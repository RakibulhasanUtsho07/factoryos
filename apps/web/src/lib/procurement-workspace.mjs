const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PURCHASE_ORDER_STATUSES = new Set([
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);
const SUPPLIER_STATUSES = new Set(["ACTIVE", "DISABLED"]);

function validatePage(page) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("Procurement page must be a positive integer.");
  }
  return page;
}

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Procurement list limit must be between 1 and 100.");
  }
  return limit;
}

function validateSearch(search) {
  if (search === undefined || search === null || search === "") return "";
  if (typeof search !== "string" || search.trim().length > 100) {
    throw new Error("Procurement search must contain at most 100 characters.");
  }
  return search.trim();
}

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(field + " must be a valid UUID.");
  }
  return value.trim().toLowerCase();
}

function createPagedQuery({ page = 1, limit = 20, status, search } = {}, statuses, label) {
  const params = new URLSearchParams({
    page: String(validatePage(page)),
    limit: String(validateLimit(limit)),
  });
  if (status !== undefined && status !== null && status !== "") {
    const normalized = String(status).trim().toUpperCase();
    if (!statuses.has(normalized)) {
      throw new Error(label + " status filter is not supported.");
    }
    params.set("status", normalized);
  }
  const normalizedSearch = validateSearch(search);
  if (normalizedSearch) params.set("search", normalizedSearch);
  return params.toString();
}

export function createProcurementWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated FactoryOS session request function is required.");
  }

  return Object.freeze({
    listPurchaseOrders({ page = 1, limit = 20, status, search } = {}) {
      const query = createPagedQuery(
        { page, limit, status, search },
        PURCHASE_ORDER_STATUSES,
        "Purchase-order",
      );
      return request("/purchase-orders?" + query);
    },

    getPurchaseOrder(purchaseOrderId) {
      const id = validateUuid(purchaseOrderId, "Purchase-order ID");
      return request("/purchase-orders/" + encodeURIComponent(id));
    },

    listSuppliers({ page = 1, limit = 20, status, search } = {}) {
      const query = createPagedQuery(
        { page, limit, status, search },
        SUPPLIER_STATUSES,
        "Supplier",
      );
      return request("/suppliers?" + query);
    },

    listGoodsReceipts(purchaseOrderId, { limit = 50 } = {}) {
      const id = validateUuid(purchaseOrderId, "Purchase-order ID");
      const params = new URLSearchParams({ limit: String(validateLimit(limit)) });
      return request("/purchase-orders/" + encodeURIComponent(id) + "/goods-receipts?" + params.toString());
    },

    getGoodsReceipt(receiptId) {
      const id = validateUuid(receiptId, "Goods-receipt ID");
      return request("/goods-receipts/" + encodeURIComponent(id));
    },
  });
}
