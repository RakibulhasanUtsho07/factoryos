export interface MaintenanceRow {
  id?: string;
  asset_code?: string;
  work_order_number?: string;
  plan_code?: string;
  name?: string;
  title?: string;
  status?: string;
  row_version?: number | string;
  [key: string]: unknown;
}
export function normalizeMaintenanceRows(value: unknown, preferredKey?: string): unknown[];
export function parseMaintenanceChecklistDraft(value: unknown): Array<{ code: string; description: string; required: boolean }>;
export function buildMaintenanceQuery(filters?: Record<string, unknown>, kind?: "assets" | "plans" | "work_orders"): string;
export function buildMaintenanceAssetPayload(input?: Record<string, unknown>): {
  asset_code: string; name: string; asset_type: string; parent_asset_id?: string;
  manufacturer?: string; model?: string; serial_number?: string; criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  location?: string; commissioned_on?: string; warranty_expires_on?: string; notes?: string;
};
export function buildMaintenanceAssetUpdatePayload(input?: Record<string, unknown>): {
  expected_version: number; reason: string; [key: string]: unknown;
};
export function buildMaintenancePmPlanPayload(input?: Record<string, unknown>): {
  asset_id: string; plan_code: string; name: string; description?: string; interval_value: number;
  interval_unit: "DAY" | "WEEK" | "MONTH"; next_due_on: string; estimated_duration_minutes: number;
  requires_shutdown: boolean; checklist: Array<{ code: string; description: string; required: boolean }>;
};
export function buildMaintenancePmTransitionPayload(input?: Record<string, unknown>): {
  expected_version: number; action: "ACTIVATE" | "PAUSE" | "RESUME" | "RETIRE"; reason: string;
};
export function buildMaintenanceGenerateDuePayload(input?: Record<string, unknown>): {
  expected_version: number; reason?: string;
};
export function buildMaintenanceBreakdownWorkOrderPayload(input?: Record<string, unknown>): {
  asset_id: string; priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; title: string; description: string;
  failure_code?: string; scheduled_start_at?: string; due_at?: string; assigned_to_user_id?: string;
  checklist: Array<{ code: string; description: string; required: boolean }>;
};
export function buildMaintenanceWorkOrderTransitionPayload(input?: Record<string, unknown>): {
  expected_version: number; action: "APPROVE" | "START" | "HOLD" | "RESUME" | "COMPLETE" | "CANCEL"; reason: string;
};
export function buildMaintenanceTaskCompletionPayload(input?: Record<string, unknown>): {
  expected_version: number; reason: string; evidence: Record<string, unknown>;
};
export function buildMaintenanceSparePartPayload(input?: Record<string, unknown>): {
  inventory_item_id: string; required_quantity: number; notes?: string;
};
export function buildMaintenanceSparePartIssuePayload(input?: Record<string, unknown>): {
  expected_version: number; quantity: number; reason: string;
};
export function filterMaintenanceRows<T extends Record<string, unknown>>(rows?: T[], search?: string, status?: string): T[];
export function summarizeMaintenanceWorkspace(input?: {
  assets?: Array<Record<string, unknown>>; plans?: Array<Record<string, unknown>>; workOrders?: Array<Record<string, unknown>>;
}): Record<string, number>;
export function validateMaintenanceIdempotencyKey(value: unknown): string;
