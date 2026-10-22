export const GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION = 'factoryos.growth.source-of-record.v1' as const;

export type GrowthKpiSourceKind = 'FINANCIAL_FACT' | 'PRODUCTION_OUTPUT';

export interface FinancialFactSourceRow {
  id: string;
  fact_type: string;
  effective_at: string;
  currency: string;
  amount: string;
  fact_hash: string;
}

export interface ProductionOutputSourceRow {
  id: string;
  created_at: string;
  good_quantity: string;
  scrap_quantity: string;
  unit: string;
  yield_percentage: string;
  cumulative_yield_percentage: string;
  request_hash: string;
}

export interface ResolvedGrowthSourceMetric {
  source_kind: GrowthKpiSourceKind;
  metric_key: string;
  unit: string;
  value: string;
  observed_at: string;
  source_record_ref: string;
  source_revision_hash: string;
}

const FINANCE_METRICS: Readonly<Record<string, string>> = Object.freeze({
  'finance.actual_revenue': 'ACTUAL_REVENUE',
  'finance.actual_cost': 'ACTUAL_COST',
  'finance.actual_contribution_cost': 'ACTUAL_CONTRIBUTION_COST',
  'finance.forecast_revenue': 'FORECAST_REVENUE',
  'finance.forecast_cost': 'FORECAST_COST',
  'finance.forecast_contribution_cost': 'FORECAST_CONTRIBUTION_COST',
  'finance.inventory_value': 'INVENTORY_VALUE',
  'finance.open_po_commitment': 'OPEN_PO_COMMITMENT',
  'finance.accounts_receivable': 'AR_OPEN',
  'finance.accounts_payable': 'AP_OPEN',
  'finance.bank_balance': 'BANK_BALANCE',
});

const PRODUCTION_METRICS: Readonly<Record<string, { field: keyof ProductionOutputSourceRow; unit: 'item_unit' | 'pct' }>> = Object.freeze({
  'production.good_quantity': { field: 'good_quantity', unit: 'item_unit' },
  'production.scrap_quantity': { field: 'scrap_quantity', unit: 'item_unit' },
  'production.yield_percentage': { field: 'yield_percentage', unit: 'pct' },
  'production.cumulative_yield_percentage': { field: 'cumulative_yield_percentage', unit: 'pct' },
});

function normalizeDecimal(value: unknown): string {
  const raw = String(value);
  if (!/^-?\\d+(?:\\.\\d{1,8})?$/.test(raw)) throw new Error('GROWTH_SOURCE_VALUE_PRECISION_INVALID');
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const wholeNormalized = whole.replace(/^0+(?=\\d)/, '');
  const normalized = `${wholeNormalized}.${fraction.padEnd(8, '0')}`;
  const number = Number(normalized);
  if (!Number.isFinite(number) || Math.abs(number) > 1_000_000_000_000) {
    throw new Error('GROWTH_SOURCE_VALUE_OUT_OF_RANGE');
  }
  return negative && number !== 0 ? `-${normalized}` : normalized;
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('GROWTH_SOURCE_TIMESTAMP_INVALID');
  return date.toISOString();
}

export function resolveFinancialFactMetric(
  row: FinancialFactSourceRow,
  metricKey: string,
): ResolvedGrowthSourceMetric {
  const expectedType = FINANCE_METRICS[metricKey];
  if (!expectedType || row.fact_type !== expectedType) {
    throw new Error('GROWTH_SOURCE_METRIC_NOT_ALLOWED_FOR_FINANCIAL_FACT');
  }
  if (!/^[A-Z]{3}$/.test(row.currency)) throw new Error('GROWTH_SOURCE_CURRENCY_INVALID');
  if (!/^[a-f0-9]{64}$/.test(row.fact_hash)) throw new Error('GROWTH_SOURCE_REVISION_HASH_INVALID');
  return {
    source_kind: 'FINANCIAL_FACT',
    metric_key: metricKey,
    unit: row.currency,
    value: normalizeDecimal(row.amount),
    observed_at: normalizeTimestamp(row.effective_at),
    source_record_ref: `finance-fact:${row.id}`,
    source_revision_hash: row.fact_hash,
  };
}

export function resolveProductionOutputMetric(
  row: ProductionOutputSourceRow,
  metricKey: string,
): ResolvedGrowthSourceMetric {
  const definition = PRODUCTION_METRICS[metricKey];
  if (!definition) throw new Error('GROWTH_SOURCE_METRIC_NOT_ALLOWED_FOR_PRODUCTION_OUTPUT');
  if (!/^[a-f0-9]{64}$/.test(row.request_hash)) throw new Error('GROWTH_SOURCE_REVISION_HASH_INVALID');
  if (definition.unit === 'item_unit' && (!row.unit || !row.unit.trim() || row.unit.length > 40)) {
    throw new Error('GROWTH_SOURCE_ITEM_UNIT_INVALID');
  }
  const value = row[definition.field];
  return {
    source_kind: 'PRODUCTION_OUTPUT',
    metric_key: metricKey,
    unit: definition.unit === 'item_unit' ? row.unit : definition.unit,
    value: normalizeDecimal(value),
    observed_at: normalizeTimestamp(row.created_at),
    source_record_ref: `production-output:${row.id}`,
    source_revision_hash: row.request_hash,
  };
}

export function allowedGrowthSourceMetrics(sourceKind: GrowthKpiSourceKind): readonly string[] {
  return sourceKind === 'FINANCIAL_FACT'
    ? Object.keys(FINANCE_METRICS).sort()
    : Object.keys(PRODUCTION_METRICS).sort();
}
