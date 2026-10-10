import { jest } from '@jest/globals';

import { BadRequestException, ConflictException } from '@nestjs/common';

import { ResearchSourceRegistryService } from './research-source.registry.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

function sourceInput(overrides: Record<string, unknown> = {}) {
  return {
    source_key: 'quality.standard',
    source_version: 'v1',
    source_type: 'WEB',
    title: 'Quality inspection standard',
    canonical_uri: 'https://example.com/docs',
    content_sha256: 'a'.repeat(64),
    rights_status: 'VERIFIED',
    rights_basis: 'Written permission recorded in supplier agreement',
    license_label: 'Supplier permission',
    allow_research: true,
    allow_model_training: false,
    allow_redistribution: false,
    ...overrides,
  };
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '9a1a2222-2222-4222-8222-222222222222',
    tenant_id: tenantId,
    factory_id: factoryId,
    source_key: 'quality.standard',
    source_version: 'v1',
    source_type: 'WEB',
    title: 'Quality inspection standard',
    canonical_uri: 'https://example.com/docs',
    content_sha256: 'a'.repeat(64),
    rights_status: 'VERIFIED',
    rights_basis: 'Written permission recorded in supplier agreement',
    license_label: 'Supplier permission',
    allow_research: true,
    allow_model_training: false,
    allow_redistribution: false,
    prompt_injection_status: 'NOT_ASSESSED',
    registry_status: 'REGISTERED',
    request_hash: 'b'.repeat(64),
    created_by: userId,
    created_at: '2026-10-10T09:00:00.000Z',
    ...overrides,
  };
}

describe('ResearchSourceRegistryService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  let service: ResearchSourceRegistryService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new ResearchSourceRegistryService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('registers an immutable source version without claiming security was assessed', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sourceRow()] });

    const result = await service.registerSource(
      tenantId,
      factoryId,
      userId,
      sourceInput() as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.source.promptInjectionStatus).toBe('NOT_ASSESSED');
    expect(result.source.registryStatus).toBe('REGISTERED');
    expect(result.source.allowResearch).toBe(true);
    expect(result.source.allowModelTraining).toBe(false);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.sources.write',
      factoryId,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RESEARCH_SOURCE_REGISTRY',
        action: 'REGISTER_VERSION',
        payload: expect.objectContaining({
          sourceKey: 'quality.standard',
          sourceVersion: 'v1',
          promptInjectionStatus: 'NOT_ASSESSED',
        }),
      }),
    );
    const auditInput = auditService.record.mock.calls[0]?.[0] as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.payload).not.toHaveProperty('canonicalUri');
    expect(auditInput?.payload).not.toHaveProperty('rightsBasis');
  });

  it('replays identical source versions idempotently', async () => {
    const savedHash = (
      service as unknown as {
        requestHash: (value: Record<string, unknown>) => string;
      }
    ).requestHash({
      tenantId,
      factoryId,
      actorUserId: userId,
      sourceKey: 'quality.standard',
      sourceVersion: 'v1',
      sourceType: 'WEB',
      title: 'Quality inspection standard',
      canonicalUri: 'https://example.com/docs',
      contentSha256: 'a'.repeat(64),
      rightsStatus: 'VERIFIED',
      rightsBasis: 'Written permission recorded in supplier agreement',
      licenseLabel: 'Supplier permission',
      allowResearch: true,
      allowModelTraining: false,
      allowRedistribution: false,
    });

    database.query.mockResolvedValueOnce({
      rows: [sourceRow({ request_hash: savedHash })],
    });

    const result = await service.registerSource(
      tenantId,
      factoryId,
      userId,
      sourceInput() as never,
    );

    expect(result.idempotent).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a source version with different metadata', async () => {
    database.query.mockResolvedValueOnce({
      rows: [sourceRow({ request_hash: 'c'.repeat(64) })],
    });

    await expect(
      service.registerSource(
        tenantId,
        factoryId,
        userId,
        sourceInput({ title: 'Different title' }) as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('requires an evidence basis before declaring rights verified', async () => {
    await expect(
      service.registerSource(
        tenantId,
        factoryId,
        userId,
        sourceInput({ rights_basis: null }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('does not grant use permissions when rights are unknown or restricted', async () => {
    await expect(
      service.registerSource(
        tenantId,
        factoryId,
        userId,
        sourceInput({
          rights_status: 'UNKNOWN',
          rights_basis: null,
          license_label: null,
          allow_research: true,
        }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects javascript URLs, embedded credentials, and non-HTTP schemes', async () => {
    for (const canonical_uri of [
      'javascript:alert(1)',
      'https://user:password@example.com/private',
      'file:///etc/passwd',
    ]) {
      await expect(
        service.registerSource(
          tenantId,
          factoryId,
          userId,
          sourceInput({ canonical_uri }) as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires a canonical URI for WEB sources', async () => {
    await expect(
      service.registerSource(
        tenantId,
        factoryId,
        userId,
        sourceInput({ canonical_uri: null }) as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });

  it('lists source versions only in the requested factory scope and authorizes reads', async () => {
    database.query.mockResolvedValueOnce({ rows: [sourceRow()] });

    const result = await service.listSources(
      tenantId,
      factoryId,
      userId,
      { sourceKey: 'quality.standard', sourceType: 'WEB', limit: 10 },
    );

    expect(result.limit).toBe(10);
    expect(result.sources).toHaveLength(1);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.sources.read',
      factoryId,
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = $1'),
      [tenantId, factoryId, 'quality.standard', 'WEB', 10],
      { tenantId, userId },
    );
  });

  it('rejects invalid list limits before querying the registry', async () => {
    await expect(
      service.listSources(tenantId, factoryId, userId, { limit: 1000 }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });
});
