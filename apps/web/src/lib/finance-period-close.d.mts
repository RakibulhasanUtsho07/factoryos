export interface FinanceCloseReadiness {
  missing_reporting_domains: string[];
  uninitialized_reporting_domains: string[];
  unresolved_reconciliation_count: number;
  can_submit: boolean;
}
export interface FinanceCloseDomain {
  domain: string;
  connector_code?: string | null;
  source_system?: string | null;
  status?: string | null;
  last_completed_at?: string | null;
  is_active: boolean;
}
export interface FinanceClosePerformance {
  fact_type_totals?: Array<{ fact_type: string; amount: string; fact_count: number }>;
  actual_fact_count?: number;
  forecast_fact_count?: number;
  actual_revenue?: string;
  actual_cost?: string;
  actual_contribution_cost?: string;
  actual_gross_margin?: string;
  actual_contribution_margin?: string;
  actual_gross_margin_percent?: string | null;
  actual_contribution_margin_percent?: string | null;
  forecast_revenue?: string;
  forecast_cost?: string;
  forecast_contribution_cost?: string;
  revenue_variance?: string;
  cost_variance?: string;
  contribution_cost_variance?: string;
  gross_margin_variance?: string;
  contribution_margin_variance?: string;
}
export interface FinanceCloseWorkingCapitalPosition {
  fact_type: string;
  amount: string;
  fact_count: number;
}
export interface FinanceCloseSnapshot {
  schema: string;
  currency: string;
  period_start: string;
  period_end: string;
  currency_policy: string;
  source_of_record_policy: string;
  actual_forecast_policy: string;
  period_costing_profitability: FinanceClosePerformance | null;
  working_capital_positions: FinanceCloseWorkingCapitalPosition[];
  reporting_domains: FinanceCloseDomain[];
  operational_reconciliation: { unresolved_mismatch_count: number };
  readiness: FinanceCloseReadiness;
  prohibited_side_effects: string[];
}
export interface FinanceClosePeriod {
  id: string;
  currency: string;
  period_start: string;
  period_end: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED";
  row_version: number;
  snapshot: FinanceCloseSnapshot;
  snapshot_hash: string;
  created_by_user_id: string;
  submitted_by_user_id?: string | null;
  submitted_at?: string | null;
  approved_by_user_id?: string | null;
  approved_at?: string | null;
  approval_reason?: string | null;
  created_at: string;
  updated_at: string;
  replayed?: boolean;
}
export function normalizeFinanceCloseRows<T = FinanceClosePeriod>(value: unknown): T[];
export function buildFinanceCloseCreatePayload(input: Record<string, unknown>): Record<string, unknown>;
export function buildFinanceCloseActionPayload(input: Record<string, unknown>): Record<string, unknown>;
export function financeCloseReadiness(snapshot?: FinanceCloseSnapshot | null): {
  ready: boolean; blockers: string[];
};
export function summarizeFinanceClosePeriods(rows?: FinanceClosePeriod[]): {
  total: number; drafts: number; submitted: number; approved: number; readyDrafts: number; blockedDrafts: number;
};
export function filterFinanceClosePeriods<T extends FinanceClosePeriod>(
  rows: T[], filters?: { status?: string; currency?: string; search?: string }
): T[];
