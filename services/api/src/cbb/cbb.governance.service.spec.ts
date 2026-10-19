import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CbbGovernanceService } from './cbb.governance.service';

type TestRow = Record<string, unknown>;
type TestResult = { rows: TestRow[] };
type QueryFn = (sql: string, values?: unknown[]) => Promise<TestResult>;

const query = jest.fn<QueryFn>();
const client = { query } as unknown as PoolClient;
const transaction = jest.fn(async (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) => callback(client));
const database = { query, transaction };
const recordWithClient = jest.fn<(client: PoolClient, input: unknown) => Promise<string>>();
const auditService = { recordWithClient };

describe('CbbGovernanceService', () => {
  const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  const factoryId = '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';
  const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
  const blueprintId = 'b0000000-0000-4000-8000-000000000001';
  const versionId = 'c0000000-0000-4000-8000-000000000001';
  const priorVersionId = 'c0000000-0000-4000-8000-000000000002';
  const aclId = 'd0000000-0000-4000-8000-000000000001';
  const entityId = 'e0000000-0000-4000-8000-000000000001';
  const secondEntityId = 'e0000000-0000-4000-8000-000000000002';
  const edgeId = 'f0000000-0000-4000-8000-000000000001';
  const roleId = 'a0000000-0000-4000-8000-000000000001';
  let service: CbbGovernanceService;

  beforeEach(() => {
    query.mockReset();
    transaction.mockReset();
    transaction.mockImplementation(async (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) => callback(client));
    recordWithClient.mockReset();
    recordWithClient.mockResolvedValue('audit-event-id');
    service = new CbbGovernanceService(database as never, auditService as never);
  });

  const queue = (...results: TestResult[]) => {
    for (const result of results) query.mockResolvedValueOnce(result);
  };

  it('hides ACL-protected graph nodes from roles without a matching grant and removes dangling edges', async () => {
    queue(
      { rows: [{ blueprint_id: blueprintId }] }, // version-to-blueprint lookup
      { rows: [] }, // user roles for blueprint
      { rows: [] }, // no blueprint ACL
      { rows: [] }, // user roles for nodes
      { rows: [{ target_id: entityId, target_type: 'ENTITY', role_id: roleId, field_name: null, access_level: 'READ' }] },
      { rows: [] }, // user roles for edges
      { rows: [] }, // ACL grants for edges
    );
    const result = await service.filterBusinessMap(tenantId, factoryId, userId, {
      nodes: [
        { id: entityId, name: 'Restricted node', state: 'VERIFIED' },
        { id: secondEntityId, name: 'Public node', state: 'VERIFIED' },
      ],
      edges: [{ id: edgeId, fromEntityId: entityId, toEntityId: secondEntityId }],
      version: { id: versionId },
    }) as { nodes: Array<{ id: string }>; edges: unknown[]; accessControl: { enforced: boolean } };

    expect(result.nodes.map((node) => node.id)).toEqual([secondEntityId]);
    expect(result.edges).toEqual([]);
    expect(result.accessControl.enforced).toBe(true);
  });

  it('redacts field-restricted attributes without hiding an otherwise visible target', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT ur.role_id::text AS role_id')) return { rows: [] };
      if (sql.includes('FROM business_acl WHERE tenant_id=$1 AND factory_id=$2 AND target_type=$3')) {
        return { rows: [{ target_id: entityId, target_type: 'ENTITY', role_id: roleId, field_name: 'description', access_level: 'READ' }] };
      }
      throw new Error('Unexpected SQL in field-redaction test: ' + sql);
    });
    const result = await service.filterBusinessMap(tenantId, factoryId, userId, {
      nodes: [{ id: entityId, name: 'Visible term', description: 'sensitive details' }],
      edges: [],
    }) as { nodes: Array<Record<string, unknown>>; edges: unknown[] };

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.name).toBe('Visible term');
    expect(result.nodes[0]).not.toHaveProperty('description');
  });

  it('validates and requires a meaningful rollback reason before touching the database', async () => {
    await expect(service.rollbackToVersion(
      { tenantId, factoryId, userId },
      { source_version_id: priorVersionId, expected_current_version_id: versionId, reason: 'no' },
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a stale expected current version before creating any rollback rows', async () => {
    queue({ rows: [{ id: blueprintId, current_version_id: priorVersionId }] });
    await expect(service.rollbackToVersion(
      { tenantId, factoryId, userId },
      { source_version_id: versionId, expected_current_version_id: versionId, reason: 'Restore a reviewed earlier CBB version' },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
    expect(recordWithClient).not.toHaveBeenCalled();
  });

  it('records stale candidates in the current version and audits the scan', async () => {
    queue(
      { rows: [{ id: blueprintId, current_version_id: versionId }] },
      { rows: [{ target_type: 'ENTITY', target_id: entityId, created_at: '2026-01-01T00:00:00Z', last_evidence_at: '2026-01-01T00:00:00Z' }] },
      { rows: [] }, // staleness-review insert
      { rows: [{ id: blueprintId }] }, // visibility gate: active blueprint
      { rows: [] }, // visibility gate: caller roles
      { rows: [] }, // visibility gate: blueprint grants
      { rows: [] }, // candidate ACL: caller roles
      { rows: [] }, // candidate ACL: target grants
    );
    const result = await service.scanStaleness({ tenantId, factoryId, userId }, 30);

    expect(result.candidateCount).toBe(1);
    expect(result.refreshedCount).toBe(1);
    expect(query.mock.calls[1]?.[0]).toContain('evidence_freshness');
    expect(query.mock.calls[2]?.[0]).toContain('INSERT INTO business_cbb_staleness_reviews');
    expect(recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'SCAN_STALE_EVIDENCE',
      payload: expect.objectContaining({ thresholdDays: 30, candidateCount: 1 }),
    }));
  });

  it('converts a confirmed stale finding into a versioned SET_STATE proposal, not an in-place graph mutation', async () => {
    queue(
      { rows: [{ id: aclId, blueprint_id: blueprintId, blueprint_version_id: versionId, target_type: 'ENTITY',
        target_id: entityId, review_status: 'OPEN', review_version: 2, last_evidence_at: '2026-01-01T00:00:00Z' }] },
      { rows: [] }, // target-specific advisory lock
      { rows: [] }, // active user's roles
      { rows: [] }, // no object/field ACL grants
      { rows: [{ current_version_id: versionId }] },
      { rows: [{ id: '90000000-0000-4000-8000-000000000001' }] },
      { rows: [{ id: aclId, review_status: 'MARKED_STALE', review_version: 3, reviewed_at: '2026-10-19T00:00:00Z' }] },
    );
    const result = await service.decideStaleness(
      { tenantId, factoryId, userId },
      aclId,
      { action: 'MARK_STALE', expected_version: 2, reason: 'No recent authoritative evidence was found' },
    );

    expect(result.review_status).toBe('MARKED_STALE');
    expect(result.proposalId).toBe('90000000-0000-4000-8000-000000000001');
    expect(query.mock.calls[5]?.[0]).toContain("'SET_STATE','STALE'");
    expect(query.mock.calls[5]?.[1]).toContain(JSON.stringify({
      state: 'STALE', stalenessReviewId: aclId, lastEvidenceAt: '2026-01-01T00:00:00Z',
    }));
    expect(recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'MARK_STALE',
      payload: expect.objectContaining({ proposalId: result.proposalId }),
    }));
  });

  it('does not allow ambiguous aliases to bypass the tenant/factory canonical dictionary', async () => {
    queue(
      { rows: [{ id: blueprintId, current_version_id: versionId }] },
      { rows: [] },
    );
    await expect(service.createTerminologyAlias(
      { tenantId, factoryId, userId },
      { alias: 'PO', canonical_term: 'Purchase Order' },
    )).rejects.toThrow('Canonical term must exist in the current CBB dictionary');
    expect(recordWithClient).not.toHaveBeenCalled();
  });

  it('requires reviewer permission context for explicit impact trace of protected nodes', async () => {
    queue(
      { rows: [] }, // current user's roles
      { rows: [{ target_id: entityId, target_type: 'ENTITY', role_id: roleId, field_name: null, access_level: 'OWNER' }] },
    );
    await expect(service.getImpactTrace(tenantId, factoryId, userId, 'ENTITY', entityId, 3))
      .rejects.toThrow('not visible to this role');
  });

  it('filters conflicts whose subject is hidden by the active role ACL', async () => {
    queue(
      { rows: [{ id: blueprintId }] }, // active blueprint
      { rows: [] }, // caller roles for blueprint
      { rows: [] }, // no blueprint-level restriction
      { rows: [] }, // caller roles for subject
      { rows: [{ target_id: entityId, role_id: roleId, field_name: null, access_level: 'READ' }] },
    );

    const result = await service.filterConflictResult(tenantId, factoryId, userId, {
      items: [{ id: aclId, subjectType: 'ENTITY', subjectId: entityId, status: 'OPEN' }],
      total: 1,
      limit: 50,
      offset: 0,
    }) as { items: unknown[]; total: number };

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('resolves terminology with source-system and language constraints while enforcing term ACL', async () => {
    const termId = 'e0000000-0000-4000-8000-000000000003';
    queue(
      { rows: [{ blueprint_id: blueprintId, version_id: versionId }] },
      { rows: [] }, // caller roles for blueprint
      { rows: [] }, // no blueprint ACL
      { rows: [{
        id: termId, term: 'Purchase Order', canonical_term: 'Purchase Order',
        language_code: 'en', source_system: 'ERP', state: 'VERIFIED', confidence: 0.98,
      }] },
      { rows: [] }, // caller roles for term
      { rows: [] }, // no term ACL
    );

    const result = await service.resolveTerminology(
      tenantId, factoryId, userId, 'Purchase Order', 'ERP', 'en',
    );

    expect(result.matchedBy).toBe('CBB_TERM');
    expect(result.match).toEqual(expect.objectContaining({ id: termId, state: 'VERIFIED' }));
    expect(query.mock.calls[3]?.[0]).toContain('AND ($5::text IS NULL OR source_system IS NULL OR lower(source_system)=lower($5))');
    expect(query.mock.calls[3]?.[0]).toContain('AND ($6::text IS NULL OR language_code IS NULL OR lower(language_code)=lower($6))');
    expect(query.mock.calls[3]?.[1]).toEqual([tenantId, factoryId, versionId, 'Purchase Order', 'ERP', 'en']);
  });

  it('creates a new immutable snapshot and records rollback receipt plus audit in one transaction', async () => {
    const rollbackEventId = 'f0000000-0000-4000-8000-000000000002';
    const newVersionId = 'c0000000-0000-4000-8000-000000000003';
    queue(
      { rows: [{ id: blueprintId, current_version_id: versionId }] }, // locked active blueprint
      { rows: [{ id: priorVersionId, version: 1, graph_hash: 'snapshot-hash', evidence_count: 0, readiness_score: null }] },
      { rows: [] }, // target ACL advisory lock
      { rows: [] }, // active caller roles
      { rows: [] }, // no blueprint ACL
      { rows: [{ next_version: 3 }] },
      { rows: [{ id: newVersionId, version: 3 }] },
      { rows: [] }, // entities
      { rows: [] }, // relations
      { rows: [] }, // processes
      { rows: [] }, // process steps
      { rows: [] }, // rules
      { rows: [] }, // terms
      { rows: [] }, // exceptions
      { rows: [{ id: blueprintId }] }, // advance current-version pointer
      { rows: [] }, // evidence links
      { rows: [] }, // impact links
      { rows: [] }, // retained ACL grants
      { rows: [] }, // open conflicts
      { rows: [{ id: rollbackEventId, created_at: '2026-10-19T08:00:00.000Z' }] },
    );

    const result = await service.rollbackToVersion(
      { tenantId, factoryId, userId },
      {
        source_version_id: priorVersionId,
        expected_current_version_id: versionId,
        reason: 'Restore the reviewed and approved historical business model',
        correlation_id: 'f0000000-0000-4000-8000-000000000003',
      },
    );

    expect(result.rollbackEventId).toBe(rollbackEventId);
    expect(result.fromVersionId).toBe(versionId);
    expect(result.restoredFromVersionId).toBe(priorVersionId);
    expect(result.version).toEqual({ id: newVersionId, number: 3 });
    expect(query.mock.calls[14]?.[0]).toContain('UPDATE business_blueprints SET current_version_id=$1');
    expect(query.mock.calls[19]?.[0]).toContain('INSERT INTO business_cbb_rollback_events');
    expect(recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      eventType: 'BUSINESS_MODEL_ROLLBACK',
      action: 'ROLLBACK_TO_VERSION',
      resourceId: newVersionId,
      correlationId: 'f0000000-0000-4000-8000-000000000003',
      payload: expect.objectContaining({
        rollbackEventId,
        fromVersionId: versionId,
        restoredFromVersionId: priorVersionId,
        toVersionId: newVersionId,
      }),
    }));
  });

  it('removes ACL-hidden graph targets from evidence link metadata', async () => {
    const evidenceId = '90000000-0000-4000-8000-000000000001';
    queue(
      { rows: [{ id: blueprintId }] }, // active blueprint
      { rows: [] }, // caller roles for blueprint
      { rows: [] }, // no blueprint restriction
      { rows: [] }, // caller roles for evidence-linked entity
      { rows: [{ target_id: entityId, role_id: roleId, field_name: null, access_level: 'READ' }] },
    );

    const result = await service.filterEvidenceResult(tenantId, factoryId, userId, {
      items: [{
        id: evidenceId,
        sourceType: 'ERP',
        links: [{
          evidence_id: evidenceId,
          target_type: 'ENTITY',
          target_id: entityId,
          link_type: 'SUPPORTS',
        }],
      }],
      total: 1,
      limit: 50,
      offset: 0,
    }) as { items: Array<{ id: string; links: unknown[] }>; total: number };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(evidenceId);
    expect(result.items[0]?.links).toEqual([]);
    expect(result.total).toBe(1);
  });

  it('does not allow a reviewer without canonical-term edit access to verify an alias', async () => {
    queue(
      { rows: [{ id: blueprintId, current_version_id: versionId }] }, // active blueprint lock
      { rows: [{
        id: aclId, state: 'PROPOSED', version: 1, alias: 'PO',
        canonical_term: 'Purchase Order', canonical_term_id: entityId,
      }] },
      { rows: [] }, // target ACL advisory lock
      { rows: [] }, // caller has no matching role
      { rows: [{ target_id: entityId, role_id: roleId, field_name: 'canonical_term', access_level: 'READ' }] },
    );

    await expect(service.decideTerminologyAlias(
      { tenantId, factoryId, userId },
      aclId,
      { action: 'VERIFY', expected_version: 1, reason: 'Reviewed and confirmed the ERP alias mapping' },
    )).rejects.toThrow('read-only or restricted');

    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE OF a');
    expect(recordWithClient).not.toHaveBeenCalled();
  });

  it('does not traverse impact edges or entities hidden by role ACLs', async () => {
    queue(
      { rows: [{ id: blueprintId }] }, // active blueprint visibility
      { rows: [] }, // roles for blueprint
      { rows: [] }, // no blueprint restriction
      { rows: [] }, // roles for requested root target
      { rows: [] }, // root target not restricted
      { rows: [{ blueprint_id: blueprintId, version_id: versionId }] }, // active version
      { rows: [{ id: entityId, entity_type: 'PROCESS', name: 'Visible start', state: 'VERIFIED', confidence: 0.9, depth: 0 }] },
      { rows: [] }, // roles for trace nodes
      { rows: [] }, // no node restrictions
      { rows: [] }, // external impact links
    );

    const result = await service.getImpactTrace(
      tenantId, factoryId, userId, 'ENTITY', entityId, 3,
    );

    expect(result.graph).toHaveLength(1);
    expect(query.mock.calls[6]?.[0]).toContain("relation_acl.target_type='RELATION'");
    expect(query.mock.calls[6]?.[0]).toContain("entity_acl.target_type='ENTITY'");
    expect(query.mock.calls[6]?.[1]).toEqual([
      tenantId, factoryId, versionId, 3, entityId, blueprintId, userId,
    ]);
  });

  it('enforces field-level edit grants before an approved description proposal can be promoted', async () => {
    queue(
      { rows: [{
        target_type: 'ENTITY',
        target_id: entityId,
        proposal_type: 'UPDATE_DESCRIPTION',
        proposed_state: null,
        proposed_payload: { description: 'Updated entity description' },
      }] },
      { rows: [] }, // ACL transaction advisory lock
      { rows: [] }, // caller roles do not include the grantee
      { rows: [{ target_id: entityId, role_id: roleId, field_name: 'description', access_level: 'READ' }] },
    );

    await expect(service.assertProposalWriteAccess(
      { tenantId, factoryId, userId },
      aclId,
    )).rejects.toThrow('CBB field description is read-only or restricted for this role');

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0]?.[0]).toContain('proposed_payload');
    expect(query.mock.calls[3]?.[1]).toEqual([tenantId, factoryId, 'ENTITY', entityId]);
  });

  it('lists an alias when only the alias matches the search and its canonical term is readable', async () => {
    const canonicalTermId = '70000000-0000-4000-8000-000000000001';
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT b.id::text AS blueprint_id,b.current_version_id::text AS version_id')) {
        return { rows: [{ blueprint_id: blueprintId, version_id: versionId }] };
      }
      if (sql.includes('SELECT DISTINCT ur.role_id::text AS role_id')) return { rows: [] };
      if (sql.includes('FROM business_acl WHERE tenant_id=$1 AND factory_id=$2 AND target_type=$3 AND target_id=ANY($4::uuid[])')) {
        return { rows: [] };
      }
      if (sql.includes('lower(canonical_term)=ANY($4::text[])')) {
        return { rows: [{ id: canonicalTermId, canonical_term: 'Purchase Order', term: 'Purchase Order', state: 'VERIFIED' }] };
      }
      if (sql.includes('FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3')) {
        return { rows: [] };
      }
      if (sql.includes('FROM business_terminology_aliases WHERE tenant_id=$1 AND factory_id=$2')) {
        return { rows: [{
          id: '71000000-0000-4000-8000-000000000001',
          alias: 'PO',
          canonical_term: 'Purchase Order',
          language_code: 'en-us',
          source_system: 'ERP',
          state: 'VERIFIED',
          version: 2,
        }] };
      }
      throw new Error('Unexpected SQL in alias-only terminology search: ' + sql);
    });

    const result = await service.listTerminology(tenantId, factoryId, userId, 'PO');

    expect(result.canonicalTerms).toEqual([]);
    expect(result.aliases).toHaveLength(1);
    expect(result.aliases[0]).toMatchObject({ alias: 'PO', canonical_term: 'Purchase Order' });
  });

  it('does not list aliases whose canonical CBB term is hidden by the active role ACL', async () => {
    const canonicalTermId = '70000000-0000-4000-8000-000000000001';
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT b.id::text AS blueprint_id,b.current_version_id::text AS version_id')) {
        return { rows: [{ blueprint_id: blueprintId, version_id: versionId }] };
      }
      if (sql.includes('SELECT DISTINCT ur.role_id::text AS role_id')) return { rows: [] };
      if (sql.includes('FROM business_acl WHERE tenant_id=$1 AND factory_id=$2 AND target_type=$3 AND target_id=ANY($4::uuid[])')) {
        if (values[2] === 'TERM') {
          return { rows: [{
            target_id: canonicalTermId,
            target_type: 'TERM',
            role_id: roleId,
            field_name: null,
            access_level: 'READ',
          }] };
        }
        return { rows: [] };
      }
      if (sql.includes('lower(canonical_term)=ANY($4::text[])')) {
        return { rows: [{ id: canonicalTermId, canonical_term: 'Purchase Order', term: 'Purchase Order', state: 'VERIFIED' }] };
      }
      if (sql.includes('FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3')) return { rows: [] };
      if (sql.includes('FROM business_terminology_aliases WHERE tenant_id=$1 AND factory_id=$2')) {
        return { rows: [{
          id: '71000000-0000-4000-8000-000000000001',
          alias: 'PO',
          canonical_term: 'Purchase Order',
          language_code: 'en-us',
          source_system: 'ERP',
          state: 'VERIFIED',
          version: 2,
        }] };
      }
      throw new Error('Unexpected SQL in hidden-canonical alias test: ' + sql);
    });

    const result = await service.listTerminology(tenantId, factoryId, userId, 'PO');

    expect(result.canonicalTerms).toEqual([]);
    expect(result.aliases).toEqual([]);
  });

  it('creates the same alias spelling independently for a source-language context and audits the write', async () => {
    const canonicalTermId = '70000000-0000-4000-8000-000000000001';
    const aliasId = '71000000-0000-4000-8000-000000000001';
    queue(
      { rows: [{ id: blueprintId, current_version_id: versionId }] }, // active CBB
      { rows: [{ id: canonicalTermId, canonical_term: 'Purchase Order' }] }, // trusted canonical term
      { rows: [] }, // target ACL advisory lock
      { rows: [] }, // active user's roles
      { rows: [] }, // no restricted canonical-term grants
      { rows: [] }, // no conflicting canonical term in this source/language context
      { rows: [] }, // exact alias-context advisory lock
      { rows: [] }, // no duplicate in this exact context
      { rows: [{
        id: aliasId, alias: 'PO', canonical_term: 'Purchase Order', language_code: 'en-us',
        source_system: 'ERP', state: 'PROPOSED', version: 1, created_at: '2026-10-19T00:00:00Z',
      }] },
    );

    const result = await service.createTerminologyAlias(
      { tenantId, factoryId, userId },
      { alias: 'PO', canonical_term: 'Purchase Order', language_code: 'EN-US', source_system: 'ERP' },
    );

    expect(result).toMatchObject({ id: aliasId, alias: 'PO', language_code: 'en-us', source_system: 'ERP' });
    expect(query.mock.calls[7]?.[1]).toEqual([tenantId, factoryId, 'PO', 'en-us', 'ERP']);
    expect(recordWithClient).toHaveBeenCalledWith(client, expect.objectContaining({
      action: 'CREATE_ALIAS',
      payload: expect.objectContaining({ alias: 'PO', languageCode: 'en-us', sourceSystem: 'ERP' }),
    }));
  });

  it('uses the most specific source and language terminology match rather than a generic alias', async () => {
    const canonicalTermId = '70000000-0000-4000-8000-000000000001';
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id::text AS blueprint_id,current_version_id::text AS version_id FROM business_blueprints')) {
        return { rows: [{ blueprint_id: blueprintId, version_id: versionId }] };
      }
      if (sql.includes('SELECT DISTINCT ur.role_id::text AS role_id')) return { rows: [] };
      if (sql.includes('FROM business_acl WHERE tenant_id=$1 AND factory_id=$2 AND target_type=$3 AND target_id=ANY($4::uuid[])')) {
        return { rows: [] };
      }
      if (sql.includes('FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT a.id::text AS alias_id')) {
        return { rows: [{
          alias_id: '71000000-0000-4000-8000-000000000001',
          alias: 'PO',
          canonical_term: 'Purchase Order',
          language_code: 'en-us',
          source_system: 'ERP',
          state: 'VERIFIED',
          version: 1,
          canonical_term_id: canonicalTermId,
          context_specificity: 2,
        }] };
      }
      throw new Error('Unexpected SQL in context-specific terminology resolution: ' + sql);
    });

    const result = await service.resolveTerminology(tenantId, factoryId, userId, 'PO', 'ERP', 'EN-US');

    expect(result).toMatchObject({ matchedBy: 'ALIAS', ambiguous: undefined });
    expect(result.match).toMatchObject({ alias: 'PO', canonical_term: 'Purchase Order' });
    expect(query.mock.calls[3]?.[1]).toEqual([tenantId, factoryId, versionId, 'PO', 'ERP', 'en-us']);
    expect(query.mock.calls[4]?.[0]).toContain('MAX(context_specificity)');
    expect(query.mock.calls[4]?.[1]).toEqual([tenantId, factoryId, 'PO', versionId, 'ERP', 'en-us']);
  });
});
