import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';

import { ResearchRetrievalService } from './research-retrieval.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

function resultRow(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: 'b4f7232a-6a66-4a82-9ee4-504944cc4c02',
    claim_key: 'quality.yield',
    claim_version: 'v1',
    claim_type: 'FACT',
    statement: 'The yield was above 95%.',
    statement_sha256: 'b'.repeat(64),
    evidence_id: 'a4f7232a-6a66-4a82-9ee4-504944cc4c03',
    source_id: '9a1a2222-2222-4222-8222-222222222222',
    content_id: '7a1a2222-2222-4222-8222-222222222222',
    content_sha256: 'a'.repeat(64),
    quote_text: 'Yield above 95%',
    quote_sha256: 'c'.repeat(64),
    start_offset: 10,
    end_offset: 25,
    locator: 'page-2',
    evidence_created_at: '2026-10-10T12:00:00.000Z',
    source_key: 'quality.report',
    source_version: 'v1',
    source_type: 'DOCUMENT',
    source_title: 'Quality report',
    canonical_uri: null,
    validation_id: 'c4f7232a-6a66-4a82-9ee4-504944cc4c05',
    validation_verdict: 'VALID',
    validation_reason_code: 'QUOTE_MATCHED',
    validation_created_at: '2026-10-10T12:05:00.000Z',
    relevance_score: 0.75,
    ...overrides,
  };
}

describe('ResearchRetrievalService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  let service: ResearchRetrievalService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new ResearchRetrievalService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('returns ranked claims with exact citations only after current approvals and VALID traceability checks', async () => {
    database.query.mockResolvedValueOnce({ rows: [resultRow()] });

    const result = await service.search(tenantId, factoryId, userId, {
      query: 'yield above 95',
      limit: 5,
    });

    expect(result.resultCount).toBe(1);
    expect(result.retrievalMethod).toBe('postgresql-full-text-simple-v1');
    expect(result.rankingSemantics).toBe('LEXICAL_RELEVANCE_ONLY');
    expect(result.results[0]).toEqual(expect.objectContaining({
      rank: 1,
      relevanceScore: 0.75,
      claim: expect.objectContaining({ key: 'quality.yield', type: 'FACT' }),
      citation: expect.objectContaining({
        quoteText: 'Yield above 95%',
        startOffset: 10,
        endOffset: 25,
      }),
      validation: expect.objectContaining({
        verdict: 'VALID',
        reasonCode: 'QUOTE_MATCHED',
        establishesClaimTruth: false,
      }),
    }));
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.retrieval.search',
      factoryId,
    );
    const [sql, values, context] = database.query.mock.calls[0] ?? [];
    expect(sql).toContain('c.tenant_id = $1 AND c.factory_id = $2');
    expect(sql).toContain("v.verdict = 'VALID'");
    expect(sql).toContain("rights.decision = 'APPROVED'");
    expect(sql).toContain("security.decision = 'APPROVED'");
    expect(sql).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
    expect(values).toEqual([tenantId, factoryId, 'yield above 95', 5]);
    expect(context).toEqual({ tenantId, userId });
  });

  it('returns no unsupported results when nothing meets the evidence gate', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });

    const result = await service.search(tenantId, factoryId, userId, { query: 'unapproved source' });

    expect(result.resultCount).toBe(0);
    expect(result.results).toEqual([]);
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid limits without querying the database', async () => {
    await expect(
      service.search(tenantId, factoryId, userId, { query: 'valid query', limit: 21 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects empty or oversized queries', async () => {
    await expect(
      service.search(tenantId, factoryId, userId, { query: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.search(tenantId, factoryId, userId, { query: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('audits the query digest instead of storing raw search text', async () => {
    const query = 'confidential production defect';
    database.query.mockResolvedValueOnce({ rows: [] });

    await service.search(tenantId, factoryId, userId, { query });

    const auditInput = auditService.record.mock.calls[0]?.[0] as {
      payload?: Record<string, unknown>;
    };
    expect(auditInput.payload).toEqual(expect.objectContaining({
      querySha256: createHash('sha256').update(query).digest('hex'),
      resultCount: 0,
    }));
    expect(JSON.stringify(auditInput.payload)).not.toContain(query);
  });
});
