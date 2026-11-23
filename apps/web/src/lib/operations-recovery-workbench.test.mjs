import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNotificationAcknowledgePayload,
  buildOperationsDlqQuery,
  buildOperationsInboxQuery,
  filterOperationsDeadLetters,
  filterOperationsNotifications,
  normalizeOperationsRows,
  summarizeOperationsRecovery,
  validateOperationsIdempotencyKey,
} from "./operations-recovery-workbench.mjs";

const factoryId = "faaab63d-c447-46ce-950d-deebdd7f5f30";

test("normalizes inbox and dead-letter list response envelopes", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(normalizeOperationsRows(rows), rows);
  assert.deepEqual(normalizeOperationsRows({ items: rows }), rows);
  assert.deepEqual(normalizeOperationsRows({ entries: rows }, "entries"), rows);
  assert.deepEqual(normalizeOperationsRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeOperationsRows(undefined), []);
});

test("builds default and status-filtered notification inbox queries", () => {
  assert.equal(buildOperationsInboxQuery(), "?limit=100");
  const unread = new URLSearchParams(buildOperationsInboxQuery(50, "unread").slice(1));
  assert.equal(unread.get("limit"), "50");
  assert.equal(unread.get("status"), "UNREAD");
  const acknowledged = new URLSearchParams(buildOperationsInboxQuery(200, "ACKNOWLEDGED").slice(1));
  assert.equal(acknowledged.get("status"), "ACKNOWLEDGED");
});

test("rejects invalid notification status and limits outside API bounds", () => {
  assert.throws(() => buildOperationsInboxQuery(0), /positive whole number/);
  assert.throws(() => buildOperationsInboxQuery(201), /no greater than 200/);
  assert.throws(() => buildOperationsInboxQuery(10, "PENDING"), /UNREAD or ACKNOWLEDGED/);
});

test("builds factory-scoped outbox DLQ query with bounded pagination", () => {
  const query = new URLSearchParams(buildOperationsDlqQuery(factoryId, 50, 100, "outbox").slice(1));
  assert.equal(query.get("factory_id"), factoryId);
  assert.equal(query.get("limit"), "50");
  assert.equal(query.get("offset"), "100");
  const bus = new URLSearchParams(buildOperationsDlqQuery(factoryId, 200, 0, "broker").slice(1));
  assert.equal(bus.get("limit"), "200");
});

test("rejects invalid factory identifiers, pagination and queue kind", () => {
  assert.throws(() => buildOperationsDlqQuery("factory-a"), /valid UUID/);
  assert.throws(() => buildOperationsDlqQuery(factoryId, 101, 0, "outbox"), /no greater than 100/);
  assert.throws(() => buildOperationsDlqQuery(factoryId, 201, 0, "broker"), /no greater than 200/);
  assert.throws(() => buildOperationsDlqQuery(factoryId, 50, -1, "broker"), /between 0 and 1000000/);
  assert.throws(() => buildOperationsDlqQuery(factoryId, 50, 0, "unknown"), /outbox or broker/);
});

test("builds acknowledgement payload using the exact optimistic row version", () => {
  assert.deepEqual(buildNotificationAcknowledgePayload("7", "Reviewed the alert and contacted the responsible owner."), {
    expected_version: 7,
    reason: "Reviewed the alert and contacted the responsible owner.",
  });
});

test("rejects stale or malformed notification versions and acknowledgement reasons", () => {
  assert.throws(() => buildNotificationAcknowledgePayload(0, "Done"), /positive whole number/);
  assert.throws(() => buildNotificationAcknowledgePayload("1.5", "Done"), /positive whole number/);
  assert.throws(() => buildNotificationAcknowledgePayload("2", "  "), /1 to 2000/);
  assert.throws(() => buildNotificationAcknowledgePayload("2", "x".repeat(2001)), /1 to 2000/);
});

test("validates fresh idempotency keys for controlled replay actions", () => {
  assert.equal(validateOperationsIdempotencyKey("recovery:123"), "recovery:123");
  assert.throws(() => validateOperationsIdempotencyKey(""), /visible ASCII/);
  assert.throws(() => validateOperationsIdempotencyKey("bad key with spaces"), /visible ASCII/);
  assert.throws(() => validateOperationsIdempotencyKey("x".repeat(201)), /visible ASCII/);
});

test("summarizes unread, acknowledged and dead-letter recovery states", () => {
  assert.deepEqual(summarizeOperationsRecovery(
    [{ status: "UNREAD", action_required: true }, { status: "ACKNOWLEDGED" }],
    [{ status: "QUARANTINED" }],
    [{ status: "QUARANTINED" }, { status: "REDRIVE_PENDING" }, { status: "REDRIVEN" }],
  ), {
    unreadNotifications: 1,
    actionRequired: 1,
    acknowledgedNotifications: 1,
    quarantinedEvents: 1,
    brokerQuarantined: 1,
    brokerRedrivePending: 1,
    brokerRedriven: 1,
  });
});

test("filters notifications by severity and searchable safe summary fields", () => {
  const rows = [
    { id: "1", title: "Utility threshold exceeded", body: "Observed 91 kWh", severity: "HIGH", status: "UNREAD" },
    { id: "2", title: "EHS drill changed", body: "Review updated drill", severity: "MEDIUM", status: "ACKNOWLEDGED" },
  ];
  assert.deepEqual(filterOperationsNotifications(rows, "utility").map((row) => row.id), ["1"]);
  assert.deepEqual(filterOperationsNotifications(rows, "", "MEDIUM").map((row) => row.id), ["2"]);
});

test("filters dead letters on event metadata and not raw payload or error internals", () => {
  const rows = [
    { id: "1", event_type: "WMS.SHIPMENT_DISPATCHED", consumer_name: "shipment-projection", payload: { secret: "hidden" } },
    { id: "2", event_type: "FINANCE.PERIOD_CLOSED", consumer_name: "finance-projection" },
  ];
  assert.deepEqual(filterOperationsDeadLetters(rows, "shipment").map((row) => row.id), ["1"]);
  assert.deepEqual(filterOperationsDeadLetters(rows, "hidden"), []);
});

