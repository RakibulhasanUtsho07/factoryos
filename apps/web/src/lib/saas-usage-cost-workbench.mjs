const METRICS = new Set([
  "ACTIVE_USER", "ROLE_ASSIGNMENT", "TRANSACTION", "STORAGE_BYTE_HOUR", "TELEMETRY_EVENT",
  "AI_INPUT_TOKEN", "AI_OUTPUT_TOKEN", "AI_TOOL_CALL", "PREMIUM_WORKLOAD", "INTEGRATION_CALL", "EDGE_INFERENCE",
]);
const WORKLOADS = new Set(["PRODUCTION", "EVALUATION", "RED_TEAM", "SHADOW_MODE", "DEVELOPMENT", "NON_AI"]);
const SOURCES = new Set(["API", "AI_GATEWAY", "TOOL_GATEWAY", "TELEMETRY", "CONNECTOR", "EDGE_GATEWAY", "MANUAL"]);
const ADJUSTMENT_REASONS = new Set(["METER_CORRECTION", "PRICING_CORRECTION", "CUSTOMER_CREDIT", "CUSTOMER_DEBIT", "TAX_CORRECTION", "OTHER"]);
const NONCRITICAL = new Set(["EVALUATION", "RED_TEAM", "SHADOW_MODE", "DEVELOPMENT"]);
const PROVIDER_METRICS = new Set(["AI_INPUT_TOKEN", "AI_OUTPUT_TOKEN", "AI_TOOL_CALL", "PREMIUM_WORKLOAD", "EDGE_INFERENCE", "INTEGRATION_CALL"]);
const PROVIDER_SOURCES = new Set(["PROVIDER_EXPORT", "PROVIDER_API", "MANUAL"]);
const CURRENCIES = /^[A-Z]{3}$/;
const IDEM = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9._:-]{0,99}$/;
const PROVIDER = /^[a-z][a-z0-9._:-]{0,59}$/;

function text(value, field, max = 255, min = 1) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.trim().normalize("NFC");
  if (result.length < min || result.length > max) throw new Error(field + " must contain " + min + " to " + max + " characters.");
  return result;
}
function enumValue(value, allowed, field) {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(field + " is invalid.");
  return value;
}
function currency(value) {
  const result = text(value, "currency", 3, 3);
  if (!CURRENCIES.test(result)) throw new Error("currency must be an uppercase ISO-style 3-letter code.");
  return result;
}
function idempotency(value) {
  const result = text(value, "idempotency_key", 128);
  if (!IDEM.test(result)) throw new Error("idempotency_key contains unsupported characters.");
  return result;
}
function finiteNumber(value, field) {
  if (value === "" || value === null || value === undefined) throw new Error(field + " must be a finite number.");
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(field + " must be a finite number.");
  return n;
}
function decimal(value, field, minimum = 0.000001, maximum = 1_000_000_000_000) {
  const n = finiteNumber(value, field);
  if (n < minimum || n > maximum) throw new Error(field + " is outside the supported range.");
  const raw = String(value).toLowerCase();
  const fraction = raw.includes("e") ? "" : raw.split(".")[1] ?? "";
  if (fraction.length > 6) throw new Error(field + " supports at most 6 decimal places.");
  return n;
}
function minor(value, field, minimum = 0, maximum = 9_000_000_000_000_000) {
  const n = finiteNumber(value, field);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) {
    throw new Error(field + " must be a supported integer in minor currency units.");
  }
  return n;
}
function isoTimestamp(value, field) {
  const result = text(value, field, 80);
  if (!/T/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(field + " must be an ISO-8601 timestamp.");
  return new Date(result).toISOString();
}
function isoDate(value, field) {
  const result = text(value, field, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result + "T00:00:00.000Z"))) {
    throw new Error(field + " must be a YYYY-MM-DD date.");
  }
  return result;
}
function period(startValue, endValue, maxDays) {
  const startDate = isoDate(startValue, "period_start");
  const endDate = isoDate(endValue, "period_end");
  const start = new Date(startDate + "T00:00:00.000Z");
  const inclusiveEnd = new Date(endDate + "T00:00:00.000Z");
  if (inclusiveEnd < start) throw new Error("period_end must be on or after period_start.");
  const days = Math.floor((inclusiveEnd.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > maxDays) throw new Error("The selected period exceeds the " + maxDays + "-day API limit.");
  const exclusiveEnd = new Date(inclusiveEnd.getTime() + 86_400_000);
  return { period_start: start.toISOString(), period_end: exclusiveEnd.toISOString(), day_count: days };
}
function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(field + " must be a JSON object.");
  return value;
}

export function normalizeSaasRows(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value;
  if (preferredKey && Array.isArray(record[preferredKey])) return record[preferredKey];
  for (const key of ["items", "data", "rows", "rates", "events", "budgets", "evaluations", "controls", "alerts", "reconciliations"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  if (record.data && typeof record.data === "object") return normalizeSaasRows(record.data, preferredKey);
  return [];
}

export function buildSaasRateCardPayload(input = {}) {
  return {
    metric_code: enumValue(input.metric_code, METRICS, "metric_code"),
    rate_version: minor(input.rate_version, "rate_version", 1, 1_000_000),
    rate_minor_per_block: minor(input.rate_minor_per_block, "rate_minor_per_block"),
    block_quantity: decimal(input.block_quantity, "block_quantity"),
    currency: currency(input.currency),
    effective_from: isoTimestamp(input.effective_from, "effective_from"),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasUsageEventPayload(input = {}) {
  const capability_code = text(input.capability_code, "capability_code", 100);
  if (!CAPABILITY.test(capability_code)) throw new Error("capability_code has an invalid format.");
  return {
    metric_code: enumValue(input.metric_code, METRICS, "metric_code"),
    capability_code,
    workload_class: enumValue(input.workload_class, WORKLOADS, "workload_class"),
    quantity: decimal(input.quantity, "quantity"),
    occurred_at: isoTimestamp(input.occurred_at, "occurred_at"),
    source_system: enumValue(input.source_system, SOURCES, "source_system"),
    source_event_ref: text(input.source_event_ref, "source_event_ref", 255),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasUsageAdjustmentPayload(input = {}) {
  const selectedPeriod = period(input.period_start, input.period_end, 366);
  const quantity_delta = decimal(input.quantity_delta, "quantity_delta", -1_000_000_000_000, 1_000_000_000_000);
  const cost_delta_minor = minor(input.cost_delta_minor, "cost_delta_minor", -9_000_000_000_000_000);
  if (quantity_delta === 0 && cost_delta_minor === 0) throw new Error("An adjustment must change quantity or cost.");
  return {
    period_start: selectedPeriod.period_start,
    period_end: selectedPeriod.period_end,
    ...(input.metric_code ? { metric_code: enumValue(input.metric_code, METRICS, "metric_code") } : {}),
    quantity_delta,
    cost_delta_minor,
    currency: currency(input.currency),
    reason_code: enumValue(input.reason_code, ADJUSTMENT_REASONS, "reason_code"),
    reason: text(input.reason, "reason", 2000),
    ...(input.reference_ref?.trim() ? { reference_ref: text(input.reference_ref, "reference_ref", 255) } : {}),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasUsageReconciliationPayload(input = {}) {
  const selectedPeriod = period(input.period_start, input.period_end, 35);
  return {
    invoice_reference: text(input.invoice_reference, "invoice_reference", 180),
    reconciliation_version: minor(input.reconciliation_version, "reconciliation_version", 1, 1_000_000),
    period_start: selectedPeriod.period_start,
    period_end: selectedPeriod.period_end,
    currency: currency(input.currency),
    invoiced_amount_minor: minor(input.invoiced_amount_minor, "invoiced_amount_minor"),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasBudgetPayload(input = {}) {
  const budget_code = text(input.budget_code, "budget_code", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(budget_code)) throw new Error("budget_code has an invalid format.");
  const policy_version = minor(input.policy_version, "policy_version", 1, 1_000_000);
  const period_kind = enumValue(input.period_kind, new Set(["DAILY", "MONTHLY"]), "period_kind");
  const scope_level = enumValue(input.scope_level, new Set(["TENANT", "FACTORY"]), "scope_level");
  const soft_limit_minor = minor(input.soft_limit_minor, "soft_limit_minor");
  const hard_limit_minor = minor(input.hard_limit_minor, "hard_limit_minor");
  if (hard_limit_minor < soft_limit_minor) throw new Error("hard_limit_minor must be greater than or equal to soft_limit_minor.");
  const anomaly_multiplier = input.anomaly_multiplier === "" || input.anomaly_multiplier === undefined ? 3 : finiteNumber(input.anomaly_multiplier, "anomaly_multiplier");
  if (anomaly_multiplier < 1.5 || anomaly_multiplier > 100) throw new Error("anomaly_multiplier must be between 1.5 and 100.");
  const anomaly_min_events = input.anomaly_min_events === "" || input.anomaly_min_events === undefined ? 10 : minor(input.anomaly_min_events, "anomaly_min_events", 3);
  if (anomaly_min_events > 100000) throw new Error("anomaly_min_events must not exceed 100000.");
  const effective_from = isoTimestamp(input.effective_from, "effective_from");
  const effective_to = input.effective_to?.trim() ? isoTimestamp(input.effective_to, "effective_to") : undefined;
  if (effective_to && Date.parse(effective_to) <= Date.parse(effective_from)) throw new Error("effective_to must be later than effective_from.");
  if (input.pause_noncritical_on_hard_limit !== undefined && typeof input.pause_noncritical_on_hard_limit !== "boolean") {
    throw new Error("pause_noncritical_on_hard_limit must be boolean.");
  }
  return {
    budget_code, policy_version, period_kind, scope_level,
    ...(input.metric_code ? { metric_code: enumValue(input.metric_code, METRICS, "metric_code") } : {}),
    ...(input.capability_code?.trim() ? { capability_code: (() => { const code = text(input.capability_code, "capability_code", 100); if (!CAPABILITY.test(code)) throw new Error("capability_code has an invalid format."); return code; })() } : {}),
    ...(input.workload_class ? { workload_class: enumValue(input.workload_class, WORKLOADS, "workload_class") } : {}),
    currency: currency(input.currency), soft_limit_minor, hard_limit_minor,
    ...(input.pause_noncritical_on_hard_limit !== undefined ? { pause_noncritical_on_hard_limit: input.pause_noncritical_on_hard_limit } : {}),
    anomaly_multiplier, anomaly_min_events, effective_from,
    ...(effective_to ? { effective_to } : {}),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasWorkloadControlPayload(input = {}) {
  return {
    workload_class: enumValue(input.workload_class, NONCRITICAL, "workload_class"),
    control_state: enumValue(input.control_state, new Set(["PAUSED", "RESUMED"]), "control_state"),
    scope_level: enumValue(input.scope_level, new Set(["TENANT", "FACTORY"]), "scope_level"),
    reason: text(input.reason, "reason", 1000),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasAlertAcknowledgementPayload(input = {}) {
  return { idempotency_key: idempotency(input.idempotency_key) };
}
export function buildSaasProviderCostEventPayload(input = {}) {
  const provider_code = text(input.provider_code, "provider_code", 60);
  if (!PROVIDER.test(provider_code)) throw new Error("provider_code has an invalid format.");
  const model_code = input.model_code?.trim() ? text(input.model_code, "model_code", 100) : undefined;
  if (model_code && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model_code)) throw new Error("model_code has an invalid format.");
  return {
    provider_code, ...(model_code ? { model_code } : {}),
    metric_code: enumValue(input.metric_code, PROVIDER_METRICS, "metric_code"),
    workload_class: enumValue(input.workload_class, WORKLOADS, "workload_class"),
    quantity: decimal(input.quantity, "quantity"),
    currency: currency(input.currency),
    provider_cost_minor: minor(input.provider_cost_minor, "provider_cost_minor"),
    occurred_at: isoTimestamp(input.occurred_at, "occurred_at"),
    ...(input.provider_invoice_reference?.trim() ? { provider_invoice_reference: text(input.provider_invoice_reference, "provider_invoice_reference", 180) } : {}),
    source_system: enumValue(input.source_system, PROVIDER_SOURCES, "source_system"),
    source_event_ref: text(input.source_event_ref, "source_event_ref", 255),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasProviderReconciliationPayload(input = {}) {
  const selectedPeriod = period(input.period_start, input.period_end, 35);
  const provider_code = text(input.provider_code, "provider_code", 60);
  if (!PROVIDER.test(provider_code)) throw new Error("provider_code has an invalid format.");
  return {
    provider_code,
    invoice_reference: text(input.invoice_reference, "invoice_reference", 180),
    reconciliation_version: minor(input.reconciliation_version, "reconciliation_version", 1),
    period_start: selectedPeriod.period_start,
    period_end: selectedPeriod.period_end,
    currency: currency(input.currency),
    invoiced_provider_cost_minor: minor(input.invoiced_provider_cost_minor, "invoiced_provider_cost_minor"),
    idempotency_key: idempotency(input.idempotency_key),
  };
}
export function buildSaasUsageReportQuery(fromValue, toValue) {
  const selectedPeriod = period(fromValue, toValue, 366);
  return "from=" + encodeURIComponent(selectedPeriod.period_start) + "&to=" + encodeURIComponent(selectedPeriod.period_end);
}
export function buildSaasBudgetEvaluationQuery(asOf) {
  return asOf ? "?as_of=" + encodeURIComponent(isoTimestamp(asOf, "as_of")) : "";
}
export function buildSaasAlertQuery(input = {}) {
  const limit = input.limit === undefined ? 25 : minor(input.limit, "limit", 1);
  const offset = input.offset === undefined ? 0 : minor(input.offset, "offset", 0);
  if (limit > 100 || offset > 10000) throw new Error("Alert pagination is outside API bounds.");
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), unread_only: String(input.unread_only === true) });
  return "?" + params.toString();
}
export function createSaasUsageClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS session request function is required.");
  const base = "/v2/saas/usage";
  const get = (path) => request(path);
  const post = (path, body) => request(path, { method: "POST", body });
  const id = (value) => encodeURIComponent(String(value));
  return Object.freeze({
    listRates: (metricCode) => get(base + "/rates" + (metricCode ? "?metric_code=" + encodeURIComponent(metricCode) : "")),
    createRate: (body) => post(base + "/rates", body),
    report: (from, to) => get(base + "/report?" + buildSaasUsageReportQuery(from, to)),
    recordEvent: (body) => post(base + "/events", body),
    createAdjustment: (body) => post(base + "/adjustments", body),
    reconcileUsage: (body) => post(base + "/reconciliations", body),
    listReconciliations: (limit = 25, offset = 0) => get(base + "/reconciliations?limit=" + encodeURIComponent(String(limit)) + "&offset=" + encodeURIComponent(String(offset))),
    listBudgets: () => get(base + "/budgets"),
    createBudget: (body) => post(base + "/budgets", body),
    evaluateBudgets: (asOf) => post(base + "/budgets/evaluate" + buildSaasBudgetEvaluationQuery(asOf), {}),
    listBudgetEvaluations: (limit = 25, offset = 0) => get(base + "/budgets/evaluations?limit=" + encodeURIComponent(String(limit)) + "&offset=" + encodeURIComponent(String(offset))),
    listWorkloadControls: () => get(base + "/workloads/controls"),
    setWorkloadControl: (body) => post(base + "/workloads/control", body),
    listAlerts: (input = {}) => get(base + "/alerts" + buildSaasAlertQuery(input)),
    acknowledgeAlert: (alertId, body) => post(base + "/alerts/" + id(alertId) + "/acknowledgements", body),
    recordProviderCost: (body) => post(base + "/provider-cost-events", body),
    reconcileProviderInvoice: (body) => post(base + "/provider-cost-reconciliations", body),
    listProviderReconciliations: (limit = 25, offset = 0) => get(base + "/provider-cost-reconciliations?limit=" + encodeURIComponent(String(limit)) + "&offset=" + encodeURIComponent(String(offset))),
  });
}
