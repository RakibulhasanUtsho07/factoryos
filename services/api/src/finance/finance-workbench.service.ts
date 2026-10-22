import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { financeRequestHash } from './finance-contract';
import {
  CreateFinanceClosePeriodDto,
  FinanceCloseActionDto,
  FinanceWorkbenchQueryDto,
  ListFinanceClosePeriodsDto,
} from './dto/finance-workbench.dto';

interface FinanceEventContext {
  requestId: string | null;
  traceId: string | null;
}

interface ClosePeriodRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  currency: string;
  period_start: string;
  period_end: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED';
  row_version: number | string;
  idempotency_key: string;
  request_hash: string;
  snapshot: Record<string, unknown>;
  snapshot_hash: string;
  created_by_user_id: string;
  submitted_by_user_id: string | null;
  submitted_at: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  approval_reason: string | null;
  created_at: string;
  updated_at: string;
}

const REQUIRED_REPORTING_DOMAINS = ['GL', 'AR', 'AP', 'BANK_RECONCILIATION', 'TAX_EINVOICE'] as const;

@Injectable()
export class FinanceWorkbenchService {
  constructor(private readonly database: DatabaseService) {}

  async readWorkbench(
    userId: string,
    tenantId: string,
    factoryId: string,
    query: FinanceWorkbenchQueryDto,
  ) {
    const to = query.to ? new Date(query.to).toISOString() : new Date().toISOString();
    const from = query.from
      ? new Date(query.from).toISOString()
      : new Date(Date.parse(to) - 180 * 86_400_000).toISOString();
    if (Date.parse(from) > Date.parse(to)) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }
    const horizonDays = query.horizon_days ?? 30;
    const horizonEnd = new Date(Date.parse(to) + horizonDays * 86_400_000).toISOString();
    const currency = query.currency?.trim().toUpperCase() ?? null;
    const unreconciledLimit = query.unreconciled_limit ?? 50;

    return this.database.transaction({ tenantId, userId }, async (client) => {
      const margin = await client.query(
        `WITH scoped AS (
          SELECT f.*, date_trunc('month',f.effective_at AT TIME ZONE 'UTC')::date AS period_start
          FROM financial_facts f
          JOIN finance_connectors fc
            ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
          WHERE f.tenant_id=$1 AND f.factory_id=$2
            AND fc.status='ACTIVE' AND fc.is_reporting_source
            AND f.fact_type IN (
              'ACTUAL_REVENUE','ACTUAL_COST','ACTUAL_CONTRIBUTION_COST',
              'FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST'
            )
            AND f.effective_at >= $3 AND f.effective_at <= $4
            AND ($5::char(3) IS NULL OR f.currency=$5)
        ), actuals AS (
          SELECT * FROM scoped
          WHERE fact_type IN ('ACTUAL_REVENUE','ACTUAL_COST','ACTUAL_CONTRIBUTION_COST')
        ), forecasts AS (
          SELECT DISTINCT ON (connector_id,fact_type,source_fact_key,currency,period_start)
            connector_id,fact_type,source_fact_key,currency,amount,effective_at,created_at,period_start
          FROM scoped
          WHERE fact_type IN ('FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST')
          ORDER BY connector_id,fact_type,source_fact_key,currency,period_start,
            created_at DESC,effective_at DESC,id DESC
        ), selected AS (
          SELECT connector_id,fact_type,source_fact_key,currency,amount,effective_at,created_at,period_start
          FROM actuals
          UNION ALL
          SELECT connector_id,fact_type,source_fact_key,currency,amount,effective_at,created_at,period_start
          FROM forecasts
        ), totals AS (
          SELECT period_start,currency,
            count(*) FILTER (WHERE fact_type LIKE 'ACTUAL_%')::int AS actual_fact_count,
            count(*) FILTER (WHERE fact_type LIKE 'FORECAST_%')::int AS forecast_fact_count,
            COALESCE(sum(amount) FILTER(WHERE fact_type='ACTUAL_REVENUE'),0) AS actual_revenue,
            COALESCE(sum(amount) FILTER(WHERE fact_type='ACTUAL_COST'),0) AS actual_cost,
            COALESCE(sum(amount) FILTER(WHERE fact_type='ACTUAL_CONTRIBUTION_COST'),0) AS actual_contribution_cost,
            COALESCE(sum(amount) FILTER(WHERE fact_type='FORECAST_REVENUE'),0) AS forecast_revenue,
            COALESCE(sum(amount) FILTER(WHERE fact_type='FORECAST_COST'),0) AS forecast_cost,
            COALESCE(sum(amount) FILTER(WHERE fact_type='FORECAST_CONTRIBUTION_COST'),0) AS forecast_contribution_cost
          FROM selected GROUP BY period_start,currency
        )
        SELECT to_char(period_start,'YYYY-MM') AS period,currency,actual_fact_count,forecast_fact_count,
          actual_revenue::text,actual_cost::text,actual_contribution_cost::text,
          forecast_revenue::text,forecast_cost::text,forecast_contribution_cost::text,
          (actual_revenue-actual_cost)::text AS actual_gross_margin,
          (actual_revenue-actual_contribution_cost)::text AS actual_contribution_margin,
          CASE WHEN actual_revenue=0 THEN NULL ELSE round((actual_revenue-actual_cost)/NULLIF(actual_revenue,0)*100,4)::text END AS actual_gross_margin_percent,
          CASE WHEN actual_revenue=0 THEN NULL ELSE round((actual_revenue-actual_contribution_cost)/NULLIF(actual_revenue,0)*100,4)::text END AS actual_contribution_margin_percent,
          (forecast_revenue-forecast_cost)::text AS forecast_gross_margin,
          (forecast_revenue-forecast_contribution_cost)::text AS forecast_contribution_margin,
          (actual_revenue-forecast_revenue)::text AS revenue_variance,
          (actual_cost-forecast_cost)::text AS cost_variance,
          (actual_contribution_cost-forecast_contribution_cost)::text AS contribution_cost_variance,
          ((actual_revenue-actual_cost)-(forecast_revenue-forecast_cost))::text AS gross_margin_variance,
          ((actual_revenue-actual_contribution_cost)-(forecast_revenue-forecast_contribution_cost))::text AS contribution_margin_variance
        FROM totals ORDER BY period_start,currency`,
        [tenantId, factoryId, from, to, currency],
      );

      const operationalVariance = await client.query(
        `SELECT to_char(date_trunc('month',f.effective_at AT TIME ZONE 'UTC'),'YYYY-MM') AS period,f.currency,
          count(*)::int AS reconciled_fact_count,
          count(*) FILTER(WHERE r.match_status='MISMATCH' AND r.review_status='OPEN')::int AS open_mismatch_count,
          count(*) FILTER(WHERE r.review_status='RESOLVED')::int AS resolved_mismatch_count,
          count(*) FILTER(WHERE r.review_status='WAIVED')::int AS waived_mismatch_count,
          COALESCE(sum((r.source_quantity-r.expected_quantity)*r.expected_rate),0)::text AS operational_quantity_variance,
          COALESCE(sum((r.source_rate-r.expected_rate)*r.source_quantity),0)::text AS operational_rate_variance,
          COALESCE(sum((r.source_quantity-r.expected_quantity)*r.expected_rate
            +(r.source_rate-r.expected_rate)*r.source_quantity),0)::text AS operational_quantity_rate_variance
        FROM finance_fact_reconciliations r
        JOIN financial_facts f ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
        JOIN finance_connectors fc ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
        WHERE r.tenant_id=$1 AND r.factory_id=$2
          AND fc.status='ACTIVE' AND fc.is_reporting_source
          AND f.effective_at >= $3 AND f.effective_at <= $4
          AND ($5::char(3) IS NULL OR f.currency=$5)
        GROUP BY date_trunc('month',f.effective_at AT TIME ZONE 'UTC'),f.currency
        ORDER BY date_trunc('month',f.effective_at AT TIME ZONE 'UTC'),f.currency`,
        [tenantId, factoryId, from, to, currency],
      );

      const workingCapital = await client.query(
        `WITH ranked_positions AS (
          SELECT f.*,
            row_number() OVER (
              PARTITION BY f.connector_id,f.fact_type,f.source_fact_key,f.currency
              ORDER BY f.effective_at DESC,f.created_at DESC,f.id DESC
            ) AS position_rank
          FROM financial_facts f
          JOIN finance_connectors fc
            ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
          WHERE f.tenant_id=$1 AND f.factory_id=$2
            AND fc.status='ACTIVE' AND fc.is_reporting_source
            AND f.fact_type IN (
              'AR_OPEN','AP_OPEN','BANK_BALANCE','INVENTORY_VALUE',
              'OPEN_PO_COMMITMENT','LC_EXPOSURE','SHIPMENT_MILESTONE','TAX_LIABILITY','GL_BALANCE'
            )
            AND f.effective_at <= $3
            AND ($5::char(3) IS NULL OR f.currency=$5)
        ), p AS (
          SELECT * FROM ranked_positions WHERE position_rank=1
        ), g AS (
          SELECT currency,
            COALESCE(sum(amount) FILTER(WHERE fact_type='AR_OPEN'),0) AS receivables,
            COALESCE(sum(amount) FILTER(WHERE fact_type='AP_OPEN'),0) AS payables,
            COALESCE(sum(amount) FILTER(WHERE fact_type='BANK_BALANCE'),0) AS bank_balance,
            COALESCE(sum(amount) FILTER(WHERE fact_type='INVENTORY_VALUE'),0) AS inventory_value,
            COALESCE(sum(amount) FILTER(WHERE fact_type='OPEN_PO_COMMITMENT'),0) AS open_po_commitments,
            COALESCE(sum(amount) FILTER(WHERE fact_type='LC_EXPOSURE'),0) AS lc_exposure,
            COALESCE(sum(amount) FILTER(WHERE fact_type='TAX_LIABILITY'),0) AS tax_liability,
            COALESCE(sum(amount) FILTER(WHERE fact_type='AR_OPEN' AND due_at < $3),0) AS overdue_receivables,
            COALESCE(sum(amount) FILTER(WHERE fact_type='AP_OPEN' AND due_at < $3),0) AS overdue_payables,
            COALESCE(sum(amount) FILTER(WHERE fact_type='AR_OPEN' AND due_at <= $4),0) AS scheduled_receivables,
            COALESCE(sum(amount) FILTER(WHERE fact_type='SHIPMENT_MILESTONE' AND due_at > $3 AND due_at <= $4),0) AS scheduled_shipments,
            COALESCE(sum(amount) FILTER(WHERE fact_type='AP_OPEN' AND due_at <= $4),0) AS scheduled_payables,
            COALESCE(sum(amount) FILTER(WHERE fact_type='OPEN_PO_COMMITMENT' AND due_at <= $4),0) AS scheduled_commitments,
            COALESCE(sum(amount) FILTER(WHERE fact_type='LC_EXPOSURE' AND due_at <= $4),0) AS scheduled_lc,
            COALESCE(sum(amount) FILTER(WHERE fact_type='TAX_LIABILITY' AND due_at <= $4),0) AS scheduled_tax
          FROM p GROUP BY currency
        )
        SELECT currency,receivables::text,payables::text,bank_balance::text,inventory_value::text,
          open_po_commitments::text,lc_exposure::text,tax_liability::text,
          (receivables+inventory_value-payables)::text AS net_working_capital,
          overdue_receivables::text,overdue_payables::text,
          (scheduled_receivables+scheduled_shipments)::text AS forecast_inflows,
          (scheduled_payables+scheduled_commitments+scheduled_lc+scheduled_tax)::text AS forecast_outflows,
          (bank_balance+scheduled_receivables+scheduled_shipments-scheduled_payables-scheduled_commitments-scheduled_lc-scheduled_tax)::text AS projected_cash_at_horizon
        FROM g ORDER BY currency`,
        [tenantId, factoryId, to, horizonEnd, currency],
      );

      const domains = await this.loadReportingDomains(client, tenantId, factoryId);
      const unreconciled = await client.query(
        `SELECT f.id::text AS fact_id,f.external_fact_id,f.source_fact_key,f.fact_type,
          f.source_record_type,f.source_record_ref,f.effective_at::text,f.due_at::text,f.currency,
          f.amount::text,r.expected_source_type,r.expected_source_ref,
          r.source_quantity::text,r.expected_quantity::text,r.quantity_delta::text,
          r.source_rate::text,r.expected_rate::text,r.rate_delta::text,r.uom_code,
          r.review_status,r.created_at::text
        FROM finance_fact_reconciliations r
        JOIN financial_facts f ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
        JOIN finance_connectors fc ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
        WHERE r.tenant_id=$1 AND r.factory_id=$2
          AND fc.status='ACTIVE' AND fc.is_reporting_source
          AND r.match_status='MISMATCH' AND r.review_status='OPEN'
          AND f.effective_at >= $3 AND f.effective_at <= $4
          AND ($5::char(3) IS NULL OR f.currency=$5)
        ORDER BY f.effective_at,f.currency,f.source_fact_key LIMIT $6`,
        [tenantId, factoryId, from, to, currency, unreconciledLimit],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
        FROM finance_fact_reconciliations r
        JOIN financial_facts f ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
        JOIN finance_connectors fc ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
        WHERE r.tenant_id=$1 AND r.factory_id=$2 AND fc.status='ACTIVE' AND fc.is_reporting_source
          AND r.match_status='MISMATCH' AND r.review_status='OPEN'
          AND f.effective_at >= $3 AND f.effective_at <= $4
          AND ($5::char(3) IS NULL OR f.currency=$5)`,
        [tenantId, factoryId, from, to, currency],
      );
      const missingDomains = domains.filter((domain) => !domain.is_active).map((domain) => domain.domain);
      const unresolvedCount = Number(count.rows[0]?.count ?? 0);

      return {
        period: { from, to },
        cash_horizon: { days: horizonDays, ends_at: horizonEnd },
        currency_policy: 'Balances are kept in their source currency. No implicit FX conversion or mixed-currency sum is performed.',
        source_of_record_policy: 'Only active, approved reporting connectors contribute to totals. Custom/enrichment and paused sources are excluded.',
        actual_forecast_policy: 'Actual facts are summed as immutable source records. Forecast facts use the latest version per source key, currency and calendar month; both are reported separately.',
        period_margin: margin.rows,
        operational_variance_attribution: operationalVariance.rows,
        working_capital: workingCapital.rows,
        reporting_domains: domains,
        missing_reporting_domains: missingDomains,
        unreconciled_fact_count: unresolvedCount,
        unreconciled_facts: unreconciled.rows,
        reporting_ready: missingDomains.length === 0 && unresolvedCount === 0,
      };
    });
  }

  async listClosePeriods(
    userId: string,
    tenantId: string,
    factoryId: string,
    query: ListFinanceClosePeriodsDto,
  ) {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      throw new BadRequestException('from must be earlier than or equal to to');
    }
    return this.database.transaction({ tenantId, userId }, async (client) => {
      const result = await client.query(
        `SELECT id::text,currency,period_start::text,period_end::text,status,row_version::int,
          snapshot,snapshot_hash,created_by_user_id::text,submitted_by_user_id::text,submitted_at::text,
          approved_by_user_id::text,approved_at::text,approval_reason,created_at::text,updated_at::text
        FROM finance_close_periods
        WHERE tenant_id=$1 AND factory_id=$2
          AND ($3::text IS NULL OR status=$3)
          AND ($4::char(3) IS NULL OR currency=$4)
          AND ($5::date IS NULL OR period_end >= $5)
          AND ($6::date IS NULL OR period_start <= $6)
        ORDER BY period_end DESC,currency LIMIT 100`,
        [tenantId, factoryId, query.status ?? null, query.currency ?? null, query.from ?? null, query.to ?? null],
      );
      return result.rows;
    });
  }

  async createClosePeriod(
    userId: string,
    tenantId: string,
    factoryId: string,
    dto: CreateFinanceClosePeriodDto,
    idempotencyKeyInput: string | null,
    ctx: FinanceEventContext,
  ) {
    const idempotencyKey = this.requireIdempotencyKey(idempotencyKeyInput);
    const periodStart = this.validateDateOnly(dto.period_start, 'period_start');
    const periodEnd = this.validateDateOnly(dto.period_end, 'period_end');
    const currency = dto.currency.trim().toUpperCase();
    const reason = dto.reason.trim();
    if (periodEnd < periodStart) throw new BadRequestException('period_end must be on or after period_start');
    if ((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000 > 370) {
      throw new BadRequestException('A finance-close period cannot exceed 371 calendar days');
    }
    if (reason.length < 8) throw new BadRequestException('A finance-close creation reason of at least 8 characters is required');
    const requestHash = financeRequestHash({ period_start: periodStart, period_end: periodEnd, currency, reason });

    return this.database.transaction({
      tenantId, userId, requestId: this.uuidOrNull(ctx.requestId), traceId: this.uuidOrNull(ctx.traceId),
      advisoryLockKey: 'finance-close:' + tenantId + ':' + factoryId + ':' + currency + ':' + periodStart,
    }, async (client) => {
      const prior = await client.query<ClosePeriodRow>(
        `SELECT * FROM finance_close_periods
        WHERE tenant_id=$1 AND factory_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [tenantId, factoryId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash.trim() !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used for a different finance-close request');
        }
        return { ...this.publicClosePeriod(prior.rows[0]), replayed: true };
      }
      const existingPeriod = await client.query(
        `SELECT id::text FROM finance_close_periods
        WHERE tenant_id=$1 AND factory_id=$2 AND currency=$3 AND period_start=$4 AND period_end=$5 FOR UPDATE`,
        [tenantId, factoryId, currency, periodStart, periodEnd],
      );
      if (existingPeriod.rows[0]) {
        throw new ConflictException('A finance-close record already exists for this currency and period; refresh or use its current lifecycle');
      }

      const snapshot = await this.buildCloseSnapshot(client, tenantId, factoryId, currency, periodStart, periodEnd);
      const snapshotHash = financeRequestHash(snapshot);
      const result = await client.query<ClosePeriodRow>(
        `INSERT INTO finance_close_periods(
          tenant_id,factory_id,currency,period_start,period_end,status,row_version,
          idempotency_key,request_hash,snapshot,snapshot_hash,created_by_user_id
        ) VALUES($1,$2,$3,$4,$5,'DRAFT',1,$6,$7,$8::jsonb,$9,$10)
        RETURNING *`,
        [tenantId, factoryId, currency, periodStart, periodEnd, idempotencyKey,
          requestHash, JSON.stringify(snapshot), snapshotHash, userId],
      );
      const row = result.rows[0];
      await this.insertHistory(client, row, 'CREATED', userId, reason, { readiness: snapshot.readiness });
      await this.audit(client, tenantId, factoryId, userId, 'FINANCE_CLOSE_CREATED', 'CREATE',
        row.id, ctx, { currency, period_start: periodStart, period_end: periodEnd, snapshot_hash: snapshotHash });
      await this.outbox(client, tenantId, factoryId, row.id, 'FINANCE_CLOSE_CREATED', userId, ctx,
        { currency, period_start: periodStart, period_end: periodEnd, snapshot_hash: snapshotHash });
      return this.publicClosePeriod(row);
    });
  }

  async refreshClosePeriod(
    userId: string,
    tenantId: string,
    factoryId: string,
    periodId: string,
    dto: FinanceCloseActionDto,
    ctx: FinanceEventContext,
  ) {
    const reason = this.requireReason(dto.reason);
    return this.withLockedPeriod(userId, tenantId, factoryId, periodId, ctx, async (client, row) => {
      this.assertVersion(row, dto.expected_version);
      if (row.status !== 'DRAFT') throw new ConflictException('Only a draft finance-close snapshot can be refreshed');
      const snapshot = await this.buildCloseSnapshot(client, tenantId, factoryId, row.currency.trim(), row.period_start, row.period_end);
      const snapshotHash = financeRequestHash(snapshot);
      const result = await client.query<ClosePeriodRow>(
        `UPDATE finance_close_periods SET snapshot=$1::jsonb,snapshot_hash=$2,row_version=row_version+1
        WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='DRAFT' AND row_version=$6
        RETURNING *`,
        [JSON.stringify(snapshot), snapshotHash, periodId, tenantId, factoryId, dto.expected_version],
      );
      if (!result.rows[0]) throw new ConflictException('Finance-close snapshot was concurrently changed');
      const updated = result.rows[0];
      await this.insertHistory(client, updated, 'REFRESHED', userId, reason, { readiness: snapshot.readiness });
      await this.recordTransition(client, updated, userId, ctx, 'FINANCE_CLOSE_REFRESHED', 'REFRESH', reason);
      return this.publicClosePeriod(updated);
    });
  }

  async submitClosePeriod(
    userId: string,
    tenantId: string,
    factoryId: string,
    periodId: string,
    dto: FinanceCloseActionDto,
    ctx: FinanceEventContext,
  ) {
    const reason = this.requireReason(dto.reason);
    return this.withLockedPeriod(userId, tenantId, factoryId, periodId, ctx, async (client, row) => {
      this.assertVersion(row, dto.expected_version);
      if (row.status !== 'DRAFT') throw new ConflictException('Only a draft finance-close snapshot can be submitted');
      const snapshot = await this.buildCloseSnapshot(client, tenantId, factoryId, row.currency.trim(), row.period_start, row.period_end);
      this.assertSnapshotReady(snapshot);
      const snapshotHash = financeRequestHash(snapshot);
      const result = await client.query<ClosePeriodRow>(
        `UPDATE finance_close_periods SET status='SUBMITTED',snapshot=$1::jsonb,snapshot_hash=$2,
          submitted_by_user_id=$3,submitted_at=clock_timestamp(),row_version=row_version+1
        WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND status='DRAFT' AND row_version=$7
        RETURNING *`,
        [JSON.stringify(snapshot), snapshotHash, userId, periodId, tenantId, factoryId, dto.expected_version],
      );
      if (!result.rows[0]) throw new ConflictException('Finance-close snapshot was concurrently changed');
      const updated = result.rows[0];
      await this.insertHistory(client, updated, 'SUBMITTED', userId, reason, { readiness: snapshot.readiness });
      await this.recordTransition(client, updated, userId, ctx, 'FINANCE_CLOSE_SUBMITTED', 'SUBMIT', reason);
      return this.publicClosePeriod(updated);
    });
  }

  async recallClosePeriod(
    userId: string,
    tenantId: string,
    factoryId: string,
    periodId: string,
    dto: FinanceCloseActionDto,
    ctx: FinanceEventContext,
  ) {
    const reason = this.requireReason(dto.reason);
    return this.withLockedPeriod(userId, tenantId, factoryId, periodId, ctx, async (client, row) => {
      this.assertVersion(row, dto.expected_version);
      if (row.status !== 'SUBMITTED') throw new ConflictException('Only a submitted finance-close snapshot can be recalled');
      if (row.submitted_by_user_id !== userId) {
        throw new ForbiddenException('Only the submitter may recall a finance-close period');
      }
      const snapshot = await this.buildCloseSnapshot(client, tenantId, factoryId, row.currency.trim(), row.period_start, row.period_end);
      const snapshotHash = financeRequestHash(snapshot);
      const result = await client.query<ClosePeriodRow>(
        `UPDATE finance_close_periods SET status='DRAFT',snapshot=$1::jsonb,snapshot_hash=$2,
          submitted_by_user_id=NULL,submitted_at=NULL,approved_by_user_id=NULL,approved_at=NULL,
          approval_reason=NULL,row_version=row_version+1
        WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='SUBMITTED' AND row_version=$6
        RETURNING *`,
        [JSON.stringify(snapshot), snapshotHash, periodId, tenantId, factoryId, dto.expected_version],
      );
      if (!result.rows[0]) throw new ConflictException('Finance-close snapshot was concurrently changed');
      const updated = result.rows[0];
      await this.insertHistory(client, updated, 'RECALLED', userId, reason, { readiness: snapshot.readiness });
      await this.recordTransition(client, updated, userId, ctx, 'FINANCE_CLOSE_RECALLED', 'RECALL', reason);
      return this.publicClosePeriod(updated);
    });
  }

  async approveClosePeriod(
    userId: string,
    tenantId: string,
    factoryId: string,
    periodId: string,
    dto: FinanceCloseActionDto,
    ctx: FinanceEventContext,
  ) {
    const reason = this.requireReason(dto.reason);
    return this.withLockedPeriod(userId, tenantId, factoryId, periodId, ctx, async (client, row) => {
      this.assertVersion(row, dto.expected_version);
      if (row.status !== 'SUBMITTED') throw new ConflictException('Only a submitted finance-close snapshot can be approved');
      if (row.submitted_by_user_id === userId || row.created_by_user_id === userId) {
        throw new ForbiddenException('Finance-close creator/submitter cannot approve their own close');
      }
      const snapshot = await this.buildCloseSnapshot(client, tenantId, factoryId, row.currency.trim(), row.period_start, row.period_end);
      this.assertSnapshotReady(snapshot);
      const currentHash = financeRequestHash(snapshot);
      if (currentHash !== row.snapshot_hash.trim()) {
        throw new ConflictException('Source facts or readiness changed after submission; the submitter must recall, refresh and resubmit');
      }
      const result = await client.query<ClosePeriodRow>(
        `UPDATE finance_close_periods SET status='APPROVED',approved_by_user_id=$1,
          approved_at=clock_timestamp(),approval_reason=$2,row_version=row_version+1
        WHERE id=$3 AND tenant_id=$4 AND factory_id=$5 AND status='SUBMITTED' AND row_version=$6
        RETURNING *`,
        [userId, reason, periodId, tenantId, factoryId, dto.expected_version],
      );
      if (!result.rows[0]) throw new ConflictException('Finance-close snapshot was concurrently changed');
      const updated = result.rows[0];
      await this.insertHistory(client, updated, 'APPROVED', userId, reason, { snapshot_hash: currentHash });
      await this.recordTransition(client, updated, userId, ctx, 'FINANCE_CLOSE_APPROVED', 'APPROVE', reason);
      return this.publicClosePeriod(updated);
    });
  }

  private async withLockedPeriod<T>(
    userId: string,
    tenantId: string,
    factoryId: string,
    periodId: string,
    ctx: FinanceEventContext,
    callback: (client: PoolClient, row: ClosePeriodRow) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction({
      tenantId, userId, requestId: this.uuidOrNull(ctx.requestId), traceId: this.uuidOrNull(ctx.traceId),
      advisoryLockKey: 'finance-close-period:' + tenantId + ':' + factoryId + ':' + periodId,
    }, async (client) => {
      const found = await client.query<ClosePeriodRow>(
        `SELECT * FROM finance_close_periods
        WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 FOR UPDATE`,
        [periodId, tenantId, factoryId],
      );
      const row = found.rows[0];
      if (!row) throw new NotFoundException('Finance-close period was not found in the active factory scope');
      return callback(client, row);
    });
  }

  private async buildCloseSnapshot(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    currency: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<Record<string, unknown> & { readiness: { missing_reporting_domains: string[]; unresolved_reconciliation_count: number; can_submit: boolean } }> {
    const performance = await client.query(
      `WITH scoped AS (
        SELECT f.* FROM financial_facts f
        JOIN finance_connectors fc
          ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
        WHERE f.tenant_id=$1 AND f.factory_id=$2 AND f.currency=$3
          AND fc.status='ACTIVE' AND fc.is_reporting_source
          AND f.fact_type IN (
            'ACTUAL_REVENUE','ACTUAL_COST','ACTUAL_CONTRIBUTION_COST',
            'FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST'
          )
          AND f.effective_at >= $4::date AND f.effective_at < ($5::date + interval '1 day')
      ), actuals AS (
        SELECT * FROM scoped WHERE fact_type IN ('ACTUAL_REVENUE','ACTUAL_COST','ACTUAL_CONTRIBUTION_COST')
      ), forecasts AS (
        SELECT DISTINCT ON (
          connector_id,fact_type,source_fact_key,currency,date_trunc('month',effective_at AT TIME ZONE 'UTC')
        ) *
        FROM scoped WHERE fact_type IN ('FORECAST_REVENUE','FORECAST_COST','FORECAST_CONTRIBUTION_COST')
        ORDER BY connector_id,fact_type,source_fact_key,currency,date_trunc('month',effective_at AT TIME ZONE 'UTC'),
          created_at DESC,effective_at DESC,id DESC
      ), selected AS (
        SELECT * FROM actuals UNION ALL SELECT * FROM forecasts
      )
      SELECT fact_type,sum(amount)::text AS amount,count(*)::int AS fact_count
      FROM selected GROUP BY fact_type ORDER BY fact_type`,
      [tenantId, factoryId, currency, periodStart, periodEnd],
    );
    const positions = await client.query(
      `WITH ranked AS (
        SELECT f.*,
          row_number() OVER (
            PARTITION BY f.connector_id,f.fact_type,f.source_fact_key,f.currency
            ORDER BY f.effective_at DESC,f.created_at DESC,f.id DESC
          ) AS position_rank
        FROM financial_facts f
        JOIN finance_connectors fc
          ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
        WHERE f.tenant_id=$1 AND f.factory_id=$2 AND f.currency=$3
          AND fc.status='ACTIVE' AND fc.is_reporting_source
          AND f.fact_type IN (
            'AR_OPEN','AP_OPEN','BANK_BALANCE','INVENTORY_VALUE','OPEN_PO_COMMITMENT',
            'LC_EXPOSURE','SHIPMENT_MILESTONE','TAX_LIABILITY','GL_BALANCE'
          )
          AND f.effective_at < ($4::date + interval '1 day')
      ), p AS (SELECT * FROM ranked WHERE position_rank=1)
      SELECT fact_type,sum(amount)::text AS amount,count(*)::int AS fact_count
      FROM p GROUP BY fact_type ORDER BY fact_type`,
      [tenantId, factoryId, currency, periodEnd],
    );
    const domains = await this.loadReportingDomains(client, tenantId, factoryId);
    const missingDomains = domains.filter((domain) => !domain.is_active).map((domain) => domain.domain);
    const mismatchResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
      FROM finance_fact_reconciliations r
      JOIN financial_facts f ON f.id=r.fact_id AND f.tenant_id=r.tenant_id AND f.factory_id=r.factory_id
      JOIN finance_connectors fc ON fc.id=f.connector_id AND fc.tenant_id=f.tenant_id AND fc.factory_id=f.factory_id
      WHERE r.tenant_id=$1 AND r.factory_id=$2 AND f.currency=$3
        AND fc.status='ACTIVE' AND fc.is_reporting_source
        AND r.match_status='MISMATCH' AND r.review_status='OPEN'
        AND f.effective_at >= $4::date AND f.effective_at < ($5::date + interval '1 day')`,
      [tenantId, factoryId, currency, periodStart, periodEnd],
    );
    const unresolvedCount = Number(mismatchResult.rows[0]?.count ?? 0);
    const readiness = {
      missing_reporting_domains: missingDomains,
      unresolved_reconciliation_count: unresolvedCount,
      can_submit: missingDomains.length === 0 && unresolvedCount === 0,
    };
    return {
      schema: 'factoryos.finance-close-snapshot/v1',
      currency,
      period_start: periodStart,
      period_end: periodEnd,
      currency_policy: 'Source currency retained; no implicit FX conversion.',
      source_of_record_policy: 'Only active reporting connectors are included; external accounting remains authoritative.',
      actual_forecast_policy: 'Actual facts are summed; forecast versions are de-duplicated by source key and latest source receipt.',
      period_costing_profitability: performance.rows,
      working_capital_positions: positions.rows,
      reporting_domains: domains,
      operational_reconciliation: {
        unresolved_mismatch_count: unresolvedCount,
      },
      readiness,
      prohibited_side_effects: ['journal_posting', 'payment_execution', 'bank_transaction_write', 'tax_submission'],
    };
  }

  private async loadReportingDomains(client: PoolClient, tenantId: string, factoryId: string) {
    const result = await client.query(
      `SELECT expected.domain,source.connector_code,source.source_system,
        source.status,latest.completed_at::text AS last_completed_at,
        (source.id IS NOT NULL) AS is_active
      FROM unnest($3::text[]) AS expected(domain)
      LEFT JOIN LATERAL (
        SELECT fc.id,fc.connector_code,fc.source_system,fc.status
        FROM finance_connectors fc
        WHERE fc.tenant_id=$1 AND fc.factory_id=$2 AND fc.domain=expected.domain
          AND fc.is_reporting_source AND fc.status='ACTIVE'
        ORDER BY fc.created_at DESC LIMIT 1
      ) source ON true
      LEFT JOIN LATERAL (
        SELECT max(r.completed_at) AS completed_at FROM finance_connector_runs r
        WHERE r.tenant_id=$1 AND r.factory_id=$2 AND r.connector_id=source.id
      ) latest ON true
      ORDER BY expected.domain`,
      [tenantId, factoryId, REQUIRED_REPORTING_DOMAINS],
    );
    return result.rows;
  }

  private assertSnapshotReady(
    snapshot: { readiness: { missing_reporting_domains: string[]; unresolved_reconciliation_count: number; can_submit: boolean } },
  ) {
    if (!snapshot.readiness.can_submit) {
      const missing = snapshot.readiness.missing_reporting_domains.join(', ') || 'none';
      throw new ConflictException(
        'Finance-close cannot be submitted with missing reporting domains (' + missing +
        ') or open reconciliation mismatches (' + snapshot.readiness.unresolved_reconciliation_count + ')',
      );
    }
  }

  private async insertHistory(
    client: PoolClient,
    row: ClosePeriodRow,
    action: 'CREATED' | 'REFRESHED' | 'SUBMITTED' | 'RECALLED' | 'APPROVED',
    actorUserId: string,
    reason: string,
    details: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO finance_close_period_history(
        tenant_id,factory_id,close_period_id,event_version,action,actor_user_id,reason,snapshot_hash,details
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [row.tenant_id, row.factory_id, row.id, Number(row.row_version), action, actorUserId,
        reason, row.snapshot_hash.trim(), JSON.stringify(details)],
    );
  }

  private async recordTransition(
    client: PoolClient,
    row: ClosePeriodRow,
    userId: string,
    ctx: FinanceEventContext,
    eventType: string,
    action: string,
    reason: string,
  ) {
    await this.audit(client, row.tenant_id, row.factory_id, userId, eventType, action, row.id, ctx, {
      currency: row.currency.trim(),
      period_start: row.period_start,
      period_end: row.period_end,
      status: row.status,
      row_version: Number(row.row_version),
      snapshot_hash: row.snapshot_hash.trim(),
      reason,
    });
    await this.outbox(client, row.tenant_id, row.factory_id, row.id, eventType, userId, ctx, {
      currency: row.currency.trim(),
      period_start: row.period_start,
      period_end: row.period_end,
      status: row.status,
      row_version: Number(row.row_version),
      snapshot_hash: row.snapshot_hash.trim(),
      reason,
    });
  }

  private async audit(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    userId: string,
    eventType: string,
    action: string,
    resourceId: string,
    ctx: FinanceEventContext,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO audit_events(tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,
        correlation_id,request_id,data_class,payload)
      VALUES($1,$2,$3,$4,$5,'FINANCE_CLOSE_PERIOD',$6,$7,$8,'CONFIDENTIAL',$9::jsonb)`,
      [tenantId, factoryId, userId, eventType, action, resourceId,
        this.uuidOrNull(ctx.traceId), this.uuidOrNull(ctx.requestId), JSON.stringify(payload)],
    );
  }

  private async outbox(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    aggregateId: string,
    eventType: string,
    userId: string,
    ctx: FinanceEventContext,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO outbox_events(tenant_id,factory_id,aggregate_type,aggregate_id,event_type,event_version,
        occurred_at,correlation_id,causation_id,actor,source,payload)
      VALUES($1,$2,'FINANCE_CLOSE',$3,$4,1,clock_timestamp(),$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
      [
        tenantId, factoryId, aggregateId, eventType,
        this.uuidOrNull(ctx.traceId) ?? this.uuidOrNull(ctx.requestId) ?? randomUUID(),
        this.uuidOrNull(ctx.requestId),
        JSON.stringify({ type: 'user', id: userId }),
        JSON.stringify({ system: 'FactoryOS', connector: 'finance-workbench', version: process.env.APP_VERSION ?? '0.0.1' }),
        JSON.stringify(payload),
      ],
    );
  }

  private publicClosePeriod(row: ClosePeriodRow) {
    return {
      id: row.id,
      currency: row.currency.trim(),
      period_start: row.period_start,
      period_end: row.period_end,
      status: row.status,
      row_version: Number(row.row_version),
      snapshot: row.snapshot,
      snapshot_hash: row.snapshot_hash.trim(),
      created_by_user_id: row.created_by_user_id,
      submitted_by_user_id: row.submitted_by_user_id,
      submitted_at: row.submitted_at,
      approved_by_user_id: row.approved_by_user_id,
      approved_at: row.approved_at,
      approval_reason: row.approval_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private validateDateOnly(value: string, name: string) {
    const date = new Date(value + 'T00:00:00.000Z');
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException(name + ' must be a valid YYYY-MM-DD date');
    }
    return value;
  }

  private requireIdempotencyKey(value: string | null) {
    const key = value?.trim() ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }
    return key;
  }

  private requireReason(value: string) {
    const reason = value.trim();
    if (reason.length < 8) throw new BadRequestException('A finance-close transition reason of at least 8 characters is required');
    return reason;
  }

  private assertVersion(row: ClosePeriodRow, expectedVersion: number) {
    if (Number(row.row_version) !== expectedVersion) {
      throw new ConflictException('Finance-close row version is stale; reload before retrying');
    }
  }

  private uuidOrNull(value: string | null | undefined): string | null {
    if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      return null;
    }
    return value;
  }
}
