import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthIdentityPayload,
  buildEntitlementPayload,
  buildFeatureFlagPayload,
  buildFlagEvaluationPath,
  buildGovernanceListQuery,
  filterGovernanceRows,
  normalizeGovernanceRows,
  summarizeGovernanceWorkspace,
} from "./tenant-governance-workbench.mjs";

const userId = "7e2e7d1a-8a1b-4d6f-9ab7-5a30b102c8a1";

test("normalizes IAM and admin response envelopes", () => {
  const rows = [{ id: "a" }];
  assert.deepEqual(normalizeGovernanceRows(rows), rows);
  assert.deepEqual(normalizeGovernanceRows({ users: rows }, "users"), rows);
  assert.deepEqual(normalizeGovernanceRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeGovernanceRows(null), []);
});

test("builds bounded tenant user list query", () => {
  assert.equal(buildGovernanceListQuery({ limit: 100 }, "users"), "?limit=100");
  assert.throws(() => buildGovernanceListQuery({ limit: 101 }, "users"), /1 to 100/);
  assert.throws(() => buildGovernanceListQuery({ offset: -1 }, "feature-flags"), /non-negative/);
});

test("builds tenant feature-flag query filters", () => {
  const params = new URLSearchParams(buildGovernanceListQuery({
    key: "wms.rfid", enabled: false, owner: "platform", security_critical: true, limit: 20, offset: 40,
  }, "feature-flags").slice(1));
  assert.equal(params.get("key"), "wms.rfid");
  assert.equal(params.get("enabled"), "false");
  assert.equal(params.get("owner"), "platform");
  assert.equal(params.get("security_critical"), "true");
  assert.equal(params.get("offset"), "40");
});

test("builds entitlement query filters with controlled status", () => {
  const params = new URLSearchParams(buildGovernanceListQuery({
    package: "enterprise", feature_key: "wms.mobile", status: "active",
  }, "entitlements").slice(1));
  assert.equal(params.get("package"), "enterprise");
  assert.equal(params.get("feature_key"), "wms.mobile");
  assert.equal(params.get("status"), "ACTIVE");
  assert.throws(() => buildGovernanceListQuery({ status: "PENDING" }, "entitlements"), /status/);
});

test("builds external auth identity payload only for a valid tenant user UUID", () => {
  assert.deepEqual(buildAuthIdentityPayload({
    user_id: userId, issuer: " https://id.example.com/tenant ", subject: " 00u123 ",
  }), {
    user_id: userId, issuer: "https://id.example.com/tenant", subject: "00u123",
  });
  assert.throws(() => buildAuthIdentityPayload({ user_id: "bad", issuer: "https://id.example", subject: "1" }), /UUID/);
  assert.throws(() => buildAuthIdentityPayload({ user_id: userId, issuer: "", subject: "1" }), /Issuer/);
  assert.throws(() => buildAuthIdentityPayload({ user_id: userId, issuer: "https://id.example", subject: "x".repeat(256) }), /Subject/);
});

test("builds feature flag version and requires explicit enabled state", () => {
  assert.deepEqual(buildFeatureFlagPayload({
    key: "wms.offline-sync", enabled: false, owner: "platform",
    config: "{\"rollout\":\"disabled\"}",
  }), {
    key: "wms.offline-sync", enabled: false, owner: "platform",
    security_critical: false, config: { rollout: "disabled" },
  });
  assert.throws(() => buildFeatureFlagPayload({ key: "flag", owner: "platform" }), /explicitly true or false/);
  assert.throws(() => buildFeatureFlagPayload({ key: "flag", enabled: true, owner: "x".repeat(151) }), /Owner/);
});

test("security-critical feature flag versions require a change reason", () => {
  assert.throws(() => buildFeatureFlagPayload({
    key: "auth.mfa.required", enabled: true, owner: "security", security_critical: true,
  }), /change reason/);
  assert.equal(buildFeatureFlagPayload({
    key: "auth.mfa.required", enabled: true, owner: "security",
    security_critical: true, change_reason: "Enable verified MFA control",
  }).change_reason, "Enable verified MFA control");
});

test("feature flag effective windows must be chronological", () => {
  assert.throws(() => buildFeatureFlagPayload({
    key: "rollout", enabled: true, owner: "platform",
    effective_from: "2026-12-02T10:00:00Z", expires_at: "2026-12-02T09:00:00Z",
  }), /later than effective_from/);
  assert.equal(buildFeatureFlagPayload({
    key: "rollout", enabled: true, owner: "platform",
    effective_from: "2026-12-02T10:00:00+06:00",
    expires_at: "2026-12-02T11:00:00+06:00",
  }).effective_from, "2026-12-02T04:00:00.000Z");
});

test("feature and entitlement config must be valid JSON objects", () => {
  assert.throws(() => buildFeatureFlagPayload({
    key: "flag", enabled: true, owner: "platform", config: "[]",
  }), /JSON object/);
  assert.throws(() => buildEntitlementPayload({
    package: "starter", feature_key: "api.calls", config: "{bad",
  }), /valid JSON/);
});

test("builds immutable entitlement version and enforces numeric limits", () => {
  assert.deepEqual(buildEntitlementPayload({
    package: "enterprise", feature_key: "api.calls", limit_value: "25000", period: "MONTH",
    status: "active", effective_from: "2026-12-01T00:00:00Z",
    effective_to: "2027-01-01T00:00:00Z", config: "{\"burst\":1000}",
  }), {
    package: "enterprise", feature_key: "api.calls", limit_value: 25000, period: "MONTH",
    status: "ACTIVE", effective_from: "2026-12-01T00:00:00.000Z",
    effective_to: "2027-01-01T00:00:00.000Z", config: { burst: 1000 },
  });
  assert.equal(buildEntitlementPayload({
    package: "starter", feature_key: "storage.gb", limit_value: "", status: "DISABLED",
  }).limit_value, undefined);
  assert.throws(() => buildEntitlementPayload({
    package: "starter", feature_key: "storage.gb", limit_value: -1,
  }), /non-negative/);
  assert.throws(() => buildEntitlementPayload({
    package: "starter", feature_key: "storage.gb",
    effective_from: "2026-12-01T00:00:00Z", effective_to: "2026-11-30T00:00:00Z",
  }), /later than effective_from/);
});

test("encodes evaluation key and optional timestamp into tenant API path", () => {
  assert.equal(buildFlagEvaluationPath("wms/labels", "2026-12-01T00:00:00Z"),
    "/admin/v1/feature-flags/wms%2Flabels/evaluate?at=2026-12-01T00%3A00%3A00.000Z");
  assert.equal(buildFlagEvaluationPath("wms.mobile"), "/admin/v1/feature-flags/wms.mobile/evaluate");
});

test("summarizes latest feature-flag versions instead of counting history as active keys", () => {
  assert.deepEqual(summarizeGovernanceWorkspace({
    users: [{}, {}], roles: [{}], permissions: [{}, {}], factories: [{ status: "ACTIVE" }, { status: "INACTIVE" }],
    featureFlags: [
      { key: "a", version: 1, enabled: true, securityCritical: false },
      { key: "a", version: 2, enabled: false, securityCritical: true },
      { key: "b", version: 1, enabled: true, securityCritical: false },
    ],
    entitlements: [{ status: "ACTIVE" }, { status: "DISABLED" }],
  }), {
    users: 2, roles: 1, permissions: 2, activeFactories: 1,
    featureFlagVersions: 3, latestFlags: 2, enabledLatestFlags: 1,
    securityCriticalLatestFlags: 1, activeEntitlements: 1,
  });
});

test("filters governance catalogues by identity and control metadata", () => {
  const rows = [
    { id: "1", email: "a@example.com", display_name: "Alpha User" },
    { id: "2", key: "wms.offline", owner: "warehouse" },
  ];
  assert.deepEqual(filterGovernanceRows(rows, "warehouse").map((row) => row.id), ["2"]);
  assert.deepEqual(filterGovernanceRows(rows, "alpha").map((row) => row.id), ["1"]);
});
