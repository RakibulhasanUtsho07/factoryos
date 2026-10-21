import {
  BadRequestException, ConflictException, Injectable, NotFoundException, Optional, Inject, ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { CreateSaasFinanceRetentionPolicyDto } from './dto/create-saas-finance-retention-policy.dto';
import { ReviewSaasFinanceRetentionPolicyDto } from './dto/review-saas-finance-retention-policy.dto';
import { RunSaasFinanceRetentionDto } from './dto/run-saas-finance-retention.dto';
import { SAAS_TENANT_FINANCE_RETENTION_ADAPTER } from './saas-tenant-propagation.adapters';
import type { SaasFinanceRetentionContext, SaasFinanceRetentionResult, SaasTenantFinanceRetentionAdapter } from './saas-tenant-propagation.adapters';

type FinancePolicyRow = QueryResultRow & {
  id: string; tenant_id: string; version: string | number; retention_days: string | number;
  legal_basis: string; finance_adapter_key: string; status: 'PENDING' | 'APPROVED' | 'REJECTED';
  created_by_user_id: string; reviewed_by_user_id: string | null; reviewed_at: string | null;
  review_reason: string | null; reason: string; idempotency_key: string; request_hash: string; created_at: string;
};
type FinanceRunRow = QueryResultRow & {
  run_id: string; policy_version: string | number; mode: 'DRY_RUN' | 'EXECUTE';
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED'; cutoff_at: string;
  planned_rows: string | number; deleted_rows: string | number; residual_rows: string | number;
  table_manifest: Record<string, unknown> | string; manifest_digest: string | null;
  adapter_receipt_reference: string | null; failure_code: string | null; reason: string;
  idempotency_key: string; request_hash: string; approved_by_user_id: string; executor_user_id: string;
  created_at: string; finished_at: string;
};
const DIGEST = /^[a-f0-9]{64}$/;
const COUNT = /^(0|[1-9][0-9]*)$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

@Injectable()
export class SaasTenantFinanceRetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    @Optional() @Inject(SAAS_TENANT_FINANCE_RETENTION_ADAPTER)
    private readonly adapter?: SaasTenantFinanceRetentionAdapter,
  ) {}

  async createPolicy(tenantValue: string, actorValue: string, input: CreateSaasFinanceRetentionPolicyDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const retentionDays = this.integer(input?.retention_days, 'retention_days', 1, 36500);
    const legalBasis = this.requiredString(input?.legal_basis, 'legal_basis', 200, 3);
    const adapterKey = this.key(input?.finance_adapter_key, 'finance_adapter_key');
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'FINANCE_RETENTION_POLICY', retentionDays, legalBasis, adapterKey, reason });
    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<FinancePolicyRow>(
        'SELECT * FROM saas_tenant_finance_retention_policies WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was reused with another finance policy request');
        return { row: replay.rows[0], replayed: true };
      }
      const latest = await client.query<{ version: string | number }>(
        'SELECT version FROM saas_tenant_finance_retention_policies WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',
        [tenantId],
      );
      const version = Number(latest.rows[0]?.version ?? 0) + 1;
      const inserted = await client.query<FinancePolicyRow>(
        `INSERT INTO saas_tenant_finance_retention_policies
         (tenant_id,version,retention_days,legal_basis,finance_adapter_key,status,created_by_user_id,reason,idempotency_key,request_hash)
         VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9) RETURNING *`,
        [tenantId, version, retentionDays, legalBasis, adapterKey, actorUserId, reason, idempotencyKey, requestHash],
      );
      await this.audit(client, tenantId, actorUserId, 'FINANCE_RETENTION_POLICY_CREATED', inserted.rows[0].id, {
        policyVersion: version, retentionDays, adapterKey, legalBasis, status: 'PENDING',
      });
      return { row: inserted.rows[0], replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-finance-retention-policy:' + tenantId });
    return { policy: this.mapPolicy(result.row), replayed: result.replayed };
  }

  async listPolicies(tenantValue: string, actorValue: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const result = await this.database.query<FinancePolicyRow>(
      'SELECT * FROM saas_tenant_finance_retention_policies WHERE tenant_id=$1 ORDER BY version DESC',
      [tenantId], { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapPolicy(row)), count: result.rows.length };
  }

  async reviewPolicy(tenantValue: string, actorValue: string, versionValue: unknown, input: ReviewSaasFinanceRetentionPolicyDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.finance_review');
    const version = this.integer(versionValue, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (this.integer(input?.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER) !== version) {
      throw new ConflictException('Route version and expected_version must match');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const status = input?.decision === 'APPROVE' ? 'APPROVED' : input?.decision === 'REJECT' ? 'REJECTED' : null;
    if (!status) throw new BadRequestException('decision must be APPROVE or REJECT');
    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<FinancePolicyRow>(
        'SELECT * FROM saas_tenant_finance_retention_policies WHERE tenant_id=$1 AND version=$2 FOR UPDATE',
        [tenantId, version],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Finance retention policy not found');
      if (current.status !== 'PENDING') throw new ConflictException('Finance retention policy has already been reviewed');
      if (current.created_by_user_id === actorUserId) throw new ConflictException('Finance policy creator cannot review the same policy');
      const updated = await client.query<FinancePolicyRow>(
        `UPDATE saas_tenant_finance_retention_policies
         SET status=$3,reviewed_by_user_id=$4,reviewed_at=clock_timestamp(),review_reason=$5
         WHERE tenant_id=$1 AND version=$2 AND status='PENDING' RETURNING *`,
        [tenantId, version, status, actorUserId, reason],
      );
      if (!updated.rows[0]) throw new ConflictException('Finance policy changed during review');
      await this.audit(client, tenantId, actorUserId, 'FINANCE_RETENTION_POLICY_' + input.decision, updated.rows[0].id, {
        policyVersion: version, status, reason,
      });
      return updated.rows[0];
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-finance-retention-review:' + tenantId + ':' + version });
    return { policy: this.mapPolicy(result) };
  }

  async runPolicy(tenantValue: string, actorValue: string, versionValue: unknown, input: RunSaasFinanceRetentionDto) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.finance_execute');
    const version = this.integer(versionValue, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (this.integer(input?.expected_policy_version, 'expected_policy_version', 1, Number.MAX_SAFE_INTEGER) !== version) {
      throw new ConflictException('Route version and expected_policy_version must match');
    }
    const mode = input?.mode;
    if (mode !== 'DRY_RUN' && mode !== 'EXECUTE') throw new BadRequestException('mode must be DRY_RUN or EXECUTE');
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'FINANCE_RETENTION_RUN', tenantId, version, mode, reason });
    const replay = await this.database.query<FinanceRunRow>(
      'SELECT * FROM saas_tenant_finance_retention_runs WHERE tenant_id=$1 AND idempotency_key=$2',
      [tenantId, idempotencyKey], { tenantId, userId: actorUserId },
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was reused with another finance run');
      return { run: this.mapRun(replay.rows[0]), replayed: true };
    }

    const policyResult = await this.database.query<FinancePolicyRow>(
      'SELECT * FROM saas_tenant_finance_retention_policies WHERE tenant_id=$1 AND version=$2',
      [tenantId, version], { tenantId, userId: actorUserId },
    );
    const policy = policyResult.rows[0];
    if (!policy) throw new NotFoundException('Finance retention policy not found');
    if (policy.status !== 'APPROVED' || !policy.reviewed_by_user_id || policy.reviewed_by_user_id === policy.created_by_user_id) {
      throw new ConflictException('Finance retention execution requires an independently approved policy');
    }
    if (actorUserId === policy.created_by_user_id || actorUserId === policy.reviewed_by_user_id) {
      throw new ConflictException('Finance policy maker, reviewer and executor must be three different actors');
    }
    if (!this.adapter || this.adapter.adapterKey !== policy.finance_adapter_key) {
      throw new ServiceUnavailableException('The approved finance-specific retention adapter is not registered');
    }
    if (!(await this.adapter.isConfigured(tenantId))) {
      throw new ServiceUnavailableException('The approved finance retention adapter is not configured');
    }

    const holdResult = await this.database.query<{ categories: unknown }>(
      `SELECT categories FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND status='ACTIVE'`,
      [tenantId], { tenantId, userId: actorUserId },
    );
    if (holdResult.rows.some((row) => {
      const categories = Array.isArray(row.categories) ? row.categories : JSON.parse(String(row.categories));
      return Array.isArray(categories) && categories.some((category) => category === 'BUSINESS_DATA' || category === 'FINANCE_USAGE_LEDGER');
    })) throw new ConflictException('An active business-data or finance-usage legal hold blocks finance retention');

    const cutoffResult = await this.database.query<{ cutoff_at: string }>(
      "SELECT (clock_timestamp() - ($1::int * interval '1 day'))::text AS cutoff_at",
      [Number(policy.retention_days)], { tenantId, userId: actorUserId },
    );
    const cutoffAt = cutoffResult.rows[0]?.cutoff_at;
    if (!cutoffAt) throw new ConflictException('Unable to calculate finance retention cutoff');
    const context: SaasFinanceRetentionContext = {
      tenantId, policyVersion: Number(policy.version), retentionDays: Number(policy.retention_days),
      cutoffAt, legalBasis: policy.legal_basis, adapterKey: policy.finance_adapter_key, idempotencyKey, reason,
    };

    let result: SaasFinanceRetentionResult | undefined;
    let failureCode: string | null = null;
    let status: 'COMPLETED' | 'BLOCKED' | 'FAILED' = 'FAILED';
    try {
      result = mode === 'DRY_RUN' ? await this.adapter.dryRun(context) : await this.adapter.execute(context);
      const plannedRows = this.count(result.plannedRows, 'plannedRows');
      const deletedRows = this.count(result.deletedRows, 'deletedRows');
      const residualRows = this.count(result.residualRows, 'residualRows');
      if (!DIGEST.test(result.manifestDigest) || !OPAQUE.test(result.adapterReceiptReference)) {
        throw new ConflictException('Finance adapter must return a SHA-256 manifest and an opaque provider receipt reference');
      }
      const verified = await this.adapter.verify(context, result);
      if (!DIGEST.test(verified.verifiedManifestDigest) || verified.verifiedManifestDigest !== result.manifestDigest
        || !OPAQUE.test(verified.verificationReference) || verified.residualRows !== '0' || residualRows !== '0'
        || (mode === 'DRY_RUN' && deletedRows !== '0')
        || (mode === 'EXECUTE' && deletedRows !== plannedRows)) {
        status = 'BLOCKED';
        failureCode = 'FINANCE_RETENTION_VERIFICATION_MISMATCH';
      } else status = 'COMPLETED';
    } catch (error) {
      status = error instanceof ConflictException ? 'BLOCKED' : 'FAILED';
      failureCode = status === 'BLOCKED' ? 'FINANCE_RETENTION_VERIFICATION_MISMATCH' : 'FINANCE_ADAPTER_OPERATION_FAILED';
    }

    const planned = result ? this.safeCount(result.plannedRows) : '0';
    const deleted = result ? this.safeCount(result.deletedRows) : '0';
    const originalResidual = result ? this.safeCount(result.residualRows) : '1';
    const finalResidual = status === 'COMPLETED' ? '0' : originalResidual === '0' ? '1' : originalResidual;
    const manifest: Record<string, unknown> = result ? {
      scope: 'FINANCE_USAGE_LEDGER_ONLY', mode, policyVersion: version, cutoffAt,
      tableManifest: result.tableManifest, plannedRows: planned, deletedRows: deleted,
      residualRows: finalResidual, verificationStatus: status,
    } : { scope: 'FINANCE_USAGE_LEDGER_ONLY', mode, policyVersion: version, cutoffAt, adapterFailure: true };
    const digest = status === 'COMPLETED' ? this.hash(manifest) : null;
    const adapterReference = result && OPAQUE.test(result.adapterReceiptReference) ? result.adapterReceiptReference : null;

    const stored = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const dupe = await client.query<FinanceRunRow>(
        'SELECT * FROM saas_tenant_finance_retention_runs WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (dupe.rows[0]) {
        if (dupe.rows[0].request_hash !== requestHash) throw new ConflictException('Idempotency-Key was reused with another finance run');
        return dupe.rows[0];
      }
      const inserted = await client.query<FinanceRunRow>(
        `INSERT INTO saas_tenant_finance_retention_runs
         (tenant_id,run_id,policy_version,mode,status,cutoff_at,planned_rows,deleted_rows,residual_rows,
          table_manifest,manifest_digest,adapter_receipt_reference,failure_code,reason,idempotency_key,request_hash,
          approved_by_user_id,executor_user_id,finished_at)
         VALUES ($1,gen_random_uuid(),$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp())
         RETURNING *`,
        [tenantId, version, mode, status, cutoffAt, planned, deleted, finalResidual,
          JSON.stringify(manifest), digest, adapterReference, failureCode, reason, idempotencyKey, requestHash,
          policy.reviewed_by_user_id, actorUserId],
      );
      await this.audit(client, tenantId, actorUserId, 'FINANCE_RETENTION_' + status, inserted.rows[0].run_id, {
        mode, policyVersion: version, cutoffAt, plannedRows: planned, deletedRows: deleted,
        residualRows: finalResidual, manifestDigest: digest, failureCode,
      });
      return inserted.rows[0];
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-finance-retention-run:' + tenantId + ':' + idempotencyKey });
    return { run: this.mapRun(stored), replayed: false };
  }

  async listRuns(tenantValue: string, actorValue: string, limitValue?: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const limit = limitValue === undefined || limitValue.trim() === '' ? 100 : Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    const result = await this.database.query<FinanceRunRow>(
      'SELECT * FROM saas_tenant_finance_retention_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, limit], { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapRun(row)), count: result.rows.length, limit };
  }

  private mapPolicy(row: FinancePolicyRow) {
    return { id: row.id, version: Number(row.version), retentionDays: Number(row.retention_days),
      legalBasis: row.legal_basis, financeAdapterKey: row.finance_adapter_key, status: row.status,
      createdByUserId: row.created_by_user_id, reviewedByUserId: row.reviewed_by_user_id,
      reviewedAt: row.reviewed_at, reviewReason: row.review_reason, reason: row.reason, createdAt: row.created_at };
  }
  private mapRun(row: FinanceRunRow) {
    const manifest = typeof row.table_manifest === 'string' ? JSON.parse(row.table_manifest) as Record<string, unknown> : row.table_manifest;
    return { runId: row.run_id, policyVersion: Number(row.policy_version), mode: row.mode, status: row.status,
      cutoffAt: row.cutoff_at, plannedRows: String(row.planned_rows), deletedRows: String(row.deleted_rows),
      residualRows: String(row.residual_rows), tableManifest: manifest, manifestDigest: row.manifest_digest,
      adapterReceiptReference: row.adapter_receipt_reference, failureCode: row.failure_code,
      approvedByUserId: row.approved_by_user_id, executorUserId: row.executor_user_id,
      createdAt: row.created_at, finishedAt: row.finished_at, receiptScope: 'FINANCE_USAGE_LEDGER_ONLY' };
  }
  private async audit(client: PoolClient, tenantId: string, actorUserId: string, action: string, resourceId: string, payload: Record<string, unknown>) {
    await this.auditService.recordWithClient(client, { tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
      action, resourceType: 'SAAS_FINANCE_RETENTION', resourceId, correlationId: null, requestId: null,
      dataClass: 'RESTRICTED', payload });
  }
  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>('SELECT id::text AS id FROM tenants WHERE id=$1::uuid FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }
  private uuid(value: unknown, field: string) { if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID'); return value; }
  private integer(value: unknown, field: string, min: number, max: number) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestException(field + ' must be an integer between ' + min + ' and ' + max);
    return value;
  }
  private requiredString(value: unknown, field: string, max: number, min = 1) {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.trim(); if (normalized.length < min || normalized.length > max) throw new BadRequestException(field + ' has invalid length'); return normalized;
  }
  private key(value: unknown, field: string) {
    const key = this.requiredString(value, field, 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key)) throw new BadRequestException(field + ' has invalid characters');
    return key;
  }
  private idempotencyKey(value: unknown) {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new BadRequestException('idempotency_key has invalid characters');
    return key;
  }
  private count(value: unknown, field: string) {
    const count = typeof value === 'string' && COUNT.test(value)
      ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
    if (!count) throw new ConflictException(field + ' must be a non-negative integer count');
    return count;
  }
  private safeCount(value: unknown) {
    return typeof value === 'string' && COUNT.test(value) ? value
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '0';
  }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
}
