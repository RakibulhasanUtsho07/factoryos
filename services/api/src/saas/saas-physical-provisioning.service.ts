import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { SaasDeploymentProfile } from './dto/create-saas-subscription-plan.dto';
import { SaasDeploymentProfileScopeType } from './dto/create-saas-deployment-profile.dto';
import { SaasDeploymentProfileTransitionAction } from './dto/transition-saas-deployment-profile.dto';
import { SaasDeploymentProfileService } from './saas-deployment-profile.service';
import { ExecuteSaasPhysicalOperationDto, SaasPhysicalFailurePolicy } from './dto/execute-saas-physical-operation.dto';
import { RollbackSaasReleaseRolloutDto } from './dto/rollback-saas-release-rollout.dto';
import { SaasReleaseTransitionAction } from './dto/transition-saas-release-rollout.dto';
import { SaasReleaseRolloutService } from './saas-release-rollout.service';
import {
  PhysicalDeploymentProfile,
  PhysicalDeploymentProfileInput,
  PhysicalHealthCheckReceipt,
  PhysicalInfrastructureAdapter,
  PhysicalOperationContext,
  PhysicalProvisioningReceipt,
  PhysicalReleaseDeploymentReceipt,
  PhysicalReleaseInput,
  PhysicalRollbackReceipt,
  PhysicalSandboxInput,
  SAAS_PHYSICAL_INFRASTRUCTURE_ADAPTERS,
} from './saas-physical-infrastructure.adapters';

type PhysicalOperation = 'SANDBOX_PROVISION' | 'DEPLOYMENT_PROFILE_PROVISION' | 'RELEASE_DEPLOY';
type PhysicalResourceType = 'SANDBOX' | 'DEPLOYMENT_PROFILE' | 'RELEASE';
type PhysicalRunStatus =
  | 'REQUESTED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'HALTED'
  | 'ROLLBACK_IN_PROGRESS' | 'ROLLED_BACK' | 'ROLLBACK_FAILED';

type PhysicalRunRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  operation: PhysicalOperation;
  resource_type: PhysicalResourceType;
  resource_id: string;
  resource_key: string;
  resource_version: number | string;
  topology: SaasDeploymentProfile;
  deployment_reference: string | null;
  failure_policy: SaasPhysicalFailurePolicy;
  health_timeout_seconds: number;
  artifact_digest: string | null;
  dataset_manifest_digest: string | null;
  idempotency_key: string;
  request_hash: string;
  actor_user_id: string;
  created_at: string;
  latest_status?: PhysicalRunStatus | null;
};

type PhysicalEventRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  run_id: string;
  event_version: number | string;
  event_status: PhysicalRunStatus;
  provider_code: string | null;
  provider_reference: string | null;
  evidence_digest: string | null;
  reason_code: string | null;
  evidence: Record<string, unknown>;
  actor_user_id: string;
  created_at: string;
};

type SandboxRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  environment_code: string;
  purpose: string;
  data_mode: 'SYNTHETIC' | 'MASKED';
  status: string;
  version: number | string;
  dataset_manifest: Record<string, unknown>;
  privacy_assessment: Record<string, unknown>;
  approval_expires_at: string | null;
};

type ProfileRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  scope_type: 'TENANT' | 'FACTORY';
  scope_key: string;
  factory_id: string | null;
  version: number | string;
  profile_type: SaasDeploymentProfile;
  status: string;
  deployment_reference: string | null;
  region_code: string | null;
  residency_domain: string | null;
  edge_site_code: string | null;
};

type ReleaseRow = QueryResultRow & {
  id: string;
  tenant_id: string;
  rollout_key: string;
  version: number | string;
  scope_type: 'ORGANIZATION' | 'FACTORY' | 'MODULE' | 'AGENT';
  factory_id: string | null;
  module_key: string | null;
  agent_key: string | null;
  release_channel: string;
  stage: string;
  artifact_version: string;
  artifact_digest: string;
  rollout_percentage: number;
};

const RUN_COLUMNS = `id::text AS id,tenant_id::text AS tenant_id,operation,resource_type,
  resource_id::text AS resource_id,resource_key,resource_version,topology,deployment_reference,
  failure_policy,health_timeout_seconds,artifact_digest,dataset_manifest_digest,
  idempotency_key,request_hash,actor_user_id::text AS actor_user_id,created_at::text AS created_at`;
const EVENT_COLUMNS = `id::text AS id,tenant_id::text AS tenant_id,run_id::text AS run_id,event_version,
  event_status,provider_code,provider_reference,evidence_digest,reason_code,evidence,
  actor_user_id::text AS actor_user_id,created_at::text AS created_at`;

@Injectable()
export class SaasPhysicalProvisioningService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    @Inject(SAAS_PHYSICAL_INFRASTRUCTURE_ADAPTERS)
    private readonly adapters: PhysicalInfrastructureAdapter[] = [],
    @Optional()
    private readonly releaseRolloutService?: SaasReleaseRolloutService,
    @Optional()
    private readonly deploymentProfileService?: SaasDeploymentProfileService,
  ) {}

  async provisionSandbox(
    tenantId: string,
    actorUserId: string,
    sandboxId: string,
    input: ExecuteSaasPhysicalOperationDto,
  ) {
    this.scope(tenantId, actorUserId, sandboxId);
    await this.authorize(actorUserId, tenantId, 'saas.sandboxes.control');
    const sandboxResult = await this.database.query<SandboxRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,environment_code,purpose,data_mode,status,version,
              dataset_manifest,privacy_assessment,approval_expires_at::text AS approval_expires_at
       FROM saas_sandbox_environments WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
      [tenantId, sandboxId],
      { tenantId, userId: actorUserId },
    );
    const sandbox = sandboxResult.rows[0];
    if (!sandbox) throw new NotFoundException('Sandbox environment was not found in this tenant');
    if (Number(sandbox.version) !== input?.expected_version) {
      throw new ConflictException('Sandbox version changed; reload and retry with the latest expected_version');
    }
    if (sandbox.status !== 'ACTIVE') {
      throw new ConflictException('Only an active sandbox may be physically provisioned');
    }
    if (sandbox.data_mode === 'MASKED' &&
      (!sandbox.approval_expires_at || Date.parse(sandbox.approval_expires_at) <= Date.now())) {
      throw new ConflictException('Masked dataset approval is missing or expired; provisioning is blocked');
    }
    const activeProfile = await this.activeProfile(tenantId, actorUserId, null);
    const profile = this.mapProfile(activeProfile);
    const datasetManifestDigest = this.hash(sandbox.dataset_manifest);
    const key = this.idempotency(input?.idempotency_key);
    const run = await this.startRun({
      tenantId, actorUserId, operation: 'SANDBOX_PROVISION', resourceType: 'SANDBOX',
      resourceId: sandbox.id, resourceKey: sandbox.environment_code, resourceVersion: Number(sandbox.version),
      profile, failurePolicy: SaasPhysicalFailurePolicy.HALT, healthTimeoutSeconds: this.healthTimeout(input),
      artifactDigest: null, datasetManifestDigest,
      idempotencyKey: key,
      requestHash: this.hash({
        operation: 'SANDBOX_PROVISION', tenantId, sandboxId, version: Number(sandbox.version),
        datasetManifestDigest, profileId: profile.id, profileType: profile.profileType,
      }),
      requiredPermission: 'saas.sandboxes.control',
    });
    const sandboxInput: PhysicalSandboxInput = {
      environmentCode: sandbox.environment_code,
      purpose: sandbox.purpose,
      dataMode: sandbox.data_mode,
      datasetManifest: sandbox.dataset_manifest,
      privacyAssessment: sandbox.privacy_assessment,
    };
    return this.executePreparedRun(run, profile, actorUserId, async (adapter, context) => {
      const receipt = await adapter.provisionSandbox(context, sandboxInput, 'fo-physical-' + run.id);
      this.assertProvisioningReceipt(receipt, profile, adapter.providerCode);
      if (!receipt.storageProvisioned || !receipt.datasetMaterialized ||
        receipt.datasetMode !== sandbox.data_mode || receipt.datasetManifestDigest !== datasetManifestDigest) {
        throw new ConflictException('Provider did not prove isolated storage and the exact approved/synthetic dataset manifest');
      }
      await this.appendEvent(tenantId, actorUserId, run.id, 'SUCCEEDED', {
        providerCode: adapter.providerCode,
        providerReference: receipt.providerReference,
        evidenceDigest: receipt.evidenceDigest,
        evidence: {
          topology: receipt.topology, isolationVerified: receipt.isolationVerified,
          storageProvisioned: receipt.storageProvisioned, datasetMaterialized: receipt.datasetMaterialized,
          datasetMode: receipt.datasetMode, datasetManifestDigest: receipt.datasetManifestDigest,
          maskingPolicyVersion: receipt.maskingPolicyVersion ?? null,
        },
      });
      return { status: 'SUCCEEDED' as const, providerCode: adapter.providerCode };
    }, (runId) => ({
      tenantId, actorUserId, runId, resourceId: sandbox.id, resourceVersion: Number(sandbox.version), profile,
    }));
  }

  async provisionDeploymentProfile(
    tenantId: string,
    actorUserId: string,
    profileVersionId: string,
    input: ExecuteSaasPhysicalOperationDto,
  ) {
    this.scope(tenantId, actorUserId, profileVersionId);
    await this.authorize(actorUserId, tenantId, 'saas.deployment_profiles.control');
    const result = await this.database.query<ProfileRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,scope_type,scope_key,factory_id::text AS factory_id,
              version,profile_type,status,deployment_reference,region_code,residency_domain,edge_site_code
       FROM saas_deployment_profile_versions WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
      [tenantId, profileVersionId],
      { tenantId, userId: actorUserId },
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Deployment profile version was not found in this tenant');
    if (Number(row.version) !== input?.expected_version) {
      throw new ConflictException('Deployment profile version changed; reload and retry with the latest expected_version');
    }
    if (!['PLANNED', 'PROVISIONING', 'FAILED'].includes(row.status)) {
      throw new ConflictException('Only a planned, failed or provisioning deployment profile can be physically provisioned');
    }
    if (!this.deploymentProfileService) {
      throw new ServiceUnavailableException('Deployment-profile lifecycle service is not available; physical provisioning is blocked');
    }
    const latestProfileResult = await this.database.query<QueryResultRow & { id: string; version: string | number }>(
      `SELECT id::text AS id,version FROM saas_deployment_profile_versions
       WHERE tenant_id=$1 AND scope_key=$2 ORDER BY version DESC LIMIT 1`,
      [tenantId, row.scope_key],
      { tenantId, userId: actorUserId },
    );
    const latestProfile = latestProfileResult.rows[0];
    if (!latestProfile || latestProfile.id !== row.id || Number(latestProfile.version) !== Number(row.version)) {
      throw new ConflictException('Deployment profile version is stale; provision only the latest lifecycle snapshot');
    }
    const profile = this.mapProfile(row);
    const key = this.idempotency(input?.idempotency_key);
    const requestHash = this.hash({
      operation: 'DEPLOYMENT_PROFILE_PROVISION', tenantId, profileVersionId,
      version: Number(row.version), profileType: row.profile_type, deploymentReference: row.deployment_reference,
      regionCode: row.region_code, residencyDomain: row.residency_domain, edgeSiteCode: row.edge_site_code,
    });
    const run = await this.startRun({
      tenantId, actorUserId, operation: 'DEPLOYMENT_PROFILE_PROVISION', resourceType: 'DEPLOYMENT_PROFILE',
      resourceId: row.id, resourceKey: row.scope_key, resourceVersion: Number(row.version), profile,
      failurePolicy: SaasPhysicalFailurePolicy.HALT, healthTimeoutSeconds: this.healthTimeout(input),
      artifactDigest: null, datasetManifestDigest: null, idempotencyKey: key, requestHash,
      requiredPermission: 'saas.deployment_profiles.control',
    });
    const profileInput: PhysicalDeploymentProfileInput = {
      scopeType: row.scope_type, scopeKey: row.scope_key, factoryId: row.factory_id,
      status: row.status, version: Number(row.version),
    };
    return this.executePreparedRun(run, profile, actorUserId, async (adapter, context) => {
      let provisioningVersion = Number(row.version);
      if (row.status === 'PLANNED' || row.status === 'FAILED') {
        const started = await this.deploymentProfileService!.transition(
          tenantId,
          actorUserId,
          row.scope_type === 'TENANT'
            ? SaasDeploymentProfileScopeType.TENANT
            : SaasDeploymentProfileScopeType.FACTORY,
          row.factory_id ?? undefined,
          {
            action: SaasDeploymentProfileTransitionAction.START_PROVISIONING,
            expected_version: Number(row.version),
            reason: 'Physical Kubernetes provisioner accepted this topology-scoped operation',
            idempotency_key: 'physical-start-' + run.id,
          },
        );
        provisioningVersion = started.profile.version;
      }

      try {
        const receipt = await adapter.provisionDeploymentProfile(context, profileInput, 'fo-physical-' + run.id);
        this.assertProvisioningReceipt(receipt, profile, adapter.providerCode);
        const activated = await this.deploymentProfileService!.transition(
          tenantId,
          actorUserId,
          row.scope_type === 'TENANT'
            ? SaasDeploymentProfileScopeType.TENANT
            : SaasDeploymentProfileScopeType.FACTORY,
          row.factory_id ?? undefined,
          {
            action: SaasDeploymentProfileTransitionAction.ACTIVATE,
            expected_version: provisioningVersion,
            reason: 'Provider returned verified namespace, quota, storage boundary and isolation evidence',
            idempotency_key: 'physical-activate-' + run.id,
          },
        );
        await this.appendEvent(tenantId, actorUserId, run.id, 'SUCCEEDED', {
          providerCode: adapter.providerCode, providerReference: receipt.providerReference,
          evidenceDigest: receipt.evidenceDigest,
          evidence: {
            topology: receipt.topology, isolationVerified: receipt.isolationVerified,
            requestedProfileVersion: Number(row.version), provisioningVersion,
            activeProfileVersion: activated.profile.version,
            scopeType: row.scope_type, scopeKey: row.scope_key,
          },
        });
        return { status: 'SUCCEEDED' as const, providerCode: adapter.providerCode };
      } catch (error) {
        await this.deploymentProfileService!.transition(
          tenantId,
          actorUserId,
          row.scope_type === 'TENANT'
            ? SaasDeploymentProfileScopeType.TENANT
            : SaasDeploymentProfileScopeType.FACTORY,
          row.factory_id ?? undefined,
          {
            action: SaasDeploymentProfileTransitionAction.FAIL,
            expected_version: provisioningVersion,
            reason: 'Physical provisioning or verified activation failed; inspect physical run evidence before retry',
            idempotency_key: 'physical-fail-' + run.id,
          },
        ).catch(() => undefined);
        throw error;
      }
    }, (runId) => ({
      tenantId, actorUserId, runId, resourceId: row.id, resourceVersion: Number(row.version), profile,
    }));
  }

  async deployRelease(
    tenantId: string,
    actorUserId: string,
    rolloutKeyInput: string,
    input: ExecuteSaasPhysicalOperationDto,
  ) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.releases.promote');
    const rolloutKey = this.requiredString(rolloutKeyInput, 'rolloutKey', 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9:_-]{0,79}$/.test(rolloutKey)) {
      throw new BadRequestException('rolloutKey format is invalid');
    }
    const key = this.idempotency(input?.idempotency_key);
    const current = await this.loadLatestRelease(tenantId, actorUserId, rolloutKey);
    if (Number(current.version) !== input?.expected_version) {
      throw new ConflictException('Release rollout version changed; reload and retry with the latest expected_version');
    }
    if (current.stage !== 'CANARY' && current.stage !== 'PRODUCTION') {
      throw new ConflictException('Only a canary or production release can be physically deployed');
    }
    const profile = this.mapProfile(await this.activeProfile(tenantId, actorUserId, current.factory_id));
    const failurePolicy = input.failure_policy ?? SaasPhysicalFailurePolicy.HALT;
    if (!Object.values(SaasPhysicalFailurePolicy).includes(failurePolicy)) {
      throw new BadRequestException('failure_policy must be HALT or ROLLBACK');
    }
    // A rollout failure policy must be able to change control-plane state as well
    // as the physical deployment; verify that authority before touching a cluster.
    await this.authorize(
      actorUserId,
      tenantId,
      failurePolicy === SaasPhysicalFailurePolicy.HALT ? 'saas.releases.control' : 'saas.releases.rollback',
    );
    if (!this.releaseRolloutService) {
      throw new ServiceUnavailableException('Release rollout lifecycle service is not available; physical deployment is blocked');
    }
    const healthTimeoutSeconds = this.healthTimeout(input);
    const previous = failurePolicy === SaasPhysicalFailurePolicy.ROLLBACK
      ? await this.previousProductionRelease(tenantId, actorUserId, current)
      : null;
    if (failurePolicy === SaasPhysicalFailurePolicy.ROLLBACK && !previous) {
      throw new ConflictException('ROLLBACK policy requires a previously registered production artifact with the same release scope');
    }
    const currentRelease = this.mapRelease(current);
    const previousRelease = previous ? this.mapRelease(previous) : null;
    const requestHash = this.hash({
      operation: 'RELEASE_DEPLOY', tenantId, rolloutKey, version: Number(current.version),
      artifactDigest: current.artifact_digest, profileId: profile.id, topology: profile.profileType,
      failurePolicy, healthTimeoutSeconds, previousArtifactDigest: previous?.artifact_digest ?? null,
    });
    const run = await this.startRun({
      tenantId, actorUserId, operation: 'RELEASE_DEPLOY', resourceType: 'RELEASE',
      resourceId: current.id, resourceKey: rolloutKey, resourceVersion: Number(current.version),
      profile, failurePolicy, healthTimeoutSeconds, artifactDigest: current.artifact_digest,
      datasetManifestDigest: null, idempotencyKey: key, requestHash,
      requiredPermission: 'saas.releases.promote',
    });
    const contextBase = (runId: string): PhysicalOperationContext => ({
      tenantId, actorUserId, runId, resourceId: current.id, resourceVersion: Number(current.version), profile,
    });
    return this.executePreparedRun(run, profile, actorUserId, async (adapter, context) => {
      const deployed = await adapter.deployRelease(context, currentRelease, 'fo-physical-' + run.id + '-deploy');
      this.assertReleaseReceipt(deployed, currentRelease, profile, adapter.providerCode);
      const health = await adapter.checkReleaseHealth(
        context, deployed.deploymentReference, healthTimeoutSeconds, deployed.artifactDigest,
      );
      this.assertHealthReceipt(health);
      if (health.healthy) {
        await this.appendEvent(tenantId, actorUserId, run.id, 'SUCCEEDED', {
          providerCode: adapter.providerCode, providerReference: deployed.deploymentReference,
          evidenceDigest: health.evidenceDigest,
          evidence: { artifactDigest: deployed.artifactDigest, topology: deployed.topology,
            isolationVerified: deployed.isolationVerified, healthCheck: health, failurePolicy },
        });
        return { status: 'SUCCEEDED' as const, providerCode: adapter.providerCode };
      }

      if (failurePolicy === SaasPhysicalFailurePolicy.HALT) {
        const halted = await adapter.haltRelease(context, deployed.deploymentReference,
          'HEALTH_CHECK_FAILED', 'fo-physical-' + run.id + '-halt');
        if (!halted.halted || !this.isDigest(halted.evidenceDigest)) {
          throw new ServiceUnavailableException('Provider could not prove the failed rollout was halted; manual incident handling is required');
        }
        let controlPlanePaused = false;
        try {
          const paused = await this.releaseRolloutService!.transition(tenantId, actorUserId, rolloutKey, {
            action: SaasReleaseTransitionAction.PAUSE,
            expected_version: Number(current.version),
            reason: 'Physical release health check failed; infrastructure provider confirmed halt',
            idempotency_key: 'physical-halt-' + run.id,
          });
          controlPlanePaused = paused.rollout.stage === 'PAUSED';
        } catch {
          await this.appendEvent(tenantId, actorUserId, run.id, 'HALTED', {
            providerCode: adapter.providerCode, providerReference: deployed.deploymentReference,
            evidenceDigest: halted.evidenceDigest,
            reasonCode: 'CONTROL_PLANE_PAUSE_FAILED',
            evidence: {
              artifactDigest: deployed.artifactDigest, healthCheck: health, failurePolicy, halted: true,
              controlPlanePaused: false,
            },
          });
          throw new ServiceUnavailableException('Infrastructure was halted, but the release could not be paused in the control plane; inspect the run receipt and recover the rollout state');
        }
        if (!controlPlanePaused) {
          await this.appendEvent(tenantId, actorUserId, run.id, 'HALTED', {
            providerCode: adapter.providerCode, providerReference: deployed.deploymentReference,
            evidenceDigest: halted.evidenceDigest, reasonCode: 'CONTROL_PLANE_PAUSE_NOT_CONFIRMED',
            evidence: { artifactDigest: deployed.artifactDigest, healthCheck: health, failurePolicy, halted: true, controlPlanePaused: false },
          });
          throw new ServiceUnavailableException('Infrastructure was halted but the control-plane release state could not be confirmed as PAUSED');
        }
        await this.appendEvent(tenantId, actorUserId, run.id, 'HALTED', {
          providerCode: adapter.providerCode, providerReference: deployed.deploymentReference,
          evidenceDigest: halted.evidenceDigest,
          reasonCode: 'HEALTH_CHECK_FAILED',
          evidence: { artifactDigest: deployed.artifactDigest, healthCheck: health, failurePolicy, halted: true, controlPlanePaused: true },
        });
        return { status: 'HALTED' as const, providerCode: adapter.providerCode };
      }

      if (!previous || !previousRelease) throw new ConflictException('Verified rollback target is missing');
      await this.appendEvent(tenantId, actorUserId, run.id, 'ROLLBACK_IN_PROGRESS', {
        providerCode: adapter.providerCode, providerReference: deployed.deploymentReference,
        evidenceDigest: health.evidenceDigest, reasonCode: 'HEALTH_CHECK_FAILED',
        evidence: { failedArtifactDigest: deployed.artifactDigest, healthCheck: health,
          targetRolloutKey: previousRelease.rolloutKey, targetArtifactDigest: previousRelease.artifactDigest },
      });
      const rollback = await adapter.rollbackRelease(
        context, deployed.deploymentReference, previousRelease, healthTimeoutSeconds,
        'fo-physical-' + run.id + '-rollback',
      );
      this.assertRollbackReceipt(rollback, previousRelease, profile);
      if (!rollback.rolledBack || !rollback.healthy) {
        await this.appendEvent(tenantId, actorUserId, run.id, 'ROLLBACK_FAILED', {
          providerCode: adapter.providerCode, providerReference: rollback.deploymentReference,
          evidenceDigest: rollback.evidenceDigest, reasonCode: 'ROLLBACK_NOT_HEALTHY',
          evidence: { failedArtifactDigest: deployed.artifactDigest, targetArtifactDigest: previousRelease.artifactDigest,
            rolledBack: rollback.rolledBack, healthy: rollback.healthy, healthCheck: health, controlPlaneRollbackApplied: false },
        });
        return { status: 'ROLLBACK_FAILED' as const, providerCode: adapter.providerCode };
      }
      let controlPlaneRollbackVersion: number;
      try {
        const rollbackRequest: RollbackSaasReleaseRolloutDto = {
          expected_version: Number(current.version),
          target_rollout_key: previousRelease.rolloutKey,
          target_version: Number(previous.version),
          reason: 'Physical rollout health check failed; provider restored and verified the prior production artifact',
          idempotency_key: 'physical-rollback-' + run.id,
        };
        const controlPlaneRollback = await this.releaseRolloutService!.rollback(
          tenantId, actorUserId, rolloutKey, rollbackRequest,
        );
        controlPlaneRollbackVersion = controlPlaneRollback.rollout.version;
      } catch {
        await this.appendEvent(tenantId, actorUserId, run.id, 'ROLLBACK_FAILED', {
          providerCode: adapter.providerCode, providerReference: rollback.deploymentReference,
          evidenceDigest: rollback.evidenceDigest, reasonCode: 'CONTROL_PLANE_ROLLBACK_SYNC_FAILED',
          evidence: {
            failedArtifactDigest: deployed.artifactDigest, targetArtifactDigest: previousRelease.artifactDigest,
            targetRolloutKey: previousRelease.rolloutKey, rolledBack: true, healthy: true,
            controlPlaneRollbackApplied: false,
          },
        });
        return { status: 'ROLLBACK_FAILED' as const, providerCode: adapter.providerCode };
      }
      await this.appendEvent(tenantId, actorUserId, run.id, 'ROLLED_BACK', {
        providerCode: adapter.providerCode, providerReference: rollback.deploymentReference,
        evidenceDigest: rollback.evidenceDigest,
        evidence: {
          failedArtifactDigest: deployed.artifactDigest,
          targetRolloutKey: previousRelease.rolloutKey, controlPlaneRolloutVersion: controlPlaneRollbackVersion,
          targetArtifactDigest: previousRelease.artifactDigest,
          rolledBack: true, healthy: true, controlPlaneRollbackApplied: true, healthCheck: health,
        },
      });
      return { status: 'ROLLED_BACK' as const, providerCode: adapter.providerCode };
    }, contextBase);
  }

  async listRuns(tenantId: string, actorUserId: string, limit = 25, offset = 0) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.physical_provisioning.read');
    this.page(limit, offset);
    const result = await this.database.query<PhysicalRunRow>(
      `SELECT ${RUN_COLUMNS}, e.event_status AS latest_status
       FROM saas_physical_provisioning_runs r
       LEFT JOIN LATERAL (
         SELECT event_status FROM saas_physical_provisioning_events
         WHERE tenant_id=r.tenant_id AND run_id=r.id ORDER BY event_version DESC LIMIT 1
       ) e ON TRUE
       WHERE r.tenant_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT $2 OFFSET $3`,
      [tenantId, limit + 1, offset], { tenantId, userId: actorUserId },
    );
    const rows = result.rows.slice(0, limit);
    return {
      limit, offset, resultCount: rows.length, hasMore: result.rows.length > limit,
      nextOffset: result.rows.length > limit ? offset + rows.length : null,
      runs: rows.map((row) => ({ ...this.mapRun(row), status: row.latest_status ?? 'REQUESTED' })),
    };
  }

  async getRun(tenantId: string, actorUserId: string, runId: string) {
    this.scope(tenantId, actorUserId, runId);
    await this.authorize(actorUserId, tenantId, 'saas.physical_provisioning.read');
    return this.loadRunView(tenantId, actorUserId, runId);
  }

  private async executePreparedRun(
    run: { id: string; replayed: boolean; status: PhysicalRunStatus | null },
    profile: PhysicalDeploymentProfile,
    actorUserId: string,
    action: (adapter: PhysicalInfrastructureAdapter, context: PhysicalOperationContext) => Promise<{ status: PhysicalRunStatus; providerCode: string }>,
    contextFactory: (runId: string) => PhysicalOperationContext,
  ) {
    const context = contextFactory(run.id);
    if (run.replayed) {
      if (run.status === 'REQUESTED' || run.status === 'IN_PROGRESS' || run.status === 'ROLLBACK_IN_PROGRESS' || !run.status) {
        throw new ConflictException('A physical operation with this idempotency key is still in progress; inspect its immutable run evidence before retrying');
      }
      return this.loadRunViewForActor(run.id, actorUserId, true, context.tenantId);
    }

    // The adapter is selected only from deployment-controlled registrations.
    // No adapter means no simulated success and no call to an untrusted URL.
    const adapter = this.adapters.find((candidate) => {
      try {
        return candidate.supports(profile);
      } catch {
        return false;
      }
    });
    if (!adapter) {
      await this.appendEventFromRun(run.id, actorUserId, 'FAILED', {
        reasonCode: 'NO_APPROVED_PHYSICAL_ADAPTER',
        evidence: { topology: profile.profileType, adapterCount: this.adapters.length },
      }, context.tenantId);
      await this.auditRun(run.id, context.tenantId, actorUserId, 'PHYSICAL_OPERATION_BLOCKED', {
        status: 'FAILED', reasonCode: 'NO_APPROVED_PHYSICAL_ADAPTER', topology: profile.profileType,
      });
      throw new ServiceUnavailableException('No approved physical infrastructure adapter is registered for the selected topology; provisioning/deployment failed closed');
    }

    await this.appendEventFromRun(run.id, actorUserId, 'IN_PROGRESS', {
      providerCode: adapter.providerCode,
      evidence: { topology: profile.profileType, phase: 'PROVIDER_OPERATION_STARTED' },
    }, context.tenantId);
    try {
      const outcome = await action(adapter, context);
      await this.auditRun(run.id, context.tenantId, actorUserId, 'PHYSICAL_OPERATION_' + outcome.status, {
        status: outcome.status, providerCode: adapter.providerCode, topology: profile.profileType,
      });
      return this.loadRunViewForActor(run.id, actorUserId, true, context.tenantId);
    } catch (error) {
      const latest = await this.latestRunStatus(run.id, context.tenantId, actorUserId);
      if (latest === 'IN_PROGRESS') {
        await this.appendEventFromRun(run.id, actorUserId, 'FAILED', {
          reasonCode: this.safeErrorCode(error),
          evidence: { topology: profile.profileType, failurePolicy: 'FAIL_CLOSED' },
        }, context.tenantId).catch(() => undefined);
      } else if (latest === 'ROLLBACK_IN_PROGRESS') {
        await this.appendEventFromRun(run.id, actorUserId, 'ROLLBACK_FAILED', {
          reasonCode: this.safeErrorCode(error),
          evidence: { topology: profile.profileType, recoveryRequired: true },
        }, context.tenantId).catch(() => undefined);
      }
      await this.auditRun(run.id, context.tenantId, actorUserId, 'PHYSICAL_OPERATION_ERROR', {
        status: latest === 'ROLLBACK_IN_PROGRESS' ? 'ROLLBACK_FAILED' : 'FAILED',
        reasonCode: this.safeErrorCode(error), topology: profile.profileType,
      });
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException('Physical provider operation failed or has an unknown outcome; inspect the immutable run evidence and recover the provider state before retrying');
    }
  }

  private async startRun(input: {
    tenantId: string; actorUserId: string; operation: PhysicalOperation; resourceType: PhysicalResourceType;
    resourceId: string; resourceKey: string; resourceVersion: number; profile: PhysicalDeploymentProfile;
    failurePolicy: SaasPhysicalFailurePolicy; healthTimeoutSeconds: number; artifactDigest: string | null;
    datasetManifestDigest: string | null; idempotencyKey: string; requestHash: string; requiredPermission: string;
  }) {
    const result = await this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'saas-physical:' + input.tenantId + ':' + input.idempotencyKey,
      ]);
      const previous = await client.query<QueryResultRow & { id: string; request_hash: string; event_status: PhysicalRunStatus | null }>(
        `SELECT r.id::text AS id,r.request_hash,
           (SELECT event_status FROM saas_physical_provisioning_events e
            WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id ORDER BY event_version DESC LIMIT 1) AS event_status
         FROM saas_physical_provisioning_runs r
         WHERE r.tenant_id=$1 AND r.idempotency_key=$2 LIMIT 1`,
        [input.tenantId, input.idempotencyKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== input.requestHash) {
          throw new ConflictException('Physical-operation idempotency key was reused for different content');
        }
        return {
          id: previous.rows[0].id,
          replayed: true,
          status: previous.rows[0].event_status,
        };
      }
      const inserted = await client.query<QueryResultRow & { id: string }>(
        `INSERT INTO saas_physical_provisioning_runs
          (tenant_id,operation,resource_type,resource_id,resource_key,resource_version,topology,
           deployment_reference,failure_policy,health_timeout_seconds,artifact_digest,dataset_manifest_digest,
           idempotency_key,request_hash,actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id::text AS id`,
        [input.tenantId, input.operation, input.resourceType, input.resourceId, input.resourceKey,
          input.resourceVersion, input.profile.profileType, input.profile.deploymentReference,
          input.failurePolicy, input.healthTimeoutSeconds, input.artifactDigest, input.datasetManifestDigest,
          input.idempotencyKey, input.requestHash, input.actorUserId],
      );
      const runId = inserted.rows[0]?.id;
      if (!runId) throw new Error('PHYSICAL_PROVISIONING_RUN_INSERT_FAILED');
      await client.query(
        `INSERT INTO saas_physical_provisioning_events
          (tenant_id,run_id,event_version,event_status,reason_code,evidence,actor_user_id,idempotency_key)
         VALUES ($1,$2,1,'REQUESTED',NULL,$3::jsonb,$4,$5)`,
        [input.tenantId, runId, JSON.stringify({
          operation: input.operation, resourceType: input.resourceType, resourceKey: input.resourceKey,
          resourceVersion: input.resourceVersion, topology: input.profile.profileType,
          artifactDigest: input.artifactDigest, datasetManifestDigest: input.datasetManifestDigest,
        }), input.actorUserId, 'physical:' + runId + ':REQUESTED'],
      );
      return { id: runId, replayed: false, status: 'REQUESTED' as const };
    }, { tenantId: input.tenantId, userId: input.actorUserId, isolationLevel: 'SERIALIZABLE' });
    return result;
  }

  private async activeProfile(tenantId: string, actorUserId: string, factoryId: string | null): Promise<ProfileRow> {
    const result = await this.database.query<ProfileRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,scope_type,scope_key,factory_id::text AS factory_id,
              version,profile_type,status,deployment_reference,region_code,residency_domain,edge_site_code
       FROM saas_deployment_profile_versions
       WHERE tenant_id=$1 AND status='ACTIVE'
         AND (scope_type='TENANT' OR (scope_type='FACTORY' AND factory_id=$2::uuid))
       ORDER BY CASE WHEN scope_type='FACTORY' THEN 0 ELSE 1 END,version DESC LIMIT 1`,
      [tenantId, factoryId],
      { tenantId, userId: actorUserId },
    );
    if (!result.rows[0]) {
      throw new ConflictException('No active tenant/factory deployment profile exists; physical provisioning is blocked until a topology is explicitly approved');
    }
    return result.rows[0];
  }

  private async loadLatestRelease(tenantId: string, actorUserId: string, rolloutKey: string): Promise<ReleaseRow> {
    const result = await this.database.query<ReleaseRow>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,rollout_key,version,scope_type,
              factory_id::text AS factory_id,module_key,agent_key,release_channel,stage,
              artifact_version,artifact_digest,rollout_percentage
       FROM saas_release_rollouts WHERE tenant_id=$1 AND rollout_key=$2
       ORDER BY version DESC LIMIT 1`,
      [tenantId, rolloutKey],
      { tenantId, userId: actorUserId },
    );
    if (!result.rows[0]) throw new NotFoundException('Release rollout was not found in this tenant');
    return result.rows[0];
  }

  private async previousProductionRelease(tenantId: string, actorUserId: string, current: ReleaseRow) {
    const result = await this.database.query<ReleaseRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (rollout_key) *
         FROM saas_release_rollouts WHERE tenant_id=$1
         ORDER BY rollout_key,version DESC
       )
       SELECT id::text AS id,tenant_id::text AS tenant_id,rollout_key,version,scope_type,
              factory_id::text AS factory_id,module_key,agent_key,release_channel,stage,
              artifact_version,artifact_digest,rollout_percentage
       FROM latest
       WHERE rollout_key<>$2 AND stage='PRODUCTION' AND scope_type=$3
         AND factory_id IS NOT DISTINCT FROM $4::uuid
         AND module_key IS NOT DISTINCT FROM $5::text
         AND agent_key IS NOT DISTINCT FROM $6::text
         AND release_channel=$7
         AND EXISTS (
           SELECT 1 FROM saas_physical_provisioning_runs pr
           WHERE pr.tenant_id=$1 AND pr.operation='RELEASE_DEPLOY'
             AND pr.resource_id=latest.id AND pr.resource_key=latest.rollout_key
             AND pr.resource_version=latest.version AND pr.artifact_digest=latest.artifact_digest
             AND pr.id=(
               SELECT newest.id FROM saas_physical_provisioning_runs newest
               WHERE newest.tenant_id=$1 AND newest.operation='RELEASE_DEPLOY'
                 AND newest.resource_key=latest.rollout_key AND newest.resource_version=latest.version
               ORDER BY newest.created_at DESC,newest.id DESC LIMIT 1
             )
             AND (
               SELECT ev.event_status FROM saas_physical_provisioning_events ev
               WHERE ev.tenant_id=pr.tenant_id AND ev.run_id=pr.id
               ORDER BY ev.event_version DESC LIMIT 1
             )='SUCCEEDED'
         )
       ORDER BY rollout_key DESC LIMIT 1`,
      [tenantId, current.rollout_key, current.scope_type, current.factory_id,
        current.module_key, current.agent_key, current.release_channel],
      { tenantId, userId: actorUserId },
    );
    return result.rows[0] ?? null;
  }

  private mapProfile(row: ProfileRow): PhysicalDeploymentProfile {
    return {
      id: row.id, profileType: row.profile_type, deploymentReference: row.deployment_reference,
      regionCode: row.region_code, residencyDomain: row.residency_domain, edgeSiteCode: row.edge_site_code,
    };
  }

  private mapRelease(row: ReleaseRow): PhysicalReleaseInput {
    return {
      rolloutKey: row.rollout_key, scopeType: row.scope_type, factoryId: row.factory_id,
      moduleKey: row.module_key, agentKey: row.agent_key, releaseChannel: row.release_channel,
      stage: row.stage as 'CANARY' | 'PRODUCTION', rolloutPercentage: Number(row.rollout_percentage),
      artifactVersion: row.artifact_version, artifactDigest: row.artifact_digest,
    };
  }

  private assertProvisioningReceipt(receipt: PhysicalProvisioningReceipt, profile: PhysicalDeploymentProfile, providerCode: string) {
    if (!this.providerCodeValid(providerCode) || !receipt || receipt.topology !== profile.profileType ||
      !receipt.isolationVerified || !this.providerReferenceValid(receipt.providerReference) ||
      !this.isDigest(receipt.evidenceDigest)) {
      throw new ConflictException('Physical provider did not return verifiable topology/isolation evidence');
    }
  }

  private assertReleaseReceipt(
    receipt: PhysicalReleaseDeploymentReceipt,
    release: PhysicalReleaseInput,
    profile: PhysicalDeploymentProfile,
    providerCode: string,
  ) {
    this.assertProvisioningReceipt(receipt, profile, providerCode);
    if (receipt.artifactDigest !== release.artifactDigest ||
      !this.providerReferenceValid(receipt.deploymentReference) ||
      receipt.deploymentReference !== receipt.providerReference) {
      throw new ConflictException('Physical provider deployed a different artifact or returned an invalid deployment reference');
    }
  }

  private assertHealthReceipt(receipt: PhysicalHealthCheckReceipt) {
    if (!receipt || typeof receipt.healthy !== 'boolean' || !this.isDigest(receipt.evidenceDigest) ||
      typeof receipt.checkedAt !== 'string' || Number.isNaN(Date.parse(receipt.checkedAt))) {
      throw new ConflictException('Provider health-check evidence is missing or invalid');
    }
  }

  private assertRollbackReceipt(
    receipt: PhysicalRollbackReceipt,
    target: PhysicalReleaseInput,
    profile: PhysicalDeploymentProfile,
  ) {
    if (!receipt || !this.providerReferenceValid(receipt.deploymentReference) ||
      receipt.topology !== profile.profileType || receipt.artifactDigest !== target.artifactDigest ||
      !this.isDigest(receipt.evidenceDigest) || typeof receipt.rolledBack !== 'boolean' ||
      typeof receipt.healthy !== 'boolean') {
      throw new ConflictException('Provider rollback receipt did not match the pinned target artifact/topology');
    }
  }

  private async appendEvent(
    tenantId: string,
    actorUserId: string,
    runId: string,
    status: PhysicalRunStatus,
    input: {
      providerCode?: string | null; providerReference?: string | null; evidenceDigest?: string | null;
      reasonCode?: string | null; evidence?: Record<string, unknown>;
    },
  ) {
    await this.appendEventFromRun(runId, actorUserId, status, input, tenantId);
  }

  private async appendEventFromRun(
    runId: string,
    actorUserId: string,
    status: PhysicalRunStatus,
    input: {
      providerCode?: string | null; providerReference?: string | null; evidenceDigest?: string | null;
      reasonCode?: string | null; evidence?: Record<string, unknown>;
    },
    tenantId: string,
  ) {
    await this.database.transaction(async (client) => {
      await client.query('SELECT id FROM saas_physical_provisioning_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, runId]);
      const latest = await client.query<QueryResultRow & { event_version: number | string }>(
        'SELECT event_version FROM saas_physical_provisioning_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY event_version DESC LIMIT 1',
        [tenantId, runId],
      );
      const eventVersion = Number(latest.rows[0]?.event_version ?? 0) + 1;
      await client.query(
        `INSERT INTO saas_physical_provisioning_events
          (tenant_id,run_id,event_version,event_status,provider_code,provider_reference,evidence_digest,
           reason_code,evidence,actor_user_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [tenantId, runId, eventVersion, status, input.providerCode ?? null, input.providerReference ?? null,
          input.evidenceDigest ?? null, input.reasonCode ?? null, JSON.stringify(input.evidence ?? {}),
          actorUserId, 'physical:' + runId + ':' + status],
      );
    }, { tenantId, userId: actorUserId, isolationLevel: 'SERIALIZABLE' });
  }

  private async latestRunStatus(runId: string, tenantId: string, actorUserId: string): Promise<PhysicalRunStatus | null> {
    const result = await this.database.query<QueryResultRow & { event_status: PhysicalRunStatus }>(
      'SELECT event_status FROM saas_physical_provisioning_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY event_version DESC LIMIT 1',
      [tenantId, runId], { tenantId, userId: actorUserId },
    );
    return result.rows[0]?.event_status ?? null;
  }

  private async loadRunViewForActor(runId: string, actorUserId: string, idempotent: boolean, tenantId: string) {
    const runResult = await this.database.query<PhysicalRunRow>(
      'SELECT ' + RUN_COLUMNS + ' FROM saas_physical_provisioning_runs WHERE tenant_id=$1 AND id=$2 LIMIT 1',
      [tenantId, runId], { tenantId, userId: actorUserId },
    );
    const row = runResult.rows[0];
    if (!row) throw new NotFoundException('Physical provisioning run was not found');
    return this.loadRunView(row.tenant_id, actorUserId, runId, idempotent);
  }

  private async loadRunView(tenantId: string, actorUserId: string, runId: string, idempotent = false) {
    const runResult = await this.database.query<PhysicalRunRow>(
      'SELECT ' + RUN_COLUMNS + ' FROM saas_physical_provisioning_runs WHERE tenant_id=$1 AND id=$2 LIMIT 1',
      [tenantId, runId], { tenantId, userId: actorUserId },
    );
    const run = runResult.rows[0];
    if (!run) throw new NotFoundException('Physical provisioning run was not found in this tenant');
    const events = await this.database.query<PhysicalEventRow>(
      'SELECT ' + EVENT_COLUMNS + ' FROM saas_physical_provisioning_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY event_version',
      [tenantId, runId], { tenantId, userId: actorUserId },
    );
    const last = events.rows[events.rows.length - 1];
    return {
      idempotent,
      run: { ...this.mapRun(run), status: last?.event_status ?? 'REQUESTED' },
      events: events.rows.map((event) => ({
        version: Number(event.event_version), status: event.event_status, providerCode: event.provider_code,
        providerReference: event.provider_reference, evidenceDigest: event.evidence_digest,
        reasonCode: event.reason_code, evidence: event.evidence, actorUserId: event.actor_user_id,
        createdAt: event.created_at,
      })),
    };
  }

  private mapRun(row: PhysicalRunRow) {
    return {
      id: row.id, operation: row.operation, resourceType: row.resource_type, resourceId: row.resource_id,
      resourceKey: row.resource_key, resourceVersion: Number(row.resource_version), topology: row.topology,
      deploymentReference: row.deployment_reference, failurePolicy: row.failure_policy,
      healthTimeoutSeconds: Number(row.health_timeout_seconds), artifactDigest: row.artifact_digest,
      datasetManifestDigest: row.dataset_manifest_digest, idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash, createdAt: row.created_at,
    };
  }

  private async auditRun(runId: string, tenantId: string, actorUserId: string, action: string, payload: Record<string, unknown>) {
    try {
      const run = await this.database.query<QueryResultRow & { tenant_id: string; resource_id: string; resource_type: string }>(
        'SELECT tenant_id::text AS tenant_id,resource_id::text AS resource_id,resource_type FROM saas_physical_provisioning_runs WHERE tenant_id=$1 AND id=$2 LIMIT 1',
        [tenantId, runId], { tenantId, userId: actorUserId },
      );
      if (!run.rows[0]) return;
      await this.auditService.record({
        tenantId: run.rows[0].tenant_id,
        factoryId: null,
        actorUserId,
        eventType: 'SAAS_PHYSICAL_INFRASTRUCTURE',
        action,
        resourceType: 'SAAS_PHYSICAL_PROVISIONING_RUN',
        resourceId: runId,
        dataClass: 'INTERNAL',
        payload: { resourceType: run.rows[0].resource_type, resourceId: run.rows[0].resource_id, ...payload },
      });
    } catch {
      // The append-only run/event ledger is the durable recovery evidence when audit delivery is unavailable.
    }
  }

  private async authorize(actorUserId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(actorUserId, tenantId, permission);
  }

  private scope(tenantId: string, actorUserId: string, ...ids: string[]) {
    if (!isUUID(tenantId) || !isUUID(actorUserId) || ids.some((id) => !isUUID(id))) {
      throw new BadRequestException('Authenticated tenant, user and resource UUIDs are required');
    }
  }

  private requiredString(value: unknown, field: string, max: number) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.normalize('NFC').trim();
    if (!normalized || normalized.length > max) throw new BadRequestException(field + ' must contain 1-' + max + ' characters');
    return normalized;
  }

  private idempotency(value: unknown) {
    const normalized = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
      throw new BadRequestException('idempotency_key format is invalid');
    }
    return normalized;
  }

  private healthTimeout(input: ExecuteSaasPhysicalOperationDto) {
    const seconds = input?.health_timeout_seconds ?? 60;
    if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 300) {
      throw new BadRequestException('health_timeout_seconds must be an integer from 5 to 300');
    }
    return seconds;
  }

  private page(limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new BadRequestException('limit must be 1-100 and offset must be 0-10000');
    }
  }

  private providerCodeValid(providerCode: unknown) {
    return typeof providerCode === 'string' && /^[a-z][a-z0-9._:-]{0,59}$/.test(providerCode);
  }

  private providerReferenceValid(value: unknown) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 255 &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/.test(value) && !value.includes('://');
  }

  private isDigest(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  private safeErrorCode(error: unknown): string {
    const providerCode = error !== null && typeof error === 'object'
      ? (error as { providerCode?: unknown }).providerCode
      : undefined;
    const errorCode = error !== null && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
    const candidate = typeof providerCode === 'string' ? providerCode
      : typeof errorCode === 'string' ? errorCode
        : error instanceof Error ? error.name : 'PROVIDER_ERROR';
    return /^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(candidate) ? candidate.toUpperCase() : 'PROVIDER_ERROR';
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(this.canonicalize(value)), 'utf8').digest('hex');
  }

  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonicalize(item));
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, this.canonicalize(record[key])]));
    }
    return value;
  }
}
