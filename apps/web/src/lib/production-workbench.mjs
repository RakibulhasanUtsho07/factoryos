const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WORK_ORDER_COMMANDS = new Set(["RELEASE", "HOLD", "RESUME", "COMPLETE", "CANCEL"]);
const OPERATION_COMMANDS = new Set([
  "START", "PAUSE", "RESUME", "HOLD", "COMPLETE", "SKIP",
  "DOWNTIME_START", "DOWNTIME_END", "WIP_REPORTED", "WIP_TRANSFERRED", "REWORK_REPORTED",
]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, field, maximum) {
  const result = clean(value);
  if (!result || result.length > maximum) throw new Error(field + " must contain 1 to " + maximum + " characters.");
  return result;
}

function integer(value, field, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(field + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return result;
}

function quantity(value, field, allowZero = false) {
  const raw = clean(String(value ?? ""));
  if (!/^\d+(?:\.\d{1,4})?$/.test(raw)) {
    throw new Error(field + " must be a non-negative number with at most four decimal places.");
  }
  const result = Number(raw);
  if (!Number.isFinite(result) || (!allowZero && result <= 0)) {
    throw new Error(field + (allowZero ? " cannot be negative." : " must be greater than zero."));
  }
  return result;
}

function uuid(value, field) {
  const result = clean(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result;
}

function calendarDate(value, field, required = false) {
  const result = clean(value);
  if (!result) {
    if (required) throw new Error(field + " is required.");
    return "";
  }
  if (!DATE.test(result)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(result + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(field + " must be a real calendar date.");
  }
  return result;
}

export function normalizeProductionRows(value, preferredKey = "items") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  for (const key of ["items", "rows", "records", "work_orders", "orders", "requirements"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.data !== undefined) return normalizeProductionRows(value.data, preferredKey);
  return [];
}

export function buildWorkOrderListQuery(input = {}) {
  const limit = integer(input.limit ?? 50, "limit", 1, 100);
  const status = clean(input.status).toUpperCase();
  const allowed = ["", "ALL", "DRAFT", "RELEASED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"];
  if (!allowed.includes(status)) throw new Error("Unsupported work-order lifecycle status.");
  const params = new URLSearchParams({ limit: String(limit) });
  if (status && status !== "ALL") params.set("status", status);
  return "?" + params.toString();
}

export function buildWorkOrderPayload(input = {}) {
  const orderLineId = uuid(input.order_line_id, "order_line_id");
  const targetQuantity = quantity(input.target_quantity, "target_quantity");
  const plannedStart = calendarDate(input.planned_start_date, "planned_start_date", true);
  const dueDate = calendarDate(input.due_date, "due_date");
  if (dueDate && dueDate < plannedStart) throw new Error("due_date cannot be before planned_start_date.");
  const priority = integer(input.priority ?? 3, "priority", 1, 5);
  const notes = clean(input.notes);
  if (notes.length > 2000) throw new Error("notes must not exceed 2000 characters.");
  return {
    order_line_id: orderLineId,
    target_quantity: targetQuantity,
    planned_start_date: plannedStart,
    ...(dueDate ? { due_date: dueDate } : {}),
    priority,
    ...(notes ? { notes } : {}),
  };
}

export function buildWorkOrderTransitionPayload(command, expectedVersion, reason = "") {
  const action = clean(command).toUpperCase();
  if (!WORK_ORDER_COMMANDS.has(action)) throw new Error("Unsupported work-order transition.");
  const rationale = clean(reason);
  if (["HOLD", "CANCEL"].includes(action) && !rationale) {
    throw new Error("A reason is required to hold or cancel a work order.");
  }
  if (rationale.length > 1000) throw new Error("reason must not exceed 1000 characters.");
  return {
    expected_version: integer(expectedVersion, "expected_version", 1, 2147483647),
    ...(rationale ? { reason: rationale } : {}),
  };
}

export function buildOperationEventPayload(input = {}) {
  const command = clean(input.command).toUpperCase();
  if (!OPERATION_COMMANDS.has(command)) throw new Error("Unsupported shop-floor operation command.");
  const payload = {
    command,
    expected_work_order_version: integer(input.expected_work_order_version, "expected_work_order_version", 1, 2147483647),
    expected_operation_version: integer(input.expected_operation_version, "expected_operation_version", 1, 2147483647),
    source: "API",
  };
  const reason = clean(input.reason);
  if (["SKIP", "HOLD", "REWORK_REPORTED", "DOWNTIME_START"].includes(command) && !reason) {
    throw new Error("A reason is required for this operation event.");
  }
  if (reason) {
    if (reason.length > 1000) throw new Error("reason must not exceed 1000 characters.");
    payload.reason = reason;
  }
  if (["WIP_REPORTED", "WIP_TRANSFERRED", "REWORK_REPORTED"].includes(command)) {
    payload.quantity = quantity(input.quantity, "quantity", command === "WIP_REPORTED");
  } else if (input.quantity !== undefined && clean(String(input.quantity)) !== "") {
    payload.quantity = quantity(input.quantity, "quantity", true);
  }
  if (command === "WIP_TRANSFERRED") {
    const target = uuid(input.target_operation_id, "target_operation_id");
    if (target.toLowerCase() === clean(input.operation_id).toLowerCase()) {
      throw new Error("WIP cannot be transferred to the same operation.");
    }
    payload.target_operation_id = target;
  } else if (input.target_operation_id) {
    throw new Error("target_operation_id is only supported for WIP transfer.");
  }
  return payload;
}

export function buildProductionOutputPayload(input = {}) {
  const operationId = uuid(input.operation_id, "operation_id");
  const good = quantity(input.good_quantity, "good_quantity", true);
  const scrap = quantity(input.scrap_quantity ?? "0", "scrap_quantity", true);
  if (good + scrap <= 0) throw new Error("Good quantity and scrap quantity cannot both be zero.");
  const scrapReason = clean(input.scrap_reason);
  if (scrap > 0 && !scrapReason) throw new Error("A scrap reason is required when scrap quantity is greater than zero.");
  if (scrapReason.length > 1000) throw new Error("scrap_reason must not exceed 1000 characters.");
  const rawSerials = clean(input.finished_good_serial_codes);
  const serials = rawSerials
    ? rawSerials.split(/[\n,;]+/).map((value) => value.trim().toUpperCase()).filter(Boolean)
    : [];
  if (serials.length > 100) throw new Error("At most 100 finished-good serial codes may be posted at once.");
  if (serials.some((value) => value.length > 160 || /[\x00-\x1f\x7f-\x9f]/.test(value))) {
    throw new Error("Serial codes must contain 1 to 160 printable characters.");
  }
  if (new Set(serials).size !== serials.length) throw new Error("Finished-good serial codes must be unique.");
  if (serials.length && (!Number.isInteger(good) || serials.length !== good)) {
    throw new Error("Serial code count must exactly match whole accepted good units.");
  }
  return {
    operation_id: operationId,
    expected_work_order_version: integer(input.expected_work_order_version, "expected_work_order_version", 1, 2147483647),
    expected_operation_version: integer(input.expected_operation_version, "expected_operation_version", 1, 2147483647),
    good_quantity: good,
    scrap_quantity: scrap,
    ...(scrapReason ? { scrap_reason: scrapReason } : {}),
    ...(clean(input.notes) ? { notes: requiredText(input.notes, "notes", 2000) } : {}),
    ...(serials.length ? { finished_good_serial_codes: serials } : {}),
    source: "API",
  };
}

export function filterWorkOrders(rows = [], filters = {}) {
  const search = clean(filters.search).toLowerCase();
  const status = clean(filters.status).toUpperCase();
  return rows.filter((row) => {
    if (status && status !== "ALL" && String(row.status ?? "").toUpperCase() !== status) return false;
    if (!search) return true;
    return [row.work_order_number, row.source_order_number, row.product_code, row.product_name]
      .some((value) => String(value ?? "").toLowerCase().includes(search));
  });
}

export function summarizeProduction(workOrders = [], materialRadar = []) {
  const orders = Array.isArray(workOrders) ? workOrders : [];
  const shortages = Array.isArray(materialRadar) ? materialRadar : [];
  const statusCount = (status) => orders.filter((row) => String(row.status ?? "").toUpperCase() === status).length;
  const shortageRows = shortages.filter((row) => Number(row.projected_shortage_quantity ?? 0) > 0);
  return {
    workOrderCount: orders.length,
    draftCount: statusCount("DRAFT"),
    releasedCount: statusCount("RELEASED"),
    inProgressCount: statusCount("IN_PROGRESS"),
    onHoldCount: statusCount("ON_HOLD"),
    completedCount: statusCount("COMPLETED"),
    materialRequirementCount: shortages.length,
    shortageRequirementCount: shortageRows.length,
    projectedShortageLines: shortageRows.length,
  };
}
