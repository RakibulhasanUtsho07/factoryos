import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateSandboxPayload,
  buildMaskedApprovalPayload,
  buildSandboxPhysicalPayload,
  buildSandboxTransitionPayload,
  createSaasSandboxClient,
  filterSandboxes,
  normalizePhysicalRunDetail,
  normalizePhysicalRunRows,
  normalizeSandboxEvents,
  normalizeSandboxMutation,
  normalizeSandboxRows,
  summarizeSandboxes,
} from "./saas-sandbox-governance.mjs";

const environmentId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d27";
const physicalRunId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d28";
const checksum = "b".repeat(64);

test("normalizes tenant sandbox and event collections from supported API envelopes", () => {
  const rows = [{ id: environmentId, environmentCode: "DEMO-01" }];
  const events = [{ eventType: "CREATED", environmentVersion: 1 }];
  assert.deepEqual(normalizeSandboxRows(rows), rows);
  assert.deepEqual(normalizeSandboxRows({ items: rows }), rows);
  assert.deepEqual(normalizeSandboxRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeSandboxEvents({ events }), events);
  assert.deepEqual(normalizeSandboxEvents({ data: { items: events } }), events);
  assert.deepEqual(normalizeSandboxRows(null), []);
});

test("normalizes sandbox create and masked approval response envelopes without inventing event", () => {
  const environment = { id: environmentId, status: "ACTIVE", version: 2 };
  const event = { eventType: "MASKED_DATA_APPROVED" };
  assert.deepEqual(normalizeSandboxMutation({ environment, event, replayed: true }), {
    environment, event, replayed: true,
  });
  assert.deepEqual(normalizeSandboxMutation({ data: { environment, event }, replayed: true }), {
    environment, event, replayed: true,
  });
  assert.deepEqual(normalizeSandboxMutation({ environment }), { environment, event: null, replayed: false });
});

test("normalizes physical sandbox provisioning run and immutable event timeline", () => {
  const run = { id: physicalRunId, operation: "SANDBOX_PROVISION", status: "SUCCEEDED" };
  const events = [{ version: 1, status: "IN_PROGRESS" }, { version: 2, status: "SUCCEEDED" }];
  assert.deepEqual(normalizePhysicalRunRows({ runs: [run] }), [run]);
  assert.deepEqual(normalizePhysicalRunDetail({ data: { run, events }, idempotent: true }), {
    run, events, idempotent: true,
  });
});

test("summarizes synthetic, masked, pending, active, suspended, expired and retired environments", () => {
  const rows = [
    { dataMode: "SYNTHETIC", status: "ACTIVE", effectiveStatus: "ACTIVE" },
    { dataMode: "MASKED", status: "PENDING_APPROVAL", effectiveStatus: "PENDING_APPROVAL" },
    { dataMode: "MASKED", status: "ACTIVE", effectiveStatus: "ACTIVE" },
    { dataMode: "MASKED", status: "SUSPENDED", effectiveStatus: "SUSPENDED" },
    { dataMode: "MASKED", status: "ACTIVE", effectiveStatus: "APPROVAL_EXPIRED" },
    { dataMode: "SYNTHETIC", status: "RETIRED", effectiveStatus: "RETIRED" },
  ];
  assert.deepEqual(summarizeSandboxes(rows), {
    total: 6, synthetic: 2, masked: 4, pendingApproval: 1, active: 2,
    suspended: 1, approvalExpired: 1, retired: 1,
  });
});

test("filters sandbox environments by query, status, data mode and purpose", () => {
  const rows = [
    { environmentCode: "DEMO-SYN", displayName: "Sales demo", purpose: "DEMO", dataMode: "SYNTHETIC", status: "ACTIVE" },
    { environmentCode: "MASKED-QA", displayName: "Quality trial", purpose: "TEST", dataMode: "MASKED", status: "PENDING_APPROVAL" },
  ];
  assert.deepEqual(filterSandboxes(rows, { query: "quality", status: "ALL" }), [rows[1]]);
  assert.deepEqual(filterSandboxes(rows, { dataMode: "SYNTHETIC" }), [rows[0]]);
  assert.deepEqual(filterSandboxes(rows, { purpose: "TEST", status: "PENDING_APPROVAL" }), [rows[1]]);
});

test("builds synthetic sandbox metadata and never accepts privacy/customer payload fields", () => {
  const payload = buildCreateSandboxPayload({
    environment_code: "demo-qa-01", display_name: "Sales demo",
    purpose: "DEMO", data_mode: "SYNTHETIC",
    generator: "factoryos-fixture-generator", generator_version: "2.1.0",
    schema_version: "2026.11", seed: "demo-seed-01", record_count: "1250",
    idempotency_key: "sandbox-synthetic-1",
  });
  assert.equal(payload.environment_code, "DEMO-QA-01");
  assert.deepEqual(payload.dataset_manifest, {
    generator: "factoryos-fixture-generator", generator_version: "2.1.0",
    schema_version: "2026.11", seed: "demo-seed-01", record_count: 1250,
  });
  assert.equal("privacy_assessment" in payload, false);
});

test("rejects malformed environment identifiers, purpose, data mode and synthetic manifest", () => {
  const base = {
    environment_code: "DEMO-1", display_name: "Demo", purpose: "DEMO", data_mode: "SYNTHETIC",
    generator: "generator", generator_version: "1", schema_version: "1", seed: "seed", record_count: 10,
    idempotency_key: "sandbox-1",
  };
  assert.throws(() => buildCreateSandboxPayload({ ...base, environment_code: "bad code" }), /environment_code/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, purpose: "UNKNOWN" }), /purpose/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, data_mode: "RAW" }), /SYNTHETIC or MASKED/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, record_count: -1 }), /record_count/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, display_name: "" }), /display_name/);
});

test("builds masked dataset provenance and assessment with bounded safe fields", () => {
  const now = new Date();
  const payload = buildCreateSandboxPayload({
    environment_code: "MASKED-TRIAL", display_name: "Masked test dataset",
    purpose: "TEST", data_mode: "MASKED",
    dataset_reference: "masked-dataset-2026-11", schema_version: "schema-4",
    record_count: 900, masking_policy_version: "mask-v3",
    masked_at: new Date(now.getTime() - 60_000).toISOString(), checksum_sha256: checksum,
    residual_risk: "LOW", reviewed_fields: ["email", "phone", "email"],
    assessed_at: new Date(now.getTime() - 30_000).toISOString(),
    idempotency_key: "sandbox-masked-1",
  });
  assert.equal(payload.dataset_manifest.dataset_reference, "masked-dataset-2026-11");
  assert.equal(payload.dataset_manifest.checksum_sha256, checksum);
  assert.deepEqual(payload.privacy_assessment.reviewed_fields, ["email", "phone"]);
  assert.equal(payload.privacy_assessment.data_minimization_status, "ASSESSED");
});

test("rejects URL dataset paths, invalid checksums and HIGH residual privacy risk", () => {
  const base = {
    environment_code: "MASKED-1", display_name: "Masked trial",
    purpose: "EVALUATION", data_mode: "MASKED",
    dataset_reference: "dataset-reference", schema_version: "1", record_count: 100,
    masking_policy_version: "mask-v1", masked_at: new Date(Date.now() - 1000).toISOString(),
    checksum_sha256: checksum, residual_risk: "LOW", reviewed_fields: ["email"],
    assessed_at: new Date(Date.now() - 1000).toISOString(), idempotency_key: "masked-1",
  };
  assert.throws(() => buildCreateSandboxPayload({ ...base, dataset_reference: "https://storage.example/private" }), /opaque reference/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, checksum_sha256: "not-digest" }), /SHA-256/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, residual_risk: "HIGH" }), /HIGH or unknown/);
  assert.throws(() => buildCreateSandboxPayload({ ...base, reviewed_fields: [] }), /1 to 100/);
});

test("builds masked approval with bounded future expiry and positive expected version", () => {
  const expires = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const payload = buildMaskedApprovalPayload({
    expected_version: "2", reason: "Independent privacy review passed",
    approval_expires_at: expires.toISOString(), idempotency_key: "masked-approval-2",
  });
  assert.equal(payload.expected_version, 2);
  assert.equal(payload.approval_expires_at, expires.toISOString());
  assert.throws(() => buildMaskedApprovalPayload({
    expected_version: 2, reason: "Expired", approval_expires_at: new Date(Date.now() - 1000).toISOString(),
    idempotency_key: "masked-approval-expired",
  }), /future/);
  assert.throws(() => buildMaskedApprovalPayload({
    expected_version: 2, reason: "Too long", approval_expires_at: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString(),
    idempotency_key: "masked-approval-too-long",
  }), /90 days/);
});

test("builds allowed sandbox transitions with optimistic version and mandatory reason", () => {
  assert.deepEqual(buildSandboxTransitionPayload({
    action: "SUSPEND", expected_version: 3, reason: "Environment maintenance",
    idempotency_key: "sandbox-suspend-3",
  }), {
    action: "SUSPEND", expected_version: 3, reason: "Environment maintenance",
    idempotency_key: "sandbox-suspend-3",
  });
  assert.throws(() => buildSandboxTransitionPayload({
    action: "APPROVE", expected_version: 3, reason: "No", idempotency_key: "invalid-action",
  }), /transition action/);
  assert.throws(() => buildSandboxTransitionPayload({
    action: "RESUME", expected_version: 0, reason: "Reason", idempotency_key: "invalid-version",
  }), /expected_version/);
});

test("bounds physical provisioning timeout and submits the current sandbox version", () => {
  assert.deepEqual(buildSandboxPhysicalPayload({
    expected_version: 5, idempotency_key: "sandbox-provision-5", health_timeout_seconds: 90,
  }), {
    expected_version: 5, idempotency_key: "sandbox-provision-5", health_timeout_seconds: 90,
  });
  assert.throws(() => buildSandboxPhysicalPayload({
    expected_version: 5, idempotency_key: "sandbox-provision-5", health_timeout_seconds: 301,
  }), /5 to 300/);
});

test("client uses exact SaaS sandbox and physical provisioning endpoints", async () => {
  const calls = [];
  const client = createSaasSandboxClient(async (path, options) => {
    calls.push({ path, options });
    return { ok: true };
  });
  await client.listEnvironments();
  await client.createEnvironment({ environment_code: "DEMO-01" });
  await client.events(environmentId);
  await client.approveMaskedData(environmentId, { expected_version: 1 });
  await client.transition(environmentId, { action: "SUSPEND" });
  await client.listPhysicalRuns(25, 0);
  await client.physicalRun(physicalRunId);
  await client.provision(environmentId, { expected_version: 1 });
  assert.deepEqual(calls.map((item) => item.path), [
    "/v2/saas/sandboxes",
    "/v2/saas/sandboxes",
    "/v2/saas/sandboxes/" + environmentId + "/events",
    "/v2/saas/sandboxes/" + environmentId + "/approve-masked-data",
    "/v2/saas/sandboxes/" + environmentId + "/transitions",
    "/v2/saas/physical-provisioning/runs?limit=25&offset=0",
    "/v2/saas/physical-provisioning/runs/" + physicalRunId,
    "/v2/saas/physical-provisioning/sandboxes/" + environmentId + "/provision",
  ]);
  assert.equal(calls[1].options.method, "POST");
  assert.throws(() => client.events("not-a-uuid"), /UUID/);
});
