import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import { ResearchSourceRegistryService } from './research-source.registry.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const sourceId = '9a1a2222-2222-4222-8222-222222222222';
const canonicalText = 'Line one\nLine two';
const contentSha256 = createHash('sha256').update(canonicalText, 'utf8').digest('hex');

function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '6b5b2222-2222-4222-8222-222222222222',
    tenant_id: tenantId,
    factory_id: factoryId,
    source_id: sourceId,
    content_sha256: contentSha256,
    canonical_text: canonicalText,
    character_count: canonicalText.length,
    line_count: 2,
    parser_version: 'factoryos-plain-text-v1',
    created_by: userId,
    created_at: '2026-10-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('ResearchSourceRegistryService plain-text ingestion', () => {
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

  it('normalizes line endings, verifies the registered digest, and stores only metadata in its response', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{
          id: sourceId,
          content_sha256: contentSha256,
          rights_status: 'VERIFIED',
          allow_research: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [contentRow()] });

    const result = await service.ingestPlainText(
      tenantId,
      factoryId,
      userId,
      sourceId,
      { content: 'Line one\r\nLine two' } as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.content.contentSha256).toBe(contentSha256);
    expect(result.content.characterCount).toBe(canonicalText.length);
    expect(result.content.lineCount).toBe(2);
    expect(result.content.parserVersion).toBe('factoryos-plain-text-v1');
    expect(result.content.ingestionStatus).toBe('PENDING_REVIEW');
    expect(result.content.promptInjectionStatus).toBe('NOT_ASSESSED');
    expect(result.content).not.toHaveProperty('canonicalText');
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.sources.ingest',
      factoryId,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RESEARCH_SOURCE_TEXT_CONTENT',
        action: 'INGEST_CANONICAL_TEXT',
        payload: expect.objectContaining({
          sourceId,
          contentSha256,
          parserVersion: 'factoryos-plain-text-v1',
          ingestionStatus: 'PENDING_REVIEW',
        }),
      }),
    );
    const auditInput = auditService.record.mock.calls[0]?.[0] as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.payload).not.toHaveProperty('content');
    expect(auditInput?.payload).not.toHaveProperty('canonicalText');
  });

  it('replays identical content idempotently', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [{
          id: sourceId,
          content_sha256: contentSha256,
          rights_status: 'VERIFIED',
          allow_research: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [contentRow()] });

    const result = await service.ingestPlainText(
      tenantId,
      factoryId,
      userId,
      sourceId,
      { content: canonicalText } as never,
    );

    expect(result.idempotent).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a digest mismatch before attempting content insertion', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        id: sourceId,
        content_sha256: 'f'.repeat(64),
        rights_status: 'VERIFIED',
        allow_research: true,
      }],
    });

    await expect(
      service.ingestPlainText(
        tenantId,
        factoryId,
        userId,
        sourceId,
        { content: canonicalText } as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('blocks ingestion when declared rights do not permit research use', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{
        id: sourceId,
        content_sha256: contentSha256,
        rights_status: 'UNKNOWN',
        allow_research: false,
      }],
    });

    await expect(
      service.ingestPlainText(
        tenantId,
        factoryId,
        userId,
        sourceId,
        { content: canonicalText } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('rejects empty text and control characters', async () => {
    for (const content of ['', '  \n ', 'unsafe\u0000content']) {
      await expect(
        service.ingestPlainText(
          tenantId,
          factoryId,
          userId,
          sourceId,
          { content } as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    expect(database.query).not.toHaveBeenCalled();
  });

  it('serves content only through a query requiring latest RIGHTS and SECURITY approvals', async () => {
    database.query.mockResolvedValueOnce({ rows: [contentRow()] });

    const result = await service.getApprovedTextContent(
      tenantId,
      factoryId,
      userId,
      sourceId,
    );

    expect(result.content).toBe(canonicalText);
    expect(result.securityReview).toBe('MANUAL_APPROVED');
    expect(result.sourceTrust).toBe('UNTRUSTED');
    expect(result.mustTreatAsUntrusted).toBe(true);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.sources.content.read',
      factoryId,
    );
    const query = String(database.query.mock.calls[0]?.[0]);
    expect(query).toContain('DISTINCT ON (assessment_type)');
    expect(query).toContain("assessment_type = 'RIGHTS'");
    expect(query).toContain("assessment_type = 'SECURITY'");
    expect(query).toContain("decision = 'APPROVED'");
  });

  it('fails closed when no same-hash approval-gated content is returned', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.getApprovedTextContent(tenantId, factoryId, userId, sourceId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
