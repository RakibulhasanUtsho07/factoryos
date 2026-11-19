"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  filterMrpRequirements,
  formatMrpQuantity,
  summarizeCapacityOperations,
  summarizeMrpRequirements,
} from "@/lib/mrp-workbench.mjs";

type Row = Record<string, unknown>;
type MrpRun = Row & {
  id: string;
  horizon_start: string;
  horizon_end: string;
  allocation_policy: string;
  summary: Row;
  exceptions: unknown[];
  created_at: string;
};
type MrpRequirement = Row & {
  id: string;
  order_number: string;
  component_sku: string;
  component_name: string;
  component_unit: string;
  need_by_date: string;
  required_quantity: string;
  shortage_quantity: string;
  allocation_status: string;
};
type CapacityPlan = Row & {
  id: string;
  plan_version: number;
  scenario_name: string;
  summary: Row;
  created_at: string;
};
type CapacityOperation = Row & {
  id: string;
  order_number: string;
  operation_code: string;
  operation_name: string;
  work_centre_code: string;
  status: string;
  conflict_codes: string[];
  required_minutes: string;
  scheduled_minutes: string;
  planned_start_date: string | null;
  planned_finish_date: string | null;
  allocations: Row[];
};
type CalendarEntry = Row & {
  id: string;
  work_centre_code: string;
  work_centre_name: string;
  shift_code: string;
  capacity_date: string;
  line_code: string;
  available_minutes: number;
  parallel_lines: number;
  status: string;
  row_version: string;
};

type View = "materials" | "capacity" | "calendar";

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}
function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function dateLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
function Metric({ label, value, detail, tone = "slate" }: { label: string; value: string; detail: string; tone?: "slate" | "blue" | "amber" | "emerald" }) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/70",
    amber: "border-amber-100 bg-amber-50/70",
    emerald: "border-emerald-100 bg-emerald-50/70",
  };
  return <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
    <p className="mt-1 text-xs text-slate-500">{detail}</p>
  </article>;
}
function Status({ value }: { value: unknown }) {
  const status = text(value, "UNKNOWN").toUpperCase();
  const tone = status === "COVERED" || status === "SCHEDULED" || status === "ACTIVE"
    ? "bg-emerald-50 text-emerald-700"
    : status === "LATE_SUPPLY" || status.includes("CONFLICT") || status === "UNSUPPLIED"
      ? "bg-amber-50 text-amber-800"
      : status.startsWith("BLOCKED") || status === "INACTIVE"
        ? "bg-rose-50 text-rose-700"
        : "bg-slate-100 text-slate-600";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold " + tone}>{status.replaceAll("_", " ")}</span>;
}

export default function MrpPlanningWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("mrp.read");
  const canWrite = hasPermission("mrp.write");
  const canCapacityRead = hasPermission("mrp.capacity.read");
  const canCapacityPlan = hasPermission("mrp.capacity.plan");

  const [runs, setRuns] = useState<MrpRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState<MrpRun | null>(null);
  const [requirements, setRequirements] = useState<MrpRequirement[]>([]);
  const [capacityPlans, setCapacityPlans] = useState<CapacityPlan[]>([]);
  const [selectedCapacityPlanId, setSelectedCapacityPlanId] = useState("");
  const [capacityDetail, setCapacityDetail] = useState<Row | null>(null);
  const [calendarEntries, setCalendarEntries] = useState<CalendarEntry[]>([]);
  const [view, setView] = useState<View>("materials");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [capacityLoading, setCapacityLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [horizonStart, setHorizonStart] = useState("");
  const [horizonEnd, setHorizonEnd] = useState("");
  const [scenarioName, setScenarioName] = useState("Baseline capacity scenario");
  const [frozenDays, setFrozenDays] = useState("0");
  const [requirementSearch, setRequirementSearch] = useState("");
  const [requirementStatus, setRequirementStatus] = useState("ALL");
  const [calendarFrom, setCalendarFrom] = useState("");
  const [calendarTo, setCalendarTo] = useState("");
  const [calendarLoading, setCalendarLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadRuns() {
      await Promise.resolve();
      if (!active) return;
      if (status !== "connected" || !activeFactoryId || !canRead) {
        setRuns([]);
        setSelectedRunId("");
        setRunDetail(null);
        setRequirements([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await request("/mrp-lite/runs?limit=50");
        if (!active) return;
        const nextRuns = rows<MrpRun>(result);
        setRuns(nextRuns);
        setSelectedRunId((current) => nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id ?? "");
      } catch (cause) {
        if (active) {
          setError(errorText(cause));
          setRuns([]);
          setSelectedRunId("");
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadRuns();
    return () => { active = false; };
  }, [status, activeFactoryId, canRead, request]);

  useEffect(() => {
    let active = true;
    async function loadSelectedRun() {
      await Promise.resolve();
      if (!active) return;
      if (!selectedRunId || status !== "connected" || !canRead) {
        setRunDetail(null);
        setRequirements([]);
        setDetailLoading(false);
        return;
      }
      setDetailLoading(true);
      try {
        const result = record(await request("/mrp-lite/runs/" + encodeURIComponent(selectedRunId)));
        if (!active) return;
        setRunDetail(result as MrpRun);
        setRequirements(rows<MrpRequirement>(result.requirements));
      } catch (cause) {
        if (active) {
          setRunDetail(null);
          setRequirements([]);
          setError(errorText(cause));
        }
      } finally {
        if (active) setDetailLoading(false);
      }
    }
    void loadSelectedRun();
    return () => { active = false; };
  }, [selectedRunId, status, canRead, request]);

  useEffect(() => {
    let active = true;
    async function loadCapacityPlans() {
      await Promise.resolve();
      if (!active) return;
      if (!selectedRunId || status !== "connected" || !canCapacityRead) {
        setCapacityPlans([]);
        setSelectedCapacityPlanId("");
        setCapacityLoading(false);
        return;
      }
      setCapacityLoading(true);
      try {
        const result = await request("/mrp-lite/runs/" + encodeURIComponent(selectedRunId) + "/capacity-plans?limit=50");
        if (!active) return;
        const nextPlans = rows<CapacityPlan>(result);
        setCapacityPlans(nextPlans);
        setSelectedCapacityPlanId((current) => nextPlans.some((plan) => plan.id === current) ? current : nextPlans[0]?.id ?? "");
      } catch (cause) {
        if (active) {
          setCapacityPlans([]);
          setSelectedCapacityPlanId("");
          setError(errorText(cause));
        }
      } finally {
        if (active) setCapacityLoading(false);
      }
    }
    void loadCapacityPlans();
    return () => { active = false; };
  }, [selectedRunId, status, canCapacityRead, request]);

  useEffect(() => {
    let active = true;
    async function loadCapacityDetail() {
      await Promise.resolve();
      if (!active) return;
      if (!selectedCapacityPlanId || status !== "connected" || !canCapacityRead) {
        setCapacityDetail(null);
        return;
      }
      try {
        const result = await request("/mrp-lite/capacity-plans/" + encodeURIComponent(selectedCapacityPlanId));
        if (active) setCapacityDetail(record(result));
      } catch (cause) {
        if (active) {
          setCapacityDetail(null);
          setError(errorText(cause));
        }
      }
    }
    void loadCapacityDetail();
    return () => { active = false; };
  }, [selectedCapacityPlanId, status, canCapacityRead, request]);

  const summary = record(runDetail?.summary);
  const requirementSummary = useMemo(() => summarizeMrpRequirements(requirements), [requirements]);
  const filteredRequirements = useMemo(
    () => filterMrpRequirements(requirements, requirementSearch, requirementStatus) as MrpRequirement[],
    [requirements, requirementSearch, requirementStatus],
  );
  const requiredTotals = rows<Row>(summary.required_material_totals);
  const capacitySummary = record(capacityDetail?.summary);
  const capacityOperations = rows<CapacityOperation>(capacityDetail?.operations);
  const operationSummary = useMemo(() => summarizeCapacityOperations(capacityOperations), [capacityOperations]);

  async function refreshRuns() {
    if (status !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setError("");
    try {
      const result = await request("/mrp-lite/runs?limit=50");
      const nextRuns = rows<MrpRun>(result);
      setRuns(nextRuns);
      if (!nextRuns.some((run) => run.id === selectedRunId)) setSelectedRunId(nextRuns[0]?.id ?? "");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function createMaterialPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!horizonStart || !horizonEnd) {
      setError("Choose both planning horizon dates.");
      return;
    }
    if (horizonEnd < horizonStart) {
      setError("Horizon end must be on or after horizon start.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = record(await request("/mrp-lite/runs", {
        method: "POST",
        idempotencyKey: "mrp-workbench-" + crypto.randomUUID(),
        body: { horizon_start: horizonStart, horizon_end: horizonEnd },
      }));
      const run = result as MrpRun;
      setSelectedRunId(run.id);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 50));
      setNotice("Material plan completed. Requirements, allocations and exceptions are loaded from the API.");
      setView("materials");
      await refreshRuns();
      setSelectedRunId(run.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createCapacityScenario(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRunId) return;
    const frozen = Number(frozenDays);
    if (!Number.isInteger(frozen) || frozen < 0 || frozen > 365) {
      setError("Frozen horizon must be an integer from 0 to 365 days.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = record(await request("/mrp-lite/runs/" + encodeURIComponent(selectedRunId) + "/capacity-plans", {
        method: "POST",
        idempotencyKey: "mrp-capacity-workbench-" + crypto.randomUUID(),
        body: { scenario_name: scenarioName.trim(), frozen_horizon_days: frozen },
      }));
      const plan = result as CapacityPlan;
      setCapacityPlans((current) => [plan, ...current.filter((item) => item.id !== plan.id)]);
      setSelectedCapacityPlanId(plan.id);
      setNotice("Finite-capacity scenario generated. Schedule and conflicts are authoritative API output.");
      setScenarioName("Scenario " + (Number(plan.plan_version) + 1));
      setView("capacity");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadCalendar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!calendarFrom || !calendarTo) {
      setError("Choose a start and end date for the capacity calendar.");
      return;
    }
    if (calendarTo < calendarFrom) {
      setError("Calendar end date must not precede its start date.");
      return;
    }
    setCalendarLoading(true);
    setError("");
    try {
      const query = "?from_date=" + encodeURIComponent(calendarFrom) + "&to_date=" + encodeURIComponent(calendarTo) + "&limit=500";
      const result = await request("/mrp-lite/capacity-calendar" + query);
      setCalendarEntries(rows<CalendarEntry>(result));
      setNotice("Capacity calendar refreshed from the selected factory.");
    } catch (cause) {
      setError(errorText(cause));
      setCalendarEntries([]);
    } finally {
      setCalendarLoading(false);
    }
  }

  if (status !== "connected" || !snapshot) {
    return <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Manufacturing planning</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">MRP is factory-scoped. Connect with your FactoryOS session, then select an active factory to calculate material demand and finite capacity.</p>
        <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800">Connect session</Link>
      </section>
    </main>;
  }
  if (!activeFactoryId) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Select an active factory from the workspace header before opening MRP.</div></main>;
  }
  if (!canRead) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold">MRP access required</h1><p className="mt-2 text-sm">Your current IAM permission snapshot does not include <code>mrp.read</code>. Ask an administrator to grant access.</p></div></main>;
  }

  const activeFactory = snapshot.factories.find((factory) => factory.id === activeFactoryId);
  return <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Materials · production planning</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">MRP Planning Workbench</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Turn confirmed demand into traceable BOM requirements, material availability and finite-capacity scenarios. Every result is calculated and persisted by the FactoryOS API.</p>
        <p className="mt-2 text-xs font-medium text-slate-500">{snapshot.tenant.name} · {activeFactory?.name ?? "Active factory"}</p>
      </div>
      <button type="button" onClick={() => void refreshRuns()} disabled={loading} className="min-h-10 self-start rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 lg:self-auto">{loading ? "Refreshing…" : "Refresh plans"}</button>
    </header>

    {error ? <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
    {notice ? <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

    <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Planning runs" value={String(runs.length)} detail="Latest 50 runs in this factory" tone="blue" />
      <Metric label="Material requirements" value={String(requirementSummary.requirements)} detail="Lines in the selected plan" />
      <Metric label="Covered requirements" value={String(requirementSummary.covered)} detail="Available by need date" tone="emerald" />
      <Metric label="Shortage lines" value={String(requirementSummary.shortageRows)} detail="Positive shortage quantity" tone="amber" />
    </section>

    <section className="mt-7 grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Planning runs</p>
          <h2 className="mt-1 text-lg font-bold text-slate-950">Material plans</h2>
          <p className="mt-1 text-xs text-slate-500">Most recent plans appear first</p>
        </div>
        <div className="max-h-[560px] space-y-2 overflow-y-auto p-3">
          {loading && runs.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">Loading planning runs…</p> : null}
          {!loading && runs.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">No MRP runs yet. Create a material plan to begin.</p> : null}
          {runs.map((run) => <button type="button" key={run.id} onClick={() => setSelectedRunId(run.id)} className={"w-full rounded-xl border p-3 text-left transition-colors " + (selectedRunId === run.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50")}>
            <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold text-slate-900">{dateLabel(run.horizon_start)} – {dateLabel(run.horizon_end)}</span><span className="text-[10px] font-semibold text-slate-500">MRP</span></div>
            <p className="mt-2 text-xs text-slate-500">{String(run.requirement_count ?? record(run.summary).requirement_count ?? 0)} requirement(s)</p>
            <p className="mt-1 truncate font-mono text-[10px] text-slate-400">{run.id}</p>
          </button>)}
        </div>
        {canWrite ? <form onSubmit={createMaterialPlan} className="border-t border-slate-200 p-4">
          <h3 className="text-sm font-bold text-slate-950">Run material planning</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">The horizon end determines which open demand is included. Start and end are persisted with the plan.</p>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Horizon start<input required type="date" value={horizonStart} onChange={(event) => setHorizonStart(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Horizon end<input required type="date" min={horizonStart || undefined} value={horizonEnd} onChange={(event) => setHorizonEnd(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>
          <button disabled={busy || !horizonStart || !horizonEnd} className="mt-4 min-h-11 w-full rounded-xl bg-blue-700 px-4 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50">{busy ? "Calculating…" : "Calculate material plan"}</button>
        </form> : <p className="border-t border-slate-200 p-4 text-xs text-slate-500">Read-only access. Creating a material plan requires <code>mrp.write</code>.</p>}
      </aside>

      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="MRP planning views">
            {([{ id: "materials", label: "Material requirements" }, { id: "capacity", label: "Finite capacity" }, { id: "calendar", label: "Capacity calendar" }] as const).map((item) =>
              <button type="button" role="tab" aria-selected={view === item.id} key={item.id} onClick={() => setView(item.id)} className={"min-h-9 rounded-lg px-3 text-xs font-bold " + (view === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>
            )}
          </div>
          {runDetail ? <span className="text-[11px] font-semibold text-slate-500">Selected: {dateLabel(runDetail.horizon_start)} to {dateLabel(runDetail.horizon_end)}</span> : null}
        </div>

        {view === "materials" ? <div className="space-y-4">
          {!selectedRunId ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><h2 className="font-bold text-slate-900">No material plan selected</h2><p className="mt-2 text-sm text-slate-500">Create a new plan or select an existing run from the left.</p></div> : detailLoading ? <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Loading material requirements…</div> : runDetail ? <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Demand order lines" value={String(summary.order_line_count ?? 0)} detail="Open confirmed / in-progress lines" />
              <Metric label="Covered" value={String(summary.covered_count ?? requirementSummary.covered)} detail="Available by required date" tone="emerald" />
              <Metric label="Late supply" value={String(summary.late_supply_count ?? requirementSummary.late)} detail="Incoming supply after need date" tone="amber" />
              <Metric label="Unsupplied" value={String(summary.unsupplied_count ?? requirementSummary.unsupplied)} detail="Not covered by available supply" tone="amber" />
            </section>
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4 sm:p-5">
                <div><h2 className="text-lg font-bold text-slate-950">Material requirements</h2><p className="mt-1 text-xs text-slate-500">Demand date → released BOM → on-hand allocation → eligible incoming supply</p></div>
                <Status value={runDetail.allocation_policy} />
              </div>
              <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Required quantity</p><p className="mt-1 text-xl font-bold tabular-nums">{formatMrpQuantity(requirementSummary.required)}</p></div>
                <div className="rounded-xl bg-amber-50 p-3"><p className="text-[11px] text-amber-700">Shortage quantity</p><p className="mt-1 text-xl font-bold text-amber-900 tabular-nums">{formatMrpQuantity(requirementSummary.shortage)}</p></div>
                <div className="rounded-xl bg-blue-50 p-3"><p className="text-[11px] text-blue-700">Planning exceptions</p><p className="mt-1 text-xl font-bold text-blue-950 tabular-nums">{rows<unknown>(runDetail.exceptions).length}</p></div>
              </div>
              <div className="border-b border-slate-100 p-4">
                <h3 className="text-sm font-bold text-slate-900">Material totals</h3>
                {requiredTotals.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{requiredTotals.slice(0, 12).map((item, index) => <article key={String(item.item_id ?? item.sku ?? index)} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-xs font-bold text-slate-800">{text(item.sku)}</span><span className="text-[10px] text-slate-400">{text(item.unit)}</span></div><p className="mt-1 truncate text-sm text-slate-600">{text(item.name)}</p><div className="mt-2 flex justify-between gap-2 text-xs"><span className="text-slate-500">Required {formatMrpQuantity(item.required)}</span><span className="font-semibold text-amber-800">Short {formatMrpQuantity(item.shortage)}</span></div></article>)}</div> : <p className="mt-2 text-sm text-slate-500">No material total rows were returned for this plan.</p>}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
                <div><h3 className="text-sm font-bold text-slate-900">Requirement detail</h3><p className="mt-1 text-xs text-slate-500">Search order, product, component or due date</p></div>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  <input aria-label="Search material requirements" value={requirementSearch} onChange={(event) => setRequirementSearch(event.target.value)} placeholder="Search requirements…" className="min-h-10 min-w-0 rounded-lg border border-slate-300 px-3 text-sm sm:w-56" />
                  <select aria-label="Filter by allocation status" value={requirementStatus} onChange={(event) => setRequirementStatus(event.target.value)} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm"><option value="ALL">All statuses</option><option value="COVERED">Covered</option><option value="LATE_SUPPLY">Late supply</option><option value="UNSUPPLIED">Unsupplied</option></select>
                </div>
              </div>
              {filteredRequirements.length ? <div className="overflow-x-auto"><table className="w-full min-w-[940px] text-left text-xs"><thead className="bg-slate-50 uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Demand</th><th className="px-4 py-3">Component</th><th className="px-4 py-3">Required</th><th className="px-4 py-3">On hand</th><th className="px-4 py-3">Incoming</th><th className="px-4 py-3">Shortage</th><th className="px-4 py-3">Need by</th><th className="px-4 py-3">Allocation</th></tr></thead><tbody className="divide-y divide-slate-100">{filteredRequirements.map((item) => <tr key={item.id} className="hover:bg-slate-50"><td className="px-4 py-3"><p className="font-bold text-slate-900">{text(item.order_number)}</p><p className="mt-1 text-[10px] text-slate-500">{text(item.product_code)} · line {String(item.order_line_number ?? "—")}</p></td><td className="px-4 py-3"><p className="font-mono font-bold text-slate-800">{text(item.component_sku)}</p><p className="mt-1 text-slate-500">{text(item.component_name)}</p></td><td className="px-4 py-3 font-semibold tabular-nums">{formatMrpQuantity(item.required_quantity, text(item.component_unit, ""))}</td><td className="px-4 py-3 tabular-nums">{formatMrpQuantity(item.available_on_hand_quantity, text(item.component_unit, ""))}</td><td className="px-4 py-3 tabular-nums">{formatMrpQuantity(item.incoming_quantity, text(item.component_unit, ""))}</td><td className="px-4 py-3 font-bold tabular-nums text-amber-800">{formatMrpQuantity(item.shortage_quantity, text(item.component_unit, ""))}</td><td className="px-4 py-3">{dateLabel(item.need_by_date)}</td><td className="px-4 py-3"><Status value={item.allocation_status} /></td></tr>)}</tbody></table></div> : <p className="p-8 text-center text-sm text-slate-500">No requirements match the current filters.</p>}
            </section>
            <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
              <h2 className="font-bold text-slate-950">Planning exceptions</h2>
              <p className="mt-1 text-xs text-slate-500">Missing product mappings, unreleased BOMs and unavailable component records are not silently planned.</p>
              {rows<Row>(runDetail.exceptions).length ? <div className="mt-3 space-y-2">{rows<Row>(runDetail.exceptions).map((item, index) => <article key={String(item.order_line_id ?? item.code ?? index)} className="rounded-xl border border-amber-200 bg-amber-50/60 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-amber-950">{text(item.order_number)} · {text(item.code, "PLANNING_EXCEPTION")}</p><span className="text-[10px] text-amber-800">{dateLabel(item.need_by_date)}</span></div><p className="mt-1 text-xs leading-5 text-amber-900">{text(item.message, "The API returned a planning exception.")}</p></article>)}</div> : <p className="mt-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">No source-data exceptions were reported in this plan.</p>}
              <p className="mt-4 text-[11px] leading-5 text-slate-500">Alternate BOM items, where present, are displayed as what-if alternatives in the saved requirement snapshot. This screen does not approve substitutions or issue inventory.</p>
            </section>
          </> : <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Select a material plan to inspect its requirement details.</div>}
        </div> : null}

        {view === "capacity" ? <div className="space-y-4">
          {!selectedRunId ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">Select or create a material plan before scheduling finite capacity.</div> : <>
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold text-slate-950">Finite-capacity scenarios</h2><p className="mt-1 text-xs leading-5 text-slate-500">Schedule released routing operations against the factory&apos;s shift and work-centre calendar. Material, routing, predecessor and capacity constraints are evaluated by the API.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{capacityPlans.length} scenario(s)</span></div>
              {canCapacityPlan ? <form onSubmit={createCapacityScenario} className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_140px_auto] sm:items-end">
                <label className="block text-xs font-semibold text-slate-600">Scenario name<input required minLength={3} maxLength={120} value={scenarioName} onChange={(event) => setScenarioName(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm" /></label>
                <label className="block text-xs font-semibold text-slate-600">Frozen horizon (days)<input required type="number" min="0" max="365" step="1" value={frozenDays} onChange={(event) => setFrozenDays(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm" /></label>
                <button disabled={busy || scenarioName.trim().length < 3 || (Number(frozenDays) > 0 && capacityPlans.length === 0)} className="min-h-10 rounded-lg bg-blue-700 px-4 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50">{busy ? "Scheduling…" : "Generate scenario"}</button>
              </form> : <p className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">Your role does not include <code>mrp.capacity.plan</code>. Capacity scenarios are read-only.</p>}
              {Number(frozenDays) > 0 && capacityPlans.length === 0 ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">A frozen horizon requires a prior scenario for this material plan. Generate an initial scenario with 0 frozen days first.</p> : null}
            </section>
            {canCapacityRead ? <>
              <div className="flex flex-wrap gap-2">{capacityPlans.map((plan) => <button type="button" key={plan.id} onClick={() => setSelectedCapacityPlanId(plan.id)} className={"rounded-xl border px-3 py-2 text-left " + (selectedCapacityPlanId === plan.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50")}><p className="text-xs font-bold text-slate-900">v{plan.plan_version} · {plan.scenario_name}</p><p className="mt-1 text-[10px] text-slate-500">{dateLabel(plan.created_at)}</p></button>)}</div>
              {capacityLoading ? <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Loading capacity scenarios…</div> : capacityDetail ? <>
                <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Metric label="Operations" value={String(capacitySummary.operation_count ?? operationSummary.operations)} detail="Required routing operations" />
                  <Metric label="Scheduled" value={String(capacitySummary.scheduled_operation_count ?? operationSummary.scheduled)} detail="Assigned to capacity slots" tone="emerald" />
                  <Metric label="Capacity conflicts" value={String(capacitySummary.capacity_conflict_count ?? operationSummary.conflicts)} detail="Not fully scheduled" tone="amber" />
                  <Metric label="Blocked operations" value={String(operationSummary.blocked)} detail="Material, routing or predecessor" tone="amber" />
                </section>
                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-200 p-4"><h3 className="font-bold text-slate-950">{text(capacityDetail.scenario_name)} · v{String(capacityDetail.plan_version ?? "")}</h3><p className="mt-1 text-xs text-slate-500">Frozen horizon: {String(capacityDetail.frozen_horizon_days ?? 0)} days · {dateLabel(capacityDetail.horizon_start)} – {dateLabel(capacityDetail.horizon_end)}</p></div>
                  {capacityOperations.length ? <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-xs"><thead className="bg-slate-50 uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Demand / operation</th><th className="px-4 py-3">Work centre</th><th className="px-4 py-3">Required min</th><th className="px-4 py-3">Scheduled min</th><th className="px-4 py-3">Planned dates</th><th className="px-4 py-3">Status / conflict</th><th className="px-4 py-3">Allocations</th></tr></thead><tbody className="divide-y divide-slate-100">{capacityOperations.map((operation) => <tr key={operation.id} className="align-top hover:bg-slate-50"><td className="px-4 py-3"><p className="font-bold text-slate-900">{text(operation.order_number)}</p><p className="mt-1 text-slate-500">{text(operation.operation_code)} · {text(operation.operation_name)}</p><p className="mt-1 text-[10px] text-slate-400">Step {String(operation.step_number ?? "—")}</p></td><td className="px-4 py-3 font-semibold">{text(operation.work_centre_code)}</td><td className="px-4 py-3 tabular-nums">{formatMrpQuantity(operation.required_minutes)} min</td><td className="px-4 py-3 tabular-nums">{formatMrpQuantity(operation.scheduled_minutes)} min</td><td className="px-4 py-3">{dateLabel(operation.planned_start_date)}<span className="mx-1 text-slate-400">→</span>{dateLabel(operation.planned_finish_date)}</td><td className="px-4 py-3"><Status value={operation.status} />{Array.isArray(operation.conflict_codes) && operation.conflict_codes.length ? <p className="mt-1 max-w-48 text-[10px] leading-4 text-amber-800">{operation.conflict_codes.join(", ")}</p> : null}</td><td className="px-4 py-3">{operation.allocations?.length ? <div className="space-y-1">{operation.allocations.map((allocation, index) => <p key={String(allocation.calendar_entry_id ?? index)} className="text-[10px] text-slate-600">{dateLabel(allocation.capacity_date)} · {text(allocation.shift_code)} · {text(allocation.line_code)} · {formatMrpQuantity(allocation.allocated_minutes)} min</p>)}</div> : <span className="text-slate-400">No allocation</span>}</td></tr>)}</tbody></table></div> : <p className="p-8 text-center text-sm text-slate-500">This scenario has no routing operation rows. Check the material plan, product routing and capacity calendar.</p>}
                </section>
                {rows<unknown>(capacityDetail.frozen_horizon_diff).length ? <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-bold text-amber-950">Frozen-horizon comparison</h3><p className="mt-1 text-xs text-amber-900">{rows<unknown>(capacityDetail.frozen_horizon_diff).length} comparison record(s) returned by the API.</p><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/70 p-3 text-[10px] text-slate-700">{JSON.stringify(capacityDetail.frozen_horizon_diff, null, 2)}</pre></section> : null}
              </> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">{capacityPlans.length ? "Select a capacity scenario to inspect its operation schedule." : "No capacity scenarios yet. Generate a baseline scenario to see the API's schedule and constraint findings."}</div>}
            </> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Your role does not include <code>mrp.capacity.read</code>.</div>}
          </>}
        </div> : null}

        {view === "calendar" ? <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-4 sm:p-5"><h2 className="text-lg font-bold text-slate-950">Finite-capacity calendar</h2><p className="mt-1 text-xs leading-5 text-slate-500">Inspect shift availability, work centres and production lines for the selected factory. Calendar changes remain under the dedicated capacity administration workflow.</p></div>
          {canCapacityRead ? <>
            <form onSubmit={loadCalendar} className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="block text-xs font-semibold text-slate-600">From date<input required type="date" value={calendarFrom} onChange={(event) => setCalendarFrom(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
              <label className="block text-xs font-semibold text-slate-600">To date<input required type="date" min={calendarFrom || undefined} value={calendarTo} onChange={(event) => setCalendarTo(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
              <button disabled={calendarLoading || !calendarFrom || !calendarTo} className="min-h-10 rounded-lg bg-slate-950 px-4 text-sm font-bold text-white disabled:opacity-50">{calendarLoading ? "Loading…" : "Load calendar"}</button>
            </form>
            {calendarEntries.length ? <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-xs"><thead className="bg-slate-50 uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Date / shift</th><th className="px-4 py-3">Work centre</th><th className="px-4 py-3">Line</th><th className="px-4 py-3">Available minutes</th><th className="px-4 py-3">Parallel lines</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Version</th></tr></thead><tbody className="divide-y divide-slate-100">{calendarEntries.map((entry) => <tr key={entry.id} className="hover:bg-slate-50"><td className="px-4 py-3"><p className="font-semibold">{dateLabel(entry.capacity_date)}</p><p className="mt-1 text-slate-500">{text(entry.shift_code)}</p></td><td className="px-4 py-3"><p className="font-semibold">{text(entry.work_centre_code)}</p><p className="mt-1 text-slate-500">{text(entry.work_centre_name)}</p></td><td className="px-4 py-3 font-mono">{text(entry.line_code)}</td><td className="px-4 py-3 tabular-nums">{String(entry.available_minutes)}</td><td className="px-4 py-3 tabular-nums">{String(entry.parallel_lines)}</td><td className="px-4 py-3"><Status value={entry.status} /></td><td className="px-4 py-3 font-mono">{text(entry.row_version)}</td></tr>)}</tbody></table></div> : <p className="p-8 text-center text-sm text-slate-500">{calendarLoading ? "Loading capacity calendar…" : "Choose a date range and load the calendar. No sample capacity is shown."}</p>}
            <p className="border-t border-slate-100 p-4 text-[11px] leading-5 text-slate-500">Calendar entries are read-only in this workbench. Creating or changing capacity requires the separate <code>mrp.capacity.write</code> workflow with valid work-centre and shift-template references.</p>
          </> : <p className="p-5 text-sm text-amber-900">Your role does not include <code>mrp.capacity.read</code>.</p>}
        </section> : null}
      </section>
    </section>
    <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 text-[11px] text-slate-500"><span>Factory-scoped · API-authoritative · Idempotent planning commands</span><span>MRP planning does not reserve, issue or substitute stock.</span></footer>
  </main>;
}
