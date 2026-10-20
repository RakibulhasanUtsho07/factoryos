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
import { ExecuteSaasTenantErasureDto } from './dto/execute-saas-tenant-erasure.dto';
import { RunSaasRetentionPolicyDto, SaasRetentionRunMode } from './dto/run-saas-retention-policy.dto';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';
import { SAAS_TENANT_DATASET_TABLES } from './saas-tenant-postgres-dataset-source';

type RetentionDisposition = 'DELETE' | 'ANONYMIZE' | 'REVIEW';
type RunStatus = 'COMPLETED' | 'BLOCKED' | 'FAILED';

interface RetentionPolicyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  category_code: SaasTransferDatasetCategory;
  version: string | number;
  retention_days: string | number;
  disposition: RetentionDisposition;
  created_by_user_id?: string;
}

interface RetentionRunRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  run_id: string;
  category_code: SaasTransferDatasetCategory;
  policy_version: string | number;
  mode: SaasRetentionRunMode;
  status: RunStatus;
  cutoff_at: string;
  examined_rows: string | number;
  eligible_rows: string | number;
  affected_rows: string | number;
  held_rows: string | number;
  table_manifest: Record<string, unknown> | string;
  manifest_digest: string | null;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  initiated_by_user_id: string;
  created_at: string;
  finished_at: string;
}

interface ErasureRequestRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  request_id: string;
  version: string | number;
  status: string;
  categories: SaasTransferDatasetCategory[] | string;
  export_transfer_id: string;
  export_transfer_version: string | number;
  export_bundle_digest: string;
  reason: string;
  requested_by_user_id: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  row_version: string | number;
}

interface ErasureRunRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  run_id: string;
  request_id: string;
  request_version: string | number;
  status: 'COMPLETED' | 'FAILED';
  categories: SaasTransferDatasetCategory[] | string;
  deleted_rows: string | number;
  table_manifest: Record<string, unknown> | string;
  manifest_digest: string | null;
  source_export_digest: string;
  executor_user_id: string;
  failure_code: string | null;
  reason: string;
  idempotency_key: string;
  request_hash: string;
  created_at: string;
  finished_at: string;
}

interface TenantTableMetadata {
  table: string;
  safe: boolean;
  deletionGuarded: boolean;
  timeColumn: string | null;
}

interface ForeignKeyEdge {
  constraintId: string;
  childTable: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
  deleteType: string;
}

const CATEGORY_VALUES = Object.values(SaasTransferDatasetCategory);
const PRESERVED_CATEGORIES = new Set<SaasTransferDatasetCategory>([
  SaasTransferDatasetCategory.AUDIT_LOG,
  SaasTransferDatasetCategory.APPROVALS,
  SaasTransferDatasetCategory.EFFECTIVE_DATED_MASTER_DATA,
  SaasTransferDatasetCategory.IAM_ACCESS,
]);
const MAX_ROWS_PER_SYNC_RUN = 100_000;
const POLICY_TIME_COLUMNS = ['occurred_at', 'event_at', 'recorded_at', 'created_at', 'received_at'] as const;
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

@Injectable()
export class SaasTenantGovernanceExecutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async runRetentionPolicy(
    tenantId: string,
    actorUserId: string,
    categoryValue: string,
    input: RunSaasRetentionPolicyDto,
  ) {
    this.identity(tenantId, actorUserId);
    const category = this.category(categoryValue);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.execute');
    const mode = input?.mode;
    if (mode !== SaasRetentionRunMode.DRY_RUN && mode !== SaasRetentionRunMode.EXECUTE) {
      throw new BadRequestException('mode must be DRY_RUN or EXECUTE');
    }
    const expectedPolicyVersion = this.integer(input?.expected_policy_version, 'expected_policy_version', 1, Number.MAX_SAFE_INTEGER);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'RETENTION_RUN', category, mode, expectedPolicyVersion, reason });
    const runId = randomUUID();

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<RetentionRunRow>(
        'SELECT * FROM saas_tenant_data_retention_runs WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [tenantId, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was used for a different retention run');
        }
        return { row: replay.rows[0], replayed: true, request: undefined };
      }

      const policyResult = await client.query<RetentionPolicyRow>(
        'SELECT * FROM saas_tenant_data_retention_policies WHERE tenant_id=$1 AND category_code=$2 ORDER BY version DESC LIMIT 1 FOR SHARE',
        [tenantId, category],
      );
      const policy = policyResult.rows[0];
      if (!policy) throw new NotFoundException('No retention policy is configured for this category');
      if (Number(policy.version) !== expectedPolicyVersion) {
        throw new ConflictException('Retention policy version changed; refresh policy history and retry');
      }

      const timeResult = await client.query<{ cutoff_at: string }>(
        "SELECT (clock_timestamp() - ($1::int * interval '1 day'))::text AS cutoff_at",
        [Number(policy.retention_days)],
      );
      const cutoffAt = timeResult.rows[0]?.cutoff_at;
      if (!cutoffAt) throw new ConflictException('Could not determine the retention cutoff');
      const tables = this.resolveTables(category);
      const mapped = tables.length > 0
        ? await this.inspectTables(client, tables, true)
        : [];
      const deleteGuarded = mapped.some((item) => item.deletionGuarded);
      const unsupported = tables.length === 0
        ? 'NO_REVIEWED_TABLE_MAPPING'
        : mapped.some((item) => !item.safe || !item.timeColumn)
          ? 'TABLE_ISOLATION_OR_TIME_ANCHOR_UNVERIFIED'
          : mode === SaasRetentionRunMode.EXECUTE && deleteGuarded
            ? 'DELETE_GUARD_REQUIRES_REVIEWED_ADAPTER'
            : null;
      const manifest: Record<string, unknown> = {};
      let examined = 0n;
      let eligible = 0n;

      if (!unsupported) {
        for (const table of mapped) {
          const qTable = this.quoteIdentifier(table.table);
          const qTime = this.quoteIdentifier(table.timeColumn as string);
          const counts = await client.query<{ examined: string; eligible: string }>(
            `SELECT COUNT(*)::text AS examined,
                    COUNT(*) FILTER (WHERE ${qTime} < $2::timestamptz)::text AS eligible
             FROM public.${qTable} WHERE tenant_id=$1::uuid`,
            [tenantId, cutoffAt],
          );
          const examinedCount = BigInt(counts.rows[0]?.examined ?? '0');
          const eligibleCount = BigInt(counts.rows[0]?.eligible ?? '0');
          examined += examinedCount;
          eligible += eligibleCount;
          manifest[table.table] = {
            examined: examinedCount.toString(),
            eligible: eligibleCount.toString(),
            affected: '0',
            timeColumn: table.timeColumn,
          };
        }
      } else {
        manifest._blocked = unsupported;
      }

      const holdResult = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
        "SELECT categories FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND status='ACTIVE' FOR SHARE",
        [tenantId],
      );
      const held = holdResult.rows.some((row) => this.parseCategories(row.categories).includes(category));
      const blockReason = unsupported
        ?? (held && mode === SaasRetentionRunMode.EXECUTE ? 'ACTIVE_LEGAL_HOLD' : null)
        ?? (mode === SaasRetentionRunMode.EXECUTE && policy.created_by_user_id === actorUserId ? 'POLICY_MAKER_CANNOT_EXECUTE' : null)
      ?? (mode === SaasRetentionRunMode.EXECUTE && policy.disposition !== 'DELETE'
          ? policy.disposition === 'ANONYMIZE' ? 'ANONYMIZATION_ADAPTER_NOT_REGISTERED' : 'POLICY_REQUIRES_MANUAL_REVIEW'
          : null)
        ?? (mode === SaasRetentionRunMode.EXECUTE && PRESERVED_CATEGORIES.has(category) ? 'PROTECTED_EVIDENCE_CATEGORY' : null);

      let status: RunStatus = blockReason ? 'BLOCKED' : 'COMPLETED';
      let affected = 0n;
      let heldRows = held ? eligible : 0n;
      let orderedTables = mapped.map((item) => item.table).sort();

      if (mode === SaasRetentionRunMode.EXECUTE && !blockReason) {
        const dependencyProblem = await this.findDependencyBlock(client, tenantId, mapped, cutoffAt);
        if (dependencyProblem) {
          status = 'BLOCKED';
          manifest._blocked = dependencyProblem;
        } else if (eligible > BigInt(MAX_ROWS_PER_SYNC_RUN)) {
          status = 'BLOCKED';
          manifest._blocked = 'SYNC_RUN_ROW_LIMIT_EXCEEDED';
        } else {
          orderedTables = await this.orderTablesForDelete(client, mapped.map((item) => item.table));
          for (const tableName of orderedTables) {
            const table = mapped.find((entry) => entry.table === tableName) as TenantTableMetadata;
            const deleteResult = await client.query<{ affected: string }>(
              `WITH deleted AS (
                 DELETE FROM public.${this.quoteIdentifier(tableName)}
                 WHERE tenant_id=$1::uuid AND ${this.quoteIdentifier(table.timeColumn as string)} < $2::timestamptz
                 RETURNING 1
               ) SELECT COUNT(*)::text AS affected FROM deleted`,
              [tenantId, cutoffAt],
            );
            const count = BigInt(deleteResult.rows[0]?.affected ?? '0');
            affected += count;
            const current = manifest[tableName] as Record<string, unknown>;
            current.affected = count.toString();
          }
          if (affected !== eligible) {
            throw new ConflictException('Retention count changed during execution; transaction rolled back');
          }
        }
      }

      if (status === 'BLOCKED') {
        manifest._blocked = manifest._blocked ?? blockReason ?? 'RETENTION_RUN_BLOCKED';
      } else {
        delete manifest._blocked;
      }

      const digest = status === 'COMPLETED'
        ? this.hash({ version: 1, tenantId, runId, category, policyVersion: Number(policy.version), cutoffAt, mode, tables: manifest })
        : null;
      const inserted = await client.query<RetentionRunRow>(
        `INSERT INTO saas_tenant_data_retention_runs
         (tenant_id, run_id, category_code, policy_version, mode, status, cutoff_at,
          examined_rows, eligible_rows, affected_rows, held_rows, table_manifest,
          manifest_digest, reason, idempotency_key, request_hash, initiated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
         RETURNING *`,
        [tenantId, runId, category, Number(policy.version), mode, status, cutoffAt,
          examined.toString(), eligible.toString(), affected.toString(), heldRows.toString(),
          JSON.stringify(manifest), digest, reason, idempotencyKey, requestHash, actorUserId],
      );
      await this.audit(client, tenantId, actorUserId,
        mode === SaasRetentionRunMode.DRY_RUN ? 'RETENTION_DRY_RUN_' + status : 'RETENTION_EXECUTION_' + status,
        inserted.rows[0].id,
        {
          runId,
          category,
          policyVersion: Number(policy.version),
          mode,
          status,
          cutoffAt,
          examinedRows: examined.toString(),
          eligibleRows: eligible.toString(),
          affectedRows: affected.toString(),
          heldRows: heldRows.toString(),
          manifestDigest: digest,
          blockedReason: status === 'BLOCKED' ? manifest._blocked : undefined,
        });
      return { row: inserted.rows[0], replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-retention-run:' + tenantId + ':' + category });

    return { run: this.mapRetentionRun(result.row), replayed: result.replayed };
  }

  async executeErasure(
    tenantId: string,
    actorUserId: string,
    requestIdValue: string,
    input: ExecuteSaasTenantErasureDto,
  ) {
    this.identity(tenantId, actorUserId);
    const requestId = this.uuid(requestIdValue, 'requestId');
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.execute');
    const expectedVersion = this.integer(input?.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER);
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const idempotencyKey = this.idempotencyKey(input?.idempotency_key);
    const requestHash = this.hash({ operation: 'TENANT_ERASURE_EXECUTION', requestId, expectedVersion, reason });
    const runId = randomUUID();
    let failureContext: {
      requestVersion: number;
      categories: SaasTransferDatasetCategory[];
      sourceDigest: string;
    } | null = null;

    try {
      const result = await this.database.transaction(async (client) => {
        await this.lockTenant(client, tenantId);
        const replay = await client.query<ErasureRunRow>(
          'SELECT * FROM saas_tenant_data_erasure_runs WHERE tenant_id=$1 AND request_id=$2 AND idempotency_key=$3 FOR UPDATE',
          [tenantId, requestId, idempotencyKey],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== requestHash) {
            throw new ConflictException('Idempotency-Key was used for a different erasure execution');
          }
          return { row: replay.rows[0], replayed: true };
        }

        const found = await client.query<ErasureRequestRow>(
          'SELECT * FROM saas_tenant_data_erasure_requests WHERE tenant_id=$1 AND request_id=$2 AND version=1 FOR UPDATE',
          [tenantId, requestId],
        );
        const current = found.rows[0];
        if (!current) throw new NotFoundException('Tenant erasure request not found');
        if (current.status !== 'APPROVED') throw new ConflictException('Only an approved erasure request can execute');
        if (Number(current.row_version) !== expectedVersion) throw new ConflictException('Erasure request version is stale');
        if (!current.reviewed_by_user_id || current.requested_by_user_id === actorUserId
          || current.reviewed_by_user_id === actorUserId) {
          throw new ConflictException('Erasure execution requires an actor distinct from the requester and reviewer');
        }
        const categories = this.parseCategories(current.categories);
        const unsupported = categories.filter((category) =>
          PRESERVED_CATEGORIES.has(category) || !this.resolveTables(category).length);
        if (unsupported.length) {
          throw new ConflictException('An erasure category has no approved deletion adapter; request a reviewed category-specific procedure');
        }
        const exportCheck = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM saas_tenant_data_export_preservation_attestations
           WHERE tenant_id=$1 AND transfer_id=$2 AND transfer_version=$3
             AND bundle_digest=$4 AND verified_by_user_id <> $5 FOR SHARE`,
          [tenantId, current.export_transfer_id, Number(current.export_transfer_version),
            current.export_bundle_digest, current.requested_by_user_id],
        );
        if (!exportCheck.rows[0]) {
          throw new ConflictException('Independent preservation attestation is no longer available');
        }
        const holdResult = await client.query<{ categories: SaasTransferDatasetCategory[] | string }>(
          "SELECT categories FROM saas_tenant_data_legal_holds WHERE tenant_id=$1 AND status='ACTIVE' FOR SHARE",
          [tenantId],
        );
        if (holdResult.rows.some((hold) => categories.some((category) => this.parseCategories(hold.categories).includes(category)))) {
          throw new ConflictException('An active legal hold blocks execution for one or more categories');
        }

        const tables = [...new Set(categories.flatMap((category) => this.resolveTables(category)))].sort();
        const mapped = await this.inspectTables(client, tables, false);
        if (mapped.some((item) => !item.safe || item.deletionGuarded)) {
          throw new ConflictException('A target table failed tenant isolation checks or has an unreviewed DELETE trigger; no erasure data was changed');
        }
        let totalRows = 0n;
        const counts: Record<string, string> = {};
        for (const table of mapped) {
          const resultCount = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM public.${this.quoteIdentifier(table.table)} WHERE tenant_id=$1::uuid`,
            [tenantId],
          );
          const count = BigInt(resultCount.rows[0]?.count ?? '0');
          totalRows += count;
          counts[table.table] = count.toString();
        }
        if (totalRows > BigInt(MAX_ROWS_PER_SYNC_RUN)) {
          throw new ConflictException('Erasure exceeds the bounded synchronous execution limit; no rows were deleted');
        }
        const dependencyProblem = await this.findDependencyBlock(client, tenantId, mapped, null);
        if (dependencyProblem) throw new ConflictException(dependencyProblem);
        const orderedTables = await this.orderTablesForDelete(client, tables);
        failureContext = {
          requestVersion: Number(current.version),
          categories,
          sourceDigest: current.export_bundle_digest,
        };

        const executing = await client.query<ErasureRequestRow>(
          `UPDATE saas_tenant_data_erasure_requests
           SET status='EXECUTING', execution_started_by_user_id=$3, execution_started_at=clock_timestamp(),
               row_version=row_version+1, updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND request_id=$2 AND version=1 AND row_version=$4 AND status='APPROVED'
           RETURNING *`,
          [tenantId, requestId, actorUserId, expectedVersion],
        );
        if (!executing.rows[0]) throw new ConflictException('Erasure request changed before execution');

        const deletedCounts: Record<string, string> = {};
        let deletedRows = 0n;
        for (const tableName of orderedTables) {
          const resultDelete = await client.query<{ deleted: string }>(
            `WITH deleted AS (
               DELETE FROM public.${this.quoteIdentifier(tableName)} WHERE tenant_id=$1::uuid
               RETURNING 1
             ) SELECT COUNT(*)::text AS deleted FROM deleted`,
            [tenantId],
          );
          const count = BigInt(resultDelete.rows[0]?.deleted ?? '0');
          if (count !== BigInt(counts[tableName] ?? '0')) {
            throw new ConflictException('Erasure count changed during execution; all changes have been rolled back');
          }
          deletedRows += count;
          deletedCounts[tableName] = count.toString();
        }
        const manifest = {
          version: 1,
          requestId,
          tenantId,
          categories: [...categories].sort(),
          sourceExportDigest: current.export_bundle_digest,
          tables: deletedCounts,
          deletedRows: deletedRows.toString(),
          verifiedAt: new Date().toISOString(),
        };
        const digest = this.hash(manifest);
        const run = await client.query<ErasureRunRow>(
          `INSERT INTO saas_tenant_data_erasure_runs
           (tenant_id, run_id, request_id, request_version, status, categories, deleted_rows,
            table_manifest, manifest_digest, source_export_digest, executor_user_id, reason,
            idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,'COMPLETED',$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
           RETURNING *`,
          [tenantId, runId, requestId, Number(current.version), JSON.stringify(categories),
            deletedRows.toString(), JSON.stringify(manifest), digest, current.export_bundle_digest,
            actorUserId, reason, idempotencyKey, requestHash],
        );
        const verified = await client.query<ErasureRequestRow>(
          `UPDATE saas_tenant_data_erasure_requests
           SET status='VERIFIED', execution_completed_at=clock_timestamp(), execution_run_id=$3,
               execution_manifest_digest=$4, row_version=row_version+1, updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND request_id=$2 AND version=1 AND status='EXECUTING'
           RETURNING *`,
          [tenantId, requestId, runId, digest],
        );
        if (!verified.rows[0]) throw new ConflictException('Erasure completion could not be verified');
        await this.audit(client, tenantId, actorUserId, 'TENANT_ERASURE_VERIFIED', run.rows[0].id, {
          requestId,
          runId,
          categories: [...categories].sort(),
          deletedRows: deletedRows.toString(),
          tables: deletedCounts,
          sourceExportDigest: current.export_bundle_digest,
          manifestDigest: digest,
        });
        return { row: run.rows[0], replayed: false, request: verified.rows[0] };
      }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-erasure:' + tenantId + ':' + requestId });

      return {
        run: this.mapErasureRun(result.row),
        request: result.request ? {
          requestId: result.request.request_id,
          status: result.request.status,
          version: Number(result.request.row_version),
          executionManifestDigest: result.request.execution_manifest_digest,
          executionCompletedAt: result.request.execution_completed_at,
        } : undefined,
        replayed: result.replayed,
      };
    } catch (error) {
      if (failureContext) {
        const code = this.failureCode(error);
        await this.recordFailedErasureRun({
          tenantId, actorUserId, requestId, runId, requestHash, idempotencyKey,
          requestVersion: failureContext.requestVersion,
          categories: failureContext.categories,
          sourceDigest: failureContext.sourceDigest,
          reason,
          failureCode: code,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async listRetentionRuns(
    tenantId: string,
    actorUserId: string,
    filters: { category?: string; status?: string; mode?: string; limit?: string } = {},
  ) {
    this.identity(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const category = filters.category ? this.category(filters.category) : null;
    const status = filters.status ? filters.status.trim().toUpperCase() : null;
    const mode = filters.mode ? filters.mode.trim().toUpperCase() : null;
    if (status && !['COMPLETED', 'BLOCKED', 'FAILED'].includes(status)) {
      throw new BadRequestException('status must be COMPLETED, BLOCKED or FAILED');
    }
    if (mode && !['DRY_RUN', 'EXECUTE'].includes(mode)) {
      throw new BadRequestException('mode must be DRY_RUN or EXECUTE');
    }
    const limit = this.queryLimit(filters.limit, 200);
    const result = await this.database.query<RetentionRunRow>(
      `SELECT * FROM saas_tenant_data_retention_runs
       WHERE tenant_id=$1 AND ($2::text IS NULL OR category_code=$2)
         AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR mode=$4)
       ORDER BY created_at DESC, id DESC LIMIT $5`,
      [tenantId, category, status, mode, limit],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapRetentionRun(row)), count: result.rows.length, limit };
  }

  async listErasureRuns(tenantId: string, actorUserId: string, requestIdValue: string, rawLimit?: string) {
    this.identity(tenantId, actorUserId);
    const requestId = this.uuid(requestIdValue, 'requestId');
    await this.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const limit = this.queryLimit(rawLimit, 100);
    const result = await this.database.query<ErasureRunRow>(
      `SELECT * FROM saas_tenant_data_erasure_runs
       WHERE tenant_id=$1 AND request_id=$2
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [tenantId, requestId, limit],
      { tenantId, userId: actorUserId },
    );
    return { items: result.rows.map((row) => this.mapErasureRun(row)), count: result.rows.length, limit };
  }

  private async recordFailedErasureRun(input: {
    tenantId: string;
    actorUserId: string;
    requestId: string;
    runId: string;
    requestHash: string;
    idempotencyKey: string;
    requestVersion: number;
    categories: SaasTransferDatasetCategory[];
    sourceDigest: string;
    reason: string;
    failureCode: string;
  }) {
    await this.database.transaction(async (client) => {
      await this.lockTenant(client, input.tenantId);
      const existing = await client.query<{ id: string }>(
        'SELECT id::text AS id FROM saas_tenant_data_erasure_runs WHERE tenant_id=$1 AND request_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [input.tenantId, input.requestId, input.idempotencyKey],
      );
      if (existing.rows[0]) return;
      const manifest = { version: 1, requestId: input.requestId, failureCode: input.failureCode, deletedRows: '0' };
      const inserted = await client.query<ErasureRunRow>(
        `INSERT INTO saas_tenant_data_erasure_runs
         (tenant_id, run_id, request_id, request_version, status, categories, deleted_rows,
          table_manifest, source_export_digest, executor_user_id, failure_code, reason,
          idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,'FAILED',$5::jsonb,0,$6::jsonb,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [input.tenantId, input.runId, input.requestId, input.requestVersion, JSON.stringify(input.categories),
          JSON.stringify(manifest), input.sourceDigest, input.actorUserId, input.failureCode,
          input.reason, input.idempotencyKey, input.requestHash],
      );
      await this.audit(client, input.tenantId, input.actorUserId, 'TENANT_ERASURE_EXECUTION_FAILED', inserted.rows[0].id, {
        requestId: input.requestId,
        runId: input.runId,
        failureCode: input.failureCode,
        deletedRows: '0',
      });
    }, { tenantId: input.tenantId, userId: input.actorUserId, advisoryLockKey: 'saas-erasure-failure:' + input.tenantId + ':' + input.requestId });
  }

  private async inspectTables(client: PoolClient, tables: string[], requireTimeColumn: boolean): Promise<TenantTableMetadata[]> {
    const result: TenantTableMetadata[] = [];
    for (const table of [...new Set(tables)].sort()) {
      if (!TABLE_NAME.test(table)) throw new ConflictException('An unsafe table identifier was rejected');
      const meta = await client.query<{
        table_exists: boolean;
        has_tenant_id: boolean;
        has_id: boolean;
        forced_rls: boolean;
        has_tenant_policy: boolean;
        deletion_guarded: boolean;
        time_column: string | null;
      }>(
        `SELECT
           (c.oid IS NOT NULL) AS table_exists,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped) AS has_tenant_id,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id' AND a.attnum>0 AND NOT a.attisdropped) AS has_id,
           COALESCE(c.relrowsecurity AND c.relforcerowsecurity, false) AS forced_rls,
           EXISTS (
             SELECT 1 FROM pg_policy p
             WHERE p.polrelid=c.oid
               AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%tenant_id%'
               AND COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
               AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%tenant_id%'
               AND COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%factoryos_current_tenant_id%'
           ) AS has_tenant_policy,
           EXISTS (
             SELECT 1 FROM pg_trigger tr
             WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal AND tr.tgenabled <> 'D'
               AND (tr.tgtype::integer & 8) = 8
           ) AS deletion_guarded,
           (SELECT a.attname::text FROM pg_attribute a
             WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
               AND a.attname=ANY($2::text[])
             ORDER BY array_position($2::text[],a.attname::text) LIMIT 1) AS time_column
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname=$1 AND c.relkind IN ('r','p')`,
        [table, [...POLICY_TIME_COLUMNS]],
      );
      const row = meta.rows[0];
      const safe = Boolean(row?.table_exists && row.has_tenant_id && row.has_id && row.forced_rls && row.has_tenant_policy);
      result.push({ table, safe, deletionGuarded: Boolean(row?.deletion_guarded), timeColumn: requireTimeColumn ? row?.time_column ?? null : null });
    }
    return result;
  }

  private async findDependencyBlock(
    client: PoolClient,
    tenantId: string,
    tables: TenantTableMetadata[],
    cutoffAt: string | null,
  ): Promise<string | null> {
    const selected = new Set(tables.map((item) => item.table));
    if (!selected.size) return null;
    const edges = await this.foreignKeysReferencing(client, [...selected]);
    for (const edge of edges) {
      const join = edge.childColumns.map((column, index) =>
        `c.${this.quoteIdentifier(column)} = p.${this.quoteIdentifier(edge.parentColumns[index] as string)}`,
      ).join(' AND ');
      if (selected.has(edge.childTable)) {
        if (cutoffAt) {
          const childMeta = tables.find((item) => item.table === edge.childTable);
          const parentMeta = tables.find((item) => item.table === edge.parentTable);
          if (!childMeta?.timeColumn || !parentMeta?.timeColumn) return 'DEPENDENCY_TIME_ANCHOR_MISSING';
          const recentChild = await client.query<{ present: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM public.${this.quoteIdentifier(edge.childTable)} c
               JOIN public.${this.quoteIdentifier(edge.parentTable)} p ON ${join}
               WHERE c.tenant_id=$1::uuid AND p.tenant_id=$1::uuid
                 AND p.${this.quoteIdentifier(parentMeta.timeColumn)} < $2::timestamptz
                 AND c.${this.quoteIdentifier(childMeta.timeColumn)} >= $2::timestamptz
             ) AS present`,
            [tenantId, cutoffAt],
          );
          if (recentChild.rows[0]?.present) return 'RECENT_DEPENDENT_ROWS_BLOCK_RETENTION';
        }
        continue;
      }
      const childMetaResult = await client.query<{ has_tenant_id: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_attribute a
          WHERE a.attrelid=to_regclass('public.' || $1) AND a.attname='tenant_id'
            AND a.attnum>0 AND NOT a.attisdropped) AS has_tenant_id`,
        [edge.childTable],
      );
      const childHasTenant = Boolean(childMetaResult.rows[0]?.has_tenant_id);
      const predicate = childHasTenant ? ' AND c.tenant_id=$1::uuid' : '';
      const duePredicate = cutoffAt
        ? ` AND p.${this.quoteIdentifier((tables.find((item) => item.table === edge.parentTable)?.timeColumn) ?? 'created_at')} < $2::timestamptz`
        : '';
      const values: unknown[] = cutoffAt ? [tenantId, cutoffAt] : [tenantId];
      const ref = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public.${this.quoteIdentifier(edge.childTable)} c
           JOIN public.${this.quoteIdentifier(edge.parentTable)} p ON ${join}
           WHERE p.tenant_id=$1::uuid${predicate}${duePredicate}
         ) AS present`,
        values,
      );
      if (ref.rows[0]?.present) return 'EXTERNAL_DEPENDENT_ROWS_BLOCK_DELETION';
    }
    return null;
  }

  private async foreignKeysReferencing(client: PoolClient, parentTables: string[]): Promise<ForeignKeyEdge[]> {
    const result = await client.query<ForeignKeyEdge>(
      `SELECT c.oid::text AS "constraintId",
              child.relname::text AS "childTable",
              parent.relname::text AS "parentTable",
              c.confdeltype::text AS "deleteType",
              array_agg(child_att.attname::text ORDER BY ck.ord) AS "childColumns",
              array_agg(parent_att.attname::text ORDER BY ck.ord) AS "parentColumns"
       FROM pg_constraint c
       JOIN pg_class child ON child.oid=c.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
       JOIN pg_class parent ON parent.oid=c.confrelid
       JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
       JOIN LATERAL unnest(c.conkey) WITH ORDINALITY ck(attnum,ord) ON true
       JOIN LATERAL unnest(c.confkey) WITH ORDINALITY pk(attnum,ord) ON pk.ord=ck.ord
       JOIN pg_attribute child_att ON child_att.attrelid=child.oid AND child_att.attnum=ck.attnum
       JOIN pg_attribute parent_att ON parent_att.attrelid=parent.oid AND parent_att.attnum=pk.attnum
       WHERE c.contype='f' AND child_ns.nspname='public' AND parent_ns.nspname='public'
         AND parent.relname=ANY($1::text[])
       GROUP BY c.oid, child.relname, parent.relname, c.confdeltype`,
      [parentTables],
    );
    return result.rows;
  }

  private async orderTablesForDelete(client: PoolClient, tables: string[]): Promise<string[]> {
    const names = [...new Set(tables)];
    const selected = new Set(names);
    const outgoing = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    for (const name of names) {
      outgoing.set(name, new Set<string>());
      indegree.set(name, 0);
    }
    const edges = await this.foreignKeysReferencing(client, names);
    for (const edge of edges) {
      if (!selected.has(edge.childTable) || !selected.has(edge.parentTable) || edge.childTable === edge.parentTable) {
        if (edge.childTable === edge.parentTable && selected.has(edge.childTable)) {
          throw new ConflictException('Self-referencing data requires a reviewed category-specific erasure adapter');
        }
        continue;
      }
      const targets = outgoing.get(edge.childTable) as Set<string>;
      if (!targets.has(edge.parentTable)) {
        targets.add(edge.parentTable);
        indegree.set(edge.parentTable, (indegree.get(edge.parentTable) ?? 0) + 1);
      }
    }
    const ready = names.filter((name) => indegree.get(name) === 0).sort();
    const ordered: string[] = [];
    while (ready.length) {
      const current = ready.shift() as string;
      ordered.push(current);
      for (const next of outgoing.get(current) ?? []) {
        const updated = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, updated);
        if (updated === 0) {
          ready.push(next);
          ready.sort();
        }
      }
    }
    if (ordered.length !== names.length) {
      throw new ConflictException('Cyclic foreign-key dependencies require a reviewed category-specific deletion plan');
    }
    return ordered;
  }

  private resolveTables(category: SaasTransferDatasetCategory): string[] {
    return [...(SAAS_TENANT_DATASET_TABLES[category] ?? [])].sort();
  }

  private async audit(
    client: PoolClient,
    tenantId: string,
    actorUserId: string,
    action: string,
    resourceId: string,
    payload: Record<string, unknown>,
  ) {
    await this.auditService.recordWithClient(client, {
      tenantId,
      factoryId: null,
      actorUserId,
      eventType: 'SAAS_DATA_GOVERNANCE',
      action,
      resourceType: 'SAAS_DATA_GOVERNANCE',
      resourceId,
      correlationId: null,
      requestId: null,
      dataClass: 'RESTRICTED',
      payload,
    });
  }

  private async lockTenant(client: PoolClient, tenantId: string) {
    const result = await client.query<{ id: string }>('SELECT id::text AS id FROM tenants WHERE id=$1::uuid FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }

  private async authorize(actorUserId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(actorUserId, tenantId, permission);
  }

  private identity(tenantId: unknown, actorUserId: unknown) {
    this.uuid(tenantId, 'tenantId');
    this.uuid(actorUserId, 'actorUserId');
  }

  private category(value: unknown): SaasTransferDatasetCategory {
    if (typeof value !== 'string' || !CATEGORY_VALUES.includes(value as SaasTransferDatasetCategory)) {
      throw new BadRequestException('category is invalid');
    }
    return value as SaasTransferDatasetCategory;
  }

  private parseCategories(value: SaasTransferDatasetCategory[] | string): SaasTransferDatasetCategory[] {
    let categories: unknown = value;
    if (typeof categories === 'string') {
      try { categories = JSON.parse(categories) as unknown; }
      catch { throw new ConflictException('Stored category manifest is malformed'); }
    }
    if (!Array.isArray(categories)) throw new ConflictException('Stored category manifest is malformed');
    const parsed = categories.map((item) => this.category(item));
    if (new Set(parsed).size !== parsed.length) throw new ConflictException('Stored category manifest contains duplicates');
    return parsed;
  }

  private uuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value;
  }

  private integer(value: unknown, field: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new BadRequestException(field + ' must be a safe integer between ' + min + ' and ' + max);
    }
    return value;
  }

  private requiredString(value: unknown, field: string, max: number, min = 1): string {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.trim();
    if (normalized.length < min || normalized.length > max) {
      throw new BadRequestException(field + ' must contain between ' + min + ' and ' + max + ' characters');
    }
    return normalized;
  }

  private idempotencyKey(value: unknown): string {
    const key = this.requiredString(value, 'idempotency_key', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('idempotency_key contains unsupported characters');
    }
    return key;
  }

  private queryLimit(raw: string | undefined, max: number): number {
    if (raw === undefined || raw.trim() === '') return max;
    const limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
      throw new BadRequestException('limit must be a safe integer between 1 and ' + max);
    }
    return limit;
  }

  private quoteIdentifier(value: string): string {
    if (!TABLE_NAME.test(value)) throw new ConflictException('Unsafe SQL identifier rejected');
    return '"' + value.replace(/"/g, '""') + '"';
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }

  private failureCode(error: unknown): string {
    const err = error as { code?: string; status?: number };
    if (err?.code === '23503') return 'FOREIGN_KEY_DEPENDENCY';
    if (err?.code === '40001') return 'CONCURRENT_CHANGE';
    if (err?.code === '55000') return 'DATABASE_GUARD';
    if (err?.status === 409) return 'PRECONDITION_CONFLICT';
    return 'EXECUTION_FAILED';
  }

  private mapRetentionRun(row: RetentionRunRow) {
    const manifest = typeof row.table_manifest === 'string' ? JSON.parse(row.table_manifest) as Record<string, unknown> : row.table_manifest;
    return {
      id: row.id,
      runId: row.run_id,
      categoryCode: row.category_code,
      policyVersion: Number(row.policy_version),
      mode: row.mode,
      status: row.status,
      cutoffAt: row.cutoff_at,
      examinedRows: String(row.examined_rows),
      eligibleRows: String(row.eligible_rows),
      affectedRows: String(row.affected_rows),
      heldRows: String(row.held_rows),
      tableManifest: manifest,
      manifestDigest: row.manifest_digest,
      reason: row.reason,
      initiatedByUserId: row.initiated_by_user_id,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  private mapErasureRun(row: ErasureRunRow) {
    const manifest = typeof row.table_manifest === 'string' ? JSON.parse(row.table_manifest) as Record<string, unknown> : row.table_manifest;
    return {
      id: row.id,
      runId: row.run_id,
      requestId: row.request_id,
      requestVersion: Number(row.request_version),
      status: row.status,
      categories: this.parseCategories(row.categories),
      deletedRows: String(row.deleted_rows),
      tableManifest: manifest,
      manifestDigest: row.manifest_digest,
      sourceExportDigest: row.source_export_digest,
      executorUserId: row.executor_user_id,
      failureCode: row.failure_code,
      reason: row.reason,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }
}
