const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSES = ["PUT_AWAY", "PICK", "TRANSFER"];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function units(value, field) {
  const source = text(String(value ?? ""));
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,4}))?$/.exec(source);
  if (!match) throw new Error(field + " must use at most four decimal places.");
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
}

function asNumber(value) {
  const whole = value / 10000n;
  const fraction = String(value % 10000n).padStart(4, "0");
  return Number(whole.toString() + "." + fraction);
}

export function asWarehouseRows(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.locations)) return value.locations;
  }
  return [];
}

export function summarizeWarehouseOperations(items = [], putawayTargets = [], pickSources = [], transfers = []) {
  let availableAtBins = 0n;
  let reservedAtBins = 0n;
  for (const source of pickSources) {
    availableAtBins += units(String(source.quantity_available ?? "0"), "quantity_available");
    reservedAtBins += units(String(source.quantity_reserved ?? "0"), "quantity_reserved");
  }
  return {
    activeItems: items.filter((item) => String(item.status).toUpperCase() === "ACTIVE").length,
    putawayTargets: putawayTargets.length,
    pickSources: pickSources.length,
    availableAtBins: asNumber(availableAtBins),
    reservedAtBins: asNumber(reservedAtBins),
    recentTransfers: transfers.length,
    putawayMoves: transfers.filter((row) => row.movement_purpose === "PUT_AWAY").length,
    pickMoves: transfers.filter((row) => row.movement_purpose === "PICK").length,
  };
}

export function filterWarehouseTransfers(rows = [], search = "", purpose = "ALL") {
  const query = text(search).toLowerCase();
  const wanted = text(purpose).toUpperCase();
  return rows.filter((row) => {
    if (wanted !== "ALL" && String(row.movement_purpose).toUpperCase() !== wanted) return false;
    if (!query) return true;
    return [
      row.id, row.movement_purpose, row.source_location_code, row.destination_location_code,
      row.source_location_id, row.destination_location_id, row.traceability_unit_code,
      row.notes, row.correlation_id,
    ].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

export function buildLocationTransferPayload(input) {
  const purpose = text(input.movement_purpose).toUpperCase();
  if (!PURPOSES.includes(purpose)) throw new Error("Choose put-away, picking or internal transfer.");
  const quantity = units(input.quantity, "quantity");
  if (quantity <= 0n) throw new Error("Transfer quantity must be greater than zero.");
  const source = text(input.source_location_id);
  const destination = text(input.destination_location_id);
  if (!UUID.test(source) || !UUID.test(destination)) {
    throw new Error("Choose valid source and destination locations.");
  }
  if (source.toLowerCase() === destination.toLowerCase()) {
    throw new Error("Source and destination locations must differ.");
  }
  const traceabilityUnit = text(input.traceability_unit_id);
  if (traceabilityUnit && !UUID.test(traceabilityUnit)) {
    throw new Error("Traceability identity must be a valid UUID.");
  }
  const notes = text(input.notes);
  if (notes.length > 1000) throw new Error("Notes must be 1000 characters or fewer.");
  return {
    movement_purpose: purpose,
    source_location_id: source,
    destination_location_id: destination,
    quantity: asNumber(quantity),
    ...(traceabilityUnit ? { traceability_unit_id: traceabilityUnit } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function warehousePurposeLabel(value) {
  const purpose = text(value).toUpperCase();
  if (purpose === "PUT_AWAY") return "Put-away";
  if (purpose === "PICK") return "Picking";
  if (purpose === "TRANSFER") return "Internal transfer";
  return purpose || "Unknown";
}
