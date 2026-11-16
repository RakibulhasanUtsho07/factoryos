const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ASSET_STATUSES = new Set(["ACTIVE", "INACTIVE", "RETIRED"]);
const PM_PLAN_STATUSES = new Set(["DRAFT", "ACTIVE", "PAUSED", "RETIRED"]);
const WORK_ORDER_STATUSES = new Set([
  "PLANNED",
  "APPROVED",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
]);
const WORK_ORDER_TYPES = new Set(["PM", "BREAKDOWN"]);
const WORK_ORDER_PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]);

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(field + " must be a valid UUID.");
  }
  return value.trim().toLowerCase();
}

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Maintenance list limit must be between 1 and 100.");
  }
  return limit;
}

function addFilter(params, key, value, allowed, label) {
  if (value === undefined || value === null || value === "") return;
  const normalized = String(value).trim().toUpperCase();
  if (!allowed.has(normalized)) {
    throw new Error(label + " filter is not supported.");
  }
  params.set(key, normalized);
}

function createListQuery({ limit = 50, status, assetId, type, priority } = {}, options = {}) {
  const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
  if (options.statuses) addFilter(params, "status", status, options.statuses, options.statusLabel);
  if (options.types) addFilter(params, "work_order_type", type, options.types, "Work order type");
  if (options.priorities) addFilter(params, "priority", priority, options.priorities, "Work order priority");
  if (assetId) params.set("asset_id", validateUuid(assetId, "Asset ID"));
  return params.toString();
}

export function createMaintenanceWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    listAssets({ status, limit = 50 } = {}) {
      const query = createListQuery({ status, limit }, {
        statuses: ASSET_STATUSES,
        statusLabel: "Asset status",
      });
      return request("/maintenance/assets?" + query);
    },

    listPmPlans({ status, assetId, limit = 50 } = {}) {
      const query = createListQuery({ status, assetId, limit }, {
        statuses: PM_PLAN_STATUSES,
        statusLabel: "Preventive-maintenance plan status",
      });
      return request("/maintenance/pm-plans?" + query);
    },

    listWorkOrders({ status, type, priority, assetId, limit = 50 } = {}) {
      const query = createListQuery({ status, type, priority, assetId, limit }, {
        statuses: WORK_ORDER_STATUSES,
        statusLabel: "Work order status",
        types: WORK_ORDER_TYPES,
        priorities: WORK_ORDER_PRIORITIES,
      });
      return request("/maintenance/work-orders?" + query);
    },

    getWorkOrder(workOrderId) {
      const id = validateUuid(workOrderId, "Work order ID");
      return request("/maintenance/work-orders/" + encodeURIComponent(id));
    },
  });
}
