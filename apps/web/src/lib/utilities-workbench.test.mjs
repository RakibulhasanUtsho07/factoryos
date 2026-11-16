import assert from "node:assert/strict";
import test from "node:test";

import {
  createUtilitiesWorkbenchClient,
  utilitiesAlertStatuses,
  utilitiesEventStatuses,
  utilitiesMeterStatuses,
  utilitiesTypes,
} from "./utilities-workbench.mjs";

const METER_ID = "123e4567-e89b-42d3-a456-426614174000";

function createClient() {
  const calls = [];
  const client = createUtilitiesWorkbenchClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { accepted: true };
    },
  });
  return { client, calls };
}

test("meter register delegates exact filters and a bounded limit to the shared session", async () => {
  const { client, calls } = createClient();
  const result = await client.listMeters({
    limit: 75,
    utilityType: "electricity",
    status: "active",
  });

  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [{
    path: "/utilities/meters?limit=75&utility_type=ELECTRICITY&status=ACTIVE",
    options: {},
  }]);
  assert.deepEqual(utilitiesTypes, [
    "ELECTRICITY", "GAS", "STEAM", "WATER", "COMPRESSED_AIR", "FUEL", "OTHER",
  ]);
  assert.deepEqual(utilitiesMeterStatuses, ["ACTIVE", "INACTIVE", "RETIRED"]);
});

test("meter readings use the exact meter route with ordered ISO date filters", async () => {
  const { client, calls } = createClient();
  await client.listReadings({
    meterId: METER_ID.toUpperCase(),
    limit: 80,
    from: "2026-10-01",
    to: "2026-11-16",
  });

  assert.deepEqual(calls, [{
    path: "/utilities/meters/" + METER_ID + "/readings?limit=80&from=2026-10-01&to=2026-11-16",
    options: {},
  }]);
});

test("utility events use only backend-supported statuses", async () => {
  const { client, calls } = createClient();
  await client.listEvents({ limit: 90, status: "acknowledged" });

  assert.equal(calls[0].path, "/utilities/events?limit=90&status=ACKNOWLEDGED");
  assert.deepEqual(utilitiesEventStatuses, ["OPEN", "ACKNOWLEDGED", "RESOLVED", "CANCELLED"]);
});

test("alert center loads alerts and policy register through separate GET routes", async () => {
  const { client, calls } = createClient();
  await client.listThresholdAlerts({ status: "OPEN" });
  await client.listThresholdPolicies();

  assert.deepEqual(calls, [
    { path: "/utilities/threshold-alerts?limit=100&status=OPEN", options: {} },
    { path: "/utilities/threshold-policies?limit=100", options: {} },
  ]);
  assert.deepEqual(utilitiesAlertStatuses, ["OPEN", "ACKNOWLEDGED", "RESOLVED", "CANCELLED"]);
});

test("source bindings use a bounded factory-scoped read route", async () => {
  const { client, calls } = createClient();
  await client.listSourceBindings({ limit: 65 });

  assert.deepEqual(calls, [{
    path: "/utilities/source-bindings?limit=65",
    options: {},
  }]);
});

test("invalid meter/event/alert enums reject before any request", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listMeters({ utilityType: "SOLAR" }), /Utility type/i);
  await assert.rejects(client.listMeters({ status: "DELETED" }), /Meter status/i);
  await assert.rejects(client.listEvents({ status: "PENDING" }), /Utility event status/i);
  await assert.rejects(client.listThresholdAlerts({ status: "PENDING" }), /Threshold alert status/i);
  assert.equal(calls.length, 0);
});

test("invalid limits reject before any request", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listMeters({ limit: 201 }), /between 1 and 200/i);
  await assert.rejects(client.listReadings({ meterId: METER_ID, limit: 0 }), /between 1 and 200/i);
  await assert.rejects(client.listEvents({ limit: 201 }), /between 1 and 200/i);
  await assert.rejects(client.listThresholdAlerts({ limit: 101 }), /between 1 and 100/i);
  await assert.rejects(client.listThresholdPolicies({ limit: 101 }), /between 1 and 100/i);
  await assert.rejects(client.listSourceBindings({ limit: 101 }), /between 1 and 100/i);
  assert.equal(calls.length, 0);
});

test("reading queries reject malformed IDs, dates and inverted ranges", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listReadings({ meterId: "not-a-uuid" }), /valid UUID/i);
  await assert.rejects(client.listReadings({ meterId: METER_ID, from: "2026-02-30" }), /real calendar date/i);
  await assert.rejects(client.listReadings({
    meterId: METER_ID,
    from: "2026-11-17",
    to: "2026-11-16",
  }), /from must be earlier/i);
  assert.equal(calls.length, 0);
});

test("client requires a shared authenticated session request function", () => {
  assert.throws(
    () => createUtilitiesWorkbenchClient({ request: null }),
    /authenticated.*session/i,
  );
});
