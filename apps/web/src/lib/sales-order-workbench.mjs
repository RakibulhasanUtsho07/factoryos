const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["DRAFT", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
const DISPOSITIONS = new Set(["RETURN_TO_STOCK", "SCRAPPED"]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value, field, max = 255, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.trim().normalize("NFC");
  if ((!optional && !result) || result.length > max) {
    throw new Error(field + " must contain " + (optional ? "at most " : "1 to ") + max + " characters.");
  }
  return result || undefined;
}
function uuid(value, field) {
  const result = text(value, field, 36);
  if (!UUID.test(result)) throw new Error(field + " must be a UUID.");
  return result.toLowerCase();
}
function decimal(value, field, min, maxDecimals = 4, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) throw new Error(field + " must be a number of at least " + min + ".");
  const normalized = String(value).trim();
  const fraction = normalized.includes(".") ? normalized.split(".")[1] ?? "" : "";
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || fraction.length > maxDecimals) {
    throw new Error(field + " must have at most " + maxDecimals + " decimal places.");
  }
  return number;
}
function date(value, field, optional = true) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  const result = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result + "T00:00:00Z"))) {
    throw new Error(field + " must be a valid YYYY-MM-DD date.");
  }
  return result;
}
function positiveInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(field + " must be a whole number from " + min + " to " + max + ".");
  }
  return number;
}

export function normalizeSalesOrderRows(value) {
  if (Array.isArray(value)) return value;
  const item = record(value);
  if (Array.isArray(item.items)) return item.items;
  if (Array.isArray(item.data)) return item.data;
  if (item.data && typeof item.data === "object") return normalizeSalesOrderRows(item.data);
  return [];
}

export function normalizeSalesOrderPagination(value) {
  const root = record(value);
  const nested = record(root.data);
  const pagination = record(root.pagination ?? nested.pagination);
  const page = Number(pagination.page ?? 1);
  const limit = Number(pagination.limit ?? 20);
  const total = Number(pagination.total ?? 0);
  const totalPages = Number(pagination.total_pages ?? pagination.totalPages ?? 0);
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    limit: Number.isSafeInteger(limit) && limit >= 1 ? limit : 20,
    total: Number.isSafeInteger(total) && total >= 0 ? total : 0,
    total_pages: Number.isSafeInteger(totalPages) && totalPages >= 0 ? totalPages : 0,
  };
}

export function buildSalesOrderListQuery(input = {}) {
  const page = positiveInteger(input.page ?? 1, "page", 1, 1_000_000);
  const limit = positiveInteger(input.limit ?? 20, "limit", 1, 100);
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (input.status && input.status !== "ALL") {
    if (typeof input.status !== "string" || !STATUSES.has(input.status)) {
      throw new Error("status must be a supported order status.");
    }
    params.set("status", input.status);
  }
  if (input.search !== undefined && input.search !== null && String(input.search).trim()) {
    params.set("search", text(String(input.search), "search", 100));
  }
  return "?" + params.toString();
}

export function buildSalesOrderCreatePayload(input = {}) {
  const factoryId = uuid(input.factory_id, "factory_id");
  const orderNumber = text(input.order_number, "order_number", 100);
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) {
    throw new Error("At least one and no more than 100 order lines are required.");
  }
  const lines = input.lines.map((raw, index) => {
    const line = record(raw);
    const result = {
      line_number: positiveInteger(line.line_number ?? index + 1, "line_number", 1, 2_147_483_647),
      product_code: text(line.product_code, "product_code", 100),
      product_name: text(line.product_name, "product_name", 255),
      quantity: decimal(line.quantity, "quantity", 0.0001, 4),
      unit: text(line.unit, "unit", 50),
    };
    if (line.inventory_item_id) result.inventory_item_id = uuid(line.inventory_item_id, "inventory_item_id");
    const unitPrice = decimal(line.unit_price, "unit_price", 0, 4, true);
    if (unitPrice !== undefined) result.unit_price = unitPrice;
    const requestedLineDate = date(line.requested_delivery_date, "line requested_delivery_date");
    if (requestedLineDate) result.requested_delivery_date = requestedLineDate;
    const notes = text(line.notes, "line notes", 2000, true);
    if (notes) result.notes = notes;
    return result;
  });
  if (new Set(lines.map((line) => line.line_number)).size !== lines.length) {
    throw new Error("Duplicate order line numbers are not allowed.");
  }
  const currency = text(input.currency || "BDT", "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code.");
  const payload = {
    factory_id: factoryId,
    order_number: orderNumber,
    currency,
    lines,
  };
  const customerName = text(input.customer_name, "customer_name", 255, true);
  const customerReference = text(input.customer_reference, "customer_reference", 255, true);
  const orderDate = date(input.order_date, "order_date");
  const requestedDeliveryDate = date(input.requested_delivery_date, "requested_delivery_date");
  const notes = text(input.notes, "notes", 4000, true);
  if (customerName) payload.customer_name = customerName;
  if (customerReference) payload.customer_reference = customerReference;
  if (orderDate) payload.order_date = orderDate;
  if (requestedDeliveryDate) payload.requested_delivery_date = requestedDeliveryDate;
  if (notes) payload.notes = notes;
  return payload;
}

export function buildSalesOrderTransitionPayload(input = {}) {
  const target = text(input.target_status, "target_status", 20);
  if (!STATUSES.has(target)) throw new Error("target_status must be a supported order status.");
  return {
    target_status: target,
    expected_version: positiveInteger(input.expected_version, "expected_version", 1, 2_147_483_647),
  };
}

export function buildOrderProductionReportPayload(input = {}) {
  const good = decimal(input.good_quantity, "good_quantity", 0, 4);
  const scrap = decimal(input.scrap_quantity, "scrap_quantity", 0, 4);
  if (good + scrap <= 0) throw new Error("Good and scrap quantities cannot both be zero.");
  const payload = {
    order_line_id: uuid(input.order_line_id, "order_line_id"),
    good_quantity: good,
    scrap_quantity: scrap,
  };
  const reason = text(input.scrap_reason, "scrap_reason", 500, true);
  if (scrap > 0 && !reason) throw new Error("scrap_reason is required when scrap quantity is greater than zero.");
  const notes = text(input.notes, "notes", 2000, true);
  if (reason) payload.scrap_reason = reason;
  if (notes) payload.notes = notes;
  return payload;
}

export function buildOrderMaterialDispositionPayload(input = {}) {
  const type = text(input.disposition_type, "disposition_type", 32);
  if (!DISPOSITIONS.has(type)) throw new Error("disposition_type must be RETURN_TO_STOCK or SCRAPPED.");
  const payload = {
    reservation_id: uuid(input.reservation_id, "reservation_id"),
    disposition_type: type,
    quantity: decimal(input.quantity, "quantity", 0.0001, 4),
  };
  const notes = text(input.notes, "notes", 1000, true);
  if (notes) payload.notes = notes;
  return payload;
}

export function summarizeSalesOrders(input, today = new Date().toISOString().slice(0, 10)) {
  const items = normalizeSalesOrderRows(input);
  return {
    total_loaded: items.length,
    draft: items.filter((item) => item?.status === "DRAFT").length,
    confirmed: items.filter((item) => item?.status === "CONFIRMED").length,
    in_progress: items.filter((item) => item?.status === "IN_PROGRESS").length,
    completed: items.filter((item) => item?.status === "COMPLETED").length,
    cancelled: items.filter((item) => item?.status === "CANCELLED").length,
    overdue: items.filter((item) => item?.requested_delivery_date && item.requested_delivery_date < today
      && !["COMPLETED", "CANCELLED"].includes(item.status)).length,
  };
}

export function createSalesOrderClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS session request function is required.");
  return Object.freeze({
    list: (input = {}) => request("/orders" + buildSalesOrderListQuery(input)),
    get: (orderId) => request("/orders/" + uuid(orderId, "orderId")),
    create: (body, idempotencyKey) => request("/orders", {
      method: "POST", body, idempotencyKey: text(idempotencyKey, "idempotencyKey", 255),
    }),
    transition: (orderId, body) => request("/orders/" + uuid(orderId, "orderId") + "/status", {
      method: "POST", body,
    }),
    listProductionReports: (orderId, limit = 50) => request(
      "/orders/" + uuid(orderId, "orderId") + "/production-reports?limit=" + positiveInteger(limit, "limit", 1, 100),
    ),
    createProductionReport: (orderId, body, idempotencyKey) => request(
      "/orders/" + uuid(orderId, "orderId") + "/production-reports",
      { method: "POST", body, idempotencyKey: text(idempotencyKey, "idempotencyKey", 255) },
    ),
    createMaterialDisposition: (orderId, body, idempotencyKey) => request(
      "/orders/" + uuid(orderId, "orderId") + "/material-dispositions",
      { method: "POST", body, idempotencyKey: text(idempotencyKey, "idempotencyKey", 255) },
    ),
  });
}
