import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { CreateSaasDeploymentProfileDto, SaasDeploymentProfileScopeType } from './dto/create-saas-deployment-profile.dto';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import {
  SaasDeploymentProfileTransitionAction,
  TransitionSaasDeploymentProfileDto,
} from './dto/transition-saas-deployment-profile.dto';

type DeploymentProfileStatus =
  | 'PLANNED'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'MIGRATING'
  | 'PAUSED'
  | 'FAILED'
  | 'RETIRED';

interface DeploymentProfileRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  scope_type: SaasDeploymentProfileScopeType;
  scope_key: string;
  factory_id: string | null;
  version: string | number;
  profile_type: SaasDeploymentProfile;
  status: DeploymentProfileStatus;
  action: SaasDeploymentProfileTransitionAction | 'REGISTER';
  deployment_reference: string | null;
  region_code: string | null;
  residency_domain: string | null;
  edge_site_code: string | null;
  target_profile_type: SaasDeploymentProfile | null;
  target_deployment_reference: string | null;
  target_region_code: string | null;
  target_residency_domain: string | null;
  target_edge_site_code: string | null;
  previous_version: string | number | null;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  actor_user_id: string;
  created_at: string;
}

interface ProfileScope {
  scopeType: SaasDeploymentProfileScopeType;
  factoryId: string | null;
  scopeKey: string;
}

interface ProfileConfig {
  profileType: SaasDeploymentProfile;
  deploymentReference: string | null;
  regionCode: string | null;
  residencyDomain: string | null;
  edgeSiteCode: string | null;
}

@Injectable()
export class SaasDeploymentProfileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createAssignment(
    tenantId: string,
    actorUserId: string,
    input: CreateSaasDeploymentProfileDto,
  ) {
    this.scopeIdentity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.deployment_profiles.write');

    if (!Object.values(SaasDeploymentProfileScopeType).includes(input?.scope_type)) {
      throw new BadRequestException('scope_type must be TENANT or FACTORY');
    }
    if (!Object.values(SaasDeploymentProfile).includes(input?.profile_type)) {
      throw new BadRequestException('profile_type is invalid');
    }
    const scope = this.profileScope(input.scope_type, input.factory_id);
    const config: ProfileConfig = {
      profileType: input.profile_type,
      deploymentReference: this.optionalOpaque(input.deployment_reference, 'deployment_reference', 200),
      regionCode: this.optionalOpaque(input.region_code, 'region_code', 64),
      residencyDomain: this.optionalOpaque(input.residency_domain, 'residency_domain', 64),
      edgeSiteCode: this.optionalOpaque(input.edge_site_code, 'edge_site_code', 80),
    };
    const reason = this.requiredString(input.reason, 'reason', 1000);
    const idempotencyKey = this.requiredIdempotencyKey(input.idempotency_key);
    const requestHash = this.hash({
      operation: 'REGISTER_DEPLOYMENT_PROFILE',
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      factoryId: scope.factoryId,
      ...config,
      reason,
    });

    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { profile: replay, replayed: true };

      if (scope.factoryId) await this.assertFactoryExists(client, tenantId, scope.factoryId);
      const latest = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_deployment_profile_versions WHERE tenant_id = $1 AND scope_key = $2 ORDER BY version DESC LIMIT 1',
        [tenantId, scope.scopeKey],
      );
      if (latest.rows[0]) {
        throw new ConflictException('A deployment profile assignment already exists for this scope; transition its lifecycle instead');
      }

      const insert = await client.query<{ id: string }>(
        `INSERT INTO saas_deployment_profile_versions
          (tenant_id, scope_type, scope_key, factory_id, version, profile_type, status, action,
           deployment_reference, region_code, residency_domain, edge_site_code,
           target_profile_type, target_deployment_reference, target_region_code,
           target_residency_domain, target_edge_site_code, previous_version, reason,
           idempotency_key, request_hash, actor_user_id)
         VALUES ($1,$2,$3,$4,1,$5,'PLANNED','REGISTER',$6,$7,$8,$9,
                 NULL,NULL,NULL,NULL,NULL,NULL,$10,$11,$12,$13)
         RETURNING id::text AS id`,
        [
          tenantId,
          scope.scopeType,
          scope.scopeKey,
          scope.factoryId,
          config.profileType,
          config.deploymentReference,
          config.regionCode,
          config.residencyDomain,
          config.edgeSiteCode,
          reason,
          idempotencyKey,
          requestHash,
          actorUserId,
        ],
      );
      const profile = await this.findById(client, tenantId, insert.rows[0].id);
      return { profile, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, 'REGISTER', outcome.profile.id, {
        scopeType: outcome.profile.scopeType,
        factoryId: outcome.profile.factoryId,
        profileType: outcome.profile.profileType,
        version: outcome.profile.version,
      });
    }
    return { profile: this.mapProfile(outcome.profile), replayed: outcome.replayed };
  }

  async listLatest(tenantId: string, actorUserId: string, factoryId?: string) {
    this.scopeIdentity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.deployment_profiles.read');
    const normalizedFactoryId = factoryId ? this.uuid(factoryId, 'factoryId') : null;
    const result = await this.database.query<DeploymentProfileRow>(
      this.snapshotSelect() +
        " WHERE d.tenant_id = $1 AND ($2::uuid IS NULL OR d.scope_type = 'TENANT' OR d.factory_id = $2) ORDER BY d.scope_key, d.version DESC",
      [tenantId, normalizedFactoryId],
      { tenantId },
    );
    const latestByScope = new Map<string, DeploymentProfileRow>();
    for (const row of result.rows) {
      if (!latestByScope.has(row.scope_key)) latestByScope.set(row.scope_key, row);
    }
    return [...latestByScope.values()].map((row) => this.mapProfile(row));
  }

  async history(
    tenantId: string,
    actorUserId: string,
    scopeType: SaasDeploymentProfileScopeType,
    factoryId?: string,
  ) {
    this.scopeIdentity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.deployment_profiles.read');
    const scope = this.profileScope(scopeType, factoryId);
    const result = await this.database.query<DeploymentProfileRow>(
      this.snapshotSelect() + ' WHERE d.tenant_id = $1 AND d.scope_key = $2 ORDER BY d.version DESC',
      [tenantId, scope.scopeKey],
      { tenantId },
    );
    return result.rows.map((row) => this.mapProfile(row));
  }

  async resolveEffective(tenantId: string, actorUserId: string, factoryId?: string) {
    this.scopeIdentity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.deployment_profiles.read');
    const normalizedFactoryId = factoryId ? this.uuid(factoryId, 'factoryId') : null;
    const result = await this.database.query<DeploymentProfileRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (scope_key) *
         FROM saas_deployment_profile_versions
         WHERE tenant_id = $1
         ORDER BY scope_key, version DESC
       )
       SELECT d.id::text AS id, d.tenant_id::text AS tenant_id, d.scope_type, d.scope_key,
         d.factory_id::text AS factory_id, d.version, d.profile_type, d.status, d.action,
         d.deployment_reference, d.region_code, d.residency_domain, d.edge_site_code,
         d.target_profile_type, d.target_deployment_reference, d.target_region_code,
         d.target_residency_domain, d.target_edge_site_code, d.previous_version, d.reason,
         d.idempotency_key, d.request_hash, d.actor_user_id::text AS actor_user_id,
         d.created_at::text AS created_at
       FROM latest d
       WHERE d.status = 'ACTIVE'
         AND (d.scope_type = 'TENANT' OR (d.scope_type = 'FACTORY' AND d.factory_id = $2))
       ORDER BY CASE WHEN d.scope_type = 'FACTORY' THEN 0 ELSE 1 END
       LIMIT 1`,
      [tenantId, normalizedFactoryId],
      { tenantId },
    );
    const row = result.rows[0] ?? null;
    const profile = row ? this.mapProfile(row) : null;
    return {
      profile,
      matchedScope: profile?.scopeType ?? null,
      fallbackToTenant: Boolean(profile && normalizedFactoryId && profile.scopeType === 'TENANT'),
      tenantSemanticsChanged: false,
    };
  }

  async transition(
    tenantId: string,
    actorUserId: string,
    scopeType: SaasDeploymentProfileScopeType,
    factoryId: string | undefined,
    input: TransitionSaasDeploymentProfileDto,
  ) {
    this.scopeIdentity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.deployment_profiles.control');
    const scope = this.profileScope(scopeType, factoryId);
    if (!Object.values(SaasDeploymentProfileTransitionAction).includes(input?.action)) {
      throw new BadRequestException('deployment profile transition action is invalid');
    }
    const expectedVersion = input.expected_version;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER) {
      throw new BadRequestException('expected_version must be a positive safe integer');
    }
    const reason = this.requiredString(input.reason, 'reason', 1000);
    const idempotencyKey = this.requiredIdempotencyKey(input.idempotency_key);
    const migrating = input.action === SaasDeploymentProfileTransitionAction.START_MIGRATION;
    const targetFieldsPresent = [
      input.target_profile_type,
      input.target_deployment_reference,
      input.target_region_code,
      input.target_residency_domain,
      input.target_edge_site_code,
    ].some((value) => value !== undefined);
    if (!migrating && targetFieldsPresent) {
      throw new BadRequestException('target profile fields are allowed only for START_MIGRATION');
    }
    if (migrating && !Object.values(SaasDeploymentProfile).includes(input.target_profile_type as SaasDeploymentProfile)) {
      throw new BadRequestException('target_profile_type is required for START_MIGRATION');
    }

    const target = migrating ? {
      profileType: input.target_profile_type as SaasDeploymentProfile,
      deploymentReference: this.optionalOpaque(input.target_deployment_reference, 'target_deployment_reference', 200),
      regionCode: this.optionalOpaque(input.target_region_code, 'target_region_code', 64),
      residencyDomain: this.optionalOpaque(input.target_residency_domain, 'target_residency_domain', 64),
      edgeSiteCode: this.optionalOpaque(input.target_edge_site_code, 'target_edge_site_code', 80),
    } : null;

    const requestHash = this.hash({
      operation: 'TRANSITION_DEPLOYMENT_PROFILE',
      scopeKey: scope.scopeKey,
      action: input.action,
      expectedVersion,
      target,
      reason,
    });

    const outcome = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await this.findReplay(client, tenantId, idempotencyKey, requestHash);
      if (replay) return { profile: replay, replayed: true };

      const latestResult = await client.query<DeploymentProfileRow>(
        this.snapshotSelect() +
          ' WHERE d.tenant_id = $1 AND d.scope_key = $2 ORDER BY d.version DESC LIMIT 1 FOR UPDATE',
        [tenantId, scope.scopeKey],
      );
      const current = latestResult.rows[0];
      if (!current) throw new NotFoundException('Deployment profile assignment was not found for this scope');
      if (Number(current.version) !== expectedVersion) {
        throw new ConflictException('expected_version is stale; reload the latest deployment profile before retrying');
      }

      const next = this.applyTransition(current, input.action, target);
      const insert = await client.query<{ id: string }>(
        `INSERT INTO saas_deployment_profile_versions
          (tenant_id, scope_type, scope_key, factory_id, version, profile_type, status, action,
           deployment_reference, region_code, residency_domain, edge_site_code,
           target_profile_type, target_deployment_reference, target_region_code,
           target_residency_domain, target_edge_site_code, previous_version, reason,
           idempotency_key, request_hash, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING id::text AS id`,
        [
          tenantId, scope.scopeType, scope.scopeKey, scope.factoryId,
          expectedVersion + 1, next.profileType, next.status, input.action,
          next.deploymentReference, next.regionCode, next.residencyDomain, next.edgeSiteCode,
          next.targetProfileType, next.targetDeploymentReference, next.targetRegionCode,
          next.targetResidencyDomain, next.targetEdgeSiteCode, expectedVersion, reason,
          idempotencyKey, requestHash, actorUserId,
        ],
      );
      const profile = await this.findById(client, tenantId, insert.rows[0].id);
      return { profile, replayed: false };
    }, { tenantId, userId: actorUserId });

    if (!outcome.replayed) {
      await this.audit(actorUserId, tenantId, input.action, outcome.profile.id, {
        scopeType: outcome.profile.scopeType,
        factoryId: outcome.profile.factoryId,
        version: outcome.profile.version,
        profileType: outcome.profile.profileType,
        status: outcome.profile.status,
        reason,
      });
    }
    return { profile: this.mapProfile(outcome.profile), replayed: outcome.replayed };
  }

  private applyTransition(
    current: DeploymentProfileRow,
    action: SaasDeploymentProfileTransitionAction,
    target: ProfileConfig | null,
  ) {
    const next = {
      profileType: current.profile_type,
      status: current.status,
      deploymentReference: current.deployment_reference,
      regionCode: current.region_code,
      residencyDomain: current.residency_domain,
      edgeSiteCode: current.edge_site_code,
      targetProfileType: null as SaasDeploymentProfile | null,
      targetDeploymentReference: null as string | null,
      targetRegionCode: null as string | null,
      targetResidencyDomain: null as string | null,
      targetEdgeSiteCode: null as string | null,
    };

    switch (action) {
      case SaasDeploymentProfileTransitionAction.START_PROVISIONING:
        if (current.status !== 'PLANNED' && current.status !== 'FAILED') {
          throw new ConflictException('Only PLANNED or FAILED profiles can start provisioning');
        }
        next.status = 'PROVISIONING';
        break;
      case SaasDeploymentProfileTransitionAction.ACTIVATE:
        if (current.status !== 'PROVISIONING') {
          throw new ConflictException('Only a PROVISIONING profile can be activated');
        }
        this.assertDeployable(next.profileType, next.deploymentReference, next.edgeSiteCode, 'profile');
        next.status = 'ACTIVE';
        break;
      case SaasDeploymentProfileTransitionAction.START_MIGRATION:
        if (current.status !== 'ACTIVE') {
          throw new ConflictException('Only an ACTIVE profile can start migration');
        }
        if (!target || target.profileType === current.profile_type) {
          throw new BadRequestException('target_profile_type must differ from the current profile type');
        }
        this.assertDeployable(target.profileType, target.deploymentReference, target.edgeSiteCode, 'target profile');
        next.status = 'MIGRATING';
        next.targetProfileType = target.profileType;
        next.targetDeploymentReference = target.deploymentReference;
        next.targetRegionCode = target.regionCode;
        next.targetResidencyDomain = target.residencyDomain;
        next.targetEdgeSiteCode = target.edgeSiteCode;
        break;
      case SaasDeploymentProfileTransitionAction.COMPLETE_MIGRATION:
        if (current.status !== 'MIGRATING' || !current.target_profile_type) {
          throw new ConflictException('Only a MIGRATING profile can complete migration');
        }
        this.assertDeployable(
          current.target_profile_type,
          current.target_deployment_reference,
          current.target_edge_site_code,
          'target profile',
        );
        next.status = 'ACTIVE';
        next.profileType = current.target_profile_type;
        next.deploymentReference = current.target_deployment_reference;
        next.regionCode = current.target_region_code;
        next.residencyDomain = current.target_residency_domain;
        next.edgeSiteCode = current.target_edge_site_code;
        break;
      case SaasDeploymentProfileTransitionAction.PAUSE:
        if (current.status !== 'ACTIVE') {
          throw new ConflictException('Only an ACTIVE profile can be paused');
        }
        next.status = 'PAUSED';
        break;
      case SaasDeploymentProfileTransitionAction.RESUME:
        if (current.status !== 'PAUSED') {
          throw new ConflictException('Only a PAUSED profile can be resumed');
        }
        this.assertDeployable(next.profileType, next.deploymentReference, next.edgeSiteCode, 'profile');
        next.status = 'ACTIVE';
        break;
      case SaasDeploymentProfileTransitionAction.FAIL:
        if (current.status !== 'PROVISIONING' && current.status !== 'MIGRATING') {
          throw new ConflictException('Only a PROVISIONING or MIGRATING profile can be marked failed');
        }
        next.status = 'FAILED';
        break;
      case SaasDeploymentProfileTransitionAction.RETIRE:
        if (!['PLANNED', 'ACTIVE', 'PAUSED', 'FAILED'].includes(current.status)) {
          throw new ConflictException('Only PLANNED, ACTIVE, PAUSED or FAILED profiles can be retired');
        }
        next.status = 'RETIRED';
        break;
      default:
        throw new BadRequestException('Unsupported deployment profile transition');
    }
    return next;
  }

  private assertDeployable(
    profileType: SaasDeploymentProfile,
    deploymentReference: string | null,
    edgeSiteCode: string | null,
    label: string,
  ) {
    if (profileType !== SaasDeploymentProfile.SHARED_SAAS && !deploymentReference) {
      throw new BadRequestException(label + ' requires a non-secret deployment_reference before activation');
    }
    if (profileType === SaasDeploymentProfile.HYBRID_EDGE_CLOUD && !edgeSiteCode) {
      throw new BadRequestException(label + ' requires edge_site_code before activation');
    }
  }

  private profileScope(scopeType: SaasDeploymentProfileScopeType, factoryId?: string): ProfileScope {
    if (!Object.values(SaasDeploymentProfileScopeType).includes(scopeType)) {
      throw new BadRequestException('scope_type must be TENANT or FACTORY');
    }
    if (scopeType === SaasDeploymentProfileScopeType.TENANT) {
      if (factoryId !== undefined && factoryId !== null && factoryId !== '') {
        throw new BadRequestException('factory_id must be omitted for TENANT deployment profile scope');
      }
      return { scopeType, factoryId: null, scopeKey: 'TENANT' };
    }
    const normalizedFactoryId = this.uuid(factoryId, 'factory_id');
    return {
      scopeType,
      factoryId: normalizedFactoryId,
      scopeKey: 'FACTORY:' + normalizedFactoryId,
    };
  }

  private async findReplay(
    client: PoolClient,
    tenantId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<DeploymentProfileRow | null> {
    const result = await client.query<DeploymentProfileRow>(
      this.snapshotSelect() + ' WHERE d.tenant_id = $1 AND d.idempotency_key = $2 LIMIT 1',
      [tenantId, idempotencyKey],
    );
    const prior = result.rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) {
      throw new ConflictException('idempotency_key was already used for a different deployment profile request');
    }
    return prior;
  }

  private async findById(client: PoolClient, tenantId: string, id: string) {
    const result = await client.query<DeploymentProfileRow>(
      this.snapshotSelect() + ' WHERE d.tenant_id = $1 AND d.id = $2 LIMIT 1',
      [tenantId, id],
    );
    if (!result.rows[0]) throw new NotFoundException('Deployment profile snapshot could not be read after insert');
    return result.rows[0];
  }

  private snapshotSelect() {
    return `SELECT d.id::text AS id, d.tenant_id::text AS tenant_id, d.scope_type, d.scope_key,
      d.factory_id::text AS factory_id, d.version, d.profile_type, d.status, d.action,
      d.deployment_reference, d.region_code, d.residency_domain, d.edge_site_code,
      d.target_profile_type, d.target_deployment_reference, d.target_region_code,
      d.target_residency_domain, d.target_edge_site_code, d.previous_version, d.reason,
      d.idempotency_key, d.request_hash, d.actor_user_id::text AS actor_user_id,
      d.created_at::text AS created_at
      FROM saas_deployment_profile_versions d`;
  }

  private mapProfile(row: DeploymentProfileRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      scopeType: row.scope_type,
      factoryId: row.factory_id,
      version: Number(row.version),
      profileType: row.profile_type,
      status: row.status,
      action: row.action,
      deploymentReference: row.deployment_reference,
      regionCode: row.region_code,
      residencyDomain: row.residency_domain,
      edgeSiteCode: row.edge_site_code,
      targetProfileType: row.target_profile_type,
      targetDeploymentReference: row.target_deployment_reference,
      targetRegionCode: row.target_region_code,
      targetResidencyDomain: row.target_residency_domain,
      targetEdgeSiteCode: row.target_edge_site_code,
      previousVersion: row.previous_version === null ? null : Number(row.previous_version),
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    };
  }

  private async assertFactoryExists(client: PoolClient, tenantId: string, factoryId: string) {
    const result = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM factories WHERE id = $1 AND tenant_id = $2 LIMIT 1',
      [factoryId, tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Factory was not found within the authenticated tenant');
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM tenants WHERE id = $1 FOR UPDATE',
      [tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException('Tenant was not found');
  }

  private async authorize(userId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(userId, tenantId, permission);
  }

  private async audit(
    actorUserId: string,
    tenantId: string,
    action: string,
    resourceId: string,
    payload: Record<string, unknown>,
  ) {
    try {
      await this.auditService.record({
        tenantId,
        factoryId: null,
        actorUserId,
        eventType: 'SAAS_DEPLOYMENT_PROFILE',
        action,
        resourceType: 'SAAS_DEPLOYMENT_PROFILE',
        resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload,
      });
    } catch {
      // State and lifecycle history are already committed; audit is best-effort and cannot duplicate a transition.
    }
  }

  private scopeIdentity(tenantId: string, actorUserId: string) {
    this.uuid(tenantId, 'tenantId');
    this.uuid(actorUserId, 'actorUserId');
  }

  private uuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) {
      throw new BadRequestException(field + ' must be a UUID');
    }
    return value.toLowerCase();
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new BadRequestException(field + ' must be a non-empty string of at most ' + maxLength + ' characters');
    }
    return value.trim();
  }

  private optionalOpaque(value: unknown, field: string, maxLength: number): string | null {
    if (value === undefined || value === null || value === '') return null;
    const normalized = this.requiredString(value, field, maxLength);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) {
      throw new BadRequestException(field + ' must be an opaque non-secret reference; URLs, credentials and arbitrary paths are not accepted');
    }
    if (normalized.length > maxLength) {
      throw new BadRequestException(field + ' exceeds its maximum length');
    }
    return normalized;
  }

  private requiredIdempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('idempotency_key has an invalid format');
    }
    return key;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
}
