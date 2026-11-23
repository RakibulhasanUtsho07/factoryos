"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
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
} from "@/lib/workforce-workbench.mjs";
type Row = Record<string, unknown>;
type Tab = "PEOPLE" | "SCHEDULE" | "ATTENDANCE" | "OVERTIME" | "PRODUCTIVITY" | "SELF";
type NoticeState = { tone: "success" | "error"; message: string };
type DraftAssignment = { id: string; row_version: number; status: string; employee_code: string; shift_date: string };
type ShiftEditDraft = { shift: Row; name: string; starts_at_local: string; ends_at_local: string; timezone_name: string; unpaid_break_minutes: string; late_grace_minutes: string; overtime_threshold_minutes: string; status: string; reason: string };
type AttendanceCorrection = { eventId: string; eventLabel: string; occurredAt: string; reason: string };
type OvertimeDecision = { id: string; rowVersion: number; action: "APPROVE" | "REJECT"; requestedMinutes: number; approvedMinutes: string; label: string };

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "PEOPLE", label: "People & skills", description: "Worker roster, competency and consent" },
  { id: "SCHEDULE", label: "Shifts & staffing", description: "Shift templates, assignments and coverage" },
  { id: "ATTENDANCE", label: "Attendance", description: "Daily attendance, corrections and time" },
  { id: "OVERTIME", label: "Overtime", description: "Requests and independent decisions" },
  { id: "PRODUCTIVITY", label: "Productivity", description: "Operation-linked output and efficiency" },
  { id: "SELF", label: "My records", description: "Personal attendance and overtime records" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function list(value: unknown, key = "items"): Row[] {
  return normalizeWorkforceRows(value, key).map((row) => object(row));
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The workforce request could not be completed.";
}

function display(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function hasBiometricConsent(worker: Row | undefined) {
  if (!worker?.biometric_consent_at) return false;
  if (!worker.biometric_consent_withdrawn_at) return true;
  return new Date(String(worker.biometric_consent_withdrawn_at)).getTime()
    < new Date(String(worker.biometric_consent_at)).getTime();
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function dateOnlyLocal(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function localDateTimeValue() {
  const date = new Date();
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function timestampFromLocal(value: string) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) throw new Error("Select a valid local date and time.");
  return parsed.toISOString();
}

function newKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure idempotency-key generation is unavailable.");
  return "workforce:" + globalThis.crypto.randomUUID();
}

function StatusPill({ value }: { value: unknown }) {
  const status = display(value, "UNKNOWN").toUpperCase();
  const tone = ["ACTIVE", "CONFIRMED", "COMPLETED", "APPROVED", "PRESENT"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["PLANNED", "PENDING", "INACTIVE", "UNCONFIRMED_ASSIGNMENT"].includes(status)
      ? "bg-amber-50 text-amber-900"
      : ["CANCELLED", "REJECTED", "ABSENT"].includes(status)
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{status.replaceAll("_", " ")}</span>;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-4 text-slate-500">{hint}</span> : null}
    </label>
  );
}

function Metric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className="mt-1 text-[10px] text-slate-500">{detail}</p>
    </article>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{children}</div>;
}

function Section({ title, subtitle, children, action }: { title: string; subtitle: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div><h2 className="text-sm font-bold text-slate-950">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p></div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>{headers.map((header) => <th key={header} className="whitespace-nowrap px-3 py-3 font-bold">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
    </div>
  );
}

export default function WorkforceOperationsPage() {
  const { status: sessionStatus, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const currentUserId = snapshot?.user.id ?? "";

  const permissions = {
    workersRead: hasPermission("workforce.workers.read"),
    workersManage: hasPermission("workforce.workers.manage"),
    skillsRead: hasPermission("workforce.skills.read"),
    skillsManage: hasPermission("workforce.skills.manage"),
    shiftsRead: hasPermission("workforce.shifts.read"),
    shiftsManage: hasPermission("workforce.shifts.manage"),
    staffingRead: hasPermission("workforce.staffing.read"),
    staffingManage: hasPermission("workforce.staffing.manage"),
    attendanceRead: hasPermission("workforce.attendance.read"),
    attendanceCapture: hasPermission("workforce.attendance.capture"),
    attendanceCorrect: hasPermission("workforce.attendance.correct"),
    overtimeRead: hasPermission("workforce.overtime.read"),
    overtimeRequest: hasPermission("workforce.overtime.request"),
    overtimeApprove: hasPermission("workforce.overtime.approve"),
    productivityRead: hasPermission("workforce.productivity.read"),
    productivityCapture: hasPermission("workforce.productivity.capture"),
    selfRead: hasPermission("workforce.self.read"),
  };
  const canRead = Object.values(permissions).some(Boolean);

  const [tab, setTab] = useState<Tab>("PEOPLE");
  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const [workers, setWorkers] = useState<Row[]>([]);
  const [skills, setSkills] = useState<Row[]>([]);
  const [shifts, setShifts] = useState<Row[]>([]);
  const [attendance, setAttendance] = useState<Row>({});
  const [coverage, setCoverage] = useState<Row>({});
  const [overtime, setOvertime] = useState<Row[]>([]);
  const [productivity, setProductivity] = useState<Row>({});
  const [selfRecords, setSelfRecords] = useState<Row>({});

  const today = dateOnlyLocal(new Date());
  const [shiftDate, setShiftDate] = useState(today);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [workerSearch, setWorkerSearch] = useState("");
  const [workerStatusFilter, setWorkerStatusFilter] = useState("ALL");

  const [workerDraft, setWorkerDraft] = useState({ employee_code: "", display_name: "", linked_user_id: "" });
  const [skillDraft, setSkillDraft] = useState({ skill_code: "", name: "", description: "" });
  const [skillAssignmentDraft, setSkillAssignmentDraft] = useState({ worker_id: "", skill_id: "", skill_level: "3", certified_on: today, certificate_expires_on: "", certificate_reference: "" });
  const [statusDraft, setStatusDraft] = useState<{ worker: Row; status: "ACTIVE" | "INACTIVE"; reason: string } | null>(null);
  const [consentDraft, setConsentDraft] = useState<{ worker: Row; consent_granted: boolean; purpose: string; reason: string } | null>(null);

  const [shiftDraft, setShiftDraft] = useState({ shift_code: "", name: "", starts_at_local: "08:00", ends_at_local: "17:00", timezone_name: "Asia/Dhaka", unpaid_break_minutes: "60", late_grace_minutes: "10", overtime_threshold_minutes: "0" });
  const [shiftEditDraft, setShiftEditDraft] = useState<ShiftEditDraft | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState({ shift_template_id: "", worker_id: "", shift_date: today, work_order_id: "", work_order_operation_id: "", operation_code: "", required_skill_code: "" });
  const [lastAssignment, setLastAssignment] = useState<DraftAssignment | null>(null);
  const [assignmentTransitionReason, setAssignmentTransitionReason] = useState("");

  const [attendanceDraft, setAttendanceDraft] = useState({ shift_assignment_id: "", event_type: "CLOCK_IN", source_type: "MANUAL", occurred_at: localDateTimeValue(), source_event_id: "" });
  const [correctionDraft, setCorrectionDraft] = useState<AttendanceCorrection | null>(null);
  const [overtimeDraft, setOvertimeDraft] = useState({ shift_assignment_id: "", requested_minutes: "60", reason: "" });
  const [overtimeDecision, setOvertimeDecision] = useState<OvertimeDecision | null>(null);
  const [overtimeDecisionReason, setOvertimeDecisionReason] = useState("");
  const [productivityDraft, setProductivityDraft] = useState({
    shift_assignment_id: "", source_operation_event_id: "", work_order_id: "", work_order_operation_id: "",
    production_started_at: localDateTimeValue(), production_ended_at: localDateTimeValue(),
    good_quantity: "", scrap_quantity: "0", standard_minutes_per_unit: "", actual_minutes: "",
    scrap_reason: "", notes: "",
  });

  const activeWorkers = useMemo(() => filterWorkforceWorkers(workers, workerSearch, workerStatusFilter), [workers, workerSearch, workerStatusFilter]);
  const attendanceShifts = list(attendance, "shifts");
  const attendanceEvents = list(attendance);
  const overtimeRows = overtime;
  const productivityRows = list(productivity);
  const workerOptions = workers.filter((row) => row.status === "ACTIVE");
  const shiftOptions = shifts.filter((row) => row.status === "ACTIVE");
  const summary = useMemo(() => summarizeWorkforceWorkspace({
    workers, skills, shifts, attendance, coverage, overtime, productivity,
  }), [workers, skills, shifts, attendance, coverage, overtime, productivity]);

  const load = useCallback(async () => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setNotice(null);
    setLoadedFactoryId("");
    try {
      const tasks: Promise<unknown>[] = [];
      const keys: string[] = [];
      const add = (key: string, enabled: boolean, path: string) => {
        if (enabled) { keys.push(key); tasks.push(request(path)); }
      };
      add("workers", permissions.workersRead, "/workforce/workers" + buildWorkforceQuery({ limit: 200 }, "workers"));
      add("skills", permissions.skillsRead, "/workforce/skills" + buildWorkforceQuery({ limit: 200 }, "skills"));
      add("shifts", permissions.shiftsRead, "/workforce/shifts" + buildWorkforceQuery({ limit: 200 }, "shifts"));
      add("attendance", permissions.attendanceRead, "/workforce/attendance" + buildWorkforceQuery({ shift_date: shiftDate, limit: 200 }, "attendance"));
      add("coverage", permissions.staffingRead, "/workforce/staffing/coverage" + buildWorkforceQuery({ shift_date: shiftDate }, "coverage"));
      add("overtime", permissions.overtimeRead, "/workforce/overtime" + buildWorkforceQuery({ from_date: fromDate, to_date: toDate, limit: 200 }, "overtime"));
      add("productivity", permissions.productivityRead, "/workforce/productivity/reports" + buildWorkforceQuery({ from_date: fromDate, to_date: toDate, limit: 200 }, "productivity"));
      add("self", permissions.selfRead, "/workforce/self/records" + buildWorkforceQuery({ from_date: fromDate, to_date: toDate }, "self"));
      const values = await Promise.all(tasks);
      const response = Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Record<string, unknown>;
      setWorkers(list(response.workers));
      setSkills(list(response.skills));
      setShifts(list(response.shifts));
      setAttendance(object(response.attendance));
      setCoverage(object(response.coverage));
      setOvertime(list(response.overtime));
      setProductivity(object(response.productivity));
      setSelfRecords(object(response.self));
      setLoadedFactoryId(activeFactoryId);
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    } finally {
      setLoading(false);
    }
  }, [
    sessionStatus, activeFactoryId, canRead, request, shiftDate, fromDate, toDate,
    permissions.workersRead, permissions.skillsRead, permissions.shiftsRead, permissions.attendanceRead,
    permissions.staffingRead, permissions.overtimeRead, permissions.productivityRead, permissions.selfRead,
  ]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, activeFactoryId, canRead, load]);

  async function perform(action: () => Promise<unknown>, success: string, refresh = true) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (refresh) await load();
      setNotice({ tone: "success", message: success });
      return true;
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceWorkerPayload(workerDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/workers", { method: "POST", body, idempotencyKey: newKey() }),
      "Worker created in the selected factory.",
    );
    if (saved) setWorkerDraft({ employee_code: "", display_name: "", linked_user_id: "" });
  }

  async function createSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceSkillPayload(skillDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/skills", { method: "POST", body, idempotencyKey: newKey() }),
      "Skill registered.",
    );
    if (saved) setSkillDraft({ skill_code: "", name: "", description: "" });
  }

  async function assignSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceSkillAssignmentPayload(skillAssignmentDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const workerId = skillAssignmentDraft.worker_id;
    const saved = await perform(
      () => request("/workforce/workers/" + workerId + "/skills", { method: "POST", body, idempotencyKey: newKey() }),
      "Worker skill and certification recorded.",
    );
    if (saved) setSkillAssignmentDraft({ worker_id: "", skill_id: "", skill_level: "3", certified_on: today, certificate_expires_on: "", certificate_reference: "" });
  }

  async function transitionWorker() {
    if (!statusDraft) return;
    let body: Row;
    try { body = buildWorkforceWorkerStatusPayload(statusDraft.status, statusDraft.worker.row_version, statusDraft.reason) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const id = String(statusDraft.worker.id);
    const saved = await perform(
      () => request("/workforce/workers/" + id + "/status", { method: "POST", body, idempotencyKey: newKey() }),
      "Worker status changed. Future planned/confirmed staffing assignments remain subject to server checks.",
    );
    if (saved) setStatusDraft(null);
  }

  async function recordConsent() {
    if (!consentDraft) return;
    let body: Row;
    try { body = buildWorkforceBiometricConsentPayload(consentDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const id = String(consentDraft.worker.id);
    const saved = await perform(
      () => request("/workforce/workers/" + id + "/biometric-consent", { method: "POST", body, idempotencyKey: newKey() }),
      consentDraft.consent_granted ? "Biometric consent grant recorded." : "Biometric consent withdrawal recorded.",
    );
    if (saved) setConsentDraft(null);
  }

  async function createShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceShiftPayload(shiftDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/shifts", { method: "POST", body, idempotencyKey: newKey() }),
      "Shift template created.",
    );
    if (saved) setShiftDraft({ ...shiftDraft, shift_code: "", name: "" });
  }

  async function updateShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shiftEditDraft) return;
    let body: Row;
    try {
      body = buildWorkforceShiftUpdatePayload({
        expected_version: shiftEditDraft.shift.row_version,
        name: shiftEditDraft.name,
        starts_at_local: shiftEditDraft.starts_at_local,
        ends_at_local: shiftEditDraft.ends_at_local,
        timezone_name: shiftEditDraft.timezone_name,
        unpaid_break_minutes: shiftEditDraft.unpaid_break_minutes,
        late_grace_minutes: shiftEditDraft.late_grace_minutes,
        overtime_threshold_minutes: shiftEditDraft.overtime_threshold_minutes,
        status: shiftEditDraft.status,
        reason: shiftEditDraft.reason,
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const id = String(shiftEditDraft.shift.id);
    const saved = await perform(
      () => request("/workforce/shifts/" + id + "/update", { method: "POST", body, idempotencyKey: newKey() }),
      "Shift template updated using the observed row version.",
    );
    if (saved) setShiftEditDraft(null);
  }

  async function createAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceAssignmentPayload(assignmentDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(async () => {
      const response = object(await request("/workforce/staffing", { method: "POST", body, idempotencyKey: newKey() }));
      setLastAssignment({
        id: String(response.id ?? ""),
        row_version: Number(response.row_version ?? 0),
        status: String(response.status ?? "PLANNED"),
        employee_code: String(response.employee_code ?? workers.find((row) => row.id === assignmentDraft.worker_id)?.employee_code ?? "Worker"),
        shift_date: assignmentDraft.shift_date,
      });
      return response;
    }, "Staffing assignment created. Confirm/cancel lifecycle is available for the returned assignment version.");
    if (saved) setAssignmentDraft({ ...assignmentDraft, worker_id: "", work_order_id: "", work_order_operation_id: "", operation_code: "", required_skill_code: "" });
  }

  async function transitionAssignment(action: "CONFIRM" | "CANCEL" | "COMPLETE") {
    if (!lastAssignment?.id || !lastAssignment.row_version) return;
    let body: Row;
    try { body = buildWorkforceAssignmentTransitionPayload(action, lastAssignment.row_version, assignmentTransitionReason) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/staffing/" + lastAssignment.id + "/transition", { method: "POST", body, idempotencyKey: newKey() }),
      "Assignment " + action.toLowerCase() + " action recorded.",
    );
    if (saved) {
      setLastAssignment({ ...lastAssignment, status: action === "CONFIRM" ? "CONFIRMED" : action === "CANCEL" ? "CANCELLED" : "COMPLETED", row_version: lastAssignment.row_version + 1 });
      setAssignmentTransitionReason("");
    }
  }

  async function createAttendance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceAttendancePayload({ ...attendanceDraft, occurred_at: timestampFromLocal(attendanceDraft.occurred_at) }) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/attendance/events", { method: "POST", body, idempotencyKey: newKey() }),
      "Attendance event captured. Effective attendance will be recalculated from the append-only event ledger.",
    );
    if (saved) setAttendanceDraft({ ...attendanceDraft, event_type: "CLOCK_OUT", occurred_at: localDateTimeValue(), source_event_id: "" });
  }

  async function correctAttendance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctionDraft) return;
    let body: Row;
    try {
      body = buildWorkforceAttendanceCorrectionPayload({
        corrected_event_type: "CLOCK_OUT",
        corrected_occurred_at: timestampFromLocal(correctionDraft.occurredAt),
        reason: correctionDraft.reason,
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/attendance/events/" + correctionDraft.eventId + "/correction", { method: "POST", body, idempotencyKey: newKey() }),
      "Append-only attendance correction recorded.",
    );
    if (saved) setCorrectionDraft(null);
  }

  async function createOvertime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildWorkforceOvertimePayload(overtimeDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/overtime", { method: "POST", body, idempotencyKey: newKey() }),
      "Overtime request submitted for independent review.",
    );
    if (saved) setOvertimeDraft({ shift_assignment_id: "", requested_minutes: "60", reason: "" });
  }

  async function decideOvertime() {
    if (!overtimeDecision) return;
    let body: Row;
    try {
      body = buildWorkforceOvertimeDecisionPayload({
        expected_version: overtimeDecision.rowVersion,
        action: overtimeDecision.action,
        approved_minutes: overtimeDecision.action === "APPROVE" ? overtimeDecision.approvedMinutes : undefined,
        requested_minutes: overtimeDecision.requestedMinutes,
        reason: overtimeDecisionReason,
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/overtime/" + overtimeDecision.id + "/decision", { method: "POST", body, idempotencyKey: newKey() }),
      "Overtime decision recorded. The requester cannot approve their own request.",
    );
    if (saved) { setOvertimeDecision(null); setOvertimeDecisionReason(""); }
  }

  async function createProductivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildWorkforceProductivityPayload({
        ...productivityDraft,
        production_started_at: timestampFromLocal(productivityDraft.production_started_at),
        production_ended_at: timestampFromLocal(productivityDraft.production_ended_at),
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/workforce/productivity/reports", { method: "POST", body, idempotencyKey: newKey() }),
      "Operation-linked productivity snapshot captured using the released routing standard.",
    );
    if (saved) setProductivityDraft({ ...productivityDraft, good_quantity: "", scrap_quantity: "0", standard_minutes_per_unit: "", actual_minutes: "", scrap_reason: "", notes: "" });
  }

  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);
  const coverageGaps = list(coverage, "gaps");
  const personalWorker = object(selfRecords.worker);
  const personalAttendance = list(selfRecords, "attendance");
  const personalOvertime = list(selfRecords, "overtime");

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-3xl bg-slate-950 px-5 py-6 text-white shadow-sm sm:px-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">FactoryOS · People operations</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Workforce Operations</h1>
              <p className="mt-2 max-w-2xl text-xs leading-6 text-slate-300 sm:text-sm">
                Factory-scoped worker records, competency, shift staffing, append-only attendance, overtime governance and operation-linked productivity.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={"rounded-full px-3 py-1.5 text-[10px] font-bold " + (hasSession ? "bg-emerald-400/15 text-emerald-200" : "bg-amber-400/15 text-amber-200")}>{hasSession ? "SESSION CONNECTED" : "SESSION REQUIRED"}</span>
              <button type="button" onClick={() => void load()} disabled={!hasSession || !canRead || loading} className="inline-flex min-h-9 items-center rounded-lg border border-white/20 px-3 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh data"}</button>
            </div>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Active workers</p><p className="mt-1 text-xl font-bold">{summary.activeWorkers}</p></div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Today present / rostered</p><p className="mt-1 text-xl font-bold">{summary.presentToday} / {summary.rosteredToday}</p></div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Coverage gaps</p><p className="mt-1 text-xl font-bold">{summary.uncoveredToday}</p></div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Pending overtime</p><p className="mt-1 text-xl font-bold">{summary.pendingOvertime}</p></div>
          </div>
          {loadedFactoryId ? <p className="mt-4 text-[10px] text-slate-400">Loaded factory context: {loadedFactoryId} · Date-based coverage and records are not factory-wide totals.</p> : null}
        </header>

        {notice ? (
          <div role="status" className={"rounded-xl border px-4 py-3 text-xs " + (notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>
            <div className="flex items-start justify-between gap-3"><span>{notice.message}</span><button type="button" className="font-bold" onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>
          </div>
        ) : null}

        {!hasSession ? (
          <Empty>Connect an authenticated FactoryOS session and select an active factory to open workforce records.</Empty>
        ) : !canRead ? (
          <Empty>Your session does not include a Workforce read permission. Ask a factory administrator to grant the specific workforce permissions required for your role.</Empty>
        ) : (
          <>
            <nav aria-label="Workforce workspaces" className="flex gap-2 overflow-x-auto pb-1">
              {TABS.map((item) => {
                const enabled = item.id === "PEOPLE" ? permissions.workersRead || permissions.workersManage || permissions.skillsRead || permissions.skillsManage
                  : item.id === "SCHEDULE" ? permissions.shiftsRead || permissions.shiftsManage || permissions.staffingRead || permissions.staffingManage
                    : item.id === "ATTENDANCE" ? permissions.attendanceRead || permissions.attendanceCapture || permissions.attendanceCorrect
                      : item.id === "OVERTIME" ? permissions.overtimeRead || permissions.overtimeRequest || permissions.overtimeApprove
                        : item.id === "PRODUCTIVITY" ? permissions.productivityRead || permissions.productivityCapture
                          : permissions.selfRead;
                return enabled ? (
                  <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-pressed={tab === item.id} className={"min-w-max rounded-xl px-4 py-3 text-left transition " + (tab === item.id ? "bg-slate-950 text-white shadow-sm" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100")}>
                    <span className="block text-xs font-bold">{item.label}</span><span className={"mt-1 block text-[10px] " + (tab === item.id ? "text-slate-300" : "text-slate-400")}>{item.description}</span>
                  </button>
                ) : null;
              })}
            </nav>

            {tab === "PEOPLE" ? (
              <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
                <div className="space-y-5">
                  <Section title="Worker roster" subtitle="Employee identifiers and factory-scoped status. Linked user accounts are optional and must already belong to this tenant." action={<span className="text-[10px] text-slate-500">{activeWorkers.length} visible · {workers.length} loaded</span>}>
                    {permissions.workersRead ? (
                      <>
                        <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_180px]">
                          <input aria-label="Search workers" className={INPUT} placeholder="Search employee code or display name" value={workerSearch} onChange={(event) => setWorkerSearch(event.target.value)} />
                          <select aria-label="Worker status" className={INPUT} value={workerStatusFilter} onChange={(event) => setWorkerStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select>
                        </div>
                        {activeWorkers.length ? <Table headers={["Employee", "Status", "Skills", "Consent", "Actions"]}>
                          {activeWorkers.map((worker) => {
                            const consentActive = hasBiometricConsent(worker);
                            return <tr key={String(worker.id)} className="align-top">
                              <td className="px-3 py-3"><p className="font-bold text-slate-900">{display(worker.employee_code)}</p><p className="mt-1 text-[11px] text-slate-500">{display(worker.display_name)}</p></td>
                              <td className="px-3 py-3"><StatusPill value={worker.status} /></td>
                              <td className="px-3 py-3 tabular-nums">{display(worker.valid_skill_count, "0")}</td>
                              <td className="px-3 py-3"><StatusPill value={consentActive ? "ACTIVE" : "NOT RECORDED"} /></td>
                              <td className="px-3 py-3"><div className="flex flex-wrap gap-1.5">
                                {permissions.workersManage ? <button type="button" className={SECONDARY} onClick={() => setStatusDraft({ worker, status: worker.status === "ACTIVE" ? "INACTIVE" : "ACTIVE", reason: "" })}>{worker.status === "ACTIVE" ? "Deactivate" : "Reactivate"}</button> : null}
                                {permissions.workersManage ? <button type="button" className={SECONDARY} onClick={() => setConsentDraft({ worker, consent_granted: !consentActive, purpose: "Workforce attendance capture", reason: "" })}>{consentActive ? "Withdraw consent" : "Record consent"}</button> : null}
                              </div></td>
                            </tr>;
                          })}
                        </Table> : <Empty>No workers match the roster filter.</Empty>}
                      </>
                    ) : <Empty>You do not have workforce.workers.read permission.</Empty>}
                  </Section>
                  {permissions.workersManage ? (
                    <Section title="Add worker" subtitle="Creates a new worker record. It does not create credentials or invite a user.">
                      <form onSubmit={createWorker} className="grid gap-3 sm:grid-cols-2">
                        <Field label="Employee code"><input required maxLength={100} className={INPUT} value={workerDraft.employee_code} onChange={(event) => setWorkerDraft({ ...workerDraft, employee_code: event.target.value })} /></Field>
                        <Field label="Display name"><input required maxLength={255} className={INPUT} value={workerDraft.display_name} onChange={(event) => setWorkerDraft({ ...workerDraft, display_name: event.target.value })} /></Field>
                        <Field label="Linked user UUID (optional)" hint="Must already be an active member of this tenant."><input className={INPUT} value={workerDraft.linked_user_id} onChange={(event) => setWorkerDraft({ ...workerDraft, linked_user_id: event.target.value })} /></Field>
                        <div className="flex items-end"><button className={PRIMARY} disabled={busy} type="submit">Create worker</button></div>
                      </form>
                    </Section>
                  ) : null}
                </div>

                <div className="space-y-5">
                  {permissions.skillsRead ? <Section title="Skill catalogue" subtitle="Factory skill register and currently qualified worker counts.">
                    {skills.length ? <div className="space-y-2">{skills.map((skill) => <div key={String(skill.id)} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><div><p className="text-xs font-bold text-slate-900">{display(skill.skill_code)} · {display(skill.name)}</p><p className="mt-1 text-[10px] text-slate-500">{display(skill.qualified_worker_count, "0")} currently qualified</p></div><StatusPill value={skill.status} /></div>)}</div> : <Empty>No skills are registered.</Empty>}
                  </Section> : null}
                  {permissions.skillsManage ? <Section title="Register skill" subtitle="Create a canonical skill code used in staffing requirements.">
                    <form onSubmit={createSkill} className="space-y-3">
                      <Field label="Skill code"><input required className={INPUT} value={skillDraft.skill_code} onChange={(event) => setSkillDraft({ ...skillDraft, skill_code: event.target.value })} /></Field>
                      <Field label="Name"><input required className={INPUT} value={skillDraft.name} onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })} /></Field>
                      <Field label="Description (optional)"><textarea className={AREA} value={skillDraft.description} onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })} /></Field>
                      <button className={PRIMARY} disabled={busy} type="submit">Register skill</button>
                    </form>
                  </Section> : null}
                  {permissions.skillsManage && permissions.workersRead && permissions.skillsRead ? <Section title="Assign certification" subtitle="Adds a versioned skill level to an active worker with optional certificate dates.">
                    <form onSubmit={assignSkill} className="space-y-3">
                      <Field label="Worker"><select required className={INPUT} value={skillAssignmentDraft.worker_id} onChange={(event) => setSkillAssignmentDraft({ ...skillAssignmentDraft, worker_id: event.target.value })}><option value="">Select worker</option>{workerOptions.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.employee_code)} · {display(row.display_name)}</option>)}</select></Field>
                      <Field label="Skill"><select required className={INPUT} value={skillAssignmentDraft.skill_id} onChange={(event) => setSkillAssignmentDraft({ ...skillAssignmentDraft, skill_id: event.target.value })}><option value="">Select skill</option>{skills.filter((row) => row.status === "ACTIVE").map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.skill_code)} · {display(row.name)}</option>)}</select></Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Level (1–5)"><select className={INPUT} value={skillAssignmentDraft.skill_level} onChange={(event) => setSkillAssignmentDraft({ ...skillAssignmentDraft, skill_level: event.target.value })}>{[1,2,3,4,5].map((n) => <option key={n} value={String(n)}>{n}</option>)}</select></Field>
                        <Field label="Certified on"><input type="date" className={INPUT} value={skillAssignmentDraft.certified_on} onChange={(event) => setSkillAssignmentDraft({ ...skillAssignmentDraft, certified_on: event.target.value })} /></Field>
                      </div>
                      <Field label="Certificate expiry (optional)"><input type="date" className={INPUT} value={skillAssignmentDraft.certificate_expires_on} onChange={(event) => setSkillAssignmentDraft({ ...skillAssignmentDraft, certificate_expires_on: event.target.value })} /></Field>
                      <Field label="Certificate reference"><input maxLength={255} className={INPUT} value={skillAssignmentDraft.certificate_reference} onChange={(event) => setSkillAssignmentDraft({ ...skillAssignmentDraft, certificate_reference: event.target.value })} /></Field>
                      <button className={PRIMARY} disabled={busy || !workerOptions.length || !skills.length} type="submit">Assign skill</button>
                    </form>
                  </Section> : null}
                </div>
              </div>
            ) : null}

            {tab === "SCHEDULE" ? (
              <div className="space-y-5">
                <div className="grid gap-5 xl:grid-cols-2">
                  {permissions.shiftsRead ? <Section title="Shift templates" subtitle="Local shift windows, timezone and policy defaults. Overnight shifts are resolved by the API.">
                    {shifts.length ? <Table headers={["Shift", "Local window", "Timezone", "Policy", "Status", "Actions"]}>
                      {shifts.map((shift) => <tr key={String(shift.id)}>
                        <td className="px-3 py-3"><p className="font-bold">{display(shift.shift_code)}</p><p className="text-[11px] text-slate-500">{display(shift.name)}</p></td>
                        <td className="whitespace-nowrap px-3 py-3 tabular-nums">{display(shift.starts_at_local)}–{display(shift.ends_at_local)}</td>
                        <td className="px-3 py-3">{display(shift.timezone_name)}</td>
                        <td className="px-3 py-3 text-[11px] text-slate-500">Break {display(shift.unpaid_break_minutes, "0")}m · Grace {display(shift.late_grace_minutes, "0")}m</td>
                        <td className="px-3 py-3"><StatusPill value={shift.status} /></td>
                        <td className="px-3 py-3">{permissions.shiftsManage ? <button type="button" className={SECONDARY} onClick={() => setShiftEditDraft({
                          shift, name: String(shift.name ?? ""), starts_at_local: String(shift.starts_at_local ?? "").slice(0,5),
                          ends_at_local: String(shift.ends_at_local ?? "").slice(0,5), timezone_name: String(shift.timezone_name ?? "Asia/Dhaka"),
                          unpaid_break_minutes: String(shift.unpaid_break_minutes ?? 0), late_grace_minutes: String(shift.late_grace_minutes ?? 0),
                          overtime_threshold_minutes: String(shift.overtime_threshold_minutes ?? 0), status: String(shift.status ?? "ACTIVE"), reason: "",
                        })}>Edit</button> : <span className="text-slate-400">—</span>}</td>
                      </tr>)}
                    </Table> : <Empty>No shift templates found.</Empty>}
                  </Section> : null}
                  {permissions.shiftsManage ? <Section title="Create shift template" subtitle="Set local times and IANA timezone; start and end times must differ.">
                    <form onSubmit={createShift} className="grid gap-3 sm:grid-cols-2">
                      <Field label="Shift code"><input required className={INPUT} value={shiftDraft.shift_code} onChange={(event) => setShiftDraft({ ...shiftDraft, shift_code: event.target.value })} /></Field>
                      <Field label="Name"><input required className={INPUT} value={shiftDraft.name} onChange={(event) => setShiftDraft({ ...shiftDraft, name: event.target.value })} /></Field>
                      <Field label="Starts at (factory local)"><input required type="time" className={INPUT} value={shiftDraft.starts_at_local} onChange={(event) => setShiftDraft({ ...shiftDraft, starts_at_local: event.target.value })} /></Field>
                      <Field label="Ends at (factory local)"><input required type="time" className={INPUT} value={shiftDraft.ends_at_local} onChange={(event) => setShiftDraft({ ...shiftDraft, ends_at_local: event.target.value })} /></Field>
                      <Field label="IANA timezone"><input required className={INPUT} value={shiftDraft.timezone_name} onChange={(event) => setShiftDraft({ ...shiftDraft, timezone_name: event.target.value })} /></Field>
                      <Field label="Unpaid break minutes"><input type="number" min="0" max="360" className={INPUT} value={shiftDraft.unpaid_break_minutes} onChange={(event) => setShiftDraft({ ...shiftDraft, unpaid_break_minutes: event.target.value })} /></Field>
                      <Field label="Late grace minutes"><input type="number" min="0" max="180" className={INPUT} value={shiftDraft.late_grace_minutes} onChange={(event) => setShiftDraft({ ...shiftDraft, late_grace_minutes: event.target.value })} /></Field>
                      <Field label="Overtime threshold minutes"><input type="number" min="0" max="1440" className={INPUT} value={shiftDraft.overtime_threshold_minutes} onChange={(event) => setShiftDraft({ ...shiftDraft, overtime_threshold_minutes: event.target.value })} /></Field>
                      <div className="flex items-end"><button type="submit" className={PRIMARY} disabled={busy}>Create shift</button></div>
                    </form>
                  </Section> : null}
                </div>

                {permissions.staffingRead ? <Section title="Staffing coverage" subtitle="Date-based roster coverage and skill-compatible backfill candidates. The uncovered count is scoped to this date and selected factory." action={<Field label="Shift date"><input type="date" className={INPUT} value={shiftDate} onChange={(event) => setShiftDate(event.target.value)} /></Field>}>
                  <div className="mb-4 grid gap-3 sm:grid-cols-3">
                    <Metric label="Planned assignments" value={Number(coverage.planned_assignments ?? 0)} detail="Selected shift date" />
                    <Metric label="Confirmed" value={Number(coverage.confirmed_assignments ?? 0)} detail="Assignments confirmed" />
                    <Metric label="Uncovered" value={Number(coverage.uncovered_count ?? 0)} detail="No attendance or absence / late grace rule" />
                  </div>
                  {coverageGaps.length ? <div className="space-y-3">{coverageGaps.map((gap, index) => <article key={String(gap.assignment_id ?? index)} className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold text-slate-900">{display(object(gap.missing_worker).employee_code)} · {display(object(gap.missing_worker).display_name)}</p><p className="mt-1 text-[11px] text-amber-800">{display(gap.reason).replaceAll("_", " ")} · {display(gap.shift_name)}</p></div><StatusPill value="UNCOVERED" /></div>
                    <p className="mt-3 text-[10px] font-bold uppercase tracking-wider text-slate-500">Skill-compatible backfill candidates</p>
                    <div className="mt-2 flex flex-wrap gap-2">{list(gap, "backfill_candidates").map((candidate) => <span key={String(candidate.worker_id)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-700">{display(candidate.employee_code)} · {display(candidate.display_name)} · {display(candidate.active_skill_count)} skills</span>)}</div>
                  </article>)}</div> : <Empty>No uncovered assignments were returned for {shiftDate}.</Empty>}
                </Section> : null}

                {permissions.staffingManage && permissions.workersRead && permissions.shiftsRead ? <Section title="Create staffing assignment" subtitle="Connect an active worker to an active shift. Optional work-order operation references are validated against the factory routing.">
                  <form onSubmit={createAssignment} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Shift template"><select required className={INPUT} value={assignmentDraft.shift_template_id} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, shift_template_id: event.target.value })}><option value="">Select shift</option>{shiftOptions.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.shift_code)} · {display(row.name)}</option>)}</select></Field>
                    <Field label="Worker"><select required className={INPUT} value={assignmentDraft.worker_id} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, worker_id: event.target.value })}><option value="">Select active worker</option>{workerOptions.map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.employee_code)} · {display(row.display_name)}</option>)}</select></Field>
                    <Field label="Shift date"><input required type="date" className={INPUT} value={assignmentDraft.shift_date} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, shift_date: event.target.value })} /></Field>
                    <Field label="Work order UUID (optional)"><input className={INPUT} value={assignmentDraft.work_order_id} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, work_order_id: event.target.value })} /></Field>
                    <Field label="Work-order operation UUID (optional)"><input className={INPUT} value={assignmentDraft.work_order_operation_id} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, work_order_operation_id: event.target.value })} /></Field>
                    <Field label="Required skill code (optional)"><input className={INPUT} value={assignmentDraft.required_skill_code} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, required_skill_code: event.target.value })} /></Field>
                    <Field label="Operation code (optional)"><input className={INPUT} value={assignmentDraft.operation_code} onChange={(event) => setAssignmentDraft({ ...assignmentDraft, operation_code: event.target.value })} /></Field>
                    <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || !workerOptions.length || !shiftOptions.length}>Create assignment</button></div>
                  </form>
                  {lastAssignment?.id ? <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold text-blue-950">Latest created assignment · {lastAssignment.employee_code}</p><p className="mt-1 text-[10px] text-blue-800">{lastAssignment.shift_date} · row version {lastAssignment.row_version}</p></div><StatusPill value={lastAssignment.status} /></div>
                    {lastAssignment.status !== "CANCELLED" && lastAssignment.status !== "COMPLETED" ? <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
                      <input className={INPUT} placeholder="Reason for assignment transition" value={assignmentTransitionReason} onChange={(event) => setAssignmentTransitionReason(event.target.value)} />
                      {lastAssignment.status === "PLANNED" ? <button type="button" className={PRIMARY} disabled={busy} onClick={() => void transitionAssignment("CONFIRM")}>Confirm</button> : null}
                      <button type="button" className={SECONDARY} disabled={busy} onClick={() => void transitionAssignment("CANCEL")}>Cancel</button>
                      {lastAssignment.status === "CONFIRMED" ? <button type="button" className={SECONDARY} disabled={busy} onClick={() => void transitionAssignment("COMPLETE")}>Complete</button> : null}
                    </div> : null}
                  </div> : null}
                </Section> : null}
              </div>
            ) : null}

            {tab === "ATTENDANCE" ? (
              <div className="space-y-5">
                <Section title="Daily attendance" subtitle="Effective events and computed shift summaries for the selected factory-local day." action={<Field label="Shift date"><input type="date" className={INPUT} value={shiftDate} onChange={(event) => setShiftDate(event.target.value)} /></Field>}>
                  <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Metric label="Rostered" value={Number(object(attendance.attendance_summary).rostered ?? 0)} detail="Non-cancelled shift assignments" />
                    <Metric label="Present" value={Number(object(attendance.attendance_summary).present ?? 0)} detail="Effective clock-in events" />
                    <Metric label="Absent" value={Number(object(attendance.attendance_summary).absent ?? 0)} detail="Absence events" />
                    <Metric label="Finalized time" value={formatWorkforceMinutes(object(attendance.attendance_summary).finalized_worked_minutes)} detail="Completed clock-in/out pairs only" />
                  </div>
                  {attendanceShifts.length ? <Table headers={["Worker", "Shift", "Clock in", "Clock out", "Worked", "Late", "State"]}>
                    {attendanceShifts.map((row) => <tr key={String(row.shift_assignment_id)}>
                      <td className="px-3 py-3"><p className="font-bold">{display(row.employee_code)}</p><p className="text-[10px] text-slate-500">{display(row.display_name)}</p></td>
                      <td className="px-3 py-3">{display(row.shift_name)}</td><td className="whitespace-nowrap px-3 py-3">{dateTime(row.clock_in_at)}</td>
                      <td className="whitespace-nowrap px-3 py-3">{dateTime(row.clock_out_at)}</td><td className="px-3 py-3">{formatWorkforceMinutes(row.worked_minutes)}</td>
                      <td className="px-3 py-3">{formatWorkforceMinutes(row.late_minutes)}</td><td className="px-3 py-3"><StatusPill value={row.absence_recorded ? "ABSENT" : row.clock_in_at ? row.clock_out_at ? "COMPLETED" : "PRESENT" : row.assignment_status} /></td>
                    </tr>)}
                  </Table> : <Empty>No shift attendance summaries were returned for this day.</Empty>}
                  <div className="mt-5">
                    <h3 className="mb-2 text-xs font-bold text-slate-900">Effective attendance event ledger</h3>
                    {attendanceEvents.length ? <Table headers={["Time", "Worker", "Event", "Source", "Assignment"]}>{attendanceEvents.map((row) => <tr key={String(row.id)}>
                      <td className="whitespace-nowrap px-3 py-3">{dateTime(row.occurred_at)}</td><td className="px-3 py-3">{display(row.employee_code)} · {display(row.display_name)}</td><td className="px-3 py-3"><StatusPill value={row.event_type} /></td><td className="px-3 py-3">{display(row.source_type)}</td><td className="px-3 py-3 font-mono text-[10px]">{display(row.shift_assignment_id).slice(0, 8)}</td>
                    </tr>)}</Table> : <Empty>No effective attendance events for this date.</Empty>}
                  </div>
                </Section>

                {permissions.attendanceCapture && permissions.staffingRead && permissions.attendanceRead ? <Section title="Capture attendance event" subtitle="Capture an event against a shift assignment. Device/QR source identifiers are optional; API validates assignment chronology and duplicate source events.">
                  <form onSubmit={createAttendance} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Shift assignment"><select required className={INPUT} value={attendanceDraft.shift_assignment_id} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, shift_assignment_id: event.target.value })}><option value="">Select assignment</option>{attendanceShifts.map((row) => <option key={String(row.shift_assignment_id)} value={String(row.shift_assignment_id)}>{display(row.employee_code)} · {display(row.shift_name)} · {display(row.assignment_status)}</option>)}</select></Field>
                    <Field label="Event type"><select className={INPUT} value={attendanceDraft.event_type} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, event_type: event.target.value })}>{["CLOCK_IN","CLOCK_OUT","BREAK_START","BREAK_END","ABSENCE_RECORDED"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></Field>
                    <Field label="Capture source"><select className={INPUT} value={attendanceDraft.source_type} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, source_type: event.target.value })}><option value="MANUAL">Manual</option><option value="QR">QR reader</option>{hasBiometricConsent(workers.find((row) => row.id === attendanceShifts.find((shift) => shift.shift_assignment_id === attendanceDraft.shift_assignment_id)?.worker_id)) ? <option value="BIOMETRIC">Biometric (worker consent active)</option> : null}<option value="API">API integration</option></select></Field>
                    <Field label="Occurred at (local browser time)"><input required type="datetime-local" className={INPUT} value={attendanceDraft.occurred_at} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, occurred_at: event.target.value })} /></Field>
                    <Field label="Device event ID (optional)"><input maxLength={255} className={INPUT} value={attendanceDraft.source_event_id} onChange={(event) => setAttendanceDraft({ ...attendanceDraft, source_event_id: event.target.value })} /></Field>
                    <div className="flex items-end"><button type="submit" className={PRIMARY} disabled={busy || !attendanceShifts.length}>Capture event</button></div>
                  </form>
                </Section> : null}

                {permissions.attendanceCorrect ? <Section title="Append attendance correction" subtitle="Corrections append a new correction record; the original attendance event is never edited or deleted.">
                  {correctionDraft ? <form onSubmit={correctAttendance} className="grid gap-3 sm:grid-cols-3">
                    <Field label="Selected event"><input readOnly className={INPUT} value={correctionDraft.eventLabel} /></Field>
                    <Field label="Corrected clock-out (local browser time)"><input required type="datetime-local" className={INPUT} value={correctionDraft.occurredAt} onChange={(event) => setCorrectionDraft({ ...correctionDraft, occurredAt: event.target.value })} /></Field>
                    <Field label="Audit reason"><input required minLength={3} maxLength={2000} className={INPUT} value={correctionDraft.reason} onChange={(event) => setCorrectionDraft({ ...correctionDraft, reason: event.target.value })} /></Field>
                    <div className="flex gap-2"><button className={PRIMARY} disabled={busy} type="submit">Append correction</button><button className={SECONDARY} type="button" onClick={() => setCorrectionDraft(null)}>Cancel</button></div>
                  </form> : <Empty>Select a CLOCK_OUT event below to start a correction. The current page only offers a correction workflow for the selected effective event.</Empty>}
                  {attendanceEvents.filter((row) => row.event_type === "CLOCK_OUT").length ? <div className="mt-3 flex flex-wrap gap-2">{attendanceEvents.filter((row) => row.event_type === "CLOCK_OUT").map((row) => <button key={String(row.id)} type="button" className={SECONDARY} onClick={() => setCorrectionDraft({ eventId: String(row.id), eventLabel: display(row.employee_code) + " · " + dateTime(row.occurred_at), occurredAt: localDateTimeValue(), reason: "" })}>Correct {display(row.employee_code)} clock-out</button>)}</div> : null}
                </Section> : null}
              </div>
            ) : null}

            {tab === "OVERTIME" ? (
              <div className="space-y-5">
                <Section title="Overtime request register" subtitle="Requests are versioned. Only a different reviewer can approve or reject a pending request." action={<div className="grid grid-cols-2 gap-2"><Field label="From"><input type="date" className={INPUT} value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></Field><Field label="To"><input type="date" className={INPUT} value={toDate} onChange={(event) => setToDate(event.target.value)} /></Field></div>}>
                  {overtimeRows.length ? <Table headers={["Worker / Date", "Requested", "Approved", "Status", "Decision", "Review"]}>
                    {overtimeRows.map((row) => <tr key={String(row.id)}>
                      <td className="px-3 py-3"><p className="font-bold">{display(row.employee_code)} · {display(row.display_name)}</p><p className="mt-1 text-[10px] text-slate-500">{display(row.shift_date)}</p><p className="mt-1 max-w-xs text-[10px] text-slate-500">{display(row.reason)}</p></td>
                      <td className="px-3 py-3 tabular-nums">{display(row.requested_minutes)}m</td><td className="px-3 py-3 tabular-nums">{display(row.approved_minutes, "—")}m</td><td className="px-3 py-3"><StatusPill value={row.status} /></td>
                      <td className="px-3 py-3 text-[10px] text-slate-500">{display(row.decision_reason)}</td>
                      <td className="px-3 py-3">{permissions.overtimeApprove && row.status === "PENDING" && String(row.requested_by_user_id ?? "") !== currentUserId ? <div className="flex gap-1"><button type="button" className={PRIMARY} onClick={() => { setOvertimeDecision({ id: String(row.id), rowVersion: Number(row.row_version), action: "APPROVE", requestedMinutes: Number(row.requested_minutes), approvedMinutes: String(row.requested_minutes), label: display(row.employee_code) }); setOvertimeDecisionReason(""); }}>Review</button><button type="button" className={DANGER} onClick={() => { setOvertimeDecision({ id: String(row.id), rowVersion: Number(row.row_version), action: "REJECT", requestedMinutes: Number(row.requested_minutes), approvedMinutes: "0", label: display(row.employee_code) }); setOvertimeDecisionReason(""); }}>Reject</button></div> : permissions.overtimeApprove && row.status === "PENDING" && String(row.requested_by_user_id ?? "") === currentUserId ? <span className="text-[10px] font-semibold text-amber-700">Self-request · cannot review</span> : <span className="text-[10px] text-slate-400">—</span>}</td>
                    </tr>)}
                  </Table> : <Empty>No overtime requests in this date range.</Empty>}
                </Section>
                {permissions.overtimeRequest && permissions.staffingRead && permissions.attendanceRead ? <Section title="Submit overtime request" subtitle="Request 1–1,440 minutes for an active or completed assignment; cancelled assignments are rejected by the API.">
                  <form onSubmit={createOvertime} className="grid gap-3 sm:grid-cols-3">
                    <Field label="Shift assignment"><select required className={INPUT} value={overtimeDraft.shift_assignment_id} onChange={(event) => setOvertimeDraft({ ...overtimeDraft, shift_assignment_id: event.target.value })}><option value="">Select assignment</option>{attendanceShifts.map((row) => <option key={String(row.shift_assignment_id)} value={String(row.shift_assignment_id)}>{display(row.employee_code)} · {display(row.shift_name)} · {display(row.shift_date)}</option>)}</select></Field>
                    <Field label="Requested minutes"><input type="number" min="1" max="1440" className={INPUT} value={overtimeDraft.requested_minutes} onChange={(event) => setOvertimeDraft({ ...overtimeDraft, requested_minutes: event.target.value })} /></Field>
                    <Field label="Reason"><input required minLength={3} maxLength={2000} className={INPUT} value={overtimeDraft.reason} onChange={(event) => setOvertimeDraft({ ...overtimeDraft, reason: event.target.value })} /></Field>
                    <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || !attendanceShifts.length}>Submit request</button></div>
                  </form>
                </Section> : null}
                {overtimeDecision ? <Section title="Independent overtime decision" subtitle="The API blocks self-approval and checks the current row version.">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Request"><input readOnly className={INPUT} value={overtimeDecision.label + " · " + overtimeDecision.requestedMinutes + " minutes"} /></Field>
                    <Field label="Decision"><input readOnly className={INPUT} value={overtimeDecision.action} /></Field>
                    {overtimeDecision.action === "APPROVE" ? <Field label="Approved minutes"><input type="number" min="1" max={overtimeDecision.requestedMinutes} className={INPUT} value={overtimeDecision.approvedMinutes} onChange={(event) => setOvertimeDecision({ ...overtimeDecision, approvedMinutes: event.target.value })} /></Field> : null}
                    <Field label="Decision reason"><input className={INPUT} value={overtimeDecisionReason} onChange={(event) => setOvertimeDecisionReason(event.target.value)} /></Field>
                  </div>
                  <div className="mt-3 flex gap-2"><button type="button" className={PRIMARY} disabled={busy} onClick={() => void decideOvertime()}>Record decision</button><button type="button" className={SECONDARY} onClick={() => setOvertimeDecision(null)}>Cancel</button></div>
                </Section> : null}
              </div>
            ) : null}

            {tab === "PRODUCTIVITY" ? (
              <div className="space-y-5">
                <Section title="Productivity evidence" subtitle="The API validates output/WIP event provenance, work-order operation and released routing standard.">
                  <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Metric label="Reports" value={Number(object(productivity.totals).report_count ?? 0)} detail="In selected date range" />
                    <Metric label="Good quantity" value={Number(object(productivity.totals).good_quantity ?? 0).toLocaleString()} detail="Source quantity units" />
                    <Metric label="Scrap quantity" value={Number(object(productivity.totals).scrap_quantity ?? 0).toLocaleString()} detail="Requires a reason at capture" />
                    <Metric label="Weighted efficiency" value={Number(productivity.weighted_efficiency_percent ?? 0).toFixed(2) + "%"} detail={formatWorkforceMinutes(object(productivity.totals).earned_minutes) + " earned / " + formatWorkforceMinutes(object(productivity.totals).actual_minutes) + " actual"} />
                  </div>
                  {productivityRows.length ? <Table headers={["Worker / operation", "Date", "Good", "Scrap", "Standard", "Actual", "Efficiency"]}>
                    {productivityRows.map((row) => <tr key={String(row.id)}>
                      <td className="px-3 py-3"><p className="font-bold">{display(row.employee_code)} · {display(row.display_name)}</p><p className="mt-1 text-[10px] text-slate-500">{display(row.operation_code)} · {display(row.work_order_id).slice(0, 8)}</p></td>
                      <td className="px-3 py-3">{display(row.shift_date)}</td><td className="px-3 py-3 tabular-nums">{display(row.good_quantity)}</td><td className="px-3 py-3 tabular-nums">{display(row.scrap_quantity)}</td>
                      <td className="px-3 py-3">{display(row.standard_minutes_per_unit)}m/u</td><td className="px-3 py-3">{display(row.actual_minutes)}m</td><td className="px-3 py-3 font-bold">{display(row.efficiency_percent)}%</td>
                    </tr>)}
                  </Table> : <Empty>No productivity reports in this date range.</Empty>}
                </Section>
                {permissions.productivityCapture ? <Section title="Capture operation productivity" subtitle="These identifiers must refer to an assignment, released work-order operation and OUTPUT_REPORTED / WIP_TRANSFERRED shop-floor event in this same factory.">
                  <form onSubmit={createProductivity} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Shift assignment UUID"><input required className={INPUT} value={productivityDraft.shift_assignment_id} onChange={(event) => setProductivityDraft({ ...productivityDraft, shift_assignment_id: event.target.value })} /></Field>
                    <Field label="Work order UUID"><input required className={INPUT} value={productivityDraft.work_order_id} onChange={(event) => setProductivityDraft({ ...productivityDraft, work_order_id: event.target.value })} /></Field>
                    <Field label="Work-order operation UUID"><input required className={INPUT} value={productivityDraft.work_order_operation_id} onChange={(event) => setProductivityDraft({ ...productivityDraft, work_order_operation_id: event.target.value })} /></Field>
                    <Field label="Source output/WIP event UUID"><input required className={INPUT} value={productivityDraft.source_operation_event_id} onChange={(event) => setProductivityDraft({ ...productivityDraft, source_operation_event_id: event.target.value })} /></Field>
                    <Field label="Production started at"><input required type="datetime-local" className={INPUT} value={productivityDraft.production_started_at} onChange={(event) => setProductivityDraft({ ...productivityDraft, production_started_at: event.target.value })} /></Field>
                    <Field label="Production ended at"><input required type="datetime-local" className={INPUT} value={productivityDraft.production_ended_at} onChange={(event) => setProductivityDraft({ ...productivityDraft, production_ended_at: event.target.value })} /></Field>
                    <Field label="Good quantity"><input required type="number" min="0" step="0.0001" className={INPUT} value={productivityDraft.good_quantity} onChange={(event) => setProductivityDraft({ ...productivityDraft, good_quantity: event.target.value })} /></Field>
                    <Field label="Scrap quantity"><input type="number" min="0" step="0.0001" className={INPUT} value={productivityDraft.scrap_quantity} onChange={(event) => setProductivityDraft({ ...productivityDraft, scrap_quantity: event.target.value })} /></Field>
                    <Field label="Released standard (minutes/unit)"><input required type="number" min="0.0001" step="0.0001" className={INPUT} value={productivityDraft.standard_minutes_per_unit} onChange={(event) => setProductivityDraft({ ...productivityDraft, standard_minutes_per_unit: event.target.value })} /></Field>
                    <Field label="Actual production minutes"><input required type="number" min="0.0001" max="1440" step="0.0001" className={INPUT} value={productivityDraft.actual_minutes} onChange={(event) => setProductivityDraft({ ...productivityDraft, actual_minutes: event.target.value })} /></Field>
                    <Field label="Scrap reason (required when scrap > 0)"><input maxLength={2000} className={INPUT} value={productivityDraft.scrap_reason} onChange={(event) => setProductivityDraft({ ...productivityDraft, scrap_reason: event.target.value })} /></Field>
                    <Field label="Notes (optional)"><input maxLength={4000} className={INPUT} value={productivityDraft.notes} onChange={(event) => setProductivityDraft({ ...productivityDraft, notes: event.target.value })} /></Field>
                    <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy}>Capture productivity</button></div>
                  </form>
                </Section> : null}
              </div>
            ) : null}

            {tab === "SELF" ? (
              <div className="space-y-5">
                <Section title="My workforce records" subtitle="Personal records are resolved by the API from your authenticated user-to-worker link.">
                  <div className="mb-4 flex flex-wrap items-end gap-3">
                    <Field label="From date"><input type="date" className={INPUT} value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></Field>
                    <Field label="To date"><input type="date" className={INPUT} value={toDate} onChange={(event) => setToDate(event.target.value)} /></Field>
                    <button type="button" className={SECONDARY} disabled={loading || busy} onClick={() => void load()}>Reload my records</button>
                  </div>
                  {personalWorker.id ? <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-bold">{display(personalWorker.employee_code)} · {display(personalWorker.display_name)}</p><p className="mt-1 text-[10px] text-slate-500">Worker account linked to the current authenticated user.</p></div> : <Empty>No active workforce worker profile is linked to your authenticated user in this factory.</Empty>}
                  <div className="grid gap-5 lg:grid-cols-2">
                    <div><h3 className="mb-2 text-xs font-bold">Attendance records</h3>{personalAttendance.length ? <Table headers={["Date", "Event", "Source", "Occurred at"]}>{personalAttendance.map((row) => <tr key={String(row.id)}><td className="px-3 py-3">{display(row.shift_date)}</td><td className="px-3 py-3"><StatusPill value={row.event_type} /></td><td className="px-3 py-3">{display(row.source_type)}</td><td className="px-3 py-3">{dateTime(row.occurred_at)}</td></tr>)}</Table> : <Empty>No personal attendance records in range.</Empty>}</div>
                    <div><h3 className="mb-2 text-xs font-bold">Overtime records</h3>{personalOvertime.length ? <Table headers={["Date", "Requested", "Approved", "Status"]}>{personalOvertime.map((row) => <tr key={String(row.id)}><td className="px-3 py-3">{display(row.shift_date)}</td><td className="px-3 py-3">{display(row.requested_minutes)}m</td><td className="px-3 py-3">{display(row.approved_minutes, "—")}m</td><td className="px-3 py-3"><StatusPill value={row.status} /></td></tr>)}</Table> : <Empty>No personal overtime records in range.</Empty>}</div>
                  </div>
                </Section>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 text-[10px] text-slate-500">
              <span>All writes use idempotency keys where the API contract requires them. The API enforces factory scope, permissions, row versions and maker-checker rules.</span>
              <span>{loading ? "Refreshing selected factory data…" : loadedFactoryId === activeFactoryId ? "Data loaded for current factory" : "No current factory snapshot"}</span>
            </div>
          </>
        )}
      </div>

      {statusDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={(event) => { event.preventDefault(); void transitionWorker(); }} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-sm font-bold">Change worker status</h2>
            <p className="mt-1 text-xs text-slate-500">{display(statusDraft.worker.employee_code)} · {display(statusDraft.worker.display_name)} → {statusDraft.status}</p>
            <Field label="Mandatory reason"><textarea required minLength={3} maxLength={1000} className={AREA + " mt-3"} value={statusDraft.reason} onChange={(event) => setStatusDraft({ ...statusDraft, reason: event.target.value })} /></Field>
            <div className="mt-4 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setStatusDraft(null)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Confirm status</button></div>
          </form>
        </div>
      ) : null}

      {consentDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={(event) => { event.preventDefault(); void recordConsent(); }} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-sm font-bold">{consentDraft.consent_granted ? "Record biometric consent" : "Withdraw biometric consent"}</h2>
            <p className="mt-1 text-xs text-slate-500">{display(consentDraft.worker.employee_code)} · {display(consentDraft.worker.display_name)}</p>
            <div className="mt-4 space-y-3">
              <Field label="Purpose"><input required maxLength={255} className={INPUT} value={consentDraft.purpose} onChange={(event) => setConsentDraft({ ...consentDraft, purpose: event.target.value })} /></Field>
              <Field label="Reason"><textarea required minLength={3} maxLength={2000} className={AREA} value={consentDraft.reason} onChange={(event) => setConsentDraft({ ...consentDraft, reason: event.target.value })} /></Field>
            </div>
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[10px] leading-4 text-amber-900">Only the consent event and timestamps are shown here. Biometric templates, images and raw biometric samples are never collected or rendered by this page.</p>
            <div className="mt-4 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setConsentDraft(null)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Record consent decision</button></div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
