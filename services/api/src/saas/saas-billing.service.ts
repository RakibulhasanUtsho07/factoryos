import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { ConfigureSaasBillingProviderDto } from './dto/configure-saas-billing-provider.dto';
import { CreateSaasBillingCloseDto } from './dto/create-saas-billing-close.dto';
import { ReconcileSaasBillingCloseDto } from './dto/reconcile-saas-billing-close.dto';
import { RetrySaasBillingPaymentDto } from './dto/retry-saas-billing-payment.dto';
import {
  StripeBillingProvider,
  StripeBillingProviderError,
  StripeInvoice,
  StripeInvoiceLine,
  StripeWebhookEvent,
} from './stripe-billing.provider';

type AccountRow = QueryResultRow & {
  id: string; tenant_id: string; provider_code: string; provider_customer_id: string;
  currency: string; collection_method: 'charge_automatically' | 'send_invoice';
  days_until_due: number | null; automatic_tax_enabled: boolean; tax_behavior: 'exclusive' | 'inclusive' | null;
  version: number | string; idempotency_key: string; request_hash: string;
  created_by: string; updated_by: string; created_at: string; updated_at: string;
};
type AccountEventRow = QueryResultRow & {
  id: string; tenant_id: string; provider_account_id: string; account_version: number | string;
  action: string; provider_code: string; provider_customer_id: string; currency: string;
  collection_method: 'charge_automatically' | 'send_invoice'; days_until_due: number | null;
  automatic_tax_enabled: boolean; tax_behavior: 'exclusive' | 'inclusive' | null;
  idempotency_key: string; request_hash: string; actor_user_id: string; created_at: string;
};
type CloseRow = QueryResultRow & {
  id: string; tenant_id: string; provider_account_id: string; provider_account_version: number | string;
  provider_code: string; provider_customer_id: string; collection_method: 'charge_automatically' | 'send_invoice';
  days_until_due: number | null; automatic_tax_enabled: boolean; tax_behavior: 'exclusive' | 'inclusive' | null;
  currency: string; period_start: string; period_end: string; usage_event_count: string | number;
  adjustment_count: string | number; usage_amount_minor: string | number; adjustment_amount_minor: string | number;
  expected_subtotal_minor: string | number; lines: BillingLine[]; snapshot_hash: string; request_hash: string;
  idempotency_key: string; closed_by: string; created_at: string;
};
type CloseEventRow = QueryResultRow & {
  id: string; tenant_id: string; close_id: string; event_type: string; provider_invoice_id: string | null;
  provider_invoice_status: string | null; idempotency_key: string; request_hash: string | null;
  error_code: string | null; evidence_hash: string | null; actor_user_id: string | null; created_at: string;
};
type ReconciliationRow = QueryResultRow & {
  id: string; tenant_id: string; close_id: string; provider_invoice_id: string; provider_invoice_status: string;
  provider_customer_id: string; currency: string; expected_subtotal_minor: string | number;
  provider_subtotal_minor: string | number; provider_tax_minor: string | number;
  provider_discount_minor: string | number; provider_total_minor: string | number;
  amount_due_minor: string | number; amount_paid_minor: string | number; automatic_tax_status: string | null;
  line_binding_valid: boolean; status: string; provider_snapshot_hash: string; report_hash: string;
  request_hash: string; idempotency_key: string; recorded_by: string; created_at: string;
};
type BillingLine = {
  key: string; marker: string; kind: 'USAGE' | 'ADJUSTMENT'; description: string;
  quantity: string; eventCount: number; amountMinor: string; metricCode: string | null;
};
type UsageAggregateRow = QueryResultRow & {
  metric_code: string; capability_code: string; workload_class: string; currency: string | null;
  event_count: string | number; total_quantity: string | number; total_cost_minor: string | number | null;
  unpriced_count: string | number;
};
type AdjustmentAggregateRow = QueryResultRow & {
  reason_code: string; currency: string; adjustment_count: string | number;
  total_quantity_delta: string | number; total_cost_delta_minor: string | number;
};

const ACCOUNT_COLUMNS = 'id::text AS id,tenant_id::text AS tenant_id,provider_code,provider_customer_id,currency,collection_method,days_until_due,automatic_tax_enabled,tax_behavior,version,idempotency_key,request_hash,created_by::text AS created_by,updated_by::text AS updated_by,created_at::text AS created_at,updated_at::text AS updated_at';
const ACCOUNT_EVENT_COLUMNS = 'id::text AS id,tenant_id::text AS tenant_id,provider_account_id::text AS provider_account_id,account_version,action,provider_code,provider_customer_id,currency,collection_method,days_until_due,automatic_tax_enabled,tax_behavior,idempotency_key,request_hash,actor_user_id::text AS actor_user_id,created_at::text AS created_at';
const CLOSE_COLUMNS = 'id::text AS id,tenant_id::text AS tenant_id,provider_account_id::text AS provider_account_id,provider_account_version,provider_code,provider_customer_id,collection_method,days_until_due,automatic_tax_enabled,tax_behavior,currency,period_start::text AS period_start,period_end::text AS period_end,usage_event_count,adjustment_count,usage_amount_minor::text AS usage_amount_minor,adjustment_amount_minor::text AS adjustment_amount_minor,expected_subtotal_minor::text AS expected_subtotal_minor,lines,snapshot_hash,request_hash,idempotency_key,closed_by::text AS closed_by,created_at::text AS created_at';
const EVENT_COLUMNS = 'id::text AS id,tenant_id::text AS tenant_id,close_id::text AS close_id,event_type,provider_invoice_id,provider_invoice_status,idempotency_key,request_hash,error_code,evidence_hash,actor_user_id::text AS actor_user_id,created_at::text AS created_at';
const RECON_COLUMNS = 'id::text AS id,tenant_id::text AS tenant_id,close_id::text AS close_id,provider_invoice_id,provider_invoice_status,provider_customer_id,currency,expected_subtotal_minor::text AS expected_subtotal_minor,provider_subtotal_minor::text AS provider_subtotal_minor,provider_tax_minor::text AS provider_tax_minor,provider_discount_minor::text AS provider_discount_minor,provider_total_minor::text AS provider_total_minor,amount_due_minor::text AS amount_due_minor,amount_paid_minor::text AS amount_paid_minor,automatic_tax_status,line_binding_valid,status,provider_snapshot_hash,report_hash,request_hash,idempotency_key,recorded_by::text AS recorded_by,created_at::text AS created_at';

@Injectable()
export class SaasBillingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly stripe: StripeBillingProvider,
  ) {}

  async configureProviderAccount(tenantId: string, actorUserId: string, input: ConfigureSaasBillingProviderDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.account.write');
    const normalized = this.normalizeAccount(input);
    const requestHash = this.hash({ tenantId, ...normalized.content, expectedVersion: normalized.expected_version });
    const prior = await this.database.query<AccountEventRow>(
      'SELECT ' + ACCOUNT_EVENT_COLUMNS + ' FROM saas_billing_provider_account_events WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',
      [tenantId, normalized.idempotency_key],
      { tenantId, userId: actorUserId },
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) {
        throw new ConflictException('Billing provider idempotency key was reused for different configuration');
      }
      return { idempotent: true, account: this.mapAccountEvent(prior.rows[0]) };
    }

    try {
      await this.stripe.verifyCustomer(normalized.content.provider_customer_id);
    } catch (error) {
      if (error instanceof StripeBillingProviderError && error.statusCode === 404) {
        throw new BadRequestException('The configured Stripe customer does not exist in the connected Stripe account');
      }
      if (error instanceof StripeBillingProviderError) {
        throw new ServiceUnavailableException('Stripe customer validation failed with code ' + error.providerCode);
      }
      throw error;
    }
    const result = await this.database.transaction(async (client) => {
      const duplicate = await client.query<AccountEventRow>(
        'SELECT ' + ACCOUNT_EVENT_COLUMNS + ' FROM saas_billing_provider_account_events WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',
        [tenantId, normalized.idempotency_key],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Billing provider idempotency key was reused for different configuration');
        }
        return { replay: true, account: this.mapAccountEvent(duplicate.rows[0]) };
      }

      const current = await client.query<AccountRow>(
        'SELECT ' + ACCOUNT_COLUMNS + ' FROM saas_billing_provider_accounts WHERE tenant_id=$1 FOR UPDATE',
        [tenantId],
      );
      const old = current.rows[0];
      let saved: AccountRow;
      if (!old) {
        if (normalized.expected_version !== 0) {
          throw new ConflictException('Billing provider account does not exist at the expected version');
        }
        const inserted = await client.query<AccountRow>(
          'INSERT INTO saas_billing_provider_accounts(tenant_id,provider_code,provider_customer_id,currency,collection_method,days_until_due,automatic_tax_enabled,tax_behavior,version,idempotency_key,request_hash,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$11) RETURNING ' + ACCOUNT_COLUMNS,
          [tenantId, normalized.content.provider_code, normalized.content.provider_customer_id,
            normalized.content.currency, normalized.content.collection_method, normalized.content.days_until_due,
            normalized.content.automatic_tax_enabled, normalized.content.tax_behavior, normalized.idempotency_key,
            requestHash, actorUserId],
        );
        saved = inserted.rows[0];
      } else {
        if (Number(old.version) !== normalized.expected_version) {
          throw new ConflictException('Billing provider account version changed; reload it before updating');
        }
        const updated = await client.query<AccountRow>(
          'UPDATE saas_billing_provider_accounts SET provider_customer_id=$3,currency=$4,collection_method=$5,days_until_due=$6,automatic_tax_enabled=$7,tax_behavior=$8,version=version+1,idempotency_key=$9,request_hash=$10,updated_by=$11,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND version=$12 RETURNING ' + ACCOUNT_COLUMNS,
          [tenantId, old.id, normalized.content.provider_customer_id, normalized.content.currency,
            normalized.content.collection_method, normalized.content.days_until_due, normalized.content.automatic_tax_enabled,
            normalized.content.tax_behavior, normalized.idempotency_key, requestHash, actorUserId, normalized.expected_version],
        );
        saved = updated.rows[0];
        if (!saved) throw new ConflictException('Billing provider account update lost an optimistic concurrency race');
      }

      const event = await client.query<AccountEventRow>(
        'INSERT INTO saas_billing_provider_account_events(tenant_id,provider_account_id,account_version,action,provider_code,provider_customer_id,currency,collection_method,days_until_due,automatic_tax_enabled,tax_behavior,idempotency_key,request_hash,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ' + ACCOUNT_EVENT_COLUMNS,
        [tenantId, saved.id, saved.version, old ? 'UPDATED' : 'CREATED', saved.provider_code,
          saved.provider_customer_id, saved.currency, saved.collection_method, saved.days_until_due,
          saved.automatic_tax_enabled, saved.tax_behavior, normalized.idempotency_key, requestHash, actorUserId],
      );
      return { replay: false, account: this.mapAccountEvent(event.rows[0]) };
    }, { tenantId, userId: actorUserId, isolationLevel: 'SERIALIZABLE', advisoryLockKey: 'saas-billing-account:' + tenantId });

    if (!result.replay) {
      await this.auditSafely({
        tenantId, actorUserId, eventType: 'SAAS_BILLING_PROVIDER_ACCOUNT',
        action: 'CONFIGURE_STRIPE_BILLING_CUSTOMER', resourceType: 'SAAS_BILLING_PROVIDER_ACCOUNT',
        resourceId: result.account.id,
        payload: {
          provider: 'stripe', providerCustomerIdSha256: this.sha(result.account.providerCustomerId),
          currency: result.account.currency, collectionMethod: result.account.collectionMethod,
          automaticTaxEnabled: result.account.automaticTaxEnabled, version: result.account.version,
          requestHash,
        },
      });
    }
    return { idempotent: result.replay, account: result.account };
  }

  async getProviderAccount(tenantId: string, actorUserId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.read');
    const row = await this.loadAccount(tenantId, actorUserId);
    return { account: this.mapAccount(row) };
  }

  async createBillingClose(tenantId: string, actorUserId: string, input: CreateSaasBillingCloseDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.close');
    return this.withTenantLedgerLock(tenantId, () =>
      this.createBillingCloseLocked(tenantId, actorUserId, input));
  }

  private async createBillingCloseLocked(tenantId: string, actorUserId: string, input: CreateSaasBillingCloseDto) {
    const period = this.normalizePeriod(input.period_start, input.period_end, 35);
    const currency = this.pattern(input.currency, 'currency', /^[A-Z]{3}$/);
    const idempotencyKey = this.idem(input.idempotency_key);
    const requestHash = this.hash({ tenantId, periodStart: period.start, periodEnd: period.end, currency });

    const prior = await this.findCloseByIdempotency(tenantId, actorUserId, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) throw new ConflictException('Billing-close idempotency key was reused for a different period');
      return this.closeResponse(prior, tenantId, actorUserId, true);
    }
    const existingPeriod = await this.database.query<CloseRow>(
      'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3 AND currency=$4 LIMIT 1',
      [tenantId, period.start, period.end, currency],
      { tenantId, userId: actorUserId },
    );
    if (existingPeriod.rows[0]) {
      if (existingPeriod.rows[0].request_hash !== requestHash) {
        throw new ConflictException('A billing close already exists for this tenant period and currency');
      }
      return this.closeResponse(existingPeriod.rows[0], tenantId, actorUserId, true);
    }

    const overlappingPeriod = await this.database.query<CloseRow>(
      'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND period_start < $3 AND period_end > $2 LIMIT 1',
      [tenantId, period.start, period.end],
      { tenantId, userId: actorUserId },
    );
    if (overlappingPeriod.rows[0]) {
      throw new ConflictException('Billing period overlaps an existing close; overlapping periods could double-invoice the same usage and are not permitted');
    }

    // Earlier versions of FactoryOS could reconcile an external invoice against
    // the same usage ledger without creating a commercial close. Until finance
    // explicitly migrates that invoice history, do not issue a second invoice
    // for any period that overlaps an existing source-of-record reconciliation.
    const legacyInvoice = await this.database.query<QueryResultRow & { id: string }>(
      'SELECT id::text AS id FROM saas_usage_reconciliations WHERE tenant_id=$1 AND period_start < $3 AND period_end > $2 LIMIT 1',
      [tenantId, period.start, period.end],
      { tenantId, userId: actorUserId },
    );
    if (legacyInvoice.rows[0]) {
      throw new ConflictException('Billing period overlaps an existing external invoice reconciliation; migrate/close the legacy invoice with finance before issuing a new commercial invoice');
    }

    const account = await this.loadAccount(tenantId, actorUserId);
    if (account.currency !== currency) {
      throw new BadRequestException('Billing-close currency must match the configured provider account currency');
    }

    const usage = await this.database.query<UsageAggregateRow>(
      'SELECT metric_code,capability_code,workload_class,currency,COUNT(*)::text AS event_count,' +
      'COALESCE(SUM(quantity),0)::text AS total_quantity,COALESCE(SUM(estimated_cost_minor),0)::text AS total_cost_minor,' +
      'COUNT(*) FILTER(WHERE estimated_cost_minor IS NULL)::text AS unpriced_count ' +
      'FROM saas_usage_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3 ' +
      'GROUP BY metric_code,capability_code,workload_class,currency ORDER BY metric_code,capability_code,workload_class,currency',
      [tenantId, period.start, period.end],
      { tenantId, userId: actorUserId },
    );
    const usageRows = usage.rows;
    const unpricedCount = usageRows.reduce((sum, row) => sum + BigInt(String(row.unpriced_count ?? 0)), 0n);
    if (unpricedCount > 0n) {
      throw new ConflictException('Billing close is blocked by ' + unpricedCount.toString() + ' unpriced usage event(s); correct or price them before issuing an invoice');
    }
    const currencyMismatch = usageRows.find((row) => row.currency !== currency);
    if (currencyMismatch) {
      throw new ConflictException('Billing close contains usage in a different or missing currency; reconcile currencies before issuing an invoice');
    }

    const partialAdjustment = await this.database.query<QueryResultRow & { id: string }>(
      'SELECT id::text AS id FROM saas_usage_adjustments WHERE tenant_id=$1 AND period_start < $3 AND period_end > $2 ' +
      'AND (period_start < $2 OR period_end > $3) LIMIT 1',
      [tenantId, period.start, period.end],
      { tenantId, userId: actorUserId },
    );
    if (partialAdjustment.rows[0]) {
      throw new ConflictException('Billing close overlaps an adjustment that crosses the selected period boundary; resolve the adjustment period before closing');
    }

    const adjustments = await this.database.query<AdjustmentAggregateRow>(
      'SELECT reason_code,currency,COUNT(*)::text AS adjustment_count,COALESCE(SUM(quantity_delta),0)::text AS total_quantity_delta,' +
      'COALESCE(SUM(cost_delta_minor),0)::text AS total_cost_delta_minor FROM saas_usage_adjustments ' +
      'WHERE tenant_id=$1 AND period_start >= $2 AND period_end <= $3 GROUP BY reason_code,currency ORDER BY reason_code,currency',
      [tenantId, period.start, period.end],
      { tenantId, userId: actorUserId },
    );
    const badAdjustmentCurrency = adjustments.rows.find((row) => row.currency !== currency);
    if (badAdjustmentCurrency) {
      throw new ConflictException('Billing close contains an adjustment in a different currency');
    }

    const usageAmount = usageRows.reduce((sum, row) => sum + BigInt(String(row.total_cost_minor ?? 0)), 0n);
    const adjustmentAmount = adjustments.rows.reduce((sum, row) => sum + BigInt(String(row.total_cost_delta_minor ?? 0)), 0n);
    const expectedSubtotal = usageAmount + adjustmentAmount;
    if (account.automatic_tax_enabled && adjustments.rows.some((row) => BigInt(String(row.total_cost_delta_minor ?? 0)) < 0n)) {
      throw new ConflictException('Automatic tax billing cannot issue negative adjustment invoice lines; route the credit through an approved provider credit-note and tax-correction process');
    }
    if (expectedSubtotal < 0n) {
      throw new ConflictException('Net adjustment exceeds billable usage; do not issue a negative invoice. Record the approved credit through the provider/accounting credit-note process');
    }
    this.assertMoneyRange(usageAmount, 'usage total');
    this.assertMoneyRange(adjustmentAmount, 'adjustment total');
    this.assertMoneyRange(expectedSubtotal, 'expected invoice subtotal');
    const usageCount = usageRows.reduce((sum, row) => sum + BigInt(String(row.event_count ?? 0)), 0n);
    const adjustmentCount = adjustments.rows.reduce((sum, row) => sum + BigInt(String(row.adjustment_count ?? 0)), 0n);
    const usageEventCount = this.safeCount(usageCount, 'usage event count');
    const totalAdjustmentCount = this.safeCount(adjustmentCount, 'adjustment count');

    const closeId = randomUUID();
    const lines: BillingLine[] = [];
    for (const row of usageRows) {
      const amount = BigInt(String(row.total_cost_minor ?? 0));
      if (amount === 0n) continue;
      const key = 'usage:' + row.metric_code + ':' + row.capability_code + ':' + row.workload_class;
      lines.push({
        key, marker: this.lineMarker(closeId, key), kind: 'USAGE',
        description: row.metric_code + ' usage - ' + row.capability_code + ' (' + row.workload_class + ')',
        quantity: String(row.total_quantity ?? '0'), eventCount: this.safeCount(BigInt(String(row.event_count ?? 0)), 'usage line event count'),
        amountMinor: amount.toString(), metricCode: row.metric_code,
      });
    }
    for (const row of adjustments.rows) {
      const amount = BigInt(String(row.total_cost_delta_minor ?? 0));
      if (amount === 0n) continue;
      const key = 'adjustment:' + row.reason_code;
      lines.push({
        key, marker: this.lineMarker(closeId, key), kind: 'ADJUSTMENT',
        description: 'Audited usage adjustment - ' + row.reason_code + ' (' + String(row.adjustment_count) + ' record(s))',
        quantity: String(row.total_quantity_delta ?? '0'), eventCount: this.safeCount(BigInt(String(row.adjustment_count ?? 0)), 'adjustment line count'),
        amountMinor: amount.toString(), metricCode: null,
      });
    }
    if (lines.length > 200) throw new BadRequestException('Billing close exceeds the safe provider invoice-line limit of 200');
    const snapshotHash = this.hash({
      tenantId, providerAccountId: account.id, providerAccountVersion: Number(account.version),
      providerCustomerId: account.provider_customer_id, currency, periodStart: period.start, periodEnd: period.end,
      usageEventCount, adjustmentCount: totalAdjustmentCount, usageAmountMinor: usageAmount.toString(),
      adjustmentAmountMinor: adjustmentAmount.toString(), expectedSubtotalMinor: expectedSubtotal.toString(), lines,
    });

    const inserted = await this.database.transaction(async (client) => {
      const priorByKey = await client.query<CloseRow>(
        'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',
        [tenantId, idempotencyKey],
      );
      if (priorByKey.rows[0]) {
        if (priorByKey.rows[0].request_hash !== requestHash) throw new ConflictException('Billing-close idempotency key was reused for a different period');
        return { row: priorByKey.rows[0], inserted: false };
      }
      const rowResult = await client.query<CloseRow>(
        'INSERT INTO saas_billing_close_runs(id,tenant_id,provider_account_id,provider_account_version,provider_code,provider_customer_id,collection_method,days_until_due,automatic_tax_enabled,tax_behavior,currency,period_start,period_end,usage_event_count,adjustment_count,usage_amount_minor,adjustment_amount_minor,expected_subtotal_minor,lines,snapshot_hash,request_hash,idempotency_key,closed_by) ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23) ON CONFLICT DO NOTHING RETURNING ' + CLOSE_COLUMNS,
        [closeId, tenantId, account.id, account.version, account.provider_code, account.provider_customer_id,
          account.collection_method, account.days_until_due, account.automatic_tax_enabled, account.tax_behavior,
          currency, period.start, period.end, usageEventCount, totalAdjustmentCount, usageAmount.toString(),
          adjustmentAmount.toString(), expectedSubtotal.toString(), JSON.stringify(lines), snapshotHash, requestHash,
          idempotencyKey, actorUserId],
      );
      if (rowResult.rows[0]) {
        await client.query(
          'INSERT INTO saas_billing_close_events(tenant_id,close_id,event_type,idempotency_key,request_hash,actor_user_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING',
          [tenantId, closeId, 'CLOSE_PREPARED', 'close-prepared:' + closeId, requestHash, actorUserId],
        );
        return { row: rowResult.rows[0], inserted: true };
      }
      const raced = await client.query<CloseRow>(
        'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND (idempotency_key=$2 OR (period_start=$3 AND period_end=$4 AND currency=$5)) ORDER BY created_at DESC LIMIT 1',
        [tenantId, idempotencyKey, period.start, period.end, currency],
      );
      const existing = raced.rows[0];
      if (!existing || existing.request_hash !== requestHash) {
        throw new ConflictException('Billing close was concurrently created with a different request or period snapshot');
      }
      return { row: existing, inserted: false };
    }, { tenantId, userId: actorUserId, isolationLevel: 'SERIALIZABLE', advisoryLockKey: 'saas-billing-close:' + tenantId + ':' + period.start + ':' + period.end + ':' + currency });

    if (inserted.inserted) {
      await this.auditSafely({
        tenantId, actorUserId, eventType: 'SAAS_BILLING_CLOSE', action: 'PREPARE_IMMUTABLE_BILLING_CLOSE',
        resourceType: 'SAAS_BILLING_CLOSE', resourceId: inserted.row.id,
        payload: {
          periodStart: inserted.row.period_start, periodEnd: inserted.row.period_end, currency,
          usageEventCount: usageEventCount, adjustmentCount: totalAdjustmentCount,
          usageAmountMinor: usageAmount.toString(), adjustmentAmountMinor: adjustmentAmount.toString(),
          expectedSubtotalMinor: expectedSubtotal.toString(), snapshotHash, semantics: 'CLOSE_SNAPSHOT_NOT_AN_ISSUED_INVOICE',
        },
      });
    }
    return this.closeResponse(inserted.row, tenantId, actorUserId, !inserted.inserted);
  }

  async getBillingClose(tenantId: string, actorUserId: string, closeId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.read');
    this.requireUuid(closeId, 'closeId');
    const close = await this.loadClose(tenantId, actorUserId, closeId);
    return this.closeResponse(close, tenantId, actorUserId, true);
  }

  async listBillingCloses(tenantId: string, actorUserId: string, limit = 25, offset = 0) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.read');
    this.page(limit, offset);
    const result = await this.database.query<CloseRow>(
      'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
      [tenantId, limit + 1, offset],
      { tenantId, userId: actorUserId },
    );
    const rows = result.rows.slice(0, limit);
    const responses = [];
    for (const row of rows) responses.push(await this.closeResponse(row, tenantId, actorUserId, true));
    return {
      limit, offset, resultCount: rows.length, hasMore: result.rows.length > limit,
      nextOffset: result.rows.length > limit ? offset + rows.length : null, closes: responses,
    };
  }

  async issueInvoice(tenantId: string, actorUserId: string, closeId: string) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.issue');
    this.requireUuid(closeId, 'closeId');
    const close = await this.loadClose(tenantId, actorUserId, closeId);
    const events = await this.loadCloseEvents(tenantId, actorUserId, closeId);
    const state = this.closeState(events);
    if (state === 'PAID' || state === 'VOIDED' || state === 'UNCOLLECTIBLE') {
      throw new ConflictException('Provider invoice is already terminal; do not issue a second invoice');
    }
    const expected = BigInt(String(close.expected_subtotal_minor));
    if (expected < 0n) throw new ConflictException('Negative invoice totals must use an approved provider credit-note workflow');
    if (expected === 0n) {
      await this.appendCloseEvent({
        tenantId, closeId, eventType: 'NO_CHARGE', idempotencyKey: 'no-charge:' + closeId,
        requestHash: close.request_hash, actorUserId,
      });
      return this.closeResponse(close, tenantId, actorUserId, true);
    }

    let invoiceId = this.latestInvoiceId(events);
    try {
      let invoice: StripeInvoice;
      if (invoiceId) {
        invoice = await this.stripe.retrieveInvoice(invoiceId);
      } else {
        // A process can die after Stripe creates the invoice but before the
        // provider ID is committed locally. Search the exact immutable close
        // marker before any create retry, including retries days later when
        // Stripe may have pruned its own idempotency cache.
        const recovered = await this.stripe.findInvoicesForClose(close.id);
        if (recovered.length > 1) {
          throw new ConflictException('More than one Stripe invoice carries this billing-close marker; stop and resolve the duplicate before issuing');
        }
        invoice = recovered[0] ?? await this.stripe.createInvoice({
          customerId: close.provider_customer_id,
          currency: close.currency,
          collectionMethod: close.collection_method,
          daysUntilDue: close.days_until_due === null ? null : Number(close.days_until_due),
          automaticTaxEnabled: close.automatic_tax_enabled,
          tenantId, closeId, snapshotHash: close.snapshot_hash,
        }, 'fo-billing-' + closeId + '-invoice-v1');
        invoiceId = invoice.id;
        await this.appendCloseEvent({
          tenantId, closeId, eventType: 'INVOICE_DRAFTED', providerInvoiceId: invoice.id,
          providerInvoiceStatus: invoice.status, idempotencyKey: 'invoice-drafted:' + closeId,
          requestHash: close.request_hash, actorUserId,
        });
      }

      this.assertInvoiceBelongsToClose(invoice, close);
      if (invoice.status === 'draft') {
        const providerLines = await this.stripe.listInvoiceLines(invoice.id);
        for (const line of close.lines ?? []) {
          const amount = this.safeProviderAmount(BigInt(String(line.amountMinor)), 'invoice line amount');
          const description = line.description + ' [ref ' + line.marker + ']';
          const matches = providerLines.filter((item) => item.description === description);
          if (matches.length > 1) throw new ConflictException('Stripe invoice contains duplicate FactoryOS billing line markers');
          if (matches.length === 1) {
            if (matches[0].amountMinor !== amount || matches[0].currency !== close.currency) {
              throw new ConflictException('Stripe invoice contains a billing line with a conflicting amount or currency');
            }
            continue;
          }
          await this.stripe.createInvoiceItem({
            invoiceId: invoice.id,
            customerId: close.provider_customer_id,
            currency: close.currency,
            amountMinor: amount,
            description,
            taxBehavior: close.automatic_tax_enabled ? close.tax_behavior : null,
            metadata: {
              factoryos_tenant_id: tenantId,
              factoryos_billing_close_id: close.id,
              factoryos_billing_snapshot_hash: close.snapshot_hash,
              factoryos_billing_line_marker: line.marker,
            },
          }, 'fo-billing-' + closeId + '-line-' + line.marker);
          await this.appendCloseEvent({
            tenantId, closeId, eventType: 'LINE_ITEM_ATTACHED', providerInvoiceId: invoice.id,
            providerInvoiceStatus: 'draft', idempotencyKey: 'line-attached:' + closeId + ':' + line.marker,
            requestHash: this.hash({ closeId, marker: line.marker, amountMinor: line.amountMinor, currency: close.currency }),
            evidenceHash: this.hash({ invoiceId: invoice.id, marker: line.marker, amountMinor: line.amountMinor }),
            actorUserId,
          });
        }
        invoice = await this.stripe.finalizeInvoice(invoice.id, 'fo-billing-' + closeId + '-finalize-v1');
        if (invoice.status === 'draft') {
          throw new ConflictException('Stripe invoice finalization returned a draft; the close remains retryable');
        }
      }

      this.assertInvoiceBelongsToClose(invoice, close);
      this.assertInvoiceTaxReady(close, invoice);
      if (invoice.status === 'open' && close.collection_method === 'send_invoice') {
        invoice = await this.stripe.sendInvoice(invoice.id, 'fo-billing-' + closeId + '-send-v1');
        this.assertInvoiceBelongsToClose(invoice, close);
      } else if (invoice.status === 'open' && close.collection_method === 'charge_automatically') {
        // Keep auto_advance disabled while FactoryOS is binding line receipts to the immutable close.
        // Collection is an explicit, stable provider request, so failures can be reconciled and retried.
        await this.appendCloseEvent({
          tenantId, closeId, eventType: 'INVOICE_ISSUED', providerInvoiceId: invoice.id,
          providerInvoiceStatus: invoice.status, idempotencyKey: 'invoice-issued:' + closeId,
          requestHash: close.request_hash,
          evidenceHash: this.hash({ invoiceId: invoice.id, status: invoice.status, total: invoice.totalMinor }),
          actorUserId,
        });
        try {
          invoice = await this.stripe.payInvoice(invoice.id, 'fo-billing-' + closeId + '-initial-payment-v1');
        } catch (error) {
          await this.appendCloseEvent({
            tenantId, closeId, eventType: 'PAYMENT_FAILED', providerInvoiceId: invoice.id,
            providerInvoiceStatus: 'open', idempotencyKey: 'initial-payment-failed:' + closeId,
            requestHash: close.request_hash, errorCode: this.safeErrorCode(error), actorUserId,
          });
          await this.auditSafely({
            tenantId, actorUserId, eventType: 'SAAS_BILLING_PAYMENT', action: 'INITIAL_STRIPE_PAYMENT_FAILED',
            resourceType: 'SAAS_BILLING_CLOSE', resourceId: closeId,
            payload: { providerInvoiceId: invoice.id, errorCode: this.safeErrorCode(error), snapshotHash: close.snapshot_hash },
          });
          return this.closeResponse(close, tenantId, actorUserId, false);
        }
        if (invoice.status !== 'paid' && invoice.amountRemainingMinor > 0) {
          await this.appendCloseEvent({
            tenantId, closeId, eventType: 'PAYMENT_FAILED', providerInvoiceId: invoice.id,
            providerInvoiceStatus: invoice.status, idempotencyKey: 'initial-payment-failed:' + closeId,
            requestHash: close.request_hash,
            evidenceHash: this.hash({ invoiceId: invoice.id, status: invoice.status, amountRemainingMinor: invoice.amountRemainingMinor }),
            actorUserId,
          });
          await this.auditSafely({
            tenantId, actorUserId, eventType: 'SAAS_BILLING_PAYMENT', action: 'INITIAL_STRIPE_PAYMENT_NOT_COLLECTED',
            resourceType: 'SAAS_BILLING_CLOSE', resourceId: closeId,
            payload: { providerInvoiceId: invoice.id, status: invoice.status, amountRemainingMinor: invoice.amountRemainingMinor },
          });
          return this.closeResponse(close, tenantId, actorUserId, false);
        }
      }
      const issueEvent = invoice.status === 'void' ? 'INVOICE_VOIDED'
        : invoice.status === 'uncollectible' ? 'INVOICE_UNCOLLECTIBLE' : 'INVOICE_ISSUED';
      await this.appendCloseEvent({
        tenantId, closeId, eventType: issueEvent, providerInvoiceId: invoice.id,
        providerInvoiceStatus: invoice.status, idempotencyKey: 'invoice-issued:' + closeId,
        requestHash: close.request_hash,
        evidenceHash: this.hash({ invoiceId: invoice.id, status: invoice.status, total: invoice.totalMinor }),
        actorUserId,
      });
      if (invoice.status === 'paid') {
        await this.appendCloseEvent({
          tenantId, closeId, eventType: 'INVOICE_PAID', providerInvoiceId: invoice.id,
          providerInvoiceStatus: invoice.status, idempotencyKey: 'invoice-paid-after-issue:' + closeId,
          evidenceHash: this.hash({ invoiceId: invoice.id, amountPaidMinor: invoice.amountPaidMinor }),
          actorUserId,
        });
      }
      await this.auditSafely({
        tenantId, actorUserId, eventType: 'SAAS_BILLING_INVOICE', action: 'ISSUE_STRIPE_INVOICE',
        resourceType: 'SAAS_BILLING_CLOSE', resourceId: closeId,
        payload: {
          provider: 'stripe', providerInvoiceId: invoice.id, providerInvoiceStatus: invoice.status,
          expectedSubtotalMinor: String(close.expected_subtotal_minor), providerSubtotalMinor: String(invoice.subtotalMinor),
          providerTaxMinor: String(invoice.taxMinor), providerTotalMinor: String(invoice.totalMinor),
          currency: invoice.currency, snapshotHash: close.snapshot_hash,
        },
      });
      return this.closeResponse(close, tenantId, actorUserId, false);
    } catch (error) {
      await this.appendCloseEvent({
        tenantId, closeId, eventType: 'ISSUE_FAILED', providerInvoiceId: invoiceId,
        providerInvoiceStatus: null, idempotencyKey: 'issue-failed:' + closeId + ':' + randomUUID(),
        requestHash: close.request_hash, errorCode: this.safeErrorCode(error), actorUserId,
      }).catch(() => undefined);
      await this.auditSafely({
        tenantId, actorUserId, eventType: 'SAAS_BILLING_INVOICE', action: 'ISSUE_STRIPE_INVOICE_FAILED',
        resourceType: 'SAAS_BILLING_CLOSE', resourceId: closeId,
        payload: { errorCode: this.safeErrorCode(error), providerInvoiceId: invoiceId, snapshotHash: close.snapshot_hash },
      });
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      if (error instanceof StripeBillingProviderError) {
        throw new ServiceUnavailableException('Stripe invoice operation failed with code ' + error.providerCode + '; retry the same billing close safely');
      }
      throw new ServiceUnavailableException('Stripe invoice operation did not complete; retry the same billing close safely');
    }
  }

  async retryPayment(tenantId: string, actorUserId: string, closeId: string, input: RetrySaasBillingPaymentDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.issue');
    this.requireUuid(closeId, 'closeId');
    const idempotencyKey = this.idem(input.idempotency_key);
    const requestHash = this.hash({ tenantId, closeId, idempotencyKey });
    const replayKeys = [
      'payment-retry:' + idempotencyKey,
      'payment-retry-attempt:' + idempotencyKey,
      'payment-retry-paid:' + idempotencyKey,
    ];
    const replay = await this.database.query<CloseEventRow>(
      'SELECT ' + EVENT_COLUMNS + ' FROM saas_billing_close_events WHERE tenant_id=$1 AND idempotency_key = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1',
      [tenantId, replayKeys],
      { tenantId, userId: actorUserId },
    );
    const replayedRequest = Boolean(replay.rows[0]);
    if (replay.rows[0] && replay.rows[0].request_hash !== requestHash) {
      throw new ConflictException('Payment retry idempotency key was reused for different content');
    }

    // Replayed requests still re-read the provider invoice. A first response
    // may have timed out after Stripe charged successfully; returning only the
    // local failure receipt would leave the close stale. The provider request
    // below uses the same stable idempotency key for a replay.
    const close = await this.loadClose(tenantId, actorUserId, closeId);
    const events = await this.loadCloseEvents(tenantId, actorUserId, closeId);
    if (!events.some((event) => event.event_type === 'PAYMENT_FAILED')) {
      throw new ConflictException('Payment retry is permitted only after a recorded provider payment failure');
    }
    const invoiceId = this.latestInvoiceId(events);
    if (!invoiceId) throw new ConflictException('No provider invoice exists for this billing close');
    const invoice = await this.stripe.retrieveInvoice(invoiceId);
    this.assertInvoiceBelongsToClose(invoice, close);
    if (invoice.status === 'paid') {
      await this.appendCloseEvent({
        tenantId, closeId, eventType: 'INVOICE_PAID', providerInvoiceId: invoiceId,
        providerInvoiceStatus: 'paid', idempotencyKey: 'payment-retry-paid:' + idempotencyKey,
        requestHash,
        evidenceHash: this.hash({ invoiceId, amountPaidMinor: invoice.amountPaidMinor }), actorUserId,
      });
      return this.closeResponse(close, tenantId, actorUserId, replayedRequest);
    }
    if (invoice.status !== 'open' || invoice.amountRemainingMinor <= 0) {
      throw new ConflictException('Only an open invoice with an outstanding amount may be retried');
    }
    if (close.collection_method !== 'charge_automatically') {
      throw new ConflictException('Send-invoice collections must be recovered by the provider receivables process, not an automatic charge retry');
    }

    try {
      const paidInvoice = await this.stripe.payInvoice(
        invoiceId,
        'fo-billing-' + closeId + '-payment-' + this.sha(idempotencyKey).slice(0, 32),
      );
      await this.appendCloseEvent({
        tenantId, closeId, eventType: paidInvoice.status === 'paid' ? 'INVOICE_PAID' : 'PAYMENT_RETRY_ATTEMPTED',
        providerInvoiceId: invoiceId, providerInvoiceStatus: paidInvoice.status,
        idempotencyKey: (paidInvoice.status === 'paid' ? 'payment-retry-paid:' : 'payment-retry-attempt:') + idempotencyKey,
        requestHash,
        evidenceHash: this.hash({ invoiceId, status: paidInvoice.status, amountPaidMinor: paidInvoice.amountPaidMinor }),
        actorUserId,
      });
      await this.auditSafely({
        tenantId, actorUserId, eventType: 'SAAS_BILLING_PAYMENT', action: 'RETRY_FAILED_STRIPE_PAYMENT',
        resourceType: 'SAAS_BILLING_CLOSE', resourceId: closeId,
        payload: { providerInvoiceId: invoiceId, providerInvoiceStatus: paidInvoice.status, amountPaidMinor: paidInvoice.amountPaidMinor },
      });
    } catch (error) {
      await this.appendCloseEvent({
        tenantId, closeId, eventType: 'PAYMENT_FAILED', providerInvoiceId: invoiceId,
        providerInvoiceStatus: 'open', idempotencyKey: 'payment-retry:' + idempotencyKey,
        requestHash, errorCode: this.safeErrorCode(error), actorUserId,
      }).catch(() => undefined);
      if (error instanceof StripeBillingProviderError) {
        throw new ServiceUnavailableException('Stripe payment retry failed with code ' + error.providerCode + '; use a new idempotency key for a new authorized attempt');
      }
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Stripe payment retry did not complete; use the same idempotency key to safely replay it');
    }
    return this.closeResponse(close, tenantId, actorUserId, false);
  }

  async reconcileInvoice(tenantId: string, actorUserId: string, closeId: string, input: ReconcileSaasBillingCloseDto) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.reconcile');
    this.requireUuid(closeId, 'closeId');
    const idempotencyKey = this.idem(input.idempotency_key);
    const requestHash = this.hash({ tenantId, closeId, idempotencyKey });
    const prior = await this.database.query<ReconciliationRow>(
      'SELECT ' + RECON_COLUMNS + ' FROM saas_billing_reconciliation_results WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',
      [tenantId, idempotencyKey],
      { tenantId, userId: actorUserId },
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new ConflictException('Billing reconciliation idempotency key was reused for a different close');
      return { idempotent: true, reconciliation: this.mapReconciliation(prior.rows[0]) };
    }

    const close = await this.loadClose(tenantId, actorUserId, closeId);
    const events = await this.loadCloseEvents(tenantId, actorUserId, closeId);
    const invoiceId = this.latestInvoiceId(events);
    if (!invoiceId) throw new ConflictException('The billing close has no provider invoice to reconcile');
    const invoice = await this.stripe.retrieveInvoice(invoiceId);
    this.assertInvoiceBelongsToClose(invoice, close);
    const providerLines = await this.stripe.listInvoiceLines(invoice.id);
    const lineBindingValid = this.checkInvoiceLines(close, providerLines);
    const expectedSubtotal = BigInt(String(close.expected_subtotal_minor));
    const providerSnapshotHash = this.hash({
      invoiceId: invoice.id, customerId: invoice.customerId, currency: invoice.currency,
      status: invoice.status, subtotal: invoice.subtotalMinor, tax: invoice.taxMinor,
      discount: invoice.discountMinor, total: invoice.totalMinor, amountDue: invoice.amountDueMinor,
      amountPaid: invoice.amountPaidMinor, amountRemaining: invoice.amountRemainingMinor,
      automaticTaxStatus: invoice.automaticTaxStatus, automaticTaxEnabled: invoice.automaticTaxEnabled,
      lineBindingValid, lineCount: providerLines.length,
      lines: providerLines.map((line) => ({ amount: line.amountMinor, currency: line.currency, description: line.description })),
    });
    let status: string;
    if (invoice.status === 'draft') status = 'DRAFT';
    else if (invoice.customerId !== close.provider_customer_id) status = 'CUSTOMER_MISMATCH';
    else if (invoice.currency !== close.currency) status = 'CURRENCY_MISMATCH';
    else if (invoice.status === 'void') status = 'VOIDED';
    else if (invoice.status === 'uncollectible') status = 'UNCOLLECTIBLE';
    else if (!lineBindingValid || BigInt(invoice.subtotalMinor) !== expectedSubtotal
      || BigInt(invoice.discountMinor) !== 0n) status = 'VARIANCE';
    else if (close.automatic_tax_enabled && invoice.automaticTaxStatus !== 'complete') status = 'TAX_REVIEW';
    else if (!close.automatic_tax_enabled && BigInt(invoice.taxMinor) !== 0n) status = 'TAX_REVIEW';
    else if (invoice.status === 'paid') status = 'MATCHED_PAID';
    else status = 'MATCHED_OPEN';

    const reportHash = this.hash({
      closeId, closeSnapshotHash: close.snapshot_hash, providerSnapshotHash,
      expectedSubtotalMinor: expectedSubtotal.toString(), providerSubtotalMinor: String(invoice.subtotalMinor),
      providerTaxMinor: String(invoice.taxMinor), providerDiscountMinor: String(invoice.discountMinor),
      providerTotalMinor: String(invoice.totalMinor), currency: invoice.currency, status, lineBindingValid,
    });
    const saved = await this.database.query<ReconciliationRow>(
      'INSERT INTO saas_billing_reconciliation_results(tenant_id,close_id,provider_invoice_id,provider_invoice_status,provider_customer_id,currency,expected_subtotal_minor,provider_subtotal_minor,provider_tax_minor,provider_discount_minor,provider_total_minor,amount_due_minor,amount_paid_minor,automatic_tax_status,line_binding_valid,status,provider_snapshot_hash,report_hash,request_hash,idempotency_key,recorded_by) ' +
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT DO NOTHING RETURNING ' + RECON_COLUMNS,
      [tenantId, closeId, invoice.id, invoice.status, invoice.customerId, invoice.currency,
        expectedSubtotal.toString(), String(invoice.subtotalMinor), String(invoice.taxMinor), String(invoice.discountMinor),
        String(invoice.totalMinor), String(invoice.amountDueMinor), String(invoice.amountPaidMinor), invoice.automaticTaxStatus,
        lineBindingValid, status, providerSnapshotHash, reportHash, requestHash, idempotencyKey, actorUserId],
      { tenantId, userId: actorUserId },
    );
    let row = saved.rows[0];
    if (!row) {
      const raced = await this.database.query<ReconciliationRow>(
        'SELECT ' + RECON_COLUMNS + ' FROM saas_billing_reconciliation_results WHERE tenant_id=$1 AND ' +
        '(idempotency_key=$2 OR (close_id=$3 AND provider_invoice_id=$4 AND provider_snapshot_hash=$5)) ORDER BY created_at DESC LIMIT 1',
        [tenantId, idempotencyKey, closeId, invoice.id, providerSnapshotHash],
        { tenantId, userId: actorUserId },
      );
      row = raced.rows[0];
      if (!row) throw new ConflictException('Concurrent billing reconciliation could not be read back');
      if (row.idempotency_key === idempotencyKey && row.request_hash !== requestHash) {
        throw new ConflictException('Billing reconciliation idempotency key conflicts with an existing request');
      }
      return { idempotent: true, reconciliation: this.mapReconciliation(row) };
    }

    await this.appendCloseEvent({
      tenantId, closeId, eventType: 'RECONCILED', providerInvoiceId: invoice.id,
      providerInvoiceStatus: invoice.status, idempotencyKey: 'reconciled:' + row.id,
      requestHash, evidenceHash: reportHash, actorUserId,
    });
    await this.auditSafely({
      tenantId, actorUserId, eventType: 'SAAS_BILLING_RECONCILIATION', action: 'RECONCILE_PROVIDER_INVOICE',
      resourceType: 'SAAS_BILLING_RECONCILIATION', resourceId: row.id,
      payload: {
        provider: 'stripe', providerInvoiceId: invoice.id, invoiceStatus: invoice.status,
        currency: invoice.currency, expectedSubtotalMinor: String(row.expected_subtotal_minor),
        providerSubtotalMinor: String(row.provider_subtotal_minor), providerTaxMinor: String(row.provider_tax_minor),
        providerDiscountMinor: String(row.provider_discount_minor), providerTotalMinor: String(row.provider_total_minor),
        lineBindingValid, status, reportHash,
      },
    });
    return { idempotent: false, reconciliation: this.mapReconciliation(row) };
  }

  async listReconciliations(tenantId: string, actorUserId: string, closeId: string, limit = 25, offset = 0) {
    this.scope(tenantId, actorUserId);
    await this.authorize(actorUserId, tenantId, 'saas.billing.read');
    this.requireUuid(closeId, 'closeId');
    this.page(limit, offset);
    const result = await this.database.query<ReconciliationRow>(
      'SELECT ' + RECON_COLUMNS + ' FROM saas_billing_reconciliation_results WHERE tenant_id=$1 AND close_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4',
      [tenantId, closeId, limit + 1, offset],
      { tenantId, userId: actorUserId },
    );
    const rows = result.rows.slice(0, limit);
    return {
      limit, offset, resultCount: rows.length, hasMore: result.rows.length > limit,
      nextOffset: result.rows.length > limit ? offset + rows.length : null,
      reconciliations: rows.map((row) => this.mapReconciliation(row)),
    };
  }

  async receiveStripeWebhook(signature: string | undefined, rawBody: Buffer) {
    const webhook = this.stripe.verifyWebhook(signature, rawBody);
    if (!webhook.type.startsWith('invoice.')) return { accepted: true, ignored: true, reason: 'Unsupported Stripe event type' };
    const invoice = webhook.data.object;
    const metadata = isRecord(invoice.metadata) ? invoice.metadata : {};
    const tenantId = typeof metadata.factoryos_tenant_id === 'string' ? metadata.factoryos_tenant_id : '';
    const closeId = typeof metadata.factoryos_billing_close_id === 'string' ? metadata.factoryos_billing_close_id : '';
    const invoiceId = typeof invoice.id === 'string' ? invoice.id : '';
    const hasFactoryOsBillingMetadata = [
      'factoryos_tenant_id', 'factoryos_billing_close_id', 'factoryos_billing_snapshot_hash',
    ].some((key) => Object.prototype.hasOwnProperty.call(metadata, key));
    if (!hasFactoryOsBillingMetadata) {
      return { accepted: true, ignored: true, reason: 'Invoice is not linked to a FactoryOS billing close' };
    }
    if (!isUUID(tenantId) || !isUUID(closeId) || !/^in_[A-Za-z0-9]+$/.test(invoiceId)) {
      throw new ConflictException('Stripe invoice contains incomplete FactoryOS billing metadata; webhook delivery is rejected for reconciliation');
    }
    const close = await this.database.query<CloseRow>(
      'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND id=$2 LIMIT 1',
      [tenantId, closeId],
      { tenantId },
    );
    if (!close.rows[0]) {
      throw new ConflictException('Stripe invoice references a FactoryOS billing close that was not found; webhook must be reconciled before acknowledgement');
    }
    const closeRow = close.rows[0];
    const eventCustomer = typeof invoice.customer === 'string' ? invoice.customer
      : isRecord(invoice.customer) && typeof invoice.customer.id === 'string' ? invoice.customer.id : '';
    if (metadata.factoryos_billing_snapshot_hash !== closeRow.snapshot_hash
      || eventCustomer !== closeRow.provider_customer_id) {
      throw new ConflictException('Stripe invoice snapshot or customer binding does not match the immutable close; webhook delivery is rejected for reconciliation');
    }

    const status = typeof invoice.status === 'string' ? invoice.status : null;
    const eventType = this.webhookCloseEventType(webhook, status);
    const payloadHash = this.sha(rawBody);
    const eventKey = 'stripe-webhook:' + webhook.id;
    const requestHash = this.hash({
      eventId: webhook.id, eventType: webhook.type, invoiceId, tenantId, closeId, payloadHash,
    });
    const inserted = await this.database.transaction(async (client) => {
      const prior = await client.query<QueryResultRow & { payload_hash: string }>(
        'SELECT payload_hash FROM saas_billing_provider_webhook_events WHERE provider_code=$1 AND provider_event_id=$2 LIMIT 1',
        ['stripe', webhook.id],
      );
      if (prior.rows[0] && prior.rows[0].payload_hash !== payloadHash) {
        throw new ConflictException('Stripe webhook event ID was replayed with a different payload digest');
      }
      const result = await client.query(
        'INSERT INTO saas_billing_provider_webhook_events(tenant_id,provider_code,provider_event_id,event_type,close_id,provider_invoice_id,signature_timestamp,payload_hash) ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider_code,provider_event_id) DO NOTHING RETURNING id',
        [tenantId, 'stripe', webhook.id, webhook.type, closeId, invoiceId, webhook.signatureTimestamp, payloadHash],
      );
      await client.query(
        'INSERT INTO saas_billing_close_events(tenant_id,close_id,event_type,provider_invoice_id,provider_invoice_status,idempotency_key,request_hash,evidence_hash) ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING',
        [tenantId, closeId, eventType, invoiceId, normalizeProviderStatus(status),
          eventKey, requestHash, payloadHash],
      );
      return result.rowCount === 1;
    }, { tenantId, userId: null, isolationLevel: 'SERIALIZABLE', advisoryLockKey: 'stripe-billing-webhook:' + webhook.id });
    return { accepted: true, duplicate: !inserted };
  }

  private webhookCloseEventType(event: StripeWebhookEvent, status: string | null): string {
    if (event.type === 'invoice.paid' || status === 'paid') return 'INVOICE_PAID';
    if (event.type === 'invoice.payment_failed') return 'PAYMENT_FAILED';
    if (event.type === 'invoice.voided' || status === 'void') return 'INVOICE_VOIDED';
    if (event.type === 'invoice.marked_uncollectible' || status === 'uncollectible') return 'INVOICE_UNCOLLECTIBLE';
    if (event.type === 'invoice.finalized' || status === 'open') return 'INVOICE_ISSUED';
    if (status === 'draft') return 'INVOICE_DRAFTED';
    return 'WEBHOOK_OBSERVED';
  }

  private async closeResponse(close: CloseRow, tenantId: string, actorUserId: string, idempotent: boolean) {
    const events = await this.loadCloseEvents(tenantId, actorUserId, close.id);
    const lastInvoiceId = this.latestInvoiceId(events);
    const state = this.closeState(events);
    return {
      idempotent, close: {
        id: close.id, provider: close.provider_code, providerCustomerId: close.provider_customer_id,
        providerAccountVersion: Number(close.provider_account_version), currency: close.currency,
        periodStart: close.period_start, periodEnd: close.period_end,
        usageEventCount: Number(close.usage_event_count), adjustmentCount: Number(close.adjustment_count),
        usageAmountMinor: String(close.usage_amount_minor), adjustmentAmountMinor: String(close.adjustment_amount_minor),
        expectedSubtotalMinor: String(close.expected_subtotal_minor), lines: close.lines,
        snapshotHash: close.snapshot_hash, providerInvoiceId: lastInvoiceId, status: state,
        automaticTaxEnabled: close.automatic_tax_enabled, createdAt: close.created_at,
      },
      events: events.map((event) => ({
        id: event.id, type: event.event_type, providerInvoiceId: event.provider_invoice_id,
        providerInvoiceStatus: event.provider_invoice_status, errorCode: event.error_code,
        evidenceHash: event.evidence_hash, createdAt: event.created_at,
      })),
    };
  }

  private closeState(events: CloseEventRow[]): string {
    // Provider webhooks may arrive out of order. Once the append-only evidence
    // contains a paid receipt, a delayed invoice.finalized/open event cannot
    // regress the customer-facing close state back to "issued".
    if (events.some((event) => event.event_type === 'INVOICE_PAID')) return 'PAID';
    for (const event of events) {
      if (event.event_type === 'NO_CHARGE') return 'NO_CHARGE';
      if (event.event_type === 'INVOICE_PAID') return 'PAID';
      if (event.event_type === 'INVOICE_VOIDED') return 'VOIDED';
      if (event.event_type === 'INVOICE_UNCOLLECTIBLE') return 'UNCOLLECTIBLE';
      if (event.event_type === 'PAYMENT_FAILED') return 'PAYMENT_FAILED';
      if (event.event_type === 'ISSUE_FAILED') return 'RETRY_REQUIRED';
      if (event.event_type === 'INVOICE_ISSUED') return 'ISSUED';
      if (event.event_type === 'INVOICE_DRAFTED' || event.event_type === 'LINE_ITEM_ATTACHED') return 'ISSUING';
      if (event.event_type === 'CLOSE_PREPARED') return 'PREPARED';
    }
    return 'PREPARED';
  }

  private async withTenantLedgerLock<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
    const client = await this.database.getClient();
    const lockKey = 'saas-billing-ledger:' + tenantId;
    let locked = false;
    let discardClient = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
      locked = true;
      return await callback();
    } finally {
      if (locked) {
        try {
          const result = await client.query<{ pg_advisory_unlock: boolean }>(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [lockKey],
          );
          discardClient = result.rows[0]?.pg_advisory_unlock !== true;
        } catch {
          // Never return a pooled connection that could still hold the session lock.
          discardClient = true;
        }
      }
      client.release(discardClient);
    }
  }

  private async loadAccount(tenantId: string, actorUserId: string): Promise<AccountRow> {
    const result = await this.database.query<AccountRow>(
      'SELECT ' + ACCOUNT_COLUMNS + ' FROM saas_billing_provider_accounts WHERE tenant_id=$1 LIMIT 1',
      [tenantId],
      { tenantId, userId: actorUserId },
    );
    if (!result.rows[0]) throw new NotFoundException('Stripe billing provider account is not configured for this tenant');
    return result.rows[0];
  }

  private async findCloseByIdempotency(tenantId: string, actorUserId: string, key: string): Promise<CloseRow | null> {
    const result = await this.database.query<CloseRow>(
      'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1',
      [tenantId, key],
      { tenantId, userId: actorUserId },
    );
    return result.rows[0] ?? null;
  }

  private async loadClose(tenantId: string, actorUserId: string, closeId: string): Promise<CloseRow> {
    const result = await this.database.query<CloseRow>(
      'SELECT ' + CLOSE_COLUMNS + ' FROM saas_billing_close_runs WHERE tenant_id=$1 AND id=$2 LIMIT 1',
      [tenantId, closeId],
      { tenantId, userId: actorUserId },
    );
    if (!result.rows[0]) throw new NotFoundException('SaaS billing close was not found in this tenant');
    return result.rows[0];
  }

  private async loadCloseEvents(tenantId: string, actorUserId: string, closeId: string): Promise<CloseEventRow[]> {
    const result = await this.database.query<CloseEventRow>(
      'SELECT ' + EVENT_COLUMNS + ' FROM saas_billing_close_events WHERE tenant_id=$1 AND close_id=$2 ORDER BY created_at DESC,id DESC',
      [tenantId, closeId],
      { tenantId, userId: actorUserId },
    );
    return result.rows;
  }

  private latestInvoiceId(events: CloseEventRow[]): string | null {
    return events.find((event) => event.provider_invoice_id)?.provider_invoice_id ?? null;
  }

  private async appendCloseEvent(input: {
    tenantId: string; closeId: string; eventType: string; idempotencyKey: string;
    requestHash?: string; providerInvoiceId?: string | null; providerInvoiceStatus?: string | null;
    errorCode?: string | null; evidenceHash?: string | null; actorUserId?: string | null;
  }) {
    await this.database.query(
      'INSERT INTO saas_billing_close_events(tenant_id,close_id,event_type,provider_invoice_id,provider_invoice_status,idempotency_key,request_hash,error_code,evidence_hash,actor_user_id) ' +
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING',
      [input.tenantId, input.closeId, input.eventType, input.providerInvoiceId ?? null,
        input.providerInvoiceStatus ?? null, input.idempotencyKey, input.requestHash ?? null,
        input.errorCode ?? null, input.evidenceHash ?? null, input.actorUserId ?? null],
      input.actorUserId ? { tenantId: input.tenantId, userId: input.actorUserId } : { tenantId: input.tenantId },
    );
  }

  private async assertInvoiceBelongsToClose(invoice: StripeInvoice, close: CloseRow) {
    if (invoice.customerId !== close.provider_customer_id) {
      throw new ConflictException('Stripe returned an invoice for a different customer than the immutable billing close');
    }
    if (invoice.currency !== close.currency) {
      throw new ConflictException('Stripe invoice currency does not match the immutable billing-close currency');
    }
    if (invoice.collectionMethod !== close.collection_method) {
      throw new ConflictException('Stripe invoice collection method does not match the immutable billing-close configuration');
    }
    if (invoice.metadata.factoryos_billing_close_id !== close.id
      || invoice.metadata.factoryos_tenant_id !== close.tenant_id
      || invoice.metadata.factoryos_billing_snapshot_hash !== close.snapshot_hash) {
      throw new ConflictException('Stripe invoice metadata does not match the immutable billing-close snapshot');
    }
  }

  private assertInvoiceTaxReady(close: CloseRow, invoice: StripeInvoice): void {
    if (invoice.automaticTaxEnabled !== close.automatic_tax_enabled) {
      throw new ConflictException('Stripe automatic-tax configuration does not match the immutable billing-close tax snapshot');
    }
    if (close.automatic_tax_enabled && invoice.status !== 'draft' && invoice.automaticTaxStatus !== 'complete') {
      throw new ConflictException('Provider automatic-tax calculation is not complete; do not send or charge this invoice until tax status is complete');
    }
  }

  private checkInvoiceLines(close: CloseRow, lines: StripeInvoiceLine[]): boolean {
    const expected = (close.lines ?? []) as BillingLine[];
    if (lines.length !== expected.length) return false;
    for (const line of expected) {
      const marker = '[ref ' + line.marker + ']';
      const matches = lines.filter((value) => value.description.endsWith(marker));
      if (matches.length !== 1) return false;
      const expectedAmount = Number(line.amountMinor);
      if (!Number.isSafeInteger(expectedAmount) || matches[0].amountMinor !== expectedAmount
        || matches[0].currency !== close.currency) return false;
    }
    return true;
  }

  private mapAccount(row: AccountRow) {
    return {
      id: row.id, provider: row.provider_code, providerCustomerId: row.provider_customer_id,
      currency: row.currency, collectionMethod: row.collection_method, daysUntilDue: row.days_until_due,
      automaticTaxEnabled: row.automatic_tax_enabled, taxBehavior: row.tax_behavior,
      version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private mapAccountEvent(row: AccountEventRow) {
    return {
      id: row.provider_account_id, provider: row.provider_code, providerCustomerId: row.provider_customer_id,
      currency: row.currency, collectionMethod: row.collection_method, daysUntilDue: row.days_until_due,
      automaticTaxEnabled: row.automatic_tax_enabled, taxBehavior: row.tax_behavior,
      version: Number(row.account_version), action: row.action, createdAt: row.created_at,
    };
  }

  private mapReconciliation(row: ReconciliationRow) {
    return {
      id: row.id, closeId: row.close_id, provider: 'stripe', providerInvoiceId: row.provider_invoice_id,
      invoiceStatus: row.provider_invoice_status, providerCustomerId: row.provider_customer_id,
      currency: row.currency, expectedSubtotalMinor: String(row.expected_subtotal_minor),
      providerSubtotalMinor: String(row.provider_subtotal_minor), providerTaxMinor: String(row.provider_tax_minor),
      providerDiscountMinor: String(row.provider_discount_minor), providerTotalMinor: String(row.provider_total_minor),
      amountDueMinor: String(row.amount_due_minor), amountPaidMinor: String(row.amount_paid_minor),
      automaticTaxStatus: row.automatic_tax_status, lineBindingValid: row.line_binding_valid,
      status: row.status, providerSnapshotHash: row.provider_snapshot_hash, reportHash: row.report_hash,
      recordedBy: row.recorded_by, createdAt: row.created_at,
    };
  }

  private normalizeAccount(input: ConfigureSaasBillingProviderDto) {
    if (!input || input.provider_code !== 'stripe') throw new BadRequestException('Only the Stripe commercial billing adapter is supported');
    const providerCustomerId = this.pattern(input.provider_customer_id, 'provider_customer_id', /^cus_[A-Za-z0-9]+$/);
    const currency = this.pattern(input.currency, 'currency', /^[A-Z]{3}$/);
    const collectionMethod = this.enum(input.collection_method, ['charge_automatically', 'send_invoice'], 'collection_method') as 'charge_automatically' | 'send_invoice';
    const expectedVersion = this.integer(input.expected_version, 'expected_version', 0, 1000000);
    const idempotencyKey = this.idem(input.idempotency_key);
    const automaticTaxEnabled = input.automatic_tax_enabled;
    if (typeof automaticTaxEnabled !== 'boolean') throw new BadRequestException('automatic_tax_enabled must be boolean');
    const daysUntilDue = input.days_until_due === undefined || input.days_until_due === null
      ? null : this.integer(input.days_until_due, 'days_until_due', 1, 120);
    if (collectionMethod === 'send_invoice' && daysUntilDue === null) {
      throw new BadRequestException('days_until_due is required for send_invoice collection');
    }
    if (collectionMethod === 'charge_automatically' && daysUntilDue !== null) {
      throw new BadRequestException('days_until_due must be omitted for charge_automatically collection');
    }
    const taxBehavior = automaticTaxEnabled
      ? this.enum(input.tax_behavior, ['exclusive', 'inclusive'], 'tax_behavior') as 'exclusive' | 'inclusive'
      : null;
    if (!automaticTaxEnabled && input.tax_behavior !== undefined && input.tax_behavior !== null) {
      throw new BadRequestException('tax_behavior is only accepted when automatic tax is enabled');
    }
    return {
      expected_version: expectedVersion, idempotency_key: idempotencyKey,
      content: {
        provider_code: 'stripe', provider_customer_id: providerCustomerId, currency,
        collection_method: collectionMethod, days_until_due: daysUntilDue,
        automatic_tax_enabled: automaticTaxEnabled, tax_behavior: taxBehavior,
      },
    };
  }

  private normalizePeriod(startInput: unknown, endInput: unknown, maxDays: number) {
    const start = this.timestamp(startInput, 'period_start');
    const end = this.timestamp(endInput, 'period_end');
    const elapsed = Date.parse(end) - Date.parse(start);
    if (elapsed <= 0) throw new BadRequestException('period_end must be after period_start');
    if (elapsed > maxDays * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Billing period exceeds the supported ' + maxDays + ' day limit');
    }
    return { start, end };
  }

  private scope(tenantId: string, actorUserId: string) {
    if (!isUUID(tenantId) || !isUUID(actorUserId)) throw new BadRequestException('Authenticated tenant and user UUIDs are required');
  }

  private requireUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
  }

  private async authorize(actorUserId: string, tenantId: string, permission: string) {
    await this.iamService.authorize(actorUserId, tenantId, permission);
  }

  private enum(value: unknown, values: string[], field: string): string {
    if (typeof value !== 'string' || !values.includes(value)) throw new BadRequestException(field + ' is invalid');
    return value;
  }

  private pattern(value: unknown, field: string, pattern: RegExp): string {
    const normalized = this.str(value, field, 180);
    if (!pattern.test(normalized)) throw new BadRequestException(field + ' contains unsupported characters');
    return normalized;
  }

  private str(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const result = value.normalize('NFC').trim();
    if (!result || result.length > max) throw new BadRequestException(field + ' must contain 1-' + max + ' characters');
    return result;
  }

  private integer(value: unknown, field: string, min: number, max: number): number {
    const numberValue = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
      throw new BadRequestException(field + ' must be an integer between ' + min + ' and ' + max);
    }
    return numberValue;
  }

  private idem(value: unknown): string {
    return this.pattern(value, 'idempotency_key', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  }

  private timestamp(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
      throw new BadRequestException(field + ' must be a valid timestamp');
    }
    return new Date(value).toISOString();
  }

  private hash(value: unknown): string {
    return this.sha(JSON.stringify(canonicalize(value)));
  }

  private sha(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private lineMarker(closeId: string, key: string): string {
    return 'FO' + closeId.replace(/-/g, '').slice(0, 8) + '-' + this.sha(key).slice(0, 12);
  }

  private assertMoneyRange(value: bigint, field: string) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new BadRequestException(field + ' exceeds the supported exact integer range for the commercial provider');
    }
  }

  private safeProviderAmount(value: bigint, field: string): number {
    this.assertMoneyRange(value, field);
    return Number(value);
  }

  private safeCount(value: bigint, field: string): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadRequestException(field + ' exceeds the supported count range');
    return Number(value);
  }

  private page(limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be between 1 and 100');
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new BadRequestException('offset must be between 0 and 10000');
  }

  private safeErrorCode(error: unknown): string {
    if (error instanceof StripeBillingProviderError) return 'STRIPE_' + error.providerCode.slice(0, 70);
    if (error instanceof ConflictException) return 'BILLING_STATE_CONFLICT';
    if (error instanceof BadRequestException) return 'BILLING_REQUEST_INVALID';
    return 'STRIPE_PROVIDER_OPERATION_FAILED';
  }

  private async auditSafely(input: {
    tenantId: string; actorUserId: string; eventType: string; action: string;
    resourceType: string; resourceId: string; payload: Record<string, unknown>;
  }) {
    try {
      await this.auditService.record({
        tenantId: input.tenantId, factoryId: null, actorUserId: input.actorUserId,
        eventType: input.eventType, action: input.action, resourceType: input.resourceType,
        resourceId: input.resourceId, dataClass: 'INTERNAL', payload: input.payload,
      });
    } catch {
      // Billing snapshots and append-only provider evidence are the accounting-control record.
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function normalizeProviderStatus(status: string | null): string | null {
  return status === 'draft' || status === 'open' || status === 'paid' || status === 'void' || status === 'uncollectible'
    ? status : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
