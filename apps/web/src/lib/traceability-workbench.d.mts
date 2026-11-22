export interface TraceabilityUnit {
  id: string;
  unit_type: string;
  product_role: string;
  unit_code: string;
  barcode_value?: string | null;
  rfid_epc?: string | null;
  inventory_item_id?: string | null;
  inventory_sku?: string | null;
  inventory_item_name?: string | null;
  quantity: string | number;
  unit: string;
  supplier_code?: string | null;
  supplier_name?: string | null;
  receipt_number?: string | null;
  goods_receipt_line_id?: string | null;
  order_number?: string | null;
  product_code?: string | null;
  product_name?: string | null;
  production_report_id?: string | null;
  external_reference?: string | null;
  manufactured_at?: string | null;
  expires_at?: string | null;
  status: string;
  attributes?: Record<string, unknown> | null;
  version?: number;
  correlation_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}
export interface TraceabilityRelationship {
  id: string;
  source_unit_id: string;
  source_unit_code: string;
  source_unit_type: string;
  target_unit_id: string;
  target_unit_code: string;
  target_unit_type: string;
  relationship_type: string;
  quantity: string | number;
  unit: string;
  notes?: string | null;
  correlation_id?: string | null;
  created_at?: string | null;
}
export interface TraceabilityNode extends TraceabilityUnit { depth: number }
export interface TraceabilityWalk {
  root: TraceabilityUnit;
  direction: "FORWARD" | "REVERSE";
  max_depth: number;
  limit: number;
  retention_years: number;
  truncated: boolean;
  node_limit_reached: boolean;
  depth_truncated: boolean;
  units: TraceabilityNode[];
  relationships: TraceabilityRelationship[];
}
export interface RecallShipment {
  shipment_unit_id: string;
  shipment_code: string;
  customer_name: string;
  customer_order_reference: string;
  carrier_name?: string | null;
  tracking_reference?: string | null;
  quantity: string | number;
  unit: string;
  dispatched_at: string;
  latest_delivery_event_type?: string | null;
  latest_delivery_event_at?: string | null;
  pod_reference?: string | null;
}
export interface RecallImpact {
  requested_unit: TraceabilityUnit;
  direction: "FORWARD";
  max_depth: number;
  node_limit: number;
  impact_truncated: boolean;
  impact_node_limit_reached: boolean;
  impact_depth_truncated: boolean;
  provenance_truncated: boolean;
  provenance_node_limit_reached: boolean;
  provenance_depth_truncated: boolean;
  impacted_unit_count: number;
  impacted_units: TraceabilityNode[];
  downstream_relationships: TraceabilityRelationship[];
  upstream_provenance: TraceabilityNode[];
  upstream_relationships: TraceabilityRelationship[];
  affected_shipment_count: number;
  affected_shipments: RecallShipment[];
  side_effects: { stock_changed: boolean; statuses_changed: boolean; records_created: boolean };
}
export interface RecallDeclaration {
  recall_case: {
    id: string;
    source_unit_id: string;
    reason: string;
    max_depth: number;
    node_limit: number;
    impacted_unit_count: number;
    impact_fingerprint: string;
    created_at: string;
  };
  units: Array<{
    unit_id: string;
    unit_code_snapshot: string;
    unit_type_snapshot: string;
    depth: number;
    status_before: string;
    unit_action: "RECALLED" | "ALREADY_RECALLED" | "SHIPPED_REVIEW_REQUIRED" | "ALREADY_DISPOSED";
    status_event_id?: string | null;
  }>;
  follow_up_required: number;
  replayed: boolean;
}
export interface RecallNotification {
  id: string;
  recall_case_id: string;
  recipient_type: "CUSTOMER" | "SITE";
  recipient_reference: string;
  channel: "EMAIL" | "PORTAL" | "EDI" | "MANUAL";
  reason?: string | null;
  created_at: string;
  dispatch_status: string;
  acknowledgement_id?: string | null;
  acknowledgement_outcome?: string | null;
  acknowledgement_notes?: string | null;
  acknowledgement_evidence_reference?: string | null;
  acknowledgement_source?: string | null;
  acknowledgement_created_at?: string | null;
  acknowledgement_externally_authenticated?: boolean;
}
export interface TraceabilityStatusEvent {
  id: string;
  unit_id: string;
  version: number;
  from_status: string;
  to_status: string;
  reason: string;
  correlation_id?: string | null;
  created_at: string;
}
export function asTraceabilityRows(value: unknown, key?: string): unknown[];
export function summarizeTraceabilityUnits(units?: TraceabilityUnit[]): {
  total: number; active: number; quarantined: number; recalled: number; shipped: number;
  disposed: number; lots: number; serials: number; expiringSoon: number;
};
export function buildRecallDeclarationPayload(input: { reason: string; depth: number | string; limit: number | string }): {
  reason: string; depth: number; limit: number;
};
export function buildRecallNotificationIntentPayload(input: {
  recipient_type: string; recipient_reference: string; channel: string; reason?: string;
}): { recipient_type: "CUSTOMER" | "SITE"; recipient_reference: string; channel: "EMAIL" | "PORTAL" | "EDI" | "MANUAL"; reason?: string };
export function buildRecallAcknowledgementPayload(input: {
  outcome: string; notes?: string; evidence_reference?: string;
}): { outcome: string; notes?: string; evidence_reference?: string };
export function buildTraceabilityStatusPayload(input: { target_status: string; reason: string }): {
  target_status: string; reason: string;
};
export function traceabilityStatusLabel(value: string): string;
export function traceabilityUnitTypeLabel(value: string): string;
