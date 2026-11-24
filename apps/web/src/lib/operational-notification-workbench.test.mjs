import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationalNotificationAcknowledgementPayload,
  buildOperationalNotificationInboxQuery,
  createOperationalNotificationClient,
  filterOperationalNotifications,
  normalizeOperationalNotificationRows,
  summarizeOperationalNotifications,
} from "./operational-notification-workbench.mjs";

const id = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d27";
const records = [
  { id, title: "Critical utility threshold", body: "Consumption exceeded the limit", category: "UTILITY_THRESHOLD", severity: "CRITICAL", status: "UNREAD", actionRequired: true, rowVersion: 1, aggregateType: "UTILITY_ALERT" },
  { id: "70e1db4f-dc2e-4cab-a3ec-13cc4c744d28", title: "EHS drill completed", body: "Review response", category: "EHS_LIFECYCLE", severity: "HIGH", status: "ACKNOWLEDGED", actionRequired: false, rowVersion: 2 },
];

test("normalizes inbox item envelopes and safely handles invalid responses", () => {
  assert.deepEqual(normalizeOperationalNotificationRows({ items: records }), records);
  assert.deepEqual(normalizeOperationalNotificationRows({ data: { items: records } }), records);
  assert.deepEqual(normalizeOperationalNotificationRows(null), []);
});

test("builds bounded status and page-size query strings", () => {
  assert.equal(buildOperationalNotificationInboxQuery({ limit: 25 }), "?limit=25");
  assert.equal(buildOperationalNotificationInboxQuery({ limit: 200, status: "UNREAD" }), "?limit=200&status=UNREAD");
  assert.throws(() => buildOperationalNotificationInboxQuery({ limit: 201 }), /between 1 and 200/);
  assert.throws(() => buildOperationalNotificationInboxQuery({ status: "DELETED" }), /UNREAD or ACKNOWLEDGED/);
});

test("requires the current row version and a meaningful acknowledgement reason", () => {
  assert.deepEqual(buildOperationalNotificationAcknowledgementPayload({ expected_version: "3", reason: "Reviewed and assigned to facilities owner" }), {
    expected_version: 3,
    reason: "Reviewed and assigned to facilities owner",
  });
  assert.throws(() => buildOperationalNotificationAcknowledgementPayload({ expected_version: 0, reason: "No" }), /expected_version/);
  assert.throws(() => buildOperationalNotificationAcknowledgementPayload({ expected_version: 2, reason: "  " }), /reason/);
  assert.throws(() => buildOperationalNotificationAcknowledgementPayload({ expected_version: 2, reason: "x".repeat(2001) }), /reason/);
});

test("filters by free-text, category, severity and action requirement", () => {
  assert.deepEqual(filterOperationalNotifications(records, { query: "consumption" }), [records[0]]);
  assert.deepEqual(filterOperationalNotifications(records, { category: "EHS_LIFECYCLE" }), [records[1]]);
  assert.deepEqual(filterOperationalNotifications(records, { severity: "CRITICAL", actionOnly: true }), [records[0]]);
  assert.deepEqual(filterOperationalNotifications(records, { query: "not present" }), []);
});

test("summarizes only server-returned inbox records", () => {
  assert.deepEqual(summarizeOperationalNotifications(records), {
    total: 2, unread: 1, acknowledged: 1, actionRequired: 1, critical: 1,
  });
});

test("client uses authenticated factory inbox paths and URL-encodes notification IDs", async () => {
  const calls = [];
  const client = createOperationalNotificationClient(async (path, options) => {
    calls.push({ path, options });
    return { ok: true };
  });
  await client.listInbox({ limit: 50, status: "UNREAD" });
  await client.acknowledge(id, { expected_version: 1, reason: "Reviewed" });
  assert.equal(calls[0].path, "/notifications/inbox?limit=50&status=UNREAD");
  assert.equal(calls[1].path, "/notifications/" + id + "/acknowledge");
  assert.equal(calls[1].options.method, "POST");
  assert.throws(() => client.acknowledge("not-a-uuid", {}), /UUID/);
});
