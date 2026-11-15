const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INCIDENT_STATUSES = new Set([
  "OPEN",
  "INVESTIGATING",
  "ACTION_REQUIRED",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
]);
const INCIDENT_TYPES = new Set([
  "INCIDENT",
  "NEAR_MISS",
  "UNSAFE_OBSERVATION",
  "INJURY",
  "ENVIRONMENTAL_RELEASE",
  "AUDIT_FINDING",
]);
const SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const PERMIT_STATUSES = new Set([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "ACTIVE",
  "CLOSED",
  "CANCELLED",
  "EXPIRED",
]);
const PERMIT_TYPES = new Set([
  "HOT_WORK",
  "ELECTRICAL_LOTO",
  "CONFINED_SPACE",
  "WORK_AT_HEIGHT",
  "CHEMICAL_HANDLING",
  "GENERAL",
]);
const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("EHS list limit must be between 1 and 200.");
  }
  return limit;
}

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(field + " must be a valid UUID.");
  }
  return value.trim().toLowerCase();
}

function addEnum(params, key, value, allowed, label) {
  if (value === undefined || value === null || value === "") return;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.has(normalized)) {
    throw new Error(label + " filter is not supported.");
  }
  params.set(key, normalized);
}

export function createEhsWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    listIncidents({ status, severity, limit = 100 } = {}) {
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      addEnum(params, "status", status, INCIDENT_STATUSES, "Incident status");
      addEnum(params, "severity", severity, SEVERITIES, "Incident severity");
      return request("/ehs/incidents?" + params.toString());
    },

    listPermits({ status, riskLevel, limit = 100 } = {}) {
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      addEnum(params, "status", status, PERMIT_STATUSES, "Permit status");
      addEnum(params, "risk_level", riskLevel, RISK_LEVELS, "Permit risk level");
      return request("/ehs/permits?" + params.toString());
    },

    listCorrectiveActions(incidentId, { limit = 100 } = {}) {
      const id = validateUuid(incidentId, "Incident ID");
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      return request("/ehs/incidents/" + encodeURIComponent(id) + "/corrective-actions?" + params.toString());
    },
  });
}
