export type InventoryReservation = {
  id: string;
  item_id: string;
  location_id: string | null;
  quantity: string;
  remaining_quantity: string;
  consumed_quantity: string;
  released_quantity: string;
  status: "RESERVED" | "RELEASED" | "CONSUMED";
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  consumed_movement_id: string | null;
  created_by_user_id: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  replayed: boolean;
};

export type ReservationInventoryItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  status: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
};

export type ReservationLocation = {
  id: string;
  code: string;
  name: string;
  location_type: string;
  status: string;
  picking_enabled?: boolean;
};

export function asReservationRows(value: unknown): InventoryReservation[];
export function summarizeReservations(rows?: InventoryReservation[]): {
  total: number;
  active: number;
  partial: number;
  remainingQuantity: number;
  consumedQuantity: number;
  releasedQuantity: number;
};
export function filterReservations(rows?: InventoryReservation[], search?: string, status?: string): InventoryReservation[];
export function buildCreateReservationPayload(input: {
  quantity: string;
  reference_type?: string;
  reference_id?: string;
  location_id?: string;
  notes?: string;
}): {
  quantity: number;
  reference_type?: string;
  reference_id?: string;
  location_id?: string;
  notes?: string;
};
export function buildReservationTransitionPayload(input: {
  target_status: "CONSUMED" | "RELEASED";
  quantity?: string;
  remaining_quantity: string;
}): { target_status: "CONSUMED" | "RELEASED"; quantity?: number };
export function reservationStatusLabel(value: string): string;
