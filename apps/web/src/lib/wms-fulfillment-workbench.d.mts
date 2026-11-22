export type WmsContainerType = "CARTON" | "PALLET";
export type WmsDeliveryEvent = "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERY_FAILED" | "DELIVERED" | "RETURNED";

export interface FulfillmentInventoryItem {
  id: string;
  sku: string;
  name: string;
  unit: string;
  status: string;
  quantity_on_hand?: string;
  quantity_reserved?: string;
  quantity_available?: string;
}

export interface FulfillmentLocation {
  id: string;
  location_code: string;
  name: string;
  location_type: string;
  status: string;
  picking_enabled: boolean;
}

export interface FulfillmentIdentity {
  id: string;
  unit_type: string;
  product_role: string;
  unit_code: string;
  barcode_value?: string | null;
  inventory_item_id?: string | null;
  inventory_sku?: string | null;
  inventory_item_name?: string | null;
  quantity: string;
  unit: string;
  status: string;
  expires_at?: string | null;
}

export interface FulfillmentContainer {
  container_unit_id: string;
  unit_code: string;
  item_id: string;
  location_id: string;
  container_type: WmsContainerType;
  unit: string;
  capacity_quantity: string;
  packed_quantity: string;
  status: "OPEN" | "SEALED" | "DISPATCHED";
  sealed_at?: string | null;
  dispatched_at?: string | null;
  contents: Array<{
    source_unit_id: string;
    source_unit_code: string;
    quantity: string;
    unit: string;
  }>;
}

export interface FulfillmentShipment {
  shipment_unit_id: string;
  shipment_code: string;
  container_unit_id: string;
  container_code: string;
  item_id: string;
  source_location_id: string;
  inventory_movement_id: string;
  customer_name: string;
  customer_order_reference: string;
  order_id?: string | null;
  order_line_id?: string | null;
  carrier_name?: string | null;
  tracking_reference?: string | null;
  quantity: string;
  unit: string;
  status: string;
  traceability_status: string;
  dispatched_at: string;
  latest_delivery_event_type?: string | null;
  latest_delivery_event_at?: string | null;
}

export interface FulfillmentDeliveryEvent {
  id: string;
  shipment_unit_id: string;
  event_type: WmsDeliveryEvent;
  source_system: string;
  event_at: string;
  recipient_name?: string | null;
  proof_type?: string | null;
  proof_reference?: string | null;
  proof_sha256?: string | null;
  signed_at?: string | null;
  notes?: string | null;
  created_at: string;
}

export interface FulfillmentOrder {
  id: string;
  order_number: string;
  customer_name: string | null;
  customer_reference: string | null;
  status: string;
  requested_delivery_date?: string | null;
}

export interface FulfillmentOrderDetail extends FulfillmentOrder {
  lines: Array<{
    id: string;
    line_number: number;
    product_code: string;
    product_name: string;
    inventory_item_id: string | null;
    quantity: string;
    unit: string;
  }>;
}

export function asFulfillmentRows<T = Record<string, unknown>>(value: unknown, key?: string): T[];
export function summarizeFulfillment(containers?: FulfillmentIdentity[], shipments?: FulfillmentShipment[]): {
  containers: number; cartons: number; pallets: number; shipments: number;
  awaitingUpdate: number; inTransit: number; deliveryFailed: number; delivered: number; returned: number;
};
export function filterContainerIdentities<T extends FulfillmentIdentity>(rows: T[], search?: string, type?: string): T[];
export function filterOutboundShipments<T extends FulfillmentShipment>(rows: T[], search?: string, event?: string): T[];
export function buildCreateContainerPayload(input: Record<string, unknown>): {
  container_type: WmsContainerType; container_code: string; item_id: string; location_id: string; capacity_quantity: number;
};
export function buildPackingContentPayload(input: Record<string, unknown>): { source_unit_id: string; quantity: number };
export function buildDispatchPayload(input: Record<string, unknown>): Record<string, string>;
export function supportedDeliveryEventTypes(): WmsDeliveryEvent[];
export function buildDeliveryEventPayload(input: Record<string, unknown>): Record<string, string>;
export function fulfillmentStatusLabel(value: string): string;
