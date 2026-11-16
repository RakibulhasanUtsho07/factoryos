const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WORK_ORDER_STATUSES = new Set([
  "DRAFT",
  "RELEASED",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
]);

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Production list limit must be between 1 and 100.");
  }
  return limit;
}

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(field + " must be a valid UUID.");
  }
  return value.trim().toLowerCase();
}

export function createProductionWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    listWorkOrders({ status, limit = 100 } = {}) {
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      if (status !== undefined && status !== null && status !== "") {
        const normalized = String(status).trim().toUpperCase();
        if (!WORK_ORDER_STATUSES.has(normalized)) {
          throw new Error("Work-order status filter is not supported.");
        }
        params.set("status", normalized);
      }
      return request("/production/work-orders?" + params.toString());
    },

    getWorkOrder(workOrderId) {
      const id = validateUuid(workOrderId, "Work order ID");
      return request("/production/work-orders/" + encodeURIComponent(id));
    },

    getMaterialShortageRadar({ limit = 100 } = {}) {
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      return request("/production/work-orders/material-shortage-radar?" + params.toString());
    },
  });
}
