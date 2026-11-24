import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEdgeCredentialPayload,
  buildEdgeDevicePayload,
  buildEdgePackageControlPayload,
  buildEdgeSigningKeyPayload,
  buildEdgeSigningKeyRevocationPayload,
  filterEdgeDevices,
  isEdgeUuid,
  normalizeEdgeRows,
  safeEdgePayloadPreview,
  summarizeEdgeDevices,
} from "./edge-device-workbench.mjs";

const validDevice = {
  device_key: "LINE-01-GATEWAY",
  display_name: "Line 01 Edge Gateway",
  protocol: "OPC_UA",
  device_group: "PACKAGING_LINE",
  capability_profile: JSON.stringify({ signals: ["temperature", "line.speed"], supportsBufferedSync: true }),
};

test("normalizes edge collection responses including nested envelopes", () => {
  const rows = [{ id: "a" }];
  assert.deepEqual(normalizeEdgeRows(rows), rows);
  assert.deepEqual(normalizeEdgeRows({ devices: rows }, "devices"), rows);
  assert.deepEqual(normalizeEdgeRows({ items: rows }), rows);
  assert.deepEqual(normalizeEdgeRows({ data: { rows } }), rows);
  assert.deepEqual(normalizeEdgeRows(null), []);
});

test("builds a bounded device registration payload", () => {
  const payload = buildEdgeDevicePayload(validDevice);
  assert.equal(payload.device_key, "LINE-01-GATEWAY");
  assert.equal(payload.display_name, "Line 01 Edge Gateway");
  assert.deepEqual(payload.capability_profile, { signals: ["temperature", "line.speed"], supportsBufferedSync: true });
  assert.equal(Object.hasOwn(payload, "tenant_id"), false);
  assert.equal(Object.hasOwn(payload, "factory_id"), false);
});

test("rejects malformed device identifiers and protocol values", () => {
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, device_key: "bad key" }), /canonical identifier/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, display_name: "x" }), /2 to 180/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, protocol: "HTTP" }), /Choose OPC_UA/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, device_group: "group with spaces" }), /unsupported characters/);
});

test("rejects unsafe capability fields and oversized capability documents", () => {
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, capability_profile: { access_token: "should-not-be-sent" } }), /credential-like field/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, capability_profile: { constructor: "unsafe" } }), /unsafe/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, capability_profile: { signals: [{ nested: { refresh_token: "hidden" } }] } }), /credential-like field/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, capability_profile: "[]" }), /JSON object/);
  assert.throws(() => buildEdgeDevicePayload({ ...validDevice, capability_profile: { description: "x".repeat(5000) } }), /4 KiB/);
});

test("bounds credential validity to the server contract", () => {
  assert.deepEqual(buildEdgeCredentialPayload("90"), { valid_for_days: 90 });
  assert.throws(() => buildEdgeCredentialPayload(0), /1 and 366/);
  assert.throws(() => buildEdgeCredentialPayload(367), /1 and 366/);
  assert.throws(() => buildEdgeCredentialPayload(1.5), /1 and 366/);
});

test("requires a public PEM signing key and rejects private key material", () => {
  const pem = "-----BEGIN PUBLIC KEY-----\n" + "A".repeat(96) + "\n-----END PUBLIC KEY-----";
  assert.deepEqual(buildEdgeSigningKeyPayload({ key_id: "factory-edge-2026", public_key_pem: pem }), {
    key_id: "factory-edge-2026", public_key_pem: pem,
  });
  assert.throws(() => buildEdgeSigningKeyPayload({ key_id: "bad id", public_key_pem: pem }), /canonical identifier/);
  assert.throws(() => buildEdgeSigningKeyPayload({ key_id: "key", public_key_pem: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----" }), /public key only/);
  assert.throws(() => buildEdgeSigningKeyPayload({ key_id: "key", public_key_pem: pem, replaces_key_id: "key" }), /cannot replace itself/);
});

test("builds package controls only for valid scope, action and reason", () => {
  assert.deepEqual(buildEdgePackageControlPayload({
    package_id: "edge-runtime", package_version: "2.1.0",
    target_kind: "FACTORY", target_key: "*", action: "PAUSE",
    reason: "Emergency package pause after signed release validation failure",
  }), {
    package_id: "edge-runtime", package_version: "2.1.0",
    target_kind: "FACTORY", target_key: "*", action: "PAUSE",
    reason: "Emergency package pause after signed release validation failure",
  });
  assert.equal(buildEdgePackageControlPayload({
    package_id: "edge-runtime", target_kind: "DEVICE",
    target_key: "a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9", action: "REVOKE",
    reason: "Permanently revoke this package from the affected device",
  }).target_kind, "DEVICE");
});

test("rejects invalid package control identifiers, target keys, actions and reasons", () => {
  const base = { package_id: "edge-runtime", target_kind: "FACTORY", target_key: "*", action: "PAUSE", reason: "A sufficiently detailed governance reason" };
  assert.throws(() => buildEdgePackageControlPayload({ ...base, package_id: "not valid" }), /canonical identifier/);
  assert.throws(() => buildEdgePackageControlPayload({ ...base, package_version: "two words" }), /supported version/);
  assert.throws(() => buildEdgePackageControlPayload({ ...base, target_key: "factory-01" }), /Factory-wide/);
  assert.throws(() => buildEdgePackageControlPayload({ ...base, target_kind: "DEVICE", target_key: "bad-id" }), /valid device UUID/);
  assert.throws(() => buildEdgePackageControlPayload({ ...base, action: "DELETE" }), /PAUSE, RESUME or REVOKE/);
  assert.throws(() => buildEdgePackageControlPayload({ ...base, reason: "short" }), /8 to 300/);
});

test("builds signing-key revocation reasons with a mandatory rationale", () => {
  assert.deepEqual(buildEdgeSigningKeyRevocationPayload("Compromised signing key confirmed by incident response"), {
    reason: "Compromised signing key confirmed by incident response",
  });
  assert.throws(() => buildEdgeSigningKeyRevocationPayload("short"), /8 to 300/);
});

test("filters devices by safe visible metadata without inspecting capability values", () => {
  const rows = [
    { id: "1", displayName: "Line 01 Gateway", deviceKey: "LINE-01", deviceGroup: "PACKAGING", protocol: "OPC_UA", status: "ACTIVE", capabilityProfile: { hidden: "not searched" } },
    { id: "2", displayName: "Boiler Sensor", deviceKey: "BOILER-03", protocol: "MQTT", status: "PAUSED" },
  ];
  assert.deepEqual(filterEdgeDevices(rows, "line").map((row) => row.id), ["1"]);
  assert.deepEqual(filterEdgeDevices(rows, "", "PAUSED").map((row) => row.id), ["2"]);
  assert.deepEqual(filterEdgeDevices(rows, "", "ALL", "MQTT").map((row) => row.id), ["2"]);
  assert.deepEqual(filterEdgeDevices(rows, "not searched"), []);
});

test("summarizes device status and latest health separately", () => {
  assert.deepEqual(summarizeEdgeDevices([
    { status: "ACTIVE", lastSeenAt: "2026-11-24", latestHealth: { runtimeStatus: "HEALTHY" } },
    { status: "ACTIVE", latestHealth: { runtimeStatus: "DEGRADED" } },
    { status: "PAUSED", lastSeenAt: null, latestHealth: { runtimeStatus: "NEEDS_ATTENTION" } },
    { status: "REVOKED", lastSeenAt: null },
  ]), { total: 4, active: 2, paused: 1, revoked: 1, healthy: 1, attention: 2, neverSeen: 3 });
});

test("validates UUIDs and returns a redacted payload preview", () => {
  assert.equal(isEdgeUuid("a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9"), true);
  assert.equal(isEdgeUuid("not-a-uuid"), false);
  const preview = safeEdgePayloadPreview({ temperature: 42, access_token: "never display", nested: { token: "hidden" } });
  assert.match(preview, /temperature/);
  assert.doesNotMatch(preview, /never display|access_token/);
});
