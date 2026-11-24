const PLAN_CODE = /^[A-Z][A-Z0-9_:-]{0,79}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DEPLOYMENTS = new Set(["SHARED_SAAS", "SINGLE_TENANT", "DEDICATED_VPC", "HYBRID_EDGE_CLOUD"]);
const PLAN_STATUSES = new Set(["ACTIVE", "DISABLED"]);
const TRANSITIONS = new Set(["ACTIVATE", "SUSPEND", "RESUME", "UPGRADE", "DOWNGRADE", "RENEW", "TERMINATE", "EXPIRE"]);
const MODES = new Set(["LEGACY_COMPATIBLE", "SUBSCRIPTION_REQUIRED"]);
const COLLECTIONS = new Set(["charge_automatically", "send_invoice"]);

function text(value, field, max = 255) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.trim().normalize("NFC");
  if (!result || result.length > max) throw new Error(field + " must contain 1 to " + max + " characters.");
  return result;
}
function enumValue(value, allowed, field) {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(field + " is invalid.");
  return value;
}
function idempotency(value) {
  const result = text(value, "idempotency_key", 128);
  if (!IDEMPOTENCY.test(result)) throw new Error("idempotency_key contains unsupported characters.");
  return result;
}
function integer(value, field, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(field + " must be a whole number from " + min + " to " + max + ".");
  }
  return result;
}
function timestamp(value, field) {
  const result = text(value, field, 80);
  if (!Number.isFinite(Date.parse(result))) throw new Error(field + " must be a valid ISO date/time.");
  return new Date(result).toISOString();
}
function plainObject(value, field) {
  let result = value;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { throw new Error(field + " must contain valid JSON."); }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(field + " must be a JSON object.");
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384) throw new Error(field + " must not exceed 16 KiB.");
  return result;
}
function currency(value) {
  const result = text(value, "currency", 3);
  if (!CURRENCY.test(result)) throw new Error("currency must be an uppercase 3-letter code.");
  return result;
}
function dateRange(startValue, endValue, maxDays, field = "period") {
  const start = timestamp(startValue, field + "_start");
  const end = timestamp(endValue, field + "_end");
  const elapsed = Date.parse(end) - Date.parse(start);
  if (elapsed <= 0) throw new Error(field + "_end must be after " + field + "_start.");
  if (elapsed > maxDays * 86_400_000) throw new Error(field + " exceeds the " + maxDays + "-day API limit.");
  return { start, end };
}

export function normalizeSaasCommercialRows(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  for (const key of ["items", "plans", "closes", "events", "rows", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.data && typeof value.data === "object") return normalizeSaasCommercialRows(value.data, preferredKey);
  return [];
}

export function buildSaasSubscriptionPlanPayload(input = {}) {
  const planCode = text(input.plan_code, "plan_code", 80).toUpperCase();
  if (!PLAN_CODE.test(planCode)) throw new Error("plan_code must use uppercase letters, numbers, underscore, colon or hyphen.");
  return {
    plan_code: planCode,
    display_name: text(input.display_name, "display_name", 160),
    tier_rank: integer(input.tier_rank, "tier_rank", 1, 1_000_000),
    deployment_profile: enumValue(input.deployment_profile || "SHARED_SAAS", DEPLOYMENTS, "deployment_profile"),
    status: enumValue(input.status || "ACTIVE", PLAN_STATUSES, "status"),
    capabilities: plainObject(input.capabilities ?? {}, "capabilities"),
    idempotency_key: idempotency(input.idempotency_key),
  };
}

export function buildSaasTrialPayload(input = {}, now = Date.now()) {
  const planCode = text(input.plan_code, "plan_code", 80).toUpperCase();
  if (!PLAN_CODE.test(planCode)) throw new Error("plan_code is invalid.");
  const trialEndsAt = timestamp(input.trial_ends_at, "trial_ends_at");
  if (Date.parse(trialEndsAt) <= now) throw new Error("trial_ends_at must be in the future.");
  return { plan_code: planCode, trial_ends_at: trialEndsAt, idempotency_key: idempotency(input.idempotency_key) };
}

export function buildSaasSubscriptionTransitionPayload(input = {}) {
  const action = enumValue(input.action, TRANSITIONS, "action");
  const payload = {
    action,
    expected_version: integer(input.expected_version, "expected_version", 1, 2_147_483_647),
    reason: text(input.reason, "reason", 1000),
    idempotency_key: idempotency(input.idempotency_key),
  };
  const target = input.target_plan_code?.trim() ? input.target_plan_code.trim().toUpperCase() : "";
  if (["UPGRADE", "DOWNGRADE"].includes(action)) {
    if (!PLAN_CODE.test(target)) throw new Error(action + " requires a valid target_plan_code.");
    payload.target_plan_code = target;
  } else if (target) {
    throw new Error("target_plan_code is only valid for UPGRADE or DOWNGRADE.");
  }
  const needsPeriod = ["ACTIVATE", "RESUME", "RENEW"].includes(action);
  const hasStart = Boolean(input.period_start);
  const hasEnd = Boolean(input.period_end);
  if (needsPeriod && (!hasStart || !hasEnd)) throw new Error(action + " requires period_start and period_end.");
  if (!needsPeriod && (hasStart || hasEnd)) throw new Error("Billing period dates are only valid for ACTIVATE, RESUME or RENEW.");
  if (needsPeriod) {
    payload.period_start = timestamp(input.period_start, "period_start");
    payload.period_end = timestamp(input.period_end, "period_end");
    if (Date.parse(payload.period_end) <= Date.parse(payload.period_start)) throw new Error("period_end must be later than period_start.");
  }
  if (input.effective_at) payload.effective_at = timestamp(input.effective_at, "effective_at");
  return payload;
}

export function buildSaasEntitlementModePayload(input = {}) {
  return {
    mode: enumValue(input.mode, MODES, "mode"),
    expected_version: integer(input.expected_version, "expected_version", 0, 1_000_000),
    reason: text(input.reason, "reason", 2000),
    idempotency_key: idempotency(input.idempotency_key),
  };
}

export function buildSaasBillingAccountPayload(input = {}) {
  const collectionMethod = enumValue(input.collection_method, COLLECTIONS, "collection_method");
  const automaticTax = input.automatic_tax_enabled === true;
  const taxBehavior = input.tax_behavior || "";
  const dueDays = input.days_until_due === "" || input.days_until_due === null || input.days_until_due === undefined
    ? null : integer(input.days_until_due, "days_until_due", 1, 120);
  if (collectionMethod === "send_invoice" && dueDays === null) throw new Error("days_until_due is required for send_invoice.");
  if (collectionMethod === "charge_automatically" && dueDays !== null) throw new Error("days_until_due must be omitted for automatic collection.");
  if (automaticTax && !["exclusive", "inclusive"].includes(taxBehavior)) throw new Error("tax_behavior is required when automatic tax is enabled.");
  if (!automaticTax && taxBehavior) throw new Error("tax_behavior is only valid when automatic tax is enabled.");
  return {
    provider_code: "stripe",
    provider_customer_id: text(input.provider_customer_id, "provider_customer_id", 120),
    currency: currency(input.currency),
    collection_method: collectionMethod,
    ...(dueDays === null ? {} : { days_until_due: dueDays }),
    automatic_tax_enabled: automaticTax,
    ...(automaticTax ? { tax_behavior: taxBehavior } : {}),
    expected_version: integer(input.expected_version, "expected_version", 0, 1_000_000),
    idempotency_key: idempotency(input.idempotency_key),
  };
}

export function buildSaasBillingClosePayload(input = {}) {
  const range = dateRange(input.period_start, input.period_end, 35, "period");
  return {
    period_start: range.start,
    period_end: range.end,
    currency: currency(input.currency),
    idempotency_key: idempotency(input.idempotency_key),
  };
}

export function buildSaasBillingActionPayload(input = {}) {
  return { idempotency_key: idempotency(input.idempotency_key) };
}

export function buildSaasBillingCloseQuery(input = {}) {
  const limit = integer(input.limit ?? 25, "limit", 1, 100);
  const offset = integer(input.offset ?? 0, "offset", 0, 100_000);
  return "?limit=" + encodeURIComponent(String(limit)) + "&offset=" + encodeURIComponent(String(offset));
}

export function createSaasCommercialClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS session request function is required.");
  const subscription = "/v2/saas/subscriptions";
  const billing = "/v2/saas/billing";
  const get = (path) => request(path);
  const post = (path, body) => request(path, { method: "POST", body });
  const id = (value) => encodeURIComponent(String(value));
  return Object.freeze({
    listPlans: () => get(subscription + "/plans"),
    createPlan: (body) => post(subscription + "/plans", body),
    getCurrentSubscription: () => get(subscription + "/current"),
    startTrial: (body) => post(subscription, body),
    listSubscriptionEvents: (subscriptionId) => get(subscription + "/" + id(subscriptionId) + "/events"),
    transitionSubscription: (subscriptionId, body) => post(subscription + "/" + id(subscriptionId) + "/transitions", body),
    getEntitlementMode: () => get(subscription + "/entitlement-mode"),
    setEntitlementMode: (body) => post(subscription + "/entitlement-mode", body),
    getBillingAccount: () => get(billing + "/provider-account"),
    configureBillingAccount: (body) => post(billing + "/provider-account", body),
    listBillingCloses: (input = {}) => get(billing + "/closes" + buildSaasBillingCloseQuery(input)),
    getBillingClose: (closeId) => get(billing + "/closes/" + id(closeId)),
    createBillingClose: (body) => post(billing + "/closes", body),
    issueInvoice: (closeId) => post(billing + "/closes/" + id(closeId) + "/issue", {}),
    retryPayment: (closeId, body) => post(billing + "/closes/" + id(closeId) + "/retry-payment", body),
    reconcileInvoice: (closeId, body) => post(billing + "/closes/" + id(closeId) + "/reconcile", body),
    listBillingReconciliations: (closeId) => get(billing + "/closes/" + id(closeId) + "/reconciliations"),
  });
}
