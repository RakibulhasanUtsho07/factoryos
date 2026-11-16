import assert from "node:assert/strict";
import test from "node:test";

import {
  createOtConnectivityClient,
  otDeliveryStatuses,
  otDeviceStatuses,
  otProtocols,
} from "./ot-connectivity-workbench.mjs";

const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";

function createClient() {
  const calls = [];
  const client = createOtConnectivityClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { accepted: true };
    },
  });
  return { client, calls };
}

test("OT device list applies only backend-supported status and protocol filters", async () => {
  const { client, calls } = createClient();
  const result = await client.listDevices({ status: "active", protocol: "opc_ua" });

  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [{
    path: "/ot/devices?status=ACTIVE&protocol=OPC_UA",
    options: {},
  }]);
  assert.deepEqual(otDeviceStatuses, ["PENDING_REVIEW", "ACTIVE", "PAUSED", "REVOKED"]);
  assert.deepEqual(otProtocols, ["OPC_UA", "MQTT", "MODBUS_TCP"]);
});

test("OT device list can request the unfiltered register", async () => {
  const { client, calls } = createClient();
  await client.listDevices();

  assert.deepEqual(calls, [{
    path: "/ot/devices",
    options: {},
  }]);
});

test("device detail and lifecycle history use validated UUID routes", async () => {
  const { client, calls } = createClient();
  await client.getDevice({ deviceId: DEVICE_ID.toUpperCase() });
  await client.listHistory({ deviceId: DEVICE_ID });

  assert.deepEqual(calls, [
    { path: "/ot/devices/" + DEVICE_ID, options: {} },
    { path: "/ot/devices/" + DEVICE_ID + "/history", options: {} },
  ]);
});

test("telemetry query uses the selected device and bounded limit", async () => {
  const { client, calls } = createClient();
  await client.listTelemetry({ deviceId: DEVICE_ID, limit: 150 });

  assert.deepEqual(calls, [{
    path: "/ot/devices/" + DEVICE_ID + "/telemetry?limit=150",
    options: {},
  }]);
  assert.deepEqual(otDeliveryStatuses, ["ON_TIME", "LATE", "SEQUENCE_GAP"]);
});

test("invalid device status and protocol enums reject before requesting", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listDevices({ status: "DISABLED" }), /OT device status/i);
  await assert.rejects(client.listDevices({ protocol: "HTTP" }), /OT protocol/i);
  assert.equal(calls.length, 0);
});

test("all detail routes reject malformed device IDs before requesting", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.getDevice({ deviceId: "not-a-uuid" }), /valid UUID/i);
  await assert.rejects(client.listHistory({ deviceId: "" }), /valid UUID/i);
  await assert.rejects(client.listTelemetry({ deviceId: "invalid" }), /valid UUID/i);
  assert.equal(calls.length, 0);
});

test("telemetry limit rejects zero, fractional and above-backend values", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listTelemetry({ deviceId: DEVICE_ID, limit: 0 }), /between 1 and 200/i);
  await assert.rejects(client.listTelemetry({ deviceId: DEVICE_ID, limit: 200.5 }), /between 1 and 200/i);
  await assert.rejects(client.listTelemetry({ deviceId: DEVICE_ID, limit: 201 }), /between 1 and 200/i);
  assert.equal(calls.length, 0);
});

test("client requires shared authenticated factory-session request delegation", () => {
  assert.throws(
    () => createOtConnectivityClient({ request: null }),
    /authenticated.*session/i,
  );
});
