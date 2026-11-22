export interface GrowthOpportunity {
  id: string; title: string; category: string; opportunity_statement: string; success_hypothesis: string;
  assumptions: string[]; expected_value_low: string; expected_value_high: string; currency: string;
  uncertainty_pct: string; effort: string; time_to_impact_days: number; implementation_risk: string;
  owner_user_id: string; status: string; created_by: string; created_at: string; updated_at: string;
  evidence: GrowthEvidence[]; scenarios: GrowthScenario[]; experiments: GrowthExperiment[];
  experiment_results: GrowthExperimentResult[]; outcomes: GrowthOutcome[]; validation_unknowns: GrowthUnknown[];
}
export interface GrowthEvidence {
  id: string; evidence_type: string; origin_class: string; reference_ref?: string | null;
  citation_url?: string | null; description: string; confidence: string; captured_at: string;
}
export interface GrowthScenario {
  id: string; scenario_name: string; scenario_type: string; model_version: string; data_vintage: string;
  baseline_source_ref: string; inputs: Record<string, unknown>; output_snapshot: Record<string, unknown>;
  input_hash: string; decision_ready: boolean; created_at: string;
}
export interface GrowthExperiment {
  id: string; name: string; objective: string; hypothesis: string; leading_indicators: string[];
  duration_days: number; owner_user_id: string; baseline_measurements: Record<string, unknown>;
  stop_conditions: string[]; status: string; started_at?: string | null; ended_at?: string | null;
  created_at: string; results?: GrowthExperimentResult[];
}
export interface GrowthExperimentResult {
  id: string; experiment_id: string; assessment: string; stop_condition_triggered: boolean;
  pre_measurements: Record<string, unknown>; post_measurements: Record<string, unknown>;
  evidence_refs: string[]; result_notes?: string | null; observed_at: string; created_at: string;
  kpi_measurements: Array<Record<string, unknown>>;
}
export interface GrowthOutcomeKpi {
  id: string; outcome_id: string; metric_key: string; baseline_value: string;
  actual_value: string; target_value?: string | null; unit: string; direction: string;
  evidence_ref: string; created_at: string;
}
export interface GrowthOutcome {
  id: string; experiment_result_id?: string | null; assessment: string;
  realized_metrics: Record<string, unknown>; evidence_refs: string[]; notes?: string | null;
  observed_at: string; created_at: string; kpi_measurements: GrowthOutcomeKpi[];
}
export interface GrowthUnknown {
  id: string; question: string; decision_variable: string; impact_if_wrong: string;
  probability_unknown: string; validation_effort: string; priority_score: string;
  validation_method: string; owner_user_id?: string | null; status: string;
  resolution_evidence_ref?: string | null; resolution_notes?: string | null;
  created_at: string;
}
export interface GrowthAssumption {
  id: string; statement: string; rationale: string; risk_if_false: string; confidence_pct: string;
  validation_method: string; initial_evidence_refs: string[]; owner_user_id: string;
  blocks_decision: boolean; latest_decision?: string | null; evidence_refs: string[];
  decision_reason?: string | null; decision_owner_user_id?: string | null; decided_at?: string | null;
  created_at: string;
}
export interface GrowthConstraint {
  id: string; dimension: string; applicability: string; constraint_name: string;
  limit_operator?: string | null; threshold_value?: string | null; observed_value?: string | null;
  unit?: string | null; source_evidence_ref?: string | null; source_as_of?: string | null;
  rationale: string; owner_user_id?: string | null; created_at: string;
}
export interface GrowthEvidenceGap {
  id: string; question: string; required_evidence: string; impact: string; owner_user_id: string;
  due_at?: string | null; blocks_decision: boolean; latest_decision: string;
  evidence_refs: string[]; decision_reason?: string | null; created_at: string;
}
export interface GrowthDecisionOwner {
  id: string; role_code: string; owner_user_id: string; rationale: string; assigned_by: string;
  assigned_at: string; active_to?: string | null; owner_active: boolean;
}
export interface GrowthGovernance {
  opportunity_id: string; assumptions: GrowthAssumption[]; constraints: GrowthConstraint[];
  evidence_gaps: GrowthEvidenceGap[]; decision_owners: GrowthDecisionOwner[];
  readiness: { ready: boolean; status: "READY" | "BLOCKED"; blockers: string[];
    missing_evidence: Array<{ code: string; subject_id?: string; detail: string }> };
  interpretation: string;
}
export interface GrowthScenarioComparison {
  opportunity: { id: string; status: string; currency: string };
  comparison_method: string; comparable: boolean; comparability_reasons: string[];
  ranking_enabled: boolean; ranking_blockers: string[]; model_versions: string[];
  baseline_sources: string[]; data_vintages: string[];
  scenario_type_coverage: { required: string[]; present: string[]; missing: string[] };
  ranking_basis?: string | null; scenarios: Array<Record<string, unknown>>;
}
export interface GrowthScenarioSet {
  id: string; set_name: string; set_version: number; expected_scenario_count: number; model_version: string;
  data_vintage: string; baseline_source_ref: string; inputs: Record<string, unknown>; input_hash: string;
  scenario_count: number; decision_ready: boolean; sensitivity_decision_ready: boolean;
  scenario_type_coverage: { required: string[]; present: string[]; missing: string[] };
  scenarios: GrowthScenario[];
}
export interface GrowthPricingPolicy {
  id: string;
  [key: string]: unknown;
}
export function normalizeGrowthRows<T = Record<string, unknown>>(value: unknown, key?: string): T[];
export function buildGrowthOpportunityPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthOwnerPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthAssumptionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthAssumptionDecisionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthConstraintPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthEvidenceGapPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthEvidenceGapDecisionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthOpportunityDecisionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthScenarioSetPayload(input: Record<string, unknown>, evidenceReferences?: string[]): Record<string, unknown>;
export function buildGrowthExperimentPayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildGrowthValidationUnknownPayload(input: Record<string, unknown>): Record<string, unknown>;
export function filterGrowthOpportunities<T extends GrowthOpportunity>(rows: T[], search?: string, status?: string, category?: string): T[];
export function summarizeGrowthOpportunities(rows?: GrowthOpportunity[]): {
  total: number; proposed: number; accepted: number; inProgress: number; realized: number; rejected: number; closed: number; other: number;
};
export function growthReadinessSummary(governance?: GrowthGovernance | null): {
  ready: boolean; blockerCount: number; missingEvidence: Array<{ code: string; subject_id?: string; detail: string }>;
};
