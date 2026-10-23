import { jest } from '@jest/globals';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { financeRequestHash } from './finance-contract';
import { FinanceWorkbenchService } from './finance-workbench.service';

describe('FinanceWorkbenchService', () => {
  function setup(options: {
    domainOverrides?: Array<{ domain: string; last_completed_at?: string | null; is_active?: boolean }>;
    unresolvedCount?: string;
    includeUnreconciledFact?: boolean;
  } = {}) {
    const domains = ['AP', 'AR', 'BANK_RECONCILIATION', 'GL', 'TAX_EINVOICE'].map((domain) => ({
      domain,
      connector_code: 'SOURCE-' + domain,
      source_system: 'External accounting',
      status: 'ACTIVE',
      last_completed_at: '2026-10-01T00:00:00.000Z' as string | null,
      is_active: true,
      ...options.domainOverrides?.find((override) => override.domain === domain),
    }));
    const query = jest.fn(async (statement: string, _values?: unknown[]) => {
      void _values;
      if (statement.includes('WITH scoped AS (')) {
        return { rows: [{
          period: '2026-09',
          currency: 'BDT',
          actual_revenue: '1000.00',
          actual_cost: '600.00',
          actual_contribution_cost: '450.00',
          forecast_revenue: '900.00',
          forecast_cost: '500.00',
          forecast_contribution_cost: '400.00',
          actual_gross_margin: '400.00',
          actual_contribution_margin: '550.00',
          gross_margin_variance: '100.00',
        }] };
      }
      if (statement.includes('operational_quantity_variance')) {
        return { rows: [{
          period: '2026-09',
          currency: 'BDT',
          operational_quantity_variance: '20.00',
          operational_rate_variance: '-5.00',
          operational_quantity_rate_variance: '15.00',
          open_mismatch_count: 1,
        }] };
      }
      if (statement.includes('WITH ranked_positions AS')) {
        return { rows: [{
          currency: 'BDT',
          receivables: '500',
          payables: '200',
          bank_balance: '1000',
          inventory_value: '700',
          open_po_commitments: '150',
          lc_exposure: '80',
          tax_liability: '30',
          overdue_receivables: '50',
          overdue_payables: '20',
          forecast_inflows: '300',
          forecast_outflows: '160',
          projected_cash_at_horizon: '1140',
        }] };
      }
      if (statement.includes('FROM unnest($3::text[]) AS expected(domain)')) {
        return { rows: domains };
      }
      if (statement.includes('SELECT f.id::text AS fact_id')) {
        return options.includeUnreconciledFact === false ? { rows: [] } : { rows: [{
          fact_id: 'fact-1',
          external_fact_id: 'ERP-INV-1',
          fact_type: 'AP_OPEN',
          source_record_ref: 'INV-1',
          currency: 'BDT',
          amount: '200',
          review_status: 'OPEN',
        }] };
      }
      if (statement.includes('SELECT count(*)::text AS count')) {
        return { rows: [{ count: options.unresolvedCount ?? '1' }] };
      }
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const transaction = jest.fn(async (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) => {
      void _context;
      return callback(client);
    });
    const database = { transaction } as unknown as DatabaseService;
    return { service: new FinanceWorkbenchService(database), query, transaction };
  }

  it('separates currency/period and actual-versus-forecast outputs while exposing open mismatches', async () => {
    const { service, query, transaction } = setup();
    const result = await service.readWorkbench('user-1', 'tenant-1', 'factory-1', {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      currency: 'BDT',
      horizon_days: 30,
      unreconciled_limit: 25,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.period_margin).toHaveLength(1);
    expect(result.period_margin[0].currency).toBe('BDT');
    expect(result.period_margin[0].actual_revenue).toBe('1000.00');
    expect(result.period_margin[0].forecast_revenue).toBe('900.00');
    expect(result.working_capital[0].projected_cash_at_horizon).toBe('1140');
    expect(result.operational_variance_attribution[0].operational_quantity_rate_variance).toBe('15.00');
    expect(result.unreconciled_fact_count).toBe(1);
    expect(result.unreconciled_facts).toHaveLength(1);
    expect(result.reporting_ready).toBe(false);
    expect(result.currency_policy).toContain('No implicit FX conversion');
    expect(query).toHaveBeenCalled();
    const marginCall = query.mock.calls.find(([statement]) => statement.includes('WITH scoped AS ('));
    const marginSql = marginCall?.[0] ?? '';
    expect(marginSql).toContain('DISTINCT ON (connector_id,fact_type,source_fact_key,currency,period_start)');
    expect(marginSql).toContain('GROUP BY period_start,currency,customer_ref,product_id,product_ref,order_id,order_ref,cost_center_ref');
    const varianceCall = query.mock.calls.find(([statement]) => statement.includes('operational_quantity_variance'));
    expect(varianceCall?.[0]).toContain('f.source_record_type');
    expect(varianceCall?.[0]).toContain('COALESCE(f.product_ref,f.product_id::text)');
    const positionCall = query.mock.calls.find(([statement]) => statement.includes('WITH ranked_positions AS'));
    expect(positionCall?.[1]).toEqual(['tenant-1', 'factory-1', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z', 'BDT']);
  });

  it('treats date-only report end bounds as inclusive UTC end-of-day', async () => {
    const { service, query } = setup();
    await service.readWorkbench('user-1', 'tenant-1', 'factory-1', {
      from: '2026-09-01',
      to: '2026-09-30',
      currency: 'BDT',
      horizon_days: 30,
      unreconciled_limit: 25,
    });

    const marginCall = query.mock.calls.find(([statement]) => statement.includes('WITH scoped AS ('));
    expect(marginCall?.[1]).toEqual([
      'tenant-1',
      'factory-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-30T23:59:59.999Z',
      'BDT',
    ]);
    const positionCall = query.mock.calls.find(([statement]) => statement.includes('WITH ranked_positions AS'));
    expect(positionCall?.[1]).toEqual([
      'tenant-1',
      'factory-1',
      '2026-09-30T23:59:59.999Z',
      '2026-10-30T23:59:59.999Z',
      'BDT',
    ]);
  });

  it('blocks reporting readiness when an active required source has no completed ingestion receipt', async () => {
    const { service } = setup({
      domainOverrides: [{ domain: 'GL', last_completed_at: null }],
      unresolvedCount: '0',
      includeUnreconciledFact: false,
    });
    const result = await service.readWorkbench('user-1', 'tenant-1', 'factory-1', {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      currency: 'BDT',
      horizon_days: 30,
      unreconciled_limit: 25,
    });

    expect(result.uninitialized_reporting_domains).toEqual(['GL']);
    expect(result.unreconciled_fact_count).toBe(0);
    expect(result.reporting_ready).toBe(false);
  });

  it('rejects a reversed reporting period before querying PostgreSQL', async () => {
    const { service, transaction } = setup();
    await expect(service.readWorkbench('user-1', 'tenant-1', 'factory-1', {
      from: '2026-10-02T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      currency: 'BDT',
      horizon_days: 30,
      unreconciled_limit: 25,
    })).rejects.toThrow('from must be earlier than or equal to to');
    expect(transaction).not.toHaveBeenCalled();
  });

  function setupClose(initialRow: Record<string, unknown>, approvedRow: Record<string, unknown>, priorHistory: Array<{ request_hash: string; action: string }> = []) {
    const query = jest.fn(async (statement: string, values?: unknown[]) => {
      void values;
      if (statement.includes('SELECT request_hash,action FROM finance_close_period_history')) {
        return { rows: priorHistory };
      }
      if (statement.includes('SELECT * FROM finance_close_periods')) return { rows: [initialRow] };
      if (statement.includes("UPDATE finance_close_periods SET status='APPROVED'")) return { rows: [approvedRow] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const transaction = jest.fn(async (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) => {
      void _context;
      return callback(client);
    });
    const database = { transaction } as unknown as DatabaseService;
    return { service: new FinanceWorkbenchService(database), query, transaction };
  }

  const approvedSnapshot = {
    schema: 'factoryos.finance-close-snapshot/v1',
    currency: 'BDT',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    readiness: { missing_reporting_domains: [], unresolved_reconciliation_count: 0, can_submit: true },
  };

  function closeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'close-1',
      tenant_id: 'tenant-1',
      factory_id: 'factory-1',
      currency: 'BDT',
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      status: 'SUBMITTED',
      row_version: 2,
      idempotency_key: 'close-2026-09-bdt',
      request_hash: 'a'.repeat(64),
      snapshot: approvedSnapshot,
      snapshot_hash: financeRequestHash(approvedSnapshot),
      created_by_user_id: 'creator-1',
      submitted_by_user_id: 'submitter-1',
      submitted_at: '2026-10-01T00:00:00.000Z',
      approved_by_user_id: null,
      approved_at: null,
      approval_reason: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('refuses finance-close approval when source facts changed after submission', async () => {
    const initial = closeRow({ snapshot_hash: '0'.repeat(64) });
    const { service, query } = setupClose(initial, closeRow({ status: 'APPROVED', row_version: 3 }));
    Object.defineProperty(service, 'buildCloseSnapshot', { value: jest.fn(async () => approvedSnapshot) });

    await expect(service.approveClosePeriod('reviewer-1', 'tenant-1', 'factory-1', 'close-1', {
      expected_version: 2,
      reason: 'Reviewed month-end close evidence',
    }, 'approve-stale-facts-1', { requestId: null, traceId: null })).rejects.toThrow(
      'Source facts or readiness changed after submission; the submitter must recall, refresh and resubmit',
    );
    expect(query.mock.calls.some(([statement]) => statement.includes("SET status='APPROVED'"))).toBe(false);
  });

  it('allows an independent reviewer to approve an unchanged finance-close snapshot', async () => {
    const initial = closeRow();
    const approved = closeRow({
      status: 'APPROVED',
      row_version: 3,
      approved_by_user_id: 'reviewer-1',
      approved_at: '2026-10-02T00:00:00.000Z',
      approval_reason: 'Independent month-end reconciliation approved',
    });
    const { service, query } = setupClose(initial, approved);
    Object.defineProperty(service, 'buildCloseSnapshot', { value: jest.fn(async () => approvedSnapshot) });

    const result = await service.approveClosePeriod('reviewer-1', 'tenant-1', 'factory-1', 'close-1', {
      expected_version: 2,
      reason: 'Independent month-end reconciliation approved',
    }, 'approve-close-success-1', { requestId: null, traceId: null });

    expect(result.status).toBe('APPROVED');
    expect(result.row_version).toBe(3);
    expect(result.approved_by_user_id).toBe('reviewer-1');
    expect(query.mock.calls.some(([statement]) => statement.includes('INSERT INTO finance_close_period_history'))).toBe(true);
    expect(query.mock.calls.some(([statement]) => statement.includes('INSERT INTO audit_events'))).toBe(true);
    expect(query.mock.calls.some(([statement]) => statement.includes('INSERT INTO outbox_events'))).toBe(true);
  });

  it('replays a repeated close transition key without reapplying the approval', async () => {
    const initial = closeRow();
    const reason = 'Independent month-end reconciliation approved';
    const key = 'approve-close-replay-1';
    const hash = financeRequestHash({
      action: 'APPROVE',
      period_id: 'close-1',
      expected_version: 2,
      reason,
    });
    const { service, query } = setupClose(initial, closeRow({ status: 'APPROVED', row_version: 3 }), [
      { request_hash: hash, action: 'APPROVED' },
    ]);
    const snapshotBuilder = jest.fn(async () => approvedSnapshot);
    Object.defineProperty(service, 'buildCloseSnapshot', { value: snapshotBuilder });

    const result = await service.approveClosePeriod('reviewer-1', 'tenant-1', 'factory-1', 'close-1', {
      expected_version: 2,
      reason,
    }, key, { requestId: null, traceId: null });

    expect(result.replayed).toBe(true);
    expect(result.status).toBe('SUBMITTED');
    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([statement]) => statement.includes(`SET status='APPROVED'`))).toBe(false);
  });

  it('rejects reuse of a close transition key for a different normalized request', async () => {
    const initial = closeRow();
    const { service, query } = setupClose(initial, closeRow({ status: 'APPROVED', row_version: 3 }), [
      { request_hash: 'f'.repeat(64), action: 'APPROVED' },
    ]);
    const snapshotBuilder = jest.fn(async () => approvedSnapshot);
    Object.defineProperty(service, 'buildCloseSnapshot', { value: snapshotBuilder });

    await expect(service.approveClosePeriod('reviewer-1', 'tenant-1', 'factory-1', 'close-1', {
      expected_version: 2,
      reason: 'Independent month-end reconciliation approved',
    }, 'approve-close-reuse-1', { requestId: null, traceId: null })).rejects.toThrow(
      'Idempotency-Key was already used for a different finance-close transition',
    );
    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([statement]) => statement.includes(`SET status='APPROVED'`))).toBe(false);
  });

  it('blocks the close creator from approving their own submitted snapshot', async () => {
    const initial = closeRow({ created_by_user_id: 'reviewer-1' });
    const { service, query } = setupClose(initial, closeRow({ status: 'APPROVED', row_version: 3 }));
    Object.defineProperty(service, 'buildCloseSnapshot', { value: jest.fn(async () => approvedSnapshot) });

    await expect(service.approveClosePeriod('reviewer-1', 'tenant-1', 'factory-1', 'close-1', {
      expected_version: 2,
      reason: 'Attempted self approval should fail',
    }, 'approve-close-self-1', { requestId: null, traceId: null })).rejects.toThrow(
      'Finance-close creator/submitter cannot approve their own close',
    );
    expect(query.mock.calls.some(([statement]) => statement.includes("SET status='APPROVED'"))).toBe(false);
  });
});
