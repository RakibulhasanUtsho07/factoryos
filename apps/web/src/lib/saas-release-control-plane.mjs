const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_SCOPES = new Set(["ORGANIZATION", "FACTORY", "MODULE", "AGENT"]);
const RELEASE_CHANNELS = new Set(["STABLE", "PREVIEW", "EXPERIMENTAL"]);
const DEPLOYMENT_PROFILES = new Set(["SHARED_SAAS", "SINGLE_TENANT", "DEDICATED_VPC", "HYBRID_EDGE_CLOUD"]);
const RELEASE_ACTIONS = new Set(["PAUSE", "RESUME", "RETIRE"]);
const PROFILE_ACTIONS = new Set([
  "START_PROVISIONING", "ACTIVATE", "START_MIGRATION", "COMPLETE_MIGRATION",
  "PAUSE", "RESUME", "FAIL", "RETIRE",
]);
const PHYSICAL_POLICIES = new Set(["HALT", "ROLLBACK"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function requiredText(value, field, max = 255) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.normalize("NFC").trim();
  if (!result || result.length > max) throw new Error(field + " must contain 1 to " + max + " characters.");
  return result;
}
function optionalToken(value, field, max = 200) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = requiredText(value, field, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result) || result.length > max || result.includes("://")) {
    throw new Error(field + " must be an opaque non-URL reference.");
  }
  return result;
}
function uuid(value, field) {
  const result = requiredText(value, field, 36).toLowerCase();
  if (!UUID.test(result)) throw new Error(field + " must be a UUID.");
  return result;
}
function whole(value, field, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(field + " must be a whole number from " + min + " to " + max + ".");
  }
  return result;
}
function idempotency(value) {
  const result = requiredText(value, "idempotency_key", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new Error("idempotency_key format is invalid.");
  }
  return result;
}
function reason(value) {
  return requiredText(value, "reason", 1000);
}
function releaseKey(value) {
  const result = requiredText(value, "rollout_key", 80).toUpperCase();
  if (!/^[A-Z][A-Z0-9:_-]{0,79}$/.test(result)) throw new Error("rollout_key format is invalid.");
  return result;
}
function digest(value) {
  const result = requiredText(value, "artifact_digest", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("artifact_digest must be a SHA-256 hex digest.");
  return result;
}

export function normalizeSaasRows(value, keys = ["items", "profiles", "rollouts", "runs"]) {
  if (Array.isArray(value)) return value;
  const root = record(value);
  for (const key of keys) if (Array.isArray(root[key])) return root[key];
  if (root.data && typeof root.data === "object") return normalizeSaasRows(root.data, keys);
  return [];
}
export function normalizePhysicalRunRows(value) {
  return normalizeSaasRows(value, ["runs", "items"]);
}
export function normalizePhysicalRunDetail(value) {
  const root = record(value);
  const nested = record(root.data);
  const source = Object.keys(record(root.run)).length ? root : nested;
  return {
    run: record(source.run),
    events: Array.isArray(source.events) ? source.events : [],
    idempotent: root.idempotent === true || source.idempotent === true,
  };
}
export function summarizeReleaseRollouts(input) {
  const rows = normalizeSaasRows(input);
  return {
    total: rows.length,
    draft: rows.filter((item) => item?.stage === "DRAFT").length,
    canary: rows.filter((item) => item?.stage === "CANARY").length,
    production: rows.filter((item) => item?.stage === "PRODUCTION").length,
    paused: rows.filter((item) => item?.stage === "PAUSED").length,
    retired: rows.filter((item) => item?.stage === "RETIRED").length,
    physicallyDeployable: rows.filter((item) => ["CANARY", "PRODUCTION"].includes(item?.stage)).length,
  };
}
export function summarizeDeploymentProfiles(input) {
  const rows = normalizeSaasRows(input, ["profiles", "items"]);
  return {
    total: rows.length,
    planned: rows.filter((item) => item?.status === "PLANNED").length,
    provisioning: rows.filter((item) => item?.status === "PROVISIONING").length,
    active: rows.filter((item) => item?.status === "ACTIVE").length,
    migrating: rows.filter((item) => item?.status === "MIGRATING").length,
    failed: rows.filter((item) => item?.status === "FAILED").length,
    retired: rows.filter((item) => item?.status === "RETIRED").length,
  };
}

export function buildCreateReleasePayload(input = {}) {
  const scope = requiredText(input.scope_type, "scope_type", 20);
  if (!RELEASE_SCOPES.has(scope)) throw new Error("scope_type is invalid.");
  const channel = requiredText(input.release_channel, "release_channel", 20);
  if (!RELEASE_CHANNELS.has(channel)) throw new Error("release_channel is invalid.");
  const payload = {
    rollout_key: releaseKey(input.rollout_key),
    scope_type: scope,
    release_channel: channel,
    artifact_version: requiredText(input.artifact_version, "artifact_version", 120),
    artifact_digest: digest(input.artifact_digest),
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
  if (scope === "ORGANIZATION") {
    if (input.factory_id || input.module_key || input.agent_key) {
      throw new Error("Organization scope must not include factory, module or agent selectors.");
    }
  } else if (scope === "FACTORY") {
    payload.factory_id = uuid(input.factory_id, "factory_id");
    if (input.module_key || input.agent_key) throw new Error("Factory scope cannot include module or agent selectors.");
  } else if (scope === "MODULE") {
    payload.module_key = optionalToken(input.module_key, "module_key", 80);
    if (!payload.module_key || input.agent_key) throw new Error("Module scope requires module_key and cannot include agent_key.");
    if (input.factory_id) payload.factory_id = uuid(input.factory_id, "factory_id");
  } else {
    payload.agent_key = optionalToken(input.agent_key, "agent_key", 160);
    if (!payload.agent_key) throw new Error("Agent scope requires agent_key.");
    if (input.module_key) payload.module_key = optionalToken(input.module_key, "module_key", 80);
    if (input.factory_id) payload.factory_id = uuid(input.factory_id, "factory_id");
  }
  const evaluation = optionalToken(input.evaluation_reference, "evaluation_reference", 200);
  if (evaluation) payload.evaluation_reference = evaluation;
  return payload;
}

export function buildReleasePromotionPayload(input = {}) {
  const stage = requiredText(input.stage, "stage", 20);
  if (!["CANARY", "PRODUCTION"].includes(stage)) throw new Error("stage must be CANARY or PRODUCTION.");
  const percentage = whole(input.rollout_percentage, "rollout_percentage", 1, 100);
  if (stage === "CANARY" && percentage > 99) throw new Error("CANARY rollout percentage must be 1 to 99.");
  if (stage === "PRODUCTION" && percentage !== 100) throw new Error("PRODUCTION rollout percentage must be exactly 100.");
  return {
    expected_version: whole(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
    stage,
    rollout_percentage: percentage,
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildReleaseTransitionPayload(input = {}) {
  const action = requiredText(input.action, "action", 20);
  if (!RELEASE_ACTIONS.has(action)) throw new Error("Release transition action is invalid.");
  return {
    action,
    expected_version: whole(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildReleaseRollbackPayload(input = {}) {
  const targetKey = releaseKey(input.target_rollout_key);
  return {
    expected_version: whole(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
    target_rollout_key: targetKey,
    target_version: whole(input.target_version, "target_version", 1, Number.MAX_SAFE_INTEGER),
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildDeploymentProfilePayload(input = {}) {
  const scope = requiredText(input.scope_type, "scope_type", 20);
  if (!["TENANT", "FACTORY"].includes(scope)) throw new Error("scope_type must be TENANT or FACTORY.");
  const profileType = requiredText(input.profile_type, "profile_type", 40);
  if (!DEPLOYMENT_PROFILES.has(profileType)) throw new Error("profile_type is invalid.");
  const payload = {
    scope_type: scope,
    profile_type: profileType,
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
  if (scope === "FACTORY") payload.factory_id = uuid(input.factory_id, "factory_id");
  else if (input.factory_id) throw new Error("Tenant profile must not include factory_id.");
  const deployment = optionalToken(input.deployment_reference, "deployment_reference", 200);
  const region = optionalToken(input.region_code, "region_code", 64);
  const residency = optionalToken(input.residency_domain, "residency_domain", 64);
  const edge = optionalToken(input.edge_site_code, "edge_site_code", 80);
  if (deployment) payload.deployment_reference = deployment;
  if (region) payload.region_code = region;
  if (residency) payload.residency_domain = residency;
  if (edge) payload.edge_site_code = edge;
  return payload;
}
export function buildDeploymentProfileTransitionPayload(input = {}) {
  const action = requiredText(input.action, "action", 32);
  if (!PROFILE_ACTIONS.has(action)) throw new Error("Deployment profile transition action is invalid.");
  const payload = {
    action,
    expected_version: whole(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER - 1),
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
  const targetKeys = ["target_profile_type", "target_deployment_reference", "target_region_code", "target_residency_domain", "target_edge_site_code"];
  const targetPresent = targetKeys.some((key) => input[key] !== undefined && input[key] !== "");
  if (action !== "START_MIGRATION" && targetPresent) throw new Error("Target profile fields are only allowed for START_MIGRATION.");
  if (action === "START_MIGRATION") {
    const profileType = requiredText(input.target_profile_type, "target_profile_type", 40);
    if (!DEPLOYMENT_PROFILES.has(profileType)) throw new Error("target_profile_type is invalid.");
    if (profileType === input.current_profile_type) throw new Error("Migration target profile must differ from the active profile type.");
    payload.target_profile_type = profileType;
    const deployment = optionalToken(input.target_deployment_reference, "target_deployment_reference", 200);
    const region = optionalToken(input.target_region_code, "target_region_code", 64);
    const residency = optionalToken(input.target_residency_domain, "target_residency_domain", 64);
    const edge = optionalToken(input.target_edge_site_code, "target_edge_site_code", 80);
    if (deployment) payload.target_deployment_reference = deployment;
    if (region) payload.target_region_code = region;
    if (residency) payload.target_residency_domain = residency;
    if (edge) payload.target_edge_site_code = edge;
  }
  return payload;
}
export function buildPhysicalOperationPayload(input = {}) {
  const payload = {
    expected_version: whole(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER - 1),
    idempotency_key: idempotency(input.idempotency_key),
    health_timeout_seconds: whole(input.health_timeout_seconds ?? 60, "health_timeout_seconds", 5, 300),
  };
  if (input.failure_policy !== undefined && input.failure_policy !== "") {
    if (!PHYSICAL_POLICIES.has(input.failure_policy)) throw new Error("failure_policy must be HALT or ROLLBACK.");
    payload.failure_policy = input.failure_policy;
  }
  return payload;
}
export function buildEffectiveReleaseQuery(input = {}) {
  const channel = requiredText(input.channel, "channel", 20);
  if (!RELEASE_CHANNELS.has(channel)) throw new Error("channel is invalid.");
  const subject = requiredText(input.subject_key, "subject_key", 200);
  const params = new URLSearchParams({ channel, subject_key: subject });
  if (input.factory_id) params.set("factory_id", uuid(input.factory_id, "factory_id"));
  const moduleKey = optionalToken(input.module_key, "module_key", 80);
  const agentKey = optionalToken(input.agent_key, "agent_key", 160);
  if (moduleKey) params.set("module_key", moduleKey);
  if (agentKey) params.set("agent_key", agentKey);
  return "?" + params.toString();
}

export function createSaasReleaseControlClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS session request function is required.");
  const releasePath = "/v2/saas/releases";
  const profilePath = "/v2/saas/deployment-profiles";
  const physicalPath = "/v2/saas/physical-provisioning";
  return Object.freeze({
    listReleases: () => request(releasePath),
    createRelease: (body) => request(releasePath, { method: "POST", body }),
    releaseHistory: (key) => request(releasePath + "/" + releaseKey(key) + "/history"),
    promoteRelease: (key, body) => request(releasePath + "/" + releaseKey(key) + "/promotions", { method: "POST", body }),
    transitionRelease: (key, body) => request(releasePath + "/" + releaseKey(key) + "/transitions", { method: "POST", body }),
    rollbackRelease: (key, body) => request(releasePath + "/" + releaseKey(key) + "/rollback", { method: "POST", body }),
    resolveRelease: (input) => request(releasePath + "/resolve" + buildEffectiveReleaseQuery(input)),
    listProfiles: (factoryId) => request(profilePath + (factoryId ? "?factory_id=" + uuid(factoryId, "factory_id") : "")),
    effectiveProfile: (factoryId) => request(profilePath + "/effective" + (factoryId ? "?factory_id=" + uuid(factoryId, "factory_id") : "")),
    createProfile: (body) => request(profilePath, { method: "POST", body }),
    tenantProfileHistory: () => request(profilePath + "/tenant/history"),
    factoryProfileHistory: (factoryId) => request(profilePath + "/factories/" + uuid(factoryId, "factory_id") + "/history"),
    transitionTenantProfile: (body) => request(profilePath + "/tenant/transitions", { method: "POST", body }),
    transitionFactoryProfile: (factoryId, body) => request(profilePath + "/factories/" + uuid(factoryId, "factory_id") + "/transitions", { method: "POST", body }),
    listPhysicalRuns: (limit = 25, offset = 0) => request(
      physicalPath + "/runs?limit=" + whole(limit, "limit", 1, 100) + "&offset=" + whole(offset, "offset", 0, 10000),
    ),
    getPhysicalRun: (runId) => request(physicalPath + "/runs/" + uuid(runId, "runId")),
    provisionProfile: (profileId, body) => request(
      physicalPath + "/deployment-profiles/" + uuid(profileId, "profileId") + "/provision", { method: "POST", body },
    ),
    deployRelease: (key, body) => request(
      physicalPath + "/releases/" + releaseKey(key) + "/deploy", { method: "POST", body },
    ),
  });
}
