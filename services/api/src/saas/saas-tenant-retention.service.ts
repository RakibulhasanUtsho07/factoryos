import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { CreateSaasRetentionPolicyDto } from './dto/create-saas-retention-policy.dto';
import { CreateSaasDataLegalHoldDto } from './dto/create-saas-data-legal-hold.dto';
import { ReleaseSaasDataLegalHoldDto } from './dto/release-saas-data-legal-hold.dto';
import { CreateSaasTenantErasureRequestDto } from './dto/create-saas-tenant-erasure-request.dto';
import { CreateSaasExportPreservationAttestationDto } from './dto/create-saas-export-preservation-attestation.dto';
import {
  ReviewSaasTenantErasureRequestDto,
  SaasTenantErasureReviewDecision,
} from './dto/review-saas-tenant-erasure-request.dto';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

type HoldStatus = 'ACTIVE' | 'RELEASED';
type ErasureStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED';

interface RetentionPolicyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  category_code: SaasTransferDatasetCategory;
  version: string | number;
  retention_days: number;
  disposition: 'DELETE' | 'ANONYMIZE' | 'REVIEW';
  legal_basis: string;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  created_by_user_id: string;
  created_at: string;
}

interface LegalHoldRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  categories: SaasTransferDatasetCategory[] | string;
  status: HoldStatus;
  case_reference: string;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  created_by_user_id: string;
  created_at: string;
  released_by_user_id: string | null;
  released_at: string | null;
  release_reason: string | null;
  row_version: number;
  updated_at: string;
}

interface ExportPreservationAttestationRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  transfer_id: string;
  transfer_version: string | number;
  bundle_digest: string;
  verification_method: string;
  verification_reference: string;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  verified_by_user_id: string;
  verified_at: string;
  created_at: string;
}

interface ErasureRequestRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  request_id: string;
  version: string | number;
  status: ErasureStatus;
  categories: SaasTransferDatasetCategory[] | string;
  export_transfer_id: string;
  export_transfer_version: string | number;
  export_bundle_digest: string;
  reason: string;
  requested_by_user_id: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  idempotency_key: string;
  request_hash: string;
  row_version: number;
  created_at: string;
  updated_at: string;
}

const CATEGORIES = Object.values(SaasTransferDatasetCategory);

@Injectable()
export class SaasTenantRetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createPolicy(tenantId: string, actorUserId: string, input: CreateSaasRetentionPolicyDto) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const category = this.category(input?.category_code);
    const retentionDays = this.integer(input?.retention_days, 'retention_days', 1, 36500);
    const disposition = input?.disposition;
    if (!['DELETE', 'ANONYMIZE', 'REVIEW'].includes(disposition)) {
      throw new BadRequestException('disposition is invalid');
    }
    const legalBasis = this.requiredString(input?.legal_basis, 'legal_basis', 200, 3);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'RETENTION_POLICY', category, retentionDays, disposition, legalBasis, reason });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<RetentionPolicyRow>(
        'SELECT * FROM saas_tenant_data_retention_policies WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for another retention policy request');
        return { row: replay.rows[0], replayed: true };
      }
      const latest = await client.query<{ version: string | number }>(
        'SELECT version FROM saas_tenant_data_retention_policies WHERE tenant_id=$1 AND category_code=$2 ORDER BY version DESC LIMIT 1',
        [tenantId, category],
      );
      const version = latest.rows[0] ? Number(latest.rows[0].version) + 1 : 1;
      const inserted = await client.query<RetentionPolicyRow>(
        `INSERT INTO saas_tenant_data_retention_policies
         (tenant_id, category_code, version, retention_days, disposition, legal_basis, reason,
          idempotency_key, request_hash, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [tenantId, category, version, retentionDays, disposition, legalBasis, reason, idempotencyKey, requestHash, actorUserId],
      );
      const row = inserted.rows[0];
      await this.audit(client, tenantId, actorUserId, 'RETENTION_POLICY_VERSION_CREATED', row.id, {
        category, version, retentionDays, disposition,
      });
      return { row, replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-retention:' + tenantId });
    return { policy: this.mapPolicy(result.row), replayed: result.replayed };
  }

  async listPolicies(tenantId: string, actorUserId: string) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const result = await this.database.query<RetentionPolicyRow>(
      `SELECT DISTINCT ON (category_code) *
       FROM saas_tenant_data_retention_policies
       WHERE tenant_id=$1
       ORDER BY category_code, version DESC`,
      [tenantId],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapPolicy(row)), count: result.rows.length };
  }

  async createLegalHold(tenantId: string, actorUserId: string, input: CreateSaasDataLegalHoldDto) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const categories = this.categories(input?.categories);
    const caseReference = this.caseReference(input?.case_reference);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'LEGAL_HOLD', categories, caseReference, reason });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<LegalHoldRow>(
        'SELECT * FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for another legal hold request');
        return { row: replay.rows[0], replayed: true };
      }

      // The tenant row lock above serializes this check against starting a new
      // propagation run. The database trigger repeats the same fence for direct
      // SQL writers, so this query supplies a clean conflict instead of relying
      // on the trigger's defensive SQLSTATE alone.
      const runningPropagation = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
        `SELECT categories
         FROM saas_tenant_external_propagation_runs
         WHERE tenant_id=$1 AND status='RUNNING'
         FOR SHARE`,
        [tenantId],
      );
      if (runningPropagation.rows.some((run) =>
        this.categoriesOverlap(categories, this.parseCategories(run.categories)))) {
        throw new ConflictException('Cannot create an overlapping legal hold while external erasure propagation is running');
      }

      const inserted = await client.query<LegalHoldRow>(
        `INSERT INTO saas_tenant_data_legal_holds
         (tenant_id, categories, case_reference, reason, idempotency_key, request_hash, created_by_user_id)
         VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7) RETURNING *`,
        [tenantId, JSON.stringify(categories), caseReference, reason, idempotencyKey, requestHash, actorUserId],
      );
      const row = inserted.rows[0];
      await this.audit(client, tenantId, actorUserId, 'LEGAL_HOLD_CREATED', row.id, { categories, caseReference });
      return { row, replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-retention:' + tenantId });
    return { hold: this.mapHold(result.row), replayed: result.replayed };
  }

  async listLegalHolds(tenantId: string, actorUserId: string, rawStatus?: string, rawLimit?: string) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const status = rawStatus?.trim().toUpperCase() || null;
    if (status && status !== 'ACTIVE' && status !== 'RELEASED') {
      throw new BadRequestException('status must be ACTIVE or RELEASED');
    }
    const limit = this.limit(rawLimit, 200);
    const result = await this.database.query<LegalHoldRow>(
      `SELECT * FROM saas_tenant_data_legal_holds
       WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [tenantId, status, limit],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapHold(row)), limit };
  }

  async releaseLegalHold(
    tenantId: string,
    actorUserId: string,
    holdId: string,
    input: ReleaseSaasDataLegalHoldDto,
  ) {
    this.identity(tenantId, actorUserId);
    this.uuid(holdId, 'holdId');
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    const expectedVersion = this.integer(input?.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<LegalHoldRow>(
        'SELECT * FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenantId, holdId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Legal hold not found');
      if (Number(current.row_version) !== expectedVersion) throw new ConflictException('Legal hold version is stale');
      if (current.status !== 'ACTIVE') throw new ConflictException('Only an active legal hold can be released');
      if (current.created_by_user_id === actorUserId) throw new ConflictException('Legal hold creator cannot approve its release');
      const updated = await client.query<LegalHoldRow>(
        `UPDATE saas_tenant_data_legal_holds
         SET status='RELEASED', released_by_user_id=$3, released_at=clock_timestamp(),
             release_reason=$4, row_version=row_version+1, updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND row_version=$5 RETURNING *`,
        [tenantId, holdId, actorUserId, reason, expectedVersion],
      );
      if (!updated.rows[0]) throw new ConflictException('Legal hold changed concurrently');
      await this.audit(client, tenantId, actorUserId, 'LEGAL_HOLD_RELEASED', holdId, {
        createdByUserId: current.created_by_user_id,
        expectedVersion,
        reason,
      });
      return updated.rows[0];
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-retention:' + tenantId });
    return this.mapHold(result);
  }

  async attestExportPreservation(
    tenantId: string,
    actorUserId: string,
    transferId: string,
    input: CreateSaasExportPreservationAttestationDto,
  ) {
    this.identity(tenantId, actorUserId);
    const normalizedTransferId = this.uuid(transferId, 'transferId');
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    const expectedVersion = this.integer(input?.expected_version, 'expected_version', 2, Number.MAX_SAFE_INTEGER);
    const bundleDigest = this.sha256(input?.bundle_digest, 'bundle_digest');
    const verificationMethod = input?.verification_method;
    if (!['READ_BACK_HASH', 'SIGNATURE_VALIDATION', 'DUAL_CONTROL_REVIEW'].includes(verificationMethod)) {
      throw new BadRequestException('verification_method is invalid');
    }
    const verificationReference = this.requiredString(input?.verification_reference, 'verification_reference', 200, 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(verificationReference)) {
      throw new BadRequestException('verification_reference must be a non-secret opaque evidence identifier');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({
      operation: 'EXPORT_PRESERVATION_ATTESTATION',
      transferId: normalizedTransferId,
      expectedVersion,
      bundleDigest,
      verificationMethod,
      verificationReference,
      reason,
    });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<ExportPreservationAttestationRow>(
        'SELECT * FROM saas_tenant_data_export_preservation_attestations WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was used for another preservation attestation');
        }
        return { row: replay.rows[0], replayed: true };
      }

      const transfer = await client.query<{
        id: string;
        transfer_id: string;
        version: string | number;
        operation_type: string;
        status: string;
        source_bundle_reference: string | null;
        source_bundle_digest: string | null;
        source_manifest: Record<string, unknown> | string;
        actor_user_id: string;
      }>(
        `SELECT id::text AS id, transfer_id::text AS transfer_id, version,
                operation_type, status, source_bundle_reference, source_bundle_digest,
                source_manifest, actor_user_id::text AS actor_user_id
         FROM saas_tenant_data_transfers
         WHERE tenant_id=$1 AND transfer_id=$2 AND version=$3 FOR SHARE`,
        [tenantId, normalizedTransferId, expectedVersion],
      );
      const source = transfer.rows[0];
      if (!source || source.operation_type !== 'EXPORT' || source.status !== 'COMPLETED'
        || !source.source_bundle_reference || source.source_bundle_digest !== bundleDigest) {
        throw new ConflictException('Preservation evidence must bind to the exact completed export version and digest');
      }
      if (source.actor_user_id === actorUserId) {
        throw new ConflictException('The export creator/attester cannot independently verify the same export');
      }
      const existing = await client.query(
        `SELECT id FROM saas_tenant_data_export_preservation_attestations
         WHERE tenant_id=$1 AND transfer_id=$2 AND transfer_version=$3 FOR UPDATE`,
        [tenantId, normalizedTransferId, expectedVersion],
      );
      if (existing.rows[0]) {
        throw new ConflictException('This completed export version already has an immutable preservation attestation');
      }

      const inserted = await client.query<ExportPreservationAttestationRow>(
        `INSERT INTO saas_tenant_data_export_preservation_attestations
         (tenant_id, transfer_id, transfer_version, bundle_digest, verification_method,
          verification_reference, reason, idempotency_key, request_hash, verified_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [tenantId, normalizedTransferId, expectedVersion, bundleDigest, verificationMethod,
          verificationReference, reason, idempotencyKey, requestHash, actorUserId],
      );
      const row = inserted.rows[0];
      await this.audit(client, tenantId, actorUserId, 'EXPORT_PRESERVATION_ATTESTED', row.id, {
        transferId: normalizedTransferId,
        transferVersion: expectedVersion,
        bundleDigest,
        verificationMethod,
        verificationReference,
      });
      return { row, replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-export-preservation:' + tenantId + ':' + normalizedTransferId + ':' + expectedVersion });

    return {
      attestation: this.mapPreservationAttestation(result.row),
      replayed: result.replayed,
    };
  }

  async createErasureRequest(tenantId: string, actorUserId: string, input: CreateSaasTenantErasureRequestDto) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const categories = this.categories(input?.categories);
    const erasureReadyCategories = new Set<SaasTransferDatasetCategory>([
      SaasTransferDatasetCategory.BUSINESS_DATA,
      SaasTransferDatasetCategory.EVIDENCE,
      SaasTransferDatasetCategory.AI_CONTEXT,
      SaasTransferDatasetCategory.LEARNING_EVALUATION,
    ]);
    const unsupportedCategories = categories.filter((category) => !erasureReadyCategories.has(category));
    if (unsupportedCategories.length) {
      throw new ConflictException(
        'Erasure cannot be approved for categories without a reviewed deletion adapter: ' + unsupportedCategories.join(', '),
      );
    }
    const exportTransferId = this.uuid(input?.export_transfer_id, 'export_transfer_id');
    const exportVersion = this.integer(input?.export_transfer_version, 'export_transfer_version', 1, Number.MAX_SAFE_INTEGER);
    const exportDigest = this.sha256(input?.export_bundle_digest, 'export_bundle_digest');
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'TENANT_ERASURE', categories, exportTransferId, exportVersion, exportDigest, reason });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<ErasureRequestRow>(
        'SELECT * FROM saas_tenant_data_erasure_requests WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for another erasure request');
        return { row: replay.rows[0], replayed: true };
      }
      const exportResult = await client.query<{
        transfer_id: string;
        version: string | number;
        operation_type: string;
        status: string;
        source_bundle_reference: string | null;
        source_bundle_digest: string | null;
        actor_user_id: string;
        required_categories: SaasTransferDatasetCategory[] | string;
      }>(
        `SELECT transfer_id::text AS transfer_id, version, operation_type, status,
                source_bundle_reference, source_bundle_digest, actor_user_id::text AS actor_user_id,
                required_categories
         FROM saas_tenant_data_transfers
         WHERE tenant_id=$1 AND transfer_id=$2 AND version=$3 FOR SHARE`,
        [tenantId, exportTransferId, exportVersion],
      );
      const sourceExport = exportResult.rows[0];
      if (!sourceExport || sourceExport.operation_type !== 'EXPORT' || sourceExport.status !== 'COMPLETED'
        || !sourceExport.source_bundle_reference || sourceExport.source_bundle_digest !== exportDigest) {
        throw new ConflictException('Erasure requires a completed export with the matching artifact digest');
      }
      const exportedCategories = this.parseCategories(sourceExport.required_categories);
      if (categories.some((category) => !exportedCategories.includes(category))) {
        throw new ConflictException('Every requested erasure category must be included in the preserved export');
      }
      const activeHolds = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
        'SELECT categories FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND status=\'ACTIVE\' FOR SHARE',
        [tenantId],
      );
      if (activeHolds.rows.some((hold) => this.categoriesOverlap(categories, this.parseCategories(hold.categories)))) {
        throw new ConflictException('An active legal hold blocks erasure for one or more requested categories');
      }
      const preservation = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM saas_tenant_data_export_preservation_attestations
         WHERE tenant_id=$1 AND transfer_id=$2 AND transfer_version=$3
           AND bundle_digest=$4 AND verified_by_user_id <> $5 FOR SHARE`,
        [tenantId, exportTransferId, exportVersion, exportDigest, sourceExport.actor_user_id],
      );
      if (!preservation.rows[0]) {
        throw new ConflictException('Erasure requires an independent preservation attestation for the completed export');
      }
      const inserted = await client.query<ErasureRequestRow>(
        `INSERT INTO saas_tenant_data_erasure_requests
         (tenant_id, request_id, version, status, categories, export_transfer_id,
          export_transfer_version, export_bundle_digest, reason, requested_by_user_id,
          idempotency_key, request_hash)
         VALUES ($1,$2,1,'REQUESTED',$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [tenantId, randomUUID(), JSON.stringify(categories), exportTransferId, exportVersion,
          exportDigest, reason, actorUserId, idempotencyKey, requestHash],
      );
      const row = inserted.rows[0];
      await this.audit(client, tenantId, actorUserId, 'TENANT_ERASURE_REQUESTED', row.id, {
        categories, exportTransferId, exportVersion, exportBundleDigest: exportDigest,
      });
      return { row, replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-retention:' + tenantId });
    return { request: this.mapErasure(result.row), replayed: result.replayed };
  }

  async reviewErasureRequest(
    tenantId: string,
    actorUserId: string,
    requestId: string,
    input: ReviewSaasTenantErasureRequestDto,
  ) {
    this.identity(tenantId, actorUserId);
    this.uuid(requestId, 'requestId');
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    const expectedVersion = this.integer(input?.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const decision = input?.decision;
    if (decision !== SaasTenantErasureReviewDecision.APPROVE && decision !== SaasTenantErasureReviewDecision.REJECT) {
      throw new BadRequestException('decision must be APPROVE or REJECT');
    }
    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<ErasureRequestRow>(
        'SELECT * FROM saas_tenant_data_erasure_requests WHERE tenant_id=$1 AND request_id=$2 AND version=1 FOR UPDATE',
        [tenantId, requestId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Tenant erasure request not found');
      if (Number(current.row_version) !== expectedVersion) throw new ConflictException('Erasure request version is stale');
      if (current.status !== 'REQUESTED') throw new ConflictException('Only a requested erasure can be reviewed once');
      if (current.requested_by_user_id === actorUserId) throw new ConflictException('Erasure requester cannot approve or reject their own request');
      const categories = this.parseCategories(current.categories);
      if (decision === SaasTenantErasureReviewDecision.APPROVE) {
        const holds = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
          'SELECT categories FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND status=\'ACTIVE\' FOR SHARE',
          [tenantId],
        );
        if (holds.rows.some((hold) => this.categoriesOverlap(categories, this.parseCategories(hold.categories)))) {
          throw new ConflictException('An active legal hold blocks erasure approval for one or more requested categories');
        }
      }
      const target: ErasureStatus = decision === SaasTenantErasureReviewDecision.APPROVE ? 'APPROVED' : 'REJECTED';
      const updated = await client.query<ErasureRequestRow>(
        `UPDATE saas_tenant_data_erasure_requests
         SET status=$3, reviewed_by_user_id=$4, reviewed_at=clock_timestamp(),
             review_reason=$5, row_version=row_version+1, updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND request_id=$2 AND version=1 AND row_version=$6
         RETURNING *`,
        [tenantId, requestId, target, actorUserId, reason, expectedVersion],
      );
      if (!updated.rows[0]) throw new ConflictException('Erasure request changed concurrently');
      await this.audit(client, tenantId, actorUserId, 'TENANT_ERASURE_' + target, current.id, {
        requestId, categories, requestedByUserId: current.requested_by_user_id, reason,
      });
      return updated.rows[0];
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-retention:' + tenantId });
    return this.mapErasure(result);
  }

  async listErasureRequests(tenantId: string, actorUserId: string, rawStatus?: string, rawLimit?: string) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const status = rawStatus?.trim().toUpperCase() || null;
    if (status && status !== 'REQUESTED' && status !== 'APPROVED' && status !== 'REJECTED') {
      throw new BadRequestException('status must be REQUESTED, APPROVED or REJECTED');
    }
    const limit = this.limit(rawLimit, 200);
    const result = await this.database.query<ErasureRequestRow>(
      `SELECT * FROM saas_tenant_data_erasure_requests
       WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [tenantId, status, limit],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapErasure(row)), limit };
  }

  async listPoliciesHistory(tenantId: string, actorUserId: string, category?: string) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const normalizedCategory = category ? this.category(category) : null;
    const result = await this.database.query<RetentionPolicyRow>(
      `SELECT * FROM saas_tenant_data_retention_policies
       WHERE tenant_id=$1 AND ($2::text IS NULL OR category_code=$2)
       ORDER BY category_code, version DESC LIMIT 500`,
      [tenantId, normalizedCategory],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapPolicy(row)), limit: 500 };
  }

  private async audit(client: PoolClient, tenantId: string, actorUserId: string, action: string, resourceId: string, payload: Record<string, unknown>) {
    await this.auditService.recordWithClient(client, {
      tenantId,
      factoryId: null,
      actorUserId,
      eventType: 'SAAS_DATA_RETENTION',
      action,
      resourceType: 'SAAS_DATA_RETENTION',
      resourceId,
      correlationId: null,
      requestId: null,
      dataClass: 'RESTRICTED',
      payload,
    });
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>('SELECT id::text AS id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }

  private async authorize(actorUserId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(actorUserId, tenantId, permission);
  }

  private identity(tenantId: unknown, actorUserId: unknown) {
    this.uuid(tenantId, 'tenantId');
    this.uuid(actorUserId, 'actorUserId');
  }

  private uuid(value: unknown, field: string) {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }

  private category(value: unknown): SaasTransferDatasetCategory {
    if (typeof value !== 'string' || !CATEGORIES.includes(value as SaasTransferDatasetCategory)) {
      throw new BadRequestException('category_code is not a supported transfer data category');
    }
    return value as SaasTransferDatasetCategory;
  }

  private categories(value: unknown): SaasTransferDatasetCategory[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
      throw new BadRequestException('categories must contain 1 to 10 supported categories');
    }
    const categories = value.map((category) => this.category(category));
    if (new Set(categories).size !== categories.length) throw new BadRequestException('categories must be unique');
    return [...categories].sort();
  }

  private parseCategories(value: SaasTransferDatasetCategory[] | string): SaasTransferDatasetCategory[] {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value) as unknown; } catch { throw new ConflictException('Stored category manifest is invalid'); }
    }
    if (!Array.isArray(parsed)) throw new ConflictException('Stored category manifest is invalid');
    return this.categories(parsed);
  }

  private categoriesOverlap(left: SaasTransferDatasetCategory[], right: SaasTransferDatasetCategory[]) {
    const rightSet = new Set(right);
    return left.some((category) => rightSet.has(category));
  }

  private requiredString(value: unknown, field: string, max: number, min = 1) {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
      throw new BadRequestException(field + ' must be a non-empty string of ' + min + ' to ' + max + ' characters');
    }
    return value.trim();
  }

  private caseReference(value: unknown) {
    const reference = this.requiredString(value, 'case_reference', 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(reference)) {
      throw new BadRequestException('case_reference must be an opaque identifier');
    }
    return reference;
  }

  private idempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new BadRequestException('idempotency_key has an invalid format');
    return key;
  }

  private sha256(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new BadRequestException(field + ' must be a SHA-256 hex digest');
    return value.toLowerCase();
  }

  private integer(value: unknown, field: string, min: number, max: number) {
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
      throw new BadRequestException(field + ' must be a safe integer between ' + min + ' and ' + max);
    }
    return Number(value);
  }

  private limit(value: string | undefined, max: number) {
    if (value === undefined) return Math.min(100, max);
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1 || result > max) {
      throw new BadRequestException('limit must be an integer between 1 and ' + max);
    }
    return result;
  }

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }

  private mapPolicy(row: RetentionPolicyRow) {
    return {
      id: row.id,
      categoryCode: row.category_code,
      version: Number(row.version),
      retentionDays: Number(row.retention_days),
      disposition: row.disposition,
      legalBasis: row.legal_basis,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    };
  }

  private mapHold(row: LegalHoldRow) {
    return {
      id: row.id,
      categories: this.parseCategories(row.categories),
      status: row.status,
      caseReference: row.case_reference,
      reason: row.reason,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      releasedByUserId: row.released_by_user_id,
      releasedAt: row.released_at,
      releaseReason: row.release_reason,
      version: Number(row.row_version),
      updatedAt: row.updated_at,
    };
  }

  private mapPreservationAttestation(row: ExportPreservationAttestationRow) {
    return {
      id: row.id,
      transferId: row.transfer_id,
      transferVersion: Number(row.transfer_version),
      bundleDigest: row.bundle_digest,
      verificationMethod: row.verification_method,
      verificationReference: row.verification_reference,
      reason: row.reason,
      verifiedByUserId: row.verified_by_user_id,
      verifiedAt: row.verified_at,
      createdAt: row.created_at,
    };
  }

  private mapErasure(row: ErasureRequestRow) {
    return {
      id: row.id,
      requestId: row.request_id,
      status: row.status,
      categories: this.parseCategories(row.categories),
      exportTransferId: row.export_transfer_id,
      exportTransferVersion: Number(row.export_transfer_version),
      exportBundleDigest: row.export_bundle_digest,
      reason: row.reason,
      requestedByUserId: row.requested_by_user_id,
      reviewedByUserId: row.reviewed_by_user_id,
      reviewedAt: row.reviewed_at,
      reviewReason: row.review_reason,
      version: Number(row.row_version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
