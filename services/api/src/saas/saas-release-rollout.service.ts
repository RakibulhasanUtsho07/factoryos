import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { CreateSaasReleaseRolloutDto, SaasReleaseChannel, SaasReleaseScopeType } from './dto/create-saas-release-rollout.dto';
import { PromoteSaasReleaseRolloutDto } from './dto/promote-saas-release-rollout.dto';
import { RollbackSaasReleaseRolloutDto } from './dto/rollback-saas-release-rollout.dto';
import { SaasReleaseTransitionAction, TransitionSaasReleaseRolloutDto } from './dto/transition-saas-release-rollout.dto';

type ReleaseStage = 'DRAFT' | 'CANARY' | 'PRODUCTION' | 'PAUSED' | 'RETIRED';
type ReleaseAction = 'REGISTER' | 'PROMOTE' | 'PAUSE' | 'RESUME' | 'ROLLBACK' | 'RETIRE';

interface ReleaseRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  rollout_key: string;
  version: string | number;
  scope_type: SaasReleaseScopeType;
  factory_id: string | null;
  module_key: string | null;
  agent_key: string | null;
  release_channel: SaasReleaseChannel;
  action: ReleaseAction;
  stage: ReleaseStage;
  last_active_stage: 'DRAFT' | 'CANARY' | 'PRODUCTION';
  artifact_version: string;
  artifact_digest: string;
  rollout_percentage: number;
  previous_version: string | number | null;
  rollback_target_key: string | null;
  rollback_target_version: string | number | null;
  evaluation_reference: string | null;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  actor_user_id: string;
  created_at: string;
}

interface ReleaseResolutionTarget {
  factoryId?: string | null;
  moduleKey?: string | null;
  agentKey?: string | null;
  channel: SaasReleaseChannel;
  subjectKey: string;
}

@Injectable()
export class SaasReleaseRolloutService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createRollout(tenantId: string, actorUserId: string, input: CreateSaasReleaseRolloutDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.write');

    const rolloutKey = this.requiredString(input?.rollout_key, 'rollout_key', 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9:_-]{0,79}$/.test(rolloutKey)) {
      throw new BadRequestException('rollout_key format is invalid');
    }
    if (!Object.values(SaasReleaseScopeType).includes(input?.scope_type)) {
      throw new BadRequestException('scope_type is invalid');
    }
    if (!Object.values(SaasReleaseChannel).includes(input?.release_channel)) {
      throw new BadRequestException('release_channel is invalid');
    }

    const scope = this.normalizeScope(input);
    const artifactVersion = this.requiredString(input?.artifact_version, 'artifact_version', 120);
    const artifactDigest = this.requiredString(input?.artifact_digest, 'artifact_digest', 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
      throw new BadRequestException('artifact_digest must be a SHA-256 hex digest');
    }
    const evaluationReference = input?.evaluation_reference
      ? this.requiredString(input.evaluation_reference, 'evaluation_reference', 200)
      : null;
    if (evaluationReference && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(evaluationReference)) {
      throw new BadRequestException('evaluation_reference must be an opaque reference ID');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    const idempotencyKey = this.requiredIdempotencyKey(input?.idempotency_key);
    const normalized = {
      operation: 'REGISTER_RELEASE',
      rolloutKey,
      scopeType: input.scope_type,
      factoryId: scope.factoryId,
      moduleKey: scope.moduleKey,
      agentKey: scope.agentKey,
      channel: input.release_channel,
      artifactVersion,
      artifactDigest,
      evaluationReference,
      reason,
    };
    const requestHash = this.hash(normalized);

    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findIdempotencyReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { rollout: replay, replayed: true };

      const existing = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_release_rollouts WHERE tenant_id = $1 AND rollout_key = $2 LIMIT 1',
        [tenantId, rolloutKey],
      );
      if (existing.rows[0]) {
        throw new ConflictException('rollout_key already exists; use a new key for a distinct artifact candidate');
      }

      const inserted = await client.query<ReleaseRow>(
        `INSERT INTO saas_release_rollouts
          (tenant_id, rollout_key, version, scope_type, factory_id, module_key, agent_key,
           release_channel, action, stage, last_active_stage, artifact_version, artifact_digest,
           rollout_percentage, previous_version, rollback_target_key, rollback_target_version,
           evaluation_reference, reason, idempotency_key, request_hash, actor_user_id)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,'REGISTER','DRAFT','DRAFT',$8,$9,0,NULL,NULL,NULL,$10,$11,$12,$13,$14)
         RETURNING ${this.columns()}`,
        [
          tenantId, rolloutKey, input.scope_type, scope.factoryId, scope.moduleKey, scope.agentKey,
          input.release_channel, artifactVersion, artifactDigest, evaluationReference, reason,
          idempotencyKey, requestHash, actorUserId,
        ],
      );
      const rollout = inserted.rows[0];
      if (!rollout) throw new Error('SAAS_RELEASE_ROLLOUT_INSERT_FAILED');
      return { rollout, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, outcome.rollout.id, 'RELEASE_ROLLOUT_REGISTERED', {
        rolloutKey,
        scopeType: outcome.rollout.scope_type,
        channel: outcome.rollout.release_channel,
        artifactVersion,
        artifactDigest,
        stage: outcome.rollout.stage,
      });
    }
    return { rollout: this.mapRollout(outcome.rollout), replayed: outcome.replayed };
  }

  async listLatest(tenantId: string, actorUserId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.read');
    const result = await this.database.query<ReleaseRow>(
      `SELECT ${this.columns('r')}
       FROM (
         SELECT DISTINCT ON (tenant_id, rollout_key) *
         FROM saas_release_rollouts
         WHERE tenant_id = $1
         ORDER BY tenant_id, rollout_key, version DESC
       ) r
       ORDER BY r.created_at DESC, r.rollout_key
       LIMIT 100`,
      [tenantId],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapRollout(row)), count: result.rows.length };
  }

  async listHistory(tenantId: string, actorUserId: string, rolloutKeyInput: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.read');
    const rolloutKey = this.normalizeRolloutKey(rolloutKeyInput);
    const result = await this.database.query<ReleaseRow>(
      `SELECT ${this.columns('r')}
       FROM saas_release_rollouts r
       WHERE r.tenant_id = $1 AND r.rollout_key = $2
       ORDER BY r.version DESC`,
      [tenantId, rolloutKey],
      { tenantId, userId: actorUserId },
    );
    if (result.rows.length === 0) throw new NotFoundException('Release rollout was not found');
    return { items: result.rows.map((row) => this.mapRollout(row)), count: result.rows.length };
  }

  async promoteRollout(
    tenantId: string,
    actorUserId: string,
    rolloutKeyInput: string,
    input: PromoteSaasReleaseRolloutDto,
  ) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.promote');
    const rolloutKey = this.normalizeRolloutKey(rolloutKeyInput);
    if (!Number.isSafeInteger(input?.expected_version) || input.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive safe integer');
    }
    if (!['CANARY', 'PRODUCTION'].includes(input?.stage)) {
      throw new BadRequestException('stage must be CANARY or PRODUCTION');
    }
    if (
      (input.stage === 'CANARY' && (!Number.isInteger(input.rollout_percentage) || input.rollout_percentage < 1 || input.rollout_percentage > 99)) ||
      (input.stage === 'PRODUCTION' && input.rollout_percentage !== 100)
    ) {
      throw new BadRequestException('CANARY requires rollout_percentage from 1 to 99; PRODUCTION requires exactly 100');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    return this.appendTransition(tenantId, actorUserId, rolloutKey, {
      action: 'PROMOTE',
      expectedVersion: input.expected_version,
      stage: input.stage,
      percentage: input.rollout_percentage,
      reason,
      idempotencyKey: this.requiredIdempotencyKey(input.idempotency_key),
      requestHash: this.hash({
        operation: 'PROMOTE_RELEASE',
        rolloutKey,
        expectedVersion: input.expected_version,
        stage: input.stage,
        percentage: input.rollout_percentage,
        reason,
      }),
      permission: 'saas.releases.promote',
    });
  }

  async transition(
    tenantId: string,
    actorUserId: string,
    rolloutKeyInput: string,
    input: TransitionSaasReleaseRolloutDto,
  ) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.control');
    const rolloutKey = this.normalizeRolloutKey(rolloutKeyInput);
    if (!Object.values(SaasReleaseTransitionAction).includes(input?.action)) {
      throw new BadRequestException('action is invalid');
    }
    if (!Number.isSafeInteger(input?.expected_version) || input.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive safe integer');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    return this.appendTransition(tenantId, actorUserId, rolloutKey, {
      action: input.action,
      expectedVersion: input.expected_version,
      reason,
      idempotencyKey: this.requiredIdempotencyKey(input.idempotency_key),
      requestHash: this.hash({
        operation: 'TRANSITION_RELEASE',
        rolloutKey,
        action: input.action,
        expectedVersion: input.expected_version,
        reason,
      }),
      permission: 'saas.releases.control',
    });
  }

  async rollback(
    tenantId: string,
    actorUserId: string,
    rolloutKeyInput: string,
    input: RollbackSaasReleaseRolloutDto,
  ) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.rollback');
    const rolloutKey = this.normalizeRolloutKey(rolloutKeyInput);
    const targetRolloutKey = this.normalizeRolloutKey(input?.target_rollout_key);
    if (targetRolloutKey === rolloutKey) {
      throw new BadRequestException('target_rollout_key must identify a different registered artifact rollout');
    }
    if (!Number.isSafeInteger(input?.expected_version) || input.expected_version < 1 ||
      !Number.isSafeInteger(input?.target_version) || input.target_version < 1) {
      throw new BadRequestException('expected_version and target_version must be positive safe integers');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000);
    return this.appendTransition(tenantId, actorUserId, rolloutKey, {
      action: 'ROLLBACK',
      expectedVersion: input.expected_version,
      targetRolloutKey,
      targetVersion: input.target_version,
      reason,
      idempotencyKey: this.requiredIdempotencyKey(input.idempotency_key),
      requestHash: this.hash({
        operation: 'ROLLBACK_RELEASE',
        rolloutKey,
        expectedVersion: input.expected_version,
        targetRolloutKey,
        targetVersion: input.target_version,
        reason,
      }),
      permission: 'saas.releases.rollback',
    });
  }

  /**
   * Resolve the newest applicable target release without a stale cache.
   * A deterministic SHA-256 cohort bucket controls canary eligibility. When
   * a subject misses the canary, a same-scope production candidate is used;
   * if none exists, resolution falls back to a broader scope.
   */
  async resolveEffectiveRelease(
    tenantId: string,
    actorUserId: string,
    target: ReleaseResolutionTarget,
  ) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.read');
    if (!Object.values(SaasReleaseChannel).includes(target?.channel)) {
      throw new BadRequestException('channel is invalid');
    }
    const subjectKey = this.requiredString(target?.subjectKey, 'subjectKey', 200);
    if (target.factoryId) this.assertUuid(target.factoryId, 'factoryId');
    const moduleKey = target.moduleKey ? this.validateToken(target.moduleKey, 'moduleKey', 80) : null;
    const agentKey = target.agentKey ? this.validateToken(target.agentKey, 'agentKey', 160) : null;
    const result = await this.database.query<ReleaseRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (tenant_id, rollout_key) *
         FROM saas_release_rollouts
         WHERE tenant_id = $1
         ORDER BY tenant_id, rollout_key, version DESC
       )
       SELECT ${this.columns('r')}
       FROM latest r
       WHERE r.release_channel = $2
         AND r.stage IN ('CANARY','PRODUCTION')
         -- A provider-declared unhealthy/halted rollout must never remain eligible
         -- because the failed deployment's control-plane pause/rollback sync failed.
         AND NOT EXISTS (
           SELECT 1
           FROM saas_physical_provisioning_runs failed_run
           WHERE failed_run.tenant_id = r.tenant_id
             AND failed_run.operation = 'RELEASE_DEPLOY'
             AND failed_run.resource_id = r.id
             AND failed_run.id = (
               SELECT newest_run.id
               FROM saas_physical_provisioning_runs newest_run
               WHERE newest_run.tenant_id = r.tenant_id
                 AND newest_run.operation = 'RELEASE_DEPLOY'
                 AND newest_run.resource_id = r.id
               ORDER BY newest_run.created_at DESC,newest_run.id DESC
               LIMIT 1
             )
             AND (
               SELECT newest_event.event_status
               FROM saas_physical_provisioning_events newest_event
               WHERE newest_event.tenant_id = failed_run.tenant_id
                 AND newest_event.run_id = failed_run.id
               ORDER BY newest_event.event_version DESC
               LIMIT 1
             ) IN ('HALTED','FAILED','ROLLBACK_FAILED')
         )
         AND (
           r.scope_type = 'ORGANIZATION'
           OR (r.scope_type = 'FACTORY' AND r.factory_id = $3::uuid)
           OR (r.scope_type = 'MODULE' AND r.module_key = $4
             AND (r.factory_id IS NULL OR r.factory_id = $3::uuid))
           OR (r.scope_type = 'AGENT' AND r.agent_key = $5
             AND (r.module_key IS NULL OR r.module_key = $4)
             AND (r.factory_id IS NULL OR r.factory_id = $3::uuid))
         )
       ORDER BY r.created_at DESC, r.rollout_key`,
      [tenantId, target.channel, target.factoryId ?? null, moduleKey, agentKey],
      { tenantId, userId: actorUserId },
    );

    const candidates = result.rows.sort((a, b) =>
      this.scopePriority(b.scope_type) - this.scopePriority(a.scope_type) ||
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    for (const priority of [4, 3, 2, 1]) {
      const scoped = candidates.filter((row) => this.scopePriority(row.scope_type) === priority);
      const canary = scoped.find((row) => row.stage === 'CANARY');
      if (canary) {
        const bucket = this.rolloutBucket(canary.rollout_key, subjectKey);
        if (bucket < Number(canary.rollout_percentage)) {
          return { release: this.mapRollout(canary), rolloutBucket: bucket, matchedScope: canary.scope_type };
        }
      }
      const production = scoped.find((row) => row.stage === 'PRODUCTION');
      if (production) {
        return { release: this.mapRollout(production), rolloutBucket: null, matchedScope: production.scope_type };
      }
    }
    return { release: null, rolloutBucket: null, matchedScope: null };
  }

  private async appendTransition(
    tenantId: string,
    actorUserId: string,
    rolloutKey: string,
    input: {
      action: 'PROMOTE' | 'PAUSE' | 'RESUME' | 'RETIRE' | 'ROLLBACK';
      expectedVersion: number;
      stage?: 'CANARY' | 'PRODUCTION';
      percentage?: number;
      targetRolloutKey?: string;
      targetVersion?: number;
      reason: string;
      idempotencyKey: string;
      requestHash: string;
      permission: string;
    },
  ) {
    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findIdempotencyReplay(client, tenantId, input.idempotencyKey, input.requestHash);
      if (replay) return { rollout: replay, replayed: true };

      const currentResult = await client.query<ReleaseRow>(
        `SELECT ${this.columns('r')}
         FROM saas_release_rollouts r
         WHERE r.tenant_id = $1 AND r.rollout_key = $2
         ORDER BY r.version DESC
         LIMIT 1 FOR UPDATE`,
        [tenantId, rolloutKey],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Release rollout was not found');
      if (Number(current.version) !== input.expectedVersion) {
        throw new ConflictException('Release rollout version changed; reload and retry with the latest expected_version');
      }

      let nextStage: ReleaseStage = current.stage;
      let lastActiveStage: ReleaseRow['last_active_stage'] = current.last_active_stage;
      let nextPercentage = Number(current.rollout_percentage);
      let artifactVersion = current.artifact_version;
      let artifactDigest = current.artifact_digest;
      let rollbackTargetKey: string | null = null;
      let rollbackTargetVersion: number | null = null;
      let action: ReleaseAction = input.action;

      switch (input.action) {
        case 'PROMOTE':
          if ((current.stage === 'DRAFT' && input.stage === 'CANARY')) {
            nextStage = 'CANARY';
            nextPercentage = input.percentage!;
          } else if (current.stage === 'CANARY' && input.stage === 'PRODUCTION') {
            nextStage = 'PRODUCTION';
            nextPercentage = 100;
          } else {
            throw new ConflictException('Release promotion must progress DRAFT → CANARY → PRODUCTION');
          }
          lastActiveStage = nextStage;
          break;
        case 'PAUSE':
          if (current.stage !== 'CANARY' && current.stage !== 'PRODUCTION') {
            throw new ConflictException('Only a canary or production release can be paused');
          }
          nextStage = 'PAUSED';
          lastActiveStage = current.stage;
          break;
        case 'RESUME':
          if (current.stage !== 'PAUSED') throw new ConflictException('Only a paused release can be resumed');
          nextStage = current.last_active_stage;
          if (!['CANARY', 'PRODUCTION'].includes(nextStage)) {
            throw new ConflictException('The release has no resumable live stage');
          }
          lastActiveStage = nextStage;
          break;
        case 'RETIRE':
          if (current.stage === 'RETIRED') throw new ConflictException('Release rollout is already retired');
          nextStage = 'RETIRED';
          lastActiveStage = current.stage === 'PAUSED' ? current.last_active_stage : current.stage as ReleaseRow['last_active_stage'];
          break;
        case 'ROLLBACK': {
          if (!['CANARY', 'PRODUCTION', 'PAUSED'].includes(current.stage)) {
            throw new ConflictException('Only a deployed rollout can be rolled back');
          }
          const targetResult = await client.query<ReleaseRow>(
            `SELECT ${this.columns('r')}
             FROM saas_release_rollouts r
             WHERE r.tenant_id = $1 AND r.rollout_key = $2
             ORDER BY r.version DESC LIMIT 1 FOR UPDATE`,
            [tenantId, input.targetRolloutKey],
          );
          const target = targetResult.rows[0];
          if (!target || Number(target.version) !== input.targetVersion) {
            throw new ConflictException('Rollback target must reference the latest version of the chosen rollout');
          }
          if ((target.stage !== 'CANARY' && target.stage !== 'PRODUCTION') ||
            target.scope_type !== current.scope_type ||
            target.factory_id !== current.factory_id ||
            target.module_key !== current.module_key ||
            target.agent_key !== current.agent_key ||
            target.release_channel !== current.release_channel) {
            throw new ForbiddenException('Rollback target must be a live, tested artifact with the exact same scope and channel');
          }
          nextStage = target.stage;
          lastActiveStage = target.stage;
          nextPercentage = Number(target.rollout_percentage);
          artifactVersion = target.artifact_version;
          artifactDigest = target.artifact_digest;
          rollbackTargetKey = target.rollout_key;
          rollbackTargetVersion = Number(target.version);
          break;
        }
      }

      const nextVersion = Number(current.version) + 1;
      const inserted = await client.query<ReleaseRow>(
        `INSERT INTO saas_release_rollouts
          (tenant_id, rollout_key, version, scope_type, factory_id, module_key, agent_key,
           release_channel, action, stage, last_active_stage, artifact_version, artifact_digest,
           rollout_percentage, previous_version, rollback_target_key, rollback_target_version,
           evaluation_reference, reason, idempotency_key, request_hash, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING ${this.columns()}`,
        [
          tenantId, rolloutKey, nextVersion, current.scope_type, current.factory_id, current.module_key,
          current.agent_key, current.release_channel, action, nextStage, lastActiveStage, artifactVersion,
          artifactDigest, nextPercentage, Number(current.version), rollbackTargetKey, rollbackTargetVersion,
          current.evaluation_reference, input.reason, input.idempotencyKey, input.requestHash, actorUserId,
        ],
      );
      const rollout = inserted.rows[0];
      if (!rollout) throw new Error('SAAS_RELEASE_ROLLOUT_VERSION_INSERT_FAILED');
      return { rollout, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, outcome.rollout.id, `RELEASE_ROLLOUT_${outcome.rollout.action}`, {
        rolloutKey,
        version: Number(outcome.rollout.version),
        stage: outcome.rollout.stage,
        artifactVersion: outcome.rollout.artifact_version,
        artifactDigest: outcome.rollout.artifact_digest,
        rolloutPercentage: Number(outcome.rollout.rollout_percentage),
        rollbackTargetKey: outcome.rollout.rollback_target_key,
        rollbackTargetVersion: outcome.rollout.rollback_target_version === null ? null : Number(outcome.rollout.rollback_target_version),
        reason: outcome.rollout.reason,
      });
    }
    return { rollout: this.mapRollout(outcome.rollout), replayed: outcome.replayed };
  }

  private async findIdempotencyReplay(
    client: PoolClient,
    tenantId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ReleaseRow | null> {
    const result = await client.query<ReleaseRow>(
      `SELECT ${this.columns('r')}
       FROM saas_release_rollouts r
       WHERE r.tenant_id = $1 AND r.idempotency_key = $2 LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw new ConflictException('idempotency_key was already used for a different release request');
    }
    return row;
  }

  private columns(alias?: string) {
    const col = (name: string) => alias ? `${alias}.${name}` : name;
    return `${col('id')}::text AS id, ${col('tenant_id')}::text AS tenant_id, ${col('rollout_key')}, ${col('version')},
      ${col('scope_type')}, ${col('factory_id')}::text AS factory_id, ${col('module_key')}, ${col('agent_key')},
      ${col('release_channel')}, ${col('action')}, ${col('stage')}, ${col('last_active_stage')},
      ${col('artifact_version')}, ${col('artifact_digest')}, ${col('rollout_percentage')},
      ${col('previous_version')}, ${col('rollback_target_key')}, ${col('rollback_target_version')},
      ${col('evaluation_reference')}, ${col('reason')}, ${col('idempotency_key')}, ${col('request_hash')},
      ${col('actor_user_id')}::text AS actor_user_id, ${col('created_at')}::text AS created_at`;
  }

  private mapRollout(row: ReleaseRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      rolloutKey: row.rollout_key,
      version: Number(row.version),
      scopeType: row.scope_type,
      factoryId: row.factory_id,
      moduleKey: row.module_key,
      agentKey: row.agent_key,
      channel: row.release_channel,
      action: row.action,
      stage: row.stage,
      lastActiveStage: row.last_active_stage,
      artifactVersion: row.artifact_version,
      artifactDigest: row.artifact_digest,
      rolloutPercentage: Number(row.rollout_percentage),
      previousVersion: row.previous_version === null ? null : Number(row.previous_version),
      rollbackTargetKey: row.rollback_target_key,
      rollbackTargetVersion: row.rollback_target_version === null ? null : Number(row.rollback_target_version),
      evaluationReference: row.evaluation_reference,
      reason: row.reason,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    };
  }

  private scopePriority(scope: SaasReleaseScopeType) {
    switch (scope) {
      case SaasReleaseScopeType.AGENT: return 4;
      case SaasReleaseScopeType.MODULE: return 3;
      case SaasReleaseScopeType.FACTORY: return 2;
      case SaasReleaseScopeType.ORGANIZATION: return 1;
      default: return 0;
    }
  }

  private rolloutBucket(rolloutKey: string, subjectKey: string) {
    const hash = createHash('sha256').update(`${rolloutKey}:${subjectKey}`, 'utf8').digest('hex');
    return Number.parseInt(hash.slice(0, 8), 16) % 100;
  }

  private normalizeScope(input: CreateSaasReleaseRolloutDto) {
    const factoryId = input.factory_id?.trim() || null;
    if (factoryId) this.assertUuid(factoryId, 'factory_id');
    const moduleKey = input.module_key?.trim() || null;
    const agentKey = input.agent_key?.trim() || null;
    if (moduleKey) this.validateToken(moduleKey, 'module_key', 80);
    if (agentKey) this.validateToken(agentKey, 'agent_key', 160);

    const invalid = (
      input.scope_type === SaasReleaseScopeType.ORGANIZATION && (factoryId !== null || moduleKey !== null || agentKey !== null)
    ) || (
      input.scope_type === SaasReleaseScopeType.FACTORY && (!factoryId || moduleKey !== null || agentKey !== null)
    ) || (
      input.scope_type === SaasReleaseScopeType.MODULE && (!moduleKey || agentKey !== null)
    ) || (
      input.scope_type === SaasReleaseScopeType.AGENT && !agentKey
    );
    if (invalid) {
      throw new BadRequestException('scope_type does not match factory_id, module_key and agent_key fields');
    }
    return { factoryId, moduleKey, agentKey };
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant was not found');
  }

  private async authorize(actorUserId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(actorUserId, tenantId, permission);
  }

  private async audit(actorUserId: string, tenantId: string, resourceId: string, action: string, payload: Record<string, unknown>) {
    try {
      await this.auditService.record({
        tenantId,
        factoryId: null,
        actorUserId,
        eventType: 'SAAS_RELEASE_ROLLOUT',
        action,
        resourceType: 'SAAS_RELEASE_ROLLOUT',
        resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload,
      });
    } catch {
      // The immutable rollout snapshot records the completed change in the same transaction.
    }
  }

  private scope(tenantId: string, actorUserId: string) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(actorUserId, 'actorUserId');
  }

  private assertUuid(value: string, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(`${field} must be a UUID`);
  }

  private normalizeRolloutKey(value: unknown) {
    const key = this.requiredString(value, 'rolloutKey', 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9:_-]{0,79}$/.test(key)) throw new BadRequestException('rolloutKey format is invalid');
    return key;
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new BadRequestException(`${field} must be a non-empty string of at most ${maxLength} characters`);
    }
    return value.trim();
  }

  private validateToken(value: string, field: string, maxLength: number) {
    if (value.length > maxLength || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maxLength - 1}}$`).test(value)) {
      throw new BadRequestException(`${field} format is invalid`);
    }
    return value;
  }

  private requiredIdempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('idempotency_key format is invalid');
    }
    return key;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
}
