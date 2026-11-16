const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INSPECTION_STATUSES = new Set([
  "OPEN",
  "IN_PROGRESS",
  "PASSED",
  "FAILED",
  "ON_HOLD",
  "DISPOSITIONED",
  "CANCELLED",
]);
const INSPECTION_TYPES = new Set([
  "INCOMING",
  "IN_PROCESS",
  "FINAL",
  "INVENTORY",
  "SUPPLIER",
]);
const TARGET_TYPES = new Set([
  "INVENTORY_ITEM",
  "TRACEABILITY_UNIT",
  "GOODS_RECEIPT_LINE",
  "PRODUCTION_REPORT",
  "WORK_ORDER",
]);
const PLAN_STATUSES = new Set(["DRAFT", "ACTIVE", "RETIRED"]);
const HOLD_STATUSES = new Set(["ACTIVE", "RELEASED", "DISPOSED"]);
const REWORK_STATUSES = new Set([
  "DRAFT",
  "APPROVED",
  "IN_PROGRESS",
  "COMPLETED",
  "REWORK_REQUIRED",
  "VERIFIED",
  "CANCELLED",
]);

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Quality list limit must be between 1 and 100.");
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

function createListQuery({ limit = 50, status, inspectionType, targetType } = {}, options = {}) {
  const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
  if (options.statuses) addEnum(params, "status", status, options.statuses, options.statusLabel);
  if (options.inspectionTypes) {
    addEnum(params, "inspection_type", inspectionType, INSPECTION_TYPES, "Inspection type");
  }
  if (options.targetTypes) {
    addEnum(params, "target_type", targetType, TARGET_TYPES, "Inspection target type");
  }
  return params.toString();
}

export function createQualityWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    listInspections({ status, inspectionType, targetType, limit = 50 } = {}) {
      const query = createListQuery({ status, inspectionType, targetType, limit }, {
        statuses: INSPECTION_STATUSES,
        statusLabel: "Inspection status",
        inspectionTypes: true,
        targetTypes: true,
      });
      return request("/quality/inspections?" + query);
    },

    getInspection(inspectionId) {
      const id = validateUuid(inspectionId, "Inspection ID");
      return request("/quality/inspections/" + encodeURIComponent(id));
    },

    listInspectionPlans({ status, inspectionType, limit = 50 } = {}) {
      const query = createListQuery({ status, inspectionType, limit }, {
        statuses: PLAN_STATUSES,
        statusLabel: "Inspection plan status",
        inspectionTypes: true,
      });
      return request("/quality/plans?" + query);
    },

    listHolds({ status, limit = 50 } = {}) {
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      addEnum(params, "status", status, HOLD_STATUSES, "Quality hold status");
      return request("/quality/holds?" + params.toString());
    },

    listReworkOrders({ status, limit = 50 } = {}) {
      const query = createListQuery({ status, limit }, {
        statuses: REWORK_STATUSES,
        statusLabel: "Rework status",
      });
      return request("/quality/rework-orders?" + query);
    },
  });
}
