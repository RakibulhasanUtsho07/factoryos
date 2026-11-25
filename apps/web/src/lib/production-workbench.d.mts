export interface ProductionWorkOrder {
  id: string; work_order_number: string; status: "DRAFT" | "RELEASED" | "IN_PROGRESS" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
  source_order_id: string; source_order_line_id: string; product_id: string; product_version_id: string;
  finished_item_id: string; target_quantity: string; planned_start_date: string; due_date: string | null;
  priority: number; row_version: number; notes: string | null;
  [key: string]: unknown;
}
export function normalizeProductionRows(value: unknown, preferredKey?: string): unknown[];
export function buildWorkOrderListQuery(input?: Record<string, unknown>): string;
export function buildWorkOrderPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildWorkOrderTransitionPayload(command: string, expectedVersion: unknown, reason?: string): Record<string, unknown>;
export function buildOperationEventPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildProductionOutputPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function filterWorkOrders<T extends Record<string, unknown>>(rows?: T[], filters?: Record<string, unknown>): T[];
export function summarizeProduction(workOrders?: Array<Record<string, unknown>>, materialRadar?: Array<Record<string, unknown>>): {
  workOrderCount: number; draftCount: number; releasedCount: number;
  inProgressCount: number; onHoldCount: number; completedCount: number;
  materialRequirementCount: number; shortageRequirementCount: number; projectedShortageLines: number;
};
