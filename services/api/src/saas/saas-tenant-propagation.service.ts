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
import {
  digestSaasExternalPropagationResources, REQUIRED_EXTERNAL_STORE_KINDS,
  SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS,
} from './saas-tenant-propagation.adapters';
import type {
  SaasExternalPropagationContext, SaasExternalPropagationDeleteReceipt,
  SaasExternalPropagationPlan, SaasTenantExternalDataPropagationAdapter,
  SaasTenantExternalDataTarget,
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
};

const CATEGORY_VALUES = Object.values(SaasTransferDatasetCategory);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_RESOURCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,499}$/;
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
      if (holdResult.rows.some((hold) => categories.some((category) => this.parseCategories(hold.categories).includes(category)))) {
        throw new ConflictException('An active legal hold blocks external propagation for one or more categories');
      }

      const targetResult = await client.query<TargetRow>(
        `SELECT * FROM saas_tenant_external_data_targets
         WHERE tenant_id=$1 AND required=true AND status='ACTIVE'
         ORDER BY store_kind,target_id FOR SHARE`,
        [tenantId],
      );
      const targets = targetResult.rows.map((row) => this.mapTarget(row))
        .filter((target) => target.categories.some((category) => categories.includes(category)));
      this.assertTargetCoverage(categories, targets);
      for (const target of targets) {
        const adapter = this.adapterFor(target);
        if (!(await adapter.isConfigured(target))) {
          throw new ServiceUnavailableException('Required external propagation adapter is not configured for target ' + target.targetId);
        }
      }

      const sourceManifest = this.jsonObject(transfer.source_manifest);
      if (!run) {
        const runId = randomUUID();
        const externalManifest = {
          version: 1, requestId, requestVersion: Number(request.version),
          sourceExportDigest: request.export_bundle_digest,
          sourceManifestDigest: this.hash(sourceManifest), sourceManifest,
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
      const receipts = await client.query<PropagationReceiptRow>(
        `SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 ORDER BY target_id,attempt_no DESC`,
        [tenantId, requestId, run.run_id],
      );
      return { replayed: false, request, run, targets, latestReceipts: receipts.rows };
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
    const latestReceiptByTarget = new Map(prepared.latestReceipts.map((receipt) => [receipt.target_id, receipt]));
    for (const target of prepared.targets) {
      const previous = latestReceiptByTarget.get(target.targetId);
      if (previous?.status === 'VERIFIED') continue;
      const adapter = this.adapterFor(target);
      const planEntry = (currentManifest.plans as Record<string, unknown> | undefined)?.[target.targetId];
      let plan: SaasExternalPropagationPlan | undefined;
      let resourceManifestId: string | null = null;
      let resourceEventState: string | null = null;
      let lastProviderReceiptReference: string | null = null;
      let plannedCopies = '0';
      let deletedCopies = '0';
      let residualCopies = '0';
      let planDigest = this.hash({ tenantId, requestId, runId: prepared.run.run_id, targetId: target.targetId, source: prepared.request.export_bundle_digest });
      let verifiedDigest: string | null = null;
      let verificationReference: string | null = null;
      let providerReceiptReference: string | null = null;
      let residualManifest: string[] = [];
      let receiptStatus: 'VERIFIED' | 'RESIDUALS' | 'FAILED' = 'FAILED';
      let failureCode: string | null = null;
      let ledgerWriteFailed = false;
      const context = this.contextFor(prepared.request, prepared.run, target, actorUserId, idempotencyKey);
      const recordResourceEvent = async (
        outcomeCode: 'PREPARED' | 'DELETE_REQUESTED' | 'DELETED' | 'VERIFIED' | 'FAILED_RETRYABLE',
        details: {
          providerReceiptReference?: string | null;
          verificationReference?: string | null;
          verifiedManifestDigest?: string | null;
          residualCount?: string;
          failureCode?: string | null;
          residualReason?: string | null;
        } = {},
      ) => {
        if (!resourceManifestId || !plan || plan.resources.length === 0) return;
        try {
          await this.appendResourceEvents({
            tenantId, actorUserId, manifestId: resourceManifestId, outcomeCode,
            providerReceiptReference: details.providerReceiptReference ?? null,
            verificationReference: details.verificationReference ?? null,
            verifiedManifestDigest: details.verifiedManifestDigest ?? null,
            residualCount: details.residualCount ?? '0',
            failureCode: details.failureCode ?? null,
            residualReason: details.residualReason ?? null,
          });
        } catch (error) {
          ledgerWriteFailed = true;
          throw error;
        }
      };

      try {
        if (planEntry) {
          const loaded = await this.loadPlanFromManifest({
            tenantId, actorUserId, requestId, runId: prepared.run.run_id, target, planEntry,
          });
          plan = loaded.plan;
          resourceManifestId = loaded.manifestId;
          resourceEventState = loaded.latestOutcome;
          lastProviderReceiptReference = loaded.providerReceiptReference;
          if (plan.resources.length > 0 && !resourceEventState) {
            throw new ConflictException('Sealed resource manifest is missing its initial per-resource PREPARED events');
          }
          if (resourceEventState === 'FAILED_RETRYABLE') {
            await recordResourceEvent('PREPARED');
            resourceEventState = 'PREPARED';
          }
          if (['VERIFIED', 'BLOCKED', 'RETAINED'].includes(resourceEventState ?? '')) {
            throw new ConflictException('The per-resource manifest has terminal outcomes and cannot be silently re-executed');
          }
          if (plan.resources.length > 0
            && !['PREPARED', 'DELETE_REQUESTED', 'DELETED'].includes(resourceEventState ?? '')) {
            throw new ConflictException('Per-resource recovery state is not resumable');
          }
          await adapter.recover({ ...context, plan });
        } else {
          plan = await adapter.prepare(context);
          this.validatePlan(plan);
          let persisted: { manifestId: string; externalManifest: Record<string, unknown> };
          try {
            persisted = await this.persistResourceManifestAndRunPlan({
              tenantId, actorUserId, requestId, requestVersion: Number(prepared.request.version),
              runId: prepared.run.run_id, target, plan,
              sourceExportDigest: prepared.request.export_bundle_digest,
              currentManifest,
            });
          } catch (error) {
            ledgerWriteFailed = true;
            throw error;
          }
          resourceManifestId = persisted.manifestId;
          currentManifest = persisted.externalManifest;
          resourceEventState = plan.resources.length > 0 ? 'PREPARED' : null;
        }
        plannedCopies = this.count(plan.plannedCopies, 'plannedCopies');
        planDigest = plan.manifestDigest;

        let deletion: SaasExternalPropagationDeleteReceipt;
        if (resourceEventState === 'DELETED' && plan.resources.length > 0) {
          if (!lastProviderReceiptReference) {
            throw new ConflictException('Per-resource DELETED state has no durable provider receipt reference');
          }
          providerReceiptReference = this.reference(lastProviderReceiptReference, 'providerReceiptReference');
          deletedCopies = plannedCopies;
          deletion = {
            deletedCopies,
            manifestDigest: plan.manifestDigest,
            providerReceiptReference,
          };
        } else {
          if (resourceEventState === 'PREPARED') {
            await recordResourceEvent('DELETE_REQUESTED');
            resourceEventState = 'DELETE_REQUESTED';
          }
          deletion = await adapter.erase({ ...context, plan });
          deletedCopies = this.count(deletion.deletedCopies, 'deletedCopies');
          providerReceiptReference = this.reference(deletion.providerReceiptReference, 'providerReceiptReference');
          if (deletion.manifestDigest !== plan.manifestDigest) {
            throw new ConflictException('External adapter deletion receipt digest differs from the exact prepared manifest');
          }
          if (deletedCopies === plannedCopies && resourceEventState === 'DELETE_REQUESTED') {
            await recordResourceEvent('DELETED', { providerReceiptReference });
            resourceEventState = 'DELETED';
          }
        }
        if (deletion.manifestDigest !== plan.manifestDigest) {
          throw new ConflictException('Recovered deletion receipt digest differs from the sealed resource manifest');
        }

        const verification = await adapter.verify({ ...context, plan, deletion });
        residualCopies = this.count(verification.residualCopies, 'residualCopies');
        verifiedDigest = this.digestOrNull(verification.verifiedManifestDigest);
        verificationReference = this.reference(verification.verificationReference, 'verificationReference');
        residualManifest = this.residualReferences(verification.residualReferences);
        const verified = verifiedDigest === plan.manifestDigest && deletedCopies === plannedCopies
          && residualCopies === '0' && residualManifest.length === 0;
        receiptStatus = verified ? 'VERIFIED' : 'RESIDUALS';
        if (!verified) {
          failureCode = 'EXTERNAL_RESIDUALS_REMAIN';
          if (residualCopies !== '0' && residualManifest.length === 0) {
            residualManifest = ['residual-count:' + residualCopies];
          }
        }
      } catch (error) {
        if (ledgerWriteFailed) {
          throw new ServiceUnavailableException('Durable per-resource erasure ledger write failed; propagation is halted before further provider mutations');
        }
        failureCode = this.failureCode(error);
        if (plan) {
          try {
            plannedCopies = this.count(plan.plannedCopies, 'plannedCopies');
            planDigest = this.digestOrNull(plan.manifestDigest) ?? planDigest;
            residualCopies = plannedCopies === '0' ? '1' : plannedCopies;
          } catch {
            plannedCopies = '0';
            deletedCopies = '0';
            residualCopies = '1';
          }
        } else residualCopies = '1';
        residualManifest = ['unverified-scope:' + target.targetId];
        receiptStatus = 'FAILED';
      }

      if (plan && resourceManifestId && plan.resources.length > 0) {
        if (receiptStatus === 'VERIFIED') {
          await recordResourceEvent('VERIFIED', {
            providerReceiptReference, verificationReference,
            verifiedManifestDigest: verifiedDigest, residualCount: '0',
          });
          resourceEventState = 'VERIFIED';
        } else if (resourceEventState && !['FAILED_RETRYABLE', 'VERIFIED', 'BLOCKED', 'RETAINED'].includes(resourceEventState)) {
          await recordResourceEvent('FAILED_RETRYABLE', {
            providerReceiptReference, residualCount: residualCopies,
            failureCode: failureCode ?? 'ADAPTER_OPERATION_FAILED',
            residualReason: 'Provider outcome requires reconciliation before this resource may be retried',
          });
          resourceEventState = 'FAILED_RETRYABLE';
        }
      }

      await this.insertReceipt({
        tenantId, actorUserId, requestId, runId: prepared.run.run_id, target,
        plannedCopies, deletedCopies, residualCopies, manifestDigest: planDigest,
        verifiedManifestDigest: verifiedDigest, verificationReference, providerReceiptReference,
        residualManifest, status: receiptStatus, failureCode,
      });
      latestReceiptByTarget.set(target.targetId, {
        target_id: target.targetId, store_kind: target.storeKind, status: receiptStatus,
        planned_copies: plannedCopies, deleted_copies: deletedCopies, residual_copies: residualCopies,
        manifest_digest: planDigest, verified_manifest_digest: verifiedDigest,
        verification_reference: verificationReference, provider_receipt_reference: providerReceiptReference,
        residual_manifest: residualManifest, failure_code: failureCode, attempt_no: 1,
      } as PropagationReceiptRow);
    }

    const latestReceipts = await this.database.query<PropagationReceiptRow>(
      `SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts
       WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 ORDER BY target_id,attempt_no DESC`,
      [tenantId, requestId, prepared.run.run_id], { tenantId, userId: actorUserId },
    );
    const receiptByTarget = new Map(latestReceipts.rows.map((receipt) => [receipt.target_id, receipt]));
    const verifiedTargets = prepared.targets.filter((target) => receiptByTarget.get(target.targetId)?.status === 'VERIFIED');
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
        storeKind: target.storeKind, adapterKey: target.adapterKey, status: receipt.status,
        plannedCopies: String(receipt.planned_copies), deletedCopies: String(receipt.deleted_copies),
        residualCopies: String(receipt.residual_copies), manifestDigest: receipt.manifest_digest,
        verifiedManifestDigest: receipt.verified_manifest_digest,
        verificationReference: receipt.verification_reference, providerReceiptReference: receipt.provider_receipt_reference,
        residualManifest: this.jsonArray(receipt.residual_manifest), failureCode: receipt.failure_code,
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
          failure_code,provider_receipt_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)`,
        [input.tenantId, input.requestId, input.runId, input.target.targetId, input.target.storeKind,
          Number(attempt.rows[0]?.attempt_no ?? 1), input.status, input.plannedCopies, input.deletedCopies,
          input.residualCopies, input.manifestDigest, input.verifiedManifestDigest, input.verificationReference,
          JSON.stringify(input.residualManifest), input.failureCode, input.providerReceiptReference],
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
      categories: this.parseCategories(request.categories), sourceExportDigest: request.export_bundle_digest,
      sourceManifest: this.jsonObject(externalManifest.sourceManifest ?? {}),
      idempotencyKey: idempotencyKey + ':' + target.targetId, target,
    };
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
