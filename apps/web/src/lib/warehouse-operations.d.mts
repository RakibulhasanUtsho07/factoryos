export type WarehouseItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  sector_code?: string | null;
  status: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
};

export type WarehouseLocation = {
  id: string;
  location_code: string;
  name: string;
  location_type: string;
  is_default: boolean;
  status: string;
  putaway_enabled: boolean;
  picking_enabled: boolean;
  putaway_priority: number;
  picking_priority: number;
};

export type WarehousePutawayTarget = {
  location_id: string;
  location_code: string;
  location_name: string;
  parent_location_id: string | null;
  putaway_priority: number;
  picking_enabled: boolean;
  quantity_on_hand: string;
  quantity_reserved: string;
};

export type WarehousePickSource = {
  location_id: string;
  location_code: string;
  location_name: string;
  parent_location_id: string | null;
  picking_priority: number;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
};

export type WarehouseTraceabilityUnit = {
  id: string;
  unit_type: "LOT" | "SERIAL";
  product_role: "MATERIAL" | "FINISHED_GOOD";
  unit_code: string;
  inventory_item_id: string | null;
  status: string;
  expires_at: string | null;
  attributes?: Record<string, unknown>;
};

export type WarehouseTransfer = {
  id: string;
  item_id: string;
  source_location_id: string;
  destination_location_id: string;
  traceability_unit_id: string | null;
  movement_purpose: "PUT_AWAY" | "PICK" | "TRANSFER";
  quantity: string;
  source_quantity_before: string;
  source_quantity_after: string;
  destination_quantity_before: string;
  destination_quantity_after: string;
  notes: string | null;
  correlation_id: string;
  created_at: string;
  replayed: boolean;
};

export function asWarehouseRows<T = unknown>(value: unknown, key: string): T[];
export function summarizeWarehouseOperations(
  items?: WarehouseItem[],
  putawayTargets?: WarehousePutawayTarget[],
  pickSources?: WarehousePickSource[],
  transfers?: WarehouseTransfer[],
): {
  activeItems: number;
  putawayTargets: number;
  pickSources: number;
  availableAtBins: number;
  reservedAtBins: number;
  recentTransfers: number;
  putawayMoves: number;
  pickMoves: number;
};
export function filterWarehouseTransfers(rows?: WarehouseTransfer[], search?: string, purpose?: string): WarehouseTransfer[];
export function buildLocationTransferPayload(input: {
  movement_purpose: "PUT_AWAY" | "PICK" | "TRANSFER";
  source_location_id: string;
  destination_location_id: string;
  quantity: string;
  traceability_unit_id?: string;
  notes?: string;
}): {
  movement_purpose: "PUT_AWAY" | "PICK" | "TRANSFER";
  source_location_id: string;
  destination_location_id: string;
  quantity: number;
  traceability_unit_id?: string;
  notes?: string;
};
export function warehousePurposeLabel(value: string): string;
