const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, field, maximum) {
  const result = clean(value);
  if (!result || result.length > maximum) {
    throw new Error(field + " must contain 1 to " + maximum + " characters.");
  }
  return result;
}

function integer(value, field, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(field + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return result;
}

function decimal(value, field, allowZero) {
  const raw = clean(String(value ?? ""));
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) {
    throw new Error(field + " must be a non-negative number with at most four decimal places.");
  }
  const result = Number(raw);
  if (!Number.isFinite(result) || (!allowZero && result <= 0)) {
    throw new Error(field + (allowZero ? " must not be negative." : " must be greater than zero."));
  }
  return result;
}

function dateValue(value, field) {
  const result = clean(value);
  if (!result) return "";
  if (!DATE.test(result)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(result + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(field + " must be a real calendar date.");
  }
  return result;
}

function uuidValue(value, field) {
  const result = clean(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result;
}

export function normalizeProcurementRows(value, preferredKey = "items") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  for (const key of ["items", "rows", "records", "suppliers", "purchase_orders", "receipts"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.data !== undefined) return normalizeProcurementRows(value.data, preferredKey);
  return [];
}

export function buildProcurementListQuery(filters = {}, kind = "suppliers") {
  if (!["suppliers", "purchase-orders"].includes(kind)) {
    throw new Error("Unsupported procurement list.");
  }
  const page = integer(filters.page ?? 1, "page", 1, 1000000);
  const limit = integer(filters.limit ?? 50, "limit", 1, 100);
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  const search = clean(filters.search);
  if (search) params.set("search", requiredText(search, "search", 100));
  const status = clean(filters.status).toUpperCase();
  const allowed = kind === "suppliers"
    ? ["ALL", "ACTIVE", "DISABLED"]
    : ["ALL", "DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"];
  if (status && !allowed.includes(status)) throw new Error("Unsupported " + kind + " status filter.");
  if (status && status !== "ALL") params.set("status", status);
  return "?" + params.toString();
}

export function buildSupplierPayload(input = {}) {
  const code = requiredText(input.code, "code", 100).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,99}$/.test(code)) {
    throw new Error("code may contain letters, digits, dot, underscore, slash and hyphen.");
  }
  const name = requiredText(input.name, "name", 255);
  const countryCode = (clean(input.country_code) || "BD").toUpperCase();
  const currency = (clean(input.currency) || "BDT").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error("country_code must be a two-letter ISO code.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code.");
  const email = clean(input.email).toLowerCase();
  if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("email must be a valid email address.");
  }
  const paymentTerms = integer(input.payment_terms_days ?? 0, "payment_terms_days", 0, 3650);
  const phone = clean(input.phone);
  const taxReference = clean(input.tax_reference);
  const address = clean(input.address);
  const notes = clean(input.notes);
  if (phone.length > 80) throw new Error("phone must not exceed 80 characters.");
  if (taxReference.length > 120) throw new Error("tax_reference must not exceed 120 characters.");
  return {
    code,
    name,
    country_code: countryCode,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(taxReference ? { tax_reference: taxReference } : {}),
    payment_terms_days: paymentTerms,
    currency,
    ...(address ? { address } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function buildSupplierUpdatePayload(input = {}, expectedVersion) {
  const version = integer(expectedVersion, "expected_version", 1, 2147483647);
  const base = buildSupplierPayload({ ...input, code: input.code || "SUPPLIER" });
  return {
    expected_version: version,
    name: base.name,
    country_code: base.country_code,
    email: base.email ?? null,
    phone: base.phone ?? null,
    tax_reference: base.tax_reference ?? null,
    payment_terms_days: base.payment_terms_days,
    currency: base.currency,
    address: base.address ?? null,
    notes: base.notes ?? null,
  };
}

export function buildSupplierStatusPayload(targetStatus, expectedVersion) {
  const target = clean(targetStatus).toUpperCase();
  if (!["ACTIVE", "DISABLED"].includes(target)) throw new Error("Supplier status must be ACTIVE or DISABLED.");
  return {
    target_status: target,
    expected_version: integer(expectedVersion, "expected_version", 1, 2147483647),
  };
}

function purchaseOrderLines(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new Error("A purchase order must contain between 1 and 500 lines.");
  }
  const numbers = new Set();
  return value.map((line, index) => {
    const lineNumber = integer(line.line_number ?? index + 1, "line_number", 1, 1000000);
    if (numbers.has(lineNumber)) throw new Error("Purchase-order line numbers must be unique.");
    numbers.add(lineNumber);
    const description = requiredText(line.description, "line description", 500);
    const unit = requiredText(line.unit, "line unit", 50).toUpperCase();
    const quantity = decimal(line.quantity, "quantity", false);
    const unitPrice = decimal(line.unit_price, "unit_price", true);
    const inventoryItemId = clean(line.inventory_item_id);
    if (inventoryItemId && !UUID.test(inventoryItemId)) {
      throw new Error("inventory_item_id must be a valid UUID when supplied.");
    }
    const notes = clean(line.notes);
    return {
      line_number: lineNumber,
      ...(inventoryItemId ? { inventory_item_id: inventoryItemId } : {}),
      description,
      quantity,
      unit,
      unit_price: unitPrice,
      ...(notes ? { notes } : {}),
    };
  });
}

export function buildPurchaseOrderPayload(input = {}) {
  const supplierId = uuidValue(input.supplier_id, "supplier_id");
  const poNumber = requiredText(input.po_number, "po_number", 100).toUpperCase();
  const orderDate = dateValue(input.order_date, "order_date");
  const expectedDate = dateValue(input.expected_delivery_date, "expected_delivery_date");
  if (orderDate && expectedDate && expectedDate < orderDate) {
    throw new Error("expected_delivery_date cannot be before order_date.");
  }
  const currency = (clean(input.currency) || "BDT").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code.");
  const notes = clean(input.notes);
  return {
    supplier_id: supplierId,
    po_number: poNumber,
    ...(orderDate ? { order_date: orderDate } : {}),
    ...(expectedDate ? { expected_delivery_date: expectedDate } : {}),
    currency,
    payment_terms_days: integer(input.payment_terms_days ?? 0, "payment_terms_days", 0, 3650),
    ...(notes ? { notes } : {}),
    lines: purchaseOrderLines(input.lines),
  };
}

export function buildPurchaseOrderUpdatePayload(input = {}, expectedVersion) {
  const base = buildPurchaseOrderPayload(input);
  return {
    expected_version: integer(expectedVersion, "expected_version", 1, 2147483647),
    ...(base.order_date ? { order_date: base.order_date } : {}),
    ...(base.expected_delivery_date ? { expected_delivery_date: base.expected_delivery_date } : { expected_delivery_date: null }),
    currency: base.currency,
    payment_terms_days: base.payment_terms_days,
    notes: base.notes ?? null,
    lines: base.lines,
  };
}

export function buildPurchaseOrderTransitionPayload(targetStatus, expectedVersion, reason = "") {
  const target = clean(targetStatus).toUpperCase();
  if (!["SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"].includes(target)) {
    throw new Error("Unsupported purchase-order transition.");
  }
  const rationale = clean(reason);
  if (["REJECTED", "CANCELLED"].includes(target) && !rationale) {
    throw new Error("A reason is required to reject or cancel a purchase order.");
  }
  if (rationale.length > 2000) throw new Error("reason must not exceed 2000 characters.");
  return {
    expected_version: integer(expectedVersion, "expected_version", 1, 2147483647),
    ...(rationale ? { reason: rationale } : {}),
  };
}

export function buildGoodsReceiptPayload(input = {}) {
  const linesInput = Array.isArray(input.lines) ? input.lines : [];
  const lines = [];
  const seen = new Set();
  for (const line of linesInput) {
    const receivedRaw = clean(String(line.received_quantity ?? ""));
    if (!receivedRaw || Number(receivedRaw) === 0) continue;
    const lineId = uuidValue(line.purchase_order_line_id, "purchase_order_line_id");
    if (seen.has(lineId)) throw new Error("Each purchase-order line may appear only once per receipt.");
    seen.add(lineId);
    const received = decimal(receivedRaw, "received_quantity", false);
    const rejected = clean(String(line.rejected_quantity ?? "0")) ? decimal(line.rejected_quantity ?? "0", "rejected_quantity", true) : 0;
    if (rejected > received) throw new Error("rejected_quantity cannot exceed received_quantity.");
    const rejectionReason = clean(line.rejection_reason);
    if (rejected > 0 && !rejectionReason) throw new Error("A rejection reason is required when rejected quantity is greater than zero.");
    lines.push({
      purchase_order_line_id: lineId,
      received_quantity: received,
      rejected_quantity: rejected,
      ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
    });
  }
  if (!lines.length) throw new Error("Enter a received quantity for at least one PO line.");
  const locationId = clean(input.location_id);
  if (locationId && !UUID.test(locationId)) throw new Error("location_id must be a valid UUID.");
  const receivedAtRaw = clean(input.received_at);
  let receivedAt;
  if (receivedAtRaw) {
    const parsed = new Date(receivedAtRaw);
    if (!Number.isFinite(parsed.getTime())) throw new Error("received_at must be a valid date and time.");
    receivedAt = parsed.toISOString();
  }
  const deliveryReference = clean(input.supplier_delivery_reference);
  const notes = clean(input.notes);
  return {
    ...(locationId ? { location_id: locationId } : {}),
    ...(deliveryReference ? { supplier_delivery_reference: requiredText(deliveryReference, "supplier_delivery_reference", 150) } : {}),
    ...(receivedAt ? { received_at: receivedAt } : {}),
    ...(notes ? { notes } : {}),
    lines,
  };
}

export function buildSupplierPerformanceQuery(input = {}) {
  const from = dateValue(input.from, "from");
  const to = dateValue(input.to, "to");
  if (!from || !to) throw new Error("from and to dates are required.");
  const start = Date.parse(from + "T00:00:00.000Z");
  const end = Date.parse(to + "T00:00:00.000Z");
  if (end < start) throw new Error("to must be on or after from.");
  if ((end - start) / 86400000 > 365) {
    throw new Error("The supplier evidence period cannot exceed 366 inclusive calendar days.");
  }
  const params = new URLSearchParams({ from, to });
  const asOf = dateValue(input.as_of, "as_of");
  if (asOf) params.set("as_of", asOf);
  return "?" + params.toString();
}

export function filterProcurementRows(rows = [], filters = {}, kind = "suppliers") {
  const search = clean(filters.search).toLowerCase();
  const status = clean(filters.status).toUpperCase();
  return rows.filter((row) => {
    const rowStatus = String(row.status ?? "").toUpperCase();
    if (status && status !== "ALL" && rowStatus !== status) return false;
    if (!search) return true;
    const fields = kind === "suppliers"
      ? [row.code, row.name, row.email, row.tax_reference]
      : [row.po_number, row.supplier_code, row.supplier_name];
    return fields.some((field) => String(field ?? "").toLowerCase().includes(search));
  });
}

export function summarizeProcurement(suppliers = [], purchaseOrders = []) {
  const supplierRows = Array.isArray(suppliers) ? suppliers : [];
  const poRows = Array.isArray(purchaseOrders) ? purchaseOrders : [];
  const statusCount = (status) => poRows.filter((row) => String(row.status ?? "").toUpperCase() === status).length;
  return {
    activeSuppliers: supplierRows.filter((row) => String(row.status ?? "").toUpperCase() === "ACTIVE").length,
    supplierCount: supplierRows.length,
    purchaseOrderCount: poRows.length,
    draftCount: statusCount("DRAFT"),
    submittedCount: statusCount("SUBMITTED"),
    approvedCount: statusCount("APPROVED"),
    totalOpenValue: poRows.filter((row) => ["DRAFT", "SUBMITTED", "APPROVED"].includes(String(row.status ?? "").toUpperCase()))
      .reduce((sum, row) => sum + (Number.isFinite(Number(row.total_amount)) ? Number(row.total_amount) : 0), 0),
  };
}
