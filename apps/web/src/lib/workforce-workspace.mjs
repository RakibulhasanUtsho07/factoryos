const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Workforce list limit must be between 1 and 200.");
  }
  return limit;
}

function validateDate(value, field) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error(field + " must be a valid YYYY-MM-DD date.");
  }
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(field + " must be a real calendar date.");
  }
  return value;
}

function validateUuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(field + " must be a valid UUID.");
  }
  return value.trim().toLowerCase();
}

function createShiftDateQuery({ shiftDate, shiftTemplateId } = {}) {
  const params = new URLSearchParams({
    shift_date: validateDate(shiftDate, "Shift date"),
  });
  if (shiftTemplateId) {
    params.set("shift_template_id", validateUuid(shiftTemplateId, "Shift template ID"));
  }
  return params;
}

export function createWorkforceWorkspaceClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    listWorkers({ limit = 200 } = {}) {
      return request("/workforce/workers?limit=" + validateLimit(limit));
    },

    listShifts({ limit = 200 } = {}) {
      return request("/workforce/shifts?limit=" + validateLimit(limit));
    },

    staffingCoverage({ shiftDate, shiftTemplateId } = {}) {
      const params = createShiftDateQuery({ shiftDate, shiftTemplateId });
      return request("/workforce/staffing/coverage?" + params.toString());
    },

    listAttendance({ shiftDate, shiftTemplateId, limit = 200 } = {}) {
      const params = createShiftDateQuery({ shiftDate, shiftTemplateId });
      params.set("limit", String(validateLimit(limit)));
      return request("/workforce/attendance?" + params.toString());
    },
  });
}
