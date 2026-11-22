import test from "node:test";
import assert from "node:assert/strict";
import {
  asTraceabilityRows,
  buildRecallAcknowledgementPayload,
  buildRecallDeclarationPayload,
  buildRecallNotificationIntentPayload,
  buildTraceabilityStatusPayload,
  summarizeTraceabilityUnits,
  traceabilityStatusLabel,
  traceabilityUnitTypeLabel,
} from "./traceability-workbench.mjs";

const now = Date.now();
const future = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();

test("normalizes traceability unit, event and notification envelopes", () => {
  const units = [{ id: "one" }];
  assert.deepEqual(asTraceabilityRows(units), units);
  assert.deepEqual(asTraceabilityRows({ units }), units);
  assert.deepEqual(asTraceabilityRows({ events: units }, "events"), units);
  assert.deepEqual(asTraceabilityRows({ items: units }, "items"), units);
  assert.deepEqual(asTraceabilityRows(null), []);
});

test("summarizes lifecycle, LOT/SERIAL and expiring identities", () => {
  const result = summarizeTraceabilityUnits([
    { status: "ACTIVE", unit_type: "LOT", expires_at: future },
    { status: "RECALLED", unit_type: "SERIAL" },
    { status: "QUARANTINED", unit_type: "LOT" },
    { status: "SHIPPED", unit_type: "SHIPMENT" },
    { status: "DISPOSED", unit_type: "SERIAL" },
  ]);
  assert.deepEqual(result, {
    total: 5, active: 1, quarantined: 1, recalled: 1, shipped: 1,
    disposed: 1, lots: 2, serials: 2, expiringSoon: 1,
  });
});

test("builds a bounded recall declaration payload", () => {
  assert.deepEqual(buildRecallDeclarationPayload({ reason: "Supplier contamination", depth: "6", limit: "250" }), {
    reason: "Supplier contamination", depth: 6, limit: 250,
  });
});

test("rejects empty or oversized recall reasons and out-of-range graph bounds", () => {
  for (const input of [
    { reason: " ", depth: 5, limit: 100 },
    { reason: "x".repeat(1801), depth: 5, limit: 100 },
    { reason: "valid", depth: 0, limit: 100 },
    { reason: "valid", depth: 13, limit: 100 },
    { reason: "valid", depth: 5, limit: 501 },
    { reason: "valid", depth: 2.5, limit: 100 },
  ]) assert.throws(() => buildRecallDeclarationPayload(input));
});

test("builds safe customer/site notification intents without contact data", () => {
  assert.deepEqual(buildRecallNotificationIntentPayload({
    recipient_type: "customer", recipient_reference: "CUST-ACME/01",
    channel: "portal", reason: "Affected finished-goods lot",
  }), {
    recipient_type: "CUSTOMER", recipient_reference: "CUST-ACME/01",
    channel: "PORTAL", reason: "Affected finished-goods lot",
  });
});

test("rejects URLs and malformed recipient references", () => {
  for (const value of ["https://example.com", "person@example.com", " ", "bad ref"]) {
    assert.throws(() => buildRecallNotificationIntentPayload({
      recipient_type: "CUSTOMER", recipient_reference: value, channel: "EMAIL",
    }));
  }
});

test("rejects unsupported recipient types and channels", () => {
  assert.throws(() => buildRecallNotificationIntentPayload({
    recipient_type: "SUPPLIER", recipient_reference: "SUP-01", channel: "EMAIL",
  }));
  assert.throws(() => buildRecallNotificationIntentPayload({
    recipient_type: "SITE", recipient_reference: "SITE-01", channel: "SMS",
  }));
});

test("builds an operator-reported acknowledgement payload", () => {
  assert.deepEqual(buildRecallAcknowledgementPayload({
    outcome: "ACTION_COMPLETED", notes: "Customer confirmed action",
    evidence_reference: "CASE-REF-2026-01",
  }), {
    outcome: "ACTION_COMPLETED", notes: "Customer confirmed action",
    evidence_reference: "CASE-REF-2026-01",
  });
});

test("rejects unsupported acknowledgement outcomes, unsafe evidence URLs and oversized notes", () => {
  assert.throws(() => buildRecallAcknowledgementPayload({ outcome: "DELIVERED" }));
  assert.throws(() => buildRecallAcknowledgementPayload({
    outcome: "RECEIVED", evidence_reference: "https://evidence.example/x",
  }));
  assert.throws(() => buildRecallAcknowledgementPayload({
    outcome: "RECEIVED", notes: "x".repeat(1801),
  }));
});

test("builds governed status transitions and validates reason bounds", () => {
  assert.deepEqual(buildTraceabilityStatusPayload({
    target_status: "quarantined", reason: "Quality review pending",
  }), { target_status: "QUARANTINED", reason: "Quality review pending" });
  assert.throws(() => buildTraceabilityStatusPayload({ target_status: "UNKNOWN", reason: "x" }));
  assert.throws(() => buildTraceabilityStatusPayload({ target_status: "ACTIVE", reason: " " }));
  assert.throws(() => buildTraceabilityStatusPayload({ target_status: "ACTIVE", reason: "x".repeat(2001) }));
});

test("provides stable labels for lifecycle statuses and identity types", () => {
  assert.equal(traceabilityStatusLabel("QUARANTINED"), "QUARANTINED");
  assert.equal(traceabilityUnitTypeLabel("FINISHED_GOOD"), "FINISHED GOOD");
});
