import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateReleasePayload,
  buildDeploymentProfilePayload,
  buildDeploymentProfileTransitionPayload,
  buildEffectiveReleaseQuery,
  buildPhysicalOperationPayload,
  buildReleasePromotionPayload,
  buildReleaseRollbackPayload,
  buildReleaseTransitionPayload,
  createSaasReleaseControlClient,
  normalizePhysicalRunDetail,
  normalizePhysicalRunRows,
  normalizeSaasRows,
  summarizeDeploymentProfiles,
  summarizeReleaseRollouts,
} from "./saas-release-control-plane.mjs";

const factoryId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d27";
const profileId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d28";
const runId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d29";
const digest = "a".repeat(64);

test("normalizes tenant-scoped release/profile and physical-run collection envelopes", () => {
  const rows = [{ rolloutKey: "RELEASE-A" }];
  assert.deepEqual(normalizeSaasRows({ items: rows }), rows);
  assert.deepEqual(normalizeSaasRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeSaasRows({ profiles: rows }, ["profiles", "items"]), rows);
  assert.deepEqual(normalizePhysicalRunRows({ runs: rows }), rows);
  assert.deepEqual(normalizeSaasRows(null), []);
});

test("normalizes immutable run timeline without fabricating absent event evidence", () => {
  const value = { run: { id: runId, status: "SUCCEEDED" }, events: [{ version: 1, status: "IN_PROGRESS" }] };
  assert.deepEqual(normalizePhysicalRunDetail(value), { ...value, idempotent: false });
  assert.deepEqual(normalizePhysicalRunDetail({ data: value, idempotent: true }), { ...value, idempotent: true });
  assert.deepEqual(normalizePhysicalRunDetail(null), { run: {}, events: [], idempotent: false });
});

test("summarizes release lifecycle and only physically deployable stages", () => {
  const rows = [
    { stage: "DRAFT" }, { stage: "CANARY" }, { stage: "PRODUCTION" },
    { stage: "PAUSED" }, { stage: "RETIRED" },
  ];
  assert.deepEqual(summarizeReleaseRollouts(rows), {
    total: 5, draft: 1, canary: 1, production: 1, paused: 1, retired: 1, physicallyDeployable: 2,
  });
});

test("summarizes deployment profile lifecycle statuses", () => {
  const rows = [
    { status: "PLANNED" }, { status: "PROVISIONING" }, { status: "ACTIVE" },
    { status: "MIGRATING" }, { status: "FAILED" }, { status: "RETIRED" },
  ];
  assert.deepEqual(summarizeDeploymentProfiles(rows), {
    total: 6, planned: 1, provisioning: 1, active: 1, migrating: 1, failed: 1, retired: 1,
  });
});

test("builds correctly scoped organization, factory, module and agent releases", () => {
  const base = {
    rollout_key: "release-2026-01", release_channel: "PREVIEW",
    artifact_version: "2026.11.24", artifact_digest: digest,
    reason: "Release candidate verified by evaluation", idempotency_key: "register-release-1",
    evaluation_reference: "eval-run-91",
  };
  const org = buildCreateReleasePayload({ ...base, scope_type: "ORGANIZATION" });
  assert.equal(org.rollout_key, "RELEASE-2026-01");
  assert.equal(org.artifact_digest, digest);
  assert.equal(org.evaluation_reference, "eval-run-91");
  assert.equal("factory_id" in org, false);
  const factory = buildCreateReleasePayload({ ...base, rollout_key: "FACTORY-01", scope_type: "FACTORY", factory_id: factoryId });
  assert.equal(factory.factory_id, factoryId);
  const moduleRelease = buildCreateReleasePayload({ ...base, rollout_key: "MODULE-01", scope_type: "MODULE", module_key: "inventory.core" });
  assert.equal(moduleRelease.module_key, "inventory.core");
  const agent = buildCreateReleasePayload({ ...base, rollout_key: "AGENT-01", scope_type: "AGENT", agent_key: "planner.agent", module_key: "planning.core" });
  assert.equal(agent.agent_key, "planner.agent");
  assert.equal(agent.module_key, "planning.core");
});

test("rejects malformed release key, scope selector combinations and artifact digest", () => {
  const base = {
    rollout_key: "RELEASE-1", scope_type: "ORGANIZATION", release_channel: "STABLE",
    artifact_version: "1.0", artifact_digest: digest, reason: "Reason",
    idempotency_key: "release-key-1",
  };
  assert.throws(() => buildCreateReleasePayload({ ...base, rollout_key: "bad key" }), /rollout_key/);
  assert.throws(() => buildCreateReleasePayload({ ...base, artifact_digest: "not-sha" }), /SHA-256/);
  assert.throws(() => buildCreateReleasePayload({ ...base, factory_id: factoryId }), /Organization scope/);
  assert.throws(() => buildCreateReleasePayload({ ...base, scope_type: "FACTORY" }), /factory_id/);
  assert.throws(() => buildCreateReleasePayload({ ...base, scope_type: "MODULE" }), /module_key/);
  assert.throws(() => buildCreateReleasePayload({ ...base, scope_type: "AGENT" }), /agent_key/);
  assert.throws(() => buildCreateReleasePayload({ ...base, release_channel: "LOCAL" }), /release_channel/);
});

test("enforces canary percentage and exact production rollout percentage", () => {
  const base = { expected_version: "3", reason: "Promote after review", idempotency_key: "promote-3" };
  assert.deepEqual(buildReleasePromotionPayload({ ...base, stage: "CANARY", rollout_percentage: "25" }), {
    expected_version: 3, stage: "CANARY", rollout_percentage: 25,
    reason: "Promote after review", idempotency_key: "promote-3",
  });
  assert.equal(buildReleasePromotionPayload({ ...base, stage: "PRODUCTION", rollout_percentage: 100 }).rollout_percentage, 100);
  assert.throws(() => buildReleasePromotionPayload({ ...base, stage: "CANARY", rollout_percentage: 100 }), /1 to 99/);
  assert.throws(() => buildReleasePromotionPayload({ ...base, stage: "PRODUCTION", rollout_percentage: 99 }), /exactly 100/);
  assert.throws(() => buildReleasePromotionPayload({ ...base, stage: "INVALID", rollout_percentage: 25 }), /CANARY or PRODUCTION/);
});

test("restricts release pause/resume/retire and rollback to positive versions with mandatory reason", () => {
  assert.deepEqual(buildReleaseTransitionPayload({
    action: "PAUSE", expected_version: 4, reason: "Health degradation", idempotency_key: "pause-4",
  }), { action: "PAUSE", expected_version: 4, reason: "Health degradation", idempotency_key: "pause-4" });
  assert.throws(() => buildReleaseTransitionPayload({
    action: "PROMOTE", expected_version: 4, reason: "x", idempotency_key: "bad",
  }), /transition action/);
  assert.deepEqual(buildReleaseRollbackPayload({
    expected_version: 5, target_rollout_key: "RELEASE-STABLE-01",
    target_version: 2, reason: "Rollback to tested artifact", idempotency_key: "rollback-5",
  }), {
    expected_version: 5, target_rollout_key: "RELEASE-STABLE-01", target_version: 2,
    reason: "Rollback to tested artifact", idempotency_key: "rollback-5",
  });
});

test("validates tenant/factory deployment profiles and opaque references, not URLs", () => {
  const tenant = buildDeploymentProfilePayload({
    scope_type: "TENANT", profile_type: "SHARED_SAAS",
    region_code: "ap-south-1", reason: "Tenant topology decision",
    idempotency_key: "profile-tenant-1",
  });
  assert.equal(tenant.scope_type, "TENANT");
  const factory = buildDeploymentProfilePayload({
    scope_type: "FACTORY", factory_id: factoryId, profile_type: "HYBRID_EDGE_CLOUD",
    edge_site_code: "DHK-EDGE-01", deployment_reference: "cluster-prod-01",
    reason: "Factory edge topology", idempotency_key: "profile-factory-1",
  });
  assert.equal(factory.factory_id, factoryId);
  assert.throws(() => buildDeploymentProfilePayload({
    scope_type: "FACTORY", profile_type: "SHARED_SAAS", reason: "Reason", idempotency_key: "x",
  }), /factory_id/);
  assert.throws(() => buildDeploymentProfilePayload({
    scope_type: "TENANT", factory_id: factoryId, profile_type: "SHARED_SAAS",
    reason: "Reason", idempotency_key: "x",
  }), /must not include factory_id/);
  assert.throws(() => buildDeploymentProfilePayload({
    scope_type: "TENANT", profile_type: "DEDICATED_VPC", deployment_reference: "https://example.com",
    reason: "Reason", idempotency_key: "x",
  }), /opaque non-URL/);
});

test("allows migration targets only for START_MIGRATION and requires a different topology", () => {
  const base = { expected_version: 2, reason: "Residency boundary changed", idempotency_key: "profile-migrate-2" };
  assert.deepEqual(buildDeploymentProfileTransitionPayload({
    ...base, action: "START_MIGRATION", current_profile_type: "SHARED_SAAS",
    target_profile_type: "DEDICATED_VPC", target_region_code: "ap-south-1",
  }), {
    action: "START_MIGRATION", expected_version: 2, reason: "Residency boundary changed",
    idempotency_key: "profile-migrate-2", target_profile_type: "DEDICATED_VPC",
    target_region_code: "ap-south-1",
  });
  assert.throws(() => buildDeploymentProfileTransitionPayload({
    ...base, action: "PAUSE", target_profile_type: "DEDICATED_VPC",
  }), /only allowed for START_MIGRATION/);
  assert.throws(() => buildDeploymentProfileTransitionPayload({
    ...base, action: "START_MIGRATION", current_profile_type: "SHARED_SAAS",
    target_profile_type: "SHARED_SAAS",
  }), /must differ/);
});

test("bounds physical operation timeout and permits only explicit HALT or ROLLBACK policies", () => {
  assert.deepEqual(buildPhysicalOperationPayload({
    expected_version: 3, idempotency_key: "deploy-3", health_timeout_seconds: 90, failure_policy: "HALT",
  }), { expected_version: 3, idempotency_key: "deploy-3", health_timeout_seconds: 90, failure_policy: "HALT" });
  assert.throws(() => buildPhysicalOperationPayload({
    expected_version: 3, idempotency_key: "deploy-3", health_timeout_seconds: 4,
  }), /5 to 300/);
  assert.throws(() => buildPhysicalOperationPayload({
    expected_version: 3, idempotency_key: "deploy-3", failure_policy: "IGNORE",
  }), /HALT or ROLLBACK/);
});

test("builds effective release resolution query using bounded channel and subject identity", () => {
  assert.equal(buildEffectiveReleaseQuery({
    channel: "PREVIEW", subject_key: "tenant-user-01", factory_id: factoryId,
    module_key: "planning.core", agent_key: "planner.agent",
  }), "?channel=PREVIEW&subject_key=tenant-user-01&factory_id=" + factoryId + "&module_key=planning.core&agent_key=planner.agent");
  assert.throws(() => buildEffectiveReleaseQuery({ channel: "STABLE", subject_key: "" }), /subject_key/);
});

test("client uses exact v2 release, deployment-profile and physical-run API contracts", async () => {
  const calls = [];
  const client = createSaasReleaseControlClient(async (path, options) => {
    calls.push({ path, options });
    return { ok: true };
  });
  await client.listReleases();
  await client.createRelease({ rollout_key: "REL-1" });
  await client.releaseHistory("REL-1");
  await client.promoteRelease("REL-1", { stage: "CANARY" });
  await client.transitionRelease("REL-1", { action: "PAUSE" });
  await client.rollbackRelease("REL-1", { target_rollout_key: "REL-0" });
  await client.resolveRelease({ channel: "STABLE", subject_key: "subject-1" });
  await client.listProfiles(factoryId);
  await client.effectiveProfile(factoryId);
  await client.createProfile({ profile_type: "SHARED_SAAS" });
  await client.tenantProfileHistory();
  await client.factoryProfileHistory(factoryId);
  await client.transitionTenantProfile({ action: "PAUSE" });
  await client.transitionFactoryProfile(factoryId, { action: "PAUSE" });
  await client.listPhysicalRuns(15, 20);
  await client.getPhysicalRun(runId);
  await client.provisionProfile(profileId, { expected_version: 1 });
  await client.deployRelease("REL-1", { expected_version: 1 });
  assert.deepEqual(calls.slice(0, 7).map((call) => call.path), [
    "/v2/saas/releases",
    "/v2/saas/releases",
    "/v2/saas/releases/REL-1/history",
    "/v2/saas/releases/REL-1/promotions",
    "/v2/saas/releases/REL-1/transitions",
    "/v2/saas/releases/REL-1/rollback",
    "/v2/saas/releases/resolve?channel=STABLE&subject_key=subject-1",
  ]);
  assert.equal(calls[7].path, "/v2/saas/deployment-profiles?factory_id=" + factoryId);
  assert.equal(calls[9].path, "/v2/saas/deployment-profiles");
  assert.equal(calls[10].path, "/v2/saas/deployment-profiles/tenant/history");
  assert.equal(calls[11].path, "/v2/saas/deployment-profiles/factories/" + factoryId + "/history");
  assert.equal(calls[12].path, "/v2/saas/deployment-profiles/tenant/transitions");
  assert.equal(calls[13].path, "/v2/saas/deployment-profiles/factories/" + factoryId + "/transitions");
  assert.equal(calls[14].path, "/v2/saas/physical-provisioning/runs?limit=15&offset=20");
  assert.equal(calls[15].path, "/v2/saas/physical-provisioning/runs/" + runId);
  assert.equal(calls[16].path, "/v2/saas/physical-provisioning/deployment-profiles/" + profileId + "/provision");
  assert.equal(calls[17].path, "/v2/saas/physical-provisioning/releases/REL-1/deploy");
  assert.equal(calls[3].options.method, "POST");
  assert.throws(() => client.getPhysicalRun("not-a-uuid"), /UUID/);
});
