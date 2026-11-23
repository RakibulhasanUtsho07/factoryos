import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkforceAssignmentPayload,
  buildWorkforceAssignmentTransitionPayload,
  buildWorkforceAttendanceCorrectionPayload,
  buildWorkforceAttendancePayload,
  buildWorkforceBiometricConsentPayload,
  buildWorkforceOvertimeDecisionPayload,
  buildWorkforceOvertimePayload,
  buildWorkforceProductivityPayload,
  buildWorkforceQuery,
  buildWorkforceShiftPayload,
  buildWorkforceShiftUpdatePayload,
  buildWorkforceSkillAssignmentPayload,
  buildWorkforceSkillPayload,
  buildWorkforceWorkerPayload,
  buildWorkforceWorkerStatusPayload,
  filterWorkforceWorkers,
  formatWorkforceMinutes,
  normalizeWorkforceRows,
  summarizeWorkforceWorkspace,
  validateWorkforceIdempotencyKey,
} from "./workforce-workbench.mjs";

const worker = "7e2e7d1a-8a1b-4d6f-9ab7-5a30b102c8a1";
const shift = "a2f4c3d8-81a0-4c29-9d0a-5b11d3c7e2f9";
const assignment = "b1c4d9e8-8a51-4f8f-b3a0-4c8a7e8d1a22";
const skill = "c5e0d3a9-b87f-4e75-9dd2-2d88e6c2a3b4";
const workOrder = "d7a3c5e9-4f2b-4a91-8c3d-6f8e0a1b2c33";
const operation = "e8b4d6f1-5a3c-4b82-9d4e-7a9b0c1d2e44";
const event = "f9c5e7a2-6b4d-4c93-ae5f-8b0c1d2e3f55";

test("normalizes direct arrays, wrapped items and nested data collections", () => {
  const items = [{ id: "one" }];
  assert.deepEqual(normalizeWorkforceRows(items), items);
  assert.deepEqual(normalizeWorkforceRows({ items }), items);
  assert.deepEqual(normalizeWorkforceRows({ workers: items }, "workers"), items);
  assert.deepEqual(normalizeWorkforceRows({ data: { rows: items } }), items);
  assert.deepEqual(normalizeWorkforceRows(null), []);
});

test("builds bounded worker, skills and shifts list queries", () => {
  assert.equal(new URLSearchParams(buildWorkforceQuery({ limit: 50 }, "workers").slice(1)).get("limit"), "50");
  assert.equal(new URLSearchParams(buildWorkforceQuery({}, "skills").slice(1)).get("limit"), "200");
  assert.throws(() => buildWorkforceQuery({ limit: 201 }, "workers"), /between 1 and 200/);
  assert.throws(() => buildWorkforceQuery({}, "unsupported"), /Unsupported/);
});

test("builds attendance and coverage day filters with optional shift UUID", () => {
  const query = new URLSearchParams(buildWorkforceQuery({
    shift_date: "2026-11-23", shift_template_id: shift, limit: 40,
  }, "attendance").slice(1));
  assert.equal(query.get("shift_date"), "2026-11-23");
  assert.equal(query.get("shift_template_id"), shift);
  assert.equal(query.get("limit"), "40");
  assert.equal(new URLSearchParams(buildWorkforceQuery({ shift_date: "2026-11-23" }, "coverage").slice(1)).has("limit"), false);
});

test("rejects invalid attendance dates and shift identifiers", () => {
  assert.throws(() => buildWorkforceQuery({ shift_date: "2026-02-30" }, "attendance"), /real calendar date/);
  assert.throws(() => buildWorkforceQuery({ shift_date: "2026-11-23", shift_template_id: "bad" }, "coverage"), /valid UUID/);
});

test("builds bounded date-range queries and optional worker filters", () => {
  const query = new URLSearchParams(buildWorkforceQuery({
    from_date: "2026-11-01", to_date: "2026-11-30", worker_id: worker, limit: 100,
  }, "overtime").slice(1));
  assert.equal(query.get("from_date"), "2026-11-01");
  assert.equal(query.get("to_date"), "2026-11-30");
  assert.equal(query.get("worker_id"), worker);
  assert.equal(query.get("limit"), "100");
  assert.throws(() => buildWorkforceQuery({ from_date: "2026-12-01", to_date: "2026-11-30" }, "productivity"), /cannot be after/);
  assert.throws(() => buildWorkforceQuery({ from_date: "2025-01-01", to_date: "2026-11-01" }, "self"), /cannot exceed/);
});

test("builds normalized worker creation payload and optional linked user", () => {
  assert.deepEqual(buildWorkforceWorkerPayload({
    employee_code: " emp-001 ", display_name: "  A Worker ", linked_user_id: worker,
  }), { employee_code: "EMP-001", display_name: "A Worker", linked_user_id: worker });
  assert.throws(() => buildWorkforceWorkerPayload({ employee_code: "bad code", display_name: "Worker" }), /only letters/);
  assert.throws(() => buildWorkforceWorkerPayload({ employee_code: "A", display_name: "" }), /Display name/);
  assert.throws(() => buildWorkforceWorkerPayload({ employee_code: "A", display_name: "Worker", linked_user_id: "x" }), /valid UUID/);
});

test("builds worker status transitions with optimistic version and mandatory reason", () => {
  assert.deepEqual(buildWorkforceWorkerStatusPayload("INACTIVE", "4", "Assignment completed"), {
    expected_version: 4, status: "INACTIVE", reason: "Assignment completed",
  });
  assert.throws(() => buildWorkforceWorkerStatusPayload("REMOVED", 2, "Reason"), /ACTIVE or INACTIVE/);
  assert.throws(() => buildWorkforceWorkerStatusPayload("ACTIVE", 0, "Reason"), /positive integer/);
  assert.throws(() => buildWorkforceWorkerStatusPayload("ACTIVE", 2, "no"), /Reason/);
});

test("builds skills and skill assignment with valid certification chronology", () => {
  assert.deepEqual(buildWorkforceSkillPayload({ skill_code: " sew-01 ", name: "Sewing" }), {
    skill_code: "SEW-01", name: "Sewing",
  });
  assert.deepEqual(buildWorkforceSkillAssignmentPayload({
    skill_id: skill, skill_level: "4", certified_on: "2026-01-01", certificate_expires_on: "2027-01-01",
  }), { skill_id: skill, skill_level: 4, certified_on: "2026-01-01", certificate_expires_on: "2027-01-01" });
  assert.throws(() => buildWorkforceSkillAssignmentPayload({
    skill_id: skill, skill_level: 4, certified_on: "2026-02-01", certificate_expires_on: "2026-01-01",
  }), /expiry cannot be before/);
  assert.throws(() => buildWorkforceSkillAssignmentPayload({ skill_id: skill, skill_level: 6 }), /between 1 and 5/);
});

test("requires explicit biometric consent choice, purpose and reason", () => {
  assert.deepEqual(buildWorkforceBiometricConsentPayload({
    consent_granted: false, purpose: "Attendance capture", reason: "Employee withdrew consent",
  }), { consent_granted: false, purpose: "Attendance capture", reason: "Employee withdrew consent" });
  assert.throws(() => buildWorkforceBiometricConsentPayload({ purpose: "attendance", reason: "Reason" }), /explicit/);
});

test("builds shift templates with IANA timezone and defaults", () => {
  const payload = buildWorkforceShiftPayload({
    shift_code: "day", name: "Day shift", starts_at_local: "08:00", ends_at_local: "17:00",
  });
  assert.equal(payload.shift_code, "DAY");
  assert.equal(payload.starts_at_local, "08:00:00");
  assert.equal(payload.ends_at_local, "17:00:00");
  assert.equal(payload.timezone_name, "Asia/Dhaka");
  assert.equal(payload.unpaid_break_minutes, 0);
  assert.throws(() => buildWorkforceShiftPayload({
    shift_code: "NIGHT", name: "Night", starts_at_local: "18:00", ends_at_local: "18:00",
  }), /must differ/);
  assert.throws(() => buildWorkforceShiftPayload({
    shift_code: "NIGHT", name: "Night", starts_at_local: "25:00", ends_at_local: "06:00",
  }), /24-hour/);
  assert.throws(() => buildWorkforceShiftPayload({
    shift_code: "NIGHT", name: "Night", starts_at_local: "18:00", ends_at_local: "06:00", timezone_name: "Mars/Olympus",
  }), /IANA/);
});

test("builds optimistic versioned shift updates and rejects no-op payloads", () => {
  assert.deepEqual(buildWorkforceShiftUpdatePayload({
    expected_version: "3", name: "Evening shift", late_grace_minutes: "10", reason: "Adjust staffing policy",
  }), { expected_version: 3, name: "Evening shift", late_grace_minutes: 10, reason: "Adjust staffing policy" });
  assert.throws(() => buildWorkforceShiftUpdatePayload({ expected_version: 1, reason: "No changes" }), /At least one/);
  assert.throws(() => buildWorkforceShiftUpdatePayload({
    expected_version: 1, starts_at_local: "08:00", ends_at_local: "08:00", reason: "Change shift hours",
  }), /must differ/);
});

test("builds factory-scoped staffing assignment with optional work order references", () => {
  assert.deepEqual(buildWorkforceAssignmentPayload({
    shift_template_id: shift, worker_id: worker, shift_date: "2026-11-23",
    work_order_id: workOrder, work_order_operation_id: operation, required_skill_code: "sewing",
  }), {
    shift_template_id: shift, worker_id: worker, shift_date: "2026-11-23",
    work_order_id: workOrder, work_order_operation_id: operation, required_skill_code: "SEWING",
  });
  assert.throws(() => buildWorkforceAssignmentPayload({
    shift_template_id: shift, worker_id: worker, shift_date: "2026-11-23",
    work_order_operation_id: operation,
  }), /work_order_id is required/);
});

test("builds allowed staffing transitions with row version and reason", () => {
  assert.deepEqual(buildWorkforceAssignmentTransitionPayload("CONFIRM", "2", "Supervisor confirmed staffing"), {
    expected_version: 2, action: "CONFIRM", reason: "Supervisor confirmed staffing",
  });
  assert.throws(() => buildWorkforceAssignmentTransitionPayload("APPROVE", 2, "Reason"), /CONFIRM/);
});

test("builds attendance events only from supported event and source types", () => {
  assert.deepEqual(buildWorkforceAttendancePayload({
    shift_assignment_id: assignment, event_type: "CLOCK_IN", source_type: "QR",
    occurred_at: "2026-11-23T08:01:00+06:00", source_event_id: "reader-123",
  }), {
    shift_assignment_id: assignment, event_type: "CLOCK_IN", source_type: "QR",
    occurred_at: "2026-11-23T02:01:00.000Z", source_event_id: "reader-123",
  });
  assert.throws(() => buildWorkforceAttendancePayload({
    shift_assignment_id: assignment, event_type: "CLOCK_IN", source_type: "DEVICE",
    occurred_at: "2026-11-23T08:00:00+06:00",
  }), /source type/);
  assert.throws(() => buildWorkforceAttendancePayload({
    shift_assignment_id: assignment, event_type: "CLOCK_IN", source_type: "MANUAL",
    occurred_at: "2026-11-23T08:00:00",
  }), /explicit UTC offset/);
});

test("builds append-only attendance corrections with audit reason", () => {
  assert.deepEqual(buildWorkforceAttendanceCorrectionPayload({
    corrected_event_type: "CLOCK_OUT", corrected_occurred_at: "2026-11-23T17:15:00Z",
    reason: "Reader had network outage",
  }), {
    corrected_event_type: "CLOCK_OUT", corrected_occurred_at: "2026-11-23T17:15:00.000Z",
    reason: "Reader had network outage",
  });
  assert.throws(() => buildWorkforceAttendanceCorrectionPayload({
    corrected_event_type: "CLOCK_IN", corrected_occurred_at: "2026-11-23T17:00:00Z", reason: "x",
  }), /Reason/);
});

test("builds overtime requests and reviewer decisions with approved minute bounds", () => {
  assert.deepEqual(buildWorkforceOvertimePayload({
    shift_assignment_id: assignment, requested_minutes: "90", reason: "Urgent delivery",
  }), { shift_assignment_id: assignment, requested_minutes: 90, reason: "Urgent delivery" });
  assert.deepEqual(buildWorkforceOvertimeDecisionPayload({
    expected_version: "2", action: "APPROVE", approved_minutes: "60",
    requested_minutes: 90, reason: "Approved by supervisor",
  }), { expected_version: 2, action: "APPROVE", approved_minutes: 60, reason: "Approved by supervisor" });
  assert.deepEqual(buildWorkforceOvertimeDecisionPayload({
    expected_version: 2, action: "REJECT", requested_minutes: 90, reason: "Capacity unavailable",
  }), { expected_version: 2, action: "REJECT", reason: "Capacity unavailable" });
  assert.throws(() => buildWorkforceOvertimeDecisionPayload({
    expected_version: 2, action: "APPROVE", approved_minutes: 100, requested_minutes: 90, reason: "Approval",
  }), /cannot exceed/);
});

test("builds productivity reports with operation provenance, quantity precision and scrap reason", () => {
  assert.deepEqual(buildWorkforceProductivityPayload({
    shift_assignment_id: assignment, source_operation_event_id: event, work_order_id: workOrder,
    work_order_operation_id: operation, production_started_at: "2026-11-23T08:00:00+06:00",
    production_ended_at: "2026-11-23T10:00:00+06:00", good_quantity: "10.5",
    scrap_quantity: "0.5", standard_minutes_per_unit: "5", actual_minutes: "45",
    scrap_reason: "Needle break",
  }), {
    shift_assignment_id: assignment, source_operation_event_id: event, work_order_id: workOrder,
    work_order_operation_id: operation, production_started_at: "2026-11-23T02:00:00.000Z",
    production_ended_at: "2026-11-23T04:00:00.000Z", good_quantity: 10.5, scrap_quantity: 0.5,
    standard_minutes_per_unit: 5, actual_minutes: 45, scrap_reason: "Needle break",
  });
  assert.throws(() => buildWorkforceProductivityPayload({
    shift_assignment_id: assignment, source_operation_event_id: event, work_order_id: workOrder,
    work_order_operation_id: operation, production_started_at: "2026-11-23T08:00:00Z",
    production_ended_at: "2026-11-23T10:00:00Z", good_quantity: 1, scrap_quantity: 1,
    standard_minutes_per_unit: 5, actual_minutes: 30,
  }), /scrap reason/);
});

test("rejects actual productivity exceeding elapsed production interval", () => {
  assert.throws(() => buildWorkforceProductivityPayload({
    shift_assignment_id: assignment, source_operation_event_id: event, work_order_id: workOrder,
    work_order_operation_id: operation, production_started_at: "2026-11-23T08:00:00Z",
    production_ended_at: "2026-11-23T09:00:00Z", good_quantity: 1,
    standard_minutes_per_unit: 5, actual_minutes: 61,
  }), /cannot exceed/);
});

test("filters workers by safe roster metadata and status", () => {
  const workers = [
    { id: "1", employee_code: "EMP-001", display_name: "A Worker", status: "ACTIVE" },
    { id: "2", employee_code: "EMP-002", display_name: "B Worker", status: "INACTIVE" },
  ];
  assert.deepEqual(filterWorkforceWorkers(workers, "a worker").map((row) => row.id), ["1"]);
  assert.deepEqual(filterWorkforceWorkers(workers, "", "INACTIVE").map((row) => row.id), ["2"]);
});

test("summarizes workforce, attendance, coverage, overtime and productivity views", () => {
  assert.deepEqual(summarizeWorkforceWorkspace({
    workers: [{ status: "ACTIVE" }, { status: "INACTIVE" }],
    skills: [{ status: "ACTIVE" }], shifts: [{ status: "ACTIVE" }],
    attendance: { attendance_summary: { rostered: 8, present: 6 } },
    coverage: { uncovered_count: 2 },
    overtime: [{ status: "PENDING" }, { status: "APPROVED" }],
    productivity: { totals: { report_count: 3, good_quantity: "100", scrap_quantity: "5" } },
  }), {
    activeWorkers: 1, inactiveWorkers: 1, activeSkills: 1, activeShifts: 1,
    rosteredToday: 8, presentToday: 6, uncoveredToday: 2, pendingOvertime: 1,
    productivityReports: 3, goodQuantity: 100, scrapQuantity: 5,
  });
});

test("formats work durations without changing source minutes", () => {
  assert.equal(formatWorkforceMinutes(135), "2h 15m");
  assert.equal(formatWorkforceMinutes(59), "59m");
  assert.equal(formatWorkforceMinutes(-1), "—");
});

test("validates request idempotency keys", () => {
  assert.equal(validateWorkforceIdempotencyKey("workforce:create:one"), "workforce:create:one");
  assert.throws(() => validateWorkforceIdempotencyKey(""), /1 to 255/);
  assert.throws(() => validateWorkforceIdempotencyKey("bad\nkey"), /single-line/);
});
