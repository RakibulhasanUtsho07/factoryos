export const GROWTH_SCENARIO_CANONICALIZATION_VERSION = 2 as const;

export type GrowthScenarioSensitivityParameter =
  | 'price_change_pct'
  | 'volume_change_pct'
  | 'variable_cost_change_pct'
  | 'fixed_cost_change_pct'
  | 'investment'
  | 'uncertainty_pct';

export interface GrowthScenarioProfileInput {
  price_change_pct: number;
  volume_change_pct: number;
  variable_cost_change_pct: number;
  fixed_cost_change_pct: number;
  investment: number;
  uncertainty_pct: number;
  projected_constraint_metrics?: Record<string, unknown> | null;
}

export interface GrowthScenarioProfilesInput {
  base: GrowthScenarioProfileInput;
  upside: GrowthScenarioProfileInput;
  downside: GrowthScenarioProfileInput;
  stress: GrowthScenarioProfileInput;
}

export interface GrowthScenarioSensitivityAxisInput {
  parameter: GrowthScenarioSensitivityParameter;
  low_value: number;
  high_value: number;
  points: number;
  projected_constraint_metrics?: Array<Record<string, unknown> | null>;
}

export interface GrowthScenarioPlanEntry {
  scenario_key: string;
  scenario_type: 'BASE' | 'UPSIDE' | 'DOWNSIDE' | 'STRESS' | 'CUSTOM';
  display_name: string;
  position: number;
  profile: GrowthScenarioProfileInput;
  sensitivity_parameter: GrowthScenarioSensitivityParameter | null;
  sensitivity_value: number | null;
}

const PARAMETER_BOUNDS: Record<GrowthScenarioSensitivityParameter, [number, number]> = {
  price_change_pct: [-90, 500],
  volume_change_pct: [-90, 500],
  variable_cost_change_pct: [-100, 500],
  fixed_cost_change_pct: [-100, 500],
  investment: [0, 1_000_000_000_000],
  uncertainty_pct: [0, 100],
};

const PROFILE_PARAMETERS = Object.keys(PARAMETER_BOUNDS) as GrowthScenarioSensitivityParameter[];

function assertWithinBounds(parameter: GrowthScenarioSensitivityParameter, value: number): void {
  const [minimum, maximum] = PARAMETER_BOUNDS[parameter];
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`SCENARIO_PARAMETER_OUT_OF_BOUNDS:${parameter}`);
  }
}

function normalizedNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error('SCENARIO_NON_FINITE_VALUE');
  const normalized = Number(value.toFixed(4));
  if (!Number.isFinite(normalized)) throw new Error('SCENARIO_NON_FINITE_VALUE');
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function buildGrowthScenarioPlan(
  profiles: GrowthScenarioProfilesInput,
  sensitivity: GrowthScenarioSensitivityAxisInput[],
): GrowthScenarioPlanEntry[] {
  if (!profiles || !profiles.base || !profiles.upside || !profiles.downside || !profiles.stress) {
    throw new Error('SCENARIO_FOUR_PROFILES_REQUIRED');
  }
  if (!Array.isArray(sensitivity) || sensitivity.length < 1 || sensitivity.length > PROFILE_PARAMETERS.length) {
    throw new Error('SCENARIO_SENSITIVITY_AXES_REQUIRED');
  }

  const profileEntries = [
    { key: 'BASE', type: 'BASE' as const, label: 'Base', profile: profiles.base },
    { key: 'UPSIDE', type: 'UPSIDE' as const, label: 'Upside', profile: profiles.upside },
    { key: 'DOWNSIDE', type: 'DOWNSIDE' as const, label: 'Downside', profile: profiles.downside },
    { key: 'STRESS', type: 'STRESS' as const, label: 'Stress', profile: profiles.stress },
  ];
  const entries: GrowthScenarioPlanEntry[] = [];
  let position = 1;

  for (const item of profileEntries) {
    for (const parameter of PROFILE_PARAMETERS) {
      assertWithinBounds(parameter, item.profile[parameter]);
    }
    entries.push({
      scenario_key: item.key,
      scenario_type: item.type,
      display_name: item.label,
      position: position++,
      profile: { ...item.profile },
      sensitivity_parameter: null,
      sensitivity_value: null,
    });
  }

  const seenParameters = new Set<GrowthScenarioSensitivityParameter>();
  for (let axisIndex = 0; axisIndex < sensitivity.length; axisIndex += 1) {
    const axis = sensitivity[axisIndex];
    if (!axis || !PROFILE_PARAMETERS.includes(axis.parameter)) {
      throw new Error('SCENARIO_SENSITIVITY_PARAMETER_INVALID');
    }
    if (seenParameters.has(axis.parameter)) {
      throw new Error(`SCENARIO_SENSITIVITY_PARAMETER_DUPLICATED:${axis.parameter}`);
    }
    seenParameters.add(axis.parameter);
    assertWithinBounds(axis.parameter, axis.low_value);
    assertWithinBounds(axis.parameter, axis.high_value);
    if (axis.low_value >= axis.high_value) {
      throw new Error(`SCENARIO_SENSITIVITY_RANGE_INVALID:${axis.parameter}`);
    }
    if (!Number.isInteger(axis.points) || axis.points < 2 || axis.points > 11) {
      throw new Error(`SCENARIO_SENSITIVITY_POINT_COUNT_INVALID:${axis.parameter}`);
    }

    if (axis.projected_constraint_metrics && axis.projected_constraint_metrics.length !== axis.points) {
      throw new Error(`SCENARIO_SENSITIVITY_PROJECTION_COUNT_MISMATCH:${axis.parameter}`);
    }
    const axisValues = Array.from({ length: axis.points }, (_, index) =>
      normalizedNumber(axis.low_value + (axis.high_value - axis.low_value) * index / (axis.points - 1)),
    );
    if (new Set(axisValues).size !== axisValues.length) {
      throw new Error(`SCENARIO_SENSITIVITY_RESOLUTION_TOO_FINE:${axis.parameter}`);
    }
    for (let index = 0; index < axisValues.length; index += 1) {
      const value = axisValues[index];
      entries.push({
        scenario_key: `SENSITIVITY:${axis.parameter}:${index + 1}:${value.toFixed(4)}`,
        scenario_type: 'CUSTOM',
        display_name: `Sensitivity ${axis.parameter} = ${value.toFixed(4)}`,
        position: position++,
        profile: {
          ...profiles.base,
          [axis.parameter]: value,
          projected_constraint_metrics: axis.projected_constraint_metrics
            ? axis.projected_constraint_metrics[index] ?? null
            : null,
        },
        sensitivity_parameter: axis.parameter,
        sensitivity_value: value,
      });
    }
  }

  return entries;
}

export function canonicalizeGrowthScenarioInput(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('SCENARIO_NON_FINITE_INPUT');
      return Object.is(item, -0) ? 0 : item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      const entries = Object.entries(item as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, normalize(child)]);
      return Object.fromEntries(entries);
    }
    return item;
  };
  return JSON.stringify(normalize(value)) ?? 'null';
}
