import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import {
  CBB_EVIDENCE_LINK_TYPES, CBB_EVIDENCE_STATES, CBB_EVIDENCE_TARGET_TYPES,
  type CbbEvidenceLinkType, type CbbEvidenceTargetType, type CbbEvidenceState,
  CreateCbbEvidenceDto, LinkCbbEvidenceDto,
} from './dto/cbb-evidence.dto';

type Row = QueryResultRow;
type Scope = { tenantId: string; factoryId: string; userId: string };
const TARGET_TABLES: Record<Exclude<CbbEvidenceTargetType, 'BLUEPRINT'>, string> = {
  ENTITY: 'business_entities', RELATION: 'business_relations', PROCESS: 'business_processes',
  PROCESS_STEP: 'business_process_steps', RULE: 'business_rules', TERM: 'business_terms',
  EXCEPTION: 'business_exceptions',
};

@Injectable()
export class CbbEvidenceService {
  constructor(private readonly database: DatabaseService, private readonly auditService: AuditService) {}

  async createEvidence(scope: Scope, dto: CreateCbbEvidenceDto) {
    this.validateScope(scope);
    const sourceType = this.requiredText(dto.source_type, 'source_type', 100).toUpperCase();
    const sourceRef = this.requiredText(dto.source_ref, 'source_ref', 1000);
    const sourceKey = dto.source_key
      ? this.requiredText(dto.source_key, 'source_key', 1000)
      : sourceType + ':' + createHash('sha256').update(sourceRef).digest('hex');
    const sourceTimestamp = this.timestamp(dto.source_timestamp);
    const contentHash = this.requiredText(dto.content_hash, 'content_hash', 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new BadRequestException('content_hash must be a SHA-256 hex digest');
    const sourceUri = this.normalizeSourceUri(dto.source_uri, sourceRef);
    const sourceSystem = this.optionalText(dto.source_system, 150);
    const sourceRecordId = this.optionalText(dto.source_record_id, 300);
    const sourceVersion = this.optionalText(dto.source_version, 150);
    const evidenceGrade = this.optionalText(dto.evidence_grade, 50)?.toUpperCase() ?? null;
    const confidence = this.confidence(dto.confidence);
    const state = dto.state ?? 'PROPOSED';
    if (!CBB_EVIDENCE_STATES.includes(state)) throw new BadRequestException('Unsupported evidence state');
    const visibility = dto.visibility ?? 'INTERNAL';
    if (!['INTERNAL', 'RESTRICTED'].includes(visibility)) throw new BadRequestException('Unsupported evidence visibility');
    const metadata = dto.metadata ?? {};
    const metadataJson = JSON.stringify(metadata);
    if (Buffer.byteLength(metadataJson, 'utf8') > 16384) throw new BadRequestException('Evidence metadata cannot exceed 16 KiB');
    const supersedesId = dto.supersedes_evidence_id ?? null;
    if (supersedesId) this.uuid(supersedesId, 'supersedes_evidence_id');

    const result = await this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const blueprint = await client.query<Row>(
        'SELECT id FROM business_blueprints WHERE tenant_id=$1 AND factory_id=$2 AND status=$3 FOR SHARE',
        [scope.tenantId, scope.factoryId, 'ACTIVE'],
      );
      if (!blueprint.rows[0]) throw new NotFoundException('An active business blueprint was not found for this factory');

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [scope.tenantId + ':' + scope.factoryId + ':' + sourceKey]);

      const latestResult = await client.query<Row>(
        'SELECT id::text AS id, source_version, content_hash, revision_no FROM business_evidence WHERE tenant_id=$1 AND factory_id=$2 AND source_key=$3 ORDER BY revision_no DESC, created_at DESC LIMIT 1 FOR UPDATE',
        [scope.tenantId, scope.factoryId, sourceKey],
      );
      const latest = latestResult.rows[0];
      if (latest) {
        if (String(latest.content_hash).toLowerCase() === contentHash) {
          if (sourceVersion && latest.source_version && String(latest.source_version) !== sourceVersion) {
            throw new ConflictException({
              code: 'CBB_EVIDENCE_IDENTICAL_CONTENT_VERSION_MISMATCH',
              message: 'Source version changed without a content change; reconcile source metadata before retrying',
              latestEvidenceId: latest.id, latestRevision: Number(latest.revision_no),
            });
          }
          return { row: await this.readEvidenceById(client, scope, String(latest.id)), replayed: true };
        }
        if (!supersedesId || supersedesId !== String(latest.id)) {
          throw new ConflictException({
            code: 'CBB_EVIDENCE_SOURCE_REVISION_CONFLICT',
            message: 'This source already has a newer revision; supply its exact id in supersedes_evidence_id',
            latestEvidenceId: latest.id, latestRevision: Number(latest.revision_no),
          });
        }
      } else if (supersedesId) {
        throw new ConflictException('supersedes_evidence_id does not identify an existing latest source revision');
      }

      const revisionNo = latest ? Number(latest.revision_no) + 1 : 1;
      const inserted = await client.query<Row>(
        `INSERT INTO business_evidence (
          tenant_id, factory_id, source_type, source_ref, source_timestamp, evidence_grade,
          confidence, state, content_hash, visibility, metadata, created_by, source_key,
          source_system, source_record_id, source_version, source_uri, supersedes_evidence_id, revision_no
        ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
          source_type, source_ref, source_timestamp::text AS source_timestamp, evidence_grade,
          confidence, state, content_hash, visibility, metadata, created_by::text AS created_by,
          created_at::text AS created_at, source_key, source_system, source_record_id, source_version,
          source_uri, supersedes_evidence_id::text AS supersedes_evidence_id, revision_no`,
        [scope.tenantId, scope.factoryId, sourceType, sourceRef, sourceTimestamp, evidenceGrade,
          confidence, state, contentHash, visibility, metadataJson, scope.userId, sourceKey,
          sourceSystem, sourceRecordId, sourceVersion, sourceUri, supersedesId, revisionNo],
      );
      if (!inserted.rows[0]) throw new Error('CBB_EVIDENCE_INSERT_FAILED');
      return { row: inserted.rows[0], replayed: false };
    });

    if (!result.replayed) {
      await this.auditService.record({
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'BUSINESS_MODEL_EVIDENCE', action: 'RECORD_SOURCE_EVIDENCE',
        resourceType: 'BUSINESS_EVIDENCE', resourceId: String(result.row.id),
        payload: { sourceType, sourceKey, contentHash, revisionNo: Number(result.row.revision_no),
          supersedesEvidenceId: supersedesId, state },
      });
    }
    return { ...this.mapEvidence(result.row), replayed: result.replayed };
  }

  async listEvidence(tenantId: string, factoryId: string, options: {
    sourceType?: string; state?: CbbEvidenceState; sourceKey?: string; limit?: number; offset?: number;
    visibility?: 'INTERNAL' | 'RESTRICTED'; targetType?: CbbEvidenceTargetType; targetId?: string;
  }) {
    this.validateReadScope(tenantId, factoryId);
    const sourceType = options.sourceType?.trim().toUpperCase() || null;
    const state = options.state ?? null;
    const sourceKey = options.sourceKey?.trim() || null;
    const visibility = options.visibility ?? 'INTERNAL';
    if (visibility !== 'INTERNAL' && visibility !== 'RESTRICTED') {
      throw new BadRequestException('Unsupported evidence visibility filter');
    }
    const targetType = options.targetType ?? null;
    const targetId = options.targetId ?? null;
    if ((targetType === null) !== (targetId === null)) {
      throw new BadRequestException('target_type and target_id must be supplied together');
    }
    if (targetId !== null) this.uuid(targetId, 'target_id');
    const limit = this.limit(options.limit);
    const offset = this.offset(options.offset);
    const filters = [tenantId, factoryId, sourceType, state, sourceKey, visibility, targetType, targetId];
    const count = await this.database.query<Row>(
      `SELECT COUNT(*)::int AS total FROM business_evidence e
       WHERE e.tenant_id=$1 AND e.factory_id=$2
         AND ($3::text IS NULL OR e.source_type=$3)
         AND ($4::text IS NULL OR e.state=$4)
         AND ($5::text IS NULL OR e.source_key=$5)
         AND e.visibility=$6
         AND ($7::text IS NULL OR EXISTS (
           SELECT 1 FROM business_evidence_links l
           WHERE l.evidence_id=e.id AND l.tenant_id=e.tenant_id AND l.factory_id=e.factory_id
             AND l.target_type=$7 AND l.target_id=$8::uuid
         ))`,
      filters, { tenantId },
    );
    const rows = await this.database.query<Row>(
      `SELECT e.id::text AS id, e.tenant_id::text AS tenant_id, e.factory_id::text AS factory_id,
         e.source_type, e.source_ref, e.source_timestamp::text AS source_timestamp, e.evidence_grade,
         e.confidence, e.state, e.content_hash, e.visibility, e.metadata, e.created_by::text AS created_by,
         e.created_at::text AS created_at, e.source_key, e.source_system, e.source_record_id,
         e.source_version, e.source_uri, e.supersedes_evidence_id::text AS supersedes_evidence_id, e.revision_no
       FROM business_evidence e
       WHERE e.tenant_id=$1 AND e.factory_id=$2
         AND ($3::text IS NULL OR e.source_type=$3)
         AND ($4::text IS NULL OR e.state=$4)
         AND ($5::text IS NULL OR e.source_key=$5)
       ORDER BY e.created_at DESC, e.id DESC LIMIT $9 OFFSET $10`,
      [...filters, limit, offset], { tenantId },
    );
    const ids = rows.rows.map((row) => String(row.id));
    const linksByEvidence = new Map<string, unknown[]>();
    if (ids.length) {
      const links = await this.database.query<Row>(
        `SELECT id::text AS id, evidence_id::text AS evidence_id, blueprint_id::text AS blueprint_id,
           blueprint_version_id::text AS blueprint_version_id, target_type, target_id::text AS target_id,
           link_type, created_by::text AS created_by, created_at::text AS created_at
         FROM business_evidence_links WHERE tenant_id=$1 AND factory_id=$2 AND evidence_id=ANY($3::uuid[])
         ORDER BY created_at, id`,
        [tenantId, factoryId, ids], { tenantId },
      );
      for (const link of links.rows) {
        const key = String(link.evidence_id);
        linksByEvidence.set(key, [...(linksByEvidence.get(key) ?? []), link]);
      }
    }
    return {
      items: rows.rows.map((row) => ({ ...this.mapEvidence(row), links: linksByEvidence.get(String(row.id)) ?? [] })),
      total: Number(count.rows[0]?.total ?? 0), limit, offset,
    };
  }

  async getEvidenceHistory(tenantId: string, factoryId: string, evidenceId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(evidenceId, 'evidenceId');
    const target = await this.database.query<Row>(
      'SELECT source_key FROM business_evidence WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [evidenceId, tenantId, factoryId], { tenantId },
    );
    if (!target.rows[0]) throw new NotFoundException('Evidence was not found in this factory');
    const sourceKey = target.rows[0].source_key ?? null;
    const history = await this.database.query<Row>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
         source_type, source_ref, source_timestamp::text AS source_timestamp, evidence_grade, confidence,
         state, content_hash, visibility, metadata, created_by::text AS created_by, created_at::text AS created_at,
         source_key, source_system, source_record_id, source_version, source_uri,
         supersedes_evidence_id::text AS supersedes_evidence_id, revision_no
       FROM business_evidence WHERE tenant_id=$1 AND factory_id=$2
         AND (($3::text IS NOT NULL AND source_key=$3) OR ($3::text IS NULL AND id=$4))
       ORDER BY revision_no ASC, created_at ASC, id ASC`,
      [tenantId, factoryId, sourceKey, evidenceId], { tenantId },
    );
    return { sourceKey, evidenceId, revisions: history.rows.map((row) => this.mapEvidence(row)) };
  }

  async createEvidenceLink(scope: Scope, evidenceId: string, dto: LinkCbbEvidenceDto) {
    this.validateScope(scope);
    this.uuid(evidenceId, 'evidenceId');
    this.uuid(dto.target_id, 'target_id');
    const targetType = dto.target_type.toUpperCase() as CbbEvidenceTargetType;
    const linkType = dto.link_type.toUpperCase() as CbbEvidenceLinkType;
    if (!CBB_EVIDENCE_TARGET_TYPES.includes(targetType) || !CBB_EVIDENCE_LINK_TYPES.includes(linkType)) {
      throw new BadRequestException('Unsupported CBB evidence link type');
    }
    const reason = this.optionalText(dto.reason, 1000);
    const result = await this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const evidence = await client.query<Row>(
        'SELECT id FROM business_evidence WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR SHARE',
        [evidenceId, scope.tenantId, scope.factoryId],
      );
      if (!evidence.rows[0]) throw new NotFoundException('Evidence was not found in this factory');
      const bpResult = await client.query<Row>(
        `SELECT id::text AS id, current_version_id::text AS current_version_id
         FROM business_blueprints WHERE tenant_id=$1 AND factory_id=$2 AND status='ACTIVE' FOR SHARE`,
        [scope.tenantId, scope.factoryId],
      );
      const bp = bpResult.rows[0];
      if (!bp || !bp.current_version_id) throw new ConflictException('The factory has no active blueprint version to link evidence to');
      await this.assertCurrentTarget(client, scope, targetType, dto.target_id, String(bp.current_version_id), String(bp.id));
      const inserted = await client.query<Row>(
        `INSERT INTO business_evidence_links (
          tenant_id, factory_id, evidence_id, target_type, target_id, link_type, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (evidence_id,target_type,target_id,link_type) DO NOTHING
        RETURNING id::text AS id, evidence_id::text AS evidence_id, blueprint_id::text AS blueprint_id,
          blueprint_version_id::text AS blueprint_version_id, target_type, target_id::text AS target_id,
          link_type, created_by::text AS created_by, created_at::text AS created_at`,
        [scope.tenantId, scope.factoryId, evidenceId, targetType, dto.target_id, linkType, scope.userId],
      );
      let link = inserted.rows[0];
      let replayed = false;
      if (!link) {
        const existing = await client.query<Row>(
          `SELECT id::text AS id, evidence_id::text AS evidence_id, blueprint_id::text AS blueprint_id,
             blueprint_version_id::text AS blueprint_version_id, target_type, target_id::text AS target_id,
             link_type, created_by::text AS created_by, created_at::text AS created_at
           FROM business_evidence_links
           WHERE tenant_id=$1 AND factory_id=$2 AND evidence_id=$3 AND target_type=$4 AND target_id=$5 AND link_type=$6`,
          [scope.tenantId, scope.factoryId, evidenceId, targetType, dto.target_id, linkType],
        );
        link = existing.rows[0]; replayed = true;
      }
      if (!link) throw new Error('CBB_EVIDENCE_LINK_INSERT_FAILED');

      let conflictId: string | null = null;
      if (linkType === 'CONTRADICTS') {
        const refsResult = await client.query<Row>(
          `SELECT DISTINCT l.evidence_id::text AS evidence_id FROM business_evidence_links l
           WHERE l.tenant_id=$1 AND l.factory_id=$2 AND l.blueprint_id=$3 AND l.blueprint_version_id=$4
             AND l.target_type=$5 AND l.target_id=$6 AND l.link_type IN ('SUPPORTS','CONTRADICTS')
           UNION SELECT $7::text AS evidence_id`,
          [scope.tenantId, scope.factoryId, link.blueprint_id, link.blueprint_version_id, targetType, dto.target_id, evidenceId],
        );
        const refs = [...new Set(refsResult.rows.map((row) => String(row.evidence_id)))];
        const open = await client.query<Row>(
          `SELECT id::text AS id, version, evidence_refs FROM business_conflicts
           WHERE tenant_id=$1 AND factory_id=$2 AND blueprint_id=$3
             AND subject_type=$4 AND subject_id=$5 AND status='OPEN' FOR UPDATE`,
          [scope.tenantId, scope.factoryId, link.blueprint_id, targetType, dto.target_id],
        );
        if (open.rows[0]) {
          const current = open.rows[0];
          conflictId = String(current.id);
          const before = this.jsonArray(current.evidence_refs);
          const after = [...new Set([...before, ...refs])];
          if (after.length !== before.length) {
            await client.query(
              `UPDATE business_conflicts SET evidence_refs=$1::jsonb, version=version+1, updated_at=NOW()
               WHERE id=$2 AND tenant_id=$3 AND factory_id=$4 AND status='OPEN' AND version=$5`,
              [JSON.stringify(after), conflictId, scope.tenantId, scope.factoryId, Number(current.version)],
            );
          }
        } else {
          const created = await client.query<Row>(
            `INSERT INTO business_conflicts (
              tenant_id, factory_id, blueprint_id, subject_type, subject_id, status,
              description, evidence_refs, created_by, version, updated_at
            ) VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7::jsonb,$8,1,NOW()) RETURNING id::text AS id`,
            [scope.tenantId, scope.factoryId, link.blueprint_id, targetType, dto.target_id,
              reason ?? ('Contradictory evidence requires review for ' + targetType.toLowerCase() + ' ' + dto.target_id),
              JSON.stringify(refs), scope.userId],
          );
          conflictId = created.rows[0] ? String(created.rows[0].id) : null;
        }
      }
      return { link, replayed, conflictId, newlyCreated: inserted.rows.length > 0 };
    });
    if (result.newlyCreated) {
      await this.auditService.record({
        tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
        eventType: 'BUSINESS_MODEL_EVIDENCE', action: 'LINK_SOURCE_EVIDENCE',
        resourceType: 'BUSINESS_EVIDENCE_LINK', resourceId: String(result.link.id),
        payload: { evidenceId, targetType, targetId: dto.target_id, linkType, conflictId: result.conflictId },
      });
    }
    return { ...result.link, replayed: result.replayed, conflictId: result.conflictId };
  }

  async listBlueprintVersions(tenantId: string, factoryId: string) {
    this.validateReadScope(tenantId, factoryId);
    const result = await this.database.query<Row>(
      `SELECT b.id::text AS blueprint_id, v.id::text AS version_id, v.version::text AS version,
         v.graph_hash, v.evidence_count, v.readiness_score::text AS readiness_score, v.status,
         v.change_reason, v.created_by::text AS created_by, v.created_at::text AS created_at,
         (b.current_version_id=v.id) AS is_current
       FROM business_blueprints b JOIN business_blueprint_versions v
         ON v.blueprint_id=b.id AND v.tenant_id=b.tenant_id AND v.factory_id=b.factory_id
       WHERE b.tenant_id=$1 AND b.factory_id=$2 ORDER BY v.version DESC`,
      [tenantId, factoryId], { tenantId },
    );
    return result.rows.map((row) => ({
      blueprintId: row.blueprint_id, versionId: row.version_id, version: row.version,
      graphHash: row.graph_hash, evidenceCount: Number(row.evidence_count),
      readinessScore: row.readiness_score === null ? null : Number(row.readiness_score),
      status: row.status, changeReason: row.change_reason, createdBy: row.created_by,
      createdAt: row.created_at, isCurrent: row.is_current,
    }));
  }

  async listConflicts(tenantId: string, factoryId: string, options: {
    status?: 'OPEN' | 'RESOLVED' | 'DISMISSED'; subjectType?: CbbEvidenceTargetType; limit?: number; offset?: number;
  }) {
    this.validateReadScope(tenantId, factoryId);
    const status = options.status ?? null;
    const subjectType = options.subjectType ?? null;
    const limit = this.limit(options.limit);
    const offset = this.offset(options.offset);
    const values = [tenantId, factoryId, status, subjectType];
    const count = await this.database.query<Row>(
      `SELECT COUNT(*)::int AS total FROM business_conflicts c
       WHERE c.tenant_id=$1 AND c.factory_id=$2 AND ($3::text IS NULL OR c.status=$3)
         AND ($4::text IS NULL OR c.subject_type=$4)`,
      values, { tenantId },
    );
    const rows = await this.database.query<Row>(
      `SELECT c.id::text AS id, c.blueprint_id::text AS blueprint_id, c.subject_type,
         c.subject_id::text AS subject_id, c.status, c.description, c.evidence_refs,
         c.resolution_ref, c.resolution_reason, c.resolution_evidence_id::text AS resolution_evidence_id,
         c.created_by::text AS created_by, c.resolved_by::text AS resolved_by,
         c.created_at::text AS created_at, c.updated_at::text AS updated_at,
         c.resolved_at::text AS resolved_at, c.version
       FROM business_conflicts c
       WHERE c.tenant_id=$1 AND c.factory_id=$2 AND ($3::text IS NULL OR c.status=$3)
         AND ($4::text IS NULL OR c.subject_type=$4)
       ORDER BY CASE WHEN c.status='OPEN' THEN 0 ELSE 1 END, c.created_at DESC, c.id DESC
       LIMIT $5 OFFSET $6`,
      [...values, limit, offset], { tenantId },
    );
    return {
      items: rows.rows.map((row) => ({
        id: row.id, blueprintId: row.blueprint_id, subjectType: row.subject_type, subjectId: row.subject_id,
        status: row.status, description: row.description, evidenceIds: this.jsonArray(row.evidence_refs),
        resolutionReference: row.resolution_ref, resolutionReason: row.resolution_reason,
        resolutionEvidenceId: row.resolution_evidence_id, createdBy: row.created_by, resolvedBy: row.resolved_by,
        createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at, version: Number(row.version),
      })),
      total: Number(count.rows[0]?.total ?? 0), limit, offset,
    };
  }

  async getConflictHistory(tenantId: string, factoryId: string, conflictId: string) {
    this.validateReadScope(tenantId, factoryId);
    this.uuid(conflictId, 'conflictId');
    const found = await this.database.query<Row>(
      'SELECT id FROM business_conflicts WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
      [conflictId, tenantId, factoryId], { tenantId },
    );
    if (!found.rows[0]) throw new NotFoundException('Conflict was not found in this factory');
    const result = await this.database.query<Row>(
      `SELECT id::text AS id, conflict_id::text AS conflict_id, version, action, from_status, to_status,
         evidence_refs, actor_user_id::text AS actor_user_id, reason, created_at::text AS created_at
       FROM business_conflict_history WHERE tenant_id=$1 AND factory_id=$2 AND conflict_id=$3
       ORDER BY version ASC, created_at ASC`,
      [tenantId, factoryId, conflictId], { tenantId },
    );
    return result.rows.map((row) => ({
      id: row.id, conflictId: row.conflict_id, version: Number(row.version), action: row.action,
      fromStatus: row.from_status, toStatus: row.to_status, evidenceIds: this.jsonArray(row.evidence_refs),
      actorUserId: row.actor_user_id, reason: row.reason, createdAt: row.created_at,
    }));
  }

  async decideConflict(scope: Scope, conflictId: string, dto: {
    action: 'RESOLVE' | 'DISMISS'; expected_version: number; reason: string;
    resolution_reference: string; resolution_evidence_id?: string;
  }) {
    this.validateScope(scope);
    this.uuid(conflictId, 'conflictId');
    const reason = this.requiredText(dto.reason, 'reason', 2000);
    if (reason.length < 10) throw new BadRequestException('reason must contain at least 10 characters');
    const reference = this.requiredText(dto.resolution_reference, 'resolution_reference', 2000);
    if (reference.length < 10) throw new BadRequestException('resolution_reference must contain at least 10 characters');
    if (!Number.isInteger(dto.expected_version) || dto.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }
    if (dto.action !== 'RESOLVE' && dto.action !== 'DISMISS') throw new BadRequestException('Unsupported conflict decision');
    const chosen = dto.resolution_evidence_id ?? null;
    if (dto.action === 'RESOLVE' && !chosen) throw new BadRequestException('resolution_evidence_id is required to resolve a conflict');
    if (chosen) this.uuid(chosen, 'resolution_evidence_id');

    const decision = await this.database.transaction({ tenantId: scope.tenantId, userId: scope.userId }, async (client: PoolClient) => {
      const selected = await client.query<Row>(
        'SELECT id::text AS id, status, version, evidence_refs FROM business_conflicts WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE',
        [conflictId, scope.tenantId, scope.factoryId],
      );
      const conflict = selected.rows[0];
      if (!conflict) throw new NotFoundException('Conflict was not found in this factory');
      if (Number(conflict.version) !== dto.expected_version) {
        throw new ConflictException({
          code: 'CBB_CONFLICT_VERSION_MISMATCH',
          message: 'Conflict changed after it was read; refresh history and retry',
          currentVersion: Number(conflict.version),
        });
      }
      if (conflict.status !== 'OPEN') throw new ConflictException('Only open conflicts can be decided');
      if (chosen) {
        if (!this.jsonArray(conflict.evidence_refs).includes(chosen)) {
          throw new BadRequestException('resolution_evidence_id must be attached to this conflict');
        }
        const evidence = await client.query<Row>(
          'SELECT id FROM business_evidence WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
          [chosen, scope.tenantId, scope.factoryId],
        );
        if (!evidence.rows[0]) throw new NotFoundException('Resolution evidence was not found in this factory');
      }
      const nextStatus = dto.action === 'RESOLVE' ? 'RESOLVED' : 'DISMISSED';
      const updated = await client.query<Row>(
        `UPDATE business_conflicts SET status=$1, resolved_by=$2, resolved_at=NOW(),
           resolution_reason=$3, resolution_evidence_id=$4, resolution_ref=$5,
           version=version+1, updated_at=NOW()
         WHERE id=$6 AND tenant_id=$7 AND factory_id=$8 AND status='OPEN' AND version=$9
         RETURNING id::text AS id, status, version, resolved_at::text AS resolved_at`,
        [nextStatus, scope.userId, reason, chosen, reference, conflictId, scope.tenantId, scope.factoryId, dto.expected_version],
      );
      if (!updated.rows[0]) throw new ConflictException('Conflict changed before the decision could be committed');
      return updated.rows[0];
    });
    await this.auditService.record({
      tenantId: scope.tenantId, factoryId: scope.factoryId, actorUserId: scope.userId,
      eventType: 'BUSINESS_MODEL_CONFLICT', action: dto.action, resourceType: 'BUSINESS_CONFLICT',
      resourceId: conflictId,
      payload: { status: decision.status, version: Number(decision.version), reason,
        resolutionReference: reference, resolutionEvidenceId: chosen },
    });
    return { id: decision.id, status: decision.status, version: Number(decision.version), resolvedAt: decision.resolved_at };
  }

  private async assertCurrentTarget(client: PoolClient, scope: Scope, targetType: CbbEvidenceTargetType,
    targetId: string, currentVersionId: string, blueprintId: string) {
    if (targetType === 'BLUEPRINT') {
      if (targetId !== blueprintId) throw new NotFoundException('Blueprint target was not found in this factory');
      return;
    }
    const table = TARGET_TABLES[targetType as Exclude<CbbEvidenceTargetType, 'BLUEPRINT'>];
    const found = await client.query<Row>(
      `SELECT id FROM ${table} WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND blueprint_version_id=$4 LIMIT 1 FOR SHARE`,
      [targetId, scope.tenantId, scope.factoryId, currentVersionId],
    );
    if (!found.rows[0]) throw new NotFoundException('Evidence target was not found in the current blueprint version');
  }

  private async readEvidenceById(client: PoolClient, scope: Scope, id: string) {
    const result = await client.query<Row>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, factory_id::text AS factory_id,
         source_type, source_ref, source_timestamp::text AS source_timestamp, evidence_grade,
         confidence, state, content_hash, visibility, metadata, created_by::text AS created_by,
         created_at::text AS created_at, source_key, source_system, source_record_id, source_version,
         source_uri, supersedes_evidence_id::text AS supersedes_evidence_id, revision_no
       FROM business_evidence WHERE id=$1 AND tenant_id=$2 AND factory_id=$3`,
      [id, scope.tenantId, scope.factoryId],
    );
    if (!result.rows[0]) throw new NotFoundException('Evidence was not found in this factory');
    return result.rows[0];
  }

  private mapEvidence(row: Row) {
    return {
      id: String(row.id), tenantId: String(row.tenant_id), factoryId: String(row.factory_id),
      sourceType: String(row.source_type), sourceRef: String(row.source_ref), sourceTimestamp: row.source_timestamp,
      evidenceGrade: row.evidence_grade ?? null,
      confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
      state: row.state, contentHash: row.content_hash, visibility: row.visibility, metadata: row.metadata ?? {},
      createdBy: row.created_by ?? null, createdAt: row.created_at, sourceKey: row.source_key ?? null,
      sourceSystem: row.source_system ?? null, sourceRecordId: row.source_record_id ?? null,
      sourceVersion: row.source_version ?? null, sourceUri: row.source_uri ?? null,
      supersedesEvidenceId: row.supersedes_evidence_id ?? null, revision: Number(row.revision_no ?? 1),
    };
  }

  private validateScope(scope: Scope) { this.validateReadScope(scope.tenantId, scope.factoryId); this.uuid(scope.userId, 'userId'); }
  private validateReadScope(tenantId: string, factoryId: string) { this.uuid(tenantId, 'tenantId'); this.uuid(factoryId, 'factoryId'); }
  private uuid(value: string, field: string) { if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID'); }
  private requiredText(value: string, field: string, max: number) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' is required');
    const text = value.trim();
    if (!text || text.length > max) throw new BadRequestException(field + ' must contain 1-' + max + ' characters');
    return text;
  }
  private optionalText(value: string | null | undefined, max: number) {
    if (value === null || value === undefined) return null;
    return this.requiredText(value, 'optional field', max);
  }
  private timestamp(value: string) {
    const text = this.requiredText(value, 'source_timestamp', 80);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) || !Number.isFinite(Date.parse(text))) {
      throw new BadRequestException('source_timestamp must be an ISO-8601 timestamp with an explicit timezone');
    }
    return new Date(text).toISOString();
  }
  private normalizeSourceUri(value: string | undefined, sourceRef: string) {
    const candidate = value?.trim() || (/^https?:\/\//i.test(sourceRef) ? sourceRef : null);
    if (!candidate) return null;
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { throw new BadRequestException('source_uri must be a valid HTTP(S) URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new BadRequestException('source_uri must use HTTP or HTTPS');
    return parsed.toString().slice(0, 2000);
  }
  private confidence(value: number | undefined) {
    if (value === undefined) return null;
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new BadRequestException('confidence must be between 0 and 1');
    return value;
  }
  private limit(value: number | undefined) {
    const n = value ?? 50;
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be between 1 and 200');
    return n;
  }
  private offset(value: number | undefined) {
    const n = value ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new BadRequestException('offset must be between 0 and 100000');
    return n;
  }
  private jsonArray(value: unknown): string[] {
    let parsed = value;
    if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { return []; } }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item));
  }
}