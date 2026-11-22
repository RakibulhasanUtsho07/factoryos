import test from "node:test";
import assert from "node:assert/strict";
import {
  supportedDeliveryEventTypes,
  asFulfillmentRows,
  buildCreateContainerPayload,
  buildDeliveryEventPayload,
  buildDispatchPayload,
  buildPackingContentPayload,
  filterContainerIdentities,
  filterOutboundShipments,
  summarizeFulfillment,
} from "./wms-fulfillment-workbench.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FACTORY = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const LOCATION = "44444444-4444-4444-8444-444444444444";
const CONTAINER = "55555555-5555-4555-8555-555555555555";
const LOT = "66666666-6666-4666-8666-666666666666";
const SHIPMENT = "77777777-7777-4777-8777-777777777777";
const ORDER = "88888888-8888-4888-8888-888888888888";
const LINE = "99999999-9999-4999-8999-999999999999";

test("normalizes container, shipment and order envelopes", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(asFulfillmentRows(rows), rows);
  assert.deepEqual(asFulfillmentRows({ units: rows }), rows);
  assert.deepEqual(asFulfillmentRows({ shipments: rows }), rows);
  assert.deepEqual(asFulfillmentRows({ items: rows }), rows);
  assert.deepEqual(asFulfillmentRows({ events: rows }), rows);
  assert.deepEqual(asFulfillmentRows(null), []);
});

test("summarizes cartons, pallets and delivery pipeline without claiming delivery", () => {
  const result = summarizeFulfillment(
    [{ unit_type: "CARTON" }, { unit_type: "PALLET" }, { unit_type: "CARTON" }],
    [
      { latest_delivery_event_type: null },
      { latest_delivery_event_type: "IN_TRANSIT" },
      { latest_delivery_event_type: "OUT_FOR_DELIVERY" },
      { latest_delivery_event_type: "DELIVERY_FAILED" },
      { latest_delivery_event_type: "DELIVERED" },
      { latest_delivery_event_type: "RETURNED" },
    ],
  );
  assert.deepEqual(result, {
    containers: 3, cartons: 2, pallets: 1, shipments: 6,
    awaitingUpdate: 1, inTransit: 2, deliveryFailed: 1, delivered: 1, returned: 1,
  });
});

test("filters containers by identity, type and search text", () => {
  const rows = [
    { unit_code: "CARTON-01", unit_type: "CARTON", status: "ACTIVE" },
    { unit_code: "PALLET-01", unit_type: "PALLET", status: "ACTIVE" },
  ];
  assert.deepEqual(filterContainerIdentities(rows, "carton"), [rows[0]]);
  assert.deepEqual(filterContainerIdentities(rows, "", "PALLET"), [rows[1]]);
});

test("filters outbound shipments by customer, tracking reference and latest event", () => {
  const rows = [
    { shipment_code: "SHP-01", customer_name: "Acme", tracking_reference: "TRK-9", latest_delivery_event_type: "IN_TRANSIT" },
    { shipment_code: "SHP-02", customer_name: "North", tracking_reference: "TRK-10", latest_delivery_event_type: "DELIVERED" },
  ];
  assert.deepEqual(filterOutboundShipments(rows, "acme"), [rows[0]]);
  assert.deepEqual(filterOutboundShipments(rows, "", "DELIVERED"), [rows[1]]);
  assert.deepEqual(filterOutboundShipments(rows, "trk-10"), [rows[1]]);
});

test("builds CARTON and PALLET container payloads with uppercase governed codes", () => {
  assert.deepEqual(buildCreateContainerPayload({
    container_type: "carton", container_code: " carton-01 ", item_id: ITEM,
    location_id: LOCATION, capacity_quantity: "12.5000",
  }), {
    container_type: "CARTON", container_code: "CARTON-01",
    item_id: ITEM, location_id: LOCATION, capacity_quantity: 12.5,
  });
  assert.equal(buildCreateContainerPayload({
    container_type: "PALLET", container_code: "PLT-01", item_id: ITEM,
    location_id: LOCATION, capacity_quantity: "100",
  }).container_type, "PALLET");
});

test("rejects invalid container codes, identifiers, zero and over-precision capacity", () => {
  for (const input of [
    { container_type: "BOX", container_code: "C1", item_id: ITEM, location_id: LOCATION, capacity_quantity: "1" },
    { container_type: "CARTON", container_code: "invalid code", item_id: ITEM, location_id: LOCATION, capacity_quantity: "1" },
    { container_type: "CARTON", container_code: "C1", item_id: "bad", location_id: LOCATION, capacity_quantity: "1" },
    { container_type: "CARTON", container_code: "C1", item_id: ITEM, location_id: LOCATION, capacity_quantity: "0" },
    { container_type: "CARTON", container_code: "C1", item_id: ITEM, location_id: LOCATION, capacity_quantity: "1.00001" },
  ]) assert.throws(() => buildCreateContainerPayload(input));
});

test("builds carton contents only from an active finished-good LOT for the same item", () => {
  assert.deepEqual(buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: LOT, container_type: "CARTON",
    item_id: ITEM, quantity: "2.125",
    source_unit: { unit_type: "LOT", product_role: "FINISHED_GOOD", status: "ACTIVE", inventory_item_id: ITEM },
  }), { source_unit_id: LOT, quantity: 2.125 });
  assert.throws(() => buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: LOT, container_type: "CARTON", item_id: ITEM, quantity: "1",
    source_unit: { unit_type: "LOT", product_role: "MATERIAL", status: "ACTIVE", inventory_item_id: ITEM },
  }));
});

test("builds pallet content only from a sealed same-item same-location carton in full quantity", () => {
  assert.deepEqual(buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: LOT, container_type: "PALLET",
    item_id: ITEM, location_id: LOCATION, quantity: "10.0000",
    source_container: { container_type: "CARTON", status: "SEALED", item_id: ITEM, location_id: LOCATION, packed_quantity: "10.0000" },
  }), { source_unit_id: LOT, quantity: 10 });
  assert.throws(() => buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: LOT, container_type: "PALLET",
    item_id: ITEM, location_id: LOCATION, quantity: "9",
    source_container: { container_type: "CARTON", status: "SEALED", item_id: ITEM, location_id: LOCATION, packed_quantity: "10" },
  }));
  assert.throws(() => buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: LOT, container_type: "PALLET",
    item_id: ITEM, location_id: LOCATION, quantity: "10",
    source_container: { container_type: "CARTON", status: "OPEN", item_id: ITEM, location_id: LOCATION, packed_quantity: "10" },
  }));
});

test("prevents a packing container from containing itself and invalid precision", () => {
  assert.throws(() => buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: CONTAINER, container_type: "CARTON",
    item_id: ITEM, quantity: "1",
    source_unit: { unit_type: "LOT", product_role: "FINISHED_GOOD", status: "ACTIVE", inventory_item_id: ITEM },
  }));
  assert.throws(() => buildPackingContentPayload({
    container_unit_id: CONTAINER, source_unit_id: LOT, container_type: "CARTON",
    item_id: ITEM, quantity: "1.00001",
    source_unit: { unit_type: "LOT", product_role: "FINISHED_GOOD", status: "ACTIVE", inventory_item_id: ITEM },
  }));
});

test("builds dispatch payloads with carrier pair and optional order-line binding", () => {
  assert.deepEqual(buildDispatchPayload({
    shipment_code: " ship-100 ", customer_name: "Acme Ltd",
    customer_order_reference: "PO-100", carrier_name: "Carrier", tracking_reference: "TRK-100",
    order_id: ORDER, order_line_id: LINE,
  }), {
    shipment_code: "SHIP-100", customer_name: "Acme Ltd",
    customer_order_reference: "PO-100", carrier_name: "Carrier", tracking_reference: "TRK-100",
    order_id: ORDER, order_line_id: LINE,
  });
});

test("rejects incomplete dispatch details, carrier pair and order pair", () => {
  const base = { shipment_code: "S1", customer_name: "Acme", customer_order_reference: "PO1" };
  assert.throws(() => buildDispatchPayload({ ...base, carrier_name: "DHL" }));
  assert.throws(() => buildDispatchPayload({ ...base, order_id: ORDER }));
  assert.throws(() => buildDispatchPayload({ ...base, shipment_code: "BAD CODE" }));
  assert.throws(() => buildDispatchPayload({ ...base, customer_name: " " }));
});

test("exposes exactly the event types supported by the delivery API without inventing sequence enforcement", () => {
  assert.deepEqual(supportedDeliveryEventTypes(), [
    "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_FAILED", "DELIVERED", "RETURNED",
  ]);
});

test("builds non-terminal delivery tracking events without proof fields", () => {
  assert.deepEqual(buildDeliveryEventPayload({
    event_type: "in_transit", previous_event_type: null, notes: "Carrier pickup complete",
  }), { event_type: "IN_TRANSIT", notes: "Carrier pickup complete" });
  assert.throws(() => buildDeliveryEventPayload({
    event_type: "RETURNED", previous_event_type: "DELIVERED",
  }));
});

test("requires a shipment-scoped uploaded object reference, digest and recipient for DELIVERED", () => {
  const prefix = "pod/" + TENANT + "/" + FACTORY + "/" + SHIPMENT + "/proof.bin";
  const valid = buildDeliveryEventPayload({
    event_type: "DELIVERED", previous_event_type: "OUT_FOR_DELIVERY",
    tenant_id: TENANT, factory_id: FACTORY, shipment_unit_id: SHIPMENT,
    recipient_name: "Receiving desk", proof_type: "DOCUMENT",
    proof_reference: prefix, proof_sha256: "a".repeat(64),
    signed_at: "2026-11-22T11:00:00.000Z",
  });
  assert.equal(valid.event_type, "DELIVERED");
  assert.equal(valid.proof_reference, prefix);
  assert.equal(valid.proof_sha256, "a".repeat(64));
  assert.throws(() => buildDeliveryEventPayload({
    event_type: "DELIVERED", previous_event_type: "IN_TRANSIT",
    tenant_id: TENANT, factory_id: FACTORY, shipment_unit_id: SHIPMENT,
    recipient_name: "Receiver", proof_type: "PHOTO",
    proof_reference: "https://example.com/proof.jpg", proof_sha256: "a".repeat(64),
    signed_at: "2026-11-22T11:00:00.000Z",
  }));
  assert.throws(() => buildDeliveryEventPayload({
    event_type: "DELIVERED", previous_event_type: "IN_TRANSIT",
    tenant_id: TENANT, factory_id: FACTORY, shipment_unit_id: SHIPMENT,
    recipient_name: "Receiver", proof_type: "PHOTO",
    proof_reference: prefix, proof_sha256: "bad", signed_at: "2026-11-22T11:00:00.000Z",
  }));
});

test("rejects oversized shipment notes and unsupported POD proof types", () => {
  assert.throws(() => buildDeliveryEventPayload({
    event_type: "IN_TRANSIT", previous_event_type: null, notes: "x".repeat(2001),
  }));
  assert.throws(() => buildDeliveryEventPayload({
    event_type: "DELIVERED", previous_event_type: null,
    tenant_id: TENANT, factory_id: FACTORY, shipment_unit_id: SHIPMENT,
    recipient_name: "Receiver", proof_type: "EMAIL",
    proof_reference: "pod/" + TENANT + "/" + FACTORY + "/" + SHIPMENT + "/file",
    proof_sha256: "a".repeat(64), signed_at: "2026-11-22T11:00:00.000Z",
  }));
});
