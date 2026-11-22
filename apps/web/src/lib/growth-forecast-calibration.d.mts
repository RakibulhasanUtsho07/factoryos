export interface GrowthForecastEvidence {
  id: string;
  reference_ref?: string | null;
  citation_url?: string | null;
  description: string;
  captured_at: string;
}
export interface GrowthForecastKpi {
  id?: string;
  metric_key: string;
  baseline_value?: string;
  actual_value: string;
  target_value?: string | null;
  unit: string;
  direction?: string;
  evidence_ref: string;
  created_at?: string;
}
export interface GrowthForecastOutcome {
  id: string;
  assessment: string;
  observed_at: string;
  evidence_refs: string[];
  kpi_measurements: GrowthForecastKpi[];
}
export interface GrowthForecastOpportunity {
  id: string;
  title: string;
  category: string;
  status: string;
  currency: string;
  created_at: string;
  evidence: GrowthForecastEvidence[];
  outcomes: GrowthForecastOutcome[];
}
export interface GrowthForecastEvaluation {
  id: string;
  model_version: string;
  metric_key: string;
  unit: string;
  forecast_origin_at: string;
  forecast_source_ref: string;
  outcome_id: string;
  forecast_value: string;
  actual_value: string;
  signed_error: string;
  absolute_error: string;
  squared_error: string;
  absolute_percentage_error?: string | null;
  symmetric_percentage_error: string;
  lower_bound?: string | null;
  upper_bound?: string | null;
  nominal_coverage_pct?: string | null;
  interval_hit?: boolean | null;
  interval_width?: string | null;
  interval_semantics: "NONE" | "HEURISTIC_RANGE" | "DECLARED_NOMINAL_COVERAGE";
  method_version: string;
  input_hash: string;
  idempotency_key: string;
  evaluated_at: string;
  replayed?: boolean;
}
export interface GrowthForecastCalibrationBucket {
  model_version: string;
  metric_key: string;
  unit: string;
  nominal_coverage_pct: number | null;
  interval_semantics: "NONE" | "HEURISTIC_RANGE" | "DECLARED_NOMINAL_COVERAGE";
  sample_count: number;
  mean_error: number;
  mean_absolute_error: number;
  root_mean_squared_error: number;
  mean_symmetric_percentage_error_pct: number;
  interval_sample_count: number;
  empirical_interval_coverage_pct: number | null;
  calibration_gap_pct_points: number | null;
  status: string;
  empirical_residual_threshold?: { status: string; threshold_value: string | null; sample_count: number; interpretation: string };
  uncertainty_threshold_assessment?: string;
  calibration_policy?: { id: string; domain: string; policy_version: number; minimum_sample_count: number; thresholds: Record<string, number | null> } | null;
  error_threshold_assessment?: string;
  error_threshold_failures?: string[];
  interval_threshold_assessment?: string;
}
export interface GrowthForecastCalibrationResponse {
  method_version: string;
  minimum_calibration_sample_size: number;
  observations_included: number;
  total_observations: number;
  sample_window_truncated: boolean;
  policy_domain_filter: string | null;
  approved_policy_count: number;
  interpretation: string;
  calibration: GrowthForecastCalibrationBucket[];
}
export interface GrowthCalibrationPolicy {
  id: string;
  domain: string;
  model_version: string;
  metric_key: string;
  unit: string;
  policy_version: number;
  minimum_sample_count: number;
  max_mean_absolute_error: string;
  max_root_mean_squared_error: string;
  max_absolute_mean_error: string;
  max_mean_symmetric_percentage_error_pct: string;
  max_absolute_calibration_gap_pct_points: string;
  residual_coverage_target_pct: string;
  max_empirical_absolute_residual: string;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  created_by: string;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_reason?: string | null;
  created_at: string;
}
export function normalizeGrowthForecastRows<T = Record<string, unknown>>(value: unknown, key?: string): T[];
export function buildGrowthForecastEvaluationPayload(input: Record<string, unknown>, context?: {
  outcome?: GrowthForecastOutcome | null;
  kpi?: GrowthForecastKpi | null;
  evidence?: GrowthForecastEvidence[];
}): Record<string, unknown>;
export function buildGrowthCalibrationPolicyPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthCalibrationDecisionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function summarizeGrowthCalibrationBuckets(rows?: GrowthForecastCalibrationBucket[]): {
  cohorts: number; assessed: number; insufficient: number; approvedPolicy: number; thresholdBreaches: number;
};
