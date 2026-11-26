const UTILITY_TYPES = ["ELECTRICITY","GAS","STEAM","WATER","COMPRESSED_AIR","FUEL","OTHER"];
const READING_MODES = ["CUMULATIVE","INTERVAL"];
const READING_SOURCES = ["MANUAL","API","METER_GATEWAY","IMPORT"];
const EVENT_TYPES = ["OUTAGE","PEAK_LOAD","LEAK","PRESSURE_DROP","METER_FAULT","EFFICIENCY_EXCEPTION","OTHER"];
const SEVERITIES = ["LOW","MEDIUM","HIGH","CRITICAL"];
const EVENT_ACTIONS = ["ACKNOWLEDGE","RESOLVE","CANCEL"];
const ADAPTERS = ["REST_POLL","OPC_UA","MQTT","MODBUS","FILE_IMPORT","MANUAL_IMPORT"];
const METRICS = ["CONSUMPTION","COST","INTENSITY"];
const COMPARISONS = ["GT","GTE","LT","LTE"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, field, max = 255) {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(field + " is required and must be at most " + max + " characters.");
  return result;
}
function optional(value, field, max = 255) {
  const result = String(value ?? "").trim();
  if (!result) return undefined;
  if (result.length > max) throw new Error(field + " cannot exceed " + max + " characters.");
  return result;
}
function enumValue(value, field, choices) {
  const result = String(value ?? "").trim().toUpperCase();
  if (!choices.includes(result)) throw new Error("Unsupported " + field + ".");
  return result;
}
function uuid(value, field) {
  const result = text(value, field, 36);
  if (!UUID.test(result)) throw new Error(field + " must be a UUID.");
  return result.toLowerCase();
}
function integer(value, field, min = 1, max = 2147483647) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(field + " must be an integer from " + min + " to " + max + ".");
  return result;
}
function decimal(value, field, min = 0, maxPlaces = 8) {
  const raw = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(raw)) throw new Error(field + " must be a plain decimal with up to " + maxPlaces + " fractional digits.");
  const places = (raw.split(".")[1] ?? "").length;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < min || places > maxPlaces) throw new Error(field + " is outside the supported numeric range.");
  return Number(raw);
}
function positiveDecimalString(value, field) {
  const raw = text(value, field, 25);
  if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(field + " must be a positive decimal string with up to 8 fractional digits.");
  }
  return raw;
}
function instant(value, field) {
  const result = new Date(String(value ?? ""));
  if (!Number.isFinite(result.getTime())) throw new Error(field + " must be a valid date/time.");
  return result.toISOString();
}
function safeObject(value, field = "config_metadata") {
  if (value === undefined || value === null || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new Error(field + " must be valid JSON."); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(field + " must be a JSON object.");
  const encoded = JSON.stringify(parsed);
  if (new TextEncoder().encode(encoded).length > 8192) throw new Error(field + " must be at most 8 KiB.");
  const forbidden = /(?:secret|password|token|credential|private.?key|api.?key|authorization|cookie|client.?secret|access.?key)/i;
  const containsSensitiveKey = (node) => {
    if (Array.isArray(node)) return node.some(containsSensitiveKey);
    if (node && typeof node === "object") return Object.entries(node).some(([key, item]) => forbidden.test(key) || containsSensitiveKey(item));
    return false;
  };
  if (containsSensitiveKey(parsed)) throw new Error(field + " cannot contain secret or credential fields; use credential_reference.");
  return parsed;
}
function keyFor(input) {
  const value = text(input, "Idempotency-Key", 200);
  return value;
}

export function normalizeUtilityRows(value, nestedKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (nestedKey && Array.isArray(value[nestedKey])) return value[nestedKey];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.data)) return value.data;
  if (value.data && typeof value.data === "object") {
    if (nestedKey && Array.isArray(value.data[nestedKey])) return value.data[nestedKey];
    if (Array.isArray(value.data.items)) return value.data.items;
  }
  return [];
}

export function buildUtilityListQuery(input = {}, kind = "meters") {
  const params = new URLSearchParams();
  const limit = input.limit === undefined || input.limit === "" ? 100 : integer(input.limit, "limit", 1, 200);
  params.set("limit", String(limit));
  if (kind === "meters") {
    if (input.status && input.status !== "ALL") params.set("status", enumValue(input.status, "meter status", ["ACTIVE","INACTIVE","RETIRED"]));
    if (input.utility_type && input.utility_type !== "ALL") params.set("utility_type", enumValue(input.utility_type, "utility type", UTILITY_TYPES));
  } else if (kind === "events" || kind === "alerts") {
    if (input.status && input.status !== "ALL") params.set("status", enumValue(input.status, "event status", ["OPEN","ACKNOWLEDGED","RESOLVED","CANCELLED"]));
  } else if (kind !== "readings" && kind !== "bindings" && kind !== "policies") {
    throw new Error("Unsupported utility list kind.");
  }
  if (kind === "readings") {
    if (input.from) params.set("from", instant(input.from, "from"));
    if (input.to) params.set("to", instant(input.to, "to"));
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) throw new Error("from must be before or equal to to.");
  }
  return "?" + params.toString();
}

export function buildUtilityMeterPayload(input = {}) {
  const currency = (input.currency_code === undefined ? "BDT" : text(input.currency_code, "currency_code", 3)).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency_code must be a three-letter ISO currency code.");
  const multiplier = decimal(input.multiplier_factor === undefined || input.multiplier_factor === "" ? "1" : input.multiplier_factor, "multiplier_factor", 0.00000001);
  const unitCost = decimal(input.unit_cost === undefined || input.unit_cost === "" ? "0" : input.unit_cost, "unit_cost", 0);
  const parent = optional(input.parent_meter_id, "parent_meter_id", 36);
  return {
    meter_code: text(input.meter_code, "meter_code", 100).toUpperCase(),
    name: text(input.name, "name", 255),
    utility_type: enumValue(input.utility_type, "utility_type", UTILITY_TYPES),
    reading_mode: enumValue(input.reading_mode, "reading_mode", READING_MODES),
    unit_code: text(input.unit_code, "unit_code", 24),
    multiplier_factor: multiplier,
    unit_cost: unitCost,
    currency_code: currency,
    ...(optional(input.cost_center_code, "cost_center_code", 100) ? { cost_center_code: optional(input.cost_center_code, "cost_center_code", 100) } : {}),
    ...(optional(input.source_system_code, "source_system_code", 100) ? { source_system_code: optional(input.source_system_code, "source_system_code", 100) } : {}),
    ...(optional(input.location, "location", 255) ? { location: optional(input.location, "location", 255) } : {}),
    ...(parent ? { parent_meter_id: uuid(parent, "parent_meter_id") } : {})
  };
}

export function buildUtilityReadingPayload(input = {}) {
  const readingAt = instant(input.reading_at, "reading_at");
  const result = {
    reading_at: readingAt,
    reading_value: decimal(input.reading_value, "reading_value", 0),
    source_type: enumValue(input.source_type, "source_type", READING_SOURCES),
    ...(optional(input.source_event_id, "source_event_id", 255) ? { source_event_id: optional(input.source_event_id, "source_event_id", 255) } : {}),
    ...(input.production_quantity !== undefined && input.production_quantity !== "" ? { production_quantity: decimal(input.production_quantity, "production_quantity", 0.00000001) } : {}),
    ...(optional(input.notes, "notes", 2000) ? { notes: optional(input.notes, "notes", 2000) } : {})
  };
  return result;
}

export function buildUtilityEventPayload(input = {}) {
  const meter = optional(input.meter_id, "meter_id", 36);
  const minutes = input.impact_minutes === undefined || input.impact_minutes === "" ? 0 : integer(input.impact_minutes, "impact_minutes", 0, 1440);
  return {
    ...(meter ? { meter_id: uuid(meter, "meter_id") } : {}),
    event_type: enumValue(input.event_type, "event_type", EVENT_TYPES),
    severity: enumValue(input.severity, "severity", SEVERITIES),
    title: text(input.title, "title", 255),
    description: text(input.description, "description", 4000),
    occurred_at: instant(input.occurred_at, "occurred_at"),
    impact_minutes: minutes,
    ...(input.impact_quantity !== undefined && input.impact_quantity !== "" ? { impact_quantity: decimal(input.impact_quantity, "impact_quantity", 0) } : {}),
    ...(optional(input.cause, "cause", 2000) ? { cause: optional(input.cause, "cause", 2000) } : {})
  };
}

export function buildUtilityEventTransitionPayload(input = {}) {
  const action = enumValue(input.action, "event action", EVENT_ACTIONS);
  const payload = {
    expected_version: integer(input.expected_version, "expected_version"),
    action,
    reason: text(input.reason, "reason", 2000)
  };
  if (action === "RESOLVE") payload.resolution = text(input.resolution, "resolution", 4000);
  if (input.impact_minutes !== undefined && input.impact_minutes !== "") payload.impact_minutes = integer(input.impact_minutes, "impact_minutes", 0, 1440);
  if (input.impact_quantity !== undefined && input.impact_quantity !== "") payload.impact_quantity = decimal(input.impact_quantity, "impact_quantity", 0);
  return payload;
}

export function buildUtilitySourceBindingPayload(input = {}) {
  const adapter = enumValue(input.vendor_adapter, "vendor_adapter", ADAPTERS);
  const polling = input.polling_interval_seconds === undefined || input.polling_interval_seconds === "" ? undefined : integer(input.polling_interval_seconds, "polling_interval_seconds", 5, 86400);
  if (["REST_POLL","OPC_UA","MODBUS"].includes(adapter) && polling === undefined) throw new Error("Polling adapters require a polling interval from 5 to 86400 seconds.");
  const credential = optional(input.credential_reference, "credential_reference", 255);
  if (credential && !(/^(?:secrets?|vault|kms):\/\/[^\s]+$/i.test(credential) || /^arn:aws:secretsmanager:[^\s]+$/i.test(credential))) {
    throw new Error("credential_reference must be a secret-manager reference, never a credential value.");
  }
  const config = safeObject(input.config_metadata);
  const sourceCode = text(input.source_system_code, "source_system_code", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceCode)) throw new Error("source_system_code must be an alphanumeric code.");
  return {
    source_system_code: sourceCode,
    source_meter_code: text(input.source_meter_code, "source_meter_code", 160),
    vendor_adapter: adapter,
    meter_id: uuid(input.meter_id, "meter_id"),
    source_unit_code: text(input.source_unit_code, "source_unit_code", 24),
    factor_to_meter_unit: decimal(input.factor_to_meter_unit === undefined || input.factor_to_meter_unit === "" ? "1" : input.factor_to_meter_unit, "factor_to_meter_unit", 0.00000001),
    ...(polling !== undefined ? { polling_interval_seconds: polling } : {}),
    ...(credential ? { credential_reference: credential } : {}),
    config_metadata: config
  };
}

export function buildUtilitySourceBindingTransitionPayload(input = {}) {
  return {
    expected_version: integer(input.expected_version, "expected_version"),
    action: enumValue(input.action, "binding action", ["ACTIVATE","DEACTIVATE","RETIRE"]),
    reason: text(input.reason, "reason", 2000)
  };
}

export function buildUtilitySourceEventPayload(input = {}) {
  const sourceCode = text(input.source_system_code, "source_system_code", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceCode)) throw new Error("source_system_code must be an alphanumeric code.");
  return {
    source_system_code: sourceCode,
    source_meter_code: text(input.source_meter_code, "source_meter_code", 160),
    source_event_id: text(input.source_event_id, "source_event_id", 160),
    reading_at: instant(input.reading_at, "reading_at"),
    reading_value: decimal(input.reading_value, "reading_value", 0),
    source_unit_code: text(input.source_unit_code, "source_unit_code", 24),
    ...(input.production_quantity !== undefined && input.production_quantity !== "" ? { production_quantity: decimal(input.production_quantity, "production_quantity", 0.00000001) } : {}),
    ...(optional(input.notes, "notes", 2000) ? { notes: optional(input.notes, "notes", 2000) } : {})
  };
}

export function buildUtilityThresholdPolicyPayload(input = {}) {
  const meter = optional(input.meter_id, "meter_id", 36);
  const type = optional(input.utility_type, "utility_type", 40);
  if (!meter && !type) throw new Error("Select a meter or utility type for the threshold policy.");
  return {
    policy_code: text(input.policy_code, "policy_code", 100),
    name: text(input.name, "name", 255),
    ...(meter ? { meter_id: uuid(meter, "meter_id") } : {}),
    ...(type ? { utility_type: enumValue(type, "utility_type", UTILITY_TYPES) } : {}),
    metric: enumValue(input.metric, "metric", METRICS),
    comparison: enumValue(input.comparison, "comparison", COMPARISONS),
    threshold_value: decimal(input.threshold_value, "threshold_value", 0),
    threshold_unit_code: text(input.threshold_unit_code, "threshold_unit_code", 24),
    severity: enumValue(input.severity, "severity", SEVERITIES)
  };
}

export function buildUtilityThresholdPolicyTransitionPayload(input = {}) {
  return {
    expected_version: integer(input.expected_version, "expected_version"),
    action: enumValue(input.action, "policy action", ["ACTIVATE","DEACTIVATE","RETIRE"]),
    reason: text(input.reason, "reason", 2000)
  };
}

export function buildUtilityWorkOrderAllocationPayload(input = {}) {
  return {
    work_order_id: uuid(input.work_order_id, "work_order_id"),
    allocated_quantity: positiveDecimalString(input.allocated_quantity, "allocated_quantity"),
    reason: text(input.reason, "reason", 2000)
  };
}

export function buildUtilityAllocationReversePayload(input = {}) {
  return { reason: text(input.reason, "reason", 2000) };
}

export function summarizeUtilities(input = {}) {
  const meters = Array.isArray(input.meters) ? input.meters : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const policies = Array.isArray(input.policies) ? input.policies : [];
  const alerts = Array.isArray(input.alerts) ? input.alerts : [];
  const readings = Array.isArray(input.readings) ? input.readings : [];
  return {
    metersLoaded: meters.length,
    metersActive: meters.filter(row => String(row.status ?? "").toUpperCase() === "ACTIVE").length,
    eventsOpen: events.filter(row => ["OPEN","ACKNOWLEDGED"].includes(String(row.status ?? "").toUpperCase())).length,
    eventsCritical: events.filter(row => String(row.severity ?? "").toUpperCase() === "CRITICAL" && !["RESOLVED","CANCELLED"].includes(String(row.status ?? "").toUpperCase())).length,
    policiesActive: policies.filter(row => String(row.status ?? "").toUpperCase() === "ACTIVE").length,
    alertsOpen: alerts.filter(row => ["OPEN","ACKNOWLEDGED"].includes(String(row.status ?? "").toUpperCase())).length,
    readingsLoaded: readings.length
  };
}
