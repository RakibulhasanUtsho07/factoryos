const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSES = new Set(["DEMO", "TEST", "EVALUATION", "TRAINING"]);
const DATA_MODES = new Set(["SYNTHETIC", "MASKED"]);
const SANDBOX_ACTIONS = new Set(["SUSPEND", "RESUME", "RETIRE"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function requiredText(value, field, max) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > max) throw new Error(field + " must contain 1 to " + max + " characters.");
  return normalized;
}
function opaqueReference(value, field, max) {
  const normalized = requiredText(value, field, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized) || normalized.length > max || normalized.includes("://")) {
    throw new Error(field + " must be an opaque reference ID, not a URL or path.");
  }
  return normalized;
}
function uuid(value, field) {
  const normalized = requiredText(value, field, 36).toLowerCase();
  if (!UUID.test(normalized)) throw new Error(field + " must be a UUID.");
  return normalized;
}
function integer(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(field + " must be an integer from " + min + " to " + max + ".");
  }
  return normalized;
}
function idempotency(value) {
  const normalized = requiredText(value, "idempotency_key", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error("idempotency_key format is invalid.");
  }
  return normalized;
}
function reason(value) {
  return requiredText(value, "reason", 1000);
}
function isoDate(value, field) {
  if (typeof value !== "string" && !(value instanceof Date)) throw new Error(field + " must be a valid date.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(field + " must be a valid date.");
  return date.toISOString();
}
function recordCount(value) {
  return integer(value, "record_count", 0, 100000000);
}
function manifestForSynthetic(input) {
  return {
    generator: requiredText(input.generator, "dataset_manifest.generator", 100),
    generator_version: requiredText(input.generator_version, "dataset_manifest.generator_version", 80),
    schema_version: requiredText(input.schema_version, "dataset_manifest.schema_version", 80),
    seed: requiredText(input.seed, "dataset_manifest.seed", 128),
    record_count: recordCount(input.record_count),
  };
}
function manifestForMasked(input) {
  const maskedAt = isoDate(input.masked_at, "dataset_manifest.masked_at");
  if (new Date(maskedAt).getTime() > Date.now()) throw new Error("dataset_manifest.masked_at cannot be in the future.");
  const checksum = requiredText(input.checksum_sha256, "dataset_manifest.checksum_sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("dataset_manifest.checksum_sha256 must be a SHA-256 hex digest.");
  return {
    dataset_reference: opaqueReference(input.dataset_reference, "dataset_manifest.dataset_reference", 200),
    schema_version: requiredText(input.schema_version, "dataset_manifest.schema_version", 80),
    record_count: recordCount(input.record_count),
    masking_policy_version: requiredText(input.masking_policy_version, "dataset_manifest.masking_policy_version", 80),
    masked_at: maskedAt,
    checksum_sha256: checksum,
  };
}
function privacyAssessment(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("privacy_assessment is required for masked datasets.");
  const residualRisk = requiredText(input.residual_risk, "privacy_assessment.residual_risk", 10);
  if (!["LOW", "MEDIUM"].includes(residualRisk)) throw new Error("HIGH or unknown residual risk is not eligible for sandbox approval.");
  if (!Array.isArray(input.reviewed_fields) || input.reviewed_fields.length < 1 || input.reviewed_fields.length > 100) {
    throw new Error("privacy_assessment.reviewed_fields must contain 1 to 100 field identifiers.");
  }
  const reviewedFields = [...new Set(input.reviewed_fields.map((field, index) => {
    const name = requiredText(field, "reviewed_fields[" + index + "]", 120);
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(name)) throw new Error("Reviewed fields must be schema field identifiers.");
    return name;
  }))].sort();
  const assessedAt = isoDate(input.assessed_at, "privacy_assessment.assessed_at");
  if (new Date(assessedAt).getTime() > Date.now()) throw new Error("privacy_assessment.assessed_at cannot be in the future.");
  return {
    data_minimization_status: "ASSESSED",
    residual_risk: residualRisk,
    reviewed_fields: reviewedFields,
    assessed_at: assessedAt,
  };
}

export function normalizeSandboxRows(value) {
  if (Array.isArray(value)) return value;
  const root = object(value);
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.environments)) return root.environments;
  if (root.data && typeof root.data === "object") return normalizeSandboxRows(root.data);
  return [];
}
export function normalizeSandboxEvents(value) {
  if (Array.isArray(value)) return value;
  const root = object(value);
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.events)) return root.events;
  if (root.data && typeof root.data === "object") return normalizeSandboxEvents(root.data);
  return [];
}
export function normalizeSandboxMutation(value) {
  const root = object(value);
  const nested = object(root.data);
  const source = Object.keys(object(root.environment)).length > 0 ? root
    : Object.keys(object(nested.environment)).length > 0 ? nested : root;
  return {
    environment: object(source.environment),
    event: Object.keys(object(source.event)).length > 0 ? object(source.event) : null,
    replayed: source.replayed === true || root.replayed === true,
  };
}
export function normalizePhysicalRunRows(value) {
  const root = object(value);
  if (Array.isArray(root.runs)) return root.runs;
  if (Array.isArray(root.items)) return root.items;
  if (root.data && typeof root.data === "object") return normalizePhysicalRunRows(root.data);
  return Array.isArray(value) ? value : [];
}
export function normalizePhysicalRunDetail(value) {
  const root = object(value);
  const nested = object(root.data);
  const source = Object.keys(object(root.run)).length > 0 ? root
    : Object.keys(object(nested.run)).length > 0 ? nested : root;
  return {
    run: object(source.run),
    events: Array.isArray(source.events) ? source.events : [],
    idempotent: root.idempotent === true || source.idempotent === true,
  };
}
export function summarizeSandboxes(input) {
  const rows = normalizeSandboxRows(input);
  return {
    total: rows.length,
    synthetic: rows.filter((item) => item?.dataMode === "SYNTHETIC").length,
    masked: rows.filter((item) => item?.dataMode === "MASKED").length,
    pendingApproval: rows.filter((item) => item?.status === "PENDING_APPROVAL").length,
    active: rows.filter((item) => item?.status === "ACTIVE" && item?.effectiveStatus !== "APPROVAL_EXPIRED").length,
    suspended: rows.filter((item) => item?.status === "SUSPENDED").length,
    approvalExpired: rows.filter((item) => item?.effectiveStatus === "APPROVAL_EXPIRED").length,
    retired: rows.filter((item) => item?.status === "RETIRED").length,
  };
}
export function filterSandboxes(input, filters = {}) {
  const query = typeof filters.query === "string" ? filters.query.trim().toLowerCase() : "";
  const status = filters.status || "ALL";
  const dataMode = filters.dataMode || "ALL";
  const purpose = filters.purpose || "ALL";
  return normalizeSandboxRows(input).filter((item) => {
    const haystack = [item?.environmentCode, item?.displayName, item?.purpose, item?.dataMode].join(" ").toLowerCase();
    return (!query || haystack.includes(query))
      && (status === "ALL" || item?.effectiveStatus === status || item?.status === status)
      && (dataMode === "ALL" || item?.dataMode === dataMode)
      && (purpose === "ALL" || item?.purpose === purpose);
  });
}
export function buildCreateSandboxPayload(input = {}) {
  const code = requiredText(input.environment_code, "environment_code", 48).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,47}$/.test(code)) throw new Error("environment_code format is invalid.");
  const purpose = requiredText(input.purpose, "purpose", 20);
  if (!PURPOSES.has(purpose)) throw new Error("purpose is invalid.");
  const dataMode = requiredText(input.data_mode, "data_mode", 20);
  if (!DATA_MODES.has(dataMode)) throw new Error("data_mode must be SYNTHETIC or MASKED.");
  const payload = {
    environment_code: code,
    display_name: requiredText(input.display_name, "display_name", 160),
    purpose,
    data_mode: dataMode,
    dataset_manifest: dataMode === "SYNTHETIC" ? manifestForSynthetic(input) : manifestForMasked(input),
    idempotency_key: idempotency(input.idempotency_key),
  };
  if (dataMode === "MASKED") payload.privacy_assessment = privacyAssessment(input);
  return payload;
}
export function buildMaskedApprovalPayload(input = {}) {
  const expiresAt = isoDate(input.approval_expires_at, "approval_expires_at");
  const expiresMs = new Date(expiresAt).getTime();
  if (expiresMs <= Date.now()) throw new Error("approval_expires_at must be in the future.");
  if (expiresMs > Date.now() + 90 * 24 * 60 * 60 * 1000) {
    throw new Error("Masked-data approval cannot exceed 90 days.");
  }
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
    reason: reason(input.reason),
    approval_expires_at: expiresAt,
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSandboxTransitionPayload(input = {}) {
  const action = requiredText(input.action, "action", 20);
  if (!SANDBOX_ACTIONS.has(action)) throw new Error("Sandbox transition action is invalid.");
  return {
    action,
    expected_version: integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER),
    reason: reason(input.reason),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSandboxPhysicalPayload(input = {}) {
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, Number.MAX_SAFE_INTEGER - 1),
    idempotency_key: idempotency(input.idempotency_key),
    health_timeout_seconds: integer(input.health_timeout_seconds ?? 60, "health_timeout_seconds", 5, 300),
  };
}

export function createSaasSandboxClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS session request function is required.");
  const sandboxPath = "/v2/saas/sandboxes";
  const physicalPath = "/v2/saas/physical-provisioning";
  return Object.freeze({
    listEnvironments: () => request(sandboxPath),
    createEnvironment: (body) => request(sandboxPath, { method: "POST", body }),
    events: (environmentId) => request(sandboxPath + "/" + uuid(environmentId, "environmentId") + "/events"),
    approveMaskedData: (environmentId, body) => request(
      sandboxPath + "/" + uuid(environmentId, "environmentId") + "/approve-masked-data", { method: "POST", body },
    ),
    transition: (environmentId, body) => request(
      sandboxPath + "/" + uuid(environmentId, "environmentId") + "/transitions", { method: "POST", body },
    ),
    listPhysicalRuns: (limit = 25, offset = 0) => request(
      physicalPath + "/runs?limit=" + integer(limit, "limit", 1, 100) + "&offset=" + integer(offset, "offset", 0, 10000),
    ),
    physicalRun: (runId) => request(physicalPath + "/runs/" + uuid(runId, "runId")),
    provision: (environmentId, body) => request(
      physicalPath + "/sandboxes/" + uuid(environmentId, "environmentId") + "/provision", { method: "POST", body },
    ),
  });
}
