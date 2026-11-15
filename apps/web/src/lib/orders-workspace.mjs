const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = new Set(["DRAFT", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(field + " must be a valid UUID.");
  }
  return value.trim().toLowerCase();
}

export function createOrdersWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    listOrders({ page = 1, limit = 20, status, search } = {}) {
      if (!Number.isSafeInteger(page) || page < 1) {
        throw new Error("Order page must be a positive integer.");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Order page size must be between 1 and 100.");
      }

      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (status) {
        const normalizedStatus = String(status).trim().toUpperCase();
        if (!ORDER_STATUSES.has(normalizedStatus)) {
          throw new Error("Order status filter is not supported.");
        }
        params.set("status", normalizedStatus);
      }
      if (typeof search === "string" && search.trim()) {
        params.set("search", search.trim());
      }

      return request("/orders?" + params.toString());
    },

    getOrder(orderId) {
      const id = validateUuid(orderId, "Order ID");
      return request("/orders/" + encodeURIComponent(id));
    },

    listProductionReports(orderId, { limit = 50 } = {}) {
      const id = validateUuid(orderId, "Order ID");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Production report limit must be between 1 and 100.");
      }
      return request("/orders/" + encodeURIComponent(id) + "/production-reports?limit=" + limit);
    },
  });
}
