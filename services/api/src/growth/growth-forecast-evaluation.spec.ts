import {
  evaluateGrowthForecast,
  GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE,
  GROWTH_FORECAST_EVALUATION_VERSION,
  summarizeGrowthForecastCalibration,
  type GrowthForecastCalibrationObservation,
} from './growth-forecast-evaluation';

describe('growth forecast evaluation', () => {
  it('computes signed error, MAE inputs, squared error and interval coverage deterministically', () => {
    const result = evaluateGrowthForecast({
      forecast_value: 120,
      actual_value: 100,
      lower_bound: 90,
      upper_bound: 110,
      nominal_coverage_pct: 90,
    });

    expect(result.method_version).toBe(GROWTH_FORECAST_EVALUATION_VERSION);
    expect(result.signed_error).toBe('20.00000000');
    expect(result.absolute_error).toBe('20.00000000');
    expect(result.squared_error).toBe('400.00000000');
    expect(result.absolute_percentage_error).toBe('20.00000000');
    expect(result.symmetric_percentage_error).toBe('18.18181818');
    expect(result.interval_hit).toBe(false);
    expect(result.interval_width).toBe('20.00000000');
    expect(result.interval_semantics).toBe('DECLARED_NOMINAL_COVERAGE');
  });

  it('handles zero actuals without emitting an infinite percentage error', () => {
    const result = evaluateGrowthForecast({ forecast_value: 0, actual_value: 0 });
    expect(result.signed_error).toBe('0.00000000');
    expect(result.absolute_percentage_error).toBeNull();
    expect(result.symmetric_percentage_error).toBe('0.00000000');
    expect(result.interval_hit).toBeNull();
    expect(result.interval_semantics).toBe('NONE');
  });

  it('rounds input values to eight decimals and normalizes negative zero', () => {
    const result = evaluateGrowthForecast({ forecast_value: -0, actual_value: 0.123456789 });
    expect(result.forecast_value).toBe('0.00000000');
    expect(result.actual_value).toBe('0.12345679');
    expect(result.signed_error).toBe('-0.12345679');
  });

  it('preserves PostgreSQL decimal strings that cannot be represented at eight-place precision by Number', () => {
    const result = evaluateGrowthForecast({
      forecast_value: 1000000000000,
      actual_value: '999999999999.99999999',
    });
    expect(result.actual_value).toBe('999999999999.99999999');
    expect(result.signed_error).toBe('0.00000001');
    expect(result.absolute_percentage_error).toBe('0.00000000');
  });

  it('rejects non-finite or out-of-domain numeric inputs', () => {
    expect(() => evaluateGrowthForecast({ forecast_value: Number.NaN, actual_value: 1 }))
      .toThrow('FORECAST_VALUE_INVALID:forecast_value');
    expect(() => evaluateGrowthForecast({ forecast_value: 1, actual_value: 1e13 }))
      .toThrow('FORECAST_VALUE_INVALID:actual_value');
  });

  it('requires paired, ordered bounds and a nominal target only when an interval exists', () => {
    expect(() => evaluateGrowthForecast({ forecast_value: 1, actual_value: 1, lower_bound: 0 }))
      .toThrow('FORECAST_INTERVAL_BOUNDS_MUST_BE_PAIRED');
    expect(() => evaluateGrowthForecast({ forecast_value: 1, actual_value: 1, lower_bound: 3, upper_bound: 2 }))
      .toThrow('FORECAST_INTERVAL_BOUNDS_REVERSED');
    expect(() => evaluateGrowthForecast({ forecast_value: 1, actual_value: 1, nominal_coverage_pct: 90 }))
      .toThrow('FORECAST_NOMINAL_COVERAGE_REQUIRES_INTERVAL');
    expect(() => evaluateGrowthForecast({ forecast_value: 1, actual_value: 1, lower_bound: 0, upper_bound: 2, nominal_coverage_pct: 100 }))
      .toThrow('FORECAST_NOMINAL_COVERAGE_INVALID');
  });

  it('labels ranges without an explicit nominal target as heuristic, not calibrated intervals', () => {
    const result = evaluateGrowthForecast({ forecast_value: 5, actual_value: 6, lower_bound: 4, upper_bound: 7 });
    expect(result.interval_hit).toBe(true);
    expect(result.nominal_coverage_pct).toBeNull();
    expect(result.interval_semantics).toBe('HEURISTIC_RANGE');
  });

  it('reports empirical coverage and calibration gap only after a sufficiently large declared cohort', () => {
    const rows: GrowthForecastCalibrationObservation[] = Array.from(
      { length: GROWTH_FORECAST_CALIBRATION_MIN_SAMPLE_SIZE },
      (_, index) => ({
        model_version: 'ops-v1',
        metric_key: 'daily_output',
        unit: 'units',
        forecast_value: '100.00000000',
        actual_value: '101.00000000',
        signed_error: '-1.00000000',
        absolute_error: '1.00000000',
        squared_error: '1.00000000',
        symmetric_percentage_error: '0.99502488',
        interval_hit: index < 8,
        nominal_coverage_pct: '90.00',
      }),
    );

    const [summary] = summarizeGrowthForecastCalibration(rows);
    expect(summary.sample_count).toBe(10);
    expect(summary.mean_error).toBe(-1);
    expect(summary.mean_absolute_error).toBe(1);
    expect(summary.root_mean_squared_error).toBe(1);
    expect(summary.empirical_interval_coverage_pct).toBe(80);
    expect(summary.calibration_gap_pct_points).toBe(-10);
    expect(summary.status).toBe('ASSESSABLE');
  });

  it('keeps small cohorts and ranges without a declared nominal coverage uncalibrated', () => {
    const row: GrowthForecastCalibrationObservation = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'units',
      forecast_value: 100, actual_value: 102, signed_error: -2,
      absolute_error: 2, squared_error: 4, symmetric_percentage_error: 1.98019802,
      interval_hit: true, nominal_coverage_pct: null,
    };
    expect(summarizeGrowthForecastCalibration([row])[0].status).toBe('INSUFFICIENT_SAMPLE');

    const rows = Array.from({ length: 10 }, () => ({ ...row }));
    expect(summarizeGrowthForecastCalibration(rows)[0].status).toBe('NO_NOMINAL_COVERAGE');
  });

  it('groups metrics by model version, unit and declared coverage rather than mixing incompatible cohorts', () => {
    const base: GrowthForecastCalibrationObservation = {
      model_version: 'ops-v1', metric_key: 'daily_output', unit: 'units',
      forecast_value: 100, actual_value: 102, signed_error: -2,
      absolute_error: 2, squared_error: 4, symmetric_percentage_error: 1.98019802,
      interval_hit: true, nominal_coverage_pct: 90,
    };
    const summaries = summarizeGrowthForecastCalibration([
      base, { ...base, unit: 'dozens' }, { ...base, nominal_coverage_pct: 80 },
      { ...base, model_version: 'ops-v2' },
    ]);
    expect(summaries).toHaveLength(4);
  });
});
