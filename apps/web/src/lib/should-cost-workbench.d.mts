export type ShouldCostCategory = "MATERIAL" | "LABOUR" | "ENERGY" | "FREIGHT" | "DUTY" | "OVERHEAD" | "SCRAP";
export type ShouldCostMethod = "DIRECT_RATE" | "FIXED_PER_BATCH" | "PERCENT_OF_BASE" | "SCRAP_GROSS_UP";
export type ShouldCostScope = "PRODUCT_VERSION" | "ORDER" | "QUOTATION";
export interface ShouldCostProfileComponent {
  id?: string; category: ShouldCostCategory; calculation_method: ShouldCostMethod;
  is_required: boolean; base_categories: ShouldCostCategory[]; guidance: string;
}
export interface ShouldCostProfile {
  id: string; product_id: string | null; profile_code: string; version: number;
  currency: string; output_unit: string; status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | string;
  is_current: boolean; row_version: number | string; created_by_user_id: string;
  submitted_by_user_id?: string | null; approved_by_user_id?: string | null;
  decision_reason?: string | null; components?: ShouldCostProfileComponent[];
  history?: Array<Record<string, unknown>>; [key: string]: unknown;
}
export interface ShouldCostAssessment {
  id: string; scope_type: ShouldCostScope; scope_id: string; product_version_id?: string | null;
  order_id?: string | null; quotation_id?: string | null; quotation_revision_number?: number | null;
  profile_id: string; profile_code: string; profile_version: number; target_quantity: string;
  target_unit: string; currency: string; total_cost: string; cost_per_unit: string;
  component_totals: Record<ShouldCostCategory, string>; revenue_source_currency?: string | null;
  revenue_amount?: string | null; gross_margin_amount?: string | null; gross_margin_percent?: string | null;
  status: string; evidence?: Array<Record<string, unknown>>; history?: Array<Record<string, unknown>>;
  created_at: string; [key: string]: unknown;
}
export const SHOULD_COST_CATEGORIES: ShouldCostCategory[];
export function normalizeShouldCostRows(value: unknown, preferredKey?: string): unknown[];
export function buildShouldCostProfilePayload(input: Record<string, unknown>): {
  factory_id: string; product_id?: string; profile_code: string; currency: string; output_unit: string;
  components: ShouldCostProfileComponent[];
};
export function buildShouldCostTransitionPayload(expectedVersion: unknown, reason: string): { expected_version: number; reason: string };
export function buildShouldCostAssessmentPayload(input: Record<string, unknown>, profile: ShouldCostProfile): {
  scope_type: ShouldCostScope; target_id: string; profile_id: string; target_quantity: number; target_unit: string; evidence: Array<Record<string, unknown>>;
};
export function buildShouldCostQuery(filters?: Record<string, unknown>, kind?: "profiles" | "assessments"): string;
export function summarizeShouldCost(profiles?: ShouldCostProfile[], assessments?: ShouldCostAssessment[]): Record<string, number>;
export function filterShouldCostProfiles(rows?: ShouldCostProfile[], search?: string, status?: string): ShouldCostProfile[];
export function formatShouldCostMoney(value: unknown, currency: string, digits?: number): string;
export function shouldCostMarginTone(value: unknown): "NEGATIVE" | "LOW" | "MODERATE" | "HEALTHY" | "UNKNOWN";
