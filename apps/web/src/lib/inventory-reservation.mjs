const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decimalUnits(value, field) {
  const source = text(String(value ?? ""));
  const match = /^(?:0|[1-9]\\d*)(?:\\.(\\d{1,4}))?$/.exec(source);
  if (!match) throw new Error(field + " must be a positive quantity with at most 4 decimal places.");
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
}

function decimalNumber(units) {
  const whole = units / 10000n;
  const fraction = String(units % 10000n).padStart(4, "0");
  return Number(whole.toString() + "." + fraction);
}

export function asReservationRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.reservations)) return value.reservations;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
}

export function summarizeReservations(rows = []) {
  let remainingUnits = 0n;
  let consumedUnits = 0n;
  let releasedUnits = 0n;
  let active = 0;
  let partial = 0;
  for (const row of rows) {
    const remaining = decimalUnits(String(row.remaining_quantity ?? "0"), "remaining_quantity");
    const consumed = decimalUnits(String(row.consumed_quantity ?? "0"), "consumed_quantity");
    const released = decimalUnits(String(row.released_quantity ?? "0"), "released_quantity");
    if (String(row.status).toUpperCase() === "RESERVED" && remaining > 0n) {
      active += 1;
      remainingUnits += remaining;
      if (consumed > 0n || released > 0n) partial += 1;
    }
    consumedUnits += consumed;
    releasedUnits += released;
  }
  return {
    total: rows.length,
    active,
    partial,
    remainingQuantity: decimalNumber(remainingUnits),
    consumedQuantity: decimalNumber(consumedUnits),
    releasedQuantity: decimalNumber(releasedUnits),
  };
}

export function filterReservations(rows = [], search = "", status = "ALL") {
  const query = text(search).toLowerCase();
  const wantedStatus = text(status).toUpperCase();
  return rows.filter((row) => {
    if (wantedStatus !== "ALL" && String(row.status).toUpperCase() !== wantedStatus) return false;
    if (!query) return true;
    return [
      row.id, row.reference_type, row.reference_id, row.notes,
      row.location_id, row.status, row.correlation_id,
    ].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

export function buildCreateReservationPayload(input) {
  const quantity = decimalUnits(input.quantity, "quantity");
  if (quantity <= 0n) throw new Error("Reservation quantity must be greater than zero.");
  const payload = { quantity: decimalNumber(quantity) };
  const referenceType = text(input.reference_type).toUpperCase();
  const referenceId = text(input.reference_id);
  const locationId = text(input.location_id);
  const notes = text(input.notes);
  if (referenceType.length > 64) throw new Error("Reference type must be 64 characters or fewer.");
  if (referenceId && !UUID.test(referenceId)) throw new Error("Reference ID must be a valid UUID.");
  if (locationId && !UUID.test(locationId)) throw new Error("Select a valid BIN location.");
  if (notes.length > 1000) throw new Error("Notes must be 1000 characters or fewer.");
  if (referenceType) payload.reference_type = referenceType;
  if (referenceId) payload.reference_id = referenceId;
  if (locationId) payload.location_id = locationId;
  if (notes) payload.notes = notes;
  return payload;
}

export function buildReservationTransitionPayload(input) {
  const targetStatus = text(input.target_status).toUpperCase();
  if (targetStatus === "RELEASED") return { target_status: "RELEASED" };
  if (targetStatus !== "CONSUMED") throw new Error("Choose CONSUMED or RELEASED.");
  const remaining = decimalUnits(input.remaining_quantity, "remaining_quantity");
  if (remaining <= 0n) throw new Error("There is no remaining reserved quantity to consume.");
  const supplied = text(input.quantity);
  if (!supplied) return { target_status: "CONSUMED" };
  const quantity = decimalUnits(supplied, "quantity");
  if (quantity <= 0n) throw new Error("Consumption quantity must be greater than zero.");
  if (quantity > remaining) throw new Error("Consumption quantity cannot exceed the remaining reservation.");
  return { target_status: "CONSUMED", quantity: decimalNumber(quantity) };
}

export function reservationStatusLabel(value) {
  const status = text(value).toUpperCase();
  if (status === "RESERVED") return "Open reservation";
  if (status === "CONSUMED") return "Fully consumed";
  if (status === "RELEASED") return "Released";
  return status || "Unknown";
}
