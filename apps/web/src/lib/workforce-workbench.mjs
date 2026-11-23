const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;
const CLOCK = /^(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?$/;
const EVENT_TYPES = new Set(["CLOCK_IN", "CLOCK_OUT", "BREAK_START", "BREAK_END", "ABSENCE_RECORDED"]);
const EVENT_SOURCES = new Set(["MANUAL", "BIOMETRIC", "QR", "API"]);
const ASSIGNMENT_ACTIONS = new Set(["CONFIRM", "CANCEL", "COMPLETE"]);
const OVERTIME_ACTIONS = new Set(["APPROVE", "REJECT"]);
const ATTENDANCE_QUERY_TYPES = new Set(["attendance", "coverage"]);
const RANGE_QUERY_TYPES = new Set(["overtime", "productivity", "self"]);
const SIMPLE_QUERY_TYPES = new Set(["workers", "skills", "shifts"]);

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function boundedText(value, field, min, max, uppercase = false) {
  const result = text(value);
  if (result.length < min || result.length > max) {
    throw new Error(field + " must contain " + min + " to " + max + " characters.");
  }
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
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(field + " must be a real calendar date.");
  }
  return result;
}

function timestamp(value, field) {
  const result = text(value);
  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$/i.test(result)) {
    throw new Error(field + " must be an ISO-8601 timestamp with an explicit UTC offset.");
  }
  if (!Number.isFinite(Date.parse(result))) throw new Error(field + " must be a valid timestamp.");
  return new Date(result).toISOString();
}

function integer(value, field, min, max, fallback) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(field + " must be an integer between " + min + " and " + max + ".");
  }
  return parsed;
}

function quantity(value, field, min = 0, max = 99999999999999) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(field + " must be a finite number between " + min + " and " + max + ".");
  }
  const rounded = Math.round(parsed * 10000) / 10000;
  if (Math.abs(parsed - rounded) > 1e-8) throw new Error(field + " supports at most four decimal places.");
  return rounded;
}

function rowsFrom(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value;
  if (preferredKey && Array.isArray(record[preferredKey])) return record[preferredKey];
  for (const key of ["items", "rows", "workers", "records"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  if (record.data !== undefined) return rowsFrom(record.data, preferredKey);
  return [];
}

export function normalizeWorkforceRows(value, preferredKey = "items") {
  return rowsFrom(value, preferredKey);
}

export function buildWorkforceQuery(filters = {}, kind = "workers") {
  const params = new URLSearchParams();
  if (SIMPLE_QUERY_TYPES.has(kind)) {
    const limit = integer(filters.limit, "limit", 1, 200, 200);
    params.set("limit", String(limit));
  } else if (ATTENDANCE_QUERY_TYPES.has(kind)) {
    params.set("shift_date", dateOnly(filters.shift_date, "shift_date"));
    if (text(filters.shift_template_id)) params.set("shift_template_id", uuid(filters.shift_template_id, "shift_template_id"));
    if (kind === "attendance") params.set("limit", String(integer(filters.limit, "limit", 1, 200, 200)));
  } else if (RANGE_QUERY_TYPES.has(kind)) {
    const from = dateOnly(filters.from_date, "from_date");
    const to = dateOnly(filters.to_date, "to_date");
    if (from > to) throw new Error("from_date cannot be after to_date.");
    const span = (Date.parse(to + "T00:00:00.000Z") - Date.parse(from + "T00:00:00.000Z")) / 86400000;
    if (span > 366) throw new Error("Date ranges cannot exceed 367 calendar days.");
    params.set("from_date", from);
    params.set("to_date", to);
    if (text(filters.worker_id)) params.set("worker_id", uuid(filters.worker_id, "worker_id"));
    if (kind !== "self") params.set("limit", String(integer(filters.limit, "limit", 1, 200, 200)));
  } else {
    throw new Error("Unsupported workforce query type.");
  }
  return "?" + params.toString();
}

export function buildWorkforceWorkerPayload(input = {}) {
  const employeeCode = boundedText(input.employee_code, "Employee code", 1, 100, true);
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(employeeCode)) {
    throw new Error("Employee code may contain only letters, numbers, dot, underscore, slash and hyphen.");
  }
  return {
    employee_code: employeeCode,
    display_name: boundedText(input.display_name, "Display name", 1, 255),
    ...(text(input.linked_user_id) ? { linked_user_id: uuid(input.linked_user_id, "linked_user_id") } : {}),
  };
}

export function buildWorkforceWorkerStatusPayload(status, expectedVersion, reason) {
  if (!["ACTIVE", "INACTIVE"].includes(status)) throw new Error("Worker status must be ACTIVE or INACTIVE.");
  return {
    expected_version: integer(expectedVersion, "expected_version", 1, 2147483647),
    status,
    reason: boundedText(reason, "Reason", 3, 1000),
  };
}

export function buildWorkforceSkillPayload(input = {}) {
  return {
    skill_code: boundedText(input.skill_code, "Skill code", 1, 120, true),
    name: boundedText(input.name, "Skill name", 1, 255),
    ...(text(input.description) ? { description: boundedText(input.description, "Description", 1, 4000) } : {}),
  };
}

export function buildWorkforceSkillAssignmentPayload(input = {}) {
  const certified = text(input.certified_on) ? dateOnly(input.certified_on, "certified_on") : undefined;
  const expires = text(input.certificate_expires_on) ? dateOnly(input.certificate_expires_on, "certificate_expires_on") : undefined;
  if (certified && expires && expires < certified) throw new Error("Certificate expiry cannot be before its certification date.");
  return {
    skill_id: uuid(input.skill_id, "skill_id"),
    skill_level: integer(input.skill_level, "skill_level", 1, 5),
    ...(certified ? { certified_on: certified } : {}),
    ...(expires ? { certificate_expires_on: expires } : {}),
    ...(text(input.certificate_reference) ? { certificate_reference: boundedText(input.certificate_reference, "Certificate reference", 1, 255) } : {}),
  };
}

export function buildWorkforceBiometricConsentPayload(input = {}) {
  if (typeof input.consent_granted !== "boolean") throw new Error("consent_granted must be explicit.");
  return {
    consent_granted: input.consent_granted,
    purpose: boundedText(input.purpose, "Purpose", 3, 255),
    reason: boundedText(input.reason, "Reason", 3, 2000),
  };
}

export function buildWorkforceShiftPayload(input = {}) {
  const starts = text(input.starts_at_local);
  const ends = text(input.ends_at_local);
  if (!CLOCK.test(starts) || !CLOCK.test(ends)) throw new Error("Shift times must use 24-hour HH:mm or HH:mm:ss.");
  if (starts === ends) throw new Error("Shift start and end times must differ.");
  const zone = text(input.timezone_name) || "Asia/Dhaka";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
  } catch {
    throw new Error("Timezone must be a valid IANA timezone.");
  }
  return {
    shift_code: boundedText(input.shift_code, "Shift code", 1, 80, true),
    name: boundedText(input.name, "Shift name", 1, 255),
    starts_at_local: starts.length === 5 ? starts + ":00" : starts,
    ends_at_local: ends.length === 5 ? ends + ":00" : ends,
    timezone_name: zone,
    unpaid_break_minutes: integer(input.unpaid_break_minutes, "unpaid_break_minutes", 0, 360, 0),
    late_grace_minutes: integer(input.late_grace_minutes, "late_grace_minutes", 0, 180, 0),
    overtime_threshold_minutes: integer(input.overtime_threshold_minutes, "overtime_threshold_minutes", 0, 1440, 0),
  };
}

export function buildWorkforceShiftUpdatePayload(input = {}) {
  const version = integer(input.expected_version, "expected_version", 1, 2147483647);
  const reason = boundedText(input.reason, "Reason", 3, 2000);
  const changes = {};
  if (input.name !== undefined) changes.name = boundedText(input.name, "Shift name", 1, 255);
  if (input.starts_at_local !== undefined) {
    const value = text(input.starts_at_local);
    if (!CLOCK.test(value)) throw new Error("Shift start must use 24-hour HH:mm or HH:mm:ss.");
    changes.starts_at_local = value.length === 5 ? value + ":00" : value;
  }
  if (input.ends_at_local !== undefined) {
    const value = text(input.ends_at_local);
    if (!CLOCK.test(value)) throw new Error("Shift end must use 24-hour HH:mm or HH:mm:ss.");
    changes.ends_at_local = value.length === 5 ? value + ":00" : value;
  }
  if (changes.starts_at_local && changes.ends_at_local && changes.starts_at_local === changes.ends_at_local) {
    throw new Error("Shift start and end times must differ.");
  }
  if (input.timezone_name !== undefined) {
    const zone = boundedText(input.timezone_name, "Timezone", 1, 80);
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0)); }
    catch { throw new Error("Timezone must be a valid IANA timezone."); }
    changes.timezone_name = zone;
  }
  if (input.unpaid_break_minutes !== undefined) changes.unpaid_break_minutes = integer(input.unpaid_break_minutes, "unpaid_break_minutes", 0, 360);
  if (input.late_grace_minutes !== undefined) changes.late_grace_minutes = integer(input.late_grace_minutes, "late_grace_minutes", 0, 180);
  if (input.overtime_threshold_minutes !== undefined) changes.overtime_threshold_minutes = integer(input.overtime_threshold_minutes, "overtime_threshold_minutes", 0, 1440);
  if (input.status !== undefined) {
    if (!["ACTIVE", "INACTIVE"].includes(input.status)) throw new Error("Shift status must be ACTIVE or INACTIVE.");
    changes.status = input.status;
  }
  if (Object.keys(changes).length === 0) throw new Error("At least one shift field must change.");
  return { expected_version: version, ...changes, reason };
}

export function buildWorkforceAssignmentPayload(input = {}) {
  const orderId = text(input.work_order_id) ? uuid(input.work_order_id, "work_order_id") : undefined;
  const operationId = text(input.work_order_operation_id) ? uuid(input.work_order_operation_id, "work_order_operation_id") : undefined;
  if (operationId && !orderId) throw new Error("work_order_id is required when work_order_operation_id is supplied.");
  return {
    shift_template_id: uuid(input.shift_template_id, "shift_template_id"),
    worker_id: uuid(input.worker_id, "worker_id"),
    shift_date: dateOnly(input.shift_date, "shift_date"),
    ...(orderId ? { work_order_id: orderId } : {}),
    ...(operationId ? { work_order_operation_id: operationId } : {}),
    ...(text(input.operation_code) ? { operation_code: boundedText(input.operation_code, "Operation code", 1, 120) } : {}),
    ...(text(input.required_skill_code) ? { required_skill_code: boundedText(input.required_skill_code, "Required skill code", 1, 120, true) } : {}),
  };
}

export function buildWorkforceAssignmentTransitionPayload(action, expectedVersion, reason) {
  if (!ASSIGNMENT_ACTIONS.has(action)) throw new Error("Choose CONFIRM, CANCEL or COMPLETE.");
  return {
    expected_version: integer(expectedVersion, "expected_version", 1, 2147483647),
    action,
    reason: boundedText(reason, "Reason", 3, 1000),
  };
}

export function buildWorkforceAttendancePayload(input = {}) {
  if (!EVENT_TYPES.has(input.event_type)) throw new Error("Attendance event type is not supported.");
  if (!EVENT_SOURCES.has(input.source_type)) throw new Error("Attendance source type is not supported.");
  return {
    shift_assignment_id: uuid(input.shift_assignment_id, "shift_assignment_id"),
    event_type: input.event_type,
    source_type: input.source_type,
    ...(text(input.source_event_id) ? { source_event_id: boundedText(input.source_event_id, "source_event_id", 1, 255) } : {}),
    occurred_at: timestamp(input.occurred_at, "occurred_at"),
  };
}

export function buildWorkforceAttendanceCorrectionPayload(input = {}) {
  if (!EVENT_TYPES.has(input.corrected_event_type)) throw new Error("Corrected attendance event type is not supported.");
  return {
    corrected_event_type: input.corrected_event_type,
    corrected_occurred_at: timestamp(input.corrected_occurred_at, "corrected_occurred_at"),
    reason: boundedText(input.reason, "Reason", 3, 2000),
  };
}

export function buildWorkforceOvertimePayload(input = {}) {
  return {
    shift_assignment_id: uuid(input.shift_assignment_id, "shift_assignment_id"),
    requested_minutes: integer(input.requested_minutes, "requested_minutes", 1, 1440),
    reason: boundedText(input.reason, "Reason", 3, 2000),
  };
}

export function buildWorkforceOvertimeDecisionPayload(input = {}) {
  if (!OVERTIME_ACTIONS.has(input.action)) throw new Error("Choose APPROVE or REJECT.");
  const approved = input.action === "APPROVE"
    ? integer(input.approved_minutes, "approved_minutes", 1, 1440)
    : 0;
  if (approved > Number(input.requested_minutes)) throw new Error("Approved minutes cannot exceed the request.");
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    action: input.action,
    ...(input.action === "APPROVE" ? { approved_minutes: approved } : {}),
    reason: boundedText(input.reason, "Reason", 3, 2000),
  };
}

export function buildWorkforceProductivityPayload(input = {}) {
  const started = timestamp(input.production_started_at, "production_started_at");
  const ended = timestamp(input.production_ended_at, "production_ended_at");
  const duration = (Date.parse(ended) - Date.parse(started)) / 60000;
  if (duration <= 0) throw new Error("Production end must be later than production start.");
  if (duration > 1440) throw new Error("Production interval cannot exceed 24 hours.");
  const good = quantity(input.good_quantity, "good_quantity");
  const scrap = quantity(input.scrap_quantity ?? 0, "scrap_quantity");
  if (good + scrap <= 0) throw new Error("Good and scrap quantity must total more than zero.");
  const standard = quantity(input.standard_minutes_per_unit, "standard_minutes_per_unit", 0.0001, 1440);
  const actual = quantity(input.actual_minutes, "actual_minutes", 0.0001, 1440);
  if (actual > duration) throw new Error("Actual minutes cannot exceed the production interval duration.");
  const scrapReason = text(input.scrap_reason);
  if (scrap > 0 && !scrapReason) throw new Error("A scrap reason is required when scrap quantity is positive.");
  return {
    shift_assignment_id: uuid(input.shift_assignment_id, "shift_assignment_id"),
    source_operation_event_id: uuid(input.source_operation_event_id, "source_operation_event_id"),
    work_order_id: uuid(input.work_order_id, "work_order_id"),
    work_order_operation_id: uuid(input.work_order_operation_id, "work_order_operation_id"),
    production_started_at: started,
    production_ended_at: ended,
    good_quantity: good,
    scrap_quantity: scrap,
    standard_minutes_per_unit: standard,
    actual_minutes: actual,
    ...(scrapReason ? { scrap_reason: boundedText(scrapReason, "scrap_reason", 1, 2000) } : {}),
    ...(text(input.notes) ? { notes: boundedText(input.notes, "notes", 1, 4000) } : {}),
  };
}

export function filterWorkforceWorkers(workers = [], search = "", status = "ALL") {
  const term = text(search).toLocaleLowerCase();
  const wanted = text(status).toUpperCase();
  return workers.filter((worker) => {
    if (wanted !== "ALL" && String(worker.status ?? "").toUpperCase() !== wanted) return false;
    if (!term) return true;
    return [worker.employee_code, worker.display_name, worker.status]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(term));
  });
}

export function summarizeWorkforceWorkspace({ workers = [], skills = [], shifts = [], attendance = {}, coverage = {}, overtime = [], productivity = {} } = {}) {
  return {
    activeWorkers: workers.filter((row) => row.status === "ACTIVE").length,
    inactiveWorkers: workers.filter((row) => row.status === "INACTIVE").length,
    activeSkills: skills.filter((row) => row.status === "ACTIVE").length,
    activeShifts: shifts.filter((row) => row.status === "ACTIVE").length,
    rosteredToday: Number(attendance.attendance_summary?.rostered ?? coverage.planned_assignments ?? 0),
    presentToday: Number(attendance.attendance_summary?.present ?? 0),
    uncoveredToday: Number(coverage.uncovered_count ?? 0),
    pendingOvertime: overtime.filter((row) => row.status === "PENDING").length,
    productivityReports: Number(productivity.totals?.report_count ?? 0),
    goodQuantity: Number(productivity.totals?.good_quantity ?? 0),
    scrapQuantity: Number(productivity.totals?.scrap_quantity ?? 0),
  };
}

export function formatWorkforceMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  const hours = Math.floor(minutes / 60);
  const remainder = Math.floor(minutes % 60);
  return hours ? hours + "h " + remainder + "m" : remainder + "m";
}

export function validateWorkforceIdempotencyKey(value) {
  const result = text(value);
  if (!result || result.length > 255 || /[\\r\\n]/.test(result)) {
    throw new Error("Idempotency key must contain 1 to 255 single-line characters.");
  }
  return result;
}
