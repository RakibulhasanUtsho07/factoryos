import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { ResearchClaimType } from './dto/create-research-claim.dto';
import { ResearchClaimEvidenceService } from './research-claim-evidence.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const claimId = 'b4f7232a-6a66-4a82-9ee4-504944cc4c02';
const evidenceId = 'a4f7232a-6a66-4a82-9ee4-504944cc4c03';
const sourceId = '9a1a2222-2222-4222-8222-222222222222';
const contentId = '7a1a2222-2222-4222-8222-222222222222';
const canonicalText = 'alpha claim evidence omega';
const contentSha256 = 'a'.repeat(64);
const quoteText = 'claim evidence';
const quoteSha256 = createHash('sha256').update(quoteText, 'utf8').digest('hex');

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: claimId,
    tenant_id: tenantId,
    factory_id: factoryId,
    claim_key: 'quality.yield',
    claim_version: 'v1',
    claim_type: ResearchClaimType.FACT,
    statement: 'The yield was above 95%.',
    statement_sha256: 'b'.repeat(64),
    request_hash: 'c'.repeat(64),
    idempotency_key: 'claim-yield-v1',
    created_by: userId,
    created_at: '2026-10-10T12:00:00.000Z',
    ...overrides,
  };
}

function validationInput(overrides: Record<string, unknown> = {}) {
  return {
    claim_id: claimId,
    claim_key: 'quality.yield',
    claim_version: 'v1',
    statement_sha256: 'b'.repeat(64),
    evidence_id: evidenceId,
    source_id: sourceId,
    content_id: contentId,
    content_sha256: contentSha256,
    canonical_text: canonicalText,
    quote_text: quoteText,
    quote_sha256: quoteSha256,
    start_offset: 6,
    end_offset: 20,
    source_rights_status: 'VERIFIED',
    allow_research: true,
    latest_rights_decision: 'APPROVED',
    latest_rights_hash: contentSha256,
    latest_security_decision: 'APPROVED',
    latest_security_hash: contentSha256,
    ...overrides,
  };
}

describe('ResearchClaimEvidenceService', () => {
  const database = {
    query: jest.fn<(query: string, values?: unknown[], context?: unknown) => Promise<{ rows: unknown[] }>>(),
  };
  const iamService = {
    authorize: jest.fn<(...args: unknown[]) => Promise<void>>(),
  };
  const auditService = {
    record: jest.fn<(...args: unknown[]) => Promise<string>>(),
  };
  let service: ResearchClaimEvidenceService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockReset();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
    service = new ResearchClaimEvidenceService(
      database as never,
      iamService as never,
      auditService as never,
    );
  });

  it('registers a versioned claim with an immutable statement hash', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [claimRow()] });

    const result = await service.createClaim(tenantId, factoryId, userId, {
      claim_key: 'quality.yield',
      claim_version: 'v1',
      claim_type: ResearchClaimType.FACT,
      statement: 'The yield was above 95%.',
      idempotency_key: 'claim-yield-v1',
    } as never);

    expect(result.idempotent).toBe(false);
    expect(result.claim.statementSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.claims.write',
      factoryId,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RESEARCH_CLAIM_REGISTERED',
        payload: expect.objectContaining({ claimKey: 'quality.yield' }),
      }),
    );
  });

  it('rejects conflicting reuse of a claim key/version', async () => {
    database.query.mockResolvedValueOnce({
      rows: [claimRow({ request_hash: 'd'.repeat(64) })],
    });

    await expect(
      service.createClaim(tenantId, factoryId, userId, {
        claim_key: 'quality.yield',
        claim_version: 'v1',
        claim_type: ResearchClaimType.FACT,
        statement: 'Changed statement.',
        idempotency_key: 'claim-yield-v1',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('links a claim to a source text hash and records exact quote offsets', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [{ id: claimId }] })
      .mockResolvedValueOnce({
        rows: [{
          content_id: contentId,
          canonical_text: canonicalText,
          registered_hash: contentSha256,
          source_format: 'PLAIN_TEXT',
          original_file_sha256: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: evidenceId,
          tenant_id: tenantId,
          factory_id: factoryId,
          claim_id: claimId,
          source_id: sourceId,
          content_id: contentId,
          content_sha256: contentSha256,
          quote_text: quoteText,
          quote_sha256: quoteSha256,
          start_offset: 6,
          end_offset: 20,
          locator: 'paragraph-2',
          request_hash: 'c'.repeat(64),
          idempotency_key: 'yield-evidence-v1',
          created_by: userId,
          created_at: '2026-10-10T12:00:00.000Z',
        }],
      });

    const result = await service.linkEvidence(tenantId, factoryId, userId, claimId, {
      source_id: sourceId,
      content_sha256: contentSha256,
      quote_text: quoteText,
      start_offset: 6,
      end_offset: 20,
      locator: 'paragraph-2',
      idempotency_key: 'yield-evidence-v1',
    } as never);

    expect(result.idempotent).toBe(false);
    expect(result.evidence.quoteSha256).toBe(quoteSha256);
    expect(result.evidence.startOffset).toBe(6);
    expect(result.evidence.endOffset).toBe(20);
    expect(database.query.mock.calls[3]?.[0]).toContain('ON CONFLICT DO NOTHING');
  });

  it('marks an exact quote VALID only when latest source rights and security approvals match the text hash', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [validationInput()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'c4f7232a-6a66-4a82-9ee4-504944cc4c05', created_at: '2026-10-10T12:00:00.000Z' }],
      });

    const result = await service.validateCitation(tenantId, factoryId, userId, claimId, evidenceId, {
      idempotency_key: 'validate-evidence-v1',
    } as never);

    expect(result.validation.verdict).toBe('VALID');
    expect(result.validation.reasonCode).toBe('QUOTE_MATCHED');
    expect(result.validation.establishesClaimTruth).toBe(false);
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId,
      tenantId,
      'research.claims.validate',
      factoryId,
    );
    expect(database.query.mock.calls[0]?.[0]).toContain('LEFT JOIN LATERAL');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RESEARCH_CITATION_VALIDATED',
        payload: expect.objectContaining({ verdict: 'VALID', reasonCode: 'QUOTE_MATCHED' }),
      }),
    );
  });

  it('marks a citation INVALID when the quote does not match its selected text offsets', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [validationInput({ quote_text: 'another quote', quote_sha256: createHash('sha256').update('another quote').digest('hex') })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'c4f7232a-6a66-4a82-9ee4-504944cc4c05', created_at: '2026-10-10T12:00:00.000Z' }],
      });

    const result = await service.validateCitation(tenantId, factoryId, userId, claimId, evidenceId, {
      idempotency_key: 'validate-mismatch-v1',
    } as never);

    expect(result.validation.verdict).toBe('INVALID');
    expect(result.validation.reasonCode).toBe('QUOTE_MISMATCH');
  });

  it('requires review when there is no matching approved security assessment', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [validationInput({ latest_security_decision: null, latest_security_hash: null })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'c4f7232a-6a66-4a82-9ee4-504944cc4c05', created_at: '2026-10-10T12:00:00.000Z' }],
      });

    const result = await service.validateCitation(tenantId, factoryId, userId, claimId, evidenceId, {
      idempotency_key: 'validate-review-v1',
    } as never);

    expect(result.validation.verdict).toBe('REVIEW_REQUIRED');
    expect(result.validation.reasonCode).toBe('SECURITY_NOT_APPROVED');
  });

  it('does not reveal claim graph across factory scope', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.getClaimGraph(tenantId, factoryId, userId, claimId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
