import test from "node:test";
import assert from "node:assert/strict";

import {
  asWarehouseRows,
  buildLocationTransferPayload,
  filterWarehouseTransfers,
  summarizeWarehouseOperations,
  warehousePurposeLabel,
} from "./warehouse-operations.mjs";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const UNIT = "33333333-3333-4333-8333-333333333333";

const items = [
  { id: "a", status: "ACTIVE" },
  { id: "b", status: "INACTIVE" },
];
const sources = [
  { quantity_available: "7.2500", quantity_reserved: "2.0000" },
  { quantity_available: "1.5000", quantity_reserved: "0.5000" },
];
const transfers = [
  { id: "t1", movement_purpose: "PUT_AWAY", source_location_code: "STAGE-A", destination_location_code: "BIN-01", notes: "receipt put away" },
  { id: "t2", movement_purpose: "PICK", source_location_code: "BIN-01", destination_location_code: "STAGE-PICK", notes: "line supply" },
  { id: "t3", movement_purpose: "TRANSFER", source_location_code: "BIN-01", destination_location_code: "BIN-02", notes: "re-slot" },
];

test("normalizes raw arrays and common API collection envelopes", () => {
  assert.deepEqual(asWarehouseRows(items, "items"), items);
  assert.deepEqual(asWarehouseRows({ items }, "items"), items);
  assert.deepEqual(asWarehouseRows({ locations: items }, "locations"), items);
  assert.deepEqual(asWarehouseRows({ targets: items }, "targets"), items);
  assert.deepEqual(asWarehouseRows(null, "items"), []);
});

test("summarizes active materials, candidate bins, bin quantities and transfer purposes", () => {
  assert.deepEqual(summarizeWarehouseOperations(items, [{ id: "bin1" }], sources, transfers), {
    activeItems: 1,
    putawayTargets: 1,
    pickSources: 2,
    availableAtBins: 8.75,
    reservedAtBins: 2.5,
    recentTransfers: 3,
    putawayMoves: 1,
    pickMoves: 1,
  });
});

test("filters transfer history by purpose and searchable location labels", () => {
  assert.equal(filterWarehouseTransfers(transfers, "", "PUT_AWAY").length, 1);
  assert.equal(filterWarehouseTransfers(transfers, "bin-01").length, 3);
  assert.equal(filterWarehouseTransfers(transfers, "line supply", "PICK").length, 1);
  assert.equal(filterWarehouseTransfers(transfers, "missing").length, 0);
});

test("builds a normalized put-away transfer payload", () => {
  assert.deepEqual(buildLocationTransferPayload({
    movement_purpose: "PUT_AWAY",
    source_location_id: SOURCE,
    destination_location_id: TARGET,
    quantity: "12.3400",
    notes: "  GRN 104 put away ",
  }), {
    movement_purpose: "PUT_AWAY",
    source_location_id: SOURCE,
    destination_location_id: TARGET,
    quantity: 12.34,
    notes: "GRN 104 put away",
  });
});

test("builds a picking payload and preserves a selected LOT/SERIAL identity", () => {
  assert.deepEqual(buildLocationTransferPayload({
    movement_purpose: "PICK",
    source_location_id: SOURCE,
    destination_location_id: TARGET,
    quantity: "1.0000",
    traceability_unit_id: UNIT,
  }), {
    movement_purpose: "PICK",
    source_location_id: SOURCE,
    destination_location_id: TARGET,
    quantity: 1,
    traceability_unit_id: UNIT,
  });
});

test("builds internal transfer payloads with a purpose and notes", () => {
  assert.equal(buildLocationTransferPayload({
    movement_purpose: "TRANSFER",
    source_location_id: SOURCE,
    destination_location_id: TARGET,
    quantity: "0.0001",
  }).quantity, 0.0001);
});

test("rejects zero, negative, malformed and over-precision quantities", () => {
  for (const quantity of ["0", "-1", "1.00001", "1e3", ""]) {
    assert.throws(() => buildLocationTransferPayload({
      movement_purpose: "PICK", source_location_id: SOURCE,
      destination_location_id: TARGET, quantity,
    }));
  }
});

test("rejects unsupported purposes and same or invalid locations", () => {
  assert.throws(() => buildLocationTransferPayload({
    movement_purpose: "RECEIPT", source_location_id: SOURCE,
    destination_location_id: TARGET, quantity: "1",
  }), /Choose put-away/);
  assert.throws(() => buildLocationTransferPayload({
    movement_purpose: "PICK", source_location_id: SOURCE,
    destination_location_id: SOURCE, quantity: "1",
  }), /must differ/);
  assert.throws(() => buildLocationTransferPayload({
    movement_purpose: "PICK", source_location_id: "bad",
    destination_location_id: TARGET, quantity: "1",
  }), /valid source/);
});

test("validates traceability UUID and bounded notes", () => {
  assert.throws(() => buildLocationTransferPayload({
    movement_purpose: "PICK", source_location_id: SOURCE,
    destination_location_id: TARGET, quantity: "1", traceability_unit_id: "bad",
  }), /valid UUID/);
  assert.throws(() => buildLocationTransferPayload({
    movement_purpose: "PICK", source_location_id: SOURCE,
    destination_location_id: TARGET, quantity: "1", notes: "x".repeat(1001),
  }), /1000 characters/);
});

test("labels each supported warehouse movement purpose", () => {
  assert.equal(warehousePurposeLabel("PUT_AWAY"), "Put-away");
  assert.equal(warehousePurposeLabel("PICK"), "Picking");
  assert.equal(warehousePurposeLabel("TRANSFER"), "Internal transfer");
});
