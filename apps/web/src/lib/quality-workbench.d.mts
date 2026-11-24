export interface QualityRow {
  id?: string;
  status?: string;
  row_version?: number | string;
  inspection_type?: string;
  target_type?: string;
  target_id?: string;
  [key: string]: unknown;
}
export function normalizeQualityRows(value: unknown, preferredKey?: string): unknown[];
export function buildQualityQuery(filters?: Record<string, unknown>, kind?: "inspections" | "plans" | "holds" | "rework"): string;
export function buildQualityInspectionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function parseQualityCriteriaDraft(input: string | unknown[]): Array<Record<string, unknown>>;
export function buildQualityPlanPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityDecisionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityDefectPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityResultPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityDispositionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityNcrActionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityNcrTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildQualityNcrVerificationPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function summarizeQualityWorkspace(input?: { inspections?: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>>; holds?: Array<Record<string, unknown>>; reworkOrders?: Array<Record<string, unknown>> }): Record<string, number>;
export function filterQualityRows<T extends Record<string, unknown>>(rows?: T[], search?: string, status?: string): T[];
export function validateQualityIdempotencyKey(value: unknown): string;
