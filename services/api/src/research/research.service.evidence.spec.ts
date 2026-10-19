import { ConflictException, ForbiddenException } from '@nestjs/common';
import { jest } from '@jest/globals';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { DecideResearchClaimDto } from './dto/decide-research-claim.dto';
import { ResearchService } from './research.service';

const USER_ID = '921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT_ID = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const SOURCE_ID = '69ef2a43-8157-4d91-aa59-7b4260ef1778';
const CLAIM_ID = '5f5a38b6-b2c3-4d8b-8c67-2e9251b6cbaa';

describe('ResearchService evidence assessment workflow', () => {
  let service: ResearchService;
  let client: { query: ReturnType<typeof jest.fn> };
  let database: {
    transaction: ReturnType<typeof jest.fn>;
    query: ReturnType<typeof jest.fn>;
  };
  let audit: { record: ReturnType<typeof jest.fn> };

  beforeEach(() => {
    client = { query: jest.fn() };
    database = {
      transaction: jest.fn(async (context: unknown, callback: (clientArg: typeof client) => Promise<unknown>) =>
        callback(client)),
      query: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue('audit-id') };
    service = new ResearchService(
      database as unknown as DatabaseService,
      audit as unknown as AuditService,
    );
  });

  it('persists a rights-version-bound rubric, citation, and safety assessment without rewriting the claim grade', async () => {
    const claimRow = {
      id: CLAIM_ID,
      tenant_id: TENANT_ID,
      source_id: SOURCE_ID,
      claim_text: 'A manufacturing study reports improved defect detection.',
      methodology: 'Controlled field study with a documented protocol.',
      dataset_description: 'Sample size, production lines and evaluation window are described.',
      limitations: 'The sample comes from one region.',
      practical_implication: 'Validate the effect in the target factory.',
      evidence_grade: 'B',
      evidence_strength: 'MODERATE',
      topic_tags: ['quality'],
      provenance_ref: { page: 4, section: 'Results', doi: '10.1234/research-study' },
      stored_excerpt: null,
      status: 'PROPOSED',
      source_title: 'Manufacturing quality study',
      source_authors: ['A. Author'],
      publication_date: '2025-06-01',
      doi: '10.1234/research-study',
      source_url: 'https://publisher.example/paper',
      access_status: 'APPROVED',
      license_status: 'OPEN_ACCESS',
      rights_basis: 'Verified open-access licence',
      source_revision: 2,
      rights_version: 3,
      independent_source_count: 1,
    };
    const savedAssessment = {
      id: 'a0e4bc0d-06de-44e6-979c-51ecfe270001',
      claim_id: CLAIM_ID,
      source_id: SOURCE_ID,
      source_revision: 2,
      rights_version: 3,
      claim_fingerprint: 'b'.repeat(64),
      rubric_version: 'research-evidence-rubric.v1',
      evidence_score: 100,
      suggested_grade: 'A',
      citation_status: 'CONSISTENT',
      citation_findings: [],
      citation_verification_level: 'METADATA_ONLY',
      safety_status: 'CLEAR',
      safety_flags: [],
      assessed_by: USER_ID,
      created_at: '2026-10-19T10:00:00.000Z',
    };
    client.query
      .mockResolvedValueOnce({ rows: [claimRow] })
      .mockResolvedValueOnce({ rows: [savedAssessment] })
      .mockResolvedValueOnce({ rows: [] });

    const assessment = await service.assessClaimEvidence(USER_ID, TENANT_ID, CLAIM_ID, null, null);

    expect(assessment).toMatchObject({
      id: savedAssessment.id,
      suggested_grade: 'A',
      evidence_score: 100,
      citation_status: 'CONSISTENT',
      citation_verification_level: 'METADATA_ONLY',
      safety_status: 'CLEAR',
    });
    expect(String(client.query.mock.calls[1][0])).toContain('INSERT INTO research_evidence_assessments');
    const insertValues = client.query.mock.calls[1][1] as unknown[];
    expect(insertValues[3]).toBe(2);
    expect(insertValues[4]).toBe(3);
    expect(JSON.parse(String(insertValues[15]))).toMatchObject({
      claimId: CLAIM_ID,
      sourceId: SOURCE_ID,
      sourceRevision: 2,
      rightsVersion: 3,
      provenanceRef: claimRow.provenance_ref,
    });
    expect(client.query.mock.calls[2][0]).toContain('INSERT INTO outbox_events');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CLAIM_EVIDENCE_ASSESS',
      resourceId: CLAIM_ID,
    }));
  });

  it('records an immutable, source-version-bound safety review with a reviewer reason', async () => {
    const assessmentId = 'a0e4bc0d-06de-44e6-979c-51ecfe270001';
    const reviewId = 'cf4f3cd0-392e-41b5-8a1a-3df07d4b2dd1';
    client.query
      .mockResolvedValueOnce({ rows: [{
        assessment_id: assessmentId, claim_id: CLAIM_ID, source_id: SOURCE_ID,
        source_revision: 2, rights_version: 3, safety_status: 'REVIEW_REQUIRED',
        citation_status: 'CONSISTENT', current_source_revision: 2, current_rights_version: 3,
        access_status: 'APPROVED', license_status: 'OPEN_ACCESS', rights_basis: 'Verified licence',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: reviewId, assessment_id: assessmentId, claim_id: CLAIM_ID, source_id: SOURCE_ID,
        source_revision: 2, rights_version: 3, decision: 'CLEAR',
        reason: 'Reviewed the flagged phrase as a quoted study example.',
        reviewed_by: USER_ID, created_at: '2026-10-19T10:00:00.000Z',
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const review = await service.decideEvidenceSafety(
      USER_ID, TENANT_ID, CLAIM_ID, assessmentId,
      { decision: 'CLEAR', reason: 'Reviewed the flagged phrase as a quoted study example.' },
      null, null,
    );

    expect(review).toMatchObject({ id: reviewId, decision: 'CLEAR', source_revision: 2, rights_version: 3 });
    expect(String(client.query.mock.calls[2][0])).toContain('INSERT INTO research_evidence_safety_reviews');
    expect(client.query.mock.calls[2][1][6]).toBe('CLEAR');
    expect(client.query.mock.calls[2][1][7]).toBe('Reviewed the flagged phrase as a quoted study example.');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CLAIM_EVIDENCE_SAFETY_REVIEW',
      resourceId: CLAIM_ID,
    }));
  });

  it('allows flagged evidence approval only after a current explicit CLEAR safety review', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{
        id: CLAIM_ID, tenant_id: TENANT_ID, namespace: 'TENANT', source_id: SOURCE_ID,
        claim_text: 'A claim with a source locator.', methodology: null, dataset_description: null,
        limitations: null, practical_implication: null, evidence_grade: 'B', evidence_strength: 'LIMITED',
        topic_tags: [], provenance_ref: { page: 2 }, status: 'PROPOSED', extraction_item_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        access_status: 'APPROVED', license_status: 'OPEN_ACCESS', full_text_storage_allowed: false,
        source_revision: 2, rights_version: 3,
      }] })
      .mockResolvedValueOnce({ rows: [{
        citation_status: 'CONSISTENT', safety_status: 'REVIEW_REQUIRED', safety_review_cleared: true,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: CLAIM_ID, status: 'APPROVED', evidence_grade: 'B',
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.decideClaim(
      USER_ID, TENANT_ID, CLAIM_ID,
      { decision: 'APPROVE', evidence_grade: 'B', reason: 'Evidence and safety review are complete.' } as DecideResearchClaimDto,
      null, null,
    );

    expect(result).toMatchObject({ id: CLAIM_ID, status: 'APPROVED' });
    expect(String(client.query.mock.calls[3][0])).toContain("evidence_grade = CASE");
    expect(String(client.query.mock.calls[4][0])).toContain('INSERT INTO outbox_events');
  });

  it('blocks claim approval until a current citation and safety assessment exists', async () => {
    client.query
      .mockResolvedValueOnce({
        rows: [{
          id: CLAIM_ID,
          tenant_id: TENANT_ID,
          namespace: 'TENANT',
          source_id: SOURCE_ID,
          claim_text: 'A claim with a source locator.',
          methodology: null,
          dataset_description: null,
          limitations: null,
          practical_implication: null,
          evidence_grade: 'B',
          evidence_strength: 'LIMITED',
          topic_tags: [],
          provenance_ref: { page: 2 },
          status: 'PROPOSED',
          extraction_item_id: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          access_status: 'APPROVED',
          license_status: 'OPEN_ACCESS',
          full_text_storage_allowed: false,
          source_revision: 1,
          rights_version: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(service.decideClaim(
      USER_ID,
      TENANT_ID,
      CLAIM_ID,
      {
        decision: 'APPROVE',
        evidence_grade: 'B',
        reason: 'Reviewed evidence and citation locator for the claim.',
      } as DecideResearchClaimDto,
      null,
      null,
    )).rejects.toBeInstanceOf(ForbiddenException);

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(String(client.query.mock.calls[2][0])).toContain('research_evidence_assessments');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an approval when the latest current assessment identifies a citation mismatch', async () => {
    client.query
      .mockResolvedValueOnce({
        rows: [{
          id: CLAIM_ID, tenant_id: TENANT_ID, namespace: 'TENANT', source_id: SOURCE_ID,
          claim_text: 'A claim with a source locator.', methodology: null, dataset_description: null,
          limitations: null, practical_implication: null, evidence_grade: 'B', evidence_strength: 'LIMITED',
          topic_tags: [], provenance_ref: { page: 2 }, status: 'PROPOSED', extraction_item_id: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{ access_status: 'APPROVED', license_status: 'OPEN_ACCESS', full_text_storage_allowed: false,
          source_revision: 1, rights_version: 1 }],
      })
      .mockResolvedValueOnce({ rows: [{ citation_status: 'INVALID', safety_status: 'CLEAR' }] });

    await expect(service.decideClaim(
      USER_ID, TENANT_ID, CLAIM_ID,
      { decision: 'APPROVE', evidence_grade: 'B', reason: 'Review the conflicting citation before approval.' } as DecideResearchClaimDto,
      null, null,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
