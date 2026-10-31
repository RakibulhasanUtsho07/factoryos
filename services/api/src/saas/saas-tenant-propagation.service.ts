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
import { S3TenantBackupWriterFenceCoordinator } from './s3-tenant-backup-writer-fence.coordinator';
import { PropagateSaasTenantErasureDto } from './dto/propagate-saas-tenant-erasure.dto';
import { RegisterSaasExternalDataTargetDto } from './dto/register-saas-external-data-target.dto';
import { ReviewSaasExternalDataTargetDto } from './dto/review-saas-external-data-target.dto';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import {
  canonicalizeSaasExternalPropagationResources, digestSaasExternalPropagationResources,
  REQUIRED_EXTERNAL_STORE_KINDS, EXTERNAL_COPY_COVERAGE_STORE_KINDS,
  UNCLASSIFIED_EXTERNAL_STORE_KIND, SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS,
} from './saas-tenant-propagation.adapters';
import { REQUIRED_BACKUP_COPY_CLASSES, S3_BACKUP_COPY_CLASS_ADAPTER_KEY } from './backup-copy-class-coverage.constants';
import { verifyBackupCopyClassEvidenceAttestation, type BackupCopyClassEvidenceAttestationPayload,
  verifyExternalCopyCoverageEvidenceAttestation, type ExternalCopyCoverageEvidenceAttestationPayload } from './backup-copy-class-evidence-attestation';
import { BackupCopyClassEvidenceArtifactReader } from './backup-copy-class-evidence-artifact-reader';
import { validateExternalStoreInventoryManifest } from './external-store-inventory-manifest';
import type {
  SaasExternalPropagationContext, SaasExternalPropagationDeleteReceipt,
  SaasExternalPropagationPlan, SaasExternalPropagationResourceIdentity,
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
type CopyCoverageRow = QueryResultRow & {
  decision_id: string; tenant_id: string; category_code: SaasTransferDatasetCategory;
  store_kind: (typeof EXTERNAL_COPY_COVERAGE_STORE_KINDS)[number]; revision: string | number;
  disposition: 'SUPPORTED' | 'NOT_APPLICABLE' | 'UNRESOLVED';
  evidence_reference: string; evidence_sha256: string; evidence_at: string; reason: string;
  attestation_key_id: string | null; attestation_owner_reference: string | null; attestation_signature: string | null;
  data_owner_reference: string; infrastructure_owner_reference: string; policy_reference: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; submitted_by_user_id: string;
  reviewed_by_user_id: string | null; valid_until: string | null;
};

type BackupCopyClassCoverageRow = QueryResultRow & {
  decision_id: string; tenant_id: string; category_code: SaasTransferDatasetCategory;
  copy_class_code: (typeof REQUIRED_BACKUP_COPY_CLASSES)[number]; revision: string | number;
  disposition: 'SUPPORTED' | 'NOT_APPLICABLE' | 'UNRESOLVED';
  evidence_reference: string; evidence_sha256: string; evidence_at: string | Date;
  attestation_key_id: string; attestation_owner_reference: string; attestation_signature: string;
  data_owner_reference: string; infrastructure_owner_reference: string; policy_reference: string; reason: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; submitted_by_user_id: string;
  reviewed_by_user_id: string | null; valid_until: string | Date | null;
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
    private readonly backupEvidenceArtifactReader: BackupCopyClassEvidenceArtifactReader,
    @Optional() @Inject(SAAS_TENANT_EXTERNAL_PROPAGATION_ADAPTERS)
    private readonly adapters: SaasTenantExternalDataPropagationAdapter[] = [],
    @Optional() @Inject(S3TenantBackupWriterFenceCoordinator)
    private readonly backupWriterFenceCoordinator?: S3TenantBackupWriterFenceCoordinator,
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

    // Do not let a target become ACTIVE unless the exact provider adapter exists
    // and its deployment configuration is ready. Do this before opening the row-
    // locking transaction because config resolution may itself involve a secret
    // manager; recheck the immutable binding after locking the current row below.
    let activationBinding: { id: string; target: SaasTenantExternalDataTarget } | undefined;
    if (nextStatus === 'ACTIVE') {
      const candidateResult = await this.database.query<TargetRow>(
        'SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 AND target_id=$2',
        [tenantId, targetId],
        { tenantId, userId: actorUserId },
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) throw new NotFoundException('External data target not found');
      const candidateTarget = this.mapTarget(candidate);
      const adapter = this.adapterFor(candidateTarget);
      let configured = false;
      try {
        configured = await adapter.isConfigured(candidateTarget);
      } catch {
        configured = false;
      }
      if (!configured) {
        throw new ServiceUnavailableException('External target cannot be activated because its registered provider adapter is not configured');
      }
      activationBinding = { id: candidate.id, target: candidateTarget };
    }

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<TargetRow>(
        'SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 AND target_id=$2 FOR UPDATE',
        [tenantId, targetId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('External data target not found');
      if (current.status !== expectedStatus) throw new ConflictException('External target status changed; reload before reviewing');
      if (activationBinding && (
        current.id !== activationBinding.id
        || current.store_kind !== activationBinding.target.storeKind
        || current.adapter_key !== activationBinding.target.adapterKey
        || current.config_reference !== activationBinding.target.configReference
        || current.required !== activationBinding.target.required
        || JSON.stringify(this.parseCategories(current.categories).slice().sort())
          !== JSON.stringify(activationBinding.target.categories.slice().sort())
      )) {
        throw new ConflictException('External target binding changed during adapter readiness check; reload and review again');
      }
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
        return { replayed: true, request, run, targets: [] as SaasTenantExternalDataTarget[], latestReceipts: [] as PropagationReceiptRow[], copyCoverageRows: [] as CopyCoverageRow[], copyCoverageManifest: [] as Array<Record<string, unknown>>, copyCoverageDigest: '', backupCopyClassRows: [] as BackupCopyClassCoverageRow[], backupCopyClassCoverageManifest: [] as Array<Record<string, unknown>>, backupCopyClassCoverageDigest: '' };
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
         WHERE tenant_id=$1 ORDER BY store_kind,target_id FOR SHARE`,
        [tenantId],
      );
      const relevantTargetRows = targetResult.rows.filter((row) =>
        this.parseCategories(row.categories).some((category) => categories.includes(category)));
      if (relevantTargetRows.some((row) => row.status !== 'ACTIVE' || row.required !== true)) {
        throw new ConflictException('A required external target is pending, blocked or inactive; copy-class coverage cannot be accepted from a partial target inventory');
      }
      const targets = relevantTargetRows.map((row) => this.mapTarget(row));
      const coverageResult = await client.query<CopyCoverageRow>(
        `SELECT DISTINCT ON (category_code,store_kind) *
         FROM public.saas_tenant_external_copy_coverage_decisions
         WHERE tenant_id=$1 AND category_code=ANY($2::text[])
         ORDER BY category_code,store_kind,revision DESC`,
        [tenantId, categories],
      );
      await this.assertTargetCoverage(categories, targets, coverageResult.rows);
      const copyCoverageManifest = this.copyCoverageManifest(coverageResult.rows);
      const copyCoverageDigest = this.hash(copyCoverageManifest);
      const backupCopyClassResult = await client.query<BackupCopyClassCoverageRow>(
        `SELECT DISTINCT ON (category_code,copy_class_code) *
         FROM public.saas_tenant_backup_copy_class_coverage_decisions
         WHERE tenant_id=$1 AND category_code=ANY($2::text[])
         ORDER BY category_code,copy_class_code,revision DESC`,
        [tenantId, categories],
      );
      await this.assertBackupCopyClassCoverage(categories, targets, backupCopyClassResult.rows);
      const backupCopyClassCoverageManifest = this.backupCopyClassCoverageManifest(backupCopyClassResult.rows);
      const backupCopyClassCoverageDigest = this.hash(backupCopyClassCoverageManifest);
      // One fence lifecycle represents one sealed backup inventory per category.
      // Until cross-target aggregate manifests are supported, reject overlapping
      // BACKUP targets rather than letting one target verify a shared fence early.
      const backupCategoryOwners = new Map<SaasTransferDatasetCategory, string>();
      for (const target of targets.filter((candidate) => candidate.storeKind === 'BACKUP')) {
        for (const category of target.categories.filter((value) => categories.includes(value))) {
          const priorTarget = backupCategoryOwners.get(category);
          if (priorTarget) {
            throw new ConflictException('Overlapping required BACKUP targets share category ' + category
              + '; one sealed provider inventory per category is required before whole-tenant propagation');
          }
          backupCategoryOwners.set(category, target.targetId);
        }
      }
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
          targetIds: targets.map((target) => target.targetId).sort(), copyClassCoverage: copyCoverageManifest,
          copyClassCoverageDigest: copyCoverageDigest,
          backupCopyClassCoverage: backupCopyClassCoverageManifest,
          backupCopyClassCoverageDigest, plans: {},
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
        if (String(currentManifest.copyClassCoverageDigest ?? '') !== copyCoverageDigest) {
          throw new ConflictException('Reviewed copy-class coverage changed; start a separately reviewed propagation run');
        }
        if (String(currentManifest.backupCopyClassCoverageDigest ?? '') !== backupCopyClassCoverageDigest) {
          throw new ConflictException('Reviewed backup copy-class inventory changed; start a separately reviewed propagation run');
        }
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
        if (String(currentManifest.copyClassCoverageDigest ?? '') !== copyCoverageDigest) {
          throw new ConflictException('Reviewed copy-class coverage changed; start a separately reviewed propagation run');
        }
        if (String(currentManifest.backupCopyClassCoverageDigest ?? '') !== backupCopyClassCoverageDigest) {
          throw new ConflictException('Reviewed backup copy-class inventory changed; start a separately reviewed propagation run');
        }
        if (JSON.stringify(previousTargets) !== JSON.stringify(newTargets)) {
          throw new ConflictException('Reviewed external target inventory changed during propagation');
        }
      }
      const receipts = await client.query<PropagationReceiptRow>(
        `SELECT DISTINCT ON (target_id) * FROM saas_tenant_external_propagation_receipts
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 ORDER BY target_id,attempt_no DESC`,
        [tenantId, requestId, run.run_id],
      );
      return { replayed: false, request, run, targets, latestReceipts: receipts.rows, copyCoverageRows: coverageResult.rows, copyCoverageManifest, copyCoverageDigest, backupCopyClassRows: backupCopyClassResult.rows, backupCopyClassCoverageManifest, backupCopyClassCoverageDigest };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-external-propagation:' + tenantId + ':' + requestId });

    if (prepared.replayed) {
      return {
        run: this.mapRun(prepared.run),
        request: { requestId, status: prepared.request.status, version: Number(prepared.request.row_version) },
        wholeTenantErasureVerified: true,
        replayed: true,
      };
    }

    // Acquire every BACKUP category fence after the RUNNING run is durable,
    // but before any adapter inventories or mutates an external store. The
    // coordinator installs/read-backs the provider deny before returning.
    const backupTargets = prepared.targets.filter((target) => target.storeKind === 'BACKUP');
    const backupFenceCategories = [...new Set(backupTargets.flatMap((target) =>
      target.categories.filter((category) => this.parseCategories(prepared.request.categories).includes(category)),
    ))].sort();
    if (backupTargets.length > 0 && !this.backupWriterFenceCoordinator) {
      throw new ServiceUnavailableException('Required backup writer-fence coordinator is not registered; external propagation is halted before provider inventory');
    }
    // Acquire every target's exact scope before entering the adapter loop. Different
    // category targets may use different reviewed provider configuration/adapter bindings.
    for (const target of backupTargets) {
      const targetCategories = [...new Set(target.categories.filter((category) =>
        this.parseCategories(prepared.request.categories).includes(category)))].sort();
      if (targetCategories.length === 0) continue;
      await this.backupWriterFenceCoordinator!.beginPropagationFence({
        tenantId, requestId, requestVersion: Number(prepared.request.version),
        runId: prepared.run.run_id, sourceExportDigest: prepared.request.export_bundle_digest,
        categories: targetCategories, actorUserId,
        configReference: target.configReference, adapterKey: target.adapterKey,
        adapterVersion: this.adapterFor(target).adapterVersion,
      });
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
            tenantId, actorUserId, manifestId: resourceManifestId,
            expectedResourceCount: plan.resources.length, outcomeCode,
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
        if (target.storeKind === 'BACKUP') {
          if (!this.backupWriterFenceCoordinator) {
            throw new ServiceUnavailableException('Backup writer-fence coordinator is unavailable; backup mutation is blocked');
          }
          await this.backupWriterFenceCoordinator.assertFenceHeld({
            tenantId, categories: target.categories.filter((category) => backupFenceCategories.includes(category)),
            configReference: target.configReference, adapterKey: target.adapterKey, adapterVersion: adapter.adapterVersion,
          });
        }
        await this.assertCurrentCopyCoverage(tenantId, actorUserId, context.categories, prepared.targets, prepared.copyCoverageDigest, prepared.backupCopyClassCoverageDigest);
        if (planEntry) {
          const loaded = await this.loadPlanFromManifest({
            tenantId, actorUserId, requestId, runId: prepared.run.run_id,
            sourceExportDigest: prepared.request.export_bundle_digest, target, adapter, planEntry,
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
          this.validatePlan(plan, adapter);
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
          if (target.storeKind === 'BACKUP') {
            await this.backupWriterFenceCoordinator!.assertFenceHeld({
              tenantId, categories: target.categories.filter((category) => backupFenceCategories.includes(category)),
              configReference: target.configReference, adapterKey: target.adapterKey, adapterVersion: adapter.adapterVersion,
            });
          }
          await this.assertCurrentCopyCoverage(tenantId, actorUserId, context.categories, prepared.targets, prepared.copyCoverageDigest, prepared.backupCopyClassCoverageDigest);
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

        await this.assertCurrentCopyCoverage(tenantId, actorUserId, context.categories, prepared.targets, prepared.copyCoverageDigest, prepared.backupCopyClassCoverageDigest);
        const verification = await adapter.verify({ ...context, plan, deletion });
        residualCopies = this.count(verification.residualCopies, 'residualCopies');
        verifiedDigest = this.digestOrNull(verification.verifiedManifestDigest);
        verificationReference = this.reference(verification.verificationReference, 'verificationReference');
        residualManifest = this.residualReferences(verification.residualReferences);
        const verified = verifiedDigest === plan.manifestDigest && deletedCopies === plannedCopies
          && residualCopies === '0' && residualManifest.length === 0;
        if (verified && target.storeKind === 'BACKUP') {
          if (!this.backupWriterFenceCoordinator) {
            throw new ServiceUnavailableException('Backup fence coordinator disappeared after provider verification; the writer gate remains closed');
          }
          const verifiedBackupCategories = target.categories.filter((category) => context.categories.includes(category));
          await this.backupWriterFenceCoordinator.recordPropagationVerification({
            tenantId, categories: verifiedBackupCategories,
            manifestDigest: verifiedDigest!, verificationReference: verificationReference!,
            residualCopies: Number(residualCopies),
            configReference: target.configReference, adapterKey: target.adapterKey, adapterVersion: adapter.adapterVersion,
          });
        }
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
      version: 2, tenantId, requestId, requestVersion: Number(prepared.request.version),
      runId: prepared.run.run_id, sourceExportDigest: prepared.request.export_bundle_digest,
      postgresqlErasureRunId: prepared.request.execution_run_id, postgresqlReceiptScope: 'POSTGRESQL_ONLY',
      copyClassCoverage: prepared.copyCoverageManifest, copyClassCoverageDigest: prepared.copyCoverageDigest,
      backupCopyClassCoverage: prepared.backupCopyClassCoverageManifest,
      backupCopyClassCoverageDigest: prepared.backupCopyClassCoverageDigest,
      targetManifest, plannedCopies: planned.toString(), deletedCopies: deleted.toString(), residualCopies: residual.toString(),
      status: allVerified ? 'VERIFIED' : 'PARTIAL',
      failureCode: allVerified ? null : residual > 0n ? 'EXTERNAL_RESIDUALS_REMAIN' : 'EXTERNAL_VERIFICATION_INCOMPLETE',
    };
    const manifestDigest = this.hash(wholeManifest);
    const status = allVerified ? 'VERIFIED' : 'PARTIAL';
    const failureCode = allVerified ? null : residual > 0n ? 'EXTERNAL_RESIDUALS_REMAIN' : 'EXTERNAL_VERIFICATION_INCOMPLETE';

    const finalized = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const finalCategories = this.parseCategories(prepared.request.categories);
      const finalTargetResult = await client.query<TargetRow>(
        `SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 ORDER BY store_kind,target_id`,
        [tenantId],
      );
      const finalRelevantRows = finalTargetResult.rows.filter((row) =>
        this.parseCategories(row.categories).some((category) => finalCategories.includes(category)));
      const finalTargetsActive = finalRelevantRows.every((row) => row.status === 'ACTIVE' && row.required === true);
      const finalTargets = finalRelevantRows.filter((row) => row.status === 'ACTIVE' && row.required === true).map((row) => this.mapTarget(row));
      const finalCoverageResult = await client.query<CopyCoverageRow>(
        `SELECT DISTINCT ON (category_code,store_kind) *
         FROM public.saas_tenant_external_copy_coverage_decisions
         WHERE tenant_id=$1 AND category_code=ANY($2::text[])
         ORDER BY category_code,store_kind,revision DESC`,
        [tenantId, finalCategories],
      );
      const finalBackupCopyClassResult = await client.query<BackupCopyClassCoverageRow>(
        `SELECT DISTINCT ON (category_code,copy_class_code) *
         FROM public.saas_tenant_backup_copy_class_coverage_decisions
         WHERE tenant_id=$1 AND category_code=ANY($2::text[])
         ORDER BY category_code,copy_class_code,revision DESC`,
        [tenantId, finalCategories],
      );
      let coverageSnapshotValid = finalTargetsActive;
      try {
        await this.assertTargetCoverage(finalCategories, finalTargets, finalCoverageResult.rows);
        this.assertBackupCopyClassCoverage(finalCategories, finalTargets, finalBackupCopyClassResult.rows);
      } catch {
        coverageSnapshotValid = false;
      }
      if (this.hash(this.copyCoverageManifest(finalCoverageResult.rows)) !== prepared.copyCoverageDigest
        || this.hash(this.backupCopyClassCoverageManifest(finalBackupCopyClassResult.rows)) !== prepared.backupCopyClassCoverageDigest
        || this.hash(this.targetBindingManifest(finalTargets, finalCategories))
          !== this.hash(this.targetBindingManifest(prepared.targets, finalCategories))) coverageSnapshotValid = false;
      const canFinalizeVerified = allVerified && coverageSnapshotValid;
      const finalStatus = canFinalizeVerified ? 'VERIFIED' : 'PARTIAL';
      const finalFailureCode = canFinalizeVerified ? null : residual > 0n ? 'EXTERNAL_RESIDUALS_REMAIN'
        : coverageSnapshotValid ? 'EXTERNAL_VERIFICATION_INCOMPLETE' : 'COPY_CLASS_COVERAGE_CHANGED_DURING_RUN';
      const finalManifest = { ...currentManifest, result: { ...wholeManifest, status: finalStatus, failureCode: finalFailureCode } };
      const runUpdate = await client.query<PropagationRunRow>(
        `UPDATE saas_tenant_external_propagation_runs
         SET status=$4,external_manifest=$5::jsonb,manifest_digest=$6,target_count=$7,verified_targets=$8,
             planned_copies=$9,deleted_copies=$10,residual_copies=$11,failure_code=$12,
             finished_at=CASE WHEN $4='VERIFIED' THEN clock_timestamp() ELSE NULL END
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 RETURNING *`,
        [tenantId, requestId, prepared.run.run_id, finalStatus, JSON.stringify(finalManifest),
          canFinalizeVerified ? manifestDigest : null, prepared.targets.length, verifiedTargets.length,
          planned.toString(), deleted.toString(), residual.toString(), finalFailureCode],
      );
      const run = runUpdate.rows[0];
      let request: ErasureRequestRow | undefined;
      if (canFinalizeVerified) {
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
        canFinalizeVerified ? 'TENANT_ERASURE_PROPAGATION_VERIFIED' : 'TENANT_ERASURE_PROPAGATION_PARTIAL',
        prepared.run.run_id, {
          requestId, runId: prepared.run.run_id, status: finalStatus, sourceExportDigest: prepared.request.export_bundle_digest,
          postgresqlReceiptScope: 'POSTGRESQL_ONLY', targetCount: prepared.targets.length,
          verifiedTargets: verifiedTargets.length, plannedCopies: planned.toString(), deletedCopies: deleted.toString(),
          residualCopies: residual.toString(), manifestDigest: canFinalizeVerified ? manifestDigest : null,
          failureCode: finalFailureCode, copyClassCoverageDigest: prepared.copyCoverageDigest,
          backupCopyClassCoverageDigest: prepared.backupCopyClassCoverageDigest,
        });
      return { run, request, wholeTenantErasureVerified: canFinalizeVerified };
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
      wholeTenantErasureVerified: finalized.wholeTenantErasureVerified,
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

  private async persistResourceManifestAndRunPlan(input: {
    tenantId: string;
    actorUserId: string;
    requestId: string;
    requestVersion: number;
    runId: string;
    target: SaasTenantExternalDataTarget;
    plan: SaasExternalPropagationPlan;
    sourceExportDigest: string;
    currentManifest: Record<string, unknown>;
  }): Promise<{ manifestId: string; externalManifest: Record<string, unknown> }> {
    const manifestId = randomUUID();
    const canonicalResources = canonicalizeSaasExternalPropagationResources(input.plan.resources);
    const resourceRows = canonicalResources.map((resource, index) => {
      const identityDigest = this.hash({
        resourceKind: resource.resourceKind,
        resourceReference: resource.resourceReference,
        resourceVersionReference: resource.resourceVersionReference ?? null,
        resourceContentDigest: resource.resourceContentDigest ?? null,
      });
      return {
        resource_ordinal: index + 1,
        resource_kind: resource.resourceKind,
        resource_identity_digest: identityDigest,
        resource_reference: resource.resourceReference,
        resource_version_reference: resource.resourceVersionReference ?? null,
        resource_content_digest: resource.resourceContentDigest ?? null,
        operation_key: 'op.' + this.hash({
          tenantId: input.tenantId, requestId: input.requestId, runId: input.runId,
          targetId: input.target.targetId, sourceExportDigest: input.sourceExportDigest,
          resourceIdentityDigest: identityDigest,
        }),
      };
    });
    const planEntry = {
      resourceManifestId: manifestId,
      manifestDigest: input.plan.manifestDigest,
      plannedCopies: input.plan.plannedCopies,
      planReference: input.plan.planReference,
      storeKind: input.target.storeKind,
      adapterKey: input.target.adapterKey,
      configReference: input.target.configReference,
      adapterVersion: input.plan.adapterVersion,
      resourceClass: input.plan.resourceClass,
    };
    const externalManifest = {
      ...input.currentManifest,
      plans: {
        ...this.jsonObject(input.currentManifest.plans ?? {}),
        [input.target.targetId]: planEntry,
      },
    };

    await this.database.transaction(async (client) => {
      await this.lockTenant(client, input.tenantId);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO saas_tenant_external_propagation_manifests
         (tenant_id,id,request_id,run_id,request_version,target_id,store_kind,adapter_key,adapter_version,
          resource_class,max_page_size,max_batch_size,source_export_digest,manifest_digest,resource_count,
          policy_versions,created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
         RETURNING id::text AS id`,
        [input.tenantId, manifestId, input.requestId, input.runId, input.requestVersion,
          input.target.targetId, input.target.storeKind, input.target.adapterKey, input.plan.adapterVersion,
          input.plan.resourceClass, input.plan.maxPageSize, input.plan.maxBatchSize,
          input.sourceExportDigest, input.plan.manifestDigest, resourceRows.length,
          JSON.stringify(input.plan.policyVersions), input.actorUserId],
      );
      if (!inserted.rows[0]) throw new ServiceUnavailableException('Resource manifest creation was not acknowledged');

      for (let offset = 0; offset < resourceRows.length; offset += input.plan.maxBatchSize) {
        const batch = resourceRows.slice(offset, offset + input.plan.maxBatchSize);
        await client.query(
          `INSERT INTO saas_tenant_external_propagation_manifest_items
           (tenant_id,manifest_id,resource_ordinal,resource_kind,resource_identity_digest,
            resource_reference,resource_version_reference,resource_content_digest,operation_key)
           SELECT $1,$2,x.resource_ordinal,x.resource_kind,x.resource_identity_digest,
                  x.resource_reference,x.resource_version_reference,x.resource_content_digest,x.operation_key
           FROM jsonb_to_recordset($3::jsonb) AS x(
             resource_ordinal integer,resource_kind text,resource_identity_digest text,
             resource_reference text,resource_version_reference text,resource_content_digest text,operation_key text
           )
           ORDER BY x.resource_ordinal`,
          [input.tenantId, manifestId, JSON.stringify(batch)],
        );
      }

      const sealed = await client.query<{ id: string }>(
        `UPDATE saas_tenant_external_propagation_manifests SET state='SEALED'
         WHERE tenant_id=$1 AND id=$2 AND state='STAGING' RETURNING id::text AS id`,
        [input.tenantId, manifestId],
      );
      if (!sealed.rows[0]) throw new ServiceUnavailableException('Resource manifest could not be durably sealed');

      if (resourceRows.length > 0) {
        await this.insertResourceEventsWithClient(client, {
          tenantId: input.tenantId, manifestId, expectedResourceCount: resourceRows.length,
          outcomeCode: 'PREPARED', providerReceiptReference: null, verificationReference: null,
          verifiedManifestDigest: null, residualCount: '0', failureCode: null, residualReason: null,
        });
      }

      const runUpdated = await client.query<{ run_id: string }>(
        `UPDATE saas_tenant_external_propagation_runs SET external_manifest=$4::jsonb
         WHERE tenant_id=$1 AND request_id=$2 AND run_id=$3 AND status='RUNNING'
         RETURNING run_id::text AS run_id`,
        [input.tenantId, input.requestId, input.runId, JSON.stringify(externalManifest)],
      );
      if (!runUpdated.rows[0]) {
        throw new ConflictException('Propagation run stopped before its sealed resource manifest could be attached');
      }
    }, { tenantId: input.tenantId, userId: input.actorUserId,
      advisoryLockKey: 'saas-resource-manifest:' + input.tenantId + ':' + input.runId + ':' + input.target.targetId });

    return { manifestId, externalManifest };
  }

  private async appendResourceEvents(input: {
    tenantId: string;
    actorUserId: string;
    manifestId: string;
    expectedResourceCount: number;
    outcomeCode: 'PREPARED' | 'DELETE_REQUESTED' | 'DELETED' | 'VERIFIED' | 'FAILED_RETRYABLE';
    providerReceiptReference: string | null;
    verificationReference: string | null;
    verifiedManifestDigest: string | null;
    residualCount: string;
    failureCode: string | null;
    residualReason: string | null;
  }) {
    await this.database.transaction(async (client) => {
      await this.lockTenant(client, input.tenantId);
      await this.insertResourceEventsWithClient(client, input);
    }, { tenantId: input.tenantId, userId: input.actorUserId,
      advisoryLockKey: 'saas-resource-events:' + input.tenantId + ':' + input.manifestId });
  }

  private async insertResourceEventsWithClient(
    client: PoolClient,
    input: {
      tenantId: string;
      manifestId: string;
      expectedResourceCount: number;
      outcomeCode: 'PREPARED' | 'DELETE_REQUESTED' | 'DELETED' | 'VERIFIED' | 'FAILED_RETRYABLE';
      providerReceiptReference: string | null;
      verificationReference: string | null;
      verifiedManifestDigest: string | null;
      residualCount: string;
      failureCode: string | null;
      residualReason: string | null;
    },
  ) {
    const result = await client.query<{ inserted_count: string | number }>(
      `WITH latest AS (
         SELECT DISTINCT ON (e.resource_id) e.resource_id,e.attempt_no,e.event_no,e.outcome_code
         FROM saas_tenant_external_propagation_resource_events e
         WHERE e.tenant_id=$1 AND e.manifest_id=$2
         ORDER BY e.resource_id,e.attempt_no DESC,e.event_no DESC
       ), inserted AS (
         INSERT INTO saas_tenant_external_propagation_resource_events
           (tenant_id,manifest_id,resource_id,resource_identity_digest,manifest_digest,
            attempt_no,event_no,outcome_code,provider_receipt_reference,verification_reference,
            verified_manifest_digest,residual_count,failure_code,residual_reason)
         SELECT i.tenant_id,i.manifest_id,i.id,i.resource_identity_digest,m.manifest_digest,
           CASE WHEN latest.resource_id IS NULL THEN 1
                WHEN $3='PREPARED' AND latest.outcome_code='FAILED_RETRYABLE' THEN latest.attempt_no+1
                ELSE latest.attempt_no END,
           CASE WHEN latest.resource_id IS NULL
                  OR ($3='PREPARED' AND latest.outcome_code='FAILED_RETRYABLE') THEN 1
                ELSE latest.event_no+1 END,
           $3,$4,$5,$6,$7,$8,$9
         FROM saas_tenant_external_propagation_manifest_items i
         JOIN saas_tenant_external_propagation_manifests m
           ON m.tenant_id=i.tenant_id AND m.id=i.manifest_id AND m.state='SEALED'
         LEFT JOIN latest ON latest.resource_id=i.id
         WHERE i.tenant_id=$1 AND i.manifest_id=$2
         ORDER BY i.resource_ordinal
         RETURNING id
       )
       SELECT count(*)::integer AS inserted_count FROM inserted`,
      [input.tenantId, input.manifestId, input.outcomeCode, input.providerReceiptReference,
        input.verificationReference, input.verifiedManifestDigest, input.residualCount,
        input.failureCode, input.residualReason],
    );
    const insertedCount = Number(result.rows[0]?.inserted_count ?? 0);
    if (insertedCount !== input.expectedResourceCount) {
      throw new ServiceUnavailableException('Per-resource erasure event was not appended for every manifest identity');
    }
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
  private async assertTargetCoverage(
    categories: SaasTransferDatasetCategory[],
    targets: SaasTenantExternalDataTarget[],
    decisions: CopyCoverageRow[],
  ): Promise<void> {
    const latest = new Map(decisions.map((decision) => [decision.category_code + ':' + decision.store_kind, decision]));
    for (const category of categories) for (const kind of EXTERNAL_COPY_COVERAGE_STORE_KINDS) {
      const decision = latest.get(category + ':' + kind);
      const evidenceAge = decision ? Date.now() - new Date(decision.evidence_at).getTime() : Number.POSITIVE_INFINITY;
      if (!decision || decision.status !== 'ACCEPTED' || !decision.reviewed_by_user_id
        || decision.reviewed_by_user_id === decision.submitted_by_user_id || !decision.valid_until
        || new Date(decision.valid_until).getTime() <= Date.now()
        || evidenceAge < -5 * 60 * 1000 || evidenceAge > 30 * 24 * 60 * 60 * 1000
        || !HEX_DIGEST.test(decision.evidence_sha256) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(decision.evidence_reference)
        || !SAFE_REFERENCE.test(decision.data_owner_reference) || !SAFE_REFERENCE.test(decision.infrastructure_owner_reference)
        || !SAFE_REFERENCE.test(decision.policy_reference)
        || !decision.attestation_key_id || !decision.attestation_owner_reference || !decision.attestation_signature) {
        throw new ConflictException('External propagation requires current independently reviewed signed copy-class coverage for ' + category + '/' + kind);
      }
      const attestation: ExternalCopyCoverageEvidenceAttestationPayload = {
        attestationKeyId: decision.attestation_key_id,
        attestationOwnerReference: decision.attestation_owner_reference,
        tenantId: decision.tenant_id,
        categoryCode: decision.category_code,
        storeKind: decision.store_kind,
        disposition: decision.disposition,
        evidenceReference: decision.evidence_reference,
        evidenceSha256: decision.evidence_sha256,
        evidenceAt: new Date(decision.evidence_at).toISOString(),
        dataOwnerReference: decision.data_owner_reference,
        infrastructureOwnerReference: decision.infrastructure_owner_reference,
        policyReference: decision.policy_reference,
        reason: decision.reason,
      };
      try {
        // The deployment trust store is read on each preflight, resume and provider checkpoint.
        verifyExternalCopyCoverageEvidenceAttestation(attestation, decision.attestation_signature);
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        throw new ConflictException('External copy-coverage evidence attestation is invalid or its signer is no longer trusted for '
          + category + '/' + kind);
      }
      // Re-read the exact evidence bytes at preflight, recovery and provider checkpoints.
      if (kind === UNCLASSIFIED_EXTERNAL_STORE_KIND) {
        if (decision.disposition !== 'NOT_APPLICABLE') {
          throw new ConflictException('An unclassified external store type was discovered or remains unresolved; classify it and submit a new signed coverage revision before propagation: ' + category);
        }
        const inventoryArtifact = await this.backupEvidenceArtifactReader.readVerifiedArtifact(
          decision.evidence_reference, decision.evidence_sha256,
        );
        try {
          validateExternalStoreInventoryManifest(inventoryArtifact.bytes, decision.tenant_id, category);
        } catch (error) {
          if (error instanceof ServiceUnavailableException) throw error;
          throw new ConflictException('UNCLASSIFIED_EXTERNAL_STORE coverage lacks a complete, current, scope-bound external inventory manifest for ' + category);
        }
        // The catch-all is governance evidence only and never an executable adapter.
        continue;
      }
      await this.backupEvidenceArtifactReader.verifyArtifact(decision.evidence_reference, decision.evidence_sha256);
      if (decision.disposition === 'UNRESOLVED') {
        throw new ConflictException('Unresolved external copy class blocks whole-tenant erasure: ' + category + '/' + kind);
      }
      const matching = targets.filter((target) => target.storeKind === kind && target.categories.includes(category));
      if (decision.disposition === 'SUPPORTED' && matching.length === 0) {
        throw new ConflictException('Copy class is marked supported but has no active required target: ' + category + '/' + kind);
      }
      if (decision.disposition === 'NOT_APPLICABLE' && matching.length > 0) {
        throw new ConflictException('Copy class is marked not applicable while a required target is configured: ' + category + '/' + kind);
      }
    }
  }

  private copyCoverageManifest(decisions: CopyCoverageRow[]): Array<Record<string, unknown>> {
    return decisions.map((d) => ({
      decisionId: d.decision_id, categoryCode: d.category_code, storeKind: d.store_kind,
      revision: String(d.revision), disposition: d.disposition, status: d.status,
      evidenceReference: d.evidence_reference, evidenceSha256: d.evidence_sha256,
      evidenceAt: new Date(d.evidence_at).toISOString(), attestationKeyId: d.attestation_key_id,
      attestationOwnerReference: d.attestation_owner_reference, attestationSignature: d.attestation_signature,
      dataOwnerReference: d.data_owner_reference, infrastructureOwnerReference: d.infrastructure_owner_reference,
      policyReference: d.policy_reference, reason: d.reason,
      submittedByUserId: d.submitted_by_user_id, reviewedByUserId: d.reviewed_by_user_id,
      validUntil: d.valid_until ? new Date(d.valid_until).toISOString() : null,
    })).sort((a, b) => {
      const left = String(a.categoryCode) + ':' + String(a.storeKind);
      const right = String(b.categoryCode) + ':' + String(b.storeKind);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  private targetBindingManifest(targets: SaasTenantExternalDataTarget[], categories: SaasTransferDatasetCategory[]) {
    return targets.map((t) => ({
      targetId: t.targetId, storeKind: t.storeKind, adapterKey: t.adapterKey, configReference: t.configReference,
      required: t.required, categories: t.categories.filter((c) => categories.includes(c)).sort(),
    })).sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0);
  }

  private async assertBackupCopyClassCoverage(
    categories: SaasTransferDatasetCategory[],
    targets: SaasTenantExternalDataTarget[],
    decisions: BackupCopyClassCoverageRow[],
  ): Promise<void> {
    const latest = new Map(decisions.map((decision) => [decision.category_code + ':' + decision.copy_class_code, decision]));
    for (const category of categories) {
      for (const copyClass of REQUIRED_BACKUP_COPY_CLASSES) {
        const decision = latest.get(category + ':' + copyClass);
        const evidenceAge = decision ? Date.now() - new Date(decision.evidence_at).getTime() : Number.POSITIVE_INFINITY;
        if (!decision || decision.status !== 'ACCEPTED' || !decision.reviewed_by_user_id
          || decision.reviewed_by_user_id === decision.submitted_by_user_id || !decision.valid_until
          || new Date(decision.valid_until).getTime() <= Date.now()
          || evidenceAge < -5 * 60 * 1000 || evidenceAge > 30 * 24 * 60 * 60 * 1000
          || !HEX_DIGEST.test(decision.evidence_sha256)
          || !SAFE_REFERENCE.test(decision.evidence_reference)
          || !SAFE_REFERENCE.test(decision.data_owner_reference)
          || !SAFE_REFERENCE.test(decision.infrastructure_owner_reference)
          || !SAFE_REFERENCE.test(decision.policy_reference)
          || !decision.attestation_key_id || !decision.attestation_owner_reference || !decision.attestation_signature) {
          throw new ConflictException('Backup propagation requires current independently reviewed evidence for ' + category + '/' + copyClass);
        }
        const attestation: BackupCopyClassEvidenceAttestationPayload = {
          attestationKeyId: decision.attestation_key_id,
          attestationOwnerReference: decision.attestation_owner_reference,
          tenantId: decision.tenant_id,
          categoryCode: decision.category_code,
          copyClassCode: decision.copy_class_code,
          disposition: decision.disposition,
          evidenceReference: decision.evidence_reference,
          evidenceSha256: decision.evidence_sha256,
          evidenceAt: new Date(decision.evidence_at).toISOString(),
          dataOwnerReference: decision.data_owner_reference,
          infrastructureOwnerReference: decision.infrastructure_owner_reference,
          policyReference: decision.policy_reference,
          reason: decision.reason,
        };
        try {
          // Recheck the deployment trust store on every run/resume/provider checkpoint.
          // Removing or rotating a compromised key invalidates the old accepted evidence.
          verifyBackupCopyClassEvidenceAttestation(attestation, decision.attestation_signature);
        } catch (error) {
          if (error instanceof ServiceUnavailableException) throw error;
          throw new ConflictException('Backup copy-class evidence attestation is invalid or its signer is no longer trusted for '
            + category + '/' + copyClass);
        }
        // Re-read source bytes at every preflight/resume/provider checkpoint. A once-valid
        // reference cannot silently disappear or be replaced by a different evidence pack.
        await this.backupEvidenceArtifactReader.verifyArtifact(decision.evidence_reference, decision.evidence_sha256);
        if (decision.disposition === 'UNRESOLVED') {
          throw new ConflictException('Unresolved backup copy class blocks whole-tenant erasure: ' + category + '/' + copyClass);
        }
        if (copyClass === 'S3_OBJECT_VERSIONS') {
          const s3Targets = targets.filter((target) => target.storeKind === 'BACKUP'
            && target.categories.includes(category)
            && target.adapterKey === S3_BACKUP_COPY_CLASS_ADAPTER_KEY);
          if (decision.disposition !== 'SUPPORTED' || s3Targets.length === 0) {
            throw new ConflictException('S3 object-version coverage must bind the active S3 tenant-backup adapter for ' + category);
          }
        } else if (decision.disposition === 'SUPPORTED') {
          throw new ConflictException('No reviewed erasure adapter is registered for backup copy class ' + copyClass
            + '; keep it unresolved or prove it is not applicable until a class-specific adapter is accepted');
        }
      }
    }
  }

  private backupCopyClassCoverageManifest(decisions: BackupCopyClassCoverageRow[]): Array<Record<string, unknown>> {
    return decisions.map((decision) => ({
      decisionId: decision.decision_id,
      categoryCode: decision.category_code,
      copyClassCode: decision.copy_class_code,
      revision: String(decision.revision),
      disposition: decision.disposition,
      status: decision.status,
      evidenceReference: decision.evidence_reference,
      evidenceSha256: decision.evidence_sha256,
      evidenceAt: new Date(decision.evidence_at).toISOString(),
      attestationKeyId: decision.attestation_key_id,
      attestationOwnerReference: decision.attestation_owner_reference,
      attestationSignatureSha256: createHash('sha256').update(decision.attestation_signature, 'utf8').digest('hex'),
      dataOwnerReference: decision.data_owner_reference,
      infrastructureOwnerReference: decision.infrastructure_owner_reference,
      policyReference: decision.policy_reference,
      submittedByUserId: decision.submitted_by_user_id,
      reviewedByUserId: decision.reviewed_by_user_id,
      validUntil: decision.valid_until ? new Date(decision.valid_until).toISOString() : null,
    })).sort((left, right) => {
      const a = String(left.categoryCode) + ':' + String(left.copyClassCode);
      const b = String(right.categoryCode) + ':' + String(right.copyClassCode);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  private async assertCurrentCopyCoverage(tenantId: string, actorUserId: string,
    categories: SaasTransferDatasetCategory[], expectedTargets: SaasTenantExternalDataTarget[],
    expectedCoverageDigest: string, expectedBackupCopyClassCoverageDigest: string) {
    const current = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const targetResult = await client.query<TargetRow>(
        'SELECT * FROM saas_tenant_external_data_targets WHERE tenant_id=$1 ORDER BY store_kind,target_id',
        [tenantId],
      );
      const relevant = targetResult.rows.filter((row) => this.parseCategories(row.categories).some((c) => categories.includes(c)));
      if (relevant.some((row) => row.status !== 'ACTIVE' || row.required !== true)) throw new ConflictException('A required external target changed state during propagation');
      const targets = relevant.map((row) => this.mapTarget(row));
      const result = await client.query<CopyCoverageRow>(
        'SELECT DISTINCT ON (category_code,store_kind) * FROM public.saas_tenant_external_copy_coverage_decisions WHERE tenant_id=$1 AND category_code=ANY($2::text[]) ORDER BY category_code,store_kind,revision DESC',
        [tenantId, categories],
      );
      await this.assertTargetCoverage(categories, targets, result.rows);
      const backupCopyClasses = await client.query<BackupCopyClassCoverageRow>(
        'SELECT DISTINCT ON (category_code,copy_class_code) * FROM public.saas_tenant_backup_copy_class_coverage_decisions WHERE tenant_id=$1 AND category_code=ANY($2::text[]) ORDER BY category_code,copy_class_code,revision DESC',
        [tenantId, categories],
      );
      await this.assertBackupCopyClassCoverage(categories, targets, backupCopyClasses.rows);
      return {
        coverageDigest: this.hash(this.copyCoverageManifest(result.rows)),
        backupCopyClassCoverageDigest: this.hash(this.backupCopyClassCoverageManifest(backupCopyClasses.rows)),
        targetsDigest: this.hash(this.targetBindingManifest(targets, categories)),
      };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-copy-class-coverage-check:' + tenantId });
    if (current.coverageDigest !== expectedCoverageDigest
      || current.backupCopyClassCoverageDigest !== expectedBackupCopyClassCoverageDigest
      || current.targetsDigest !== this.hash(this.targetBindingManifest(expectedTargets, categories))) {
      throw new ConflictException('Copy-class coverage or required target inventory changed during propagation; provider mutation is blocked');
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
  private validatePlan(
    plan: SaasExternalPropagationPlan,
    adapter?: SaasTenantExternalDataPropagationAdapter,
  ) {
    if (!plan || typeof plan !== 'object' || !HEX_DIGEST.test(plan.manifestDigest)) {
      throw new ConflictException('Adapter plan must include a SHA-256 resource identity manifest digest');
    }
    this.count(plan.plannedCopies, 'plannedCopies');
    this.reference(plan.planReference, 'planReference');
    if (typeof plan.adapterVersion !== 'string'
      || !/^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$/.test(plan.adapterVersion)) {
      throw new ConflictException('Adapter plan must pin a semantic adapter version');
    }
    if (adapter && (typeof adapter.adapterVersion !== 'string'
      || !/^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$/.test(adapter.adapterVersion)
      || plan.adapterVersion !== adapter.adapterVersion)) {
      throw new ConflictException('Sealed resource manifest adapter version differs from the running adapter implementation');
    }
    if (typeof plan.resourceClass !== 'string'
      || !/^[A-Za-z][A-Za-z0-9._:-]{0,31}$/.test(plan.resourceClass)) {
      throw new ConflictException('Adapter plan resourceClass has an invalid format');
    }
    if (!Number.isSafeInteger(plan.maxPageSize) || plan.maxPageSize < 1 || plan.maxPageSize > 5000
      || !Number.isSafeInteger(plan.maxBatchSize) || plan.maxBatchSize < 1 || plan.maxBatchSize > 1000) {
      throw new ConflictException('Adapter plan enumeration and database batch limits exceed the supported bounds');
    }
    if (!plan.policyVersions || typeof plan.policyVersions !== 'object' || Array.isArray(plan.policyVersions)
      || Buffer.byteLength(JSON.stringify(plan.policyVersions), 'utf8') > 16384) {
      throw new ConflictException('Adapter plan policyVersions must be a bounded object');
    }
    for (const [key, value] of Object.entries(plan.policyVersions)) {
      if (!/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(key) || typeof value !== 'string'
        || value.length < 1 || value.length > 100
        || /(secret|password|credential|access[-_]?key|token)/i.test(key + ':' + value)) {
        throw new ConflictException('Adapter plan policyVersions may contain only bounded non-secret labels');
      }
    }
    if (!Array.isArray(plan.resources) || plan.resources.length > 100000) {
      throw new ConflictException('Adapter plan resources must contain at most 100,000 identities per target');
    }
    if (BigInt(this.count(plan.plannedCopies, 'plannedCopies')) !== BigInt(plan.resources.length)) {
      throw new ConflictException('Adapter plannedCopies must exactly equal the enumerable resource identity count');
    }
    const seenIdentityDigests = new Set<string>();
    for (const resource of plan.resources) {
      if (!resource || typeof resource !== 'object'
        || typeof resource.resourceKind !== 'string'
        || !/^[A-Za-z][A-Za-z0-9._:-]{0,31}$/.test(resource.resourceKind)) {
        throw new ConflictException('Adapter resource identity has an invalid resourceKind');
      }
      this.resourceReference(resource.resourceReference, 'resourceReference', 500);
      if (resource.resourceVersionReference !== undefined && resource.resourceVersionReference !== null) {
        this.resourceReference(resource.resourceVersionReference, 'resourceVersionReference', 200);
      }
      if (resource.resourceContentDigest !== undefined && resource.resourceContentDigest !== null
        && !HEX_DIGEST.test(resource.resourceContentDigest)) {
        throw new ConflictException('Adapter resourceContentDigest must be a SHA-256 hex digest');
      }
      const identityDigest = this.hash({
        resourceKind: resource.resourceKind,
        resourceReference: resource.resourceReference,
        resourceVersionReference: resource.resourceVersionReference ?? null,
        resourceContentDigest: resource.resourceContentDigest ?? null,
      });
      if (seenIdentityDigests.has(identityDigest)) {
        throw new ConflictException('Adapter resource manifest contains duplicate provider identities');
      }
      seenIdentityDigests.add(identityDigest);
    }
    if (Buffer.byteLength(JSON.stringify(plan.resources), 'utf8') > 32 * 1024 * 1024) {
      throw new ConflictException('Adapter plan resource identities must not exceed 32 MiB');
    }
    if (digestSaasExternalPropagationResources(plan.resources) !== plan.manifestDigest) {
      throw new ConflictException('Adapter manifest digest does not match the canonical resource identity set');
    }
  }

  private async loadPlanFromManifest(input: {
    tenantId: string;
    actorUserId: string;
    requestId: string;
    runId: string;
    sourceExportDigest: string;
    target: SaasTenantExternalDataTarget;
    adapter: SaasTenantExternalDataPropagationAdapter;
    planEntry: unknown;
  }): Promise<{
    plan: SaasExternalPropagationPlan;
    manifestId: string;
    latestOutcome: string | null;
    providerReceiptReference: string | null;
  }> {
    const entry = this.jsonObject(input.planEntry);
    const manifestId = this.uuid(entry.resourceManifestId, 'resourceManifestId');
    const planReference = this.reference(entry.planReference, 'planReference');
    const result = await this.database.query<QueryResultRow & {
      manifest_id: string; manifest_digest: string; resource_count: string | number;
      source_export_digest: string; store_kind: string; adapter_key: string; adapter_version: string;
      resource_class: string; max_page_size: number; max_batch_size: number;
      policy_versions: Record<string, unknown> | string;
      resource_id: string | null; resource_kind: string | null; resource_reference: string | null;
      resource_version_reference: string | null; resource_content_digest: string | null;
      latest_outcome: string | null;
      provider_receipt_reference: string | null;
    }>(
      `SELECT m.id::text AS manifest_id,m.manifest_digest,m.resource_count,m.source_export_digest,
              m.store_kind,m.adapter_key,m.adapter_version,m.resource_class,m.max_page_size,m.max_batch_size,
              m.policy_versions,
              i.id::text AS resource_id,i.resource_kind,i.resource_reference,i.resource_version_reference,
              i.resource_content_digest,latest.outcome_code AS latest_outcome,latest.provider_receipt_reference
       FROM saas_tenant_external_propagation_manifests m
       LEFT JOIN saas_tenant_external_propagation_manifest_items i
         ON i.tenant_id=m.tenant_id AND i.manifest_id=m.id
       LEFT JOIN LATERAL (
         SELECT e.outcome_code,e.provider_receipt_reference
         FROM saas_tenant_external_propagation_resource_events e
         WHERE e.tenant_id=i.tenant_id AND e.manifest_id=i.manifest_id AND e.resource_id=i.id
         ORDER BY e.attempt_no DESC,e.event_no DESC LIMIT 1
       ) latest ON true
       WHERE m.tenant_id=$1 AND m.id=$2::uuid AND m.request_id=$3::uuid
         AND m.run_id=$4::uuid AND m.target_id=$5 AND m.state='SEALED'
       ORDER BY i.resource_ordinal`,
      [input.tenantId, manifestId, input.requestId, input.runId, input.target.targetId],
      { tenantId: input.tenantId, userId: input.actorUserId },
    );
    if (!result.rows.length) throw new ConflictException('Persisted resource manifest is missing or is not SEALED');
    const row = result.rows[0]!;
    if (row.source_export_digest !== input.sourceExportDigest
      || row.store_kind !== input.target.storeKind
      || row.adapter_key !== input.target.adapterKey
      || String(entry.storeKind) !== input.target.storeKind
      || String(entry.adapterKey) !== input.target.adapterKey
      || String(entry.configReference) !== input.target.configReference
      || String(entry.manifestDigest) !== row.manifest_digest
      || String(entry.plannedCopies) !== String(row.resource_count)
      || String(entry.resourceManifestId) !== row.manifest_id) {
      throw new ConflictException('Stored plan metadata does not bind to the approved target and exact source export');
    }
    const resources: SaasExternalPropagationResourceIdentity[] = result.rows
      .filter((resource) => resource.resource_id !== null)
      .map((resource) => ({
        resourceKind: String(resource.resource_kind),
        resourceReference: String(resource.resource_reference),
        resourceVersionReference: resource.resource_version_reference === null
          ? null : String(resource.resource_version_reference),
        resourceContentDigest: resource.resource_content_digest === null
          ? null : String(resource.resource_content_digest),
      }));
    const resourceEventStates = result.rows
      .filter((resource) => resource.resource_id !== null)
      .map((resource) => resource.latest_outcome);
    const distinctStates = [...new Set(resourceEventStates)];
    if (distinctStates.length > 1) {
      throw new ConflictException('Per-resource ledger is inconsistent: items do not share one resumable state');
    }
    if (resourceEventStates.some((state) => state === null)) {
      throw new ConflictException('Per-resource ledger is incomplete: one or more identities lack execution evidence');
    }
    const providerReceiptReferences = [...new Set(result.rows
      .filter((resource) => resource.resource_id !== null && resource.provider_receipt_reference !== null)
      .map((resource) => String(resource.provider_receipt_reference)))];
    if (providerReceiptReferences.length > 1) {
      throw new ConflictException('Per-resource ledger has conflicting provider receipt references');
    }
    const decodedPolicyVersions = this.jsonObject(row.policy_versions);
    const policyVersions: Record<string, string> = {};
    for (const [key, value] of Object.entries(decodedPolicyVersions)) {
      if (typeof value !== 'string') {
        throw new ConflictException('Stored policy version labels are malformed');
      }
      policyVersions[key] = value;
    }
    const plan: SaasExternalPropagationPlan = {
      manifestDigest: row.manifest_digest,
      plannedCopies: String(row.resource_count),
      planReference,
      adapterVersion: row.adapter_version,
      resourceClass: row.resource_class,
      maxPageSize: Number(row.max_page_size),
      maxBatchSize: Number(row.max_batch_size),
      policyVersions,
      resources,
    };
    this.validatePlan(plan, input.adapter);
    if (entry.adapterVersion !== undefined && String(entry.adapterVersion) !== plan.adapterVersion) {
      throw new ConflictException('Stored adapter version does not match the sealed resource manifest');
    }
    return {
      plan, manifestId,
      latestOutcome: resourceEventStates[0] ?? null,
      providerReceiptReference: providerReceiptReferences[0] ?? null,
    };
  }

  private resourceReference(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
      || !SAFE_RESOURCE_REFERENCE.test(value) || value.includes('://')
      || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
      throw new ConflictException(field + ' must be an opaque, bounded, non-secret provider identity');
    }
    return value;
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
