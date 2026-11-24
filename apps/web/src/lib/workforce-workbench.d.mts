export interface WorkforceRow {
  id?: string;
  employee_code?: string;
  display_name?: string;
  status?: string;
  row_version?: number | string;
  [key: string]: unknown;
}
export interface WorkforceDateRange {
  from_date: string;
  to_date: string;
  worker_id?: string;
  limit?: number | string;
}
export interface WorkforceDayQuery {
  shift_date: string;
  shift_template_id?: string;
  limit?: number | string;
}
export function normalizeWorkforceRows(value: unknown, preferredKey?: string): unknown[];
export function buildWorkforceQuery(filters?: Record<string, unknown>, kind?: "workers" | "skills" | "shifts" | "attendance" | "coverage" | "overtime" | "productivity" | "self"): string;
export function buildWorkforceWorkerPayload(input?: Record<string, unknown>): {
  employee_code: string; display_name: string; linked_user_id?: string;
};
export function buildWorkforceWorkerStatusPayload(status: "ACTIVE" | "INACTIVE", expectedVersion: unknown, reason: string): {
  expected_version: number; status: "ACTIVE" | "INACTIVE"; reason: string;
};
export function buildWorkforceSkillPayload(input?: Record<string, unknown>): {
  skill_code: string; name: string; description?: string;
};
export function buildWorkforceSkillAssignmentPayload(input?: Record<string, unknown>): {
  skill_id: string; skill_level: number; certified_on?: string; certificate_expires_on?: string; certificate_reference?: string;
};
export function buildWorkforceBiometricConsentPayload(input?: Record<string, unknown>): {
  consent_granted: boolean; purpose: string; reason: string;
};
export function buildWorkforceShiftPayload(input?: Record<string, unknown>): {
  shift_code: string; name: string; starts_at_local: string; ends_at_local: string; timezone_name: string;
  unpaid_break_minutes: number; late_grace_minutes: number; overtime_threshold_minutes: number;
};
export function buildWorkforceShiftUpdatePayload(input?: Record<string, unknown>): {
  expected_version: number; reason: string; [key: string]: unknown;
};
export function buildWorkforceAssignmentPayload(input?: Record<string, unknown>): {
  shift_template_id: string; worker_id: string; shift_date: string; work_order_id?: string;
  work_order_operation_id?: string; operation_code?: string; required_skill_code?: string;
};
export function buildWorkforceAssignmentTransitionPayload(action: "CONFIRM" | "CANCEL" | "COMPLETE", expectedVersion: unknown, reason: string): {
  expected_version: number; action: "CONFIRM" | "CANCEL" | "COMPLETE"; reason: string;
};
export function buildWorkforceAttendancePayload(input?: Record<string, unknown>): {
  shift_assignment_id: string; event_type: "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END" | "ABSENCE_RECORDED";
  source_type: "MANUAL" | "BIOMETRIC" | "QR" | "API"; source_event_id?: string; occurred_at: string;
};
export function buildWorkforceAttendanceCorrectionPayload(input?: Record<string, unknown>): {
  corrected_event_type: "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END" | "ABSENCE_RECORDED";
  corrected_occurred_at: string; reason: string;
};
export function buildWorkforceOvertimePayload(input?: Record<string, unknown>): {
  shift_assignment_id: string; requested_minutes: number; reason: string;
};
export function buildWorkforceOvertimeDecisionPayload(input?: Record<string, unknown>): {
  expected_version: number; action: "APPROVE" | "REJECT"; approved_minutes?: number; reason: string;
};
export function buildWorkforceProductivityPayload(input?: Record<string, unknown>): {
  shift_assignment_id: string; source_operation_event_id: string; work_order_id: string;
  work_order_operation_id: string; production_started_at: string; production_ended_at: string;
  good_quantity: number; scrap_quantity: number; standard_minutes_per_unit: number;
  actual_minutes: number; scrap_reason?: string; notes?: string;
};
export function filterWorkforceWorkers<T extends WorkforceRow>(workers?: T[], search?: string, status?: string): T[];
export function summarizeWorkforceWorkspace(input?: {
  workers?: WorkforceRow[]; skills?: WorkforceRow[]; shifts?: WorkforceRow[];
  attendance?: Record<string, unknown>; coverage?: Record<string, unknown>;
  overtime?: WorkforceRow[]; productivity?: Record<string, unknown>;
}): Record<string, number>;
export function formatWorkforceMinutes(value: unknown): string;
export function validateWorkforceIdempotencyKey(value: unknown): string;
