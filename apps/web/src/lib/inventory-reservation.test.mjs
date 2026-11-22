import test from "node:test";
import assert from "node:assert/strict";

import {
  asReservationRows,
  buildCreateReservationPayload,
  buildReservationTransitionPayload,
  filterReservations,
  reservationStatusLabel,
  summarizeReservations,
} from "./inventory-reservation.mjs";

const BIN_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_ID = "22222222-2222-4222-8222-222222222222";

const rows = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "RESERVED",
    quantity: "5.0000",
    remaining_quantity: "3.5000",
    consumed_quantity: "1.0000",
    released_quantity: "0.5000",
    reference_type: "WORK_ORDER",
    reference_id: REFERENCE_ID,
    location_id: BIN_ID,
    notes: "Line 2 issue",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "CONSUMED",
    quantity: "2.0000",
    remaining_quantity: "0.0000",
    consumed_quantity: "2.0000",
    released_quantity: "0.0000",
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    status: "RELEASED",
    quantity: "1.2500",
    remaining_quantity: "0.0000",
    consumed_quantity: "0.0000",
    released_quantity: "1.2500",
  },
];

test("normalizes reservation collection response shapes", () => {
  assert.deepEqual(asReservationRows(rows), rows);
  assert.deepEqual(asReservationRows({ reservations: rows }), rows);
  assert.deepEqual(asReservationRows({ items: rows }), rows);
  assert.deepEqual(asReservationRows({}), []);
});

test("summarizes remaining, consumed, released and partial reservations", () => {
  assert.deepEqual(summarizeReservations(rows), {
    total: 3,
    active: 1,
    partial: 1,
    remainingQuantity: 3.5,
    consumedQuantity: 3,
    releasedQuantity: 1.75,
  });
});

test("filters by lifecycle state and searchable references", () => {
  assert.equal(filterReservations(rows, "", "RESERVED").length, 1);
  assert.equal(filterReservations(rows, "work_order").length, 1);
  assert.equal(filterReservations(rows, REFERENCE_ID).length, 1);
  assert.equal(filterReservations(rows, "not-found").length, 0);
});

test("builds a normalized create payload and omits blank optionals", () => {
  assert.deepEqual(buildCreateReservationPayload({
    quantity: "12.3400",
    reference_type: " work_order ",
    reference_id: REFERENCE_ID,
    location_id: BIN_ID,
    notes: "  allocate to line 2  ",
  }), {
    quantity: 12.34,
    reference_type: "WORK_ORDER",
    reference_id: REFERENCE_ID,
    location_id: BIN_ID,
    notes: "allocate to line 2",
  });
  assert.deepEqual(buildCreateReservationPayload({ quantity: "0.1250" }), { quantity: 0.125 });
});

test("rejects zero, invalid and over-precision reservation quantities", () => {
  assert.throws(() => buildCreateReservationPayload({ quantity: "0" }), /greater than zero/);
  assert.throws(() => buildCreateReservationPayload({ quantity: "1.00001" }), /4 decimal places/);
  assert.throws(() => buildCreateReservationPayload({ quantity: "1e3" }), /4 decimal places/);
});

test("validates optional UUIDs and bounded notes", () => {
  assert.throws(() => buildCreateReservationPayload({ quantity: "1", reference_id: "bad" }), /valid UUID/);
  assert.throws(() => buildCreateReservationPayload({ quantity: "1", location_id: "bad" }), /valid BIN/);
  assert.throws(() => buildCreateReservationPayload({ quantity: "1", notes: "x".repeat(1001) }), /1000 characters/);
  assert.throws(() => buildCreateReservationPayload({ quantity: "1", reference_type: "x".repeat(65) }), /64 characters/);
});

test("consumes the full remaining balance when quantity is left blank", () => {
  assert.deepEqual(buildReservationTransitionPayload({
    target_status: "CONSUMED",
    quantity: "",
    remaining_quantity: "4.2500",
  }), { target_status: "CONSUMED" });
});

test("supports bounded partial consumption at four-decimal precision", () => {
  assert.deepEqual(buildReservationTransitionPayload({
    target_status: "CONSUMED",
    quantity: "1.1250",
    remaining_quantity: "4.2500",
  }), { target_status: "CONSUMED", quantity: 1.125 });
  assert.throws(() => buildReservationTransitionPayload({
    target_status: "CONSUMED",
    quantity: "4.2501",
    remaining_quantity: "4.2500",
  }), /cannot exceed/);
  assert.throws(() => buildReservationTransitionPayload({
    target_status: "CONSUMED",
    quantity: "0",
    remaining_quantity: "4.2500",
  }), /greater than zero/);
});

test("releases the whole remainder without sending an unsupported quantity", () => {
  assert.deepEqual(buildReservationTransitionPayload({
    target_status: "RELEASED",
    quantity: "1",
    remaining_quantity: "4.2500",
  }), { target_status: "RELEASED" });
});

test("labels lifecycle states without inventing additional states", () => {
  assert.equal(reservationStatusLabel("RESERVED"), "Open reservation");
  assert.equal(reservationStatusLabel("CONSUMED"), "Fully consumed");
  assert.equal(reservationStatusLabel("RELEASED"), "Released");
});
