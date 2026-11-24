const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSPECTION_TYPES = new Set(["INCOMING", "IN_PROCESS", "FINAL", "INVENTORY", "SUPPLIER"]);
const TARGET_TYPES = new Set(["INVENTORY_ITEM", "TRACEABILITY_UNIT", "GOODS_RECEIPT_LINE", "PRODUCTION_REPORT", "WORK_ORDER"]);
const INSPECTION_STATUSES = new Set(["OPEN", "IN_PROGRESS", "PASSED", "FAILED", "ON_HOLD", "DISPOSITIONED", "CANCELLED"]);
const PLAN_STATUSES = new Set(["DRAFT", "ACTIVE", "RETIRED"]);
const HOLD_STATUSES = new Set(["ACTIVE", "RELEASED", "DISPOSED"]);
const REWORK_STATUSES = new Set(["DRAFT", "APPROVED", "IN_PROGRESS", "COMPLETED", "REWORK_REQUIRED", "VERIFIED", "CANCELLED"]);
const DECISIONS = new Set(["START", "PASS", "FAIL", "HOLD", "CANCEL"]);
const DISPOSITIONS = new Set(["RELEASE", "USE_AS_IS", "REWORK", "SCRAP", "RETURN_TO_SUPPLIER"]);
const NCR_ACTION_TYPES = new Set(["CONTAINMENT", "CORRECTIVE", "PREVENTIVE"]);
const NCR_ACTION_TRANSITIONS = new Set(["START", "COMPLETE"]);
const NCR_VERIFICATIONS = new Set(["PASS", "FAIL"]);
const REWORK_ACTIONS = new Set(["APPROVE", "START", "COMPLETE", "VERIFY", "RESTART", "CANCEL"]);

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function bounded(value, field, min, max, uppercase = false) {
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

function integer(value, field, min, max, fallback) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(field + " must be an integer between " + min + " and " + max + ".");
  }
  return parsed;
}

function quantity(value, field, min = 0, max = 99999999999999, decimals = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(field + " must be a finite number between " + min + " and " + max + ".");
  }
  const scale = 10 ** decimals;
  if (Math.abs(parsed * scale - Math.round(parsed * scale)) > 0.000001) {
    throw new Error(field + " supports at most " + decimals + " decimal places.");
  }
  return parsed;
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

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be a JSON object.");
  }
  return value;
}

function normalizeRows(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const row = value;
  if (preferredKey && Array.isArray(row[preferredKey])) return row[preferredKey];
  for (const key of ["items", "rows", "inspections", "plans", "holds", "rework_orders", "records"]) {
    if (Array.isArray(row[key])) return row[key];
  }
  return row.data !== undefined ? normalizeRows(row.data, preferredKey) : [];
}

export function normalizeQualityRows(value, preferredKey = "items") {
  return normalizeRows(value, preferredKey);
}

export function buildQualityQuery(filters = {}, kind = "inspections") {
  const params = new URLSearchParams();
  const limit = integer(filters.limit, "limit", 1, 100, 50);
  params.set("limit", String(limit));
  if (kind === "inspections") {
    if (text(filters.status)) {
      const status = text(filters.status).toUpperCase();
      if (!INSPECTION_STATUSES.has(status)) throw new Error("Inspection status is not supported.");
      params.set("status", status);
    }
    if (text(filters.inspection_type)) {
      const type = text(filters.inspection_type).toUpperCase();
      if (!INSPECTION_TYPES.has(type)) throw new Error("Inspection type is not supported.");
      params.set("inspection_type", type);
    }
    if (text(filters.target_type)) {
      const target = text(filters.target_type).toUpperCase();
      if (!TARGET_TYPES.has(target)) throw new Error("Inspection target type is not supported.");
      params.set("target_type", target);
    }
  } else if (kind === "plans") {
    if (text(filters.status)) {
      const status = text(filters.status).toUpperCase();
      if (!PLAN_STATUSES.has(status)) throw new Error("Plan status is not supported.");
      params.set("status", status);
    }
    if (text(filters.inspection_type)) {
      const type = text(filters.inspection_type).toUpperCase();
      if (!INSPECTION_TYPES.has(type)) throw new Error("Inspection type is not supported.");
      params.set("inspection_type", type);
    }
  } else if (kind === "holds") {
    if (text(filters.status)) {
      const status = text(filters.status).toUpperCase();
      if (!HOLD_STATUSES.has(status)) throw new Error("Hold status is not supported.");
      params.set("status", status);
    }
  } else if (kind === "rework") {
    if (text(filters.status)) {
      const status = text(filters.status).toUpperCase();
      if (!REWORK_STATUSES.has(status)) throw new Error("Rework status is not supported.");
      params.set("status", status);
    }
  } else {
    throw new Error("Unsupported quality query type.");
  }
  return "?" + params.toString();
}

export function buildQualityInspectionPayload(input = {}) {
  const inspectionType = text(input.inspection_type).toUpperCase();
  const targetType = text(input.target_type).toUpperCase();
  if (!INSPECTION_TYPES.has(inspectionType)) throw new Error("Choose a supported inspection type.");
  if (!TARGET_TYPES.has(targetType)) throw new Error("Choose a supported target type.");
  const planCode = text(input.plan_code).toUpperCase();
  if (["INCOMING", "IN_PROCESS", "FINAL"].includes(inspectionType) && !planCode) {
    throw new Error("An active inspection plan is required for incoming, in-process and final inspections.");
  }
  if (planCode && !/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(planCode)) throw new Error("Plan code contains unsupported characters.");
  const sample = text(input.sample_quantity) ? quantity(input.sample_quantity, "sample_quantity", 0.0001) : undefined;
  return {
    inspection_type: inspectionType,
    target_type: targetType,
    target_id: uuid(input.target_id, "target_id"),
    ...(planCode ? { plan_code: planCode } : {}),
    ...(sample !== undefined ? { sample_quantity: sample } : {}),
    ...(text(input.notes) ? { notes: bounded(input.notes, "Notes", 1, 2000) } : {}),
  };
}

export function parseQualityCriteriaDraft(input) {
  let rows;
  try {
    rows = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("Inspection criteria must be valid JSON.");
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new Error("An inspection plan requires between 1 and 100 criteria.");
  }
  const allowedTypes = new Set(["NUMERIC", "TEXT", "BOOLEAN", "ENUM"]);
  const allowedOperators = new Set(["EQ", "NE", "GT", "GTE", "LT", "LTE", "BETWEEN", "IN", "CONTAINS"]);
  const seenCodes = new Set();
  const seenSequences = new Set();
  return rows.map((source, index) => {
    const row = record(source, "Criterion");
    const code = bounded(row.criterion_code, "criterion_code", 1, 100, true);
    if (!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(code)) throw new Error("Criterion code contains unsupported characters.");
    if (seenCodes.has(code)) throw new Error("Criterion codes must be unique.");
    seenCodes.add(code);
    const name = bounded(row.name, "Criterion name", 1, 255);
    const valueType = text(row.value_type).toUpperCase();
    const operator = text(row.comparison_operator).toUpperCase();
    if (!allowedTypes.has(valueType)) throw new Error("Criterion value_type must be NUMERIC, TEXT, BOOLEAN or ENUM.");
    if (!allowedOperators.has(operator)) throw new Error("Criterion comparison_operator is not supported.");
    if (["GT", "GTE", "LT", "LTE", "BETWEEN"].includes(operator) && valueType !== "NUMERIC") {
      throw new Error("Range comparison operators require a NUMERIC criterion.");
    }
    if (operator === "CONTAINS" && valueType !== "TEXT") throw new Error("CONTAINS is only supported for TEXT criteria.");
    if (valueType === "BOOLEAN" && !["EQ", "NE"].includes(operator)) throw new Error("BOOLEAN criteria support only EQ or NE.");
    if (valueType === "ENUM" && !["EQ", "NE", "IN"].includes(operator)) throw new Error("ENUM criteria support EQ, NE or IN.");
    const target = text(row.target_value);
    const lower = row.lower_limit === undefined || row.lower_limit === null || row.lower_limit === "" ? undefined : quantity(row.lower_limit, "lower_limit", -999999999999, 999999999999, 6);
    const upper = row.upper_limit === undefined || row.upper_limit === null || row.upper_limit === "" ? undefined : quantity(row.upper_limit, "upper_limit", -999999999999, 999999999999, 6);
    const values = row.allowed_values === undefined ? [] : row.allowed_values;
    if (!Array.isArray(values) || values.length > 100 || values.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error("allowed_values must be an array of non-empty strings.");
    }
    if (operator === "BETWEEN" && (lower === undefined || upper === undefined || lower > upper)) {
      throw new Error("BETWEEN requires lower_limit less than or equal to upper_limit.");
    }
    if (operator === "IN" && values.length === 0) throw new Error("IN requires a non-empty allowed_values list.");
    if (!["BETWEEN", "IN"].includes(operator) && !target) throw new Error("target_value is required for this comparison operator.");
    if (valueType === "BOOLEAN" && !["true", "false"].includes(target.toLowerCase())) throw new Error("BOOLEAN target_value must be true or false.");
    if (valueType === "NUMERIC" && target) quantity(target, "target_value", -999999999999, 999999999999, 6);
    if (valueType === "NUMERIC" && values.some((entry) => !Number.isFinite(Number(entry)) || Math.abs(Number(entry) * 1e6 - Math.round(Number(entry) * 1e6)) > 0.000001)) {
      throw new Error("NUMERIC allowed_values must contain numbers with at most six decimal places.");
    }
    const sequence = integer(row.sequence_number, "sequence_number", 1, 2147483647, index + 1);
    if (seenSequences.has(sequence)) throw new Error("Criterion sequence numbers must be unique.");
    seenSequences.add(sequence);
    return {
      criterion_code: code,
      name,
      ...(text(row.description) ? { description: bounded(row.description, "Description", 1, 2000) } : {}),
      value_type: valueType,
      comparison_operator: operator,
      ...(target ? { target_value: target } : {}),
      ...(lower !== undefined ? { lower_limit: lower } : {}),
      ...(upper !== undefined ? { upper_limit: upper } : {}),
      ...(values.length ? { allowed_values: values.map((entry) => entry.trim()) } : {}),
      ...(text(row.unit) ? { unit: bounded(row.unit, "Unit", 1, 50) } : {}),
      is_required: row.is_required !== false,
      is_critical: row.is_critical === true,
      sequence_number: sequence,
    };
  });
}

export function buildQualityPlanPayload(input = {}) {
  const inspectionType = text(input.inspection_type).toUpperCase();
  if (!INSPECTION_TYPES.has(inspectionType)) throw new Error("Choose a supported inspection type.");
  const code = bounded(input.plan_code, "Plan code", 1, 100, true);
  if (!/^[A-Z0-9][A-Z0-9._-]{0,99}$/.test(code)) throw new Error("Plan code contains unsupported characters.");
  const sample = text(input.default_sample_quantity)
    ? quantity(input.default_sample_quantity, "default_sample_quantity", 0.0001) : undefined;
  return {
    plan_code: code,
    name: bounded(input.name, "Plan name", 1, 255),
    inspection_type: inspectionType,
    ...(sample !== undefined ? { default_sample_quantity: sample } : {}),
    ...(text(input.notes) ? { notes: bounded(input.notes, "Notes", 1, 2000) } : {}),
    criteria: parseQualityCriteriaDraft(input.criteria),
  };
}

export function buildQualityDecisionPayload(input = {}) {
  const action = text(input.action).toUpperCase();
  if (!DECISIONS.has(action)) throw new Error("Choose START, PASS, FAIL, HOLD or CANCEL.");
  const reason = text(input.reason);
  if (["FAIL", "HOLD", "CANCEL"].includes(action) && reason.length < 3) {
    throw new Error("A reason of at least three characters is required for FAIL, HOLD and CANCEL.");
  }
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    action,
    ...(reason ? { reason: bounded(reason, "Reason", 1, 2000) } : {}),
  };
}

export function buildQualityDefectPayload(input = {}) {
  const severity = text(input.severity).toUpperCase();
  if (!["CRITICAL", "MAJOR", "MINOR"].includes(severity)) throw new Error("Choose CRITICAL, MAJOR or MINOR severity.");
  const evidence = text(input.evidence_reference);
  return {
    defect_code: bounded(input.defect_code, "Defect code", 1, 100, true),
    severity,
    affected_quantity: quantity(input.affected_quantity === undefined || input.affected_quantity === null || input.affected_quantity === "" ? 1 : input.affected_quantity, "affected_quantity", 0.0001),
    description: bounded(input.description, "Description", 3, 4000),
    ...(evidence ? { evidence: { reference: bounded(evidence, "Evidence reference", 1, 1000) } } : {}),
  };
}

export function buildQualityResultPayload(input = {}) {
  const evidence = text(input.evidence_reference);
  return {
    criterion_code: bounded(input.criterion_code, "criterion_code", 1, 100, true),
    observed_value: bounded(input.observed_value, "Observed value", 1, 1000),
    ...(text(input.notes) ? { notes: bounded(input.notes, "Notes", 1, 2000) } : {}),
    ...(evidence ? { evidence: { reference: bounded(evidence, "Evidence reference", 1, 1000) } } : {}),
  };
}

export function buildQualityDispositionPayload(input = {}) {
  const action = text(input.action).toUpperCase();
  if (!DISPOSITIONS.has(action)) throw new Error("Choose a supported quality disposition.");
  const stockAction = ["SCRAP", "RETURN_TO_SUPPLIER"].includes(action);
  const rawQuantity = text(input.quantity);
  if (stockAction && !rawQuantity) throw new Error("Quantity is required for SCRAP and RETURN_TO_SUPPLIER.");
  if (!stockAction && rawQuantity) throw new Error("Quantity is only used for SCRAP and RETURN_TO_SUPPLIER.");
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    action,
    ...(stockAction ? { quantity: quantity(rawQuantity, "quantity", 0.0001) } : {}),
    reason: bounded(input.reason, "Reason", 3, 2000),
  };
}

export function buildQualityNcrActionPayload(input = {}) {
  const actionType = text(input.action_type).toUpperCase();
  if (!NCR_ACTION_TYPES.has(actionType)) throw new Error("Choose CONTAINMENT, CORRECTIVE or PREVENTIVE.");
  const dueDate = text(input.due_date);
  return {
    action_type: actionType,
    action_text: bounded(input.action_text, "Action text", 3, 4000),
    ...(text(input.responsible_user_id) ? { responsible_user_id: uuid(input.responsible_user_id, "responsible_user_id") } : {}),
    ...(dueDate ? { due_date: dateOnly(dueDate, "due_date") } : {}),
  };
}

export function buildQualityNcrTransitionPayload(input = {}) {
  const action = text(input.action).toUpperCase();
  if (!NCR_ACTION_TRANSITIONS.has(action)) throw new Error("Choose START or COMPLETE.");
  const evidence = input.evidence === undefined ? {} : record(input.evidence, "Evidence");
  if (action === "COMPLETE" && (Object.keys(evidence).length === 0 || Object.values(evidence).every((value) => text(value) === ""))) {
    throw new Error("Completion requires non-empty evidence.");
  }
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    action,
    reason: bounded(input.reason, "Reason", 3, 2000),
    ...(Object.keys(evidence).length ? { evidence } : {}),
  };
}

export function buildQualityNcrVerificationPayload(input = {}) {
  const decision = text(input.decision).toUpperCase();
  if (!NCR_VERIFICATIONS.has(decision)) throw new Error("Choose PASS or FAIL.");
  const evidence = record(input.evidence, "Verification evidence");
  if (Object.keys(evidence).length === 0 || Object.values(evidence).every((value) => text(value) === "")) {
    throw new Error("Verification requires non-empty evidence.");
  }
  return {
    expected_version: integer(input.expected_version, "expected_version", 1, 2147483647),
    decision,
    reason: bounded(input.reason, "Reason", 3, 2000),
    evidence,
  };
}

export function summarizeQualityWorkspace({ inspections = [], plans = [], holds = [], reworkOrders = [] } = {}) {
  return {
    inspections: inspections.length,
    inProgress: inspections.filter((row) => row.status === "IN_PROGRESS").length,
    failed: inspections.filter((row) => row.status === "FAILED").length,
    activeHolds: holds.filter((row) => row.status === "ACTIVE").length,
    criticalDefects: inspections.reduce((sum, row) => sum + Number(row.defect_count ?? 0), 0),
    activePlans: plans.filter((row) => row.status === "ACTIVE").length,
    openRework: reworkOrders.filter((row) => !["COMPLETED", "VERIFIED", "CANCELLED"].includes(String(row.status))).length,
  };
}

export function filterQualityRows(rows = [], search = "", status = "ALL") {
  const term = text(search).toLocaleLowerCase();
  const wanted = text(status).toUpperCase();
  return rows.filter((row) => {
    if (wanted !== "ALL" && String(row.status ?? "").toUpperCase() !== wanted) return false;
    if (!term) return true;
    return [
      row.id, row.plan_code, row.name, row.inspection_type, row.target_type, row.target_id,
      row.defect_code, row.severity, row.ncr_number, row.rework_number, row.status,
    ].some((value) => String(value ?? "").toLocaleLowerCase().includes(term));
  });
}

export function validateQualityIdempotencyKey(value) {
  const result = text(value);
  if (!result || result.length > 220 || /[\r\n]/.test(result)) {
    throw new Error("Idempotency key must contain 1 to 220 single-line characters.");
  }
  return result;
}
