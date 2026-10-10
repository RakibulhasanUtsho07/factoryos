import { jest } from '@jest/globals';

import { BadRequestException, ConflictException } from '@nestjs/common';

import {
  ResearchSourceAssessmentDecision,
  ResearchSourceAssessmentType,
} from './dto/create-research-source-assessment.dto';
import { ResearchSourceRegistryService } from './research-source.registry.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const sourceId = '9a1a2222-2222-4222-8222-222222222222';
const contentSha256 = 'a'.repeat(64);

function assessmentInput(overrides: Record<string, unknown> = {}) {
  return {
    assessment_type: ResearchSourceAssessmentType.SECURITY,
    decision: ResearchSourceAssessmentDecision.REVIEW_REQUIRED,
    content_sha256: contentSha256,
    assessment_basis: 'Manual review required; no automated scanner was run.',
    idempotency_key: 'review-security-v1',
    ...overrides,
  };
}

function assessmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '6b5b2222-2222-4222-8222-222222222222',
    tenant_id: tenantId,
    factory_id: factoryId,
    source_id: sourceId,
    assessment_type: ResearchSourceAssessmentType.SECURITY,
    decision: ResearchSourceAssessmentDecision.REVIEW_REQUIRED,
    assessment_method: 'MANUAL',
    content_sha256: contentSha256,
    assessment_basis: 'Manual review required; no automated scanner was run.',
    idempotency_key: 'review-security-v1',
    request_hash: 'b'.repeat(64),
    assessed_by: userId,
    created_at: '2026-10-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('ResearchSourceRegistryService source assessments', () => {
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

  it('records an append-only human assessment bound to the registered source hash', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: sourceId, content_sha256: contentSha256, content_hash_is_ingested: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [assessmentRow()] });

    const result = await service.createAssessment(
      tenantId,
      factoryId,
      userId,
      sourceId,
      assessmentInput() as never,
    );

    expect(result.idempotent).toBe(false);
    expect(result.assessment.assessmentMethod).toBe('MANUAL');
    expect(result.assessment.contentSha256).toBe(contentSha256);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.sources.assess',
      factoryId,
    );
    expect(database.query.mock.calls[2]?.[0]).toContain(
      'ON CONFLICT (tenant_id, factory_id, idempotency_key) DO NOTHING',
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RESEARCH_SOURCE_ASSESSMENT',
        action: 'RECORD_MANUAL_ASSESSMENT',
        payload: expect.objectContaining({
          sourceId,
          assessmentType: ResearchSourceAssessmentType.SECURITY,
          decision: ResearchSourceAssessmentDecision.REVIEW_REQUIRED,
          assessmentMethod: 'MANUAL',
          contentSha256,
        }),
      }),
    );
    const auditInput = auditService.record.mock.calls[0]?.[0] as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.payload).not.toHaveProperty('assessmentBasis');
  });

  it('refuses assessment when the registered source has no content digest', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ id: sourceId, content_sha256: null }],
    });

    await expect(
      service.createAssessment(
        tenantId,
        factoryId,
        userId,
        sourceId,
        assessmentInput() as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('rejects assessments bound to a different content digest', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ id: sourceId, content_sha256: contentSha256, content_hash_is_ingested: true }],
    });

    await expect(
      service.createAssessment(
        tenantId,
        factoryId,
        userId,
        sourceId,
        assessmentInput({ content_sha256: 'c'.repeat(64) }) as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('replays identical assessment requests idempotently', async () => {
    const requestHash = (
      service as unknown as {
        requestHash: (value: Record<string, unknown>) => string;
      }
    ).requestHash({
      tenantId,
      factoryId,
      actorUserId: userId,
      sourceId,
      assessmentType: ResearchSourceAssessmentType.SECURITY,
      decision: ResearchSourceAssessmentDecision.REVIEW_REQUIRED,
      assessmentMethod: 'MANUAL',
      contentSha256,
      assessmentBasis: 'Manual review required; no automated scanner was run.',
      idempotencyKey: 'review-security-v1',
    });

    database.query
      .mockResolvedValueOnce({ rows: [{ id: sourceId, content_sha256: contentSha256, content_hash_is_ingested: true }] })
      .mockResolvedValueOnce({
        rows: [assessmentRow({ request_hash: requestHash })],
      });

    const result = await service.createAssessment(
      tenantId,
      factoryId,
      userId,
      sourceId,
      assessmentInput() as never,
    );

    expect(result.idempotent).toBe(true);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('rejects reuse of an idempotency key for a different assessment', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: sourceId, content_sha256: contentSha256, content_hash_is_ingested: true }] })
      .mockResolvedValueOnce({ rows: [assessmentRow({ request_hash: 'c'.repeat(64) })] });

    await expect(
      service.createAssessment(
        tenantId,
        factoryId,
        userId,
        sourceId,
        assessmentInput({ decision: ResearchSourceAssessmentDecision.APPROVED }) as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('lists scoped assessments only after authorizing registry reads', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: sourceId }] })
      .mockResolvedValueOnce({ rows: [assessmentRow()] });

    const result = await service.listAssessments(
      tenantId,
      factoryId,
      userId,
      sourceId,
      10,
    );

    expect(result.limit).toBe(10);
    expect(result.assessments).toHaveLength(1);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.sources.read',
      factoryId,
    );
    expect(database.query.mock.calls[1]?.[1]).toEqual([
      tenantId,
      factoryId,
      sourceId,
      10,
    ]);
  });

  it('rejects invalid assessment history limits', async () => {
    await expect(
      service.listAssessments(tenantId, factoryId, userId, sourceId, 1000),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(database.query).not.toHaveBeenCalled();
  });
});
