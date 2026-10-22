import { jest } from '@jest/globals';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { FinanceWorkbenchService } from './finance-workbench.service';

describe('FinanceWorkbenchService', () => {
  function setup() {
    const domains = ['AP', 'AR', 'BANK_RECONCILIATION', 'GL', 'TAX_EINVOICE'].map((domain) => ({
      domain,
      connector_code: 'SOURCE-' + domain,
      source_system: 'External accounting',
      status: 'ACTIVE',
      last_completed_at: '2026-10-01T00:00:00.000Z',
      is_active: true,
    }));
    const query = jest.fn(async (statement: string) => {
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
        return { rows: [{
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
        return { rows: [{ count: '1' }] };
      }
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const transaction = jest.fn(async (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback(client),
    );
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
    const positionCall = query.mock.calls.find(([statement]) => statement.includes('WITH ranked_positions AS'));
    expect(positionCall?.[1]).toEqual(['tenant-1', 'factory-1', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z', 'BDT']);
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
});
