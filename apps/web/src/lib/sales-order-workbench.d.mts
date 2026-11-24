export type SalesOrderStatus = "DRAFT" | "CONFIRMED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export interface SalesOrderRecord extends Record<string, unknown> {
  id: string;
  order_number: string;
  status: SalesOrderStatus;
  version?: number | string;
}
export interface SalesOrderPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}
export interface SalesOrderRequest {
  (path: string, options?: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string }): Promise<unknown>;
}
export interface SalesOrderClient {
  list(input?: { page?: number; limit?: number; status?: SalesOrderStatus | "ALL"; search?: string }): Promise<unknown>;
  get(orderId: string): Promise<unknown>;
  create(body: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
  transition(orderId: string, body: Record<string, unknown>): Promise<unknown>;
  listProductionReports(orderId: string, limit?: number): Promise<unknown>;
  createProductionReport(orderId: string, body: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
  createMaterialDisposition(orderId: string, body: Record<string, unknown>, idempotencyKey: string): Promise<unknown>;
}
export function normalizeSalesOrderRows(value: unknown): Record<string, unknown>[];
export function normalizeSalesOrderPagination(value: unknown): SalesOrderPagination;
export function buildSalesOrderListQuery(input?: { page?: number; limit?: number; status?: string; search?: string }): string;
export function buildSalesOrderCreatePayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSalesOrderTransitionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildOrderProductionReportPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildOrderMaterialDispositionPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function summarizeSalesOrders(input: unknown, today?: string): {
  total_loaded: number; draft: number; confirmed: number; in_progress: number;
  completed: number; cancelled: number; overdue: number;
};
export function createSalesOrderClient(request: SalesOrderRequest): SalesOrderClient;
