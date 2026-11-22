export interface ReplenishmentSignal {
  policy_id: string;
  item_id: string;
  sku: string;
  item_name: string;
  unit: string;
  minimum_quantity: string;
  maximum_quantity: string;
  lead_time_days: number;
  preferred_supplier_id: string | null;
  preferred_supplier_name: string | null;
  preferred_supplier_status: string | null;
  enabled: boolean;
  policy_version: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  available_quantity: string;
  incoming_quantity: string;
  inventory_position: string;
  physical_shortage_quantity: string;
  uncovered_shortage_quantity: string;
  recommended_order_quantity: string;
  reorder_triggered: boolean;
  recommendation_status: "NOT_REQUIRED" | "COVERED_BY_INCOMING" | "SUPPLIER_REQUIRED" | "REVIEW_REQUIRED";
  next_incoming_date: string | null;
  estimated_replenishment_date: string;
}
export interface AllocationPolicy {
  policy_scope: "FACTORY" | "SECTOR" | "MATERIAL" | "INHERITED";
  sector_code?: string | null;
  inventory_item_id?: string | null;
  allocation_policy: "FIFO" | "FEFO" | "LOT" | "SERIAL" | null;
  require_traceability: boolean | null;
  version: number | null;
  updated_at?: string;
  source: "MATERIAL" | "SECTOR" | "FACTORY" | "SYSTEM_DEFAULT";
  inherited?: boolean;
}
export interface InventoryMaterial {
  id: string;
  sku: string;
  name: string;
  unit: string;
  sector_code?: string | null;
  status: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
}
export interface ReplenishmentSupplier {
  id: string;
  code: string;
  name: string;
  status: string;
  currency?: string;
}
export function asInventoryRows(value: unknown, key?: string): unknown[];
export function summarizeReplenishment(shortages?: ReplenishmentSignal[], recommendations?: ReplenishmentSignal[], allocationPolicies?: AllocationPolicy[]): {
  shortageItems: number; uncoveredItems: number; recommendations: number;
  supplierRequired: number; reviewRequired: number; allocationRules: number; traceabilityRequired: number;
};
export function filterReplenishmentRows(rows: ReplenishmentSignal[], search?: string, status?: string): ReplenishmentSignal[];
export function replenishmentMetrics(row: ReplenishmentSignal): {
  onHand: number; reserved: number; available: number; incoming: number; minimum: number;
  maximum: number; inventoryPosition: number; physicalShortage: number;
  uncoveredShortage: number; recommendedOrder: number;
};
export function buildReorderPolicyPayload(input: Record<string, unknown>): {
  minimum_quantity: number; maximum_quantity: number; lead_time_days: number;
  preferred_supplier_id: string | null; enabled: boolean;
};
export function buildAllocationPolicyPayload(input: Record<string, unknown>): {
  allocation_policy: "FIFO" | "FEFO" | "LOT" | "SERIAL";
  require_traceability: boolean; expected_version: number;
};
export function findAllocationPolicy(policies: AllocationPolicy[], scope: string, value: string): AllocationPolicy | null;
export function resolveAllocationPolicy(item: InventoryMaterial, policies: AllocationPolicy[]): AllocationPolicy;
export function allocationPolicyLabel(value: unknown): string;
export function getReorderEditorDefaults(item: InventoryMaterial, signal?: Partial<ReplenishmentSignal> | null): {
  minimum_quantity: string | number; maximum_quantity: string | number; lead_time_days: string;
  preferred_supplier_id: string; enabled: boolean; item_id: string;
};
