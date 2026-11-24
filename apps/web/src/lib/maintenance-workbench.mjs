const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CRITICALITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const ASSET_STATUSES = new Set(["ACTIVE", "INACTIVE", "RETIRED"]);
const INTERVAL_UNITS = new Set(["DAY", "WEEK", "MONTH"]);
const PM_ACTIONS = new Set(["ACTIVATE", "PAUSE", "RESUME", "RETIRE"]);
const WO_PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const WO_ACTIONS = new Set(["APPROVE", "START", "HOLD", "RESUME", "COMPLETE", "CANCEL"]);
const ASSET_LIST = new Set(["assets"]);
const PM_LIST = new Set(["plans"]);
const WO_LIST = new Set(["work_orders"]);

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function bounded(value, field, min, max, uppercase = false) {
  const result = text(value);
  if (result.length < min || result.length > max) throw new Error(field + " must contain " + min + " to " + max + " characters.");
  return uppercase ? result.toUpperCase() : result;
}

function uuid(value, field) {
  const result = text(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result.toLowerCase();
}

function dateOnly(value, field) {
  const result = text(value);
  if (!DATE.test(result)) throw new Error(field + " must use YYYY-MM-DD.");
  const parsed = new Date(result + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new Error(field + " must be a real calendar date.");
  return result;
}

function number(value, field, min, max, decimals = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(field + " must be between " + min + " and " + max + ".");
  const factor = 10 ** decimals;
  if (Math.abs(parsed * factor - Math.round(parsed * factor)) > 1e-7) throw new Error(field + " supports at most " + decimals + " decimal places.");
  return Math.round(parsed * factor) / factor;
}

function integer(value, field, min, max, fallback) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(field + " must be an integer between " + min + " and " + max + ".");
  return parsed;
}

function isoTimestamp(value, field) {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(field + " must be a valid ISO-8601 timestamp with an explicit UTC offset.");
  }
  return new Date(result).toISOString();
}

function checklist(items) {
  if (!Array.isArray(items) || items.length > 100) throw new Error("Checklist must contain no more than 100 items.");
  const seen = new Set();
  return items.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const code = bounded(item.code, "Checklist code " + (index + 1), 1, 100, true);
    const description = bounded(item.description, "Checklist description " + (index + 1), 1, 1000);
    if (seen.has(code)) throw new Error("Checklist task codes must be unique.");
    seen.add(code);
    return { code, description, required: item.required !== false };
  });
}

export function parseMaintenanceChecklistDraft(value) {
  const source = text(value);
  if (!source) return [];
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 100) throw new Error("Checklist supports at most 100 lines.");
  return checklist(lines.map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error("Checklist line " + (index + 1) + " must use CODE | description | required/optional.");
    const required = parts[2] ? parts[2].toLowerCase() !== "optional" : true;
    if (parts[2] && !["required", "optional"].includes(parts[2].toLowerCase())) throw new Error("Checklist line " + (index + 1) + " must mark required or optional.");
    return { code: parts[0], description: parts[1], required };
  }));
}

function rowsFrom(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value;
  if (preferredKey && Array.isArray(record[preferredKey])) return record[preferredKey];
  for (const key of ["items", "assets", "plans", "work_orders", "rows"]) if (Array.isArray(record[key])) return record[key];
  if (record.data !== undefined) return rowsFrom(record.data, preferredKey);
  return [];
}

export function normalizeMaintenanceRows(value, preferredKey = "items") {
  return rowsFrom(value, preferredKey);
}

export function buildMaintenanceQuery(filters = {}, kind = "assets") {
  const params = new URLSearchParams();
  params.set("limit", String(integer(filters.limit, "limit", 1, 100, 100)));
  if (kind === "assets") {
    if (text(filters.status)) {
      if (!ASSET_STATUSES.has(filters.status)) throw new Error("Asset status is not supported.");
      params.set("status", filters.status);
    }
    if (text(filters.parent_asset_id)) params.set("parent_asset_id", uuid(filters.parent_asset_id, "parent_asset_id"));
  } else if (kind === "plans") {
    if (text(filters.status)) {
      if (!["DRAFT", "ACTIVE", "PAUSED", "RETIRED"].includes(filters.status)) throw new Error("PM plan status is not supported.");
      params.set("status", filters.status);
    }
    if (text(filters.asset_id)) params.set("asset_id", uuid(filters.asset_id, "asset_id"));
  } else if (kind === "work_orders") {
    if (text(filters.status)) {
      if (!["PLANNED", "APPROVED", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"].includes(filters.status)) throw new Error("Work-order status is not supported.");
      params.set("status", filters.status);
    }
    if (text(filters.work_order_type)) {
      if (!["PM", "BREAKDOWN"].includes(filters.work_order_type)) throw new Error("Work-order type is not supported.");
      params.set("work_order_type", filters.work_order_type);
    }
    if (text(filters.priority)) {
      if (!WO_PRIORITIES.has(filters.priority)) throw new Error("Work-order priority is not supported.");
      params.set("priority", filters.priority);
    }
    if (text(filters.asset_id)) params.set("asset_id", uuid(filters.asset_id, "asset_id"));
  } else {
    throw new Error("Unsupported maintenance query type.");
  }
  return "?" + params.toString();
}

export function buildMaintenanceAssetPayload(input = {}) {
  const commissioned = text(input.commissioned_on) ? dateOnly(input.commissioned_on, "commissioned_on") : undefined;
  const warranty = text(input.warranty_expires_on) ? dateOnly(input.warranty_expires_on, "warranty_expires_on") : undefined;
  if (commissioned && warranty && warranty < commissioned) throw new Error("Warranty expiry cannot be before commissioning.");
  const criticality = text(input.criticality) || "MEDIUM";
  if (!CRITICALITIES.has(criticality)) throw new Error("Asset criticality is not supported.");
  return {
    asset_code: bounded(input.asset_code, "Asset code", 1, 100, true),
    name: bounded(input.name, "Asset name", 1, 255),
    asset_type: bounded(input.asset_type, "Asset type", 1, 80, true),
    ...(text(input.parent_asset_id) ? { parent_asset_id: uuid(input.parent_asset_id, "parent_asset_id") } : {}),
    ...(text(input.manufacturer) ? { manufacturer: bounded(input.manufacturer, "Manufacturer", 1, 160) } : {}),
    ...(text(input.model) ? { model: bounded(input.model, "Model", 1, 160) } : {}),
    ...(text(input.serial_number) ? { serial_number: bounded(input.serial_number, "Serial number", 1, 160) } : {}),
    criticality,
    ...(text(input.location) ? { location: bounded(input.location, "Location", 1, 255) } : {}),
    ...(commissioned ? { commissioned_on: commissioned } : {}),
    ...(warranty ? { warranty_expires_on: warranty } : {}),
    ...(text(input.notes) ? { notes: bounded(input.notes, "Notes", 1, 4000) } : {}),
  };
}

export function buildMaintenanceAssetUpdatePayload(input = {}) {
  const expected = integer(input.expected_version, "expected_version", 1, 2147483647);
  const reason = bounded(input.reason, "Reason", 3, 1000);
  const changes = {};
  if (input.name !== undefined) changes.name = bounded(input.name, "Asset name", 1, 255);
  if (input.asset_type !== undefined) changes.asset_type = bounded(input.asset_type, "Asset type", 1, 80, true);
  if (input.parent_asset_id !== undefined) changes.parent_asset_id = text(input.parent_asset_id) ? uuid(input.parent_asset_id, "parent_asset_id") : null;
  for (const field of ["manufacturer", "model", "serial_number", "location", "notes"]) {
    if (input[field] !== undefined) {
      const max = field === "manufacturer" || field === "model" || field === "serial_number" ? 160 : field === "location" ? 255 : 4000;
      changes[field] = text(input[field]) ? bounded(input[field], field, 1, max) : null;
    }
  }
  if (input.criticality !== undefined) {
    if (!CRITICALITIES.has(input.criticality)) throw new Error("Asset criticality is not supported.");
    changes.criticality = input.criticality;
  }
  if (input.status !== undefined) {
    if (!ASSET_STATUSES.has(input.status)) throw new Error("Asset status is not supported.");
    changes.status = input.status;
  }
  for (const field of ["commissioned_on", "warranty_expires_on"]) {
    if (input[field] !== undefined) changes[field] = text(input[field]) ? dateOnly(input[field], field) : null;
  }
  const commissioned = Object.prototype.hasOwnProperty.call(changes, "commissioned_on")
    ? changes.commissioned_on : input.current_commissioned_on;
  const warranty = Object.prototype.hasOwnProperty.call(changes, "warranty_expires_on")
    ? changes.warranty_expires_on : input.current_warranty_expires_on;
  if (commissioned && warranty && String(warranty) < String(commissioned)) throw new Error("Warranty expiry cannot be before commissioning.");
  if (!Object.keys(changes).length) throw new Error("At least one asset field must change.");
  return { expected_version: expected, ...changes, reason };
}

export function buildMaintenancePmPlanPayload(input = {}) {
  const intervalUnit = text(input.interval_unit);
  if (!INTERVAL_UNITS.has(intervalUnit)) throw new Error("PM interval unit must be DAY, WEEK or MONTH.");
  const duration = input.estimated_duration_minutes === undefined || input.estimated_duration_minutes === ""
    ? 60 : integer(input.estimated_duration_minutes, "estimated_duration_minutes", 1, 100000);
  return {
    asset_id: uuid(input.asset_id, "asset_id"),
    plan_code: bounded(input.plan_code, "Plan code", 1, 100, true),
    name: bounded(input.name, "Plan name", 1, 255),
    ...(text(input.description) ? { description: bounded(input.description, "Description", 1, 4000) } : {}),
    interval_value: integer(input.interval_value, "interval_value", 1, 3650),
    interval_unit: intervalUnit,
    next_due_on: dateOnly(input.next_due_on, "next_due_on"),
    estimated_duration_minutes: duration,
    requires_shutdown: input.requires_shutdown === true,
    checklist: checklist(input.checklist ?? []),
  };
}

export function buildMaintenancePmTransitionPayload(input = {}) {
  if (!PM_ACTIONS.has(input.action)) throw new Error("PM action must be ACTIVATE, PAUSE, RESUME or RETIRE.");
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    action: input.action,
    reason: bounded(input.reason, "Reason", 3, 2000),
  };
}

export function buildMaintenanceGenerateDuePayload(input = {}) {
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    ...(text(input.reason) ? { reason: bounded(input.reason, "Reason", 3, 1000) } : {}),
  };
}

export function buildMaintenanceBreakdownWorkOrderPayload(input = {}) {
  if (!WO_PRIORITIES.has(input.priority)) throw new Error("Work-order priority is not supported.");
  const scheduled = text(input.scheduled_start_at) ? isoTimestamp(input.scheduled_start_at, "scheduled_start_at") : undefined;
  const due = text(input.due_at) ? isoTimestamp(input.due_at, "due_at") : undefined;
  if (scheduled && due && Date.parse(due) < Date.parse(scheduled)) throw new Error("Due date cannot be before scheduled start.");
  return {
    asset_id: uuid(input.asset_id, "asset_id"),
    priority: input.priority,
    title: bounded(input.title, "Title", 1, 255),
    description: bounded(input.description, "Description", 1, 4000),
    ...(text(input.failure_code) ? { failure_code: bounded(input.failure_code, "Failure code", 1, 100, true) } : {}),
    ...(scheduled ? { scheduled_start_at: scheduled } : {}),
    ...(due ? { due_at: due } : {}),
    ...(text(input.assigned_to_user_id) ? { assigned_to_user_id: uuid(input.assigned_to_user_id, "assigned_to_user_id") } : {}),
    checklist: checklist(input.checklist ?? []),
  };
}

export function buildMaintenanceWorkOrderTransitionPayload(input = {}) {
  if (!WO_ACTIONS.has(input.action)) throw new Error("Maintenance work-order action is not supported.");
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    action: input.action,
    reason: bounded(input.reason, "Reason", 3, 2000),
  };
}

export function buildMaintenanceTaskCompletionPayload(input = {}) {
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).length === 0) {
    throw new Error("Checklist completion requires non-empty structured evidence.");
  }
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    reason: bounded(input.reason, "Reason", 3, 2000),
    evidence,
  };
}

export function buildMaintenanceSparePartPayload(input = {}) {
  return {
    inventory_item_id: uuid(input.inventory_item_id, "inventory_item_id"),
    required_quantity: number(input.required_quantity, "required_quantity", 0.0001, 99999999999999, 4),
    ...(text(input.notes) ? { notes: bounded(input.notes, "Notes", 1, 1000) } : {}),
  };
}

export function buildMaintenanceSparePartIssuePayload(input = {}) {
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    quantity: number(input.quantity, "quantity", 0.0001, 99999999999999, 4),
    reason: bounded(input.reason, "Reason", 3, 1000),
  };
}

export function filterMaintenanceRows(rows = [], search = "", status = "ALL") {
  const term = text(search).toLocaleLowerCase();
  const wanted = text(status).toUpperCase();
  return rows.filter((row) => {
    if (wanted !== "ALL" && String(row.status ?? "").toUpperCase() !== wanted) return false;
    if (!term) return true;
    return [row.asset_code, row.name, row.asset_type, row.plan_code, row.work_order_number, row.title, row.status, row.priority]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(term));
  });
}

export function summarizeMaintenanceWorkspace({ assets = [], plans = [], workOrders = [] } = {}) {
  return {
    activeAssets: assets.filter((row) => row.status === "ACTIVE").length,
    criticalAssets: assets.filter((row) => row.criticality === "CRITICAL" || row.criticality === "HIGH").length,
    activePlans: plans.filter((row) => row.status === "ACTIVE").length,
    duePlans: plans.filter((row) => row.status === "ACTIVE" && String(row.next_due_on ?? "") <= new Date().toISOString().slice(0, 10)).length,
    openWorkOrders: workOrders.filter((row) => !["COMPLETED", "CANCELLED"].includes(String(row.status))).length,
    urgentWorkOrders: workOrders.filter((row) => row.priority === "URGENT" && !["COMPLETED", "CANCELLED"].includes(String(row.status))).length,
    overdueWorkOrders: workOrders.filter((row) => row.due_at && new Date(String(row.due_at)).getTime() < Date.now() && !["COMPLETED", "CANCELLED"].includes(String(row.status))).length,
  };
}

export function validateMaintenanceIdempotencyKey(value) {
  const result = text(value);
  if (!result || result.length > 220 || /[\r\n]/.test(result)) throw new Error("Idempotency key must contain 1 to 220 single-line characters.");
  return result;
}
