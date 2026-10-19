import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type {
  CreateCbbImpactLinkDto, CreateCbbTerminologyAliasDto, DecideCbbStalenessDto,
  DecideCbbTerminologyAliasDto, GrantCbbAccessDto, RollbackCbbVersionDto,
} from './dto/cbb-governance.dto';

type DbRow = QueryResultRow & Record<string, unknown>;
type Scope = { tenantId: string; factoryId: string; userId: string };
type TargetType = 'BLUEPRINT' | 'ENTITY' | 'RELATION' | 'PROCESS' | 'PROCESS_STEP' | 'RULE' | 'TERM' | 'EXCEPTION';
const TARGET_TABLE: Record<Exclude<TargetType, 'BLUEPRINT'>, string> = {
  ENTITY: 'business_entities',
  RELATION: 'business_relations',
  PROCESS: 'business_processes',
  PROCESS_STEP: 'business_process_steps',
  RULE: 'business_rules',
  TERM: 'business_terms',
  EXCEPTION: 'business_exceptions',
};
const ACCESS_LEVELS = ['READ', 'EDIT', 'OWNER'] as const;

@Injectable()
export class CbbGovernanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async listAccess(tenantId: string, factoryId: string) {
    this.validateReadScope(tenantId, factoryId);
    const result = await this.database.query<DbRow>(
      `SELECT a.id::text AS id, a.role_id::text AS role_id, r.code AS role_code, r.name AS role_name,
         a.target_type, a.target_id::text AS target_id, a.field_name, a.access_level,
         a.created_by::text AS created_by, a.created_at::text AS created_at
       FROM business_acl a
       INNER JOIN roles r ON r.id=a.role_id AND r.tenant_id=a.tenant_id
       WHERE a.tenant_id=$1 AND a.factory_id=$2
       ORDER BY a.target_type, a.target_id, a.role_id, a.field_name NULLS FIRST, a.access_level`,
      [tenantId, factoryId], { tenantId },
    );
    return result.rows;
  }

  async grantAccess(scope: Scope, dto: GrantCbbAccessDto) {
    this.validateScope(scope);
    this.validateTargetType(dto.target_type);
    this.uuid(dto.role_id, 'role_id');
    this.uuid(dto.target_id, 'target_id');
    const accessLevel = String(dto.access_level).toUpperCase();
    if (!ACCESS_LEVELS.includes(accessLevel as (typeof ACCESS_LEVELS)[number])) {
      throw new BadRequestException('Unsupported CBB access level');
    }
    const fieldName = dto.field_name?.trim() || null;
    const result = await this.database.transaction(
      { tenantId: scope.tenantId, userId: scope.userId },
      async (client: PoolClient) => {
        const blueprint = await this.currentBlueprint(client, scope, true);
        const role = await client.query<DbRow>(
          'SELECT id FROM roles WHERE id=$1 AND tenant_id=$2 FOR SHARE',
          [dto.role_id, scope.tenantId],
        );
        if (!role.rows[0]) throw new NotFoundException('Role was not found in this tenant');
        await this.assertTarget(client, scope, dto.target_type, dto.target_id, blueprint.id, blueprint.current_version_id);
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`cbb-acl-target:${scope.tenantId}:${scope.factoryId}:${dto.target_type}:${dto.target_id}`],
        );
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`cbb-acl:${scope.tenantId}:${scope.factoryId}:${dto.role_id}:${dto.target_type}:${dto.target_id}:${fieldName ?? '*'}`],
        );
        await client.query(
          `DELETE FROM business_acl WHERE tenant_id=$1 AND factory_id=$2 AND role_id=$3
             AND target_type=$4 AND target_id=$5 AND field_name IS NOT DISTINCT FROM $6`,
          [scope.tenantId, scope.factoryId, dto.role_id, dto.target_type, dto.target_id, fieldName],
        );
        const inserted = await client.query<DbRow>(
          `INSERT INTO business_acl
             (tenant_id, factory_id, role_id, target_type, target_id, field_name, access_level, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id::text AS id, role_id::text AS role_id, target_type, target_id::text AS target_id,
             field_name, access_level, created_by::text AS created_by, created_at::text AS created_at`,
          [scope.tenantId, scope.factoryId, dto.role_id, dto.target_type, dto.target_id, fieldName, accessLevel, scope.userId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('CBB_ACCESS_GRANT_INSERT_FAILED');
        await this.auditService.recordWithClient(client, {
          tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
          eventType: 'CBB_ACCESS_CONTROL', action: 'GRANT_ACCESS', resourceType: 'BUSINESS_ACL',
          resourceId: String(row.id),
          payload: { roleId: dto.role_id, targetType: dto.target_type, targetId: dto.target_id,
            fieldName, accessLevel },
        });
        return row;
      },
    );
    return result;
  }

  async revokeAccess(scope: Scope, aclId: string) {
    this.validateScope(scope);
    this.uuid(aclId, 'aclId');
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const found = await client.query<DbRow>(
        `SELECT id::text AS id, role_id::text AS role_id, target_type, target_id::text AS target_id,
           field_name, access_level FROM business_acl
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [aclId, scope.tenantId, scope.factoryId],
      );
      const row = found.rows[0];
      if (!row) throw new NotFoundException('CBB access grant was not found in this factory');
      await client.query('DELETE FROM business_acl WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
        [aclId, scope.tenantId, scope.factoryId]);
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'CBB_ACCESS_CONTROL', action: 'REVOKE_ACCESS', resourceType: 'BUSINESS_ACL',
        resourceId: aclId,
        payload: { roleId: row.role_id, targetType: row.target_type, targetId: row.target_id,
          fieldName: row.field_name, accessLevel: row.access_level },
      });
      return { id: aclId, revoked: true };
    });
  }

  async filterBusinessMap(tenantId: string, factoryId: string, userId: string, map: unknown) {
    if (!map || typeof map !== 'object') return map;
    const value = map as Record<string, unknown>;
    const version = value.version && typeof value.version === 'object'
      ? value.version as Record<string, unknown>
      : null;
    if (version && typeof version.id === 'string') {
      const blueprintResult = await this.database.query<DbRow>(
        'SELECT blueprint_id::text AS blueprint_id FROM business_blueprint_versions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
        [version.id, tenantId, factoryId], { tenantId },
      );
      const blueprintId = blueprintResult.rows[0]?.blueprint_id ? String(blueprintResult.rows[0].blueprint_id) : null;
      if (blueprintId && !(await this.filterItemsByAcl(tenantId, factoryId, userId, 'BLUEPRINT', [{ id: blueprintId }])).length) {
        return { ...value, nodes: [], edges: [], accessControl: { enforced: true, scope: 'ROLE_AND_TARGET', blueprintVisible: false } };
      }
    }
    const nodes = Array.isArray(value.nodes) ? value.nodes as Array<Record<string, unknown>> : [];
    const edges = Array.isArray(value.edges) ? value.edges as Array<Record<string, unknown>> : [];
    const visibleNodes = await this.filterItemsByAcl(tenantId, factoryId, userId, 'ENTITY', nodes);
    const visibleEdges = await this.filterItemsByAcl(tenantId, factoryId, userId, 'RELATION', edges);
    const ids = new Set(visibleNodes.map((item) => String(item.id)));
    return {
      ...value,
      nodes: visibleNodes,
      edges: visibleEdges.filter((edge) => ids.has(String(edge.fromEntityId)) && ids.has(String(edge.toEntityId))),
      accessControl: { enforced: true, scope: 'ROLE_AND_TARGET' },
    };
  }

  async filterProcessResult(tenantId: string, factoryId: string, userId: string, result: unknown) {
    if (!result) return result;
    const blueprintResult = await this.database.query<DbRow>(
      "SELECT id::text AS id FROM business_blueprints WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' LIMIT 1",
      [tenantId, factoryId], { tenantId },
    );
    const blueprintId = blueprintResult.rows[0]?.id ? String(blueprintResult.rows[0].id) : null;
    if (blueprintId && !(await this.filterItemsByAcl(tenantId, factoryId, userId, 'BLUEPRINT', [{ id: blueprintId }])).length) {
      if (Array.isArray(result)) return [];
      if (typeof result === 'object') {
        const value = result as Record<string, unknown>;
        if (Array.isArray(value.items)) return { ...value, items: [] };
      }
      return null;
    }
    if (Array.isArray(result)) {
      return this.filterItemsByAcl(tenantId, factoryId, userId, 'PROCESS', result as Array<Record<string, unknown>>);
    }
    if (!result || typeof result !== 'object') return result;
    const value = result as Record<string, unknown>;
    if (Array.isArray(value.items)) {
      return { ...value, items: await this.filterItemsByAcl(tenantId, factoryId, userId, 'PROCESS', value.items as Array<Record<string, unknown>>) };
    }
    if (value.process && typeof value.process === 'object') {
      const processes = await this.filterItemsByAcl(tenantId, factoryId, userId, 'PROCESS', [value.process as Record<string, unknown>]);
      if (!processes.length) return null;
      const steps = Array.isArray(value.steps) ? value.steps as Array<Record<string, unknown>> : [];
      return {
        ...value,
        process: processes[0],
        steps: await this.filterItemsByAcl(tenantId, factoryId, userId, 'PROCESS_STEP', steps),
      };
    }
    if (typeof value.id === 'string' && typeof value.name === 'string') {
      const filtered = await this.filterItemsByAcl(tenantId, factoryId, userId, 'PROCESS', [value]);
      return filtered[0] ?? null;
    }
    return value;
  }

  async scanStaleness(scope: Scope, thresholdDays: number) {
    this.validateScope(scope);
    if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 3650) {
      throw new BadRequestException('threshold_days must be between 1 and 3650');
    }
    const scan = await this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const blueprint = await this.currentBlueprint(client, scope, true);
      const candidates = await client.query<DbRow>(
        `WITH targets AS (
          SELECT 'ENTITY'::text target_type, id target_id, created_at
            FROM business_entities WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
          UNION ALL
          SELECT 'RELATION', id, created_at
            FROM business_relations WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
          UNION ALL
          SELECT 'PROCESS', id, created_at
            FROM business_processes WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
          UNION ALL
          SELECT 'PROCESS_STEP', id, created_at
            FROM business_process_steps WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
          UNION ALL
          SELECT 'RULE', id, created_at
            FROM business_rules WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
          UNION ALL
          SELECT 'TERM', id, created_at
            FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
          UNION ALL
          SELECT 'EXCEPTION', id, created_at
            FROM business_exceptions WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 AND state IN ('VERIFIED','INFERRED')
        ), evidence_freshness AS (
          SELECT l.target_type, l.target_id, MAX(e.source_timestamp) AS last_evidence_at
          FROM business_evidence_links l
          JOIN business_evidence e ON e.id=l.evidence_id AND e.tenant_id=l.tenant_id AND e.factory_id=l.factory_id
          WHERE l.tenant_id=$1 AND l.factory_id=$2 AND l.blueprint_id=$4 AND l.blueprint_version_id=$3
          GROUP BY l.target_type,l.target_id
        )
        SELECT t.target_type, t.target_id::text AS target_id, t.created_at::text AS created_at,
          f.last_evidence_at::text AS last_evidence_at
        FROM targets t LEFT JOIN evidence_freshness f
          ON f.target_type=t.target_type AND f.target_id=t.target_id
        WHERE COALESCE(f.last_evidence_at,t.created_at) < NOW() - ($5 * INTERVAL '1 day')
        ORDER BY COALESCE(f.last_evidence_at,t.created_at),t.target_type,t.target_id`,
        [scope.tenantId, scope.factoryId, blueprint.current_version_id, blueprint.id, thresholdDays],
      );
      let createdOrRefreshed = 0;
      for (const candidate of candidates.rows) {
        await client.query(
          `INSERT INTO business_cbb_staleness_reviews
             (tenant_id,factory_id,blueprint_id,blueprint_version_id,target_type,target_id,last_evidence_at,
              stale_threshold_days,review_status,created_by,last_scanned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,NOW())
           ON CONFLICT (tenant_id,factory_id,blueprint_version_id,target_type,target_id)
           DO UPDATE SET last_evidence_at=EXCLUDED.last_evidence_at,
             stale_threshold_days=EXCLUDED.stale_threshold_days,last_scanned_at=NOW(),
             review_version=CASE WHEN business_cbb_staleness_reviews.review_status='OPEN'
               THEN business_cbb_staleness_reviews.review_version+1 ELSE business_cbb_staleness_reviews.review_version END`,
          [scope.tenantId, scope.factoryId, blueprint.id, blueprint.current_version_id,
            candidate.target_type, candidate.target_id, candidate.last_evidence_at,
            thresholdDays, scope.userId],
        );
        createdOrRefreshed += 1;
      }
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'CBB_STALENESS', action: 'SCAN_STALE_EVIDENCE', resourceType: 'CBB_BLUEPRINT_VERSION',
        resourceId: String(blueprint.current_version_id),
        payload: { thresholdDays, candidateCount: candidates.rows.length, refreshedCount: createdOrRefreshed },
      });
      return { blueprintVersionId: String(blueprint.current_version_id), thresholdDays,
        candidateCount: candidates.rows.length, refreshedCount: createdOrRefreshed, candidates: candidates.rows };
    });
    if (!(await this.canReadActiveBlueprint(scope.tenantId, scope.factoryId, scope.userId))) {
      return { ...scan, candidateCount: 0, refreshedCount: 0, candidates: [] };
    }
    const visibleCandidates = await this.filterTargetRowsByAcl(
      scope.tenantId, scope.factoryId, scope.userId, scan.candidates as DbRow[],
    );
    return {
      ...scan,
      candidateCount: visibleCandidates.length,
      refreshedCount: visibleCandidates.length,
      candidates: visibleCandidates,
    };
  }

  async listStaleness(
    tenantId: string,
    factoryId: string,
    userId: string,
    status?: 'OPEN' | 'MARKED_STALE' | 'RECONFIRMED' | 'DISMISSED',
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) return [];
    const rows = await this.database.query<DbRow>(
      `SELECT id::text AS id, blueprint_id::text AS blueprint_id, blueprint_version_id::text AS blueprint_version_id,
         target_type,target_id::text AS target_id,last_evidence_at::text AS last_evidence_at,
         stale_threshold_days,review_status,review_version,reviewed_by::text AS reviewed_by,
         reviewed_at::text AS reviewed_at,review_reason,last_scanned_at::text AS last_scanned_at
       FROM business_cbb_staleness_reviews
       WHERE tenant_id=$1 AND factory_id=$2 AND ($3::text IS NULL OR review_status=$3)
       ORDER BY CASE WHEN review_status='OPEN' THEN 0 ELSE 1 END,last_scanned_at DESC,id DESC LIMIT 500`,
      [tenantId, factoryId, status ?? null], { tenantId },
    );
    return this.filterTargetRowsByAcl(tenantId, factoryId, userId, rows.rows);
  }

  async decideStaleness(scope: Scope, reviewId: string, dto: DecideCbbStalenessDto) {
    this.validateScope(scope);
    this.uuid(reviewId, 'reviewId');
    const reason = this.requiredText(dto.reason, 'reason', 2000);
    if (reason.length < 10) throw new BadRequestException('reason must contain at least 10 characters');
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) throw new BadRequestException('expected_version must be positive');
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const selected = await client.query<DbRow>(
        `SELECT id::text AS id,blueprint_id::text AS blueprint_id,blueprint_version_id::text AS blueprint_version_id,
           target_type,target_id::text AS target_id,review_status,review_version,last_evidence_at::text AS last_evidence_at
         FROM business_cbb_staleness_reviews WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [reviewId, scope.tenantId, scope.factoryId],
      );
      const review = selected.rows[0];
      if (!review) throw new NotFoundException('CBB staleness review was not found in this factory');
      if (Number(review.review_version) !== dto.expected_version) {
        throw new ConflictException({ code: 'CBB_STALENESS_VERSION_MISMATCH', currentVersion: Number(review.review_version) });
      }
      if (review.review_status !== 'OPEN') throw new ConflictException('Only open staleness reviews may be decided');
      await this.assertTargetWriteAccessInClient(client, scope, String(review.target_type) as TargetType, String(review.target_id),
        dto.action === 'MARK_STALE' ? ['state'] : []);
      if (dto.action === 'MARK_STALE') {
        const current = await client.query<DbRow>(
          `SELECT current_version_id::text AS current_version_id FROM business_blueprints
           WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='ACTIVE' FOR SHARE`,
          [review.blueprint_id, scope.tenantId, scope.factoryId],
        );
        if (String(current.rows[0]?.current_version_id ?? '') !== String(review.blueprint_version_id)) {
          throw new ConflictException({ code: 'CBB_STALENESS_SOURCE_VERSION_ADVANCED', message: 'Rescan staleness against the current CBB version before marking an item stale' });
        }
      }
      let proposalId: string | null = null;
      if (dto.action === 'MARK_STALE') {
        const proposal = await client.query<DbRow>(
          `INSERT INTO business_change_proposals
             (tenant_id,factory_id,blueprint_id,source_version_id,target_type,target_id,proposal_type,
              proposed_state,proposed_payload,status,reason,requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,'SET_STATE','STALE',$7::jsonb,'PENDING',$8,$9)
           RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, review.blueprint_id, review.blueprint_version_id,
            review.target_type, review.target_id,
            JSON.stringify({ state: 'STALE', stalenessReviewId: reviewId, lastEvidenceAt: review.last_evidence_at }),
            reason, scope.userId],
        );
        proposalId = proposal.rows[0] ? String(proposal.rows[0].id) : null;
        if (!proposalId) throw new Error('CBB_STALENESS_CHANGE_PROPOSAL_FAILED');
      }
      const status = dto.action === 'MARK_STALE' ? 'MARKED_STALE' : dto.action === 'RECONFIRM' ? 'RECONFIRMED' : 'DISMISSED';
      const updated = await client.query<DbRow>(
        `UPDATE business_cbb_staleness_reviews SET review_status=$1,review_version=review_version+1,
           reviewed_by=$2,reviewed_at=NOW(),review_reason=$3
         WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND review_status='OPEN' AND review_version=$7
         RETURNING id::text AS id,review_status,review_version,reviewed_at::text AS reviewed_at`,
        [status, scope.userId, reason, reviewId, scope.tenantId, scope.factoryId, dto.expected_version],
      );
      if (!updated.rows[0]) throw new ConflictException('Staleness review changed before the decision could be committed');
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'CBB_STALENESS', action: dto.action, resourceType: 'CBB_STALENESS_REVIEW',
        resourceId: reviewId, payload: { status, proposalId, reason, version: Number(updated.rows[0].review_version) },
      });
      return { ...updated.rows[0], proposalId };
    });
  }

  async listTerminology(tenantId: string, factoryId: string, userId: string, search?: string) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    const blueprint = await this.database.query<DbRow>(
      `SELECT b.id::text AS blueprint_id,b.current_version_id::text AS version_id FROM business_blueprints b
       WHERE b.tenant_id=$1 AND b.factory_id=$2 AND b.status='ACTIVE' LIMIT 1`,
      [tenantId, factoryId], { tenantId },
    );
    const blueprintId = blueprint.rows[0]?.blueprint_id ? String(blueprint.rows[0].blueprint_id) : null;
    const versionId = blueprint.rows[0]?.version_id ? String(blueprint.rows[0].version_id) : null;
    if (!blueprintId || !versionId ||
        !(await this.filterItemsByAcl(tenantId, factoryId, userId, 'BLUEPRINT', [{ id: blueprintId }])).length) {
      return { canonicalTerms: [], aliases: [] };
    }

    const termRows = await this.database.query<DbRow>(
      `SELECT id::text AS id,term,canonical_term,language_code,source_system,state,confidence,metadata
       FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3
         AND ($4::text IS NULL OR term ILIKE '%' || $4 || '%' OR canonical_term ILIKE '%' || $4 || '%')
       ORDER BY lower(canonical_term),lower(term) LIMIT 500`,
      [tenantId, factoryId, versionId, search?.trim() || null], { tenantId },
    );
    const canonicalTerms = await this.filterItemsByAcl(
      tenantId, factoryId, userId, 'TERM', termRows.rows as Array<Record<string, unknown>>,
    );
    const aliasResult = await this.database.query<DbRow>(
      `SELECT id::text AS id,alias,canonical_term,language_code,source_system,state,metadata,
         version,created_by::text AS created_by,updated_by::text AS updated_by,created_at::text AS created_at,
         updated_at::text AS updated_at
       FROM business_terminology_aliases WHERE tenant_id=$1 AND factory_id=$2
         AND ($3::text IS NULL OR alias ILIKE '%' || $3 || '%' OR canonical_term ILIKE '%' || $3 || '%')
       ORDER BY lower(canonical_term),lower(alias),source_system NULLS FIRST,language_code NULLS FIRST LIMIT 500`,
      [tenantId, factoryId, search?.trim() || null], { tenantId },
    );
    const aliases = await this.filterTerminologyAliasesByAcl(
      tenantId, factoryId, userId, versionId, aliasResult.rows,
    );
    return { blueprintVersionId: versionId, canonicalTerms, aliases };
  }

  async createTerminologyAlias(scope: Scope, dto: CreateCbbTerminologyAliasDto) {
    this.validateScope(scope);
    const alias = this.requiredText(dto.alias, 'alias', 300).normalize('NFKC');
    const canonical = this.requiredText(dto.canonical_term, 'canonical_term', 300).normalize('NFKC');
    if (alias.toLocaleLowerCase() === canonical.toLocaleLowerCase()) {
      throw new BadRequestException('Alias must differ from its canonical term');
    }
    const languageCode = dto.language_code?.trim().normalize('NFKC').toLocaleLowerCase() || null;
    const sourceSystem = dto.source_system?.trim().normalize('NFKC') || null;
    const metadata = dto.metadata ?? {};
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8192) {
      throw new BadRequestException('Terminology metadata cannot exceed 8 KiB');
    }
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const blueprint = await this.currentBlueprint(client, scope, true);
      const canonicalFound = await client.query<DbRow>(
        `SELECT id::text AS id,canonical_term FROM business_terms WHERE tenant_id=$1 AND factory_id=$2
           AND blueprint_version_id=$3 AND lower(canonical_term)=lower($4)
           AND state IN ('VERIFIED','INFERRED') LIMIT 1`,
        [scope.tenantId, scope.factoryId, blueprint.current_version_id, canonical],
      );
      if (!canonicalFound.rows[0]) throw new NotFoundException('Canonical term must exist in the current CBB dictionary');
      await this.assertTargetWriteAccessInClient(client, scope, 'TERM', String(canonicalFound.rows[0].id), ['canonical_term']);

      const conflictingCanonical = await client.query<DbRow>(
        `SELECT canonical_term FROM business_terms WHERE tenant_id=$1 AND factory_id=$2
           AND blueprint_version_id=$3 AND lower(term)=lower($4) AND lower(canonical_term)<>lower($5)
           AND ($6::text IS NULL OR source_system IS NULL OR lower(source_system)=lower($6))
           AND ($7::text IS NULL OR language_code IS NULL OR lower(language_code)=lower($7)) LIMIT 1`,
        [scope.tenantId, scope.factoryId, blueprint.current_version_id, alias, canonical, sourceSystem, languageCode],
      );
      if (conflictingCanonical.rows[0]) {
        throw new ConflictException({
          code: 'CBB_TERMINOLOGY_CANONICAL_CONFLICT',
          existingCanonicalTerm: conflictingCanonical.rows[0].canonical_term,
        });
      }

      // A source/language-qualified alias is a separate dictionary entry. Serialize
      // the exact uniqueness key so concurrent imports cannot create duplicate mappings.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`cbb-terminology:${scope.tenantId}:${scope.factoryId}:${alias.toLocaleLowerCase()}:${languageCode ?? '*'}:${sourceSystem?.toLocaleLowerCase() ?? '*'}`],
      );
      const foundAlias = await client.query<DbRow>(
        `SELECT id::text AS id,canonical_term FROM business_terminology_aliases
         WHERE tenant_id=$1 AND factory_id=$2 AND lower(alias)=lower($3)
           AND COALESCE(lower(language_code),'')=COALESCE(lower($4),'')
           AND COALESCE(lower(source_system),'')=COALESCE(lower($5)) FOR UPDATE`,
        [scope.tenantId, scope.factoryId, alias, languageCode, sourceSystem],
      );
      if (foundAlias.rows[0]) {
        throw new ConflictException({
          code: 'CBB_TERMINOLOGY_ALIAS_EXISTS',
          existingCanonicalTerm: foundAlias.rows[0].canonical_term,
          message: 'An alias already exists for this source/language context',
        });
      }
      const inserted = await client.query<DbRow>(
        `INSERT INTO business_terminology_aliases
           (tenant_id,factory_id,alias,canonical_term,language_code,source_system,state,metadata,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'PROPOSED',$7::jsonb,$8,$8)
         RETURNING id::text AS id,alias,canonical_term,language_code,source_system,state,metadata,version,created_at::text AS created_at`,
        [scope.tenantId, scope.factoryId, alias, String(canonicalFound.rows[0].canonical_term),
          languageCode, sourceSystem, JSON.stringify(metadata), scope.userId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('CBB_TERMINOLOGY_ALIAS_INSERT_FAILED');
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'CBB_TERMINOLOGY', action: 'CREATE_ALIAS', resourceType: 'CBB_TERMINOLOGY_ALIAS',
        resourceId: String(row.id),
        payload: { alias, canonicalTerm: row.canonical_term, sourceSystem, languageCode },
      });
      return row;
    });
  }

  async decideTerminologyAlias(scope: Scope, aliasId: string, dto: DecideCbbTerminologyAliasDto) {
    this.validateScope(scope);
    this.uuid(aliasId, 'aliasId');
    const reason = this.requiredText(dto.reason, 'reason', 2000);
    if (reason.length < 10) throw new BadRequestException('reason must contain at least 10 characters');
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const selected = await client.query<DbRow>(
        `SELECT a.id::text AS id,a.state,a.version,a.alias,a.canonical_term,t.id::text AS canonical_term_id
         FROM business_terminology_aliases a
         JOIN business_blueprints b ON b.tenant_id=a.tenant_id AND b.factory_id=a.factory_id AND b.status='ACTIVE'
         JOIN LATERAL (
           SELECT term.id FROM business_terms term
           WHERE term.tenant_id=a.tenant_id AND term.factory_id=a.factory_id
             AND term.blueprint_version_id=b.current_version_id
             AND lower(term.canonical_term)=lower(a.canonical_term)
             AND term.state IN ('VERIFIED','INFERRED')
           ORDER BY CASE term.state WHEN 'VERIFIED' THEN 0 ELSE 1 END,term.id
           LIMIT 1
         ) t ON TRUE
         WHERE a.id=$1 AND a.tenant_id=$2 AND a.factory_id=$3
         FOR UPDATE OF a`,
        [aliasId, scope.tenantId, scope.factoryId],
      );
      const alias = selected.rows[0];
      if (!alias) throw new NotFoundException('Terminology alias or its current canonical term was not found in this factory');
      if (Number(alias.version) !== dto.expected_version) {
        throw new ConflictException({ code: 'CBB_TERMINOLOGY_VERSION_MISMATCH', currentVersion: Number(alias.version) });
      }
      await this.assertTargetWriteAccessInClient(
        client, scope, 'TERM', String(alias.canonical_term_id), ['canonical_term'],
      );
      if (alias.state === 'STALE') throw new ConflictException('A stale alias cannot be reactivated; create a new alias revision');
      if (dto.action === 'VERIFY' && alias.state !== 'PROPOSED') {
        throw new ConflictException('Only proposed terminology aliases can be verified');
      }
      const nextState = dto.action === 'VERIFY' ? 'VERIFIED' : 'STALE';
      const updated = await client.query<DbRow>(
        `UPDATE business_terminology_aliases SET state=$1,updated_by=$2,updated_at=NOW(),version=version+1
         WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND version=$6
         RETURNING id::text AS id,alias,canonical_term,state,version,updated_at::text AS updated_at`,
        [nextState, scope.userId, aliasId, scope.tenantId, scope.factoryId, dto.expected_version],
      );
      if (!updated.rows[0]) throw new ConflictException('Terminology alias changed before the decision could be committed');
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'CBB_TERMINOLOGY', action: dto.action === 'VERIFY' ? 'VERIFY_ALIAS' : 'MARK_ALIAS_STALE',
        resourceType: 'CBB_TERMINOLOGY_ALIAS', resourceId: aliasId,
        payload: { state: nextState, version: Number(updated.rows[0].version), reason },
      });
      return updated.rows[0];
    });
  }

  async resolveTerminology(
    tenantId: string,
    factoryId: string,
    userId: string,
    term: string,
    sourceSystem?: string,
    languageCode?: string,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    const needle = this.requiredText(term, 'term', 300).normalize('NFKC');
    const normalizedSourceSystem = sourceSystem?.trim() || null;
    const normalizedLanguage = languageCode?.trim().normalize('NFKC') || null;
    const blueprint = await this.database.query<DbRow>(
      `SELECT id::text AS blueprint_id,current_version_id::text AS version_id FROM business_blueprints
       WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' LIMIT 1`,
      [tenantId, factoryId], { tenantId },
    );
    const blueprintId = blueprint.rows[0]?.blueprint_id ? String(blueprint.rows[0].blueprint_id) : null;
    const versionId = blueprint.rows[0]?.version_id ? String(blueprint.rows[0].version_id) : null;
    if (!blueprintId || !versionId ||
        !(await this.filterItemsByAcl(tenantId, factoryId, userId, 'BLUEPRINT', [{ id: blueprintId }])).length) {
      return { input: needle, match: null, matchedBy: null, candidates: [] };
    }

    const direct = await this.database.query<DbRow>(
      `SELECT id::text AS id,term,canonical_term,language_code,source_system,state,confidence
       FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3
         AND (lower(term)=lower($4) OR lower(canonical_term)=lower($4))
         AND ($5::text IS NULL OR source_system IS NULL OR lower(source_system)=lower($5))
         AND ($6::text IS NULL OR language_code IS NULL OR lower(language_code)=lower($6))
       ORDER BY CASE state WHEN 'VERIFIED' THEN 0 WHEN 'INFERRED' THEN 1 ELSE 2 END,lower(term) LIMIT 20`,
      [tenantId, factoryId, versionId, needle, normalizedSourceSystem, normalizedLanguage], { tenantId },
    );
    const visibleDirect = await this.filterItemsByAcl(
      tenantId, factoryId, userId, 'TERM', direct.rows as Array<Record<string, unknown>>,
    );
    const trustedDirect = visibleDirect.filter((row) => ['VERIFIED', 'INFERRED'].includes(String(row.state)));
    if (trustedDirect.length) {
      const canonicalKeys = new Set(trustedDirect.map((row) =>
        String(row.canonical_term ?? row.term).normalize('NFKC').toLocaleLowerCase()));
      if (canonicalKeys.size === 1) {
        return { input: needle, match: trustedDirect[0], matchedBy: 'CBB_TERM', candidates: trustedDirect };
      }
      return { input: needle, match: null, matchedBy: null, ambiguous: true, candidates: trustedDirect };
    }

    const aliases = await this.database.query<DbRow>(
      `SELECT a.alias,a.canonical_term,a.language_code,a.source_system,a.state,a.version,
          t.id::text AS canonical_term_id
       FROM business_terminology_aliases a
       JOIN business_terms t ON t.tenant_id=a.tenant_id AND t.factory_id=a.factory_id
         AND t.blueprint_version_id=$4 AND lower(t.canonical_term)=lower(a.canonical_term)
         AND t.state IN ('VERIFIED','INFERRED')
       WHERE a.tenant_id=$1 AND a.factory_id=$2 AND lower(a.alias)=lower($3)
         AND a.state IN ('VERIFIED','INFERRED')
         AND ($5::text IS NULL OR a.source_system IS NULL OR lower(a.source_system)=lower($5))
         AND ($6::text IS NULL OR a.language_code IS NULL OR lower(a.language_code)=lower($6))
       ORDER BY CASE a.state WHEN 'VERIFIED' THEN 0 ELSE 1 END,a.version DESC LIMIT 20`,
      [tenantId, factoryId, needle, versionId, normalizedSourceSystem, normalizedLanguage], { tenantId },
    );
    const visibleCanonicalTerms = await this.filterItemsByAcl(
      tenantId, factoryId, userId, 'TERM',
      aliases.rows.map((row) => ({ ...row, id: String(row.canonical_term_id) })),
    );
    const visibleCanonicalIds = new Set(visibleCanonicalTerms.map((row) => String(row.id)));
    const visibleAliases = aliases.rows.filter((row) => visibleCanonicalIds.has(String(row.canonical_term_id)));
    const stripCanonicalTermId = (row: DbRow) => {
      const value = { ...row };
      delete value.canonical_term_id;
      return value;
    };
    if (visibleAliases.length) {
      const canonicals = new Set(visibleAliases.map((row) => String(row.canonical_term).normalize('NFKC').toLocaleLowerCase()));
      const safeAliases = visibleAliases.map(stripCanonicalTermId);
      if (canonicals.size === 1) {
        return { input: needle, match: safeAliases[0], matchedBy: 'ALIAS', candidates: safeAliases };
      }
      return { input: needle, match: null, matchedBy: null, ambiguous: true, candidates: safeAliases };
    }

    const suggestions = await this.database.query<DbRow>(
      `SELECT a.alias,a.canonical_term,a.language_code,a.source_system,a.state,t.id::text AS canonical_term_id
       FROM business_terminology_aliases a
       JOIN business_terms t ON t.tenant_id=a.tenant_id AND t.factory_id=a.factory_id
         AND t.blueprint_version_id=$4 AND lower(t.canonical_term)=lower(a.canonical_term)
         AND t.state IN ('VERIFIED','INFERRED')
       WHERE a.tenant_id=$1 AND a.factory_id=$2
         AND lower(a.alias) LIKE '%' || lower($3) || '%' AND a.state='PROPOSED'
         AND ($5::text IS NULL OR a.language_code IS NULL OR lower(a.language_code)=lower($5))
         AND ($6::text IS NULL OR a.source_system IS NULL OR lower(a.source_system)=lower($6))
       ORDER BY lower(a.alias) LIMIT 10`,
      [tenantId, factoryId, needle, versionId, normalizedLanguage, normalizedSourceSystem], { tenantId },
    );
    const visibleSuggestionTerms = await this.filterItemsByAcl(
      tenantId, factoryId, userId, 'TERM',
      suggestions.rows.map((row) => ({ ...row, id: String(row.canonical_term_id) })),
    );
    const visibleSuggestionIds = new Set(visibleSuggestionTerms.map((row) => String(row.id)));
    const safeSuggestions = suggestions.rows
      .filter((row) => visibleSuggestionIds.has(String(row.canonical_term_id)))
      .map(stripCanonicalTermId);
    return { input: needle, match: null, matchedBy: null, candidates: safeSuggestions };
  }

  /**
   * An alias is visible only when its canonical CBB term is visible.
   * Resolve the canonical independently of the user's search string; otherwise
   * searching by alias alone leaks either nothing or alias rows for hidden terms.
   */
  private async filterTerminologyAliasesByAcl(
    tenantId: string,
    factoryId: string,
    userId: string,
    versionId: string,
    aliases: DbRow[],
  ): Promise<DbRow[]> {
    if (!aliases.length) return [];
    const canonicalKeys = [...new Set(aliases.map((row) =>
      String(row.canonical_term).normalize('NFKC').toLocaleLowerCase()).filter(Boolean))];
    if (!canonicalKeys.length) return [];
    const terms = await this.database.query<DbRow>(
      `SELECT DISTINCT ON (lower(canonical_term)) id::text AS id,canonical_term,term,state
       FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3
         AND lower(canonical_term)=ANY($4::text[]) AND state IN ('VERIFIED','INFERRED')
       ORDER BY lower(canonical_term),CASE state WHEN 'VERIFIED' THEN 0 ELSE 1 END,lower(term)`,
      [tenantId, factoryId, versionId, canonicalKeys], { tenantId },
    );
    const visibleTerms = await this.filterItemsByAcl(
      tenantId, factoryId, userId, 'TERM', terms.rows as Array<Record<string, unknown>>,
    );
    const visibleKeys = new Set(visibleTerms.map((row) =>
      String(row.canonical_term ?? '').normalize('NFKC').toLocaleLowerCase()));
    return aliases.filter((row) =>
      visibleKeys.has(String(row.canonical_term).normalize('NFKC').toLocaleLowerCase()));
  }

  async addImpactLink(scope: Scope, dto: CreateCbbImpactLinkDto) {
    this.validateScope(scope);
    this.validateTargetType(dto.source_type);
    this.uuid(dto.source_id, 'source_id');
    const impactedRef = this.requiredText(dto.impacted_ref, 'impacted_ref', 300);
    const description = dto.description?.trim() || null;
    const metadata = dto.metadata ?? {};
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8192) throw new BadRequestException('Impact metadata cannot exceed 8 KiB');
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const blueprint = await this.currentBlueprint(client, scope, true);
      await this.assertTarget(client, scope, dto.source_type, dto.source_id, blueprint.id, blueprint.current_version_id);
      await this.assertTargetWriteAccessInClient(client, scope, dto.source_type, dto.source_id);
      const existing = await client.query<DbRow>(
        `SELECT id::text AS id FROM business_cbb_impact_links WHERE tenant_id=$1 AND factory_id=$2
         AND blueprint_version_id=$3 AND source_type=$4 AND source_id=$5 AND impacted_type=$6
         AND lower(impacted_ref)=lower($7) AND impact_type=$8 LIMIT 1`,
        [scope.tenantId, scope.factoryId, blueprint.current_version_id, dto.source_type, dto.source_id,
          dto.impacted_type, impactedRef, dto.impact_type ?? 'DEPENDS_ON'],
      );
      if (existing.rows[0]) throw new ConflictException('This CBB impact link already exists in the current version');
      const inserted = await client.query<DbRow>(
        `INSERT INTO business_cbb_impact_links
          (tenant_id,factory_id,blueprint_id,blueprint_version_id,source_type,source_id,impacted_type,impacted_ref,impact_type,description,metadata,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         RETURNING id::text AS id,source_type,source_id::text AS source_id,impacted_type,impacted_ref,impact_type,description,created_at::text AS created_at`,
        [scope.tenantId, scope.factoryId, blueprint.id, blueprint.current_version_id, dto.source_type,
          dto.source_id, dto.impacted_type, impactedRef, dto.impact_type ?? 'DEPENDS_ON', description, JSON.stringify(metadata), scope.userId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('CBB_IMPACT_LINK_INSERT_FAILED');
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'CBB_IMPACT_TRACE', action: 'ADD_IMPACT_LINK', resourceType: 'CBB_IMPACT_LINK',
        resourceId: String(row.id), payload: { sourceType: dto.source_type, sourceId: dto.source_id,
          impactedType: dto.impacted_type, impactedRef, impactType: dto.impact_type ?? 'DEPENDS_ON' },
      });
      return row;
    });
  }

  async getImpactTrace(tenantId: string, factoryId: string, userId: string, sourceType: TargetType, sourceId: string, depth = 3) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    this.validateTargetType(sourceType);
    if (sourceType === 'BLUEPRINT') throw new BadRequestException('Impact trace requires a typed graph target, not the whole blueprint');
    this.uuid(sourceId, 'sourceId');
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) {
      throw new NotFoundException('CBB blueprint was not found or is not visible to this role');
    }
    if (!Number.isInteger(depth) || depth < 1 || depth > 5) throw new BadRequestException('depth must be between 1 and 5');
    await this.assertTargetReadable(tenantId, factoryId, userId, sourceType, sourceId);
    const bp = await this.database.query<DbRow>(
      `SELECT id::text AS blueprint_id,current_version_id::text AS version_id FROM business_blueprints
       WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' LIMIT 1`,
      [tenantId, factoryId], { tenantId },
    );
    const blueprintId = bp.rows[0]?.blueprint_id ? String(bp.rows[0].blueprint_id) : null;
    const versionId = bp.rows[0]?.version_id ? String(bp.rows[0].version_id) : null;
    if (!blueprintId || !versionId) return { sourceType, sourceId, graph: [], externalImpacts: [] };

    let graph: Array<Record<string, unknown>> = [];
    if (sourceType === 'ENTITY') {
      const trace = await this.database.query<DbRow>(
        `WITH RECURSIVE walk AS (
           SELECT e.id,e.entity_type,e.name,e.state,e.confidence,0::int AS depth,ARRAY[e.id]::uuid[] AS path
           FROM business_entities e WHERE e.id=$5 AND e.tenant_id=$1 AND e.factory_id=$2 AND e.blueprint_version_id=$3
           UNION ALL
           SELECT target.id,target.entity_type,target.name,target.state,target.confidence,w.depth+1,w.path || target.id
           FROM walk w
           JOIN business_relations r ON r.from_entity_id=w.id AND r.tenant_id=$1 AND r.factory_id=$2
             AND r.blueprint_version_id=$3 AND r.state IN ('VERIFIED','INFERRED')
             AND (
               NOT EXISTS (
                 SELECT 1 FROM business_acl relation_acl
                 WHERE relation_acl.tenant_id=$1 AND relation_acl.factory_id=$2
                   AND relation_acl.target_type='RELATION' AND relation_acl.target_id=r.id
                   AND relation_acl.field_name IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM business_acl relation_acl
                 JOIN tenant_memberships membership ON membership.tenant_id=relation_acl.tenant_id
                   AND membership.user_id=$7 AND membership.status='ACTIVE'
                 JOIN user_roles assigned_role ON assigned_role.membership_id=membership.id
                   AND assigned_role.role_id=relation_acl.role_id
                   AND (assigned_role.factory_id IS NULL OR assigned_role.factory_id=$2)
                 WHERE relation_acl.tenant_id=$1 AND relation_acl.factory_id=$2
                   AND relation_acl.target_type='RELATION' AND relation_acl.target_id=r.id
                   AND relation_acl.field_name IS NULL
               )
             )
           JOIN business_entities target ON target.id=r.to_entity_id AND target.tenant_id=$1 AND target.factory_id=$2
             AND target.blueprint_version_id=$3 AND target.state IN ('VERIFIED','INFERRED')
             AND (
               NOT EXISTS (
                 SELECT 1 FROM business_acl entity_acl
                 WHERE entity_acl.tenant_id=$1 AND entity_acl.factory_id=$2
                   AND entity_acl.target_type='ENTITY' AND entity_acl.target_id=target.id
                   AND entity_acl.field_name IS NULL
               )
               OR EXISTS (
                 SELECT 1
                 FROM business_acl entity_acl
                 JOIN tenant_memberships membership ON membership.tenant_id=entity_acl.tenant_id
                   AND membership.user_id=$7 AND membership.status='ACTIVE'
                 JOIN user_roles assigned_role ON assigned_role.membership_id=membership.id
                   AND assigned_role.role_id=entity_acl.role_id
                   AND (assigned_role.factory_id IS NULL OR assigned_role.factory_id=$2)
                 WHERE entity_acl.tenant_id=$1 AND entity_acl.factory_id=$2
                   AND entity_acl.target_type='ENTITY' AND entity_acl.target_id=target.id
                   AND entity_acl.field_name IS NULL
               )
             )
           WHERE w.depth < $4 AND NOT target.id=ANY(w.path)
             AND NOT EXISTS (SELECT 1 FROM business_conflicts c WHERE c.tenant_id=$1 AND c.factory_id=$2
               AND c.blueprint_id=$6 AND c.subject_type='ENTITY' AND c.subject_id=target.id AND c.status='OPEN')
         )
         SELECT DISTINCT id::text AS id,entity_type,name,state,confidence,MIN(depth) AS depth FROM walk GROUP BY id,entity_type,name,state,confidence
         ORDER BY depth,name LIMIT 250`,
        [tenantId, factoryId, versionId, depth, sourceId, blueprintId, userId], { tenantId },
      );
      graph = await this.filterItemsByAcl(tenantId, factoryId, userId, 'ENTITY',
        trace.rows.map((row) => ({ ...row, id: String(row.id), depth: Number(row.depth) })) as Array<Record<string, unknown>>);
    }
    const graphIds = graph.map((item) => String(item.id));
    const externalRows = await this.database.query<DbRow>(
      `SELECT id::text AS id,source_type,source_id::text AS source_id,impacted_type,impacted_ref,impact_type,description,metadata
       FROM business_cbb_impact_links WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_id=$3 AND blueprint_version_id=$4
         AND ((source_type=$5 AND source_id=$6) OR (source_type='ENTITY' AND source_id=ANY($7::uuid[])))
       ORDER BY source_type,source_id,impacted_type,impacted_ref`,
      [tenantId, factoryId, blueprintId, versionId, sourceType, sourceId, graphIds], { tenantId },
    );
    return {
      sourceType, sourceId, blueprintId, blueprintVersionId: versionId,
      graph,
      externalImpacts: externalRows.rows,
      depth,
      caveat: 'Graph traversal follows directed, verified/inferred CBB entity relations. External impacts are explicit, version-bound references, not inferred order/KPI/workflow state.',
    };
  }

  async rollbackToVersion(scope: Scope, dto: RollbackCbbVersionDto) {
    this.validateScope(scope);
    this.uuid(dto.source_version_id, 'source_version_id');
    this.uuid(dto.expected_current_version_id, 'expected_current_version_id');
    const reason = this.requiredText(dto.reason, 'reason', 2000);
    if (reason.length < 10) throw new BadRequestException('reason must contain at least 10 characters');
    if (dto.correlation_id) this.uuid(dto.correlation_id, 'correlation_id');
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const blueprintResult = await client.query<DbRow>(
        `SELECT id::text AS id,current_version_id::text AS current_version_id FROM business_blueprints
         WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' FOR UPDATE`,
        [scope.tenantId, scope.factoryId],
      );
      const blueprint = blueprintResult.rows[0];
      if (!blueprint || !blueprint.current_version_id) throw new NotFoundException('Active CBB blueprint/version was not found');
      const currentVersionId = String(blueprint.current_version_id);
      if (currentVersionId !== dto.expected_current_version_id) {
        throw new ConflictException({ code: 'CBB_ROLLBACK_CURRENT_VERSION_MISMATCH', currentVersionId });
      }
      if (currentVersionId === dto.source_version_id) throw new ConflictException('Rollback target is already the current version');
      const targetResult = await client.query<DbRow>(
        `SELECT id::text AS id,version,graph_hash,evidence_count,readiness_score
         FROM business_blueprint_versions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND blueprint_id=$4 FOR SHARE`,
        [dto.source_version_id, scope.tenantId, scope.factoryId, blueprint.id],
      );
      const source = targetResult.rows[0];
      if (!source) throw new NotFoundException('Rollback target version was not found in this factory blueprint');
      await this.assertTargetWriteAccessInClient(client, scope, 'BLUEPRINT', String(blueprint.id));
      const next = await client.query<DbRow>(
        `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM business_blueprint_versions
         WHERE blueprint_id=$1 AND tenant_id=$2 AND factory_id=$3`,
        [blueprint.id, scope.tenantId, scope.factoryId],
      );
      const nextVersion = Number(next.rows[0]?.next_version ?? 0);
      if (!Number.isInteger(nextVersion) || nextVersion < 1) throw new Error('CBB_ROLLBACK_VERSION_ALLOCATION_FAILED');
      const created = await client.query<DbRow>(
        `INSERT INTO business_blueprint_versions
           (tenant_id,factory_id,blueprint_id,version,graph_hash,evidence_count,readiness_score,status,change_reason,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9)
         RETURNING id::text AS id,version`,
        [scope.tenantId, scope.factoryId, blueprint.id, nextVersion, source.graph_hash,
          source.evidence_count, source.readiness_score, `Audited rollback to CBB version ${source.version}: ${reason}`, scope.userId],
      );
      const versionRow = created.rows[0];
      if (!versionRow) throw new Error('CBB_ROLLBACK_VERSION_INSERT_FAILED');
      const newVersionId = String(versionRow.id);
      const maps: Record<string, Map<string, string>> = {};
      for (const type of ['ENTITY','RELATION','PROCESS','PROCESS_STEP','RULE','TERM','EXCEPTION'] as const) maps[type] = new Map();

      const entities = await client.query<DbRow>(
        `SELECT id::text AS id,entity_type,name,description,state,confidence,metadata,created_by::text AS created_by
         FROM business_entities WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY id`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of entities.rows) {
        const copy = await client.query<DbRow>(
          `INSERT INTO business_entities (tenant_id,factory_id,blueprint_version_id,entity_type,name,description,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, row.entity_type, row.name, row.description, row.state,
            row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_ENTITY_CLONE_FAILED');
        maps.ENTITY.set(String(row.id), String(copy.rows[0].id));
      }

      const relations = await client.query<DbRow>(
        `SELECT id::text AS id,from_entity_id::text AS from_entity_id,to_entity_id::text AS to_entity_id,
           relation_type,state,confidence,metadata,created_by::text AS created_by
         FROM business_relations WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY id`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of relations.rows) {
        const from = maps.ENTITY.get(String(row.from_entity_id));
        const to = maps.ENTITY.get(String(row.to_entity_id));
        if (!from || !to) throw new Error('CBB_ROLLBACK_RELATION_ENDPOINT_MISSING');
        const copy = await client.query<DbRow>(
          `INSERT INTO business_relations (tenant_id,factory_id,blueprint_version_id,from_entity_id,to_entity_id,relation_type,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, from, to, row.relation_type, row.state,
            row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_RELATION_CLONE_FAILED');
        maps.RELATION.set(String(row.id), String(copy.rows[0].id));
      }

      const processes = await client.query<DbRow>(
        `SELECT id::text AS id,name,description,owner_ref,state,confidence,metadata,created_by::text AS created_by
         FROM business_processes WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY id`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of processes.rows) {
        const copy = await client.query<DbRow>(
          `INSERT INTO business_processes (tenant_id,factory_id,blueprint_version_id,name,description,owner_ref,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, row.name, row.description, row.owner_ref, row.state,
            row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_PROCESS_CLONE_FAILED');
        maps.PROCESS.set(String(row.id), String(copy.rows[0].id));
      }

      const steps = await client.query<DbRow>(
        `SELECT id::text AS id,process_id::text AS process_id,sequence_no,name,description,owner_ref,inputs,outputs,state,confidence,metadata,created_by::text AS created_by
         FROM business_process_steps WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY process_id,sequence_no`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of steps.rows) {
        const processId = maps.PROCESS.get(String(row.process_id));
        if (!processId) throw new Error('CBB_ROLLBACK_PROCESS_STEP_PARENT_MISSING');
        const copy = await client.query<DbRow>(
          `INSERT INTO business_process_steps
             (tenant_id,factory_id,blueprint_version_id,process_id,sequence_no,name,description,owner_ref,inputs,outputs,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, processId, row.sequence_no, row.name, row.description,
            row.owner_ref, JSON.stringify(row.inputs ?? []), JSON.stringify(row.outputs ?? []), row.state,
            row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_PROCESS_STEP_CLONE_FAILED');
        maps.PROCESS_STEP.set(String(row.id), String(copy.rows[0].id));
      }

      const rules = await client.query<DbRow>(
        `SELECT id::text AS id,name,rule_type,description,expression_ref,state,confidence,metadata,created_by::text AS created_by
         FROM business_rules WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY id`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of rules.rows) {
        const copy = await client.query<DbRow>(
          `INSERT INTO business_rules (tenant_id,factory_id,blueprint_version_id,name,rule_type,description,expression_ref,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, row.name, row.rule_type, row.description, row.expression_ref,
            row.state, row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_RULE_CLONE_FAILED');
        maps.RULE.set(String(row.id), String(copy.rows[0].id));
      }

      const terms = await client.query<DbRow>(
        `SELECT id::text AS id,term,canonical_term,language_code,source_system,state,confidence,metadata,created_by::text AS created_by
         FROM business_terms WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY id`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of terms.rows) {
        const copy = await client.query<DbRow>(
          `INSERT INTO business_terms (tenant_id,factory_id,blueprint_version_id,term,canonical_term,language_code,source_system,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, row.term, row.canonical_term, row.language_code, row.source_system,
            row.state, row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_TERM_CLONE_FAILED');
        maps.TERM.set(String(row.id), String(copy.rows[0].id));
      }

      const exceptions = await client.query<DbRow>(
        `SELECT id::text AS id,name,description,trigger_ref,handling_ref,state,confidence,metadata,created_by::text AS created_by
         FROM business_exceptions WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_version_id=$3 ORDER BY id`,
        [scope.tenantId, scope.factoryId, dto.source_version_id],
      );
      for (const row of exceptions.rows) {
        const copy = await client.query<DbRow>(
          `INSERT INTO business_exceptions (tenant_id,factory_id,blueprint_version_id,name,description,trigger_ref,handling_ref,state,confidence,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id::text AS id`,
          [scope.tenantId, scope.factoryId, newVersionId, row.name, row.description, row.trigger_ref, row.handling_ref,
            row.state, row.confidence, JSON.stringify(row.metadata ?? {}), row.created_by ?? scope.userId],
        );
        if (!copy.rows[0]) throw new Error('CBB_ROLLBACK_EXCEPTION_CLONE_FAILED');
        maps.EXCEPTION.set(String(row.id), String(copy.rows[0].id));
      }

      const promoted = await client.query<DbRow>(
        `UPDATE business_blueprints SET current_version_id=$1
         WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND current_version_id=$5
         RETURNING id::text AS id`,
        [newVersionId, blueprint.id, scope.tenantId, scope.factoryId, currentVersionId],
      );
      if (!promoted.rows[0]) throw new ConflictException('CBB changed while rollback was being committed');

      const links = await client.query<DbRow>(
        `SELECT evidence_id::text AS evidence_id,target_type,target_id::text AS target_id,link_type,created_by::text AS created_by
         FROM business_evidence_links WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_id=$3 AND blueprint_version_id=$4
         ORDER BY id`,
        [scope.tenantId, scope.factoryId, blueprint.id, dto.source_version_id],
      );
      let clonedLinks = 0;
      for (const link of links.rows) {
        const targetType = String(link.target_type) as TargetType;
        const targetId = targetType === 'BLUEPRINT' ? String(blueprint.id) : maps[targetType]?.get(String(link.target_id));
        if (!targetId) throw new Error('CBB_ROLLBACK_EVIDENCE_LINK_TARGET_MISSING');
        await client.query(
          `INSERT INTO business_evidence_links
             (tenant_id,factory_id,evidence_id,target_type,target_id,link_type,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [scope.tenantId, scope.factoryId, link.evidence_id, targetType, targetId, link.link_type, link.created_by ?? scope.userId],
        );
        clonedLinks += 1;
      }

      const impactLinks = await client.query<DbRow>(
        `SELECT source_type,source_id::text AS source_id,impacted_type,impacted_ref,impact_type,description,metadata,created_by::text AS created_by
         FROM business_cbb_impact_links WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_id=$3 AND blueprint_version_id=$4`,
        [scope.tenantId, scope.factoryId, blueprint.id, dto.source_version_id],
      );
      let clonedImpactLinks = 0;
      for (const link of impactLinks.rows) {
        const targetId = maps[String(link.source_type)]?.get(String(link.source_id));
        if (!targetId) throw new Error('CBB_ROLLBACK_IMPACT_LINK_TARGET_MISSING');
        await client.query(
          `INSERT INTO business_cbb_impact_links
             (tenant_id,factory_id,blueprint_id,blueprint_version_id,source_type,source_id,impacted_type,impacted_ref,impact_type,description,metadata,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
          [scope.tenantId, scope.factoryId, blueprint.id, newVersionId, link.source_type, targetId, link.impacted_type,
            link.impacted_ref, link.impact_type, link.description, JSON.stringify(link.metadata ?? {}), link.created_by ?? scope.userId],
        );
        clonedImpactLinks += 1;
      }

      const aclRows = await client.query<DbRow>(
        `SELECT role_id::text AS role_id,target_type,target_id::text AS target_id,field_name,access_level
         FROM business_acl WHERE tenant_id=$1 AND factory_id=$2`,
        [scope.tenantId, scope.factoryId],
      );
      let clonedAclGrants = 0;
      for (const grant of aclRows.rows) {
        const aclType = String(grant.target_type) as TargetType;
        const targetId = aclType === 'BLUEPRINT' ? String(blueprint.id) : maps[aclType]?.get(String(grant.target_id));
        if (!targetId) continue;
        if (targetId === String(grant.target_id)) continue;
        await client.query(
          `INSERT INTO business_acl (tenant_id,factory_id,role_id,target_type,target_id,field_name,access_level,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [scope.tenantId, scope.factoryId, grant.role_id, aclType, targetId, grant.field_name, grant.access_level, scope.userId],
        );
        clonedAclGrants += 1;
      }

      const openConflicts = await client.query<DbRow>(
        `SELECT subject_type,subject_id::text AS subject_id,description,evidence_refs
         FROM business_conflicts WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_id=$3 AND status='OPEN'`,
        [scope.tenantId, scope.factoryId, blueprint.id],
      );
      let clonedConflicts = 0;
      for (const conflict of openConflicts.rows) {
        const conflictTargetId = maps[String(conflict.subject_type)]?.get(String(conflict.subject_id));
        if (!conflictTargetId) continue;
        const already = await client.query<DbRow>(
          `SELECT id FROM business_conflicts WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_id=$3
             AND subject_type=$4 AND subject_id=$5 AND status='OPEN' LIMIT 1`,
          [scope.tenantId, scope.factoryId, blueprint.id, conflict.subject_type, conflictTargetId],
        );
        if (already.rows[0]) continue;
        await client.query(
          `INSERT INTO business_conflicts
             (tenant_id,factory_id,blueprint_id,subject_type,subject_id,status,description,evidence_refs,created_by,version,updated_by,updated_at)
           VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7::jsonb,$8,1,$8,NOW())`,
          [scope.tenantId, scope.factoryId, blueprint.id, conflict.subject_type, conflictTargetId,
            conflict.description, JSON.stringify(conflict.evidence_refs ?? []), scope.userId],
        );
        clonedConflicts += 1;
      }

      const rollback = await client.query<DbRow>(
        `INSERT INTO business_cbb_rollback_events
          (tenant_id,factory_id,blueprint_id,from_version_id,restored_from_version_id,to_version_id,reason,actor_user_id,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id::text AS id,created_at::text AS created_at`,
        [scope.tenantId, scope.factoryId, blueprint.id, currentVersionId, dto.source_version_id,
          newVersionId, reason, scope.userId, dto.correlation_id ?? null],
      );
      const rollbackEvent = rollback.rows[0];
      if (!rollbackEvent) throw new Error('CBB_ROLLBACK_EVENT_INSERT_FAILED');
      await this.auditService.recordWithClient(client, {
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'BUSINESS_MODEL_ROLLBACK', action: 'ROLLBACK_TO_VERSION', resourceType: 'CBB_BLUEPRINT_VERSION',
        resourceId: newVersionId,
        correlationId: dto.correlation_id ?? null,
        payload: { rollbackEventId: rollbackEvent.id, fromVersionId: currentVersionId,
          restoredFromVersionId: dto.source_version_id, toVersionId: newVersionId,
          restoredVersionNumber: Number(source.version), createdVersionNumber: nextVersion, reason,
          entities: maps.ENTITY.size, relations: maps.RELATION.size, processes: maps.PROCESS.size,
          processSteps: maps.PROCESS_STEP.size, rules: maps.RULE.size, terms: maps.TERM.size,
          exceptions: maps.EXCEPTION.size, evidenceLinks: clonedLinks, impactLinks: clonedImpactLinks,
          accessGrants: clonedAclGrants, openConflicts: clonedConflicts },
      });
      return {
        rollbackEventId: String(rollbackEvent.id),
        fromVersionId: currentVersionId,
        restoredFromVersionId: dto.source_version_id,
        version: { id: newVersionId, number: nextVersion },
        counts: { entities: maps.ENTITY.size, relations: maps.RELATION.size, processes: maps.PROCESS.size,
          processSteps: maps.PROCESS_STEP.size, rules: maps.RULE.size, terms: maps.TERM.size,
          exceptions: maps.EXCEPTION.size, evidenceLinks: clonedLinks, impactLinks: clonedImpactLinks,
          accessGrants: clonedAclGrants, openConflicts: clonedConflicts },
      };
    });
  }

  async listRollbackEvents(tenantId: string, factoryId: string, userId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) return [];
    const rows = await this.database.query<DbRow>(
      `SELECT id::text AS id,blueprint_id::text AS blueprint_id,from_version_id::text AS from_version_id,
         restored_from_version_id::text AS restored_from_version_id,to_version_id::text AS to_version_id,
         reason,actor_user_id::text AS actor_user_id,correlation_id::text AS correlation_id,created_at::text AS created_at
       FROM business_cbb_rollback_events WHERE tenant_id=$1 AND factory_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200`,
      [tenantId, factoryId], { tenantId },
    );
    return rows.rows;
  }

  async filterEvidenceResult(tenantId: string, factoryId: string, userId: string, result: unknown) {
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) {
      if (result && typeof result === 'object') {
        const value = result as Record<string, unknown>;
        if (Array.isArray(value.items)) return { ...value, items: [], total: 0 };
      }
      return result;
    }
    if (!result || typeof result !== 'object') return result;
    const value = result as Record<string, unknown>;
    if (!Array.isArray(value.items)) return result;
    const items = value.items as Array<Record<string, unknown>>;
    const links = items.flatMap((item) => Array.isArray(item.links)
      ? (item.links as Array<Record<string, unknown>>).map((link) => ({
          ...link,
          target_type: String(link.target_type),
          target_id: String(link.target_id),
        }))
      : []);
    const visibleLinks = await this.filterTargetRowsByAcl(tenantId, factoryId, userId, links as DbRow[]);
    const visibleKeys = new Set(visibleLinks.map((link) =>
      String(link.target_type) + ':' + String(link.target_id) + ':' + String(link.evidence_id ?? '')));
    const filteredItems = items.map((item) => {
      const sourceLinks = Array.isArray(item.links) ? item.links as Array<Record<string, unknown>> : [];
      return {
        ...item,
        links: sourceLinks.filter((link) => visibleKeys.has(
          String(link.target_type) + ':' + String(link.target_id) + ':' + String(link.evidence_id ?? ''),
        )),
      };
    });
    return { ...value, items: filteredItems };
  }

  async filterChangeProposalResult(tenantId: string, factoryId: string, userId: string, result: unknown) {
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) {
      if (result && typeof result === 'object') {
        const value = result as Record<string, unknown>;
        if (Array.isArray(value.items)) return { ...value, items: [], count: 0 };
      }
      return result;
    }
    if (!result || typeof result !== 'object') return result;
    const value = result as Record<string, unknown>;
    if (!Array.isArray(value.items)) return result;
    const items = value.items as Array<Record<string, unknown>>;
    const blueprintItems = items.filter((item) => String(item.targetType) === 'BLUEPRINT' && !item.targetId);
    const rows = items
      .filter((item) => item.targetId && String(item.targetType) !== 'BLUEPRINT')
      .map((item) => ({ ...item, target_type: String(item.targetType), target_id: String(item.targetId) })) as DbRow[];
    const visibleRows = await this.filterTargetRowsByAcl(tenantId, factoryId, userId, rows);
    const visibleKeys = new Set(visibleRows.map((row) => String(row.target_type) + ':' + String(row.target_id)));
    const visibleItems = items.filter((item) => {
      if (String(item.targetType) === 'BLUEPRINT') return blueprintItems.includes(item);
      return !!item.targetId && visibleKeys.has(String(item.targetType) + ':' + String(item.targetId));
    });
    return { ...value, items: visibleItems, count: visibleItems.length };
  }

  async filterConflictResult(tenantId: string, factoryId: string, userId: string, result: unknown) {
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) {
      if (result && typeof result === 'object') {
        const value = result as Record<string, unknown>;
        if (Array.isArray(value.items)) return { ...value, items: [], total: 0 };
      }
      return result;
    }
    if (!result || typeof result !== 'object') return result;
    const value = result as Record<string, unknown>;
    if (!Array.isArray(value.items)) return result;
    const items = value.items as Array<Record<string, unknown>>;
    const rows = items
      .filter((item) => item.subjectId && item.subjectType)
      .map((item) => ({ ...item, target_type: String(item.subjectType), target_id: String(item.subjectId) })) as DbRow[];
    const visibleRows = await this.filterTargetRowsByAcl(tenantId, factoryId, userId, rows);
    const visibleKeys = new Set(visibleRows.map((row) => String(row.target_type) + ':' + String(row.target_id)));
    const visibleItems = items.filter((item) =>
      !!item.subjectId && visibleKeys.has(String(item.subjectType) + ':' + String(item.subjectId)),
    );
    return { ...value, items: visibleItems, total: visibleItems.length };
  }

  async assertConflictReadAccess(tenantId: string, factoryId: string, userId: string, conflictId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    this.uuid(conflictId, 'conflictId');
    const result = await this.database.query<DbRow>(
      `SELECT subject_type,subject_id::text AS subject_id FROM business_conflicts
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [conflictId, tenantId, factoryId], { tenantId },
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('CBB conflict was not found in this factory');
    await this.assertTargetReadAccess(
      tenantId, factoryId, userId, String(row.subject_type) as TargetType, String(row.subject_id),
    );
    return { allowed: true };
  }

  async canReadActiveBlueprint(tenantId: string, factoryId: string, userId: string): Promise<boolean> {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    const result = await this.database.query<DbRow>(
      `SELECT id::text AS id FROM business_blueprints
       WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' LIMIT 1`,
      [tenantId, factoryId], { tenantId },
    );
    const blueprintId = result.rows[0]?.id ? String(result.rows[0].id) : null;
    if (!blueprintId) return false;
    return (await this.filterItemsByAcl(tenantId, factoryId, userId, 'BLUEPRINT', [{ id: blueprintId }])).length > 0;
  }

  async assertTargetReadAccess(
    tenantId: string,
    factoryId: string,
    userId: string,
    targetType: TargetType,
    targetId: string,
  ) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(userId, 'userId');
    this.validateTargetType(targetType);
    this.uuid(targetId, 'targetId');
    if (!(await this.canReadActiveBlueprint(tenantId, factoryId, userId))) {
      throw new NotFoundException('CBB blueprint was not found or is not visible to this role');
    }
    await this.assertTargetReadable(tenantId, factoryId, userId, targetType, targetId);
    return { allowed: true };
  }

  async filterTargetRowsByAcl(
    tenantId: string,
    factoryId: string,
    userId: string,
    rows: DbRow[],
  ): Promise<DbRow[]> {
    const visibleKeys = new Set<string>();
    const groups = new Map<TargetType, DbRow[]>();
    for (const row of rows) {
      const targetType = String(row.target_type) as TargetType;
      const targetId = String(row.target_id ?? '');
      if (!targetId || !isUUID(targetId)) continue;
      this.validateTargetType(targetType);
      groups.set(targetType, [...(groups.get(targetType) ?? []), row]);
    }
    for (const [targetType, group] of groups) {
      const visible = await this.filterItemsByAcl(
        tenantId, factoryId, userId, targetType,
        group.map((row) => ({ ...row, id: String(row.target_id) })),
      );
      for (const row of visible) visibleKeys.add(targetType + ':' + String(row.id));
    }
    return rows.filter((row) =>
      visibleKeys.has(String(row.target_type) + ':' + String(row.target_id)),
    );
  }

  private async filterItemsByAcl(
    tenantId: string, factoryId: string, userId: string, targetType: TargetType,
    items: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    if (!items.length) return [];
    const ids = items.map((item) => String(item.id)).filter((id) => isUUID(id));
    if (!ids.length) return items;
    const roleRows = await this.database.query<DbRow>(
      `SELECT DISTINCT ur.role_id::text AS role_id
       FROM tenant_memberships tm
       JOIN user_roles ur ON ur.membership_id=tm.id
       JOIN roles r ON r.id=ur.role_id AND r.tenant_id=tm.tenant_id
       WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND tm.status='ACTIVE'
         AND (ur.factory_id IS NULL OR ur.factory_id=$3)`,
      [tenantId, userId, factoryId], { tenantId },
    );
    const roleIds = new Set(roleRows.rows.map((row) => String(row.role_id)));
    const acl = await this.database.query<DbRow>(
      `SELECT role_id::text AS role_id,target_type,target_id::text AS target_id,field_name,access_level
       FROM business_acl WHERE tenant_id=$1 AND factory_id=$2 AND target_type=$3 AND target_id=ANY($4::uuid[])`,
      [tenantId, factoryId, targetType, ids], { tenantId },
    );
    const groups = new Map<string, DbRow[]>();
    for (const row of acl.rows) {
      const key = String(row.target_id);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const visible: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const targetId = String(item.id);
      const grants = groups.get(targetId) ?? [];
      const objectGrants = grants.filter((grant) => grant.field_name === null || grant.field_name === undefined);
      if (objectGrants.length && !objectGrants.some((grant) => roleIds.has(String(grant.role_id)))) continue;
      const safe: Record<string, unknown> = { ...item };
      const fieldGroups = new Map<string, DbRow[]>();
      for (const grant of grants) {
        if (grant.field_name === null || grant.field_name === undefined) continue;
        const field = String(grant.field_name);
        fieldGroups.set(field, [...(fieldGroups.get(field) ?? []), grant]);
      }
      for (const [field, fieldGrants] of fieldGroups) {
        if (!fieldGrants.some((grant) => roleIds.has(String(grant.role_id)))) delete safe[field];
      }
      visible.push(safe);
    }
    return visible;
  }

  async assertTargetWriteAccess(scope: Scope, targetType: TargetType, targetId: string | null, fields: string[] = []) {
    this.validateScope(scope);
    this.validateTargetType(targetType);
    return this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      let effectiveTargetId = targetId;
      if (targetType === 'BLUEPRINT' && !effectiveTargetId) {
        effectiveTargetId = String((await this.currentBlueprint(client, scope, true)).id);
      }
      if (!effectiveTargetId) throw new BadRequestException('targetId is required for this CBB target type');
      this.uuid(effectiveTargetId, 'targetId');
      await this.assertTargetWriteAccessInClient(client, scope, targetType, effectiveTargetId, fields);
      return { targetType, targetId: effectiveTargetId, allowed: true };
    });
  }

  async assertProposalWriteAccess(scope: Scope, proposalId: string) {
    this.validateScope(scope);
    this.uuid(proposalId, 'proposalId');
    const result = await this.database.query<DbRow>(
      `SELECT target_type,target_id::text AS target_id FROM business_change_proposals
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [proposalId, scope.tenantId, scope.factoryId], { tenantId: scope.tenantId },
    );
    const proposal = result.rows[0];
    if (!proposal) throw new NotFoundException('CBB proposal was not found in this factory');
    await this.assertTargetWriteAccess(scope, String(proposal.target_type) as TargetType,
      proposal.target_id ? String(proposal.target_id) : String((await this.database.query<DbRow>(
        'SELECT id::text AS id FROM business_blueprints WHERE tenant_id=$1 AND factory_id=$2 AND status=$3 LIMIT 1',
        [scope.tenantId, scope.factoryId, 'ACTIVE'], { tenantId: scope.tenantId },
      )).rows[0]?.id ?? ''));
    return { allowed: true };
  }

  async assertConflictWriteAccess(scope: Scope, conflictId: string) {
    this.validateScope(scope);
    this.uuid(conflictId, 'conflictId');
    const result = await this.database.query<DbRow>(
      `SELECT subject_type,subject_id::text AS subject_id FROM business_conflicts
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [conflictId, scope.tenantId, scope.factoryId], { tenantId: scope.tenantId },
    );
    const conflict = result.rows[0];
    if (!conflict) throw new NotFoundException('CBB conflict was not found in this factory');
    await this.assertTargetWriteAccess(scope, String(conflict.subject_type) as TargetType, String(conflict.subject_id));
    return { allowed: true };
  }

  private async assertTargetWriteAccessInClient(
    client: PoolClient,
    scope: Scope,
    targetType: TargetType,
    targetId: string,
    fields: string[] = [],
  ) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`cbb-acl-target:${scope.tenantId}:${scope.factoryId}:${targetType}:${targetId}`],
    );
    const roleRows = await client.query<DbRow>(
      `SELECT DISTINCT ur.role_id::text AS role_id
       FROM tenant_memberships tm JOIN user_roles ur ON ur.membership_id=tm.id
       JOIN roles r ON r.id=ur.role_id AND r.tenant_id=tm.tenant_id
       WHERE tm.tenant_id=$1 AND tm.user_id=$2 AND tm.status='ACTIVE'
         AND (ur.factory_id IS NULL OR ur.factory_id=$3)`,
      [scope.tenantId, scope.userId, scope.factoryId],
    );
    const roleIds = new Set(roleRows.rows.map((row) => String(row.role_id)));
    const grants = await client.query<DbRow>(
      `SELECT role_id::text AS role_id,field_name,access_level FROM business_acl
       WHERE tenant_id=$1 AND factory_id=$2 AND target_type=$3 AND target_id=$4 FOR SHARE`,
      [scope.tenantId, scope.factoryId, targetType, targetId],
    );
    const objectGrants = grants.rows.filter((row) => row.field_name === null || row.field_name === undefined);
    if (objectGrants.length && !objectGrants.some((row) =>
      roleIds.has(String(row.role_id)) && ['EDIT','OWNER'].includes(String(row.access_level)))) {
      throw new ForbiddenException('CBB target is read-only or restricted for this role');
    }
    for (const field of fields) {
      const fieldGrants = grants.rows.filter((row) => String(row.field_name ?? '').toLowerCase() === field.toLowerCase());
      if (fieldGrants.length && !fieldGrants.some((row) =>
        roleIds.has(String(row.role_id)) && ['EDIT','OWNER'].includes(String(row.access_level)))) {
        throw new ForbiddenException('CBB field ' + field + ' is read-only or restricted for this role');
      }
    }
  }

  private async assertTargetReadable(tenantId: string, factoryId: string, userId: string, targetType: TargetType, targetId: string) {
    const result = await this.filterItemsByAcl(tenantId, factoryId, userId, targetType, [{ id: targetId }]);
    if (!result.length) throw new NotFoundException('CBB target was not found or is not visible to this role');
  }

  private async currentBlueprint(client: PoolClient, scope: Scope, lock = false) {
    const result = await client.query<DbRow>(
      `SELECT id::text AS id,current_version_id::text AS current_version_id
       FROM business_blueprints WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' ${lock ? 'FOR UPDATE' : ''} LIMIT 1`,
      [scope.tenantId, scope.factoryId],
    );
    const row = result.rows[0];
    if (!row || !row.current_version_id) throw new NotFoundException('An active CBB blueprint/version was not found');
    return { id: String(row.id), current_version_id: String(row.current_version_id) };
  }

  private async assertTarget(
    client: PoolClient, scope: Scope, targetType: TargetType, targetId: string, blueprintId: string, versionId: string,
  ) {
    if (targetType === 'BLUEPRINT') {
      if (targetId !== blueprintId) throw new NotFoundException('CBB blueprint target was not found in this factory');
      return;
    }
    const table = TARGET_TABLE[targetType as Exclude<TargetType, 'BLUEPRINT'>];
    const result = await client.query<DbRow>(
      `SELECT id FROM ${table} WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND blueprint_version_id=$4 LIMIT 1 FOR SHARE`,
      [targetId, scope.tenantId, scope.factoryId, versionId],
    );
    if (!result.rows[0]) throw new NotFoundException('CBB target was not found in the current blueprint version');
  }

  private validateScope(scope: Scope) {
    this.validateReadScope(scope.tenantId, scope.factoryId);
    this.uuid(scope.userId, 'userId');
  }
  private validateReadScope(tenantId: string, factoryId: string) {
    this.uuid(tenantId, 'tenantId');
    this.uuid(factoryId, 'factoryId');
  }
  private uuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }
  private validateTargetType(value: string): asserts value is TargetType {
    if (!['BLUEPRINT','ENTITY','RELATION','PROCESS','PROCESS_STEP','RULE','TERM','EXCEPTION'].includes(value)) {
      throw new BadRequestException('Unsupported CBB target type');
    }
  }
  private requiredText(value: string, field: string, max: number) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' is required');
    const normalized = value.trim();
    if (!normalized || normalized.length > max) throw new BadRequestException(field + ' must contain 1-' + max + ' characters');
    return normalized;
  }
}
