/**
 * Versioned deterministic scoring for out-of-sample operational forecasts.
 *
 * Errors are calculated on an eight-decimal fixed-point grid. Calibration is
 * descriptive only: this module never changes a model or infers a nominal
 * interval coverage from heuristic uncertainty bounds.
 */
export const GROWTH_FORECAST_EVALUATION_VERSION = 'factoryos.growth.forecast-evaluation.v1' as const;
export const GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE = 10;
const SCALE = 100_000_000n;
const MAX_ABS_VALUE = 1_000_000_000_000;

export interface GrowthForecastEvaluationInput {
  forecast_value: number;
  actual_value: number | string;
  lower_bound?: number | null;
  upper_bound?: number | null;
  nominal_coverage_pct?: number | null;
}

export interface GrowthForecastEvaluationMetrics {
  method_version: typeof GROWTH_FORECAST_EVALUATION_VERSION;
  forecast_value: string;
  actual_value: string;
  signed_error: string;
  absolute_error: string;
  squared_error: string;
  absolute_percentage_error: string | null;
  symmetric_percentage_error: string;
  lower_bound: string | null;
  upper_bound: string | null;
  nominal_coverage_pct: string | null;
  interval_hit: boolean | null;
  interval_width: string | null;
  interval_semantics: 'NONE' | 'HEURISTIC_RANGE' | 'DECLARED_NOMINAL_COVERAGE';
}

export interface GrowthForecastCalibrationObservation {
  model_version: string;
  metric_key: string;
  unit: string;
  forecast_value: string | number;
  actual_value: string | number;
  signed_error: string | number;
  absolute_error: string | number;
  squared_error: string | number;
  symmetric_percentage_error: string | number;
  interval_hit: boolean | null;
  nominal_coverage_pct: string | number | null;
  interval_semantics?: 'NONE' | 'HEURISTIC_RANGE' | 'DECLARED_NOMINAL_COVERAGE';
}

export interface GrowthForecastCalibrationBucket {
  model_version: string;
  metric_key: string;
  unit: string;
  nominal_coverage_pct: number | null;
  interval_semantics: 'NONE' | 'HEURISTIC_RANGE' | 'DECLARED_NOMINAL_COVERAGE';
  sample_count: number;
  mean_error: number;
  mean_absolute_error: number;
  root_mean_squared_error: number;
  mean_symmetric_percentage_error_pct: number;
  interval_sample_count: number;
  empirical_interval_coverage_pct: number | null;
  calibration_gap_pct_points: number | null;
  status: 'INSUFFICIENT_SAMPLE' | 'NO_NOMINAL_COVERAGE' | 'INSUFFICIENT_INTERVAL_SAMPLE' | 'ASSESSABLE';
}

function assertNumber(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_VALUE) {
    throw new Error(`FORECAST_VALUE_INVALID:${name}`);
  }
}

function parseScaledDecimal(decimal: string): bigint {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(decimal)) throw new Error('FORECAST_DECIMAL_FORMAT_INVALID');
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, fraction = ''] = unsigned.split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
  return negative ? -result : result;
}

function scaled(value: number): bigint {
  assertNumber('numeric', value);
  return parseScaledDecimal(value.toFixed(8));
}

function scaledInput(name: string, value: number | string): bigint {
  if (typeof value === 'number') {
    assertNumber(name, value);
    return scaled(value);
  }
  if (typeof value !== 'string') throw new Error(`FORECAST_VALUE_INVALID:${name}`);
  const parsed = parseScaledDecimal(value);
  const absolute = parsed < 0n ? -parsed : parsed;
  if (absolute > BigInt(MAX_ABS_VALUE) * SCALE) throw new Error(`FORECAST_VALUE_INVALID:${name}`);
  return parsed;
}

function integerSquareRoot(value: bigint): bigint {
  if (value < 0n) throw new Error('FORECAST_SQUARE_ROOT_NEGATIVE');
  if (value < 2n) return value;
  let current = value;
  let next = (current + 1n) / 2n;
  while (next < current) {
    current = next;
    next = (current + value / current) / 2n;
  }
  return current;
}

function roundedSquareRoot(value: bigint): bigint {
  const floor = integerSquareRoot(value);
  return value - floor * floor >= floor + 1n ? floor + 1n : floor;
}

function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(8, '0');
  return `${negative && absolute !== 0n ? '-' : ''}${whole.toString()}.${fraction}`;
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('FORECAST_RATIO_DENOMINATOR_INVALID');
  if (numerator < 0n) return -roundRatio(-numerator, denominator);
  return (numerator + denominator / 2n) / denominator;
}

function scaledRatioPercent(numerator: bigint, denominator: bigint, multiplier: bigint): bigint {
  return roundRatio(numerator * multiplier * SCALE, denominator);
}

function normalizePercentage(value: number): string {
  if (!Number.isFinite(value) || value < 1 || value > 99.99) {
    throw new Error('FORECAST_NOMINAL_COVERAGE_INVALID');
  }
  return value.toFixed(2);
}

export function evaluateGrowthForecast(input: GrowthForecastEvaluationInput): GrowthForecastEvaluationMetrics {
  assertNumber('forecast_value', input.forecast_value);
  const forecast = scaled(input.forecast_value);
  const actual = scaledInput('actual_value', input.actual_value);
  const error = forecast - actual;
  const absoluteError = error < 0n ? -error : error;
  const forecastAbs = forecast < 0n ? -forecast : forecast;
  const actualAbs = actual < 0n ? -actual : actual;
  const squaredError = roundRatio(absoluteError * absoluteError, SCALE);
  const denominator = forecastAbs + actualAbs;
  const smape = denominator === 0n ? 0n : scaledRatioPercent(absoluteError, denominator, 200n);
  const absolutePercentageError = actualAbs === 0n
    ? null
    : formatScaled(scaledRatioPercent(absoluteError, actualAbs, 100n));

  const hasLower = input.lower_bound !== undefined && input.lower_bound !== null;
  const hasUpper = input.upper_bound !== undefined && input.upper_bound !== null;
  if (hasLower !== hasUpper) throw new Error('FORECAST_INTERVAL_BOUNDS_MUST_BE_PAIRED');
  const hasInterval = hasLower && hasUpper;
  const lower = hasInterval ? scaled(input.lower_bound as number) : null;
  const upper = hasInterval ? scaled(input.upper_bound as number) : null;
  if (hasInterval && (lower as bigint) > (upper as bigint)) {
    throw new Error('FORECAST_INTERVAL_BOUNDS_REVERSED');
  }

  const nominalProvided = input.nominal_coverage_pct !== undefined && input.nominal_coverage_pct !== null;
  if (nominalProvided && !hasInterval) throw new Error('FORECAST_NOMINAL_COVERAGE_REQUIRES_INTERVAL');
  const nominal = nominalProvided ? normalizePercentage(input.nominal_coverage_pct as number) : null;
  const intervalHit = hasInterval ? actual >= (lower as bigint) && actual <= (upper as bigint) : null;
  const intervalWidth = hasInterval ? (upper as bigint) - (lower as bigint) : null;

  return {
    method_version: GROWTH_FORECAST_EVALUATION_VERSION,
    forecast_value: formatScaled(forecast),
    actual_value: formatScaled(actual),
    signed_error: formatScaled(error),
    absolute_error: formatScaled(absoluteError),
    squared_error: formatScaled(squaredError),
    absolute_percentage_error: absolutePercentageError,
    symmetric_percentage_error: formatScaled(smape),
    lower_bound: lower === null ? null : formatScaled(lower),
    upper_bound: upper === null ? null : formatScaled(upper),
    nominal_coverage_pct: nominal,
    interval_hit: intervalHit,
    interval_width: intervalWidth === null ? null : formatScaled(intervalWidth),
    interval_semantics: !hasInterval ? 'NONE'
      : nominalProvided ? 'DECLARED_NOMINAL_COVERAGE' : 'HEURISTIC_RANGE',
  };
}

export function summarizeGrowthForecastCalibration(
  observations: GrowthForecastCalibrationObservation[],
): GrowthForecastCalibrationBucket[] {
  const groups = new Map<string, GrowthForecastCalibrationObservation[]>();
  for (const row of observations) {
    const nominal = row.nominal_coverage_pct === null ? null : Number(row.nominal_coverage_pct);
    const intervalSemantics = row.interval_semantics ?? (nominal !== null ? 'DECLARED_NOMINAL_COVERAGE' : (row.interval_hit === null ? 'NONE' : 'HEURISTIC_RANGE'));
    const key = JSON.stringify([row.model_version, row.metric_key, row.unit, nominal, intervalSemantics]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, rows]) => {
    const [model_version, metric_key, unit, nominal, interval_semantics] = JSON.parse(key) as [string, string, string, number | null, GrowthForecastCalibrationBucket['interval_semantics']];
    const count = BigInt(rows.length);
    const sumScaled = (field: 'signed_error' | 'absolute_error' | 'squared_error' | 'symmetric_percentage_error') =>
      rows.reduce((sum, row) => sum + parseScaledDecimal(String(row[field])), 0n);
    const meanError = roundRatio(sumScaled('signed_error'), count);
    const meanAbsoluteError = roundRatio(sumScaled('absolute_error'), count);
    const meanSquaredError = roundRatio(sumScaled('squared_error'), count);
    const rmseScaled = roundedSquareRoot(meanSquaredError * SCALE);
    const rmse = Number(formatScaled(rmseScaled));
    const meanSmape = roundRatio(sumScaled('symmetric_percentage_error'), count);
    const intervalRows = rows.filter(row => row.interval_hit !== null);
    const intervalCount = intervalRows.length;
    const empiricalCoverage = intervalCount === 0
      ? null
      : Number(((intervalRows.filter(row => row.interval_hit === true).length / intervalCount) * 100).toFixed(4));
    const nominalCoverage = nominal === null ? null : Number(nominal);
    const gap = empiricalCoverage === null || nominalCoverage === null
      ? null : Number((empiricalCoverage - nominalCoverage).toFixed(4));

    let status: GrowthForecastCalibrationBucket['status'];
    if (rows.length < GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE) status = 'INSUFFICIENT_SAMPLE';
    else if (nominalCoverage === null) status = 'NO_NOMINAL_COVERAGE';
    else if (intervalCount < GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE) status = 'INSUFFICIENT_INTERVAL_SAMPLE';
    else status = 'ASSESSABLE';

    return {
      model_version, metric_key, unit, nominal_coverage_pct: nominalCoverage, interval_semantics,
      sample_count: rows.length,
      mean_error: Number(formatScaled(meanError)),
      mean_absolute_error: Number(formatScaled(meanAbsoluteError)),
      root_mean_squared_error: rmse,
      mean_symmetric_percentage_error_pct: Number(formatScaled(meanSmape)),
      interval_sample_count: intervalCount,
      empirical_interval_coverage_pct: empiricalCoverage,
      calibration_gap_pct_points: gap,
      status,
    };
  }).sort((a, b) => {
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    return compare(a.model_version, b.model_version)
      || compare(a.metric_key, b.metric_key)
      || compare(a.unit, b.unit)
      || (a.nominal_coverage_pct ?? -1) - (b.nominal_coverage_pct ?? -1);
  });
}
