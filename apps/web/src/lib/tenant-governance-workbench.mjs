const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTITLEMENT_STATUSES = new Set(["ACTIVE", "DISABLED", "EXPIRED"]);

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function bounded(value, field, max, min = 1) {
  const result = text(value);
  if (result.length < min || result.length > max) {
    throw new Error(field + " must contain " + min + " to " + max + " characters.");
  }
  return result;
}

function uuid(value, field) {
  const result = text(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result.toLowerCase();
}

function finiteNonNegative(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(field + " must be a finite non-negative number.");
  return result;
}

function timestamp(value, field) {
  const input = text(value);
  if (!input) return undefined;
  const result = new Date(input);
  if (!Number.isFinite(result.getTime())) throw new Error(field + " must be a valid date and time.");
  return result.toISOString();
}

function objectFromJson(value, field = "Configuration") {
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error(field + " must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(field + " must be a JSON object.");
  }
  return parsed;
}

function normalizeRows(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const row = value;
  if (preferredKey && Array.isArray(row[preferredKey])) return row[preferredKey];
  for (const key of ["items", "rows", "users", "roles", "permissions", "factories", "flags", "entitlements"]) {
    if (Array.isArray(row[key])) return row[key];
  }
  return row.data !== undefined ? normalizeRows(row.data, preferredKey) : [];
}

export function normalizeGovernanceRows(value, preferredKey = "items") {
  return normalizeRows(value, preferredKey);
}

export function buildGovernanceListQuery(filters = {}, kind = "users") {
  const params = new URLSearchParams();
  const limit = filters.limit === undefined ? 100 : Number(filters.limit);
  const offset = filters.offset === undefined ? 0 : Number(filters.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100.");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer.");
  if (kind === "users") {
    params.set("limit", String(limit));
  } else if (kind === "feature-flags" || kind === "entitlements") {
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (kind === "feature-flags") {
      if (text(filters.key)) params.set("key", bounded(filters.key, "Feature flag key", 200));
      if (filters.enabled !== undefined && filters.enabled !== "") {
        if (typeof filters.enabled !== "boolean") throw new Error("enabled must be boolean.");
        params.set("enabled", String(filters.enabled));
      }
      if (text(filters.owner)) params.set("owner", bounded(filters.owner, "Owner", 150));
      if (filters.security_critical !== undefined && filters.security_critical !== "") {
        if (typeof filters.security_critical !== "boolean") throw new Error("security_critical must be boolean.");
        params.set("security_critical", String(filters.security_critical));
      }
    } else {
      if (text(filters.package)) params.set("package", bounded(filters.package, "Package", 100));
      if (text(filters.feature_key)) params.set("feature_key", bounded(filters.feature_key, "Feature key", 150));
      if (text(filters.status)) {
        const status = text(filters.status).toUpperCase();
        if (!ENTITLEMENT_STATUSES.has(status)) throw new Error("Entitlement status is not supported.");
        params.set("status", status);
      }
    }
  } else {
    throw new Error("Unsupported governance list type.");
  }
  return "?" + params.toString();
}

export function buildAuthIdentityPayload(input = {}) {
  return {
    user_id: uuid(input.user_id, "user_id"),
    issuer: bounded(input.issuer, "Issuer", 500),
    subject: bounded(input.subject, "Subject", 255),
  };
}

export function buildFeatureFlagPayload(input = {}) {
  const key = bounded(input.key, "Feature flag key", 200);
  const owner = bounded(input.owner, "Owner", 150);
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be explicitly true or false.");
  const securityCritical = input.security_critical === true;
  const changeReason = text(input.change_reason);
  if (securityCritical && !changeReason) {
    throw new Error("Security-critical feature flag changes require a change reason.");
  }
  const effectiveFrom = timestamp(input.effective_from, "effective_from");
  const expiresAt = timestamp(input.expires_at, "expires_at");
  if (effectiveFrom && expiresAt && Date.parse(expiresAt) <= Date.parse(effectiveFrom)) {
    throw new Error("expires_at must be later than effective_from.");
  }
  return {
    key,
    enabled: input.enabled,
    owner,
    security_critical: securityCritical,
    ...(changeReason ? { change_reason: bounded(changeReason, "Change reason", 2000) } : {}),
    ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    config: objectFromJson(input.config ?? "{}", "Feature flag config"),
  };
}

export function buildEntitlementPayload(input = {}) {
  const packageName = bounded(input.package, "Package", 100);
  const featureKey = bounded(input.feature_key, "Feature key", 150);
  const status = text(input.status || "ACTIVE").toUpperCase();
  if (!ENTITLEMENT_STATUSES.has(status)) throw new Error("Entitlement status must be ACTIVE, DISABLED or EXPIRED.");
  const limitValue = finiteNonNegative(input.limit_value, "limit_value");
  const period = text(input.period);
  if (period.length > 50) throw new Error("period must not exceed 50 characters.");
  const effectiveFrom = timestamp(input.effective_from, "effective_from");
  const effectiveTo = timestamp(input.effective_to, "effective_to");
  if (effectiveFrom && effectiveTo && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
    throw new Error("effective_to must be later than effective_from.");
  }
  return {
    package: packageName,
    feature_key: featureKey,
    ...(limitValue !== null ? { limit_value: limitValue } : {}),
    ...(period ? { period: bounded(period, "Period", 50) } : {}),
    status,
    ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
    ...(input.effective_to ? { effective_to: effectiveTo } : {}),
    config: objectFromJson(input.config ?? "{}", "Entitlement config"),
  };
}

export function buildFlagEvaluationPath(key, at) {
  const normalizedKey = bounded(key, "Feature flag key", 200);
  const effectiveAt = timestamp(at, "Evaluation time");
  return "/admin/v1/feature-flags/" + encodeURIComponent(normalizedKey) + "/evaluate"
    + (effectiveAt ? "?at=" + encodeURIComponent(effectiveAt) : "");
}

export function summarizeGovernanceWorkspace({ users = [], roles = [], permissions = [], factories = [], featureFlags = [], entitlements = [] } = {}) {
  const latestFlags = new Map();
  for (const flag of featureFlags) {
    const key = String(flag.key ?? "");
    const version = Number(flag.version ?? 0);
    if (!latestFlags.has(key) || version > Number(latestFlags.get(key).version ?? 0)) latestFlags.set(key, flag);
  }
  return {
    users: users.length,
    roles: roles.length,
    permissions: permissions.length,
    activeFactories: factories.filter((factory) => String(factory.status).toUpperCase() === "ACTIVE").length,
    featureFlagVersions: featureFlags.length,
    latestFlags: latestFlags.size,
    enabledLatestFlags: Array.from(latestFlags.values()).filter((flag) => flag.enabled === true).length,
    securityCriticalLatestFlags: Array.from(latestFlags.values()).filter((flag) => flag.securityCritical === true).length,
    activeEntitlements: entitlements.filter((item) => String(item.status).toUpperCase() === "ACTIVE").length,
  };
}

export function filterGovernanceRows(rows = [], search = "") {
  const term = text(search).toLocaleLowerCase();
  if (!term) return rows;
  return rows.filter((row) => [
    row.id, row.email, row.display_name, row.code, row.name, row.description,
    row.key, row.owner, row.package, row.featureKey, row.feature_key, row.status,
  ].some((value) => String(value ?? "").toLocaleLowerCase().includes(term)));
}
