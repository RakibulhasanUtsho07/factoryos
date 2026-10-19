import {
  buildGrowthScenarioPlan,
  canonicalizeGrowthScenarioInput,
  type GrowthScenarioProfilesInput,
} from './growth-scenario-engine';

const profile = (changes: Partial<GrowthScenarioProfilesInput['base']> = {}) => ({
  price_change_pct: 0,
  volume_change_pct: 0,
  variable_cost_change_pct: 0,
  fixed_cost_change_pct: 0,
  investment: 0,
  uncertainty_pct: 10,
  ...changes,
});

const profiles: GrowthScenarioProfilesInput = {
  base: profile(),
  upside: profile({ price_change_pct: 4, volume_change_pct: 10 }),
  downside: profile({ price_change_pct: -3, volume_change_pct: -8 }),
  stress: profile({ volume_change_pct: -20, variable_cost_change_pct: 25 }),
};

describe('growth scenario planning engine', () => {
  it('creates all four named cases and a reproducible inclusive sensitivity grid', () => {
    const plan = buildGrowthScenarioPlan(profiles, [{
      parameter: 'price_change_pct',
      low_value: -10,
      high_value: 10,
      points: 3,
    }]);

    expect(plan.slice(0, 4).map(item => item.scenario_type)).toEqual([
      'BASE', 'UPSIDE', 'DOWNSIDE', 'STRESS',
    ]);
    const sensitivity = plan.slice(4);
    expect(sensitivity.map(item => item.sensitivity_value)).toEqual([-10, 0, 10]);
    expect(sensitivity.every(item => item.scenario_type === 'CUSTOM')).toBe(true);
    expect(sensitivity.map(item => item.profile.price_change_pct)).toEqual([-10, 0, 10]);
    expect(sensitivity.every(item => item.profile.volume_change_pct === profiles.base.volume_change_pct)).toBe(true);
    expect(plan.map(item => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('rejects non-increasing or overly fine sensitivity ranges', () => {
    expect(() => buildGrowthScenarioPlan(profiles, [{
      parameter: 'investment', low_value: 10, high_value: 10, points: 2,
    }])).toThrow('SCENARIO_SENSITIVITY_RANGE_INVALID:investment');
    expect(() => buildGrowthScenarioPlan(profiles, [{
      parameter: 'price_change_pct', low_value: 0, high_value: 0.00001, points: 3,
    }])).toThrow('SCENARIO_SENSITIVITY_RESOLUTION_TOO_FINE:price_change_pct');
  });

  it('rejects out-of-domain values and duplicate sensitivity dimensions', () => {
    expect(() => buildGrowthScenarioPlan({
      ...profiles, stress: profile({ volume_change_pct: 501 }),
    }, [{ parameter: 'investment', low_value: 0, high_value: 100, points: 2 }]))
      .toThrow('SCENARIO_PARAMETER_OUT_OF_BOUNDS:volume_change_pct');
    expect(() => buildGrowthScenarioPlan(profiles, [
      { parameter: 'investment', low_value: 0, high_value: 100, points: 2 },
      { parameter: 'investment', low_value: 10, high_value: 200, points: 3 },
    ])).toThrow('SCENARIO_SENSITIVITY_PARAMETER_DUPLICATED:investment');
  });

  it('does not inherit base constraints and requires one projection per sensitivity point', () => {
    const projected = {
      capacity_utilization_pct: 80,
      quality_yield_pct: 99,
      cash_after_investment: 100000,
      cash_currency: 'BDT',
      delivery_backlog_days: 3,
    };
    const plan = buildGrowthScenarioPlan({
      ...profiles,
      base: profile({ projected_constraint_metrics: projected }),
    }, [{
      parameter: 'price_change_pct',
      low_value: -10,
      high_value: 10,
      points: 3,
      projected_constraint_metrics: [projected, null, projected],
    }]);
    expect(plan[0].profile.projected_constraint_metrics).toEqual(projected);
    expect(plan.slice(4).map(item => item.profile.projected_constraint_metrics))
      .toEqual([projected, null, projected]);

    expect(() => buildGrowthScenarioPlan(profiles, [{
      parameter: 'price_change_pct',
      low_value: -10,
      high_value: 10,
      points: 3,
      projected_constraint_metrics: [projected],
    }])).toThrow('SCENARIO_SENSITIVITY_PROJECTION_COUNT_MISMATCH:price_change_pct');
  });

  it('canonicalizes object keys so equivalent input snapshots have the same bytes', () => {
    expect(canonicalizeGrowthScenarioInput({
      baseline: { revenue: 100, variableCost: 40 }, model: 'v1',
    })).toBe(canonicalizeGrowthScenarioInput({
      model: 'v1', baseline: { variableCost: 40, revenue: 100 },
    }));
    expect(canonicalizeGrowthScenarioInput({ value: -0 })).toBe('{"value":0}');
  });
});
