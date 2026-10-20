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
import { CreateSaasSubscriptionPlanDto, SaasDeploymentProfile, SaasSubscriptionPlanStatus } from './dto/create-saas-subscription-plan.dto';
import { StartSaasTrialDto } from './dto/start-saas-trial.dto';
import { SaasSubscriptionTransitionAction, TransitionSaasSubscriptionDto } from './dto/transition-saas-subscription.dto';
import { SaasEntitlementEnforcementMode, SetSaasEntitlementEnforcementModeDto } from './dto/set-saas-entitlement-enforcement-mode.dto';

type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'EXPIRED';
type SubscriptionEventType = 'TRIAL_STARTED' | 'ACTIVATED' | 'SUSPENDED' | 'RESUMED' | 'UPGRADED' | 'DOWNGRADED' | 'RENEWED' | 'TERMINATED' | 'EXPIRED';

type EntitlementModeRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  version: number | string;
  mode: SaasEntitlementEnforcementMode;
  reason: string;
  effective_at: string;
  idempotency_key: string;
  request_hash: string;
  changed_by: string;
  created_at: string;
};

type PlanRow = QueryResultRow & {
  id: string; tenant_id: string; plan_code: string; version: number | string; display_name: string;
  tier_rank: number | string; deployment_profile: SaasDeploymentProfile; status: SaasSubscriptionPlanStatus;
  capabilities: Record<string, unknown>; idempotency_key: string; request_hash: string; created_by: string; created_at: string;
};

type SubscriptionRow = QueryResultRow & {
  id: string; tenant_id: string; plan_code: string; plan_version: number | string; status: SubscriptionStatus;
  version: number | string; started_at: string; trial_ends_at: string | null; current_period_start: string | null;
  current_period_end: string | null; suspended_at: string | null; terminated_at: string | null;
  last_transition_at: string; created_by: string; updated_by: string; created_at: string; updated_at: string;
  tier_rank?: number | string; display_name?: string; deployment_profile?: SaasDeploymentProfile;
};

type SubscriptionEventRow = QueryResultRow & {
  id: string; tenant_id: string; subscription_id: string; subscription_version: number | string;
  event_type: SubscriptionEventType; from_status: SubscriptionStatus | null; to_status: SubscriptionStatus;
  prior_plan_code: string | null; prior_plan_version: number | string | null;
  plan_code: string; plan_version: number | string; effective_at: string; reason: string | null;
  idempotency_key: string; request_hash: string; actor_user_id: string; created_at: string;
};

@Injectable()
export class SaasSubscriptionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Runtime entitlement gate for premium AI execution.
   *
   * Legacy tenants without a subscription record are deliberately kept in
   * compatibility mode while subscription onboarding is rolled out. If a
   * tenant has a subscription, current state and effective billing/trial
   * window are enforced on every tool execution (no stale cache).
   */
  async assertAiCapabilityAvailable(tenantId: string): Promise<void> {
    this.assertUuid(tenantId, 'tenantId');
    const result = await this.database.query<{
      enforcement_mode: SaasEntitlementEnforcementMode;
      status: SubscriptionStatus | null;
      trial_ends_at: string | null;
      current_period_start: string | null;
      current_period_end: string | null;
    }>(
      `SELECT
         COALESCE((
           SELECT m.mode
           FROM saas_entitlement_enforcement_modes m
           WHERE m.tenant_id = scope.tenant_id
           ORDER BY m.version DESC
           LIMIT 1
         ), 'LEGACY_COMPATIBLE') AS enforcement_mode,
         subscription.status,
         subscription.trial_ends_at::text AS trial_ends_at,
         subscription.current_period_start::text AS current_period_start,
         subscription.current_period_end::text AS current_period_end
       FROM (SELECT $1::uuid AS tenant_id) scope
       LEFT JOIN LATERAL (
         SELECT s.status, s.trial_ends_at, s.current_period_start, s.current_period_end
         FROM saas_subscriptions s
         WHERE s.tenant_id = scope.tenant_id
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 1
       ) subscription ON TRUE`,
      [tenantId],
      { tenantId },
    );

    const subscription = result.rows[0];
    // The no-row branch is kept fail-compatible with older database adapters;
    // PostgreSQL returns one row from the SELECT above even when no subscription exists.
    if (!subscription) return;
    if (!subscription.status) {
      if (subscription.enforcement_mode === SaasEntitlementEnforcementMode.SUBSCRIPTION_REQUIRED) {
        throw new ForbiddenException(
          'This tenant requires an eligible subscription before premium AI execution',
        );
      }
      return; // Unmigrated tenants remain explicitly identified as legacy-compatible.
    }

    const now = Date.now();
    if (
      subscription.status === 'TRIAL' &&
      subscription.trial_ends_at !== null &&
      new Date(subscription.trial_ends_at).getTime() > now
    ) {
      return;
    }

    if (
      subscription.status === 'ACTIVE' &&
      subscription.current_period_start !== null &&
      subscription.current_period_end !== null &&
      new Date(subscription.current_period_start).getTime() <= now &&
      new Date(subscription.current_period_end).getTime() > now
    ) {
      return;
    }

    throw new ForbiddenException(
      'Tenant subscription is suspended, expired, or outside its effective period; premium AI execution is disabled',
    );
  }

  async getEntitlementEnforcementMode(tenantId: string, actorUserId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.entitlement_modes.read');
    const result = await this.database.query<EntitlementModeRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, version, mode, reason,
              effective_at::text AS effective_at, idempotency_key, request_hash,
              changed_by::text AS changed_by, created_at::text AS created_at
       FROM saas_entitlement_enforcement_modes
       WHERE tenant_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [tenantId],
      { tenantId, userId: actorUserId },
    );
    const row = result.rows[0];
    if (!row) {
      return {
        tenantId,
        mode: SaasEntitlementEnforcementMode.LEGACY_COMPATIBLE,
        version: 0,
        reason: null,
        effectiveAt: null,
        changedBy: null,
        createdAt: null,
        source: 'IMPLICIT_LEGACY_DEFAULT',
        requiresSubscription: false,
      };
    }
    return this.mapEntitlementMode(row);
  }

  async setEntitlementEnforcementMode(
    tenantId: string,
    actorUserId: string,
    input: SetSaasEntitlementEnforcementModeDto,
  ) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.entitlement_modes.write');

    const mode = input?.mode;
    if (!Object.values(SaasEntitlementEnforcementMode).includes(mode)) {
      throw new BadRequestException('Entitlement enforcement mode is invalid');
    }
    const expectedVersion = input?.expected_version;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 1_000_000) {
      throw new BadRequestException('expected_version must be an integer from 0 to 1000000');
    }
    const reason = this.requiredString(input?.reason, 'reason', 2000);
    const idempotencyKey = this.requiredIdempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({
      operation: 'SET_ENTITLEMENT_ENFORCEMENT_MODE',
      tenantId,
      mode,
      expectedVersion,
      reason,
    });

    const outcome = await this.database.transaction(
      { tenantId, userId: actorUserId },
      async (client) => {
        // Serializes concurrent first-write migrations even when no mode row exists yet.
        await this.lockTenant(client, tenantId);
        const replay = await client.query<EntitlementModeRow>(
          `SELECT id::text AS id, tenant_id::text AS tenant_id, version, mode, reason,
                  effective_at::text AS effective_at, idempotency_key, request_hash,
                  changed_by::text AS changed_by, created_at::text AS created_at
           FROM saas_entitlement_enforcement_modes
           WHERE tenant_id = $1 AND idempotency_key = $2
           LIMIT 1`,
          [tenantId, idempotencyKey],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== requestHash) {
            throw new ConflictException('Idempotency key was already used for a different entitlement migration');
          }
          return { row: replay.rows[0], replayed: true };
        }

        const latest = await client.query<EntitlementModeRow>(
          `SELECT id::text AS id, tenant_id::text AS tenant_id, version, mode, reason,
                  effective_at::text AS effective_at, idempotency_key, request_hash,
                  changed_by::text AS changed_by, created_at::text AS created_at
           FROM saas_entitlement_enforcement_modes
           WHERE tenant_id = $1
           ORDER BY version DESC
           LIMIT 1
           FOR UPDATE`,
          [tenantId],
        );
        const current = latest.rows[0] ?? null;
        const currentVersion = current ? Number(current.version) : 0;
        const currentMode = current?.mode ?? SaasEntitlementEnforcementMode.LEGACY_COMPATIBLE;
        if (currentVersion !== expectedVersion) {
          throw new ConflictException('Entitlement mode version is stale; reload before migrating the tenant');
        }
        if (currentMode === mode && currentVersion > 0) {
          throw new ConflictException('Tenant already uses the requested entitlement enforcement mode');
        }
        if (
          currentMode === SaasEntitlementEnforcementMode.SUBSCRIPTION_REQUIRED &&
          mode === SaasEntitlementEnforcementMode.LEGACY_COMPATIBLE
        ) {
          throw new ConflictException('Subscription-required enforcement cannot be downgraded to legacy compatibility');
        }
        if (currentVersion >= 1_000_000) {
          throw new ConflictException('Entitlement mode version limit has been reached');
        }

        if (mode === SaasEntitlementEnforcementMode.SUBSCRIPTION_REQUIRED) {
          const eligible = await client.query<{ id: string }>(
            `SELECT id::text AS id
             FROM saas_subscriptions
             WHERE tenant_id = $1
               AND (
                 (status = 'TRIAL' AND trial_ends_at > clock_timestamp())
                 OR
                 (status = 'ACTIVE'
                  AND current_period_start <= clock_timestamp()
                  AND current_period_end > clock_timestamp())
               )
             ORDER BY created_at DESC, id DESC
             LIMIT 1
             FOR UPDATE`,
            [tenantId],
          );
          if (!eligible.rows[0]) {
            throw new ConflictException('Migrate this tenant only after it has an active subscription or an unexpired trial');
          }
        }

        const inserted = await client.query<EntitlementModeRow>(
          `INSERT INTO saas_entitlement_enforcement_modes
             (tenant_id, version, mode, reason, idempotency_key, request_hash, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id::text AS id, tenant_id::text AS tenant_id, version, mode, reason,
                     effective_at::text AS effective_at, idempotency_key, request_hash,
                     changed_by::text AS changed_by, created_at::text AS created_at`,
          [tenantId, currentVersion + 1, mode, reason, idempotencyKey, requestHash, actorUserId],
        );
        if (!inserted.rows[0]) throw new Error('SAAS_ENTITLEMENT_MODE_INSERT_FAILED');
        return { row: inserted.rows[0], replayed: false };
      },
    );

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, 'ENTITLEMENT_ENFORCEMENT_MODE_CHANGED', outcome.row.id, {
        mode: outcome.row.mode,
        version: Number(outcome.row.version),
        reason,
        requestHash,
      });
    }
    return { ...this.mapEntitlementMode(outcome.row), replayed: outcome.replayed };
  }

  async createPlan(tenantId: string, actorUserId: string, input: CreateSaasSubscriptionPlanDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.subscription_plans.write');
    const planCode = this.requiredString(input?.plan_code, 'plan_code', 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9_:-]{0,79}$/.test(planCode)) throw new BadRequestException('plan_code must use uppercase letters, digits, underscore, colon or hyphen');
    const displayName = this.requiredString(input?.display_name, 'display_name', 160);
    const tierRank = input?.tier_rank;
    if (!Number.isInteger(tierRank) || tierRank < 1 || tierRank > 1_000_000) throw new BadRequestException('tier_rank must be an integer from 1 to 1000000');
    const deploymentProfile = input.deployment_profile ?? SaasDeploymentProfile.SHARED_SAAS;
    if (!Object.values(SaasDeploymentProfile).includes(deploymentProfile)) throw new BadRequestException('deployment_profile is invalid');
    const status = input.status ?? SaasSubscriptionPlanStatus.ACTIVE;
    if (!Object.values(SaasSubscriptionPlanStatus).includes(status)) throw new BadRequestException('plan status is invalid');
    const capabilities = input.capabilities ?? {};
    if (!this.isPlainObject(capabilities) || Buffer.byteLength(JSON.stringify(capabilities), 'utf8') > 16384) throw new BadRequestException('capabilities must be an object no larger than 16 KiB');
    const idempotencyKey = this.requiredIdempotencyKey(input.idempotency_key);
    const normalized = { planCode, displayName, tierRank, deploymentProfile, status, capabilities };
    const requestHash = this.hash({ operation: 'CREATE_PLAN_VERSION', ...normalized });
    const outcome = await this.database.transaction({ tenantId, userId: actorUserId }, async (client) => {
      await this.lockTenant(client, tenantId);
      const prior = await client.query<PlanRow>(
        'SELECT * FROM saas_subscription_plans WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
        [tenantId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new ConflictException('idempotency_key was already used for a different plan request');
        return { plan: prior.rows[0], replayed: true };
      }
      const versionResult = await client.query<{ next_version: string }>(
        'SELECT (COALESCE(MAX(version), 0) + 1)::text AS next_version FROM saas_subscription_plans WHERE tenant_id = $1 AND plan_code = $2',
        [tenantId, planCode],
      );
      const version = Number(versionResult.rows[0]?.next_version ?? 1);
      const inserted = await client.query<PlanRow>(
        `INSERT INTO saas_subscription_plans
          (tenant_id, plan_code, version, display_name, tier_rank, deployment_profile, status, capabilities, idempotency_key, request_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
         RETURNING id::text AS id, tenant_id::text AS tenant_id, plan_code, version, display_name, tier_rank,
                   deployment_profile, status, capabilities, idempotency_key, request_hash,
                   created_by::text AS created_by, created_at::text AS created_at`,
        [tenantId, planCode, version, displayName, tierRank, deploymentProfile, status, JSON.stringify(capabilities), idempotencyKey, requestHash, actorUserId],
      );
      if (!inserted.rows[0]) throw new Error('SAAS_PLAN_INSERT_FAILED');
      return { plan: inserted.rows[0], replayed: false };
    });
    if (!outcome.replayed) await this.audit(actorUserId, tenantId, 'PLAN_VERSION_CREATED', outcome.plan.id, {
      planCode, version: Number(outcome.plan.version), tierRank, deploymentProfile, status,
    });
    return { plan: this.mapPlan(outcome.plan), replayed: outcome.replayed };
  }

  async listPlans(tenantId: string, actorUserId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.subscription_plans.read');
    const result = await this.database.query<PlanRow>(
      `SELECT DISTINCT ON (p.plan_code)
          p.id::text AS id, p.tenant_id::text AS tenant_id, p.plan_code, p.version, p.display_name,
          p.tier_rank, p.deployment_profile, p.status, p.capabilities, p.idempotency_key,
          p.request_hash, p.created_by::text AS created_by, p.created_at::text AS created_at
       FROM saas_subscription_plans p
       WHERE p.tenant_id = $1
       ORDER BY p.plan_code, p.version DESC`,
      [tenantId],
      { tenantId },
    );
    return { items: result.rows.map((row) => this.mapPlan(row)), count: result.rows.length };
  }

  async startTrial(tenantId: string, actorUserId: string, input: StartSaasTrialDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.subscriptions.write');
    const planCode = this.requiredString(input?.plan_code, 'plan_code', 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9_:-]{0,79}$/.test(planCode)) throw new BadRequestException('plan_code is invalid');
    const trialEndsAt = this.normalizeDate(input?.trial_ends_at, 'trial_ends_at');
    if (new Date(trialEndsAt).getTime() <= Date.now()) throw new BadRequestException('trial_ends_at must be in the future');
    const idempotencyKey = this.requiredIdempotencyKey(input.idempotency_key);
    const requestHash = this.hash({ operation: 'START_TRIAL', planCode, trialEndsAt });
    const outcome = await this.database.transaction({ tenantId, userId: actorUserId }, async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findEventReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { ...replay, replayed: true };
      const live = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM saas_subscriptions
         WHERE tenant_id = $1 AND status NOT IN ('TERMINATED','EXPIRED') LIMIT 1 FOR UPDATE`,
        [tenantId],
      );
      if (live.rows[0]) throw new ConflictException('Tenant already has a non-terminal subscription');
      const planResult = await client.query<PlanRow>(
        `SELECT id::text AS id, tenant_id::text AS tenant_id, plan_code, version, display_name, tier_rank,
                deployment_profile, status, capabilities, idempotency_key, request_hash,
                created_by::text AS created_by, created_at::text AS created_at
         FROM saas_subscription_plans
         WHERE tenant_id = $1 AND plan_code = $2 AND status = 'ACTIVE'
         ORDER BY version DESC LIMIT 1`,
        [tenantId, planCode],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new NotFoundException('No active subscription plan exists for this tenant and plan_code');
      const now = new Date();
      const subscriptionResult = await client.query<SubscriptionRow>(
        `INSERT INTO saas_subscriptions (tenant_id, plan_code, plan_version, status, version, started_at, trial_ends_at, created_by, updated_by)
         VALUES ($1,$2,$3,'TRIAL',1,$4::timestamptz,$5::timestamptz,$6,$6)
         RETURNING id::text AS id, tenant_id::text AS tenant_id, plan_code, plan_version, status, version,
                   started_at::text AS started_at, trial_ends_at::text AS trial_ends_at,
                   current_period_start::text AS current_period_start, current_period_end::text AS current_period_end,
                   suspended_at::text AS suspended_at, terminated_at::text AS terminated_at,
                   last_transition_at::text AS last_transition_at, created_by::text AS created_by,
                   updated_by::text AS updated_by, created_at::text AS created_at, updated_at::text AS updated_at`,
        [tenantId, planCode, Number(plan.version), now.toISOString(), trialEndsAt, actorUserId],
      );
      const subscription = subscriptionResult.rows[0];
      if (!subscription) throw new Error('SAAS_SUBSCRIPTION_INSERT_FAILED');
      const eventResult = await client.query<SubscriptionEventRow>(
        `INSERT INTO saas_subscription_events
          (tenant_id, subscription_id, subscription_version, event_type, from_status, to_status,
           prior_plan_code, prior_plan_version, plan_code, plan_version, effective_at, reason, idempotency_key, request_hash, actor_user_id)
         VALUES ($1,$2,1,'TRIAL_STARTED',NULL,'TRIAL',NULL,NULL,$3,$4,$5::timestamptz,NULL,$6,$7,$8)
         RETURNING id::text AS id, tenant_id::text AS tenant_id, subscription_id::text AS subscription_id,
                   subscription_version, event_type, from_status, to_status, prior_plan_code, prior_plan_version,
                   plan_code, plan_version, effective_at::text AS effective_at, reason, idempotency_key,
                   request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at`,
        [tenantId, subscription.id, planCode, Number(plan.version), now.toISOString(), idempotencyKey, requestHash, actorUserId],
      );
      if (!eventResult.rows[0]) throw new Error('SAAS_SUBSCRIPTION_EVENT_INSERT_FAILED');
      return { subscription, event: eventResult.rows[0], replayed: false };
    });
    if (!outcome.replayed) await this.audit(actorUserId, tenantId, 'TRIAL_STARTED', outcome.subscription.id, {
      planCode, trialEndsAt, subscriptionVersion: Number(outcome.subscription.version),
    });
    return {
      subscription: this.mapSubscription(outcome.subscription),
      event: this.mapEvent(outcome.event),
      replayed: outcome.replayed,
    };
  }

  async getCurrentSubscription(tenantId: string, actorUserId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.subscriptions.read');
    const result = await this.database.query<SubscriptionRow>(
      this.subscriptionSelect() + ` WHERE s.tenant_id = $1 ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
      [tenantId],
      { tenantId },
    );
    return result.rows[0] ? this.mapSubscription(result.rows[0]) : null;
  }

  async listEvents(tenantId: string, actorUserId: string, subscriptionId: string) {
    this.scope(tenantId, actorUserId);
    this.assertUuid(subscriptionId, 'subscriptionId');
    await this.authorize(actorUserId, tenantId, 'saas.subscriptions.read');
    const exists = await this.database.query<{ id: string }>(
      'SELECT id::text AS id FROM saas_subscriptions WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, subscriptionId],
      { tenantId },
    );
    if (!exists.rows[0]) throw new NotFoundException('Subscription was not found in this tenant');
    const result = await this.database.query<SubscriptionEventRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, subscription_id::text AS subscription_id,
              subscription_version, event_type, from_status, to_status, prior_plan_code, prior_plan_version,
              plan_code, plan_version, effective_at::text AS effective_at, reason, idempotency_key,
              request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at
       FROM saas_subscription_events WHERE tenant_id = $1 AND subscription_id = $2
       ORDER BY subscription_version ASC`,
      [tenantId, subscriptionId],
      { tenantId },
    );
    return { items: result.rows.map((row) => this.mapEvent(row)), count: result.rows.length };
  }

  async transition(tenantId: string, actorUserId: string, subscriptionId: string, input: TransitionSaasSubscriptionDto) {
    this.scope(tenantId, actorUserId);
    this.assertUuid(subscriptionId, 'subscriptionId');
    await this.authorize(actorUserId, tenantId, 'saas.subscriptions.write');
    if (!Object.values(SaasSubscriptionTransitionAction).includes(input?.action)) throw new BadRequestException('Subscription transition action is invalid');
    if (!Number.isInteger(input?.expected_version) || input.expected_version < 1) throw new BadRequestException('expected_version must be a positive integer');
    const action = input.action;
    const targetPlanCode = input.target_plan_code?.trim().toUpperCase() || null;
    if (targetPlanCode && !/^[A-Z][A-Z0-9_:-]{0,79}$/.test(targetPlanCode)) throw new BadRequestException('target_plan_code is invalid');
    const reason = input.reason === undefined ? null : this.requiredString(input.reason, 'reason', 1000);
    const effectiveAt = input.effective_at ? this.normalizeDate(input.effective_at, 'effective_at') : new Date().toISOString();
    if (new Date(effectiveAt).getTime() > Date.now() + 1000) throw new BadRequestException('Future subscription transitions are not supported; run the transition at its effective time');
    const periodStart = input.period_start ? this.normalizeDate(input.period_start, 'period_start') : null;
    const periodEnd = input.period_end ? this.normalizeDate(input.period_end, 'period_end') : null;
    if ((periodStart === null) !== (periodEnd === null)) throw new BadRequestException('period_start and period_end must be supplied together');
    if (periodStart && periodEnd && new Date(periodEnd).getTime() <= new Date(periodStart).getTime()) throw new BadRequestException('period_end must be later than period_start');
    if (['ACTIVATE','RESUME','RENEW'].includes(action) && (!periodStart || !periodEnd)) throw new BadRequestException(`${action} requires period_start and period_end`);
    if (['UPGRADE','DOWNGRADE'].includes(action) && !targetPlanCode) throw new BadRequestException(`${action} requires target_plan_code`);
    if (!['UPGRADE','DOWNGRADE'].includes(action) && targetPlanCode) throw new BadRequestException('target_plan_code is only valid for UPGRADE or DOWNGRADE');
    if (!['ACTIVATE','RESUME','RENEW'].includes(action) && periodStart) throw new BadRequestException(`period dates are not valid for ${action}`);

    const idempotencyKey = this.requiredIdempotencyKey(input.idempotency_key);
    const requestHash = this.hash({
      operation: 'TRANSITION_SUBSCRIPTION',
      subscriptionId,
      action,
      expectedVersion: input.expected_version,
      targetPlanCode,
      periodStart,
      periodEnd,
      effectiveAt: input.effective_at ? effectiveAt : null,
      reason,
    });

    const outcome = await this.database.transaction({ tenantId, userId: actorUserId }, async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findEventReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) {
        if (replay.event.subscription_id !== subscriptionId) throw new ConflictException('idempotency_key was already used for a different subscription');
        return { ...replay, replayed: true };
      }
      const currentResult = await client.query<SubscriptionRow>(
        this.subscriptionSelect() + ` WHERE s.tenant_id = $1 AND s.id = $2 LIMIT 1 FOR UPDATE OF s`,
        [tenantId, subscriptionId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('Subscription was not found in this tenant');
      if (Number(current.version) !== input.expected_version) throw new ConflictException('Subscription version is stale; reload current state before retrying');
      if (['TERMINATED','EXPIRED'].includes(current.status)) throw new ConflictException('Terminal subscriptions cannot be transitioned');

      let nextStatus: SubscriptionStatus = current.status;
      let nextPlanCode = current.plan_code;
      let nextPlanVersion = Number(current.plan_version);
      let nextPlanRank = Number(current.tier_rank ?? 0);
      let nextPeriodStart = current.current_period_start;
      let nextPeriodEnd = current.current_period_end;
      let suspendedAt: string | null = current.suspended_at;
      let terminatedAt: string | null = current.terminated_at;

      switch (action) {
        case SaasSubscriptionTransitionAction.ACTIVATE:
          if (current.status !== 'TRIAL') throw new ConflictException('Only a TRIAL subscription can be activated');
          if (current.trial_ends_at && new Date(current.trial_ends_at).getTime() <= new Date(effectiveAt).getTime()) throw new ConflictException('Expired trials cannot be activated');
          if (new Date(periodStart!).getTime() > new Date(effectiveAt).getTime() || new Date(periodEnd!).getTime() <= new Date(effectiveAt).getTime()) throw new BadRequestException('Activation period must include effective_at');
          nextStatus = 'ACTIVE'; nextPeriodStart = periodStart; nextPeriodEnd = periodEnd; break;
        case SaasSubscriptionTransitionAction.SUSPEND:
          if (current.status !== 'ACTIVE') throw new ConflictException('Only ACTIVE subscriptions can be suspended');
          nextStatus = 'SUSPENDED'; suspendedAt = effectiveAt; break;
        case SaasSubscriptionTransitionAction.RESUME:
          if (current.status !== 'SUSPENDED') throw new ConflictException('Only SUSPENDED subscriptions can be resumed');
          if (current.current_period_end && new Date(periodStart!).getTime() < new Date(current.current_period_end).getTime()) throw new ConflictException('Resume period cannot overlap the previous billing period');
          if (new Date(periodStart!).getTime() > new Date(effectiveAt).getTime() || new Date(periodEnd!).getTime() <= new Date(effectiveAt).getTime()) throw new BadRequestException('Resume period must include effective_at');
          nextStatus = 'ACTIVE'; suspendedAt = null; nextPeriodStart = periodStart; nextPeriodEnd = periodEnd; break;
        case SaasSubscriptionTransitionAction.UPGRADE:
        case SaasSubscriptionTransitionAction.DOWNGRADE: {
          if (current.status !== 'ACTIVE') throw new ConflictException('Only ACTIVE subscriptions can change plan');
          if (!targetPlanCode) throw new BadRequestException(`${action} requires target_plan_code`);
          const targetResult = await client.query<PlanRow>(
            `SELECT id::text AS id, tenant_id::text AS tenant_id, plan_code, version, display_name, tier_rank,
                    deployment_profile, status, capabilities, idempotency_key, request_hash,
                    created_by::text AS created_by, created_at::text AS created_at
             FROM saas_subscription_plans
             WHERE tenant_id = $1 AND plan_code = $2 AND status = 'ACTIVE'
             ORDER BY version DESC LIMIT 1`,
            [tenantId, targetPlanCode],
          );
          const target = targetResult.rows[0];
          if (!target) throw new NotFoundException('Target plan is not active for this tenant');
          const targetRank = Number(target.tier_rank);
          if (targetPlanCode === current.plan_code) throw new ConflictException('Target plan must differ from the current plan');
          if (action === 'UPGRADE' && targetRank <= nextPlanRank) throw new ConflictException('UPGRADE target must have a greater tier_rank than the current plan');
          if (action === 'DOWNGRADE' && targetRank >= nextPlanRank) throw new ConflictException('DOWNGRADE target must have a lower tier_rank than the current plan');
          nextPlanCode = target.plan_code; nextPlanVersion = Number(target.version); nextPlanRank = targetRank;
          break;
        }
        case SaasSubscriptionTransitionAction.RENEW:
          if (current.status !== 'ACTIVE') throw new ConflictException('Only ACTIVE subscriptions can be renewed');
          if (!current.current_period_end || new Date(current.current_period_end).getTime() > new Date(effectiveAt).getTime()) throw new ConflictException('A renewal can only be recorded when the current billing period has ended');
          if (new Date(periodStart!).getTime() < new Date(current.current_period_end).getTime()) throw new ConflictException('Renewal period cannot start before the current period ends');
          if (new Date(periodStart!).getTime() > new Date(effectiveAt).getTime() || new Date(periodEnd!).getTime() <= new Date(effectiveAt).getTime()) throw new BadRequestException('Renewal period must include effective_at');
          nextPeriodStart = periodStart; nextPeriodEnd = periodEnd; break;
        case SaasSubscriptionTransitionAction.TERMINATE:
          nextStatus = 'TERMINATED'; terminatedAt = effectiveAt; suspendedAt = null; break;
        case SaasSubscriptionTransitionAction.EXPIRE: {
          const expirableAt = current.status === 'TRIAL' ? current.trial_ends_at : current.status === 'ACTIVE' ? current.current_period_end : null;
          if (!expirableAt || new Date(expirableAt).getTime() > new Date(effectiveAt).getTime()) throw new ConflictException('Subscription has not reached an expiry boundary');
          nextStatus = 'EXPIRED'; suspendedAt = null; terminatedAt = null; break;
        }
        default:
          throw new BadRequestException('Unsupported subscription transition action');
      }

      const nextVersion = Number(current.version) + 1;
      const updatedResult = await client.query<SubscriptionRow>(
        `UPDATE saas_subscriptions
         SET plan_code = $3, plan_version = $4, status = $5, version = $6,
             current_period_start = $7::timestamptz, current_period_end = $8::timestamptz,
             suspended_at = $9::timestamptz, terminated_at = $10::timestamptz,
             last_transition_at = $11::timestamptz, updated_by = $12, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND version = $13
         RETURNING id::text AS id, tenant_id::text AS tenant_id, plan_code, plan_version, status, version,
                   started_at::text AS started_at, trial_ends_at::text AS trial_ends_at,
                   current_period_start::text AS current_period_start, current_period_end::text AS current_period_end,
                   suspended_at::text AS suspended_at, terminated_at::text AS terminated_at,
                   last_transition_at::text AS last_transition_at, created_by::text AS created_by,
                   updated_by::text AS updated_by, created_at::text AS created_at, updated_at::text AS updated_at`,
        [tenantId, subscriptionId, nextPlanCode, nextPlanVersion, nextStatus, nextVersion,
         nextPeriodStart, nextPeriodEnd, suspendedAt, terminatedAt, effectiveAt, actorUserId, input.expected_version],
      );
      const updated = updatedResult.rows[0];
      if (!updated) throw new ConflictException('Subscription state changed concurrently; reload and retry');
      const eventType = this.eventType(action);
      const eventResult = await client.query<SubscriptionEventRow>(
        `INSERT INTO saas_subscription_events
          (tenant_id, subscription_id, subscription_version, event_type, from_status, to_status,
           prior_plan_code, prior_plan_version, plan_code, plan_version, effective_at, reason, idempotency_key, request_hash, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14,$15)
         RETURNING id::text AS id, tenant_id::text AS tenant_id, subscription_id::text AS subscription_id,
                   subscription_version, event_type, from_status, to_status, prior_plan_code, prior_plan_version,
                   plan_code, plan_version, effective_at::text AS effective_at, reason, idempotency_key,
                   request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at`,
        [tenantId, subscriptionId, nextVersion, eventType, current.status, nextStatus,
         current.plan_code, Number(current.plan_version), nextPlanCode, nextPlanVersion, effectiveAt,
         reason, idempotencyKey, requestHash, actorUserId],
      );
      if (!eventResult.rows[0]) throw new Error('SAAS_SUBSCRIPTION_EVENT_INSERT_FAILED');
      return { subscription: updated, event: eventResult.rows[0], replayed: false };
    });
    if (!outcome.replayed) await this.audit(actorUserId, tenantId, outcome.event.event_type, outcome.subscription.id, {
      subscriptionVersion: Number(outcome.subscription.version),
      fromStatus: outcome.event.from_status,
      toStatus: outcome.event.to_status,
      priorPlanCode: outcome.event.prior_plan_code,
      planCode: outcome.event.plan_code,
      reason: outcome.event.reason,
    });
    return {
      subscription: this.mapSubscription(outcome.subscription),
      event: this.mapEvent(outcome.event),
      replayed: outcome.replayed,
    };
  }

  private mapEntitlementMode(row: EntitlementModeRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      mode: row.mode,
      version: Number(row.version),
      reason: row.reason,
      effectiveAt: row.effective_at,
      changedBy: row.changed_by,
      createdAt: row.created_at,
      source: 'EXPLICIT',
      requiresSubscription: row.mode === SaasEntitlementEnforcementMode.SUBSCRIPTION_REQUIRED,
    };
  }

  private async findEventReplay(client: PoolClient, tenantId: string, idempotencyKey: string, requestHash: string) {
    const prior = await client.query<SubscriptionEventRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, subscription_id::text AS subscription_id,
              subscription_version, event_type, from_status, to_status, prior_plan_code, prior_plan_version,
              plan_code, plan_version, effective_at::text AS effective_at, reason, idempotency_key,
              request_hash, actor_user_id::text AS actor_user_id, created_at::text AS created_at
       FROM saas_subscription_events WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    const event = prior.rows[0];
    if (!event) return null;
    if (event.request_hash !== requestHash) throw new ConflictException('idempotency_key was already used for a different subscription request');
    const subscriptionResult = await client.query<SubscriptionRow>(
      this.subscriptionSelect() + ' WHERE s.tenant_id = $1 AND s.id = $2 LIMIT 1',
      [tenantId, event.subscription_id],
    );
    if (!subscriptionResult.rows[0]) throw new NotFoundException('Subscription event exists but its subscription is not visible');
    return { subscription: subscriptionResult.rows[0], event };
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>('SELECT id::text AS id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant was not found');
  }

  private subscriptionSelect() {
    return `SELECT s.id::text AS id, s.tenant_id::text AS tenant_id, s.plan_code, s.plan_version,
                   s.status, s.version, s.started_at::text AS started_at, s.trial_ends_at::text AS trial_ends_at,
                   s.current_period_start::text AS current_period_start, s.current_period_end::text AS current_period_end,
                   s.suspended_at::text AS suspended_at, s.terminated_at::text AS terminated_at,
                   s.last_transition_at::text AS last_transition_at, s.created_by::text AS created_by,
                   s.updated_by::text AS updated_by, s.created_at::text AS created_at, s.updated_at::text AS updated_at,
                   p.tier_rank, p.display_name, p.deployment_profile
            FROM saas_subscriptions s
            JOIN saas_subscription_plans p
              ON p.tenant_id = s.tenant_id AND p.plan_code = s.plan_code AND p.version = s.plan_version`;
  }

  private eventType(action: SaasSubscriptionTransitionAction): SubscriptionEventType {
    const eventTypes: Record<SaasSubscriptionTransitionAction, SubscriptionEventType> = {
      ACTIVATE: 'ACTIVATED', SUSPEND: 'SUSPENDED', RESUME: 'RESUMED', UPGRADE: 'UPGRADED',
      DOWNGRADE: 'DOWNGRADED', RENEW: 'RENEWED', TERMINATE: 'TERMINATED', EXPIRE: 'EXPIRED',
    };
    return eventTypes[action];
  }

  private mapPlan(row: PlanRow) {
    return {
      id: row.id, tenantId: row.tenant_id, planCode: row.plan_code, version: Number(row.version),
      displayName: row.display_name, tierRank: Number(row.tier_rank), deploymentProfile: row.deployment_profile,
      status: row.status, capabilities: row.capabilities, createdBy: row.created_by, createdAt: row.created_at,
    };
  }

  private mapSubscription(row: SubscriptionRow) {
    return {
      id: row.id, tenantId: row.tenant_id, planCode: row.plan_code, planVersion: Number(row.plan_version),
      planName: row.display_name ?? null, tierRank: row.tier_rank === undefined ? null : Number(row.tier_rank),
      deploymentProfile: row.deployment_profile ?? null, status: row.status, version: Number(row.version),
      startedAt: row.started_at, trialEndsAt: row.trial_ends_at, currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end, suspendedAt: row.suspended_at, terminatedAt: row.terminated_at,
      lastTransitionAt: row.last_transition_at, createdBy: row.created_by, updatedBy: row.updated_by,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private mapEvent(row: SubscriptionEventRow) {
    return {
      id: row.id, tenantId: row.tenant_id, subscriptionId: row.subscription_id,
      subscriptionVersion: Number(row.subscription_version), eventType: row.event_type, fromStatus: row.from_status,
      toStatus: row.to_status, priorPlanCode: row.prior_plan_code,
      priorPlanVersion: row.prior_plan_version === null ? null : Number(row.prior_plan_version),
      planCode: row.plan_code, planVersion: Number(row.plan_version), effectiveAt: row.effective_at,
      reason: row.reason, idempotencyKey: row.idempotency_key, actorUserId: row.actor_user_id, createdAt: row.created_at,
    };
  }

  private async authorize(userId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(userId, tenantId, permission);
  }

  private async audit(actorUserId: string, tenantId: string, action: string, resourceId: string, payload: Record<string, unknown>) {
    try {
      await this.auditService.record({
        tenantId, factoryId: null, actorUserId, eventType: 'SAAS_SUBSCRIPTION', action,
        resourceType: 'SAAS_SUBSCRIPTION', resourceId, correlationId: null, requestId: null,
        dataClass: 'INTERNAL', payload,
      });
    } catch {
      // The immutable lifecycle event and state transaction are already committed; audit failure cannot be retried as a second transition.
    }
  }

  private scope(tenantId: string, actorUserId: string) {
    this.assertUuid(tenantId, 'tenantId');
    this.assertUuid(actorUserId, 'actorUserId');
  }

  private assertUuid(value: string, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(`${field} must be a UUID`);
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new BadRequestException(`${field} must be a non-empty string of at most ${maxLength} characters`);
    return value.trim();
  }

  private requiredIdempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) throw new BadRequestException('idempotency_key has an invalid format');
    return key;
  }

  private normalizeDate(value: unknown, field: string) {
    if (typeof value !== 'string' && !(value instanceof Date)) throw new BadRequestException(`${field} must be a valid date`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${field} must be a valid date`);
    return date.toISOString();
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
}
