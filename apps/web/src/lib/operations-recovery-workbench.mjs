const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTIFICATION_STATUSES = new Set(["UNREAD", "ACKNOWLEDGED"]);
const MAX_INT32 = 2147483647;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uuid(value, label) {
  const normalized = clean(value).toLowerCase();
  if (!UUID.test(normalized)) throw new Error(label + " must be a valid UUID.");
  return normalized;
}

function positiveInt(value, label, maximum = MAX_INT32) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(label + " must be a positive whole number no greater than " + maximum + ".");
  }
  return number;
}

export function normalizeOperationsRows(value, preferredKey = "") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.rows)) return value.rows;
  if (value.data !== undefined) return normalizeOperationsRows(value.data, preferredKey);
  return [];
}

export function buildOperationsInboxQuery(limit = 100, status = "ALL") {
  const boundedLimit = positiveInt(limit, "Notification limit", 200);
  const filter = clean(status).toUpperCase() || "ALL";
  if (filter !== "ALL" && !NOTIFICATION_STATUSES.has(filter)) {
    throw new Error("Notification status must be UNREAD or ACKNOWLEDGED.");
  }
  const params = new URLSearchParams({ limit: String(boundedLimit) });
  if (filter !== "ALL") params.set("status", filter);
  return "?" + params.toString();
}

export function buildOperationsDlqQuery(factoryId, limit = 50, offset = 0, kind = "outbox") {
  const factory = uuid(factoryId, "Active factory ID");
  if (kind !== "outbox" && kind !== "broker") throw new Error("Choose an outbox or broker dead-letter queue.");
  const maximum = kind === "outbox" ? 100 : 200;
  const boundedLimit = positiveInt(limit, "Dead-letter limit", maximum);
  const pageOffset = Number(offset);
  if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 1000000) {
    throw new Error("Dead-letter offset must be between 0 and 1000000.");
  }
  const params = new URLSearchParams({
    factory_id: factory,
    limit: String(boundedLimit),
    offset: String(pageOffset),
  });
  return "?" + params.toString();
}

export function buildNotificationAcknowledgePayload(expectedVersion, reason) {
  const version = positiveInt(expectedVersion, "Notification row version");
  const rationale = clean(reason);
  if (!rationale || rationale.length > 2000) {
    throw new Error("Acknowledgement reason must contain 1 to 2000 characters.");
  }
  return { expected_version: version, reason: rationale };
}

export function validateOperationsIdempotencyKey(value) {
  const key = clean(value);
  if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error("Idempotency key must contain 1 to 200 visible ASCII characters.");
  }
  return key;
}

export function summarizeOperationsRecovery(notifications = [], quarantined = [], brokerDeadLetters = []) {
  return {
    unreadNotifications: notifications.filter((row) => row.status === "UNREAD").length,
    actionRequired: notifications.filter((row) => row.status === "UNREAD" && row.action_required === true).length,
    acknowledgedNotifications: notifications.filter((row) => row.status === "ACKNOWLEDGED").length,
    quarantinedEvents: quarantined.filter((row) => row.status === "QUARANTINED").length,
    brokerQuarantined: brokerDeadLetters.filter((row) => row.status === "QUARANTINED").length,
    brokerRedrivePending: brokerDeadLetters.filter((row) => row.status === "REDRIVE_PENDING").length,
    brokerRedriven: brokerDeadLetters.filter((row) => row.status === "REDRIVEN").length,
  };
}

export function filterOperationsNotifications(rows = [], search = "", severity = "ALL") {
  const query = clean(search).toLocaleLowerCase();
  const wantedSeverity = clean(severity).toUpperCase();
  return rows.filter((row) => {
    if (wantedSeverity !== "ALL" && String(row.severity ?? "").toUpperCase() !== wantedSeverity) return false;
    if (!query) return true;
    return [row.title, row.body, row.category, row.severity, row.status, row.source_event_type]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(query));
  });
}

export function filterOperationsDeadLetters(rows = [], search = "") {
  const query = clean(search).toLocaleLowerCase();
  if (!query) return rows;
  return rows.filter((row) => [
    row.event_type,
    row.aggregate_type,
    row.consumer_name,
    row.source_topic,
    row.status,
  ].some((value) => String(value ?? "").toLocaleLowerCase().includes(query)));
}
