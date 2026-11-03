import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type {
  SaasFinanceRetentionContext,
  SaasFinanceRetentionResult,
  SaasTenantFinanceRetentionAdapter,
} from './saas-tenant-propagation.adapters';

/**
 * Read-only inventory adapter for immutable SaaS usage, provider-cost and
 * commercial-billing ledgers. It deliberately has no DELETE implementation.
 * An expired immutable row remains a verified, explicitly retained residual;
 * it cannot be silently removed by the general business-data retention path.
 */
export const POSTGRES_FINANCE_RETENTION_INVENTORY_ADAPTER_KEY =
  'postgresql.finance-usage-ledger.inventory.v1';
export const POSTGRES_FINANCE_RETENTION_ADAPTER_VERSION = '1.0.0';
export const POSTGRES_FINANCE_RETENTION_MAX_ROWS = 100000;

export const POSTGRES_FINANCE_RETENTION_RELATIONS = [
  { table: 'saas_usage_rate_cards', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_RATE_CARD_HISTORY' },
  { table: 'saas_usage_events', cutoffColumn: 'occurred_at', purpose: 'IMMUTABLE_USAGE_EVENTS' },
  { table: 'saas_usage_adjustments', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_USAGE_ADJUSTMENTS' },
  { table: 'saas_usage_reconciliations', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_USAGE_RECONCILIATIONS' },
  { table: 'saas_usage_budgets', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_BUDGET_POLICY_HISTORY' },
  { table: 'saas_budget_evaluations', cutoffColumn: 'evaluated_at', purpose: 'IMMUTABLE_BUDGET_EVALUATIONS' },
  { table: 'saas_budget_alerts', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_BUDGET_ALERTS' },
  { table: 'saas_budget_alert_acknowledgements', cutoffColumn: 'acknowledged_at', purpose: 'IMMUTABLE_BUDGET_ACKNOWLEDGEMENTS' },
  { table: 'saas_workload_control_events', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_WORKLOAD_CONTROL_HISTORY' },
  { table: 'saas_provider_cost_events', cutoffColumn: 'occurred_at', purpose: 'IMMUTABLE_PROVIDER_COST_EVENTS' },
  { table: 'saas_provider_cost_reconciliations', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_PROVIDER_COST_RECONCILIATIONS' },
  { table: 'saas_billing_provider_accounts', cutoffColumn: 'created_at', purpose: 'VERSIONED_BILLING_PROVIDER_ACCOUNT' },
  { table: 'saas_billing_provider_account_events', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_BILLING_ACCOUNT_EVENTS' },
  { table: 'saas_billing_close_runs', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_BILLING_CLOSE_RUNS' },
  { table: 'saas_billing_close_events', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_BILLING_CLOSE_EVENTS' },
  { table: 'saas_billing_provider_webhook_events', cutoffColumn: 'received_at', purpose: 'IMMUTABLE_BILLING_PROVIDER_WEBHOOKS' },
  { table: 'saas_billing_reconciliation_results', cutoffColumn: 'created_at', purpose: 'IMMUTABLE_BILLING_RECONCILIATION_RESULTS' },
] as const;

interface FinanceRelationMetadataRow extends QueryResultRow {
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_id: boolean;
  has_cutoff_column: boolean;
  has_delete_guard: boolean;
}

interface FinanceCountRow extends QueryResultRow {
  candidate_rows: string | number;
}

interface FinanceRelationInventory {
  table: string;
  cutoffColumn: string;
  purpose: string;
  candidateRows: string | null;
  scanStatus: 'COMPLETE' | 'NOT_SCANNED_AFTER_BOUND';
  disposition: 'RETAINED_IMMUTABLE';
}

interface FinanceInventoryManifest {
  schema: 'factoryos.postgres-finance-retention-inventory/v1';
  adapterVersion: string;
  tenantId: string;
  policyVersion: number;
  retentionDays: number;
  cutoffAt: string;
  legalBasisSha256: string;
  maxRows: number;
  candidateRows: string;
  inventoryComplete: boolean;
  destructiveDeletePermitted: false;
  relations: FinanceRelationInventory[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function count(value: string | number): bigint {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new ConflictException('Finance retention inventory returned an invalid row count');
  }
  return BigInt(text);
}

@Injectable()
export class PostgresFinanceRetentionInventoryAdapter implements SaasTenantFinanceRetentionAdapter {
  readonly adapterKey = POSTGRES_FINANCE_RETENTION_INVENTORY_ADAPTER_KEY;
  readonly adapterVersion = POSTGRES_FINANCE_RETENTION_ADAPTER_VERSION;

  constructor(private readonly database: DatabaseService) {}

  async isConfigured(tenantId: string): Promise<boolean> {
    return process.env.FACTORYOS_FINANCE_RETENTION_MODE === 'INVENTORY_ONLY'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId);
  }

  async dryRun(context: SaasFinanceRetentionContext): Promise<SaasFinanceRetentionResult> {
    const inventory = await this.inventory(context);
    const manifestDigest = digest(inventory);
    const overBound = !inventory.inventoryComplete;
    return {
      plannedRows: inventory.candidateRows,
      deletedRows: '0',
      residualRows: overBound ? '1' : '0',
      tableManifest: {
        inventory,
        executionDisposition: overBound ? 'BLOCKED_INVENTORY_BOUND_EXCEEDED' : 'READ_ONLY_PREVIEW',
        deletionPermitted: false,
      },
      manifestDigest,
      adapterReceiptReference: this.receipt('preview', manifestDigest),
      failureCode: overBound ? 'FINANCE_RETENTION_INVENTORY_LIMIT_EXCEEDED' : null,
    };
  }

  async execute(context: SaasFinanceRetentionContext): Promise<SaasFinanceRetentionResult> {
    const inventory = await this.inventory(context);
    const manifestDigest = digest(inventory);
    const candidateRows = count(inventory.candidateRows);
    const overBound = !inventory.inventoryComplete;
    const hasImmutableRows = candidateRows > 0n;
    const blocked = overBound || hasImmutableRows;
    return {
      plannedRows: inventory.candidateRows,
      deletedRows: '0',
      residualRows: blocked ? (candidateRows > 0n ? String(candidateRows) : '1') : '0',
      tableManifest: {
        inventory,
        executionDisposition: overBound
          ? 'BLOCKED_INVENTORY_BOUND_EXCEEDED'
          : hasImmutableRows
            ? 'BLOCKED_IMMUTABLE_FINANCE_LEDGER'
            : 'NO_OP_NO_EXPIRED_FINANCE_ROWS',
        deletionPermitted: false,
      },
      manifestDigest,
      adapterReceiptReference: this.receipt('execute', manifestDigest),
      failureCode: overBound
        ? 'FINANCE_RETENTION_INVENTORY_LIMIT_EXCEEDED'
        : hasImmutableRows
          ? 'FINANCE_LEDGER_IMMUTABLE_REQUIRES_APPROVED_ARCHIVE_PURGE'
          : null,
    };
  }

  async verify(
    context: SaasFinanceRetentionContext,
    result: SaasFinanceRetentionResult,
  ): Promise<{ verifiedManifestDigest: string; residualRows: string; verificationReference: string }> {
    const current = await this.inventory(context);
    const verifiedManifestDigest = digest(current);
    const manifestValue = result.tableManifest as Record<string, unknown> | null;
    const previousInventory = manifestValue && typeof manifestValue === 'object'
      ? manifestValue.inventory : null;
    const previousDigestMatches = previousInventory !== null
      && previousInventory !== undefined
      && digest(previousInventory) === result.manifestDigest;
    const manifestStillCurrent = current.inventoryComplete
      && previousDigestMatches
      && verifiedManifestDigest === result.manifestDigest;
    const candidates = count(current.candidateRows);
    const residualRows = !manifestStillCurrent
      ? '1'
      : context.mode === 'DRY_RUN'
        ? '0'
        : String(candidates);
    return {
      verifiedManifestDigest,
      residualRows,
      verificationReference: this.receipt('verify', verifiedManifestDigest),
    };
  }

  private async inventory(context: SaasFinanceRetentionContext): Promise<FinanceInventoryManifest> {
    const tenantId = context.tenantId.toLowerCase();
    const cutoff = Date.parse(context.cutoffAt);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)
      || !Number.isSafeInteger(context.policyVersion) || context.policyVersion < 1
      || !Number.isSafeInteger(context.retentionDays) || context.retentionDays < 1 || context.retentionDays > 36500
      || !Number.isFinite(cutoff)
      || !context.legalBasis.trim() || context.legalBasis.length > 200) {
      throw new ConflictException('Finance retention context is invalid');
    }

    return this.database.transaction(async (client) => {
      let remaining = POSTGRES_FINANCE_RETENTION_MAX_ROWS;
      let total = 0n;
      let inventoryComplete = true;
      const relations: FinanceRelationInventory[] = [];

      for (const relation of POSTGRES_FINANCE_RETENTION_RELATIONS) {
        if (remaining <= 0) {
          inventoryComplete = false;
          relations.push({
            table: relation.table,
            cutoffColumn: relation.cutoffColumn,
            purpose: relation.purpose,
            candidateRows: null,
            scanStatus: 'NOT_SCANNED_AFTER_BOUND',
            disposition: 'RETAINED_IMMUTABLE',
          });
          continue;
        }

        const metadataSql = [
          "SELECT c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,",
          "EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname = 'tenant_id' AND a.attnum>0 AND NOT a.attisdropped) AS has_tenant_id,",
          "EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname=$2 AND a.attnum>0 AND NOT a.attisdropped) AS has_cutoff_column,",
          "EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgenabled <> 'D' AND pg_catalog.pg_get_triggerdef(t.oid) ILIKE '%DELETE%' AND p.prosrc ILIKE '%RAISE EXCEPTION%') AS has_delete_guard",
          "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace",
          "WHERE n.nspname = 'public' AND c.relname=$1 AND c.relkind IN ('r','p')",
        ].join(' ');
        const metadata = await client.query<FinanceRelationMetadataRow>(
          metadataSql,
          [relation.table, relation.cutoffColumn],
        );
        const guard = metadata.rows[0];
        if (!guard || guard.rls_enabled !== true || guard.rls_forced !== true
          || guard.has_tenant_id !== true || guard.has_cutoff_column !== true || guard.has_delete_guard !== true) {
          throw new ConflictException(
            'Finance retention inventory requires an existing tenant column, forced RLS, cutoff column and immutable DELETE guard on ' + relation.table,
          );
        }

        const pageLimit = remaining + 1;
        const countSql = [
          "SELECT COUNT(*)::text AS candidate_rows FROM (",
          "SELECT 1 FROM public." + relation.table,
          "WHERE tenant_id=$1 AND " + relation.cutoffColumn + " < $2::timestamptz",
          "ORDER BY " + relation.cutoffColumn + ", id LIMIT $3",
          ") AS bounded_finance_retention_inventory",
        ].join(' ');
        const countResult = await client.query<FinanceCountRow>(
          countSql,
          [tenantId, context.cutoffAt, pageLimit],
        );
        const observed = count(countResult.rows[0]?.candidate_rows ?? '0');
        const exceededRemaining = observed > BigInt(remaining);
        const observedBounded = exceededRemaining ? BigInt(remaining + 1) : observed;
        total += observedBounded;
        remaining = exceededRemaining ? 0 : remaining - Number(observedBounded);
        if (exceededRemaining) inventoryComplete = false;
        relations.push({
          table: relation.table,
          cutoffColumn: relation.cutoffColumn,
          purpose: relation.purpose,
          candidateRows: String(observedBounded),
          scanStatus: exceededRemaining ? 'NOT_SCANNED_AFTER_BOUND' : 'COMPLETE',
          disposition: 'RETAINED_IMMUTABLE',
        });
      }

      return {
        schema: 'factoryos.postgres-finance-retention-inventory/v1',
        adapterVersion: this.adapterVersion,
        tenantId,
        policyVersion: context.policyVersion,
        retentionDays: context.retentionDays,
        cutoffAt: new Date(cutoff).toISOString(),
        legalBasisSha256: createHash('sha256').update(context.legalBasis, 'utf8').digest('hex'),
        maxRows: POSTGRES_FINANCE_RETENTION_MAX_ROWS,
        candidateRows: String(total),
        inventoryComplete,
        destructiveDeletePermitted: false,
        relations,
      };
    }, { tenantId, isolationLevel: 'REPEATABLE READ', readOnly: true });
  }

  private receipt(kind: 'preview' | 'execute' | 'verify', manifestDigest: string): string {
    return 'pg-finance-retention-' + kind + '.' + manifestDigest.slice(0, 40);
  }
}
