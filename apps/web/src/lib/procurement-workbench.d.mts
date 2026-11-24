export interface ProcurementSupplier {
  id: string; code: string; name: string; status: "ACTIVE" | "DISABLED";
  country_code: string; email: string | null; phone: string | null; tax_reference: string | null;
  payment_terms_days: number; currency: string; address: string | null; notes: string | null;
  created_by_user_id: string; created_at: string; updated_at: string; version: string;
  [key: string]: unknown;
}
export interface ProcurementPurchaseOrder {
  id: string; supplier_id: string; supplier_code: string; supplier_name: string;
  po_number: string; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED";
  order_date: string; expected_delivery_date: string | null; currency: string;
  payment_terms_days: number; notes: string | null; created_by_user_id: string;
  created_at: string; updated_at: string; version: string; total_amount: string; line_count: number;
  [key: string]: unknown;
}
export function normalizeProcurementRows(value: unknown, preferredKey?: string): unknown[];
export function buildProcurementListQuery(filters?: Record<string, unknown>, kind?: string): string;
export function buildSupplierPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSupplierUpdatePayload(input: Record<string, unknown>, expectedVersion: unknown): Record<string, unknown>;
export function buildSupplierStatusPayload(targetStatus: string, expectedVersion: unknown): Record<string, unknown>;
export function buildPurchaseOrderPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildPurchaseOrderUpdatePayload(input: Record<string, unknown>, expectedVersion: unknown): Record<string, unknown>;
export function buildPurchaseOrderTransitionPayload(targetStatus: string, expectedVersion: unknown, reason?: string): Record<string, unknown>;
export function buildGoodsReceiptPayload(input?: Record<string, unknown>): Record<string, unknown>;
export function buildSupplierPerformanceQuery(input?: Record<string, unknown>): string;
export function filterProcurementRows<T>(rows?: T[], filters?: Record<string, unknown>, kind?: string): T[];
export function summarizeProcurement(suppliers?: object[], purchaseOrders?: object[]): {
  activeSuppliers: number; supplierCount: number; purchaseOrderCount: number;
  draftCount: number; submittedCount: number; approvedCount: number;
  openCurrencyCount: number; openValueCurrency: string; totalOpenValue: number | null;
  openValueByCurrency: Record<string, number>;
};
