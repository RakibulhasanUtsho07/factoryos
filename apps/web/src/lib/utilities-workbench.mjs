const UTILITY_TYPES = Object.freeze([
  "ELECTRICITY",
  "GAS",
  "STEAM",
  "WATER",
  "COMPRESSED_AIR",
  "FUEL",
  "OTHER",
]);
const METER_STATUSES = Object.freeze(["ACTIVE", "INACTIVE", "RETIRED"]);
const EVENT_STATUSES = Object.freeze(["OPEN", "ACKNOWLEDGED", "RESOLVED", "CANCELLED"]);
const ALERT_STATUSES = EVENT_STATUSES;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredRequest(request) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }
  return request;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(label + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.includes(normalized)) {
    throw new Error(label + " must be one of: " + allowed.join(", ") + ".");
  }
  return normalized;
}

function calendarDate(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(label + " must use YYYY-MM-DD format.");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(label + " must be a real calendar date.");
  }
  return value;
}

function validateDateRange(from, to) {
  if (from && to && from > to) {
    throw new Error("from must be earlier than or equal to to.");
  }
}

function meterUuid(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error("Meter ID must be a valid UUID.");
  }
  return normalized;
}

function queryString(entries) {
  const selected = entries.filter((entry) =>
    entry[1] !== undefined && entry[1] !== null && entry[1] !== "");
  return selected.length
    ? "?" + selected.map((entry) =>
      encodeURIComponent(entry[0]) + "=" + encodeURIComponent(String(entry[1]))).join("&")
    : "";
}

function boundedListLimit(value, maximum, label) {
  return boundedInteger(value, label, 1, maximum);
}

export function createUtilitiesWorkbenchClient({ request }) {
  const sessionRequest = requiredRequest(request);

  return Object.freeze({
    async listMeters({
      limit = 100,
      utilityType: utilityTypeInput,
      status: statusInput,
    } = {}) {
      const boundedLimit = boundedListLimit(limit, 200, "Meter limit");
      const utilityType = enumValue(utilityTypeInput, UTILITY_TYPES, "Utility type");
      const status = enumValue(statusInput, METER_STATUSES, "Meter status");
      const query = queryString([
        ["limit", boundedLimit],
        ["utility_type", utilityType],
        ["status", status],
      ]);
      return sessionRequest("/utilities/meters" + query);
    },

    async listReadings({
      meterId: meterIdInput,
      limit = 50,
      from: fromInput,
      to: toInput,
    } = {}) {
      const meterId = meterUuid(meterIdInput);
      const boundedLimit = boundedListLimit(limit, 200, "Reading limit");
      const from = calendarDate(fromInput, "from");
      const to = calendarDate(toInput, "to");
      validateDateRange(from, to);
      const query = queryString([
        ["limit", boundedLimit],
        ["from", from],
        ["to", to],
      ]);
      return sessionRequest("/utilities/meters/" + meterId + "/readings" + query);
    },

    async listEvents({
      limit = 100,
      status: statusInput,
    } = {}) {
      const boundedLimit = boundedListLimit(limit, 200, "Event limit");
      const status = enumValue(statusInput, EVENT_STATUSES, "Utility event status");
      return sessionRequest("/utilities/events" + queryString([
        ["limit", boundedLimit],
        ["status", status],
      ]));
    },

    async listThresholdAlerts({
      limit = 100,
      status: statusInput,
    } = {}) {
      const boundedLimit = boundedListLimit(limit, 100, "Alert limit");
      const status = enumValue(statusInput, ALERT_STATUSES, "Threshold alert status");
      return sessionRequest("/utilities/threshold-alerts" + queryString([
        ["limit", boundedLimit],
        ["status", status],
      ]));
    },

    async listThresholdPolicies({ limit = 100 } = {}) {
      const boundedLimit = boundedListLimit(limit, 100, "Policy limit");
      return sessionRequest("/utilities/threshold-policies" + queryString([
        ["limit", boundedLimit],
      ]));
    },

    async listSourceBindings({ limit = 100 } = {}) {
      const boundedLimit = boundedListLimit(limit, 100, "Source binding limit");
      return sessionRequest("/utilities/source-bindings" + queryString([
        ["limit", boundedLimit],
      ]));
    },
  });
}

export const utilitiesTypes = UTILITY_TYPES;
export const utilitiesMeterStatuses = METER_STATUSES;
export const utilitiesEventStatuses = EVENT_STATUSES;
export const utilitiesAlertStatuses = ALERT_STATUSES;
