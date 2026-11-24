const STATUSES = new Set(["UNREAD", "ACKNOWLEDGED"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value, field, max = 255) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.trim().normalize("NFC");
  if (!result || result.length > max) throw new Error(field + " must contain 1 to " + max + " characters.");
  return result;
}
function integer(value, field, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(field + " must be a whole number from " + min + " to " + max + ".");
  }
  return result;
}
function uuid(value, field) {
  const result = text(value, field, 36).toLowerCase();
  if (!UUID.test(result)) throw new Error(field + " must be a UUID.");
  return result;
}

export function normalizeOperationalNotificationRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.data)) return value.data;
  if (value.data && typeof value.data === "object") return normalizeOperationalNotificationRows(value.data);
  return [];
}

export function buildOperationalNotificationInboxQuery(input = {}) {
  const limit = integer(input.limit ?? 50, "limit", 1, 200);
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.status !== undefined && input.status !== null && input.status !== "") {
    if (typeof input.status !== "string" || !STATUSES.has(input.status)) throw new Error("status must be UNREAD or ACKNOWLEDGED.");
    params.set("status", input.status);
  }
  return "?" + params.toString();
}

export function buildOperationalNotificationAcknowledgementPayload(input = {}) {
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2_147_483_647),
    reason: text(input.reason, "reason", 2000),
  };
}

export function filterOperationalNotifications(input, filters = {}) {
  const query = typeof filters.query === "string" ? filters.query.trim().toLocaleLowerCase() : "";
  const category = typeof filters.category === "string" ? filters.category : "ALL";
  const severity = typeof filters.severity === "string" ? filters.severity : "ALL";
  const actionOnly = filters.actionOnly === true;
  return normalizeOperationalNotificationRows(input).filter((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const item = raw;
    if (category !== "ALL" && item.category !== category) return false;
    if (severity !== "ALL" && item.severity !== severity) return false;
    if (actionOnly && item.actionRequired !== true && item.action_required !== true) return false;
    if (!query) return true;
    const searchable = [
      item.title, item.body, item.category, item.severity, item.status,
      item.aggregateType, item.aggregate_type, item.sourceEventType, item.source_event_type,
      item.id, item.aggregateId, item.aggregate_id,
    ].filter((value) => typeof value === "string").join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  });
}

export function summarizeOperationalNotifications(input) {
  const items = normalizeOperationalNotificationRows(input);
  return {
    total: items.length,
    unread: items.filter((item) => item?.status === "UNREAD").length,
    acknowledged: items.filter((item) => item?.status === "ACKNOWLEDGED").length,
    actionRequired: items.filter((item) => item?.actionRequired === true || item?.action_required === true).length,
    critical: items.filter((item) => item?.severity === "CRITICAL").length,
  };
}

export function createOperationalNotificationClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS session request function is required.");
  return Object.freeze({
    listInbox: (input = {}) => request("/notifications/inbox" + buildOperationalNotificationInboxQuery(input)),
    acknowledge: (notificationId, body) => request("/notifications/" + encodeURIComponent(uuid(notificationId, "notificationId")) + "/acknowledge", {
      method: "POST",
      body,
    }),
  });
}
