import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException,
  Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { PropagateSaasTenantErasureDto } from './dto/propagate-saas-tenant-erasure.dto';
import { RegisterSaasExternalDataTargetDto } from './dto/register-saas-external-data-target.dto';
import { ReviewSaasExternalDataTargetDto } from './dto/review-saas-external-data-target.dto';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { REQUIRED_EXTERNAL_STORE_KINDS, SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS } from './saas-tenant-propagation.adapters';
import type {
  SaasExternalManifestKind, SaasExternalPropagationContext, SaasExternalPropagationOutcome,
  SaasExternalPropagationPlan, SaasExternalPropagationPreflight,
  SaasTenantExternalDataPropagationAdapter, SaasTenantExternalDataTarget,
} from './saas-tenant-propagation.adapters';

type ErasureRequestRow = QueryResultRow & {
  tenant_id: string; request_id: string; version: string | number; row_version: string | number; status: string;
  categories: SaasTransferDatasetCategory[] | string; export_transfer_id: string;
  export_transfer_version: string | number; export_bundle_digest: string; requested_by_user_id: string;
  reviewed_by_user_id: string | null; execution_started_by_user_id: string | null;
  execution_run_id: string | null; execution_manifest_digest: string | null;
};
type TransferRow = QueryResultRow & { source_manifest: Record<string, unknown> | string; source_bundle_digest: string; actor_user_id: string };
type TargetRow = QueryResultRow & {
  id: string; target_id: string; tenant_id: string; store_kind: SaasTenantExternalDataTarget['storeKind'];
  adapter_key: string; config_reference: string; registration_reason: string;
  categories: SaasTransferDatasetCategory[] | string; required: boolean; status: string;
  registered_by_user_id: string; reviewed_by_user_id: string | null; reviewed_at: string | null;
  review_reason: string | null; created_at: string; updated_at: string;
};
type PropagationRunRow = QueryResultRow & {
  run_id: string; request_hash: string; status: 'RUNNING' | 'PARTIAL' | 'FAILED' | 'VERIFIED';
  external_manifest: Record<string, unknown> | string; manifest_digest: string | null; target_count: number;
  verified_targets: number; planned_copies: string | number; deleted_copies: string | number;
  residual_copies: string | number; failure_code: string | null;
};
type PropagationReceiptRow = QueryResultRow & {
  target_id: string; store_kind: SaasTenantExternalDataTarget['storeKind']; attempt_no: number;
  status: 'VERIFIED' | 'RESIDUALS' | 'FAILED'; planned_copies: string | number; deleted_copies: string | number;
  residual_copies: string | number; manifest_digest: string; verified_manifest_digest: string | null;
  verification_reference: string | null; provider_receipt_reference: string | null;
  residual_manifest: unknown[] | string; failure_code: string | null;
  outcome_code: SaasExternalPropagationOutcome;
  manifest_kind: SaasExternalManifestKind;
  resource_class: string;
  adapter_version: string | null;
  max_page_size: number | null;
  max_batch_size: number | null;
  policy_versions: Record<string, number> | string;
  residual_reason: string | null;
  completed_at: string;
};

class ExternalPropagationDispositionError extends Error {
  constructor(
    readonly outcome: 'BLOCKED' | 'RETAINED',
    readonly reason: string,
    readonly code: string,
  ) {
    super(reason);
    this.name = 'ExternalPropagationDispositionError';
  }
}

const CATEGORY_VALUES = Object.values(SaasTransferDatasetCategory);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

@Injectable()
export class SaasTenantPropagationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    @Optional() @Inject(SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS)
    private readonly adapters: SaasTenantExternalDataPropagationAdapter[] = [],
  ) {}

  async registerTarget(tenantValue: string, actorValue: string, input: RegisterSaasExternalDataTargetDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const targetId = this.requiredString(input?.target_id, 'target_id', 100, 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(targetId)) throw new BadRequestException('target_id has invalid characters');
    if (!REQUIRED_EXTERNAL_STORE_KINDS.includes(input?.store_kind)) throw new BadRequestException('store_kind is invalid');
    const adapterKey = this.requiredString(input?.adapter_key, 'adapter_key', 100, 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(adapterKey)) throw new BadRequestException('adapter_key has invalid characters');
    const configReference = this.reference(input?.config_reference, 'config_reference');
    const categories = this.parseCategories(input?.categories);
    const required = input?.required !== false;
    const registrationReason = this.requiredString(input?.registration_reason, 'registration_reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'EXTERNAL_TARGET_REGISTER', targetId, storeKind: input.store_kind,
      adapterKey, configReference, categories: [...categories].sort(), required, registrationReason });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<TargetRow>(
        'SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for another target registration');
        return { row: replay.rows[0], replayed: true };
      }
      const inserted = await client.query<TargetRow>(
        `INSERT INTO saas_tenant_external_data_targets
         (tenant_id,target_id,store_kind,adapter_key,config_reference,registration_reason,categories,required,
          registered_by_user_id,idempotency_key,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING *`,
        [tenantId, targetId, input.store_kind, adapterKey, configReference, registrationReason,
          JSON.stringify([...categories].sort()), required, actorUserId, idempotencyKey, requestHash],
      );
      await this.audit(client, tenantId, actorUserId, 'EXTERNAL_PROPAGATION_TARGET_REGISTERED', inserted.rows[0].id, {
        targetId, storeKind: input.store_kind, adapterKey, categories: [...categories].sort(), required, status: 'PENDING',
      });
      return { row: inserted.rows[0], replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-external-target:' + tenantId + ':' + targetId });
    return { target: this.mapTargetAdmin(result.row), replayed: result.replayed };
  }

  async reviewTarget(tenantValue: string, actorValue: string, targetValue: string, input: ReviewSaasExternalDataTargetDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    const targetId = this.requiredString(targetValue, 'targetId', 100, 1);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const expectedStatus = input?.expected_status;
    const decision = input?.decision;
    const nextStatus = decision === 'APPROVE' ? 'ACTIVE'
      : decision === 'REJECT' ? 'REJECTED'
      : decision === 'PAUSE' ? 'PAUSED'
      : decision === 'RESUME' ? 'ACTIVE' : null;
    const validPair = decision === 'APPROVE' && expectedStatus === 'PENDING'
      || decision === 'REJECT' && expectedStatus === 'PENDING'
      || decision === 'PAUSE' && expectedStatus === 'ACTIVE'
      || decision === 'RESUME' && expectedStatus === 'PAUSED';
    if (!nextStatus || !validPair) throw new BadRequestException('decision and expected_status do not form a supported target lifecycle transition');

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<TargetRow>(
        'SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 AND target_id=$2 FOR UPDATE',
        [tenantId, targetId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('External data target not found');
      if (current.status !== expectedStatus) throw new ConflictException('External target status changed; reload before reviewing');
      if (current.registered_by_user_id === actorUserId) throw new ConflictException('Target registration and review require different actors');
      const updated = await client.query<TargetRow>(
        `UPDATE saas_tenant_external_data_targets
         SET status=$3,reviewed_by_user_id=$4,reviewed_at=clock_timestamp(),review_reason=$5,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND target_id=$2 AND status=$6 RETURNING *`,
        [tenantId, targetId, nextStatus, actorUserId, reason, expectedStatus],
      );
      if (!updated.rows[0]) throw new ConflictException('External target changed during review');
      await this.audit(client, tenantId, actorUserId, 'EXTERNAL_PROPAGATION_TARGET_' + decision, updated.rows[0].id, {
        targetId, previousStatus: expectedStatus, status: nextStatus, reason,
      });
      return updated.rows[0];
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-external-target-review:' + tenantId + ':' + targetId });
    return { target: this.mapTargetAdmin(result) };
  }

  async listTargets(tenantValue: string, actorValue: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const result = await this.database.query<TargetRow>(
      'SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 ORDER BY store_kind,target_id',
      [tenantId], { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapTargetAdmin(row)), count: result.rows.length };
  }

  async propagateErasure(tenantValue: string, actorValue: string, requestValue: string, input: PropagateSaasTenantErasureDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    const requestId = this.uuid(requestValue, 'requestId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.propagate');
    const expectedVersion = this.integer(input?.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'EXTERNAL_ERASURE_PROPAGATION', tenantId, requestId, expectedVersion, reason });

    const prepared = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const requestResult = await client.query<ErasureRequestRow>(
        'SELECT * FROM saas_tenant_data_erasure_requests WHERE tenant_id=$1 AND request_id=$2 AND version=1 FOR UPDATE',
        [tenantId, requestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw new NotFoundException('Tenant erasure request not found');

      const priorRunResult = await client.query<PropagationRunRow>(
        'SELECT * FROM saas_tenant_external_propagation_runs WHERE tenant_id=$1 AND request_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [tenantId, requestId, idempotencyKey],
      );
      let run = priorRunResult.rows[0];
      if (run && run.request_hash !== requestHash) {
        throw new ConflictException('Idempotency-Key was used for another external propagation request');
      }
      if (run?.status === 'VERIFIED') {
        return { replayed: true, request, run, targets: [] as SaasTenantExternalDataTarget[], latestReceipts: [] as PropagationReceiptRow[] };
      }
      if (request.status !== 'PROPAGATION_PENDING') {
        if (request.status === 'VERIFIED') throw new ConflictException('Tenant erasure has already been externally verified');
        throw new ConflictException('PostgreSQL erasure must complete before external propagation');
      }
      if (Number(request.row_version) !== expectedVersion) {
        throw new ConflictException('Erasure request version is stale; reload its current version');
      }
      if (!request.reviewed_by_user_id || !request.execution_started_by_user_id
        || actorUserId === request.requested_by_user_id
        || actorUserId === request.reviewed_by_user_id
        || actorUserId === request.execution_started_by_user_id) {
        throw new ConflictException('External propagation requires an independent actor distinct from requester, reviewer and PostgreSQL executor');
      }

      const categories = this.parseCategories(request.categories);
      const transferResult = await client.query<TransferRow>(
        `SELECT t.source_manifest, t.source_bundle_digest, t.actor_user_id
         FROM saas_tenant_data_transfers t
         WHERE t.tenant_id=$1 AND t.transfer_id=$2 AND t.version=$3
           AND t.operation_type='EXPORT' AND t.status='COMPLETED' AND t.source_bundle_digest=$4
         FOR SHARE`,
        [tenantId, request.export_transfer_id, Number(request.export_transfer_version), request.export_bundle_digest],
      );
      const transfer = transferResult.rows[0];
      if (!transfer || transfer.source_bundle_digest !== request.export_bundle_digest) {
        throw new ConflictException('Exact completed source export is no longer available');
      }
      const attestationResult = await client.query<{ verified_by_user_id: string }>(
        `SELECT verified_by_user_id FROM saas_tenant_data_export_preservation_attestations
         WHERE tenant_id=$1 AND transfer_id=$2 AND transfer_version=$3 AND bundle_digest=$4
         ORDER BY verified_at DESC FOR SHARE`,
        [tenantId, request.export_transfer_id, Number(request.export_transfer_version), request.export_bundle_digest],
      );
      if (!attestationResult.rows.some((row) =>
        row.verified_by_user_id !== request.requested_by_user_id
        && row.verified_by_user_id !== actorUserId
        && row.verified_by_user_id !== request.reviewed_by_user_id)) {
        throw new ConflictException('Independent preservation attestation must remain available and be separate from the propagation actor');
      }
      const holdResult = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
        "SELECT categories FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND status='ACTIVE' FOR SHARE",
        [tenantId],
      );
      // Record the hold disposition rather than aborting before a durable run/receipt exists.
      // The per-target loop below will emit RETAINED evidence and will not call providers.
      const activeLegalHoldCategories = [...new Set(holdResult.rows
        .flatMap((hold) => this.parseCategories(hold.categories))
        .filter((category) => categories.includes(category)))];

      const targetResult = await client.query<TargetRow>(
        `SELECT * FROM saas_tenant_external_data_targets
         WHERE tenant_id=$1 AND required=true AND status='ACTIVE'
         ORDER BY store_kind,target_id FOR SHARE`,
        [tenantId],
      );
      const targets = targetResult.rows.map((row) => this.mapTarget(row))
        .filter((target) => target.categories.some((category) => categories.includes(category)));
      this.assertTargetCoverage(categories, targets);

      // Pin the latest explicit DELETE retention-policy version for every requested
      // category. Missing policies and REVIEW/ANONYMIZE policies do not authorize
      // a provider-side delete operation.
      const policyResult = await client.query<{
        category_code: string; version: string | number; disposition: string;
      }>(
        `SELECT DISTINCT ON (category_code) category_code, version, disposition
         FROM saas_tenant_data_retention_policies
         WHERE tenant_id=$1 AND category_code = ANY($2::varchar[])
         ORDER BY category_code,version DESC`,
        [tenantId, categories],
      );
      const policyByCategory = new Map(policyResult.rows.map((row) => [row.category_code, row]));
      const policyVersions: Record<string, number> = {};
      const heldCategorySet = new Set(activeLegalHoldCategories);
      for (const category of categories) {
        const policy = policyByCategory.get(category);
        if (!policy && !heldCategorySet.has(category)) {
          throw new ConflictException('A current DELETE retention policy is required for each requested erasure category');
        }
        if (policy && !heldCategorySet.has(category) && policy.disposition !== 'DELETE') {
          throw new ConflictException('A current DELETE retention policy is required for each requested erasure category');
        }
        if (policy) {
          const version = Number(policy.version);
          if (!Number.isSafeInteger(version) || version < 1) {
            throw new ConflictException('A requested retention policy has an invalid version');
          }
          policyVersions[category] = version;
        }
      }

      const sourceManifest = this.jsonObject(transfer.source_manifest);
      if (!run) {
        const runId = randomUUID();
        const externalManifest = {
          version: 1, requestId, requestVersion: Number(request.version),
          sourceExportDigest: request.export_bundle_digest,
          sourceManifestDigest: this.hash(sourceManifest), sourceManifest,
          policyVersions: this.parsePolicyVersions(policyVersions),
          activeLegalHoldCategories,
          targetIds: targets.map((target) => target.targetId).sort(), plans: {},
        };
        const inserted = await client.query<PropagationRunRow>(
          `INSERT INTO saas_tenant_external_propagation_runs
           (tenant_id,run_id,request_id,request_version,status,categories,source_export_digest,
            external_manifest,target_count,reason,idempotency_key,request_hash,executor_user_id)
           VALUES ($1,$2,$3,$4,'RUNNING',$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12) RETURNING *`,
          [tenantId, runId, requestId, Number(request.version), JSON.stringify(categories),
            request.export_bundle_digest, JSON.stringify(externalManifest), targets.length,
            reason, idempotencyKey, requestHash, actorUserId],
        );
        run = inserted.rows[0];
      } else if (run.status === 'PARTIAL' || run.status === 'FAILED') {
        const currentManifest = this.jsonObject(run.external_manifest);
        const previousTargets = Array.isArray(currentManifest.targetIds) ? currentManifest.targetIds.map(String).sort() : [];
        const newTargets = targets.map((target) => target.targetId).sort();
        if (JSON.stringify(previousTargets) !== JSON.stringify(newTargets)) {
          throw new ConflictException('Reviewed external target inventory changed; start a separately reviewed propagation run');
        }
        const restarted = await client.query<PropagationRunRow>(
          `UPDATE saas_tenant_external_propagation_runs
           SET status='RUNNING',failure_code=NULL,finished_at=NULL,manifest_digest=NULL,
               verified_targets=0,planned_copies=0,deleted_copies=0,residual_copies=0
           WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 RETURNING *`,
          [tenantId, requestId, run.run_id],
        );
        run = restarted.rows[0];
      } else {
        const currentManifest = this.jsonObject(run.external_manifest);
        const previousTargets = Array.isArray(currentManifest.targetIds) ? currentManifest.targetIds.map(String).sort() : [];
        const newTargets = targets.map((target) => target.targetId).sort();
        if (JSON.stringify(previousTargets) !== JSON.stringify(newTargets)) {
          throw new ConflictException('Reviewed external target inventory changed during propagation');
        }
      }
      const persistedPolicyVersions = this.parsePolicyVersions(this.jsonObject(run.external_manifest).policyVersions ?? {});
      if (JSON.stringify(persistedPolicyVersions) !== JSON.stringify(this.parsePolicyVersions(policyVersions))) {
        throw new ConflictException('Retention policy version changed during an existing external propagation run; create a newly reviewed run');
      }
      const receipts = await client.query<PropagationReceiptRow>(
        `SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 ORDER BY target_id,attempt_no DESC`,
        [tenantId, requestId, run.run_id],
      );
      return { replayed: false, request, run, targets, latestReceipts: receipts.rows, activeLegalHoldCategories };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-external-propagation:' + tenantId + ':' + requestId });

    if (prepared.replayed) {
      return {
        run: this.mapRun(prepared.run),
        request: { requestId, status: prepared.request.status, version: Number(prepared.request.row_version) },
        wholeTenantErasureVerified: true,
        replayed: true,
      };
    }

    let currentManifest = this.jsonObject(prepared.run.external_manifest);
    currentManifest.activeLegalHoldCategories = prepared.activeLegalHoldCategories;
    const policyVersions = this.parsePolicyVersions(currentManifest.policyVersions ?? {});
    const latestReceiptByTarget = new Map(prepared.latestReceipts.map((receipt) => [receipt.target_id, receipt]));
    for (const target of prepared.targets) {
      const previous = latestReceiptByTarget.get(target.targetId);
      if (previous?.status === 'VERIFIED' && previous.outcome_code === 'COMPLETED') continue;
      const planEntry = (currentManifest.plans as Record<string, unknown> | undefined)?.[target.targetId];
      let plan = this.decodePlan(planEntry);
      let plannedCopies = '0';
      let deletedCopies = '0';
      let residualCopies = '0';
      let manifestKind: SaasExternalManifestKind = 'SCOPE_INTENT';
      let outcomeCode: SaasExternalPropagationOutcome = 'FAILED_RETRYABLE';
      let adapterVersion: string | null = null;
      let resourceClass = target.storeKind;
      let maxPageSize: number | null = null;
      let maxBatchSize: number | null = null;
      let residualReason: string | null = null;
      let planDigest = this.hash({
        manifestKind: 'SCOPE_INTENT', tenantId, requestId, runId: prepared.run.run_id,
        targetId: target.targetId, storeKind: target.storeKind,
        categories: this.parseCategories(prepared.request.categories),
        sourceExportDigest: prepared.request.export_bundle_digest, policyVersions,
      });
      let verifiedDigest: string | null = null;
      let verificationReference: string | null = null;
      let providerReceiptReference: string | null = null;
      let residualManifest: string[] = [];
      let receiptStatus: 'VERIFIED' | 'RESIDUALS' | 'FAILED' = 'FAILED';
      let failureCode: string | null = null;
      let adapter: SaasTenantExternalDataPropagationAdapter | undefined;
      let configured = false;
      const context = this.contextFor(prepared.request, prepared.run, target, actorUserId, idempotencyKey);

      try {
        if (prepared.activeLegalHoldCategories.some((category: SaasTransferDatasetCategory) => target.categories.includes(category))) {
          throw new ExternalPropagationDispositionError(
            'RETAINED',
            'An active legal hold retains this target/category scope; provider deletion was not attempted.',
            'ACTIVE_LEGAL_HOLD',
          );
        }
        adapter = this.adapterFor(target);
        adapterVersion = this.validateAdapterVersion(adapter.adapterVersion);
        configured = await adapter.isConfigured(target);
        if (!configured) {
          throw new ExternalPropagationDispositionError(
            'BLOCKED',
            'The target adapter has no resolved deployment configuration; no provider deletion was attempted.',
            'ADAPTER_UNCONFIGURED',
          );
        }

        const preflight = this.validatePreflight(await adapter.preflight(context), adapter);
        adapterVersion = preflight.adapterVersion;
        resourceClass = preflight.resourceClass;
        maxPageSize = preflight.maxPageSize;
        maxBatchSize = preflight.maxBatchSize;
        if (preflight.outcome !== 'READY') {
          throw new ExternalPropagationDispositionError(
            preflight.outcome,
            this.safeReason(preflight.reason, 'Adapter preflight returned ' + preflight.outcome.toLowerCase()),
            preflight.outcome === 'BLOCKED' ? 'PREFLIGHT_BLOCKED' : 'PREFLIGHT_RETAINED',
          );
        }

        if (planEntry && !plan) {
          throw new ConflictException('Persisted external deletion plan is malformed; recovery must be reviewed');
        }
        if (plan) {
          const storedPlan = this.jsonObject(planEntry ?? {});
          if (storedPlan.adapterVersion !== adapterVersion
            || storedPlan.resourceClass !== resourceClass
            || Number(storedPlan.maxPageSize) !== maxPageSize
            || Number(storedPlan.maxBatchSize) !== maxBatchSize) {
            throw new ConflictException('Persisted plan adapter version or bounded page/batch limits changed; create a newly reviewed run');
          }
          // Recovery can reconcile or resume an uncertain provider operation, so it
          // is destructive-capable and must pass the same fresh scope/hold/policy checks.
          await this.assertExternalDeletionPreconditions({
            tenantId, actorUserId, requestId, expectedVersion,
            request: prepared.request, runId: prepared.run.run_id, target, plan, policyVersions,
          });
          await adapter.recover({ ...context, plan });
        } else {
          // prepare() is the bounded dry-run that enumerates exact resource identities.
          plan = await adapter.prepare(context);
          this.validatePlan(plan);
          manifestKind = 'RESOURCE_IDENTITIES';
          currentManifest = {
            ...currentManifest,
            plans: {
              ...this.jsonObject(currentManifest.plans ?? {}),
              [target.targetId]: {
                manifestDigest: plan.manifestDigest, plannedCopies: plan.plannedCopies,
                planReference: plan.planReference, storeKind: target.storeKind,
                adapterKey: target.adapterKey, configReference: target.configReference,
                adapterVersion, resourceClass, maxPageSize, maxBatchSize, policyVersions,
                manifestKind: 'RESOURCE_IDENTITIES',
              },
            },
          };
          await this.persistRunManifest(tenantId, actorUserId, requestId, prepared.run.run_id, currentManifest);
        }

        plannedCopies = this.count(plan.plannedCopies, 'plannedCopies');
        planDigest = plan.manifestDigest;
        manifestKind = 'RESOURCE_IDENTITIES';

        // Re-read approval, policy versions, legal holds, target inventory and exact
        // resource identities immediately before the irreversible provider call.
        await this.assertExternalDeletionPreconditions({
          tenantId, actorUserId, requestId, expectedVersion,
          request: prepared.request, runId: prepared.run.run_id, target, plan, policyVersions,
        });
        const deletion = await adapter.execute({ ...context, plan });
        deletedCopies = this.count(deletion.deletedCopies, 'deletedCopies');
        providerReceiptReference = this.reference(deletion.providerReceiptReference, 'providerReceiptReference');
        if (deletion.manifestDigest !== plan.manifestDigest) {
          throw new ConflictException('External adapter deletion receipt digest differs from the exact prepared manifest');
        }
        const verification = await adapter.verify({ ...context, plan, deletion });
        residualCopies = this.count(verification.residualCopies, 'residualCopies');
        verifiedDigest = this.digestOrNull(verification.verifiedManifestDigest);
        verificationReference = this.reference(verification.verificationReference, 'verificationReference');
        residualManifest = this.residualReferences(verification.residualReferences);
        const verified = verifiedDigest === plan.manifestDigest && deletedCopies === plannedCopies
          && residualCopies === '0' && residualManifest.length === 0;
        receiptStatus = verified ? 'VERIFIED' : 'RESIDUALS';
        if (verified) {
          outcomeCode = 'COMPLETED';
          residualReason = null;
        } else {
          outcomeCode = 'FAILED_RETRYABLE';
          failureCode = 'EXTERNAL_RESIDUALS_REMAIN';
          residualReason = 'Provider deletion did not reconcile to the exact prepared manifest with zero residual copies.';
          if (residualCopies !== '0' && residualManifest.length === 0) {
            residualManifest = ['residual-count:' + residualCopies];
          }
        }
      } catch (error) {
        if (error instanceof ExternalPropagationDispositionError) {
          outcomeCode = error.outcome;
          residualReason = error.reason;
          failureCode = error.code;
          receiptStatus = 'FAILED';
        } else if (error instanceof ConflictException && /legal hold/i.test(error.message)) {
          outcomeCode = 'RETAINED';
          residualReason = 'An active legal hold blocks deletion for this target/category scope.';
          failureCode = 'ACTIVE_LEGAL_HOLD';
          receiptStatus = 'FAILED';
        } else {
          failureCode = this.failureCode(error);
          if (!adapter) {
            outcomeCode = 'BLOCKED';
            residualReason = 'No provider adapter is registered for this target; no resource identity manifest was accepted.';
            failureCode = 'ADAPTER_UNAVAILABLE';
          } else if (!configured) {
            outcomeCode = 'BLOCKED';
            residualReason = 'The target adapter is not configured; no provider deletion was attempted.';
            failureCode = 'ADAPTER_UNCONFIGURED';
          } else {
            outcomeCode = 'FAILED_RETRYABLE';
            residualReason = plan
              ? 'Provider execution or verification did not produce a fully reconciled receipt; provider state must be recovered before retry.'
              : 'Provider preflight or dry-run did not produce a complete resource identity manifest.';
          }
          receiptStatus = 'FAILED';
        }

        if (plan) {
          try {
            plannedCopies = this.count(plan.plannedCopies, 'plannedCopies');
            planDigest = this.digestOrNull(plan.manifestDigest) ?? planDigest;
            manifestKind = 'RESOURCE_IDENTITIES';
          } catch {
            plannedCopies = '0';
            deletedCopies = '0';
            residualCopies = '0';
            manifestKind = 'SCOPE_INTENT';
          }
        } else {
          // A scope-intent digest is deliberately not represented as an enumerated
          // resource manifest and carries no invented copy count.
          residualCopies = '0';
          manifestKind = 'SCOPE_INTENT';
        }
      }

      await this.insertReceipt({
        tenantId, actorUserId, requestId, runId: prepared.run.run_id, target,
        plannedCopies, deletedCopies, residualCopies, manifestDigest: planDigest,
        verifiedManifestDigest: verifiedDigest, verificationReference, providerReceiptReference,
        residualManifest, status: receiptStatus, failureCode, outcomeCode, manifestKind,
        resourceClass, adapterVersion, maxPageSize, maxBatchSize, policyVersions, residualReason,
      });
      latestReceiptByTarget.set(target.targetId, {
        target_id: target.targetId, store_kind: target.storeKind, status: receiptStatus,
        planned_copies: plannedCopies, deleted_copies: deletedCopies, residual_copies: residualCopies,
        manifest_digest: planDigest, verified_manifest_digest: verifiedDigest,
        verification_reference: verificationReference, provider_receipt_reference: providerReceiptReference,
        residual_manifest: residualManifest, failure_code: failureCode, attempt_no: 1,
        outcome_code: outcomeCode, manifest_kind: manifestKind, resource_class: resourceClass,
        adapter_version: adapterVersion, max_page_size: maxPageSize, max_batch_size: maxBatchSize,
        policy_versions: policyVersions, residual_reason: residualReason,
        completed_at: new Date().toISOString(),
      } as PropagationReceiptRow);
    }

    const latestReceipts = await this.database.query<PropagationReceiptRow>(
      `SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts
       WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 ORDER BY target_id,attempt_no DESC`,
      [tenantId, requestId, prepared.run.run_id], { tenantId, userId: actorUserId },
    );
    const receiptByTarget = new Map(latestReceipts.rows.map((receipt) => [receipt.target_id, receipt]));
    const verifiedTargets = prepared.targets.filter((target) => {
      const receipt = receiptByTarget.get(target.targetId);
      return receipt?.status === 'VERIFIED' && receipt.outcome_code === 'COMPLETED';
    });
    const planned = latestReceipts.rows.reduce((sum, row) => sum + BigInt(row.planned_copies), 0n);
    const deleted = latestReceipts.rows.reduce((sum, row) => sum + BigInt(row.deleted_copies), 0n);
    const residual = latestReceipts.rows.reduce((sum, row) => sum + BigInt(row.residual_copies), 0n);
    const allVerified = verifiedTargets.length === prepared.targets.length
      && latestReceipts.rows.length === prepared.targets.length && residual === 0n && deleted === planned;

    const targetManifest: Record<string, unknown> = {};
    for (const target of prepared.targets) {
      const receipt = receiptByTarget.get(target.targetId);
      if (!receipt) {
        targetManifest[target.targetId] = { storeKind: target.storeKind, status: 'MISSING_RECEIPT' };
        continue;
      }
      targetManifest[target.targetId] = {
        storeKind: target.storeKind, adapterKey: target.adapterKey,
        status: receipt.status, outcomeCode: receipt.outcome_code, manifestKind: receipt.manifest_kind,
        resourceClass: receipt.resource_class, adapterVersion: receipt.adapter_version,
        policyVersions: this.parsePolicyVersions(receipt.policy_versions),
        maxPageSize: receipt.max_page_size, maxBatchSize: receipt.max_batch_size,
        plannedCopies: String(receipt.planned_copies), deletedCopies: String(receipt.deleted_copies),
        residualCopies: String(receipt.residual_copies), manifestDigest: receipt.manifest_digest,
        verifiedManifestDigest: receipt.verified_manifest_digest,
        verificationReference: receipt.verification_reference, providerReceiptReference: receipt.provider_receipt_reference,
        residualManifest: this.jsonArray(receipt.residual_manifest), residualReason: receipt.residual_reason,
        completedAt: receipt.completed_at, failureCode: receipt.failure_code,
      };
    }
    const wholeManifest = {
      version: 1, tenantId, requestId, requestVersion: Number(prepared.request.version),
      runId: prepared.run.run_id, sourceExportDigest: prepared.request.export_bundle_digest,
      postgresqlErasureRunId: prepared.request.execution_run_id, postgresqlReceiptScope: 'POSTGRESQL_ONLY',
      targetManifest, plannedCopies: planned.toString(), deletedCopies: deleted.toString(), residualCopies: residual.toString(),
    };
    const manifestDigest = this.hash(wholeManifest);
    const status = allVerified ? 'VERIFIED' : 'PARTIAL';
    const failureCode = allVerified ? null : residual > 0n ? 'EXTERNAL_RESIDUALS_REMAIN' : 'EXTERNAL_VERIFICATION_INCOMPLETE';

    const finalized = await this.database.transaction(async (client) => {
      const runUpdate = await client.query<PropagationRunRow>(
        `UPDATE saas_tenant_external_propagation_runs
         SET status=$4,external_manifest=$5::jsonb,manifest_digest=$6,target_count=$7,verified_targets=$8,
             planned_copies=$9,deleted_copies=$10,residual_copies=$11,failure_code=$12,
             finished_at=CASE WHEN $4='VERIFIED' THEN clock_timestamp() ELSE NULL END
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 RETURNING *`,
        [tenantId, requestId, prepared.run.run_id, status, JSON.stringify({ ...currentManifest, result: wholeManifest }),
          allVerified ? manifestDigest : null, prepared.targets.length, verifiedTargets.length,
          planned.toString(), deleted.toString(), residual.toString(), failureCode],
      );
      const run = runUpdate.rows[0];
      let request: ErasureRequestRow | undefined;
      if (allVerified) {
        const verified = await client.query<ErasureRequestRow>(
          `UPDATE saas_tenant_data_erasure_requests
           SET status='VERIFIED',propagation_run_id=$3,propagation_manifest_digest=$4,
               propagation_verified_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND request_id=$2 AND version=1
             AND status='PROPAGATION_PENDING' AND row_version=$5 RETURNING *`,
          [tenantId, requestId, prepared.run.run_id, manifestDigest, expectedVersion],
        );
        request = verified.rows[0];
        if (!request) throw new ConflictException('Erasure request changed before whole-tenant propagation could be finalized');
      }
      await this.audit(client, tenantId, actorUserId,
        allVerified ? 'TENANT_ERASURE_PROPAGATION_VERIFIED' : 'TENANT_ERASURE_PROPAGATION_PARTIAL',
        prepared.run.run_id, {
          requestId, runId: prepared.run.run_id, status, sourceExportDigest: prepared.request.export_bundle_digest,
          postgresqlReceiptScope: 'POSTGRESQL_ONLY', targetCount: prepared.targets.length,
          verifiedTargets: verifiedTargets.length, plannedCopies: planned.toString(), deletedCopies: deleted.toString(),
          residualCopies: residual.toString(), manifestDigest: allVerified ? manifestDigest : null, failureCode,
        });
      return { run, request };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-external-propagation-finalize:' + tenantId + ':' + requestId });

    return {
      run: this.mapRun(finalized.run),
      request: finalized.request ? {
        requestId, status: finalized.request.status, version: Number(finalized.request.row_version),
        postgresqlManifestDigest: finalized.request.execution_manifest_digest,
        propagationManifestDigest: finalized.request.propagation_manifest_digest,
        propagationVerifiedAt: finalized.request.propagation_verified_at,
      } : {
        requestId, status: 'PROPAGATION_PENDING', version: Number(prepared.request.row_version),
        postgresqlManifestDigest: prepared.request.execution_manifest_digest,
      },
      wholeTenantErasureVerified: allVerified,
      replayed: false,
    };
  }

  async listPropagationRuns(tenantValue: string, actorValue: string, requestValue: string, rawLimit?: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    const requestId = this.uuid(requestValue, 'requestId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const limit = rawLimit === undefined || rawLimit.trim() === '' ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    const result = await this.database.query<PropagationRunRow & { created_at: string }>(
      `SELECT * FROM saas_tenant_external_propagation_runs
       WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3`,
      [tenantId, requestId, limit], { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapRun(row)), count: result.rows.length, limit };
  }

  private async assertExternalDeletionPreconditions(input: {
    tenantId: string;
    actorUserId: string;
    requestId: string;
    expectedVersion: number;
    request: ErasureRequestRow;
    runId: string;
    target: SaasTenantExternalDataTarget;
    plan: SaasExternalPropagationPlan;
    policyVersions: Record<string, number>;
  }) {
    const { tenantId, actorUserId, requestId, expectedVersion, request, runId, target, plan, policyVersions } = input;

    await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);

      const currentRequestResult = await client.query<ErasureRequestRow>(
        `SELECT * FROM saas_tenant_data_erasure_requests
         WHERE tenant_id=$1 AND request_id=$2 AND version=$3 FOR UPDATE`,
        [tenantId, requestId, Number(request.version)],
      );
      const currentRequest = currentRequestResult.rows[0];
      if (!currentRequest || currentRequest.status !== 'PROPAGATION_PENDING') {
        throw new ConflictException('Erasure approval is no longer eligible for external deletion');
      }
      if (Number(currentRequest.row_version) !== expectedVersion
        || currentRequest.export_bundle_digest !== request.export_bundle_digest
        || currentRequest.export_transfer_id !== request.export_transfer_id
        || Number(currentRequest.export_transfer_version) !== Number(request.export_transfer_version)
        || currentRequest.execution_run_id !== request.execution_run_id
        || currentRequest.execution_manifest_digest !== request.execution_manifest_digest
        || JSON.stringify([...this.parseCategories(currentRequest.categories)].sort())
          !== JSON.stringify([...this.parseCategories(request.categories)].sort())) {
        throw new ConflictException('Approved erasure request, export digest, PostgreSQL receipt or categories changed before external deletion');
      }

      const transferResult = await client.query<TransferRow>(
        `SELECT t.source_manifest, t.source_bundle_digest, t.actor_user_id
         FROM saas_tenant_data_transfers t
         WHERE t.tenant_id=$1 AND t.transfer_id=$2 AND t.version=$3
           AND t.operation_type='EXPORT' AND t.status='COMPLETED' AND t.source_bundle_digest=$4
         FOR SHARE`,
        [tenantId, currentRequest.export_transfer_id, Number(currentRequest.export_transfer_version), currentRequest.export_bundle_digest],
      );
      const transfer = transferResult.rows[0];
      if (!transfer || transfer.source_bundle_digest !== currentRequest.export_bundle_digest) {
        throw new ConflictException('Exact completed source export changed or is no longer available before external deletion');
      }

      const sourceManifest = this.jsonObject(transfer.source_manifest);
      const attestationResult = await client.query<{ verified_by_user_id: string }>(
        `SELECT verified_by_user_id FROM saas_tenant_data_export_preservation_attestations
         WHERE tenant_id=$1 AND transfer_id=$2 AND transfer_version=$3 AND bundle_digest=$4
         ORDER BY verified_at DESC FOR SHARE`,
        [tenantId, currentRequest.export_transfer_id, Number(currentRequest.export_transfer_version), currentRequest.export_bundle_digest],
      );
      if (!attestationResult.rows.some((row) =>
        row.verified_by_user_id !== currentRequest.requested_by_user_id
        && row.verified_by_user_id !== currentRequest.reviewed_by_user_id
        && row.verified_by_user_id !== currentRequest.execution_started_by_user_id
        && row.verified_by_user_id !== actorUserId)) {
        throw new ConflictException('Independent export-preservation attestation is missing or no longer independent before external deletion');
      }

      const categories = this.parseCategories(currentRequest.categories);
      const holdResult = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
        `SELECT categories FROM saas_tenant_data_legal_holds
         WHERE tenant_id=$1 AND status='ACTIVE' FOR SHARE`,
        [tenantId],
      );
      if (holdResult.rows.some((hold) =>
        categories.some((category) => this.parseCategories(hold.categories).includes(category)))) {
        throw new ConflictException('An active legal hold blocks external deletion for one or more categories');
      }

      const livePolicyResult = await client.query<{
        category_code: string; version: string | number; disposition: string;
      }>(
        `SELECT DISTINCT ON (category_code) category_code, version, disposition
         FROM saas_tenant_data_retention_policies
         WHERE tenant_id=$1 AND category_code = ANY($2::varchar[])
         ORDER BY category_code,version DESC`,
        [tenantId, categories],
      );
      const livePolicyVersions: Record<string, number> = {};
      const livePolicies = new Map(livePolicyResult.rows.map((row) => [row.category_code, row]));
      for (const category of categories) {
        const policy = livePolicies.get(category);
        const version = Number(policy?.version);
        if (!policy || policy.disposition !== 'DELETE' || !Number.isSafeInteger(version) || version < 1) {
          throw new ConflictException('A current DELETE retention policy is no longer available for this category');
        }
        livePolicyVersions[category] = version;
      }
      if (JSON.stringify(this.parsePolicyVersions(livePolicyVersions)) !== JSON.stringify(this.parsePolicyVersions(policyVersions))) {
        throw new ConflictException('Retention policy version changed before provider deletion');
      }

      const targetResult = await client.query<TargetRow>(
        `SELECT * FROM saas_tenant_external_data_targets
         WHERE tenant_id=$1 AND required=true AND status='ACTIVE'
         ORDER BY store_kind,target_id FOR SHARE`,
        [tenantId],
      );
      const currentTargets = targetResult.rows.map((row) => this.mapTarget(row))
        .filter((candidate) => candidate.categories.some((category) => categories.includes(category)));
      this.assertTargetCoverage(categories, currentTargets);

      const runResult = await client.query<PropagationRunRow>(
        `SELECT * FROM saas_tenant_external_propagation_runs
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 FOR UPDATE`,
        [tenantId, requestId, runId],
      );
      const currentRun = runResult.rows[0];
      if (!currentRun || currentRun.status !== 'RUNNING') {
        throw new ConflictException('External propagation run is no longer RUNNING before provider deletion');
      }
      const manifest = this.jsonObject(currentRun.external_manifest);
      const persistedTargets = Array.isArray(manifest.targetIds) ? manifest.targetIds.map(String).sort() : [];
      const currentTargetIds = currentTargets.map((candidate) => candidate.targetId).sort();
      if (Number(currentRun.request_version) !== Number(currentRequest.version)
        || currentRun.source_export_digest !== currentRequest.export_bundle_digest
        || manifest.sourceExportDigest !== currentRequest.export_bundle_digest
        || manifest.requestId !== requestId
        || Number(manifest.requestVersion) !== Number(currentRequest.version)
        || manifest.sourceManifestDigest !== this.hash(sourceManifest)
        || JSON.stringify(this.parsePolicyVersions(manifest.policyVersions ?? {})) !== JSON.stringify(this.parsePolicyVersions(policyVersions))
        || JSON.stringify(persistedTargets) !== JSON.stringify(currentTargetIds)) {
        throw new ConflictException('External target inventory or exact approved manifest changed before provider deletion');
      }

      const liveTarget = currentTargets.find((candidate) => candidate.targetId === target.targetId);
      if (!liveTarget
        || liveTarget.storeKind !== target.storeKind
        || liveTarget.adapterKey !== target.adapterKey
        || liveTarget.configReference !== target.configReference
        || liveTarget.required !== target.required
        || JSON.stringify([...liveTarget.categories].sort()) !== JSON.stringify([...target.categories].sort())) {
        throw new ConflictException('The external target registration changed or is no longer active before provider deletion');
      }

      const plans = this.jsonObject(manifest.plans ?? {});
      const persistedPlan = this.jsonObject(plans[target.targetId] ?? {});
      if (persistedPlan.manifestDigest !== plan.manifestDigest
        || String(persistedPlan.plannedCopies ?? '') !== String(plan.plannedCopies)
        || persistedPlan.planReference !== plan.planReference
        || persistedPlan.storeKind !== target.storeKind
        || persistedPlan.adapterKey !== target.adapterKey
        || persistedPlan.configReference !== target.configReference) {
        throw new ConflictException('The exact prepared external deletion plan changed before provider deletion');
      }
    }, {
      tenantId,
      userId: actorUserId,
      advisoryLockKey: 'saas-external-predelete:' + tenantId + ':' + requestId + ':' + runId + ':' + target.targetId,
    });
  }

  private async persistRunManifest(tenantId: string, actorUserId: string, requestId: string, runId: string, manifest: Record<string, unknown>) {
    await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      await client.query(
        `UPDATE saas_tenant_external_propagation_runs SET external_manifest=$4::jsonb
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 AND status='RUNNING'`,
        [tenantId, requestId, runId, JSON.stringify(manifest)],
      );
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-external-plan:' + tenantId + ':' + requestId + ':' + runId });
  }

  private async insertReceipt(input: {
    tenantId: string; actorUserId: string; requestId: string; runId: string; target: SaasTenantExternalDataTarget;
    plannedCopies: string; deletedCopies: string; residualCopies: string; manifestDigest: string;
    verifiedManifestDigest: string | null; verificationReference: string | null; providerReceiptReference: string | null;
    residualManifest: string[]; status: 'VERIFIED' | 'RESIDUALS' | 'FAILED'; failureCode: string | null;
    outcomeCode: SaasExternalPropagationOutcome; manifestKind: SaasExternalManifestKind;
    resourceClass: string; adapterVersion: string | null; maxPageSize: number | null; maxBatchSize: number | null;
    policyVersions: Record<string, number>; residualReason: string | null;
  }) {
    await this.database.transaction(async (client) => {
      await this.lockTenant(client, input.tenantId);
      const attempt = await client.query<{ attempt_no: number }>(
        `SELECT COALESCE(MAX(attempt_no),0)+1 AS attempt_no FROM saas_tenant_external_propagation_receipts
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 AND target_id=$4`,
        [input.tenantId, input.requestId, input.runId, input.target.targetId],
      );
      await client.query(
        `INSERT INTO saas_tenant_external_propagation_receipts
         (tenant_id,request_id,run_id,target_id,store_kind,attempt_no,status,planned_copies,deleted_copies,
          residual_copies,manifest_digest,verified_manifest_digest,verification_reference,residual_manifest,
          failure_code,provider_receipt_reference,outcome_code,manifest_kind,resource_class,adapter_version,
          max_page_size,max_batch_size,policy_versions,residual_reason,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25)`,
        [input.tenantId, input.requestId, input.runId, input.target.targetId, input.target.storeKind,
          Number(attempt.rows[0]?.attempt_no ?? 1), input.status, input.plannedCopies, input.deletedCopies,
          input.residualCopies, input.manifestDigest, input.verifiedManifestDigest, input.verificationReference,
          JSON.stringify(input.residualManifest), input.failureCode, input.providerReceiptReference,
          input.outcomeCode, input.manifestKind, input.resourceClass, input.adapterVersion,
          input.maxPageSize, input.maxBatchSize, JSON.stringify(input.policyVersions), input.residualReason, new Date()],
      );
    }, { tenantId: input.tenantId, userId: input.actorUserId,
      advisoryLockKey: 'saas-external-receipt:' + input.tenantId + ':' + input.runId + ':' + input.target.targetId });
  }

  private async audit(client: PoolClient, tenantId: string, actorUserId: string, action: string, resourceId: string, payload: Record<string, unknown>) {
    await this.auditService.recordWithClient(client, {
      tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
      action, resourceType: 'SAAS_EXTERNAL_PROPAGATION', resourceId, correlationId: null,
      requestId: null, dataClass: 'RESTRICTED', payload,
    });
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>('SELECT id::text AS id FROM tenants WHERE id=$1::uuid FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }
  private mapTargetAdmin(row: TargetRow) {
    return { targetId: row.target_id, storeKind: row.store_kind, adapterKey: row.adapter_key,
      configReference: row.config_reference, categories: this.parseCategories(row.categories), required: row.required,
      status: row.status, registeredByUserId: row.registered_by_user_id, reviewedByUserId: row.reviewed_by_user_id,
      reviewedAt: row.reviewed_at, reviewReason: row.review_reason, registrationReason: row.registration_reason,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private mapTarget(row: TargetRow): SaasTenantExternalDataTarget {
    return { tenantId: row.tenant_id, targetId: row.target_id, storeKind: row.store_kind, adapterKey: row.adapter_key,
      configReference: row.config_reference, categories: this.parseCategories(row.categories), required: row.required };
  }
  private assertTargetCoverage(categories: SaasTransferDatasetCategory[], targets: SaasTenantExternalDataTarget[]) {
    if (!targets.length) throw new ConflictException('No reviewed external propagation targets are configured; PostgreSQL-only evidence cannot complete erasure');
    for (const kind of REQUIRED_EXTERNAL_STORE_KINDS) for (const category of categories) {
      if (!targets.some((target) => target.storeKind === kind && target.categories.includes(category))) {
        throw new ConflictException('External propagation is missing an active, reviewed ' + kind + ' target for category ' + category);
      }
    }
  }
  private adapterFor(target: SaasTenantExternalDataTarget) {
    const adapter = this.adapters.find((item) => item.storeKind === target.storeKind && item.adapterKey === target.adapterKey);
    if (!adapter) throw new ServiceUnavailableException('No provider adapter registered for target ' + target.targetId);
    return adapter;
  }
  private contextFor(request: ErasureRequestRow, run: PropagationRunRow, target: SaasTenantExternalDataTarget, actorUserId: string, idempotencyKey: string): SaasExternalPropagationContext {
    const externalManifest = this.jsonObject(run.external_manifest);
    return {
      tenantId: request.tenant_id, requestId: request.request_id, requestVersion: Number(request.version), runId: run.run_id,
      categories: this.parseCategories(request.categories),
      policyVersions: this.parsePolicyVersions(externalManifest.policyVersions ?? {}),
      sourceExportDigest: request.export_bundle_digest,
      sourceManifest: this.jsonObject(externalManifest.sourceManifest ?? {}),
      idempotencyKey: idempotencyKey + ':' + target.targetId, target,
    };
  }
  private validateAdapterVersion(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
      throw new ConflictException('External adapter must declare an immutable semver-like version');
    }
    return value;
  }
  private validatePreflight(
    value: SaasExternalPropagationPreflight,
    adapter: SaasTenantExternalDataPropagationAdapter,
  ): SaasExternalPropagationPreflight {
    if (!value || typeof value !== 'object' || !['READY', 'BLOCKED', 'RETAINED'].includes(value.outcome)) {
      throw new ConflictException('External adapter preflight returned an invalid outcome');
    }
    const adapterVersion = this.validateAdapterVersion(value.adapterVersion);
    if (adapterVersion !== this.validateAdapterVersion(adapter.adapterVersion)) {
      throw new ConflictException('External adapter preflight version differs from its registered implementation version');
    }
    if (typeof value.resourceClass !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,31}$/.test(value.resourceClass)) {
      throw new ConflictException('External adapter preflight must declare a bounded resource class');
    }
    if (!Number.isSafeInteger(value.maxPageSize) || value.maxPageSize < 1 || value.maxPageSize > 5000
      || !Number.isSafeInteger(value.maxBatchSize) || value.maxBatchSize < 1 || value.maxBatchSize > 1000) {
      throw new ConflictException('External adapter preflight page/batch limits exceed the supported bounds');
    }
    const result: SaasExternalPropagationPreflight = {
      outcome: value.outcome, adapterVersion, resourceClass: value.resourceClass,
      maxPageSize: value.maxPageSize, maxBatchSize: value.maxBatchSize,
    };
    if (value.outcome !== 'READY') {
      result.reason = this.safeReason(value.reason, 'Adapter preflight returned ' + value.outcome.toLowerCase());
    } else if (value.reason !== undefined) {
      result.reason = this.safeReason(value.reason, 'Adapter preflight is ready');
    }
    return result;
  }
  private safeReason(value: unknown, fallback: string): string {
    const reason = typeof value === 'string' ? value.trim() : fallback;
    if (reason.length < 3 || reason.length > 1000 || reason.includes('://')
      || /(?:secret|password|credential|access[-_]?key|bearer|token)/i.test(reason)) {
      throw new ConflictException('External adapter reason must be bounded and must not contain URLs or credential-like data');
    }
    return reason;
  }
  private parsePolicyVersions(value: unknown): Record<string, number> {
    const decoded = typeof value === 'string' ? (() => {
      try { return JSON.parse(value) as unknown; } catch { throw new ConflictException('Stored policy-version manifest is malformed'); }
    })() : value;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new ConflictException('Stored policy-version manifest must be an object');
    }
    const result: Record<string, number> = {};
    for (const [category, rawVersion] of Object.entries(decoded as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      if (!CATEGORY_VALUES.includes(category as SaasTransferDatasetCategory)
        || typeof rawVersion !== 'number' || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
        throw new ConflictException('Stored policy-version manifest contains an invalid category version');
      }
      result[category] = rawVersion;
    }
    return result;
  }
  private validatePlan(plan: SaasExternalPropagationPlan) {
    if (!plan || !HEX_DIGEST.test(plan.manifestDigest)) throw new ConflictException('Adapter plan must include a SHA-256 manifest digest');
    this.count(plan.plannedCopies, 'plannedCopies'); this.reference(plan.planReference, 'planReference');
  }
  private decodePlan(value: unknown): SaasExternalPropagationPlan | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    const plan = { manifestDigest: String(row.manifestDigest ?? ''), plannedCopies: String(row.plannedCopies ?? ''), planReference: String(row.planReference ?? '') };
    try { this.validatePlan(plan); return plan; } catch { return undefined; }
  }
  private residualReferences(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 50) throw new ConflictException('Adapter residual manifest must be an array of at most 50 opaque references');
    return value.map((item) => this.reference(item, 'residualReference'));
  }
  private reference(value: unknown, field: string): string {
    if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://')
      || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
      throw new ConflictException(field + ' must be an opaque, non-secret reference');
    }
    return value;
  }
  private digestOrNull(value: unknown): string | null { return typeof value === 'string' && HEX_DIGEST.test(value) ? value : null; }
  private count(value: unknown, field: string): string {
    const count = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value) : typeof value === 'string' && NON_NEGATIVE_INTEGER.test(value) ? value : '';
    if (!count) throw new ConflictException(field + ' must be a non-negative integer count');
    return count;
  }
  private parseCategories(value: SaasTransferDatasetCategory[] | string): SaasTransferDatasetCategory[] {
    let decoded: unknown = value;
    if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded) as unknown; } catch { throw new ConflictException('Stored category list is malformed'); } }
    if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 10) throw new ConflictException('Stored category list is malformed');
    const categories = decoded.map((item) => {
      if (typeof item !== 'string' || !CATEGORY_VALUES.includes(item as SaasTransferDatasetCategory)) throw new ConflictException('Stored category list contains an unsupported category');
      return item as SaasTransferDatasetCategory;
    });
    if (new Set(categories).size !== categories.length) throw new ConflictException('Stored category list contains duplicates');
    return categories;
  }
  private jsonObject(value: unknown): Record<string, unknown> {
    let decoded = value;
    if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded) as unknown; } catch { throw new ConflictException('Stored manifest JSON is malformed'); } }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new ConflictException('Stored manifest must be a JSON object');
    return decoded as Record<string, unknown>;
  }
  private jsonArray(value: unknown): unknown[] {
    let decoded = value;
    if (typeof decoded === 'string') { try { decoded = JSON.parse(decoded) as unknown; } catch { return []; } }
    return Array.isArray(decoded) ? decoded : [];
  }
  private mapRun(row: PropagationRunRow) {
    return { runId: row.run_id, status: row.status, manifestDigest: row.manifest_digest,
      externalManifest: this.jsonObject(row.external_manifest), targetCount: Number(row.target_count),
      verifiedTargets: Number(row.verified_targets), plannedCopies: String(row.planned_copies),
      deletedCopies: String(row.deleted_copies), residualCopies: String(row.residual_copies), failureCode: row.failure_code };
  }
  private uuid(value: unknown, field: string) { if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID'); return value; }
  private integer(value: unknown, field: string, min: number, max: number) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestException(field + ' must be a safe integer between ' + min + ' and ' + max);
    return value;
  }
  private requiredString(value: unknown, field: string, max: number, min = 1) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.trim(); if (normalized.length < min || normalized.length > max) throw new BadRequestException(field + ' has invalid length');
    return normalized;
  }
  private idempotencyKey(value: unknown) { const key = this.requiredString(value, 'idempotency_key', 128); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new BadRequestException('idempotency_key has invalid characters'); return key; }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
  private failureCode(error: unknown) {
    if (error instanceof ConflictException) return 'VERIFICATION_MISMATCH';
    if (error instanceof ServiceUnavailableException) return 'ADAPTER_UNAVAILABLE';
    return 'ADAPTER_OPERATION_FAILED';
  }
}
