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
const client = { query } as unknown as PoolClient;
const transaction = jest.fn(async (_context: unknown, callback: (c: PoolClient) => Promise<unknown>) => callback(client));
const database = { query, transaction };
const auditService = { record: auditRecord };

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
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'BUSINESS_MODEL_EVIDENCE',
      action: 'RECORD_SOURCE_EVIDENCE',
      resourceId: evidenceId,
      payload: expect.objectContaining({ contentHash: digestA, revisionNo: 1 }),
    }));
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
    expect(auditRecord).not.toHaveBeenCalled();
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
    expect(auditRecord).not.toHaveBeenCalled();
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
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'LINK_SOURCE_EVIDENCE',
      payload: expect.objectContaining({ linkType: 'CONTRADICTS', conflictId }),
    }));
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
    expect(query.mock.calls[5]?.[0]).toContain('updated_by=$2');
    expect(query.mock.calls[5]?.[1]).toEqual([
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
    expect(auditRecord).not.toHaveBeenCalled();
  });
});
