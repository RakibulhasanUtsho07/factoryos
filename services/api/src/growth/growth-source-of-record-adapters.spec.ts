import {
  allowedGrowthSourceMetrics,
  GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION,
  resolveFinancialFactMetric,
  resolveProductionOutputMetric,
  type FinancialFactSourceRow,
  type ProductionOutputSourceRow,
} from './growth-source-of-record-adapters';

describe('versioned growth source-of-record adapters', () => {
  it('pins the adapter version and exposes stable metric allowlists', () => {
    expect(GROWTH_SOURCE_OF_RECORD_ADAPTER_VERSION).toBe('factoryos.growth.source-of-record.v1');
    expect(allowedGrowthSourceMetrics('FINANCIAL_FACT')).toContain('finance.actual_revenue');
    expect(allowedGrowthSourceMetrics('PRODUCTION_OUTPUT')).toContain('production.good_quantity');
    expect(allowedGrowthSourceMetrics('FINANCIAL_FACT')).not.toContain('production.yield_percentage');
  });

  it('maps an approved financial fact without accepting an independently supplied actual', () => {
    const source: FinancialFactSourceRow = {
      id: '9a48c2fc-d30f-46bf-8e7c-c9cbcd588a10',
      fact_type: 'ACTUAL_REVENUE',
      effective_at: '2026-10-18T12:30:00.000Z',
      currency: 'BDT',
      amount: '123456.12345678',
      fact_hash: 'a'.repeat(64),
    };
    expect(resolveFinancialFactMetric(source, 'finance.actual_revenue')).toEqual({
      source_kind: 'FINANCIAL_FACT',
      metric_key: 'finance.actual_revenue',
      unit: 'BDT',
      value: '123456.12345678',
      observed_at: '2026-10-18T12:30:00.000Z',
      source_record_ref: 'finance-fact:9a48c2fc-d30f-46bf-8e7c-c9cbcd588a10',
      source_revision_hash: 'a'.repeat(64),
    });
  });

  it('rejects a metric whose allowlisted fact type differs from the canonical fact row', () => {
    expect(() => resolveFinancialFactMetric({
      id: '9a48c2fc-d30f-46bf-8e7c-c9cbcd588a10',
      fact_type: 'FORECAST_REVENUE',
      effective_at: '2026-10-18T12:30:00.000Z',
      currency: 'BDT',
      amount: '100.00000000',
      fact_hash: 'a'.repeat(64),
    }, 'finance.actual_revenue')).toThrow('GROWTH_SOURCE_METRIC_NOT_ALLOWED_FOR_FINANCIAL_FACT');
  });

  it('rejects unsupported keys, invalid currency, invalid digest and out-of-range decimal inputs', () => {
    const source: FinancialFactSourceRow = {
      id: '9a48c2fc-d30f-46bf-8e7c-c9cbcd588a10',
      fact_type: 'ACTUAL_REVENUE',
      effective_at: '2026-10-18T12:30:00.000Z',
      currency: 'bdt',
      amount: '100.00000000',
      fact_hash: 'a'.repeat(64),
    };
    expect(() => resolveFinancialFactMetric(source, 'production.yield_percentage'))
      .toThrow('GROWTH_SOURCE_METRIC_NOT_ALLOWED_FOR_FINANCIAL_FACT');
    expect(() => resolveFinancialFactMetric(source, 'finance.actual_revenue'))
      .toThrow('GROWTH_SOURCE_CURRENCY_INVALID');
    expect(() => resolveFinancialFactMetric({ ...source, currency: 'BDT', fact_hash: 'invalid' }, 'finance.actual_revenue'))
      .toThrow('GROWTH_SOURCE_REVISION_HASH_INVALID');
    expect(() => resolveFinancialFactMetric({ ...source, currency: 'BDT', amount: '1000000000001.00000000' }, 'finance.actual_revenue'))
      .toThrow('GROWTH_SOURCE_VALUE_OUT_OF_RANGE');
  });

  it('maps immutable production output columns into typed source observations', () => {
    const source: ProductionOutputSourceRow = {
      id: '139e9b4d-c14f-45ec-a2da-471df53c74c3',
      created_at: '2026-10-18T14:00:00.000Z',
      good_quantity: '970.0000',
      scrap_quantity: '30.0000',
      unit: 'PCS',
      yield_percentage: '97.0000',
      cumulative_yield_percentage: '95.5000',
      request_hash: 'b'.repeat(64),
    };
    expect(resolveProductionOutputMetric(source, 'production.good_quantity')).toMatchObject({
      source_kind: 'PRODUCTION_OUTPUT',
      metric_key: 'production.good_quantity',
      unit: 'PCS',
      value: '970.00000000',
      observed_at: '2026-10-18T14:00:00.000Z',
      source_record_ref: 'production-output:139e9b4d-c14f-45ec-a2da-471df53c74c3',
      source_revision_hash: 'b'.repeat(64),
    });
    expect(resolveProductionOutputMetric(source, 'production.yield_percentage')).toMatchObject({
      unit: 'pct', value: '97.00000000',
    });
  });

  it('never maps an arbitrary production field or accepts a missing immutable digest', () => {
    const source: ProductionOutputSourceRow = {
      id: '139e9b4d-c14f-45ec-a2da-471df53c74c3',
      created_at: '2026-10-18T14:00:00.000Z',
      good_quantity: '970.0000',
      it('never maps an arbitrary production field or accepts a missing immutable digest', () => {
    const source: ProductionOutputSourceRow = {
      id: '139e9b4d-c14f-45ec-a2da-471df53c74c3',
      created_at: '2026-10-18T14:00:00.000Z',
      good_quantity: '970.0000',
      scrap_quantity: '30.0000',
      unit: 'PCS',
      yield_percentage: '97.0000',
      cumulative_yield_percentage: '95.5000',
      request_hash: 'b'.repeat(64),
    };
    expect(() => resolveProductionOutputMetric(source, 'production.inventory_value'))
      .toThrow('GROWTH_SOURCE_METRIC_NOT_ALLOWED_FOR_PRODUCTION_OUTPUT');
    expect(() => resolveProductionOutputMetric({ ...source, request_hash: 'invalid' }, 'production.good_quantity'))
      .toThrow('GROWTH_SOURCE_REVISION_HASH_INVALID');
  });
});
