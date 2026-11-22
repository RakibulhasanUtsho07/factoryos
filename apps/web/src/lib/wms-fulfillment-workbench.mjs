const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER_TYPES = ["CARTON", "PALLET"];
const DELIVERY_EVENTS = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_FAILED", "DELIVERED", "RETURNED"];
const PROOF_TYPES = ["SIGNATURE", "PHOTO", "DOCUMENT", "OTP", "CUSTOMER_ACKNOWLEDGEMENT"];
const SAFE_OBJECT_KEY = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function quantityUnits(value, field) {
  const source = clean(String(value ?? ""));
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,4}))?$/.exec(source);
  if (!match) throw new Error(field + " must be positive and use at most four decimal places.");
  const [whole, fraction = ""] = source.split(".");
  const result = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
  if (result <= 0n) throw new Error(field + " must be greater than zero.");
  return result;
}

function quantityNumber(value) {
  const whole = value / 10000n;
  const fraction = String(value % 10000n).padStart(4, "0");
  return Number(whole.toString() + "." + fraction);
}

function requiredUuid(value, field) {
  const result = clean(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid identifier.");
  return result;
}

function requiredText(value, field, max, pattern) {
  const result = clean(value);
  if (!result || result.length > max || (pattern && !pattern.test(result))) {
    throw new Error(field + " is required and must use an allowed format of at most " + max + " characters.");
  }
  return result;
}

export function asFulfillmentRows(value, key = "items") {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.units)) return value.units;
    if (Array.isArray(value.shipments)) return value.shipments;
    if (Array.isArray(value.locations)) return value.locations;
    if (Array.isArray(value.events)) return value.events;
    if (Array.isArray(value.lines)) return value.lines;
  }
  return [];
}

export function summarizeFulfillment(containers = [], shipments = []) {
  const summary = {
    containers: containers.length,
    cartons: containers.filter((row) => String(row.unit_type).toUpperCase() === "CARTON").length,
    pallets: containers.filter((row) => String(row.unit_type).toUpperCase() === "PALLET").length,
    shipments: shipments.length,
    awaitingUpdate: 0,
    inTransit: 0,
    deliveryFailed: 0,
    delivered: 0,
    returned: 0,
  };
  for (const shipment of shipments) {
    const event = clean(shipment.latest_delivery_event_type).toUpperCase();
    if (!event) summary.awaitingUpdate += 1;
    if (event === "IN_TRANSIT" || event === "OUT_FOR_DELIVERY") summary.inTransit += 1;
    if (event === "DELIVERY_FAILED") summary.deliveryFailed += 1;
    if (event === "DELIVERED") summary.delivered += 1;
    if (event === "RETURNED") summary.returned += 1;
  }
  return summary;
}

export function filterContainerIdentities(rows = [], search = "", type = "ALL") {
  const query = clean(search).toLowerCase();
  const wanted = clean(type).toUpperCase();
  return rows.filter((row) => {
    if (wanted !== "ALL" && String(row.unit_type).toUpperCase() !== wanted) return false;
    if (!query) return true;
    return [row.unit_code, row.barcode_value, row.unit_type, row.status, row.inventory_sku]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

export function filterOutboundShipments(rows = [], search = "", event = "ALL") {
  const query = clean(search).toLowerCase();
  const wanted = clean(event).toUpperCase();
  return rows.filter((row) => {
    const latest = clean(row.latest_delivery_event_type).toUpperCase() || "DISPATCHED";
    if (wanted !== "ALL" && latest !== wanted) return false;
    if (!query) return true;
    return [
      row.shipment_code, row.container_code, row.customer_name, row.customer_order_reference,
      row.carrier_name, row.tracking_reference, row.latest_delivery_event_type,
    ].some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

export function buildCreateContainerPayload(input) {
  const type = clean(input.container_type).toUpperCase();
  if (!CONTAINER_TYPES.includes(type)) throw new Error("Choose CARTON or PALLET.");
  const code = requiredText(input.container_code, "Container code", 160, /^[A-Z0-9._:-]+$/i).toUpperCase();
  return {
    container_type: type,
    container_code: code,
    item_id: requiredUuid(input.item_id, "Inventory item"),
    location_id: requiredUuid(input.location_id, "Packing location"),
    capacity_quantity: quantityNumber(quantityUnits(input.capacity_quantity, "Capacity")),
  };
}

export function buildPackingContentPayload(input) {
  const containerId = requiredUuid(input.container_unit_id, "Packing container");
  const sourceId = requiredUuid(input.source_unit_id, "Source identity");
  if (containerId.toLowerCase() === sourceId.toLowerCase()) {
    throw new Error("A container cannot contain itself.");
  }
  const quantity = quantityUnits(input.quantity, "Packing quantity");
  const type = clean(input.container_type).toUpperCase();
  if (type === "CARTON") {
    const source = input.source_unit || {};
    if (String(source.unit_type).toUpperCase() !== "LOT"
      || String(source.product_role).toUpperCase() !== "FINISHED_GOOD"
      || String(source.status).toUpperCase() !== "ACTIVE"
      || source.inventory_item_id !== input.item_id) {
      throw new Error("A carton can contain only an active finished-good LOT for the same item.");
    }
  } else if (type === "PALLET") {
    const source = input.source_container || {};
    if (String(source.container_type).toUpperCase() !== "CARTON"
      || String(source.status).toUpperCase() !== "SEALED"
      || source.item_id !== input.item_id
      || source.location_id !== input.location_id) {
      throw new Error("A pallet can contain only a sealed same-item carton at the same location.");
    }
    if (quantityUnits(source.packed_quantity, "Carton packed quantity") !== quantity) {
      throw new Error("A pallet must contain the whole sealed carton quantity.");
    }
  } else {
    throw new Error("Choose a valid carton or pallet.");
  }
  return { source_unit_id: sourceId, quantity: quantityNumber(quantity) };
}

export function buildDispatchPayload(input) {
  const shipmentCode = requiredText(input.shipment_code, "Shipment code", 160, /^[A-Z0-9._:-]+$/i).toUpperCase();
  const customerName = requiredText(input.customer_name, "Customer name", 255);
  const customerReference = requiredText(input.customer_order_reference, "Customer order reference", 160);
  const carrier = clean(input.carrier_name);
  const tracking = clean(input.tracking_reference);
  if ((carrier === "") !== (tracking === "")) {
    throw new Error("Carrier and tracking reference must be provided together.");
  }
  if (carrier.length > 255 || tracking.length > 255 || /[^\x20-\x7e]/.test(carrier + tracking)) {
    throw new Error("Carrier and tracking reference must be at most 255 visible ASCII characters.");
  }
  const orderId = clean(input.order_id);
  const orderLineId = clean(input.order_line_id);
  if ((orderId === "") !== (orderLineId === "")) {
    throw new Error("Choose both an order and an order line, or leave both unbound.");
  }
  const payload = {
    shipment_code: shipmentCode,
    customer_name: customerName,
    customer_order_reference: customerReference,
    ...(carrier ? { carrier_name: carrier, tracking_reference: tracking } : {}),
  };
  if (orderId && orderLineId) {
    payload.order_id = requiredUuid(orderId, "Order");
    payload.order_line_id = requiredUuid(orderLineId, "Order line");
  }
  return payload;
}

export function supportedDeliveryEventTypes() {
  return [...DELIVERY_EVENTS];
}

export function buildDeliveryEventPayload(input) {
  const eventType = clean(input.event_type).toUpperCase();
  if (!DELIVERY_EVENTS.includes(eventType)) throw new Error("Choose a supported delivery event.");
  const notes = clean(input.notes);
  if (notes.length > 2000) throw new Error("Delivery notes must be 2000 characters or fewer.");
  const payload = { event_type: eventType, ...(notes ? { notes } : {}) };
  if (input.event_at) {
    const eventAt = new Date(input.event_at);
    if (!Number.isFinite(eventAt.getTime()) || eventAt.getTime() > Date.now() + 10 * 60 * 1000) {
      throw new Error("Event time must be valid and cannot be more than ten minutes in the future.");
    }
    payload.event_at = eventAt.toISOString();
  }
  if (eventType === "DELIVERED") {
    const recipient = requiredText(input.recipient_name, "Recipient name", 255);
    const proofType = clean(input.proof_type).toUpperCase();
    if (!PROOF_TYPES.includes(proofType)) throw new Error("Choose a supported proof-of-delivery type.");
    const tenantId = requiredUuid(input.tenant_id, "Tenant");
    const factoryId = requiredUuid(input.factory_id, "Factory");
    const shipmentId = requiredUuid(input.shipment_unit_id, "Shipment");
    const proofReference = requiredText(input.proof_reference, "POD object key", 500, SAFE_OBJECT_KEY);
    const expectedPrefix = "pod/" + tenantId.toLowerCase() + "/" + factoryId.toLowerCase() + "/" + shipmentId.toLowerCase() + "/";
    if (/^https?:/i.test(proofReference) || !proofReference.startsWith(expectedPrefix)
      || proofReference.length <= expectedPrefix.length) {
      throw new Error("POD reference must be an uploaded object key under this shipment's pod storage prefix.");
    }
    const digest = clean(input.proof_sha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("POD SHA-256 digest must contain exactly 64 hexadecimal characters.");
    const signedAt = new Date(input.signed_at);
    if (!input.signed_at || !Number.isFinite(signedAt.getTime())) {
      throw new Error("A valid signed timestamp is required for a delivered event.");
    }
    const eventTime = payload.event_at ? new Date(payload.event_at).getTime() : Date.now();
    if (signedAt.getTime() > eventTime) throw new Error("The proof must be signed no later than the delivery event.");
    payload.recipient_name = recipient;
    payload.proof_type = proofType;
    payload.proof_reference = proofReference;
    payload.proof_sha256 = digest;
    payload.signed_at = signedAt.toISOString();
  }
  return payload;
}

export function fulfillmentStatusLabel(value) {
  const status = clean(value).toUpperCase();
  return status ? status.replaceAll("_", " ") : "UNKNOWN";
}
