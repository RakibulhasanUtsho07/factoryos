const EVENT_TYPE = /^[A-Z][A-Z0-9_.-]{0,149}$/;
const SOURCE_SYSTEM = /^[A-Z0-9][A-Z0-9._-]{1,119}$/;
const SECRET_REFERENCE = /^env:\/\/WEBHOOK_SECRET_[A-Z][A-Z0-9_]{0,79}$/;
const DOMAINS = new Set(["ATTENDANCE", "PRODUCTION", "QUALITY"]);
const DELIVERY_CLASSES = new Set(["ON_TIME", "LATE"]);
const CONNECTOR_STATUSES = new Set(["PENDING_REVIEW", "ACTIVE", "PAUSED", "REJECTED"]);
const CASE_STATUSES = new Set(["OPEN", "RESOLVED", "WAIVED"]);
const CASE_TYPES = new Set([
  "MISSING_EVENT_TIME", "INVALID_EVENT_TIME", "INVALID_SEQUENCE",
  "MISSING_SEQUENCE_RANGE", "SEQUENCE_COLLISION", "CROSS_SOURCE_CONFLICT",
  "CONFLICTING_DUPLICATE", "DUPLICATE_BUSINESS_EVENT", "BUSINESS_EVENT_CONFLICT",
]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SENSITIVE_PROPERTY = /(password|token|secret|credential|api.?key|authorization|private.?key|client.?secret)/i;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function validateSchemaNode(value, path, depth) {
  if (!isRecord(value)) throw new Error(path + " must be an object.");
  if (depth > 8) throw new Error(path + " exceeds the maximum schema depth of 8.");
  const type = value.type;
  if (typeof type !== "string" || !SCHEMA_TYPES.has(type)) {
    throw new Error(path + ".type must be a supported JSON type.");
  }
  const allowed = {
    object: new Set(["type", "properties", "required", "additionalProperties", "maxProperties", "enum"]),
    array: new Set(["type", "items", "maxItems", "enum"]),
    string: new Set(["type", "minLength", "maxLength", "enum"]),
    number: new Set(["type", "minimum", "maximum", "enum"]),
    integer: new Set(["type", "minimum", "maximum", "enum"]),
    boolean: new Set(["type", "enum"]),
    null: new Set(["type", "enum"]),
  }[type];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(path + " contains unsupported schema keyword " + key + ".");
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 100) {
      throw new Error(path + ".enum must contain 1 to 100 values.");
    }
    for (const entry of value.enum) {
      const actual = jsonType(entry);
      if (actual !== type && !(type === "number" && typeof entry === "number")) {
        throw new Error(path + ".enum values must match the schema type.");
      }
    }
  }
  if (type === "object") {
    if (!isRecord(value.properties)) throw new Error(path + ".properties must be an object.");
    const keys = Object.keys(value.properties);
    if (keys.length > 100) throw new Error(path + ".properties cannot exceed 100 keys.");
    if (value.additionalProperties !== undefined && value.additionalProperties !== false) {
      throw new Error(path + ".additionalProperties must be false.");
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.length > 100 ||
        value.required.some((entry) => typeof entry !== "string") ||
        new Set(value.required).size !== value.required.length) {
        throw new Error(path + ".required must be a unique string array.");
      }
      for (const key of value.required) {
        if (!Object.hasOwn(value.properties, key)) throw new Error(path + ".required references an undefined property.");
      }
    }
    if (value.maxProperties !== undefined &&
      (!Number.isInteger(value.maxProperties) || value.maxProperties < 0 || value.maxProperties > 100)) {
      throw new Error(path + ".maxProperties must be an integer from 0 to 100.");
    }
    for (const [key, child] of Object.entries(value.properties)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new Error(path + " contains an unsafe property name.");
      }
      if (SENSITIVE_PROPERTY.test(key)) throw new Error(path + " cannot accept credential-like properties.");
      validateSchemaNode(child, path + ".properties." + key, depth + 1);
    }
  } else if (type === "array") {
    if (!Object.hasOwn(value, "items")) throw new Error(path + ".items is required for arrays.");
    if (!Number.isInteger(value.maxItems) || value.maxItems < 0 || value.maxItems > 1000) {
      throw new Error(path + ".maxItems is required and must be an integer from 0 to 1000.");
    }
    validateSchemaNode(value.items, path + ".items", depth + 1);
  } else if (type === "string") {
    const minLength = value.minLength ?? 0;
    const maxLength = value.maxLength ?? 10000;
    if (!Number.isInteger(minLength) || minLength < 0 || minLength > 10000 ||
      !Number.isInteger(maxLength) || maxLength < minLength || maxLength > 10000) {
      throw new Error(path + " has an invalid string length limit.");
    }
  } else if (type === "number" || type === "integer") {
    if (value.minimum !== undefined && (typeof value.minimum !== "number" || !Number.isFinite(value.minimum))) {
      throw new Error(path + ".minimum must be finite.");
    }
    if (value.maximum !== undefined && (typeof value.maximum !== "number" || !Number.isFinite(value.maximum))) {
      throw new Error(path + ".maximum must be finite.");
    }
    if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) {
      throw new Error(path + ".minimum cannot exceed maximum.");
    }
  }
}

export function validateIntegrationPayloadSchema(input) {
  let schema = input;
  if (typeof input === "string") {
    try { schema = JSON.parse(input); }
    catch { throw new Error("Payload schema must contain valid JSON."); }
  }
  if (!isRecord(schema)) throw new Error("Payload schema must be a JSON object.");
  let serialized;
  try { serialized = JSON.stringify(schema); }
  catch { throw new Error("Payload schema must be serializable JSON."); }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 32 * 1024) {
    throw new Error("Payload schema cannot exceed 32 KiB.");
  }
  validateSchemaNode(schema, "$", 0);
  if (schema.type !== "object") throw new Error("Payload schema root type must be object.");
  return schema;
}

export function normalizeIntegrationRows(value, preferredKey = "") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.rows)) return value.rows;
  if (value.data !== undefined) return normalizeIntegrationRows(value.data, preferredKey);
  return [];
}

export function buildIntegrationConnectorPayload(input) {
  const displayName = clean(input.display_name);
  const sourceSystem = clean(input.source_system).toUpperCase();
  const secretReference = clean(input.secret_reference);
  const schemaVersion = Number(input.schema_version);
  if (displayName.length < 2 || displayName.length > 160) {
    throw new Error("Display name must contain 2 to 160 characters.");
  }
  if (!SOURCE_SYSTEM.test(sourceSystem)) {
    throw new Error("Source system must use a canonical uppercase identifier.");
  }
  if (!SECRET_REFERENCE.test(secretReference)) {
    throw new Error("Secret reference must use env://WEBHOOK_SECRET_<ALIAS>.");
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 10000) {
    throw new Error("Schema version must be an integer between 1 and 10000.");
  }
  const rawEvents = Array.isArray(input.allowed_event_types)
    ? input.allowed_event_types
    : String(input.allowed_event_types ?? "").split(/[\r\n,]+/);
  const eventTypes = rawEvents.map((item) => clean(item).toUpperCase()).filter(Boolean);
  if (eventTypes.length < 1 || eventTypes.length > 100 ||
    eventTypes.some((item) => !EVENT_TYPE.test(item)) ||
    new Set(eventTypes).size !== eventTypes.length) {
    throw new Error("Allowed event types must contain 1 to 100 unique canonical identifiers.");
  }
  const payloadSchema = validateIntegrationPayloadSchema(input.payload_schema);
  return {
    display_name: displayName,
    source_system: sourceSystem,
    secret_reference: secretReference,
    schema_version: schemaVersion,
    allowed_event_types: eventTypes,
    payload_schema: payloadSchema,
  };
}

export function buildIntegrationDecisionPayload(reason) {
  const value = clean(reason);
  if (value.length < 3 || value.length > 500) {
    throw new Error("Decision reason must contain 3 to 500 characters.");
  }
  return { reason: value };
}

export function buildIntegrationSecretRotationPayload(secretReference, reason) {
  const reference = clean(secretReference);
  const rationale = clean(reason);
  if (!SECRET_REFERENCE.test(reference)) {
    throw new Error("New secret reference must use env://WEBHOOK_SECRET_<ALIAS>.");
  }
  if (rationale.length < 3 || rationale.length > 500) {
    throw new Error("Rotation reason must contain 3 to 500 characters.");
  }
  return { secret_reference: reference, reason: rationale };
}

export function buildIntegrationCaseDecisionPayload(action, expectedVersion, reason) {
  const version = Number(expectedVersion);
  const rationale = clean(reason);
  if (!["RESOLVE", "WAIVE"].includes(action)) throw new Error("Choose RESOLVE or WAIVE.");
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
    throw new Error("Expected case version must be a positive integer.");
  }
  if (rationale.length < 10 || rationale.length > 500) {
    throw new Error("Case decision reason must contain 10 to 500 characters.");
  }
  return { action, expected_version: version, reason: rationale };
}

function isoFilter(value, field) {
  const candidate = clean(value);
  if (!candidate) return "";
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) throw new Error(field + " must be a valid date and time.");
  return parsed.toISOString();
}

export function buildIntegrationQuery(filters = {}, kind = "report") {
  if (!["report", "events", "cases", "connectors"].includes(kind)) {
    throw new Error("Unsupported integration query type.");
  }
  const params = new URLSearchParams();
  const domain = clean(filters.domain).toUpperCase();
  if (domain && domain !== "ALL") {
    if (!DOMAINS.has(domain)) throw new Error("Domain must be ATTENDANCE, PRODUCTION or QUALITY.");
    params.set("domain", domain);
  }
  if (kind === "report") {
    const since = isoFilter(filters.since, "Since");
    const until = isoFilter(filters.until, "Until");
    if (since && until && Date.parse(since) > Date.parse(until)) {
      throw new Error("Since must not be later than until.");
    }
    if (since) params.set("since", since);
    if (until) params.set("until", until);
  } else if (kind === "events") {
    const delivery = clean(filters.delivery_class).toUpperCase();
    if (delivery && delivery !== "ALL") {
      if (!DELIVERY_CLASSES.has(delivery)) throw new Error("Delivery class must be ON_TIME or LATE.");
      params.set("delivery_class", delivery);
    }
    const source = clean(filters.source_system).toUpperCase();
    if (source) {
      if (!SOURCE_SYSTEM.test(source)) throw new Error("Source system filter is invalid.");
      params.set("source_system", source);
    }
    const limit = filters.limit === undefined ? 100 : Number(filters.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Event limit must be between 1 and 500.");
    params.set("limit", String(limit));
  } else if (kind === "cases") {
    const status = clean(filters.status).toUpperCase();
    const caseType = clean(filters.case_type).toUpperCase();
    if (status && status !== "ALL") {
      if (!CASE_STATUSES.has(status)) throw new Error("Case status is invalid.");
      params.set("status", status);
    }
    if (caseType && caseType !== "ALL") {
      if (!CASE_TYPES.has(caseType)) throw new Error("Case type is invalid.");
      params.set("case_type", caseType);
    }
    const limit = filters.limit === undefined ? 100 : Number(filters.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Case limit must be between 1 and 500.");
    params.set("limit", String(limit));
  }
  const query = params.toString();
  return query ? "?" + query : "";
}

export function summarizeIntegrationWorkspace(connectors = [], events = [], cases = [], report = null) {
  const counts = {
    connectors: connectors.length,
    activeConnectors: connectors.filter((row) => row.status === "ACTIVE").length,
    pendingConnectors: connectors.filter((row) => row.status === "PENDING_REVIEW").length,
    pausedConnectors: connectors.filter((row) => row.status === "PAUSED").length,
    events: events.length,
    lateEvents: events.filter((row) => row.delivery_class === "LATE").length,
    openCases: cases.filter((row) => row.status === "OPEN").length,
    errorCases: cases.filter((row) => row.status === "OPEN" && row.severity === "ERROR").length,
    domains: normalizeIntegrationRows(report, "items").length,
  };
  return counts;
}

export function filterIntegrationConnectors(rows = [], search = "", status = "ALL") {
  const term = clean(search).toLocaleLowerCase();
  const wanted = clean(status).toUpperCase();
  return rows.filter((row) => {
    if (wanted !== "ALL" && String(row.status ?? "").toUpperCase() !== wanted) return false;
    if (!term) return true;
    return [row.display_name, row.source_system, row.connector_type, row.status, row.decision_reason]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(term));
  });
}

export function integrationCaseVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 && version <= 2147483647 ? version : null;
}
