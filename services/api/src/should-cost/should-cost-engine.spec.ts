import {
  calculateGrossMargin,
  calculateShouldCost,
  normalizeCostCurrency,
  type ShouldCostRule,
} from './should-cost-engine';

const rules: ShouldCostRule[] = [
  { category: 'MATERIAL', calculation_method: 'DIRECT_RATE', is_required: true, base_categories: [] },
  { category: 'LABOUR', calculation_method: 'DIRECT_RATE', is_required: true, base_categories: [] },
  { category: 'ENERGY', calculation_method: 'DIRECT_RATE', is_required: true, base_categories: [] },
  { category: 'FREIGHT', calculation_method: 'FIXED_PER_BATCH', is_required: true, base_categories: [] },
  { category: 'DUTY', calculation_method: 'PERCENT_OF_BASE', is_required: true, base_categories: ['MATERIAL', 'FREIGHT'] },
  { category: 'OVERHEAD', calculation_method: 'PERCENT_OF_BASE', is_required: true, base_categories: ['LABOUR', 'ENERGY'] },
  { category: 'SCRAP', calculation_method: 'SCRAP_GROSS_UP', is_required: true, base_categories: ['MATERIAL', 'LABOUR', 'ENERGY'] },
];
const evidence = [
  { category: 'MATERIAL', line_number: 1, applicable: true, input_quantity: 10, unit_code: 'KG', unit_rate: 100, source_currency: 'BDT', fx_rate_to_cost_currency: 1, source_type: 'BOM', source_reference: 'bom-line:1', source_as_of: '2026-10-01', notes: 'Pinned BOM quantity and rate', source_snapshot: { item: 'FABRIC-A' } },
  { category: 'LABOUR', line_number: 1, applicable: true, input_quantity: 4, unit_code: 'HOUR', unit_rate: 200, source_currency: 'BDT', fx_rate_to_cost_currency: 1, source_type: 'ROUTING', source_reference: 'routing:1', source_as_of: '2026-10-01', notes: 'Approved route time and hourly rate', source_snapshot: { operation: 'SEW' } },
  { category: 'ENERGY', line_number: 1, applicable: true, input_quantity: 50, unit_code: 'KWH', unit_rate: 12, source_currency: 'BDT', fx_rate_to_cost_currency: 1, source_type: 'UTILITY_METER', source_reference: 'meter:1', source_as_of: '2026-10-01', notes: 'Allocated energy use and rate', source_snapshot: { meter: 'ELEC-01' } },
  { category: 'FREIGHT', line_number: 1, applicable: true, fixed_amount: 100, source_currency: 'BDT', fx_rate_to_cost_currency: 1, source_type: 'FREIGHT_QUOTE', source_reference: 'carrier-quote:1', source_as_of: '2026-10-01', notes: 'Quoted shipment allocation', source_snapshot: { shipment: 'S1' } },
  { category: 'DUTY', line_number: 1, applicable: true, percentage_rate: 5, source_type: 'DUTY_SCHEDULE', source_reference: 'duty:1', source_as_of: '2026-10-01', notes: 'Import duty percentage and base', source_snapshot: { schedule: 'DUTY-A' } },
  { category: 'OVERHEAD', line_number: 1, applicable: true, percentage_rate: 10, source_type: 'COST_RATE_CARD', source_reference: 'oh:1', source_as_of: '2026-10-01', notes: 'Factory overhead allocation policy', source_snapshot: { pool: 'FACTORY' } },
  { category: 'SCRAP', line_number: 1, applicable: true, percentage_rate: 5, source_type: 'QUALITY_STANDARD', source_reference: 'scrap:1', source_as_of: '2026-10-01', notes: 'Approved process scrap allowance', source_snapshot: { source: 'standard' } },
] as const;

describe('deterministic should-cost engine', () => {
  it('calculates all seven categories in canonical order with a stable total', () => {
    const result = calculateShouldCost({ currency: 'bdt', target_quantity: 100, target_unit: 'PCS', rules, evidence: [...evidence] });
    expect(result.currency).toBe('BDT');
    expect(result.component_totals).toEqual({
      MATERIAL: '1000.0000',
      LABOUR: '800.0000',
      ENERGY: '600.0000',
      FREIGHT: '100.0000',
      DUTY: '55.0000',
      OVERHEAD: '140.0000',
      SCRAP: '126.3158',
    });
    expect(result.total_cost).toBe('2821.3158');
    expect(result.cost_per_unit).toBe('28.21315800');
    expect(result.formula_version).toBe('factoryos.should-cost.v1');
  });

  it('converts source-currency line amounts with the snapshotted FX rate', () => {
    const copy = [...evidence];
    copy[0] = { ...evidence[0], input_quantity: 2, unit_rate: 10, source_currency: 'USD', fx_rate_to_cost_currency: 120 };
    const result = calculateShouldCost({ currency: 'BDT', target_quantity: 1, target_unit: 'PCS', rules, evidence: copy });
    expect(result.component_totals.MATERIAL).toBe('2400.0000');
  });

  it('requires a traceable evidence row for every configured category', () => {
    expect(() => calculateShouldCost({
      currency: 'BDT', target_quantity: 1, target_unit: 'PCS', rules,
      evidence: evidence.filter((line) => line.category !== 'DUTY'),
    })).toThrow('Missing evidence for DUTY');
  });

  it('allows a zero-cost category only through a justified optional NOT_APPLICABLE row', () => {
    const adjustedRules = rules.map((rule) => rule.category === 'FREIGHT' ? { ...rule, is_required: false } : rule);
    const adjustedEvidence = evidence.map((line) => line.category === 'FREIGHT'
      ? { category: 'FREIGHT' as const, line_number: 1, applicable: false, source_type: 'NOT_APPLICABLE', notes: 'Customer collects at factory', source_snapshot: { reason: 'EXW' } }
      : line);
    const result = calculateShouldCost({ currency: 'BDT', target_quantity: 1, target_unit: 'PCS', rules: adjustedRules, evidence: adjustedEvidence });
    expect(result.component_totals.FREIGHT).toBe('0.0000');
    expect(result.evidence.find((line) => line.category === 'FREIGHT')?.applicable).toBe(false);
  });

  it('rejects cyclic or forward percentage dependencies', () => {
    const invalid = rules.map((rule) => rule.category === 'DUTY'
      ? { ...rule, base_categories: ['SCRAP' as const] }
      : rule);
    expect(() => calculateShouldCost({ currency: 'BDT', target_quantity: 1, target_unit: 'PCS', rules: invalid, evidence: [...evidence] }))
      .toThrow('may only depend on earlier, valid cost categories');
  });

  it('rejects missing source references and duplicate evidence line numbers', () => {
    const missingRef = [...evidence];
    missingRef[1] = { ...evidence[1], source_reference: '' };
    expect(() => calculateShouldCost({ currency: 'BDT', target_quantity: 1, target_unit: 'PCS', rules, evidence: missingRef }))
      .toThrow('requires a traceable evidence source and source date');
    const duplicate = [...evidence, { ...evidence[0], input_quantity: 1 }];
    expect(() => calculateShouldCost({ currency: 'BDT', target_quantity: 1, target_unit: 'PCS', rules, evidence: duplicate }))
      .toThrow('Evidence line numbers must be unique');
  });

  it('calculates negative margin correctly and handles zero revenue', () => {
    expect(calculateGrossMargin('80', '100')).toEqual({
      revenue: '80.0000', cost: '100.0000', gross_margin_amount: '-20.0000', gross_margin_percent: '-25.000000',
    });
    expect(calculateGrossMargin('0', '10')?.gross_margin_percent).toBeNull();
    expect(calculateGrossMargin(null, '10')).toBeNull();
  });

  it('formats signed margin percentages with exact decimal scale', () => {
    expect(calculateGrossMargin('100', '123.4567')?.gross_margin_percent).toBe('-23.456700');
  });

  it('rejects invalid ISO currency codes', () => {
    expect(normalizeCostCurrency('usd')).toBe('USD');
    expect(() => normalizeCostCurrency('US')).toThrow('three-letter code');
  });
});
