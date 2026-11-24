import test from "node:test";
import assert from "node:assert/strict";
import {
  buildErasureExecutionPayload,
  buildErasureReviewPayload,
  buildExternalTargetPayload,
  buildExternalTargetReviewPayload,
  buildFinanceRetentionPayload,
  buildFinanceRetentionReviewPayload,
  buildFinanceRetentionRunPayload,
  buildLegalHoldPayload,
  buildLegalHoldReleasePayload,
  buildMigrationTransitionPayload,
  buildMigrationValidationPayload,
  buildRetentionPolicyPayload,
  buildRetentionRunPayload,
  buildTenantErasurePayload,
  buildTenantExportPayload,
  createSaasDataProtectionClient,
  normalizeDataProtectionRows,
} from "./saas-data-protection-workbench.mjs";

const id = "8c2f0e8d-5ca4-4cc2-9e3c-2d0d70adba2a";
const digest = "a".repeat(64);
const common = { reason: "Reviewed under the tenant data lifecycle policy", idempotency_key: "data-protection-20261124-001" };

test("row normalizer handles arrays and API wrappers without inventing rows", () => {
  const rows = [{ id: "1" }];
  assert.equal(normalizeDataProtectionRows(rows), rows);
  assert.equal(normalizeDataProtectionRows({ policies: rows }, "policies"), rows);
  assert.equal(normalizeDataProtectionRows({ data: { items: rows } })[0].id, "1");
  assert.deepEqual(normalizeDataProtectionRows(null), []);
});

test("retention policy payload validates category, days, disposition and legal basis", () => {
  const payload = buildRetentionPolicyPayload({
    category_code: "AUDIT_LOG", retention_days: "365", disposition: "REVIEW",
    legal_basis: "Regulatory recordkeeping", ...common,
  });
  assert.equal(payload.retention_days, 365);
  assert.throws(() => buildRetentionPolicyPayload({ category_code: "NOT_A_CATEGORY", retention_days: 1, disposition: "DELETE", legal_basis: "valid", ...common }), /category_code/);
  assert.throws(() => buildRetentionPolicyPayload({ category_code: "AUDIT_LOG", retention_days: 0, disposition: "DELETE", legal_basis: "valid", ...common }), /retention_days/);
});

test("retention dry-run and execute modes require expected version and idempotency", () => {
  assert.equal(buildRetentionRunPayload({ mode: "DRY_RUN", expected_policy_version: 2, ...common }).mode, "DRY_RUN");
  assert.equal(buildRetentionRunPayload({ mode: "EXECUTE", expected_policy_version: 2, ...common }).expected_policy_version, 2);
  assert.throws(() => buildRetentionRunPayload({ mode: "EXECUTE", expected_policy_version: 0, ...common }), /expected_policy_version/);
});

test("legal holds enforce unique supported categories and optimistic version release", () => {
  assert.deepEqual(buildLegalHoldPayload({ categories: ["AUDIT_LOG", "EVIDENCE"], case_reference: "CASE-102", ...common }).categories, ["AUDIT_LOG", "EVIDENCE"]);
  assert.throws(() => buildLegalHoldPayload({ categories: ["AUDIT_LOG", "AUDIT_LOG"], case_reference: "CASE-102", ...common }), /unique/);
  assert.equal(buildLegalHoldReleasePayload({ expected_version: 3, reason: common.reason }).expected_version, 3);
});

test("erasure request requires export UUID, exact version and SHA-256 bundle digest", () => {
  const payload = buildTenantErasurePayload({
    categories: ["BUSINESS_DATA"], export_transfer_id: id, export_transfer_version: "4",
    export_bundle_digest: digest, ...common,
  });
  assert.equal(payload.export_bundle_digest, digest);
  assert.equal(payload.export_transfer_version, 4);
  assert.throws(() => buildTenantErasurePayload({
    categories: ["BUSINESS_DATA"], export_transfer_id: id, export_transfer_version: 4,
    export_bundle_digest: "not-a-digest", ...common,
  }), /SHA-256/);
  assert.equal(buildErasureReviewPayload({ decision: "APPROVE", expected_version: 2, reason: common.reason }).decision, "APPROVE");
  assert.equal(buildErasureExecutionPayload({ expected_version: 2, ...common }).expected_version, 2);
});

test("external target rejects URL or credential-like references and validates transitions", () => {
  const payload = buildExternalTargetPayload({
    target_id: "archive-01", store_kind: "OBJECT_STORAGE", adapter_key: "s3-adapter",
    config_reference: "vault.refs.archive-policy", categories: ["EVIDENCE"],
    registration_reason: common.reason, idempotency_key: common.idempotency_key,
  });
  assert.equal(payload.target_id, "archive-01");
  assert.throws(() => buildExternalTargetPayload({
    target_id: "archive-02", store_kind: "DATABASE", adapter_key: "db",
    config_reference: "vault.refs.archive", categories: ["EVIDENCE"],
    registration_reason: common.reason, idempotency_key: "data-protection-20261124-002",
  }), /store_kind/);
  assert.throws(() => buildExternalTargetPayload({
    target_id: "archive-01", store_kind: "OBJECT_STORAGE", adapter_key: "s3",
    config_reference: "https://example.com", categories: ["EVIDENCE"],
    registration_reason: common.reason, idempotency_key: common.idempotency_key,
  }), /non-secret/);
  assert.equal(buildExternalTargetReviewPayload({ decision: "PAUSE", expected_status: "ACTIVE", reason: common.reason }).decision, "PAUSE");
});

test("export and migration builders require schema contract and preserve explicit transition data", () => {
  assert.equal(buildTenantExportPayload({ source_schema_version: "2.1.0", ...common }).source_schema_version, "2.1.0");
  assert.throws(() => buildTenantExportPayload({ source_schema_version: "latest", ...common }), /major.minor.patch/);
  assert.equal(buildMigrationValidationPayload({
    source_transfer_id: id, target_schema_version: "2.2.0", ...common,
  }).source_transfer_id, id);
  assert.equal(buildMigrationTransitionPayload({
    action: "START", expected_version: 2, ...common,
  }).action, "START");
  assert.throws(() => buildMigrationTransitionPayload({
    action: "COMPLETE", expected_version: 2, target_bundle_reference: "bundle-2",
    target_bundle_digest: digest, ...common,
  }), /target_manifest/);
});

test("finance retention policies use positive bounded days and maker-checker decisions", () => {
  const payload = buildFinanceRetentionPayload({
    retention_days: "2555", legal_basis: "Accounting law", finance_adapter_key: "ledger-v1", ...common,
  });
  assert.equal(payload.retention_days, 2555);
  assert.equal(buildFinanceRetentionReviewPayload({ decision: "REJECT", expected_version: 1, reason: common.reason }).decision, "REJECT");
  assert.equal(buildFinanceRetentionRunPayload({ mode: "DRY_RUN", expected_policy_version: 1, ...common }).mode, "DRY_RUN");
});

test("client delegates authenticated requests to exact v2 routes and URL-encodes IDs", async () => {
  const calls = [];
  const client = createSaasDataProtectionClient(async (path, options = {}) => {
    calls.push({ path, options });
    return { ok: true };
  });
  await client.listPolicyHistory("AUDIT_LOG");
  await client.createPolicy({ category_code: "AUDIT_LOG" });
  await client.releaseLegalHold(id, { expected_version: 1 });
  await client.executeErasure(id, { expected_version: 1 });
  await client.createExport({ source_schema_version: "2.1.0" });
  await client.transitionMigration(id, { action: "START", expected_version: 1 });
  await client.currentBackupCopyClassCoverage("EVIDENCE");
  assert.equal(calls[0].path, "/v2/saas/data-retention/policies/history?categoryCode=AUDIT_LOG");
  assert.equal(calls[1].path, "/v2/saas/data-retention/policies");
  assert.equal(calls[2].path, "/v2/saas/data-retention/legal-holds/" + id + "/release");
  assert.equal(calls[3].path, "/v2/saas/data-retention/erasure-requests/" + id + "/execute");
  assert.equal(calls[4].path, "/v2/saas/data-transfers/exports");
  assert.equal(calls[5].path, "/v2/saas/data-transfers/migrations/" + id + "/transitions");
  assert.equal(calls[6].path, "/v2/saas/data-retention/backup-copy-classes/EVIDENCE/current");
  assert.equal(calls[1].options.method, "POST");
});

test("client rejects malformed identifiers before issuing a request", async () => {
  let calls = 0;
  const client = createSaasDataProtectionClient(async () => { calls += 1; });
  assert.throws(() => client.executeErasure("not-a-uuid", {}), /valid UUID/);
  assert.equal(calls, 0);
});
