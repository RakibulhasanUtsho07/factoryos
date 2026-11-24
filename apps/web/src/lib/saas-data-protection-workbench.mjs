const DATASET_CATEGORIES = new Set([
  "BUSINESS_DATA", "AUDIT_LOG", "EVIDENCE", "APPROVALS", "EFFECTIVE_DATED_MASTER_DATA",
  "AI_CONTEXT", "LEARNING_EVALUATION", "INTEGRATION_METADATA", "FILE_REFERENCES", "IAM_ACCESS",
]);
const DISPOSITIONS = new Set(["DELETE", "ANONYMIZE", "REVIEW"]);
const REVIEW_DECISIONS = new Set(["APPROVE", "REJECT"]);
const EXTERNAL_REVIEW_DECISIONS = new Set(["APPROVE", "REJECT", "PAUSE", "RESUME"]);
const TRANSFER_SCHEMA = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const IDEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function text(value, field, min = 1, max = 1000) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.trim().normalize("NFC");
  if (result.length < min || result.length > max) throw new Error(field + " must contain " + min + " to " + max + " characters.");
  return result;
}
function enumValue(value, values, field) {
  if (typeof value !== "string" || !values.has(value)) throw new Error(field + " is invalid.");
  return value;
}
function positiveInteger(value, field, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(field + " must be a supported positive integer.");
  return number;
}
function key(value, field = "idempotency_key") {
  const normalized = text(value, field, 1, 128);
  if (!IDEM.test(normalized)) throw new Error(field + " contains unsupported characters.");
  return normalized;
}
function category(value) {
  return enumValue(value, DATASET_CATEGORIES, "category_code");
}
function reason(value) {
  return text(value, "reason", 3, 1000);
}
function uuid(value, field) {
  const normalized = text(value, field, 36, 36);
  if (!UUID.test(normalized)) throw new Error(field + " must be a valid UUID.");
  return normalized;
}
function digest(value, field) {
  const normalized = text(value, field, 64, 64);
  if (!DIGEST.test(normalized)) throw new Error(field + " must be a SHA-256 hex digest.");
  return normalized.toLowerCase();
}
function schemaVersion(value, field) {
  const normalized = text(value, field, 5, 32);
  if (!TRANSFER_SCHEMA.test(normalized)) throw new Error(field + " must use major.minor.patch schema notation.");
  return normalized;
}

export function normalizeDataProtectionRows(value, keyName) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const direct = keyName ? value[keyName] : undefined;
  if (Array.isArray(direct)) return direct;
  for (const name of ["items", "rows", "results", "records", "data"]) {
    if (Array.isArray(value[name])) return value[name];
    if (value[name] && typeof value[name] === "object" && Array.isArray(value[name].items)) return value[name].items;
  }
  return [];
}

export function buildRetentionPolicyPayload(input = {}) {
  return {
    category_code: category(input.category_code),
    retention_days: positiveInteger(input.retention_days, "retention_days", 36500),
    disposition: enumValue(input.disposition, DISPOSITIONS, "disposition"),
    legal_basis: text(input.legal_basis, "legal_basis", 3, 200),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildRetentionRunPayload(input = {}) {
  const mode = enumValue(input.mode, new Set(["DRY_RUN", "EXECUTE"]), "mode");
  return {
    mode,
    expected_policy_version: positiveInteger(input.expected_policy_version, "expected_policy_version"),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildLegalHoldPayload(input = {}) {
  if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 10) {
    throw new Error("Select between 1 and 10 legal-hold categories.");
  }
  const categories = input.categories.map(category);
  if (new Set(categories).size !== categories.length) throw new Error("Legal-hold categories must be unique.");
  return {
    categories,
    case_reference: text(input.case_reference, "case_reference", 1, 200),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildLegalHoldReleasePayload(input = {}) {
  return {
    expected_version: positiveInteger(input.expected_version, "expected_version"),
    reason: reason(input.reason),
  };
}
export function buildTenantErasurePayload(input = {}) {
  if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 10) {
    throw new Error("Select between 1 and 10 erasure categories.");
  }
  const categories = input.categories.map(category);
  if (new Set(categories).size !== categories.length) throw new Error("Erasure categories must be unique.");
  return {
    categories,
    export_transfer_id: uuid(input.export_transfer_id, "export_transfer_id"),
    export_transfer_version: positiveInteger(input.export_transfer_version, "export_transfer_version"),
    export_bundle_digest: digest(input.export_bundle_digest, "export_bundle_digest"),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildErasureReviewPayload(input = {}) {
  return {
    decision: enumValue(input.decision, REVIEW_DECISIONS, "decision"),
    expected_version: positiveInteger(input.expected_version, "expected_version"),
    reason: reason(input.reason),
  };
}
export function buildErasureExecutionPayload(input = {}) {
  return {
    expected_version: positiveInteger(input.expected_version, "expected_version"),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildErasurePropagationPayload(input = {}) {
  return buildErasureExecutionPayload(input);
}
export function buildExternalTargetPayload(input = {}) {
  const targetId = text(input.target_id, "target_id", 1, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(targetId)) throw new Error("target_id contains unsupported characters.");
  const adapterKey = text(input.adapter_key, "adapter_key", 1, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(adapterKey)) throw new Error("adapter_key contains unsupported characters.");
  const configReference = text(input.config_reference, "config_reference", 1, 200);
  if (/:\//.test(configReference) || /(secret|password|credential|access[-_]?key|token)/i.test(configReference)) {
    throw new Error("Use a non-secret configuration reference, not a URL or credential.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/i.test(configReference)) throw new Error("config_reference contains unsupported characters.");
  if (!Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 10) {
    throw new Error("Select between 1 and 10 external-target categories.");
  }
  const categories = input.categories.map(category);
  if (new Set(categories).size !== categories.length) throw new Error("External-target categories must be unique.");
  return {
    target_id: targetId,
    store_kind: text(input.store_kind, "store_kind", 1, 100),
    adapter_key: adapterKey,
    config_reference: configReference,
    categories,
    required: input.required !== false,
    registration_reason: reason(input.registration_reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildExternalTargetReviewPayload(input = {}) {
  return {
    decision: enumValue(input.decision, EXTERNAL_REVIEW_DECISIONS, "decision"),
    expected_status: enumValue(input.expected_status, new Set(["PENDING", "ACTIVE", "PAUSED"]), "expected_status"),
    reason: reason(input.reason),
  };
}
export function buildTenantExportPayload(input = {}) {
  const payload = {
    source_schema_version: schemaVersion(input.source_schema_version, "source_schema_version"),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
  if (Array.isArray(input.dataset_categories) && input.dataset_categories.length) {
    const categories = input.dataset_categories.map(category);
    if (new Set(categories).size !== categories.length) throw new Error("Export dataset categories must be unique.");
    if (categories.length > 9) throw new Error("An export can include at most 9 categories.");
    payload.dataset_categories = categories;
  }
  return payload;
}
export function buildMigrationValidationPayload(input = {}) {
  return {
    source_transfer_id: uuid(input.source_transfer_id, "source_transfer_id"),
    target_schema_version: schemaVersion(input.target_schema_version, "target_schema_version"),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildMigrationTransitionPayload(input = {}) {
  const action = enumValue(input.action, new Set(["START", "COMPLETE", "FAIL", "CANCEL"]), "action");
  const payload = {
    action,
    expected_version: positiveInteger(input.expected_version, "expected_version"),
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
  if (input.target_bundle_reference) {
    payload.target_bundle_reference = text(input.target_bundle_reference, "target_bundle_reference", 1, 200);
    payload.target_bundle_digest = digest(input.target_bundle_digest, "target_bundle_digest");
    if (!input.target_manifest || typeof input.target_manifest !== "object" || Array.isArray(input.target_manifest)) {
      throw new Error("target_manifest must be a JSON object when a target bundle is supplied.");
    }
    payload.target_manifest = input.target_manifest;
  }
  if (input.preservation_verified !== undefined) payload.preservation_verified = input.preservation_verified === true;
  return payload;
}
export function buildFinanceRetentionPayload(input = {}) {
  const adapterKey = text(input.finance_adapter_key, "finance_adapter_key", 1, 100);
  if (!SAFE_CODE.test(adapterKey)) throw new Error("finance_adapter_key contains unsupported characters.");
  return {
    retention_days: positiveInteger(input.retention_days, "retention_days", 36500),
    legal_basis: text(input.legal_basis, "legal_basis", 3, 200),
    finance_adapter_key: adapterKey,
    reason: reason(input.reason),
    idempotency_key: key(input.idempotency_key),
  };
}
export function buildFinanceRetentionReviewPayload(input = {}) {
  return {
    decision: enumValue(input.decision, REVIEW_DECISIONS, "decision"),
    expected_version: positiveInteger(input.expected_version, "expected_version"),
    reason: reason(input.reason),
  };
}
export function buildFinanceRetentionRunPayload(input = {}) {
  return buildRetentionRunPayload(input);
}

function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value).trim()) params.set(name, String(value).trim());
  }
  const query = params.toString();
  return query ? "?" + query : "";
}
function encodedId(value, field) {
  return encodeURIComponent(uuid(value, field));
}

export function createSaasDataProtectionClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS request function is required.");
  const get = (path) => request(path);
  const post = (path, body) => request(path, { method: "POST", body });
  const retention = "/v2/saas/data-retention";
  const transfers = "/v2/saas/data-transfers";
  return Object.freeze({
    listPolicies: () => get(retention + "/policies"),
    listPolicyHistory: (categoryCode) => get(retention + "/policies/history" + queryString({ categoryCode })),
    createPolicy: (body) => post(retention + "/policies", body),
    runPolicy: (categoryCode, body) => post(retention + "/policies/" + encodeURIComponent(category(categoryCode)) + "/run", body),
    listLegalHolds: (status, limit = 100) => get(retention + "/legal-holds" + queryString({ status, limit })),
    createLegalHold: (body) => post(retention + "/legal-holds", body),
    releaseLegalHold: (id, body) => post(retention + "/legal-holds/" + encodedId(id, "holdId") + "/release", body),
    listErasureRequests: (status, limit = 100) => get(retention + "/erasure-requests" + queryString({ status, limit })),
    createErasureRequest: (body) => post(retention + "/erasure-requests", body),
    reviewErasureRequest: (id, body) => post(retention + "/erasure-requests/" + encodedId(id, "requestId") + "/review", body),
    executeErasure: (id, body) => post(retention + "/erasure-requests/" + encodedId(id, "requestId") + "/execute", body),
    propagateErasure: (id, body) => post(retention + "/erasure-requests/" + encodedId(id, "requestId") + "/propagate", body),
    listErasureRuns: (id, limit = 100) => get(retention + "/erasure-requests/" + encodedId(id, "requestId") + "/runs" + queryString({ limit })),
    listPropagationRuns: (id, limit = 100) => get(retention + "/erasure-requests/" + encodedId(id, "requestId") + "/propagation-runs" + queryString({ limit })),
    listRetentionRuns: (filters = {}) => get(retention + "/runs" + queryString(filters)),
    listExternalTargets: () => get(retention + "/external-targets"),
    registerExternalTarget: (body) => post(retention + "/external-targets", body),
    reviewExternalTarget: (id, body) => post(retention + "/external-targets/" + encodeURIComponent(text(id, "targetId", 1, 200)) + "/review", body),
    listFinancePolicies: () => get(retention + "/finance-policies"),
    createFinancePolicy: (body) => post(retention + "/finance-policies", body),
    reviewFinancePolicy: (version, body) => post(retention + "/finance-policies/" + positiveInteger(version, "version") + "/review", body),
    runFinancePolicy: (version, body) => post(retention + "/finance-policies/" + positiveInteger(version, "version") + "/run", body),
    listFinanceRuns: (limit = 100) => get(retention + "/finance-runs" + queryString({ limit })),
    listTransfers: (operationType) => get(transfers + queryString({ operation_type: operationType })),
    createExport: (body) => post(transfers + "/exports", body),
    processExport: (id) => post(transfers + "/exports/" + encodedId(id, "transferId") + "/process", {}),
    attestExport: (id, body) => post(transfers + "/exports/" + encodedId(id, "transferId") + "/attest", body),
    validateMigration: (body) => post(transfers + "/migrations/validate", body),
    processMigration: (id) => post(transfers + "/migrations/" + encodedId(id, "transferId") + "/process", {}),
    transitionMigration: (id, body) => post(transfers + "/migrations/" + encodedId(id, "transferId") + "/transitions", body),
    listTransferHistory: (id) => get(transfers + "/" + encodedId(id, "transferId") + "/history"),
    listCompatibilityRules: () => get(transfers + "/compatibility-rules"),
    latestBackupProviderAcceptance: (categoryCode) => get(retention + "/backup-provider-acceptances/" + encodeURIComponent(category(categoryCode)) + "/latest"),
    currentBackupProviderAcceptance: (categoryCode) => get(retention + "/backup-provider-acceptances/" + encodeURIComponent(category(categoryCode)) + "/current"),
    latestBackupWriterInventory: (categoryCode) => get(retention + "/backup-writer-inventories/" + encodeURIComponent(category(categoryCode)) + "/latest"),
    currentBackupWriterInventory: (categoryCode) => get(retention + "/backup-writer-inventories/" + encodeURIComponent(category(categoryCode)) + "/current"),
    currentBackupCopyClassCoverage: (categoryCode) => get(retention + "/backup-copy-classes/" + encodeURIComponent(category(categoryCode)) + "/current"),
    currentExternalCopyCoverage: (categoryCode) => get(retention + "/external-copy-coverage/" + encodeURIComponent(category(categoryCode)) + "/current"),
  });
}
