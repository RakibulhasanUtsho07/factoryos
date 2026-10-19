import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CbbEvidenceService } from './cbb.evidence.service';
import type { CreateCbbEvidenceDto, LinkCbbEvidenceDto } from './dto/cbb-evidence.dto';

type TestRow = Record<string, unknown>;
type TestResult = { rows: TestRow[] };
type Query = (sql: string, values?: unknown[]) => Promise<TestResult>;

const query = jest.fn<Query>();
const auditRecord = jest.fn<(input: unknown) => Promise<string>>();
const auditRecordWithClient = jest.fn<(client: PoolClient, input: unknown) => Promise<string>>();
const client = { query } as unknown as PoolClient;
const transaction = jest.fn(async (_context: unknown, callback: (c: PoolClient) => Promise<unknown>) => callback(client));
const database = { query, transaction };
const auditService = { record: auditRecord, recordWithClient: auditRecordWithClient };

describe('CbbEvidenceService', () => {
  const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  const factoryId = '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';
  const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
  const blueprintId = 'b0000000-0000-4000-8000-000000000001';
  const versionId = 'c0000000-0000-4000-8000-000000000001';
  const evidenceId = 'e0000000-0000-4000-8000-000000000001';
  const otherEvidenceId = 'e0000000-0000-4000-8000-000000000002';
  const entityId = 'f0000000-0000-4000-8000-000000000001';
  const conflictId = 'a0000000-0000-4000-8000-000000000001';
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  let service: CbbEvidenceService;

  const evidenceRow = (overrides: TestRow = {}): TestRow => ({
    id: evidenceId, tenant_id: tenantId, factory_id: factoryId, source_type: 'ERP',
    source_ref: 'purchase-order:PO-100', source_timestamp: '2026-10-19T05:00:00.000Z',
    evidence_grade: 'AUTHORITATIVE', confidence: 0.99, state: 'PROPOSED',
    content_hash: digestA, visibility: 'INTERNAL', metadata: {}, created_by: userId,
    created_at: '2026-10-19T05:01:00.000Z', source_key: 'erp:po-100', source_system: 'ERP',
    source_record_id: 'PO-100', source_version: '1', source_uri: null,
    supersedes_evidence_id: null, revision_no: 1, ...overrides,
  });

  const createDto = (overrides: Partial<CreateCbbEvidenceDto> = {}): CreateCbbEvidenceDto => ({
    source_type: 'ERP',
    source_ref: 'purchase-order:PO-100',
    source_key: 'erp:po-100',
    source_system: 'ERP',
    source_record_id: 'PO-100',
    source_version: '1',
    source_timestamp: '2026-10-19T05:00:00Z',
    content_hash: digestA,
    evidence_grade: 'AUTHORITATIVE',
    confidence: 0.99,
    state: 'PROPOSED',
    visibility: 'INTERNAL',
    metadata: { fixture: true },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    auditRecordWithClient.mockResolvedValue('audit-event-id');
    service = new CbbEvidenceService(database as never, auditService as never);
  });

  function queue(...results: TestResult[]) {
    for (const result of results) query.mockResolvedValueOnce(result as never);
  }

  it('records a source fingerprint and auditable revision metadata atomically', async () => {
    queue(
      { rows: [{ id: blueprintId }] },
      { rows: [] },
      { rows: [] },
      { rows: [evidenceRow()] },
    );
    const result = await service.createEvidence({ tenantId, factoryId, userId }, createDto());

    expect(result.id).toBe(evidenceId);
    expect(result.revision).toBe(1);
    expect(result.contentHash).toBe(digestA);
    expect(result.sourceUri).toBeNull();
    expect(result.replayed).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(auditRecordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      eventType: 'BUSINESS_MODEL_EVIDENCE',
      action: 'RECORD_SOURCE_EVIDENCE',
      resourceId: evidenceId,
      payload: expect.objectContaining({ contentHash: digestA, revisionNo: 1 }),
    }));
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('filters evidence by the requested graph target and defaults to internal visibility', async () => {
    queue(
      { rows: [{ total: 0 }] },
      { rows: [] },
    );
    const result = await service.listEvidence(tenantId, factoryId, {
      targetType: 'ENTITY',
      targetId: entityId,
      limit: 20,
      offset: 0,
    });

    expect(result.items).toEqual([]);
    expect(query.mock.calls[0]?.[1]).toEqual([
      tenantId, factoryId, null, null, null, 'INTERNAL', 'ENTITY', entityId,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      tenantId, factoryId, null, null, null, 'INTERNAL', 'ENTITY', entityId, 20, 0,
    ]);
    // Keep page contents consistent with the count query: filters on the count
    // alone can both leak restricted records and return unrelated targets.
    expect(query.mock.calls[1]?.[0]).toContain('AND e.visibility=$6');
    expect(query.mock.calls[1]?.[0]).toContain('AND ($7::text IS NULL OR EXISTS');
  });

  it('treats an identical source revision as an idempotent replay', async () => {
    queue(
      { rows: [{ id: blueprintId }] },
      { rows: [] },
      { rows: [{ id: evidenceId, source_version: '1', content_hash: digestA, revision_no: 1 }] },
      { rows: [evidenceRow()] },
    );
    const result = await service.createEvidence({ tenantId, factoryId, userId }, createDto());

    expect(result.replayed).toBe(true);
    expect(result.id).toBe(evidenceId);
    expect(auditRecordWithClient).not.toHaveBeenCalled();
  });

  it('rejects a changed source without the latest predecessor to prevent lost updates', async () => {
    queue(
      { rows: [{ id: blueprintId }] },
      { rows: [] },
      { rows: [{ id: evidenceId, source_version: '1', content_hash: digestA, revision_no: 1 }] },
    );
    await expect(service.createEvidence(
      { tenantId, factoryId, userId },
      createDto({ content_hash: digestB, source_version: '2' }),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(auditRecordWithClient).not.toHaveBeenCalled();
  });

  it('requires explicit timezone metadata for source timestamps', async () => {
    await expect(service.createEvidence(
      { tenantId, factoryId, userId },
      createDto({ source_timestamp: '2026-10-19T05:00:00' }),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('creates a review conflict when contradictory evidence is linked to a graph target', async () => {
    const link: TestRow = {
      id: otherEvidenceId, evidence_id: otherEvidenceId, blueprint_id: blueprintId,
      blueprint_version_id: versionId, target_type: 'ENTITY', target_id: entityId,
      link_type: 'CONTRADICTS', created_by: userId, created_at: '2026-10-19T05:00:00Z',
    };
    queue(
      { rows: [{ id: otherEvidenceId }] },
      { rows: [{ id: blueprintId, current_version_id: versionId }] },
      { rows: [] }, // transaction-scoped advisory lock
      { rows: [{ id: entityId }] },
      { rows: [link] },
      { rows: [{ evidence_id: evidenceId }, { evidence_id: otherEvidenceId }] },
      { rows: [] },
      { rows: [{ id: conflictId }] },
    );
    const result = await service.createEvidenceLink(
      { tenantId, factoryId, userId },
      otherEvidenceId,
      { target_type: 'ENTITY', target_id: entityId, link_type: 'CONTRADICTS' } as LinkCbbEvidenceDto,
    );

    expect(result.conflictId).toBe(conflictId);
    expect(result.replayed).toBe(false);
    expect(auditRecordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'LINK_SOURCE_EVIDENCE',
      payload: expect.objectContaining({ linkType: 'CONTRADICTS', conflictId }),
    }));
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('does not reopen a closed conflict when the same contradiction link is replayed', async () => {
    const link: TestRow = {
      id: otherEvidenceId,
      evidence_id: otherEvidenceId,
      blueprint_id: blueprintId,
      blueprint_version_id: versionId,
      target_type: 'ENTITY',
      target_id: entityId,
      link_type: 'CONTRADICTS',
      created_by: userId,
      created_at: '2026-10-19T05:00:00Z',
    };
    queue(
      { rows: [{ id: otherEvidenceId }] },
      { rows: [{ id: blueprintId, current_version_id: versionId }] },
      { rows: [] }, // transaction-scoped advisory lock
      { rows: [{ id: entityId }] },
      { rows: [] }, // idempotent link insert found an existing link
      { rows: [link] }, // load the existing provenance link
      { rows: [{ evidence_id: otherEvidenceId }] },
      { rows: [] }, // the conflict has already been resolved or dismissed
    );

    const result = await service.createEvidenceLink(
      { tenantId, factoryId, userId },
      otherEvidenceId,
      { target_type: 'ENTITY', target_id: entityId, link_type: 'CONTRADICTS' } as LinkCbbEvidenceDto,
    );

    expect(result.replayed).toBe(true);
    expect(result.conflictId).toBeNull();
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls[7]?.[0]).toContain("status='OPEN'");
    expect(auditRecordWithClient).not.toHaveBeenCalled();
  });

  it('appends new supporting evidence to an existing open conflict with actor attribution', async () => {
    const priorEvidenceId = 'e0000000-0000-4000-8000-000000000003';
    const link: TestRow = {
      id: otherEvidenceId,
      evidence_id: otherEvidenceId,
      blueprint_id: blueprintId,
      blueprint_version_id: versionId,
      target_type: 'ENTITY',
      target_id: entityId,
      link_type: 'SUPPORTS',
      created_by: userId,
      created_at: '2026-10-19T05:00:00Z',
    };
    queue(
      { rows: [{ id: otherEvidenceId }] },
      { rows: [{ id: blueprintId, current_version_id: versionId }] },
      { rows: [] }, // transaction-scoped advisory lock
      { rows: [{ id: entityId }] },
      { rows: [link] },
      { rows: [{ id: conflictId, version: 1, evidence_refs: [priorEvidenceId] }] },
      { rows: [] },
    );

    const result = await service.createEvidenceLink(
      { tenantId, factoryId, userId },
      otherEvidenceId,
      { target_type: 'ENTITY', target_id: entityId, link_type: 'SUPPORTS' } as LinkCbbEvidenceDto,
    );

    expect(result.conflictId).toBe(conflictId);
    expect(query.mock.calls[6]?.[0]).toContain('updated_by=$2');
    expect(query.mock.calls[6]?.[1]).toEqual([
      JSON.stringify([priorEvidenceId, otherEvidenceId]),
      userId,
      conflictId,
      tenantId,
      factoryId,
      1,
    ]);
  });

  it('does not let stale conflict decisions overwrite a newer review version', async () => {
    queue({ rows: [{ id: conflictId, status: 'OPEN', version: 2, evidence_refs: [evidenceId] }] });
    await expect(service.decideConflict(
      { tenantId, factoryId, userId },
      conflictId,
      {
        action: 'RESOLVE', expected_version: 1, reason: 'Reviewed source discrepancy',
        resolution_reference: 'Approved decision record', resolution_evidence_id: evidenceId,
      },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(auditRecordWithClient).not.toHaveBeenCalled();
  });

  it('returns only links for the requested graph target', async () => {
    const link = {
      id: 'd0000000-0000-4000-8000-000000000001',
      evidence_id: evidenceId,
      blueprint_id: blueprintId,
      blueprint_version_id: versionId,
      target_type: 'ENTITY',
      target_id: entityId,
      link_type: 'SUPPORTS',
      created_by: userId,
      created_at: '2026-10-19T05:00:00.000Z',
    };
    queue(
      { rows: [{ total: 1 }] },
      { rows: [evidenceRow()] },
      { rows: [link] },
    );

    const result = await service.listEvidence(tenantId, factoryId, {
      targetType: 'ENTITY',
      targetId: entityId,
      limit: 20,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.links).toEqual([link]);
    expect(query.mock.calls[2]?.[0]).toContain('target_type=$4 AND target_id=$5::uuid');
    expect(query.mock.calls[2]?.[1]).toEqual([tenantId, factoryId, [evidenceId], 'ENTITY', entityId]);
  });

  it('restricts source revision history to the caller-specified visibility', async () => {
    queue(
      { rows: [{ source_key: 'erp:po-100' }] },
      { rows: [evidenceRow()] },
    );

    const result = await service.getEvidenceHistory(tenantId, factoryId, evidenceId, 'INTERNAL');

    expect(result.revisions).toHaveLength(1);
    expect(query.mock.calls[0]?.[0]).toContain('visibility=$4');
    expect(query.mock.calls[0]?.[1]).toEqual([evidenceId, tenantId, factoryId, 'INTERNAL']);
    expect(query.mock.calls[1]?.[0]).toContain('visibility=$5');
    expect(query.mock.calls[1]?.[1]).toEqual([tenantId, factoryId, 'erp:po-100', evidenceId, 'INTERNAL']);
  });

  it('does not report evidence creation success when the transactional audit insert fails', async () => {
    queue(
      { rows: [{ id: blueprintId }] },
      { rows: [] },
      { rows: [] },
      { rows: [evidenceRow()] },
    );
    auditRecordWithClient.mockRejectedValueOnce(new Error('AUDIT_EVENT_INSERT_FAILED'));

    await expect(service.createEvidence(
      { tenantId, factoryId, userId },
      createDto(),
    )).rejects.toThrow('AUDIT_EVENT_INSERT_FAILED');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(auditRecordWithClient).toHaveBeenCalledWith(client, expect.any(Object));
  });

  it('records conflict decisions in the same transaction as the state transition', async () => {
    queue(
      { rows: [{ id: conflictId, status: 'OPEN', version: 2, evidence_refs: [evidenceId] }] },
      { rows: [{ id: evidenceId }] },
      { rows: [{ id: conflictId, status: 'RESOLVED', version: 3, resolved_at: '2026-10-19T06:00:00.000Z' }] },
    );

    const result = await service.decideConflict(
      { tenantId, factoryId, userId },
      conflictId,
      {
        action: 'RESOLVE',
        expected_version: 2,
        reason: 'Reviewed and accepted the corrected source evidence',
        resolution_reference: 'review-ticket: CBB-1042',
        resolution_evidence_id: evidenceId,
      },
    );

    expect(result).toEqual({
      id: conflictId,
      status: 'RESOLVED',
      version: 3,
      resolvedAt: '2026-10-19T06:00:00.000Z',
    });
    expect(auditRecordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      eventType: 'BUSINESS_MODEL_CONFLICT',
      action: 'RESOLVE',
      resourceId: conflictId,
      payload: expect.objectContaining({ status: 'RESOLVED', version: 3 }),
    }));
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('rejects non-HTTP source URIs before opening a transaction', async () => {
    await expect(service.createEvidence(
      { tenantId, factoryId, userId },
      createDto({ source_uri: 'javascript:alert(1)' }),
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(transaction).not.toHaveBeenCalled();
    expect(auditRecordWithClient).not.toHaveBeenCalled();
  });
});
