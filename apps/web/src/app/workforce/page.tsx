"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createWorkforceWorkspaceClient } from "@/lib/workforce-workspace.mjs";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  StatusBadge,
} from "@/components/ui";

type JsonRecord = Record<string, unknown>;
type SectionResult = {
  permitted: boolean;
  items: JsonRecord[];
  count: number;
  error: string;
};
type DirectoryResult = {
  key: string;
  workers: SectionResult;
  shifts: SectionResult;
};
type DailyResult = {
  key: string;
  coverage: { permitted: boolean; payload: JsonRecord; error: string };
  attendance: { permitted: boolean; payload: JsonRecord; error: string };
};

function localDateValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord =>
      item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function valueText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number)
    : valueText(value);
}

function formatMinutes(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return valueText(value);
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return hours ? hours + "h " + remainder + "m" : remainder + "m";
}

function formatDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
}

function sectionResult(
  permitted: boolean,
  items: JsonRecord[] = [],
  count = 0,
  error = "",
): SectionResult {
  return { permitted, items, count, error };
}

async function loadSection(
  permitted: boolean,
  load: () => Promise<unknown>,
): Promise<SectionResult> {
  if (!permitted) return sectionResult(false);
  try {
    const response = asRecord(await load());
    const items = asRecords(response.items);
    const count = items.length;
    return sectionResult(true, items, count);
  } catch (cause) {
    return sectionResult(
      true,
      [],
      0,
      cause instanceof Error ? cause.message : "The workforce list could not be loaded.",
    );
  }
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      </CardContent>
    </Card>
  );
}

function displayReason(value: unknown) {
  return valueText(value, "Not specified").replaceAll("_", " ").toLowerCase();
}

export default function WorkforceWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [shiftDate, setShiftDate] = useState(localDateValue);
  const [selectedShift, setSelectedShift] = useState<{ scopeKey: string; shiftTemplateId: string } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [directoryResult, setDirectoryResult] = useState<DirectoryResult | null>(null);
  const [dailyResult, setDailyResult] = useState<DailyResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadWorkers = connected && hasPermission("workforce.workers.read");
  const canReadShifts = connected && hasPermission("workforce.shifts.read");
  const canReadCoverage = connected && hasPermission("workforce.staffing.read");
  const canReadAttendance = connected && hasPermission("workforce.attendance.read");
  const canReadAny = canReadWorkers || canReadShifts || canReadCoverage || canReadAttendance;
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const selectedShiftTemplateId = selectedShift?.scopeKey === scopeKey
    ? selectedShift.shiftTemplateId
    : "";

  const directoryKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadWorkers,
    canReadShifts,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadWorkers,
    canReadShifts,
    refreshVersion,
  ]);

  const dailyKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadCoverage,
    canReadAttendance,
    shiftDate,
    selectedShiftTemplateId,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadCoverage,
    canReadAttendance,
    shiftDate,
    selectedShiftTemplateId,
    refreshVersion,
  ]);

  const currentDirectory = directoryResult?.key === directoryKey ? directoryResult : null;
  const currentDaily = dailyResult?.key === dailyKey ? dailyResult : null;
  const loadingDirectory = connected && Boolean(activeFactoryId)
    && (canReadWorkers || canReadShifts) && currentDirectory === null;
  const loadingDaily = connected && Boolean(activeFactoryId)
    && (canReadCoverage || canReadAttendance) && currentDaily === null;

  useEffect(() => {
    if (!connected || !activeFactoryId || (!canReadWorkers && !canReadShifts)) return;

    let active = true;
    const client = createWorkforceWorkspaceClient({ request });
    void Promise.all([
      loadSection(canReadWorkers, () => client.listWorkers({ limit: 200 })),
      loadSection(canReadShifts, () => client.listShifts({ limit: 200 })),
    ]).then(([workers, shifts]) => {
      if (!active) return;
      setDirectoryResult({ key: directoryKey, workers, shifts });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadWorkers,
    canReadShifts,
    request,
    refreshVersion,
    directoryKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || (!canReadCoverage && !canReadAttendance)) return;

    let active = true;
    const client = createWorkforceWorkspaceClient({ request });
    const dateInput = {
      shiftDate,
      ...(selectedShiftTemplateId ? { shiftTemplateId: selectedShiftTemplateId } : {}),
    };
    const loadCoverage = async () => {
      if (!canReadCoverage) return { permitted: false, payload: {}, error: "" };
      try {
        return {
          permitted: true,
          payload: asRecord(await client.staffingCoverage(dateInput)),
          error: "",
        };
      } catch (cause) {
        return {
          permitted: true,
          payload: {},
          error: cause instanceof Error ? cause.message : "Staffing coverage could not be loaded.",
        };
      }
    };
    const loadAttendance = async () => {
      if (!canReadAttendance) return { permitted: false, payload: {}, error: "" };
      try {
        return {
          permitted: true,
          payload: asRecord(await client.listAttendance({ ...dateInput, limit: 200 })),
          error: "",
        };
      } catch (cause) {
        return {
          permitted: true,
          payload: {},
          error: cause instanceof Error ? cause.message : "Attendance records could not be loaded.",
        };
      }
    };

    void Promise.all([loadCoverage(), loadAttendance()]).then(([coverage, attendance]) => {
      if (!active) return;
      setDailyResult({ key: dailyKey, coverage, attendance });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadCoverage,
    canReadAttendance,
    request,
    shiftDate,
    selectedShiftTemplateId,
    refreshVersion,
    dailyKey,
  ]);

  const workers = currentDirectory?.workers.items ?? [];
  const shifts = currentDirectory?.shifts.items ?? [];
  const coverage = asRecord(currentDaily?.coverage.payload);
  const gaps = asRecords(coverage.gaps);
  const attendance = asRecord(currentDaily?.attendance.payload);
  const attendanceSummary = asRecord(attendance.attendance_summary);
  const attendanceShifts = asRecords(attendance.shifts);
  const attendanceEvents = asRecords(attendance.items);

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="People operations · shift execution"
        title="Workforce Workbench"
        description="Review factory staffing coverage, attendance summaries, shift templates and workforce records for a selected shift date."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!connected || !activeFactoryId || !canReadAny || loadingDirectory || loadingDaily}
            >
              Refresh workforce
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Alert tone={connected && activeFactoryId ? "success" : "warning"} title="Workspace scope">
          {connected && snapshot
            ? snapshot.tenant.name + (activeFactory
              ? " · " + activeFactory.code + " — " + activeFactory.name
              : " · Select an active factory")
            : "Connect an existing FactoryOS session to inspect workforce records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canReadAny ? "success" : "info"} title="Workforce read permissions">
          {canReadAny
            ? "Each workforce section is gated by the current IAM permission snapshot. The API remains authoritative for every request."
            : "Workers, shifts, staffing and attendance sections require their corresponding workforce read permissions."}
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory returned by the authenticated IAM session. Workforce data is never loaded across all factories."
        />
      ) : null}

      {connected && activeFactoryId && !canReadAny ? (
        <EmptyState
          title="Workforce access is not available"
          description="The current IAM permission snapshot does not include a workforce read permission. Ask an authorized administrator to review your access."
        />
      ) : null}

      {connected && activeFactoryId && canReadAny ? (
        <>
          <Card className="mb-5">
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,240px)_minmax(0,320px)_auto] sm:items-end">
                <div>
                  <label htmlFor="workforce-shift-date" className="block text-sm font-semibold text-slate-800">
                    Shift date
                  </label>
                  <input
                    id="workforce-shift-date"
                    type="date"
                    value={shiftDate}
                    onChange={(event) => { if (event.target.value) setShiftDate(event.target.value); }}
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                  />
                </div>
                <div>
                  <label htmlFor="workforce-shift-filter" className="block text-sm font-semibold text-slate-800">
                    Shift template
                  </label>
                  <select
                    id="workforce-shift-filter"
                    value={selectedShiftTemplateId}
                    onChange={(event) => setSelectedShift({ scopeKey, shiftTemplateId: event.target.value })}
                    disabled={!canReadShifts || loadingDirectory}
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm disabled:bg-slate-100"
                  >
                    <option value="">All shifts</option>
                    {shifts.map((shift) => (
                      <option key={valueText(shift.id)} value={valueText(shift.id, "")}>
                        {valueText(shift.shift_code)} · {valueText(shift.name)}
                      </option>
                    ))}
                  </select>
                  {!canReadShifts ? (
                    <p className="mt-1 text-[11px] text-slate-500">Shift filter requires workforce.shifts.read.</p>
                  ) : null}
                </div>
                <div className="text-xs text-slate-500">
                  Selected date: <span className="font-semibold text-slate-700">{shiftDate || "Choose a date"}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Rostered shifts"
              value={currentDaily?.attendance.permitted ? formatNumber(attendanceSummary.rostered) : "—"}
              hint="Attendance summary · selected date"
            />
            <MetricCard
              label="Present"
              value={currentDaily?.attendance.permitted ? formatNumber(attendanceSummary.present) : "—"}
              hint="Persisted effective clock-in events"
            />
            <MetricCard
              label="Absent"
              value={currentDaily?.attendance.permitted ? formatNumber(attendanceSummary.absent) : "—"}
              hint="Recorded absence events"
            />
            <MetricCard
              label="Uncovered assignments"
              value={currentDaily?.coverage.permitted ? formatNumber(coverage.uncovered_count) : "—"}
              hint="Server-calculated coverage gaps"
            />
          </div>

          <div className="mb-6 grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Staffing coverage</CardTitle>
                    <CardDescription>Shift assignments and uncovered positions calculated by the workforce API.</CardDescription>
                  </div>
                  <Badge tone="neutral">Date scoped</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!canReadCoverage ? (
                  <EmptyState title="Staffing read permission required" description="This section requires workforce.staffing.read." />
                ) : currentDaily?.coverage.error ? (
                  <Alert tone="danger" title="Could not load staffing coverage">{currentDaily.coverage.error}</Alert>
                ) : loadingDaily ? (
                  <div className="h-48 animate-pulse rounded-xl bg-slate-100" aria-label="Loading staffing coverage" />
                ) : currentDaily?.coverage.permitted ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Planned</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(coverage.planned_assignments)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Confirmed</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(coverage.confirmed_assignments)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Uncovered</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(coverage.uncovered_count)}</p>
                      </div>
                    </div>
                    <div className="mt-4 space-y-3">
                      {gaps.length ? gaps.map((gap) => {
                        const missing = asRecord(gap.missing_worker);
                        const candidates = asRecords(gap.backfill_candidates);
                        return (
                          <article key={valueText(gap.assignment_id)} className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="font-semibold text-slate-900">
                                  {valueText(missing.employee_code)} · {valueText(missing.display_name)}
                                </p>
                                <p className="mt-1 text-xs text-slate-600">
                                  {valueText(gap.shift_name, "Shift not recorded")} · {displayReason(gap.reason)}
                                </p>
                              </div>
                              <Badge tone="warning">Coverage gap</Badge>
                            </div>
                            {gap.required_skill_code ? (
                              <p className="mt-2 text-xs text-slate-600">
                                Required skill: {valueText(gap.required_skill_code)}
                              </p>
                            ) : null}
                            <div className="mt-3 border-t border-amber-200 pt-2">
                              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                API-returned backfill candidates ({candidates.length})
                              </p>
                              {candidates.length ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {candidates.map((candidate) => (
                                    <span key={valueText(candidate.worker_id)} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700">
                                      {valueText(candidate.employee_code)} · {valueText(candidate.display_name)}
                                      {" · " + formatNumber(candidate.active_skill_count) + " skills"}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <p className="mt-1 text-xs text-slate-500">No eligible backfill candidates were returned.</p>
                              )}
                            </div>
                          </article>
                        );
                      }) : (
                        <EmptyState title="No uncovered assignments returned" description="The workforce API did not report a coverage gap for this date and shift filter." />
                      )}
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Attendance summary</CardTitle>
                    <CardDescription>Server-computed attendance totals and shift-level clock records.</CardDescription>
                  </div>
                  <Badge tone="neutral">Date scoped</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!canReadAttendance ? (
                  <EmptyState title="Attendance read permission required" description="This section requires workforce.attendance.read." />
                ) : currentDaily?.attendance.error ? (
                  <Alert tone="danger" title="Could not load attendance">{currentDaily.attendance.error}</Alert>
                ) : loadingDaily ? (
                  <div className="h-48 animate-pulse rounded-xl bg-slate-100" aria-label="Loading attendance" />
                ) : currentDaily?.attendance.permitted ? (
                  <>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Clocked out</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(attendanceSummary.clocked_out)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Finalized shifts</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(attendanceSummary.finalized_shifts)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3 sm:col-span-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Finalized worked time</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{formatMinutes(attendanceSummary.finalized_worked_minutes)}</p>
                      </div>
                    </div>
                    <div className="mt-4 space-y-2">
                      {attendanceShifts.length ? attendanceShifts.map((item) => (
                        <article key={valueText(item.shift_assignment_id)} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="font-semibold text-slate-900">{valueText(item.employee_code)} · {valueText(item.display_name)}</p>
                              <p className="mt-1 text-xs text-slate-500">{valueText(item.shift_code)} · {valueText(item.shift_name)}</p>
                            </div>
                            <StatusBadge status={valueText(item.assignment_status, "UNKNOWN")} />
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600">
                            <span>Clock in: {formatDateTime(item.clock_in_at)}</span>
                            <span>Clock out: {formatDateTime(item.clock_out_at)}</span>
                            <span>Worked: {formatMinutes(item.worked_minutes)}</span>
                            <span>Late: {formatMinutes(item.late_minutes)}</span>
                          </div>
                          {item.absence_recorded === true ? (
                            <p className="mt-2 text-xs font-semibold text-rose-700">Absence recorded</p>
                          ) : null}
                        </article>
                      )) : (
                        <EmptyState title="No shift attendance summaries" description="No attendance summaries were returned for this date and shift filter." />
                      )}
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Attendance event log</CardTitle>
                  <CardDescription>Effective clock, break and absence events returned for the selected date.</CardDescription>
                </div>
                <Badge tone="neutral">{currentDaily?.attendance.permitted ? attendanceEvents.length + " returned events" : "Permission gated"}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              {!canReadAttendance ? (
                <EmptyState title="Attendance read permission required" description="This event log requires workforce.attendance.read." />
              ) : currentDaily?.attendance.error ? (
                <Alert tone="danger" title="Could not load attendance events">{currentDaily.attendance.error}</Alert>
              ) : loadingDaily ? (
                <div className="h-28 animate-pulse rounded-xl bg-slate-100" aria-label="Loading attendance events" />
              ) : attendanceEvents.length ? (
                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-3 font-bold">Employee</th>
                        <th className="px-3 py-3 font-bold">Event</th>
                        <th className="px-3 py-3 font-bold">Source</th>
                        <th className="px-3 py-3 font-bold">Occurred at</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {attendanceEvents.map((event) => (
                        <tr key={valueText(event.id)}>
                          <td className="px-3 py-3">
                            <p className="font-semibold text-slate-800">{valueText(event.employee_code)}</p>
                            <p className="text-xs text-slate-500">{valueText(event.display_name)}</p>
                          </td>
                          <td className="px-3 py-3"><StatusBadge status={valueText(event.event_type, "UNKNOWN")} /></td>
                          <td className="px-3 py-3 text-xs text-slate-600">{valueText(event.source_type)}</td>
                          <td className="px-3 py-3 text-xs text-slate-600">{formatDateTime(event.occurred_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                    Showing up to 200 effective attendance events returned by the API.
                  </p>
                </div>
              ) : (
                <EmptyState title="No attendance events returned" description="No effective attendance events were returned for this date and shift filter." />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Worker directory</CardTitle>
                    <CardDescription>Factory-scoped worker records and valid skill counts.</CardDescription>
                  </div>
                  <Badge tone="neutral">200-row limit</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!canReadWorkers ? (
                  <EmptyState title="Worker read permission required" description="This section requires workforce.workers.read." />
                ) : currentDirectory?.workers.error ? (
                  <Alert tone="danger" title="Could not load workers">{currentDirectory.workers.error}</Alert>
                ) : loadingDirectory ? (
                  <div className="h-32 animate-pulse rounded-xl bg-slate-100" aria-label="Loading workers" />
                ) : workers.length ? (
                  <div className="space-y-2">
                    {workers.map((worker) => (
                      <div key={valueText(worker.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3">
                        <div>
                          <p className="font-semibold text-slate-900">{valueText(worker.employee_code)} · {valueText(worker.display_name)}</p>
                          <p className="mt-1 text-xs text-slate-500">{formatNumber(worker.valid_skill_count)} valid skills</p>
                        </div>
                        <StatusBadge status={valueText(worker.status, "UNKNOWN")} />
                      </div>
                    ))}
                    <p className="text-[11px] text-slate-500">Showing {workers.length} of up to 200 workers returned.</p>
                  </div>
                ) : (
                  <EmptyState title="No workers returned" description="No worker records were returned for this factory." />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Shift templates</CardTitle>
                    <CardDescription>Configured local shift hours, time zones and attendance thresholds.</CardDescription>
                  </div>
                  <Badge tone="neutral">200-row limit</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!canReadShifts ? (
                  <EmptyState title="Shift read permission required" description="This section requires workforce.shifts.read." />
                ) : currentDirectory?.shifts.error ? (
                  <Alert tone="danger" title="Could not load shifts">{currentDirectory.shifts.error}</Alert>
                ) : loadingDirectory ? (
                  <div className="h-32 animate-pulse rounded-xl bg-slate-100" aria-label="Loading shifts" />
                ) : shifts.length ? (
                  <div className="space-y-2">
                    {shifts.map((shift) => (
                      <div key={valueText(shift.id)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold text-slate-900">{valueText(shift.shift_code)} · {valueText(shift.name)}</p>
                          <StatusBadge status={valueText(shift.status, "UNKNOWN")} />
                        </div>
                        <p className="mt-2 text-sm font-medium text-slate-700">
                          {valueText(shift.starts_at_local)} – {valueText(shift.ends_at_local)}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span>{valueText(shift.timezone_name, "Timezone not recorded")}</span>
                          <span>Unpaid break: {formatNumber(shift.unpaid_break_minutes)} min</span>
                          <span>Late grace: {formatNumber(shift.late_grace_minutes)} min</span>
                        </div>
                      </div>
                    ))}
                    <p className="text-[11px] text-slate-500">Showing {shifts.length} of up to 200 shift templates returned.</p>
                  </div>
                ) : (
                  <EmptyState title="No shift templates returned" description="No shift templates were returned for this factory." />
                )}
              </CardContent>
            </Card>
          </div>

          <p className="mt-4 text-xs leading-5 text-slate-500">
            This workbench is read-only. It does not create workers or shifts, assign staffing, capture or correct attendance, submit overtime, or approve/reject overtime. The API remains authoritative for identity, permissions and factory scope.
          </p>
        </>
      ) : null}
    </main>
  );
}
