export const SHOULD_COST_CATEGORIES = [
  'MATERIAL',
  'LABOUR',
  'ENERGY',
  'FREIGHT',
  'DUTY',
  'OVERHEAD',
  'SCRAP',
] as const;

export type ShouldCostCategory = (typeof SHOULD_COST_CATEGORIES)[number];
export type ShouldCostMethod = 'DIRECT_RATE' | 'FIXED_PER_BATCH' | 'PERCENT_OF_BASE' | 'SCRAP_GROSS_UP';

export interface ShouldCostRule {
  category: ShouldCostCategory;
  calculation_method: ShouldCostMethod;
  is_required: boolean;
  base_categories: ShouldCostCategory[];
}

export interface ShouldCostEvidenceInput {
  category: ShouldCostCategory;
  line_number: number;
  applicable: boolean;
  input_quantity?: string | number | null;
  unit_rate?: string | number | null;
  unit_code?: string | null;
  fixed_amount?: string | number | null;
  percentage_rate?: string | number | null;
  source_currency?: string | null;
  fx_rate_to_cost_currency?: string | number | null;
  source_type: string;
  source_reference?: string | null;
  source_as_of?: string | null;
  fx_rate_effective_on?: string | null;
  fx_rate_source?: string | null;
  notes: string;
  source_snapshot: Record<string, unknown>;
}

export interface CalculatedEvidenceLine {
  category: ShouldCostCategory;
  line_number: number;
  applicable: boolean;
  calculation_method: ShouldCostMethod;
  input_quantity: string | null;
  unit_code: string | null;
  unit_rate: string | null;
  fixed_amount: string | null;
  percentage_rate: string | null;
  source_currency: string | null;
  fx_rate_to_cost_currency: string | null;
  source_amount: string | null;
  cost_amount: string;
  base_categories: ShouldCostCategory[];
  base_amount: string | null;
  source_type: string;
  source_reference: string | null;
  source_as_of: string | null;
  fx_rate_effective_on: string | null;
  fx_rate_source: string | null;
  notes: string;
  source_snapshot: Record<string, unknown>;
  evidence_hash_payload: Record<string, unknown>;
}

export interface ShouldCostCalculation {
  currency: string;
  target_quantity: string;
  target_unit: string;
  total_cost: string;
  cost_per_unit: string;
  component_totals: Record<ShouldCostCategory, string>;
  evidence: CalculatedEvidenceLine[];
  formula_version: 'factoryos.should-cost.v1';
}

export interface MarginCalculation {
  revenue: string;
  cost: string;
  gross_margin_amount: string;
  gross_margin_percent: string | null;
}

const MONEY_SCALE = 4;
const QUANTITY_SCALE = 6;
const RATE_SCALE = 8;
const FX_SCALE = 10;
const PERCENT_SCALE = 4;
const PERCENT_DENOMINATOR = 100n * 10n ** BigInt(PERCENT_SCALE);

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  const half = denominator / 2n;
  return (numerator + half) / denominator;
}

export function toScaled(value: string | number, scale: number, field = 'value'): bigint {
  const raw = typeof value === 'number' ? value.toFixed(scale) : value.trim();
  if (!Number.isFinite(Number(raw)) || !/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new RangeError(field + ' must be a finite, non-negative decimal');
  }
  const [whole = '0', fraction = ''] = raw.split('.');
  if (fraction.length > scale) throw new RangeError(field + ' exceeds supported decimal precision');
  return BigInt(whole) * 10n ** BigInt(scale) +
    BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

export function fromScaled(value: bigint, scale: number): string {
  const factor = 10n ** BigInt(scale);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / factor;
  const fraction = (absolute % factor).toString().padStart(scale, '0');
  return (negative ? '-' : '') + whole.toString() + (scale ? '.' + fraction : '');
}

function convertToCostCurrency(amountScaled: bigint, fxRate: string | number): bigint {
  const fxScaled = toScaled(fxRate, FX_SCALE, 'fx_rate_to_cost_currency');
  if (fxScaled <= 0n) throw new RangeError('FX rate must be greater than zero');
  return roundDivide(amountScaled * fxScaled, 10n ** BigInt(FX_SCALE));
}

function addBase(
  categories: ShouldCostCategory[],
  totals: Record<ShouldCostCategory, bigint>,
): bigint {
  return categories.reduce((sum, category) => sum + totals[category], 0n);
}

function assertMethod(category: ShouldCostCategory, method: ShouldCostMethod, bases: ShouldCostCategory[]) {
  const allowed: Record<ShouldCostCategory, ShouldCostMethod[]> = {
    MATERIAL: ['DIRECT_RATE'],
    LABOUR: ['DIRECT_RATE'],
    ENERGY: ['DIRECT_RATE'],
    FREIGHT: ['DIRECT_RATE', 'FIXED_PER_BATCH'],
    DUTY: ['DIRECT_RATE', 'PERCENT_OF_BASE'],
    OVERHEAD: ['DIRECT_RATE', 'FIXED_PER_BATCH', 'PERCENT_OF_BASE'],
    SCRAP: ['DIRECT_RATE', 'SCRAP_GROSS_UP'],
  };
  if (!allowed[category].includes(method)) {
    throw new RangeError(method + ' is not supported for ' + category);
  }
  if (method === 'PERCENT_OF_BASE' || method === 'SCRAP_GROSS_UP') {
    if (bases.length === 0) throw new RangeError(category + ' requires at least one cost base category');
    for (const base of bases) {
      if (!SHOULD_COST_CATEGORIES.includes(base) ||
          SHOULD_COST_CATEGORIES.indexOf(base) >= SHOULD_COST_CATEGORIES.indexOf(category)) {
        throw new RangeError(category + ' may only depend on earlier, valid cost categories');
      }
    }
    if (new Set(bases).size !== bases.length) throw new RangeError(category + ' base categories must be unique');
  } else if (bases.length !== 0) {
    throw new RangeError(category + ' does not accept base categories for ' + method);
  }
}

export function calculateShouldCost(input: {
  currency: string;
  target_quantity: string | number;
  target_unit: string;
  rules: ShouldCostRule[];
  evidence: ShouldCostEvidenceInput[];
}): ShouldCostCalculation {
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('currency must be a three-letter code');
  if (!input.target_unit.trim()) throw new RangeError('target_unit is required');
  const targetQuantity = toScaled(input.target_quantity, QUANTITY_SCALE, 'target_quantity');
  if (targetQuantity <= 0n) throw new RangeError('target_quantity must be greater than zero');
  if (input.rules.length !== SHOULD_COST_CATEGORIES.length) {
    throw new RangeError('A profile must configure all seven should-cost categories');
  }
  const ruleByCategory = new Map<ShouldCostCategory, ShouldCostRule>();
  for (const rule of input.rules) {
    if (ruleByCategory.has(rule.category)) throw new RangeError('A category may only be configured once per profile');
    assertMethod(rule.category, rule.calculation_method, rule.base_categories);
    ruleByCategory.set(rule.category, rule);
  }
  for (const category of SHOULD_COST_CATEGORIES) {
    if (!ruleByCategory.has(category)) throw new RangeError('Missing profile configuration for ' + category);
  }

  const inputsByCategory = new Map<ShouldCostCategory, ShouldCostEvidenceInput[]>();
  const lineKeys = new Set<string>();
  for (const line of input.evidence) {
    const rule = ruleByCategory.get(line.category);
    if (!rule) throw new RangeError('Evidence references an unconfigured category');
    const key = line.category + ':' + line.line_number;
    if (!Number.isSafeInteger(line.line_number) || line.line_number < 1 || lineKeys.has(key)) {
      throw new RangeError('Evidence line numbers must be unique positive integers within each category');
    }
    lineKeys.add(key);
    const group = inputsByCategory.get(line.category) ?? [];
    group.push(line);
    inputsByCategory.set(line.category, group);
  }
  for (const category of SHOULD_COST_CATEGORIES) {
    const rule = ruleByCategory.get(category)!;
    const lines = inputsByCategory.get(category) ?? [];
    if (lines.length === 0) throw new RangeError('Missing evidence for ' + category);
    if (lines.some((line) => !line.applicable) && lines.length !== 1) {
      throw new RangeError(category + ' cannot mix NOT_APPLICABLE and cost evidence lines');
    }
    if (lines.length > 1 && rule.calculation_method !== 'DIRECT_RATE') {
      throw new RangeError(category + ' method ' + rule.calculation_method + ' accepts exactly one evidence line');
    }
    if (lines.length === 1 && !lines[0]!.applicable && rule.is_required) {
      throw new RangeError('Required category ' + category + ' cannot be marked NOT_APPLICABLE');
    }
  }

  const totals = Object.fromEntries(SHOULD_COST_CATEGORIES.map((category) => [category, 0n])) as
    Record<ShouldCostCategory, bigint>;
  const calculated: CalculatedEvidenceLine[] = [];
  for (const category of SHOULD_COST_CATEGORIES) {
    const rule = ruleByCategory.get(category)!;
    const lines = inputsByCategory.get(category)!;
    for (const line of lines) {
      const common = {
        category,
        line_number: line.line_number,
        applicable: line.applicable,
        calculation_method: rule.calculation_method,
        input_quantity: line.input_quantity == null ? null : fromScaled(toScaled(line.input_quantity, QUANTITY_SCALE, 'input_quantity'), QUANTITY_SCALE),
        unit_code: line.unit_code?.trim() || null,
        unit_rate: line.unit_rate == null ? null : fromScaled(toScaled(line.unit_rate, RATE_SCALE, 'unit_rate'), RATE_SCALE),
        fixed_amount: line.fixed_amount == null ? null : fromScaled(toScaled(line.fixed_amount, MONEY_SCALE, 'fixed_amount'), MONEY_SCALE),
        percentage_rate: line.percentage_rate == null ? null : fromScaled(toScaled(line.percentage_rate, PERCENT_SCALE, 'percentage_rate'), PERCENT_SCALE),
        source_currency: line.source_currency?.trim().toUpperCase() || null,
        fx_rate_to_cost_currency: line.fx_rate_to_cost_currency == null ? null :
          fromScaled(toScaled(line.fx_rate_to_cost_currency, FX_SCALE, 'fx_rate_to_cost_currency'), FX_SCALE),
        base_categories: [...rule.base_categories],
        source_type: line.source_type.trim().toUpperCase(),
        source_reference: line.source_reference?.trim() || null,
        source_as_of: line.source_as_of ?? null,
        fx_rate_effective_on: line.fx_rate_effective_on ?? null,
        fx_rate_source: line.fx_rate_source?.trim() || null,
        notes: line.notes.trim(),
        source_snapshot: line.source_snapshot,
      };
      if (!line.notes.trim()) throw new RangeError(category + ' evidence notes are required');
      if (!line.source_snapshot || typeof line.source_snapshot !== 'object' || Array.isArray(line.source_snapshot)) {
        throw new RangeError(category + ' evidence requires a structured source snapshot');
      }
      if (!line.applicable) {
        if (line.source_type !== 'NOT_APPLICABLE' || line.source_reference ||
            line.input_quantity != null || line.unit_rate != null || line.fixed_amount != null ||
            line.percentage_rate != null || line.source_currency != null) {
          throw new RangeError('NOT_APPLICABLE evidence must not include cost inputs or a source reference');
        }
        calculated.push({
          ...common, source_amount: null, cost_amount: '0.0000', base_amount: null,
          evidence_hash_payload: common,
        });
        continue;
      }
      if (line.source_type.toUpperCase() === 'NOT_APPLICABLE' ||
          !line.source_reference?.trim() || !line.source_as_of) {
        throw new RangeError(category + ' requires a traceable evidence source and source date');
      }

      let sourceAmount: bigint | null = null;
      let baseAmount: bigint | null = null;
      let costAmount = 0n;
      if (rule.calculation_method === 'DIRECT_RATE') {
        if (line.input_quantity == null || line.unit_rate == null || !line.unit_code?.trim() ||
            line.source_currency == null || line.fx_rate_to_cost_currency == null) {
          throw new RangeError(category + ' direct-rate evidence requires quantity, unit, rate, currency and FX rate');
        }
        const quantity = toScaled(line.input_quantity, QUANTITY_SCALE, 'input_quantity');
        const rate = toScaled(line.unit_rate, RATE_SCALE, 'unit_rate');
        sourceAmount = roundDivide(quantity * rate, 10n ** BigInt(QUANTITY_SCALE + RATE_SCALE - MONEY_SCALE));
        costAmount = convertToCostCurrency(sourceAmount, line.fx_rate_to_cost_currency);
      } else if (rule.calculation_method === 'FIXED_PER_BATCH') {
        if (line.fixed_amount == null || line.source_currency == null || line.fx_rate_to_cost_currency == null) {
          throw new RangeError(category + ' fixed-per-batch evidence requires amount, currency and FX rate');
        }
        sourceAmount = toScaled(line.fixed_amount, MONEY_SCALE, 'fixed_amount');
        costAmount = convertToCostCurrency(sourceAmount, line.fx_rate_to_cost_currency);
      } else if (rule.calculation_method === 'PERCENT_OF_BASE') {
        if (line.percentage_rate == null) throw new RangeError(category + ' evidence requires percentage_rate');
        const rate = toScaled(line.percentage_rate, PERCENT_SCALE, 'percentage_rate');
        if (rate > PERCENT_DENOMINATOR) throw new RangeError(category + ' percentage cannot exceed 100');
        baseAmount = addBase(rule.base_categories, totals);
        sourceAmount = roundDivide(baseAmount * rate, PERCENT_DENOMINATOR);
        costAmount = sourceAmount;
      } else if (rule.calculation_method === 'SCRAP_GROSS_UP') {
        if (line.percentage_rate == null) throw new RangeError('SCRAP evidence requires percentage_rate');
        const rate = toScaled(line.percentage_rate, PERCENT_SCALE, 'percentage_rate');
        if (rate >= PERCENT_DENOMINATOR) throw new RangeError('Scrap percentage must be less than 100');
        baseAmount = addBase(rule.base_categories, totals);
        sourceAmount = roundDivide(baseAmount * rate, PERCENT_DENOMINATOR - rate);
        costAmount = sourceAmount;
      }

      if (sourceAmount == null || sourceAmount < 0n || costAmount < 0n) {
        throw new RangeError(category + ' produced an invalid monetary amount');
      }
      totals[category] += costAmount;
      calculated.push({
        ...common,
        source_amount: fromScaled(sourceAmount, MONEY_SCALE),
        cost_amount: fromScaled(costAmount, MONEY_SCALE),
        base_amount: baseAmount == null ? null : fromScaled(baseAmount, MONEY_SCALE),
        evidence_hash_payload: {
          ...common,
          source_amount: fromScaled(sourceAmount, MONEY_SCALE),
          cost_amount: fromScaled(costAmount, MONEY_SCALE),
          base_amount: baseAmount == null ? null : fromScaled(baseAmount, MONEY_SCALE),
        },
      });
    }
  }

  const totalCost = SHOULD_COST_CATEGORIES.reduce((sum, category) => sum + totals[category], 0n);
  const costPerUnit = roundDivide(totalCost * 10_000_000_000n, targetQuantity);
  return {
    currency,
    target_quantity: fromScaled(targetQuantity, QUANTITY_SCALE),
    target_unit: input.target_unit.trim(),
    total_cost: fromScaled(totalCost, MONEY_SCALE),
    cost_per_unit: fromScaled(costPerUnit, 8),
    component_totals: Object.fromEntries(
      SHOULD_COST_CATEGORIES.map((category) => [category, fromScaled(totals[category], MONEY_SCALE)]),
    ) as Record<ShouldCostCategory, string>,
    evidence: calculated,
    formula_version: 'factoryos.should-cost.v1',
  };
}

export function calculateGrossMargin(revenue: string | number | null, cost: string | number): MarginCalculation | null {
  if (revenue == null) return null;
  const revenueScaled = toScaled(revenue, MONEY_SCALE, 'revenue');
  const costScaled = toScaled(cost, MONEY_SCALE, 'cost');
  const margin = revenueScaled - costScaled;
  const percent = revenueScaled === 0n
    ? null
    : roundDivide(margin * 100n * 1_000_000n, revenueScaled);
  return {
    revenue: fromScaled(revenueScaled, MONEY_SCALE),
    cost: fromScaled(costScaled, MONEY_SCALE),
    gross_margin_amount: fromScaled(margin, MONEY_SCALE),
    gross_margin_percent: percent == null ? null : fromScaled(percent, 6),
  };
}

export function normalizeCostCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError('Currency must be a three-letter code');
  return currency;
}
