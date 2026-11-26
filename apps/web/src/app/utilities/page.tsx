"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildUtilityAllocationReversePayload, buildUtilityEventPayload, buildUtilityEventTransitionPayload,
  buildUtilityListQuery, buildUtilityMeterPayload, buildUtilityReadingPayload, buildUtilitySourceBindingPayload,
  buildUtilitySourceBindingTransitionPayload, buildUtilitySourceEventPayload, buildUtilityThresholdPolicyPayload,
  buildUtilityThresholdPolicyTransitionPayload, buildUtilityWorkOrderAllocationPayload, normalizeUtilityRows,
  summarizeUtilities,
} from "@/lib/utilities-workbench.mjs";

type Row = Record<string, unknown>;
type Item = Row & { id: string; status?: string; row_version?: number };
type Tab = "meters" | "events" | "governance" | "costing";
type Editor =
  | "METER_CREATE" | "READING_CREATE" | "EVENT_CREATE" | "EVENT_TRANSITION"
  | "BINDING_CREATE" | "BINDING_TRANSITION" | "SOURCE_INGEST"
  | "POLICY_CREATE" | "POLICY_TRANSITION" | "ALLOCATE" | "REVERSE" | "";

const TABS: Array<{ id: Tab; label: string; description: string }> = [
  { id: "meters", label: "Meters & readings", description: "Meter register, chronological readings and measured consumption" },
  { id: "events", label: "Events & alerts", description: "Utility interruptions, anomalies and threshold evidence" },
  { id: "governance", label: "Sources & policies", description: "Approved ingestion mappings and independent threshold activation" },
  { id: "costing", label: "Work-order costing", description: "Allocate immutable meter consumption to released production work orders" },
];
const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonBase = "inline-flex min-h-9 items-center justify-center rounded-lg px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonBase + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonBase + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const warningButton = buttonBase + " border border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100";
const dangerButton = buttonBase + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function str(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The utility request could not be completed.";
}
function localDateTime(minutesFromNow = 0): string {
  const date = new Date(Date.now() + minutesFromNow * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function dateLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function numberLabel(value: unknown, maximumFractionDigits = 4): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return parsed.toLocaleString(undefined, { maximumFractionDigits });
}
function tone(value: string): string {
  const key = value.toUpperCase();
  if (["ACTIVE","RESOLVED","COMPLETED","APPROVED"].includes(key)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["OPEN","ACKNOWLEDGED","DRAFT","INACTIVE"].includes(key)) return "border-blue-200 bg-blue-50 text-blue-800";
  if (["CRITICAL","HIGH","RETIRED","CANCELLED"].includes(key)) return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}
function Pill({ value }: { value: string }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide " + tone(value)}>{value.replaceAll("_", " ")}</span>;
}
function Metric({ label, value, hint, toneName = "slate" }: { label: string; value: number | string; hint: string; toneName?: "slate" | "blue" | "amber" | "emerald" }) {
  const colors = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return <article className={"rounded-2xl border p-4 shadow-sm " + colors[toneName]}>
    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
    <p className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</p>
  </article>;
}
function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
      <div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}</div>
      {action}
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </section>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function Field({ label, name, value, onChange, type = "text", required = true, placeholder, hint, min, step }: {
  label: string; name: string; value: string; onChange(name: string, value: string): void;
  type?: string; required?: boolean; placeholder?: string; hint?: string; min?: string; step?: string;
}) {
  return <label className="block min-w-0">
    <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
    <input name={name} type={type} value={value} onChange={event => onChange(name, event.target.value)} className={inputClass}
      required={required} placeholder={placeholder} min={min} step={step} />
    {hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}
  </label>;
}
function SelectField({ label, name, value, onChange, options, required = true, hint }: {
  label: string; name: string; value: string; onChange(name: string, value: string): void;
  options: Array<{ value: string; label: string }>; required?: boolean; hint?: string;
}) {
  return <label className="block min-w-0">
    <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
    <select name={name} value={value} onChange={event => onChange(name, event.target.value)} className={inputClass} required={required}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}
  </label>;
}
function TextAreaField({ label, name, value, onChange, required = true, hint }: {
  label: string; name: string; value: string; onChange(name: string, value: string): void; required?: boolean; hint?: string;
}) {
  return <label className="block min-w-0">
    <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
    <textarea name={name} value={value} onChange={event => onChange(name, event.target.value)} className={inputClass + " min-h-24 py-2.5"}
      required={required} rows={3} />
    {hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}
  </label>;
}

export default function UtilitiesEnergyWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot) && Boolean(activeFactoryId);
  const canMeterRead = hasPermission("utilities.meters.read");
  const canMeterManage = hasPermission("utilities.meters.manage");
  const canReadingRead = hasPermission("utilities.readings.read");
  const canReadingCapture = hasPermission("utilities.readings.capture");
  const canEventRead = hasPermission("utilities.events.read");
  const canEventManage = hasPermission("utilities.events.manage");
  const canSourceManage = hasPermission("utilities.sources.manage");
  const canAlertRead = hasPermission("utilities.alerts.read");
  const canAlertManage = hasPermission("utilities.alerts.manage");
  const canProductionRead = hasPermission("production.workorders.read");
  const canAllocate = canReadingCapture && canProductionRead;
  const currentUserId = snapshot?.user?.id ?? "";

  const [tab, setTab] = useState<Tab>("meters");
  const [meters, setMeters] = useState<Item[]>([]);
  const [events, setEvents] = useState<Item[]>([]);
  const [policies, setPolicies] = useState<Item[]>([]);
  const [alerts, setAlerts] = useState<Row[]>([]);
  const [bindings, setBindings] = useState<Item[]>([]);
  const [workOrders, setWorkOrders] = useState<Item[]>([]);
  const [readings, setReadings] = useState<Item[]>([]);
  const [allocations, setAllocations] = useState<Row[]>([]);
  const [allocationSource, setAllocationSource] = useState<Row>({});
  const [selectedMeterId, setSelectedMeterId] = useState("");
  const [selectedReadingId, setSelectedReadingId] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedBindingId, setSelectedBindingId] = useState("");
  const [selectedPolicyId, setSelectedPolicyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor>("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const selectedMeter = meters.find(item => item.id === selectedMeterId) ?? null;
  const selectedReading = readings.find(item => item.id === selectedReadingId) ?? null;
  const selectedEvent = events.find(item => item.id === selectedEventId) ?? null;
  const selectedBinding = bindings.find(item => item.id === selectedBindingId) ?? null;
  const selectedPolicy = policies.find(item => item.id === selectedPolicyId) ?? null;
  const summary = useMemo(() => summarizeUtilities({ meters, events, policies, alerts, readings }), [meters,events,policies,alerts,readings]);

  const visibleMeters = useMemo(() => meters.filter(item =>
    (statusFilter === "ALL" || String(item.status ?? "") === statusFilter)
    && [item.meter_code,item.name,item.utility_type,item.location,item.unit_code].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [meters,statusFilter,search]);
  const visibleEvents = useMemo(() => events.filter(item =>
    (statusFilter === "ALL" || String(item.status ?? "") === statusFilter)
    && [item.event_number,item.title,item.event_type,item.severity,item.description].some(value => String(value ?? "").toLowerCase().includes(search.toLowerCase()))
  ), [events,statusFilter,search]);

  const loadWorkspace = useCallback(async () => {
    if (!connected) {
      setMeters([]); setEvents([]); setPolicies([]); setAlerts([]); setBindings([]); setWorkOrders([]);
      setSelectedMeterId(""); setSelectedEventId(""); setSelectedBindingId(""); setSelectedPolicyId("");
      return;
    }
    setLoading(true);
    setError("");
    const errors: string[] = [];
    const safe = async (name: string, endpoint: string, permitted: boolean, setter: (rows: Item[]) => void, select?: Dispatch<SetStateAction<string>>) => {
      if (!permitted) { setter([]); select?.(""); return; }
      try {
        const response = await request(endpoint);
        const next = normalizeUtilityRows(response) as Item[];
        setter(next);
        select?.(current => current && next.some(item => item.id === current) ? current : next[0]?.id ?? "");
      } catch (cause) {
        errors.push(name + ": " + errorText(cause));
        setter([]);
        select?.("");
      }
    };
    await Promise.all([
      safe("Meters","/utilities/meters" + buildUtilityListQuery({}, "meters"),canMeterRead,setMeters,setSelectedMeterId),
      safe("Events","/utilities/events" + buildUtilityListQuery({}, "events"),canEventRead,setEvents,setSelectedEventId),
      safe("Threshold policies","/utilities/threshold-policies" + buildUtilityListQuery({}, "policies"),canAlertRead,setPolicies,setSelectedPolicyId),
      safe("Threshold alerts","/utilities/threshold-alerts" + buildUtilityListQuery({}, "alerts"),canAlertRead,setAlerts),
      safe("Source bindings","/utilities/source-bindings" + buildUtilityListQuery({}, "bindings"),canMeterRead,setBindings,setSelectedBindingId),
      safe("Production work orders","/production/work-orders?limit=100",canProductionRead,setWorkOrders),
    ]);
    if (errors.length) setError(errors.join(" · "));
    setLoading(false);
  }, [connected,canMeterRead,canEventRead,canAlertRead,canProductionRead,request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  const loadReadings = useCallback(async (meterId: string) => {
    if (!meterId || !canReadingRead) { setReadings([]); setSelectedReadingId(""); return; }
    setRelatedLoading(true);
    try {
      const response = await request("/utilities/meters/" + encodeURIComponent(meterId) + "/readings" + buildUtilityListQuery({}, "readings"));
      const next = normalizeUtilityRows(response) as Item[];
      setReadings(next);
      setSelectedReadingId(current => current && next.some(item => item.id === current) ? current : next[0]?.id ?? "");
    } catch (cause) {
      setReadings([]); setSelectedReadingId(""); setError(errorText(cause));
    } finally { setRelatedLoading(false); }
  }, [request,canReadingRead]);

  useEffect(() => {
    if (tab !== "meters" || !selectedMeterId) return;
    const timer = window.setTimeout(() => { void loadReadings(selectedMeterId); }, 0);
    return () => window.clearTimeout(timer);
  }, [tab,selectedMeterId,loadReadings]);

  const loadAllocations = useCallback(async (meterId: string, readingId: string) => {
    if (!meterId || !readingId || !canReadingRead) { setAllocations([]); setAllocationSource({}); return; }
    setRelatedLoading(true);
    try {
      const response = object(await request("/utilities/meters/" + encodeURIComponent(meterId) + "/readings/" + encodeURIComponent(readingId) + "/work-order-cost-allocations"));
      setAllocations(normalizeUtilityRows(response) as Row[]);
      setAllocationSource(object(response.source));
    } catch (cause) {
      setAllocations([]); setAllocationSource({}); setError(errorText(cause));
    } finally { setRelatedLoading(false); }
  }, [request,canReadingRead]);

  useEffect(() => {
    if (tab !== "costing" || !selectedMeterId || !selectedReadingId) return;
    const timer = window.setTimeout(() => { void loadAllocations(selectedMeterId,selectedReadingId); }, 0);
    return () => window.clearTimeout(timer);
  }, [tab,selectedMeterId,selectedReadingId,loadAllocations]);

  function update(name: string, value: string) {
    setDraft(current => ({ ...current, [name]: value }));
  }
  function openEditor(kind: Editor, values: Record<string,string> = {}) {
    setEditor(kind); setDraft(values); setError(""); setNotice("");
  }
  function closeEditor() { setEditor(""); setDraft({}); }

  async function refresh(message: string) {
    setNotice(message);
    closeEditor();
    await loadWorkspace();
    if (selectedMeterId) await loadReadings(selectedMeterId);
    if (selectedMeterId && selectedReadingId && tab === "costing") await loadAllocations(selectedMeterId,selectedReadingId);
  }

  function beginEventTransition(item: Item) {
    setSelectedEventId(item.id);
    const action = item.status === "OPEN" ? "ACKNOWLEDGE" : "RESOLVE";
    openEditor("EVENT_TRANSITION",{
      expected_version:String(item.row_version ?? ""),action,reason:"",
      resolution:"",impact_minutes:String(item.impact_minutes ?? 0),
    });
  }
  function beginBindingTransition(item: Item) {
    setSelectedBindingId(item.id);
    openEditor("BINDING_TRANSITION",{
      expected_version:String(item.row_version ?? ""),
      action:item.status === "ACTIVE" ? "DEACTIVATE" : item.status === "INACTIVE" ? "ACTIVATE" : "RETIRE",
      reason:"",
    });
  }
  function beginPolicyTransition(item: Item) {
    setSelectedPolicyId(item.id);
    openEditor("POLICY_TRANSITION",{
      expected_version:String(item.row_version ?? ""),
      action:item.status === "ACTIVE" ? "DEACTIVATE" : item.status === "INACTIVE" ? "ACTIVATE" : "ACTIVATE",
      reason:"",
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      switch (editor) {
        case "METER_CREATE":
          if (!canMeterManage) throw new Error("Missing utilities.meters.manage permission.");
          await request("/utilities/meters",{
            method:"POST",body:buildUtilityMeterPayload(draft),
            idempotencyKey:"utility-meter-" + window.crypto.randomUUID(),
          });
          await refresh("Utility meter registered. Readings can be captured after the meter is active.");
          break;
        case "READING_CREATE":
          if (!canReadingCapture || !selectedMeter) throw new Error("Select a meter and verify utilities.readings.capture permission.");
          await request("/utilities/meters/" + encodeURIComponent(selectedMeter.id) + "/readings",{
            method:"POST",body:buildUtilityReadingPayload(draft),
            idempotencyKey:"utility-reading-" + window.crypto.randomUUID(),
          });
          await refresh("Meter reading recorded. Consumption and cost are calculated by the API from the meter configuration.");
          break;
        case "EVENT_CREATE":
          if (!canEventManage) throw new Error("Missing utilities.events.manage permission.");
          await request("/utilities/events",{
            method:"POST",body:buildUtilityEventPayload(draft),
            idempotencyKey:"utility-event-" + window.crypto.randomUUID(),
          });
          await refresh("Utility event recorded in the factory event register.");
          break;
        case "EVENT_TRANSITION":
          if (!selectedEvent || !canEventManage) throw new Error("Select an event and verify utilities.events.manage permission.");
          await request("/utilities/events/" + encodeURIComponent(selectedEvent.id) + "/transition",{
            method:"POST",body:buildUtilityEventTransitionPayload(draft),
          });
          await refresh("Utility event transition saved.");
          break;
        case "BINDING_CREATE":
          if (!canSourceManage) throw new Error("Missing utilities.sources.manage permission.");
          await request("/utilities/source-bindings",{
            method:"POST",body:buildUtilitySourceBindingPayload(draft),
            idempotencyKey:"utility-source-binding-" + window.crypto.randomUUID(),
          });
          await refresh("Meter source binding submitted as a draft. A different authorized approver must activate it.");
          break;
        case "BINDING_TRANSITION":
          if (!selectedBinding || !canSourceManage) throw new Error("Select a source binding and verify utilities.sources.manage permission.");
          await request("/utilities/source-bindings/" + encodeURIComponent(selectedBinding.id) + "/transition",{
            method:"POST",body:buildUtilitySourceBindingTransitionPayload(draft),
          });
          await refresh("Meter source binding state updated.");
          break;
        case "SOURCE_INGEST":
          if (!canReadingCapture) throw new Error("Missing utilities.readings.capture permission.");
          await request("/utilities/source-events",{method:"POST",body:buildUtilitySourceEventPayload(draft)});
          await refresh("Source reading accepted and normalized through the active approved mapping.");
          break;
        case "POLICY_CREATE":
          if (!canAlertManage) throw new Error("Missing utilities.alerts.manage permission.");
          await request("/utilities/threshold-policies",{
            method:"POST",body:buildUtilityThresholdPolicyPayload(draft),
            idempotencyKey:"utility-threshold-policy-" + window.crypto.randomUUID(),
          });
          await refresh("Threshold policy created as a draft. Independent activation is required.");
          break;
        case "POLICY_TRANSITION":
          if (!selectedPolicy || !canAlertManage) throw new Error("Select a threshold policy and verify utilities.alerts.manage permission.");
          await request("/utilities/threshold-policies/" + encodeURIComponent(selectedPolicy.id) + "/transition",{
            method:"POST",body:buildUtilityThresholdPolicyTransitionPayload(draft),
          });
          await refresh("Threshold policy state updated.");
          break;
        case "ALLOCATE":
          if (!canAllocate || !selectedMeter || !selectedReading) throw new Error("A meter reading and production.workorders.read plus utilities.readings.capture permissions are required.");
          await request("/utilities/meters/" + encodeURIComponent(selectedMeter.id) + "/readings/" + encodeURIComponent(selectedReading.id) + "/work-order-cost-allocations",{
            method:"POST",body:buildUtilityWorkOrderAllocationPayload(draft),
            idempotencyKey:"utility-cost-allocation-" + window.crypto.randomUUID(),
          });
          await refresh("Utility consumption allocated to the selected work order.");
          break;
        case "REVERSE": {
          if (!canAllocate || !selectedMeter || !selectedReading) throw new Error("A meter reading and work-order cost permissions are required.");
          const allocationId = draft.allocation_id;
          await request("/utilities/meters/" + encodeURIComponent(selectedMeter.id) + "/readings/" + encodeURIComponent(selectedReading.id) + "/work-order-cost-allocations/" + encodeURIComponent(allocationId) + "/reverse",{
            method:"POST",body:buildUtilityAllocationReversePayload(draft),
            idempotencyKey:"utility-cost-reversal-" + window.crypto.randomUUID(),
          });
          await refresh("Cost allocation reversal recorded as an append-only entry.");
          break;
        }
        default:
          break;
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const editorTitle: Record<Exclude<Editor,"">,string> = {
    METER_CREATE:"Register utility meter",
    READING_CREATE:"Capture meter reading",
    EVENT_CREATE:"Record utility event",
    EVENT_TRANSITION:"Update utility event",
    BINDING_CREATE:"Register meter source binding",
    BINDING_TRANSITION:"Change source binding state",
    SOURCE_INGEST:"Ingest source reading",
    POLICY_CREATE:"Create threshold policy",
    POLICY_TRANSITION:"Change threshold policy state",
    ALLOCATE:"Allocate reading to work order",
    REVERSE:"Reverse cost allocation",
  };

  const selectedMeterLabel = selectedMeter ? str(selectedMeter.meter_code) + " · " + str(selectedMeter.name) : "No meter selected";
  const reversedIds = new Set(allocations.filter(item => String(item.allocation_kind) === "REVERSAL").map(item => String(item.reverses_allocation_id ?? "")));

  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Factory utilities · metering · energy cost</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Utilities & Energy Performance</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Manage meter hierarchies, capture governed readings, respond to utility events, approve automated source mappings and allocate measured consumption to production work orders.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={"rounded-full px-3 py-1.5 text-[10px] font-bold " + (connected ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")}>{connected ? "Authenticated factory scope" : "Session required"}</span>
        <button type="button" onClick={() => void loadWorkspace()} disabled={!connected || loading} className={secondaryButton}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
    </header>

    {!connected ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      Connect an authenticated FactoryOS session and select an active factory before opening the utility workspace. All records are scoped by the server session.
      <Link href="/session" className="ml-2 font-semibold underline">Open session setup</Link>
    </div> : null}
    {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-800">{error}</div> : null}
    {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-800">{notice}</div> : null}

    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Active meters" value={summary.metersActive} hint={summary.metersLoaded + " meters in the loaded register"} toneName="blue" />
      <Metric label="Open utility events" value={summary.eventsOpen} hint={summary.eventsCritical + " unresolved critical events"} toneName={summary.eventsCritical ? "amber" : "slate"} />
      <Metric label="Threshold alerts" value={summary.alertsOpen} hint={summary.policiesActive + " active policies in the loaded set"} toneName={summary.alertsOpen ? "amber" : "emerald"} />
      <Metric label="Readings loaded" value={summary.readingsLoaded} hint="Latest selected-meter history only" />
    </section>

    <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-1">
      {TABS.map(item => <button key={item.id} type="button" onClick={() => { setTab(item.id); setSearch(""); setStatusFilter("ALL"); }}
        aria-pressed={tab === item.id} className={"min-h-10 shrink-0 rounded-lg px-3 text-[11px] font-semibold transition-colors " + (tab === item.id ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950")}>
        {item.label}
      </button>)}
    </div>
    <p className="-mt-3 text-xs text-slate-500">{TABS.find(item => item.id === tab)?.description}</p>

    {tab === "meters" ? <div className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
      <Panel title="Meter register" subtitle="Meters returned by the authenticated factory API. Parent meter references create a governed hierarchy."
        action={canMeterManage ? <button type="button" onClick={() => openEditor("METER_CREATE",{utility_type:"ELECTRICITY",reading_mode:"CUMULATIVE",unit_code:"kWh",multiplier_factor:"1",unit_cost:"0",currency_code:"BDT"})} className={primaryButton}>+ Register meter</button> : null}>
        <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_150px]">
          <input className={inputClass} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search meter code, name or location…" aria-label="Search meters" />
          <select className={inputClass} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="RETIRED">Retired</option>
          </select>
        </div>
        {visibleMeters.length ? <div className="space-y-2">
          {visibleMeters.map(item => <button key={item.id} type="button" onClick={() => { setSelectedMeterId(item.id); setSelectedReadingId(""); }}
            className={"w-full rounded-xl border p-3 text-left transition-colors " + (selectedMeterId === item.id ? "border-blue-300 bg-blue-50/70" : "border-slate-200 hover:bg-slate-50")}>
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-bold text-slate-950">{str(item.meter_code)} <span className="font-normal text-slate-400">·</span> {str(item.name)}</p><p className="mt-1 text-[10px] text-slate-500">{str(item.utility_type)} · {str(item.location,"No location")}</p></div><Pill value={str(item.status,"UNKNOWN")} /></div>
            <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500"><span>{str(item.reading_mode)} mode</span><span>Unit {str(item.unit_code)}</span><span>{numberLabel(item.child_count,0)} child meters</span></div>
          </button>)}
        </div> : <Empty>{canMeterRead ? "No meter records match this filter." : "Your session does not have utilities.meters.read permission."}</Empty>}
      </Panel>

      <div className="space-y-4">
        <Panel title="Selected meter" subtitle={selectedMeter ? "Meter identity and frozen reading/cost configuration." : "Select a meter to inspect its configuration and reading history."}
          action={selectedMeter && canReadingCapture ? <button type="button" onClick={() => openEditor("READING_CREATE",{reading_at:localDateTime(),reading_value:"",source_type:"MANUAL",production_quantity:"",notes:""})} className={primaryButton}>+ Capture reading</button> : null}>
          {selectedMeter ? <div className="grid gap-3 sm:grid-cols-2">
            {[
              ["Meter code",selectedMeter.meter_code],["Utility",selectedMeter.utility_type],["Reading mode",selectedMeter.reading_mode],
              ["Unit",selectedMeter.unit_code],["Multiplier",selectedMeter.multiplier_factor],["Unit cost",selectedMeter.unit_cost],
              ["Currency",selectedMeter.currency_code],["Cost centre",selectedMeter.cost_center_code],["Source system",selectedMeter.source_system_code],
              ["Parent meter",selectedMeter.parent_meter_id],["Location",selectedMeter.location],["Version",selectedMeter.row_version],
            ].map(([label,value]) => <div key={String(label)} className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 break-words text-xs font-semibold text-slate-800">{str(value)}</p></div>)}
          </div> : <Empty>Select a meter from the register. New readings are only accepted for active meters.</Empty>}
        </Panel>

        <Panel title="Reading history" subtitle={selectedMeter ? selectedMeterLabel + " · latest 100 readings" : "Meter readings are loaded when a meter is selected."}>
          {relatedLoading ? <p className="text-xs text-slate-500">Loading reading history…</p> : readings.length ? <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead><tr className="border-b border-slate-200 text-[9px] uppercase tracking-wide text-slate-500"><th className="pb-2">Reading time</th><th className="pb-2">Value</th><th className="pb-2">Consumption</th><th className="pb-2">Cost</th><th className="pb-2">Source</th><th className="pb-2">Allocation</th></tr></thead>
              <tbody>{readings.map(item => <tr key={item.id} onClick={() => setSelectedReadingId(item.id)} className={"cursor-pointer border-b border-slate-100 last:border-0 " + (selectedReadingId === item.id ? "bg-blue-50" : "hover:bg-slate-50")}>
                <td className="py-2.5 pr-3">{dateLabel(item.reading_at)}</td><td className="py-2.5 pr-3 font-semibold tabular-nums">{numberLabel(item.reading_value)} {str(item.unit_code)}</td>
                <td className="py-2.5 pr-3 tabular-nums">{numberLabel(item.consumption_quantity)} {str(item.unit_code)}</td>
                <td className="py-2.5 pr-3 tabular-nums">{str(item.currency_code_snapshot)} {numberLabel(item.cost_amount)}</td><td className="py-2.5 pr-3">{str(item.source_type)}</td><td className="py-2.5">{item.intensity_per_unit ? numberLabel(item.intensity_per_unit) : "—"}</td>
              </tr>)}</tbody>
            </table>
          </div> : <Empty>{selectedMeter ? "No readings are available for this meter yet." : "Select a meter to load its readings."}</Empty>}
        </Panel>
      </div>
    </div> : null}

    {tab === "events" ? <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <Panel title="Utility event register" subtitle="Outages, peaks, leaks, pressure drops, meter faults and efficiency exceptions."
        action={canEventManage ? <button type="button" onClick={() => openEditor("EVENT_CREATE",{event_type:"OUTAGE",severity:"HIGH",occurred_at:localDateTime(),impact_minutes:"0",impact_quantity:"",meter_id:"",cause:""})} className={primaryButton}>+ Record event</button> : null}>
        <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_160px]">
          <input className={inputClass} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search event, type or cause…" aria-label="Search events" />
          <select className={inputClass} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="OPEN">Open</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="RESOLVED">Resolved</option><option value="CANCELLED">Cancelled</option></select>
        </div>
        {visibleEvents.length ? <div className="space-y-2">
          {visibleEvents.map(item => <article key={item.id} className={"rounded-xl border p-3 " + (selectedEventId === item.id ? "border-blue-300 bg-blue-50/60" : "border-slate-200")}>
            <button type="button" onClick={() => setSelectedEventId(item.id)} className="w-full text-left">
              <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold text-slate-950">{str(item.event_number)} · {str(item.title)}</p><p className="mt-1 text-[10px] text-slate-500">{str(item.event_type)} · {dateLabel(item.occurred_at)} · {numberLabel(item.impact_minutes,0)} impact minutes</p></div><div className="flex gap-1.5"><Pill value={str(item.severity,"LOW")} /><Pill value={str(item.status,"OPEN")} /></div></div>
              <p className="mt-2 text-xs leading-5 text-slate-600">{str(item.description)}</p>
              {item.resolution ? <p className="mt-1 text-[10px] text-emerald-700">Resolution: {str(item.resolution)}</p> : null}
            </button>
            {canEventManage && ["OPEN","ACKNOWLEDGED"].includes(String(item.status)) ? <div className="mt-3 flex justify-end"><button type="button" onClick={() => beginEventTransition(item)} className={secondaryButton}>{item.status === "OPEN" ? "Acknowledge / cancel" : "Resolve / cancel"}</button></div> : null}
          </article>)}
        </div> : <Empty>{canEventRead ? "No utility events match this filter." : "Your session does not have utilities.events.read permission."}</Empty>}
      </Panel>

      <Panel title="Threshold alert evidence" subtitle="Alerts reference the source reading, evaluated policy and linked utility event. Use the event register to acknowledge or resolve the operational event.">
        {alerts.length ? <div className="space-y-2">
          {alerts.map(item => {
            const linkedEvent = events.find(event => event.id === item.utility_event_id);
            return <article key={String(item.alert_id)} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{str(item.policy_code)} · {str(item.policy_name)}</p><Pill value={str(item.severity,"MEDIUM")} /></div>
              <p className="mt-1 text-[10px] text-slate-500">{str(item.metric)} {str(item.unit_code)} · observed {numberLabel(item.observed_value)} vs threshold {numberLabel(item.threshold_value)}</p>
              <p className="mt-2 text-[11px] font-semibold text-slate-800">{str(item.event_number)} · {str(item.title)}</p>
              <p className="mt-1 text-[10px] text-slate-500">Reading {dateLabel(item.reading_at)} · {numberLabel(item.consumption_quantity)} {str(item.unit_code)} · {str(item.source_type)}</p>
              {linkedEvent ? <button type="button" onClick={() => { setSelectedEventId(linkedEvent.id); setTab("events"); }} className="mt-2 text-[10px] font-semibold text-blue-700 underline">Open linked event</button> : <p className="mt-2 text-[10px] text-slate-400">Linked event is not in the currently loaded event window.</p>}
            </article>;
          })}
        </div> : <Empty>{canAlertRead ? "No threshold alert evidence is currently returned." : "Your session does not have utilities.alerts.read permission."}</Empty>}
      </Panel>
    </div> : null}

    {tab === "governance" ? <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Meter source bindings" subtitle="Map external source identity and unit conversion to an active meter. Credentials remain in a secret manager; the workspace stores references only."
        action={<div className="flex flex-wrap gap-2">{canReadingCapture ? <button type="button" onClick={() => openEditor("SOURCE_INGEST",{reading_at:localDateTime(),reading_value:"",source_system_code:"",source_meter_code:"",source_event_id:"",source_unit_code:"",production_quantity:"",notes:""})} className={secondaryButton}>Ingest event</button> : null}{canSourceManage ? <button type="button" onClick={() => openEditor("BINDING_CREATE",{vendor_adapter:"REST_POLL",factor_to_meter_unit:"1",polling_interval_seconds:"300",config_metadata:"{}"})} className={primaryButton}>+ Register source</button> : null}</div>}>
        {bindings.length ? <div className="space-y-2">
          {bindings.map(item => <article key={item.id} className="rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold text-slate-950">{str(item.source_system_code)} / {str(item.source_meter_code)}</p><p className="mt-1 text-[10px] text-slate-500">{str(item.vendor_adapter)} → {str(item.meter_code)} · factor {str(item.factor_to_meter_unit)}</p></div><Pill value={str(item.status,"DRAFT")} /></div>
            <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500"><span>Source unit: {str(item.source_unit_code)}</span><span>Meter unit: {str(item.meter_unit_code)}</span><span>Credential configured: {item.credential_configured ? "Yes · reference only" : "No"}</span></div>
            {item.config_metadata ? <p className="mt-1 break-all text-[10px] text-slate-400">Metadata: {JSON.stringify(item.config_metadata)}</p> : null}
            {canSourceManage && !["RETIRED"].includes(String(item.status)) && !((["DRAFT","INACTIVE"].includes(String(item.status))) && String(item.created_by_user_id) === currentUserId) ? <div className="mt-3 flex justify-end"><button type="button" onClick={() => beginBindingTransition(item)} className={secondaryButton}>Change state</button></div> : null}
          </article>)}
        </div> : <Empty>{canMeterRead ? "No source bindings are registered." : "Your session does not have utilities.meters.read permission."}</Empty>}
      </Panel>

      <Panel title="Threshold policies" subtitle="Define consumption, cost or intensity thresholds. The API requires a separate user to activate a policy created by another user."
        action={canAlertManage ? <button type="button" onClick={() => openEditor("POLICY_CREATE",{metric:"CONSUMPTION",comparison:"GT",threshold_value:"",threshold_unit_code:"kWh",severity:"HIGH",meter_id:"",utility_type:""})} className={primaryButton}>+ Create policy</button> : null}>
        {policies.length ? <div className="space-y-2">
          {policies.map(item => <article key={item.id} className="rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold text-slate-950">{str(item.policy_code)} · {str(item.name)}</p><p className="mt-1 text-[10px] text-slate-500">{str(item.metric)} {str(item.comparison)} {numberLabel(item.threshold_value)} {str(item.threshold_unit_code)}</p></div><Pill value={str(item.status,"DRAFT")} /></div>
            <p className="mt-2 text-[10px] text-slate-500">{item.meter_id ? "Meter-specific policy" : "Utility type: " + str(item.utility_type)} · {str(item.severity)} severity · version {str(item.row_version)}</p>
            {canAlertManage && !["RETIRED"].includes(String(item.status)) && !((["DRAFT","INACTIVE"].includes(String(item.status))) && String(item.created_by_user_id) === currentUserId) ? <div className="mt-3 flex justify-end"><button type="button" onClick={() => beginPolicyTransition(item)} className={secondaryButton}>Change state</button></div> : null}
            {item.status === "DRAFT" && String(item.created_by_user_id) === currentUserId ? <p className="mt-2 text-[10px] text-amber-700">Created by this session user. A different authorized approver must activate it.</p> : null}
          </article>)}
        </div> : <Empty>{canAlertRead ? "No threshold policies are registered." : "Your session does not have utilities.alerts.read permission."}</Empty>}
      </Panel>

      <Panel title="Integration boundary" subtitle="An active source binding is an approved mapping, not proof that a vendor adapter is deployed or polling live. The API currently accepts a source-event ingestion contract.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-800">Supported mapping adapters</p><p className="mt-2 text-[11px] leading-5 text-slate-600">REST polling, OPC UA, MQTT, Modbus, file import and manual import.</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-800">Secret handling</p><p className="mt-2 text-[11px] leading-5 text-slate-600">Only secret-manager references are accepted. Passwords, tokens and private keys are not placed in metadata or browser payloads.</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-800">Unit normalization</p><p className="mt-2 text-[11px] leading-5 text-slate-600">Source values are converted using the approved factor and exact configured source unit before a reading is recorded.</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-bold text-slate-800">Production adapter acceptance</p><p className="mt-2 text-[11px] leading-5 text-slate-600">Live connectivity, polling delivery, gateway health and vendor-specific credentials still require deployment and physical commissioning evidence.</p></div>
        </div>
      </Panel>
    </div> : null}

    {tab === "costing" ? <div className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
      <Panel title="Reading source" subtitle="Choose a meter and a non-zero reading with a frozen unit-cost and currency snapshot. The API enforces the work-order time window and remaining consumption capacity.">
        <div className="space-y-3">
          <SelectField label="Meter" name="meter" value={selectedMeterId} onChange={(_,value) => { setSelectedMeterId(value); setSelectedReadingId(""); }}
            options={[{value:"",label:"Select meter"},...meters.map(item=>({value:item.id,label:str(item.meter_code)+" · "+str(item.name)}))]} />
          <SelectField label="Reading" name="reading" value={selectedReadingId} onChange={(_,value)=>setSelectedReadingId(value)}
            options={[{value:"",label:"Select meter reading"},...readings.map(item=>({value:item.id,label:dateLabel(item.reading_at)+" · "+numberLabel(item.consumption_quantity)+" "+str(item.unit_code)}))]} />
          {selectedReading ? <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-xs">
            <p className="font-bold text-slate-900">Selected consumption snapshot</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-slate-600">
              <span>Consumption</span><strong className="text-right">{numberLabel(selectedReading.consumption_quantity)} {str(selectedReading.unit_code)}</strong>
              <span>Unit cost</span><strong className="text-right">{str(selectedReading.currency_code_snapshot)} {numberLabel(selectedReading.unit_cost_snapshot)}</strong>
              <span>Recorded cost</span><strong className="text-right">{str(selectedReading.currency_code_snapshot)} {numberLabel(selectedReading.cost_amount)}</strong>
              <span>Remaining</span><strong className="text-right">{numberLabel(allocationSource.remaining_quantity,8)} {str(selectedReading.unit_code)}</strong>
            </div>
          </div> : <Empty>Select an eligible reading to inspect work-order allocations.</Empty>}
          <p className="text-[10px] leading-5 text-slate-500">Allocations are append-only. Corrections create a separate reversal record; the original allocation is not edited or deleted.</p>
        </div>
      </Panel>

      <Panel title="Work-order allocations" subtitle="Allocation capacity is checked transactionally against the immutable utility reading consumption."
        action={canAllocate && selectedReading ? <button type="button" onClick={() => openEditor("ALLOCATE",{work_order_id:"",allocated_quantity:"",reason:""})} className={primaryButton}>+ Allocate consumption</button> : null}>
        {allocations.length ? <div className="overflow-x-auto">
          <table className="w-full min-w-[660px] text-left text-xs">
            <thead><tr className="border-b border-slate-200 text-[9px] uppercase tracking-wide text-slate-500"><th className="pb-2">Work order</th><th className="pb-2">Kind</th><th className="pb-2">Quantity</th><th className="pb-2">Cost</th><th className="pb-2">Reason</th><th className="pb-2">Action</th></tr></thead>
            <tbody>{allocations.map(item => <tr key={String(item.id)} className="border-b border-slate-100 last:border-0">
              <td className="py-2.5 pr-3 font-semibold">{str(item.work_order_number)}</td><td className="py-2.5 pr-3"><Pill value={str(item.allocation_kind)} /></td>
              <td className="py-2.5 pr-3 tabular-nums">{numberLabel(item.allocated_quantity,8)} {str(item.unit_code)}</td>
              <td className="py-2.5 pr-3 tabular-nums">{str(item.currency_code)} {numberLabel(item.allocated_cost)}</td><td className="max-w-44 py-2.5 pr-3 text-[10px] text-slate-500">{str(item.reason)}</td>
              <td className="py-2.5">{canAllocate && item.allocation_kind === "ALLOCATE" && !reversedIds.has(String(item.id)) ? <button type="button" onClick={() => openEditor("REVERSE",{allocation_id:String(item.id),reason:""})} className={dangerButton}>Reverse</button> : "—"}</td>
            </tr>)}</tbody>
          </table>
        </div> : <Empty>{selectedReading ? "No work-order cost allocations exist for this reading." : "Select a meter reading to view allocation details."}</Empty>}
        {selectedReading ? <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-slate-100 pt-3 text-[10px] text-slate-500"><span>Reading ID: {selectedReading.id}</span><span>Source: {str(selectedReading.source_type)}</span><span>Work orders loaded: {workOrders.length}</span></div> : null}
      </Panel>
    </div> : null}

    {editor ? <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) closeEditor(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="utility-editor-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-5">
          <div><h2 id="utility-editor-title" className="text-sm font-bold text-slate-950">{editorTitle[editor]}</h2><p className="mt-1 text-[10px] text-slate-500">{editor === "READING_CREATE" ? selectedMeterLabel : "Inputs are validated before submission; server-side factory scope and policy checks remain authoritative."}</p></div>
          <button type="button" onClick={closeEditor} disabled={busy} className={secondaryButton}>Close</button>
        </div>
        <form onSubmit={submit} className="space-y-4 p-4 sm:p-5">
          {editor === "METER_CREATE" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Meter code" name="meter_code" value={draft.meter_code ?? ""} onChange={update} />
            <Field label="Meter name" name="name" value={draft.name ?? ""} onChange={update} />
            <SelectField label="Utility type" name="utility_type" value={draft.utility_type ?? "ELECTRICITY"} onChange={update} options={["ELECTRICITY","GAS","STEAM","WATER","COMPRESSED_AIR","FUEL","OTHER"].map(value=>({value,label:value.replaceAll("_"," ")}))} />
            <SelectField label="Reading mode" name="reading_mode" value={draft.reading_mode ?? "CUMULATIVE"} onChange={update} options={[{value:"CUMULATIVE",label:"Cumulative counter"},{value:"INTERVAL",label:"Interval reading"}]} />
            <Field label="Unit code" name="unit_code" value={draft.unit_code ?? ""} onChange={update} placeholder="kWh, m3, kg…" />
            <Field label="Multiplier factor" name="multiplier_factor" value={draft.multiplier_factor ?? "1"} onChange={update} type="number" min="0.00000001" step="0.00000001" />
            <Field label="Unit cost" name="unit_cost" value={draft.unit_cost ?? "0"} onChange={update} type="number" min="0" step="0.00000001" />
            <Field label="Currency code" name="currency_code" value={draft.currency_code ?? "BDT"} onChange={update} />
            <Field label="Cost centre" name="cost_center_code" value={draft.cost_center_code ?? ""} onChange={update} required={false} />
            <Field label="Source system" name="source_system_code" value={draft.source_system_code ?? ""} onChange={update} required={false} />
            <Field label="Location" name="location" value={draft.location ?? ""} onChange={update} required={false} />
            <SelectField label="Parent meter" name="parent_meter_id" value={draft.parent_meter_id ?? ""} onChange={update} required={false} options={[{value:"",label:"No parent"},...meters.filter(item=>item.status==="ACTIVE").map(item=>({value:item.id,label:str(item.meter_code)+" · "+str(item.name)}))]} />
          </div> : null}

          {editor === "READING_CREATE" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reading time" name="reading_at" value={draft.reading_at ?? ""} onChange={update} type="datetime-local" />
            <Field label={"Reading value (" + str(selectedMeter?.unit_code) + ")"} name="reading_value" value={draft.reading_value ?? ""} onChange={update} type="number" min="0" step="0.00000001" />
            <SelectField label="Reading source" name="source_type" value={draft.source_type ?? "MANUAL"} onChange={update} options={["MANUAL","API","METER_GATEWAY","IMPORT"].map(value=>({value,label:value.replaceAll("_"," ")}))} />
            <Field label="Production quantity (optional)" name="production_quantity" value={draft.production_quantity ?? ""} onChange={update} type="number" min="0.00000001" step="0.00000001" required={false} />
            <Field label="Source event ID" name="source_event_id" value={draft.source_event_id ?? ""} onChange={update} required={false} />
            <Field label="Notes" name="notes" value={draft.notes ?? ""} onChange={update} required={false} />
          </div> : null}

          {editor === "EVENT_CREATE" ? <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Event type" name="event_type" value={draft.event_type ?? "OUTAGE"} onChange={update} options={["OUTAGE","PEAK_LOAD","LEAK","PRESSURE_DROP","METER_FAULT","EFFICIENCY_EXCEPTION","OTHER"].map(value=>({value,label:value.replaceAll("_"," ")}))} />
            <SelectField label="Severity" name="severity" value={draft.severity ?? "HIGH"} onChange={update} options={["LOW","MEDIUM","HIGH","CRITICAL"].map(value=>({value,label:value}))} />
            <Field label="Title" name="title" value={draft.title ?? ""} onChange={update} />
            <SelectField label="Related meter (optional)" name="meter_id" value={draft.meter_id ?? ""} onChange={update} required={false} options={[{value:"",label:"No linked meter"},...meters.map(item=>({value:item.id,label:str(item.meter_code)+" · "+str(item.name)}))]} />
            <Field label="Occurred at" name="occurred_at" value={draft.occurred_at ?? ""} onChange={update} type="datetime-local" />
            <Field label="Impact minutes" name="impact_minutes" value={draft.impact_minutes ?? "0"} onChange={update} type="number" min="0" step="1" />
            <Field label="Impact quantity (optional)" name="impact_quantity" value={draft.impact_quantity ?? ""} onChange={update} type="number" min="0" step="0.00000001" required={false} />
            <Field label="Cause (optional)" name="cause" value={draft.cause ?? ""} onChange={update} required={false} />
            <div className="sm:col-span-2"><TextAreaField label="Description" name="description" value={draft.description ?? ""} onChange={update} /></div>
          </div> : null}

          {editor === "EVENT_TRANSITION" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Expected record version" name="expected_version" value={draft.expected_version ?? ""} onChange={update} type="number" min="1" />
            <SelectField label="Action" name="action" value={draft.action ?? "ACKNOWLEDGE"} onChange={update} options={["ACKNOWLEDGE","RESOLVE","CANCEL"].map(value=>({value,label:value}))} />
            <div className="sm:col-span-2"><Field label="Reason" name="reason" value={draft.reason ?? ""} onChange={update} /></div>
            {draft.action === "RESOLVE" ? <div className="sm:col-span-2"><TextAreaField label="Resolution evidence" name="resolution" value={draft.resolution ?? ""} onChange={update} hint="Required when resolving the utility event." /></div> : null}
            <Field label="Impact minutes (optional)" name="impact_minutes" value={draft.impact_minutes ?? ""} onChange={update} type="number" min="0" step="1" required={false} />
            <Field label="Impact quantity (optional)" name="impact_quantity" value={draft.impact_quantity ?? ""} onChange={update} type="number" min="0" step="0.00000001" required={false} />
          </div> : null}

          {editor === "BINDING_CREATE" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Source system code" name="source_system_code" value={draft.source_system_code ?? ""} onChange={update} />
            <Field label="Source meter code" name="source_meter_code" value={draft.source_meter_code ?? ""} onChange={update} />
            <SelectField label="Vendor adapter" name="vendor_adapter" value={draft.vendor_adapter ?? "REST_POLL"} onChange={update} options={["REST_POLL","OPC_UA","MQTT","MODBUS","FILE_IMPORT","MANUAL_IMPORT"].map(value=>({value,label:value.replaceAll("_"," ")}))} />
            <SelectField label="Factory meter" name="meter_id" value={draft.meter_id ?? ""} onChange={update} options={[{value:"",label:"Select active meter"},...meters.filter(item=>item.status==="ACTIVE").map(item=>({value:item.id,label:str(item.meter_code)+" · "+str(item.name)}))]} />
            <Field label="Source unit code" name="source_unit_code" value={draft.source_unit_code ?? ""} onChange={update} />
            <Field label="Conversion factor" name="factor_to_meter_unit" value={draft.factor_to_meter_unit ?? "1"} onChange={update} type="number" min="0.00000001" step="0.00000001" />
            <Field label="Polling interval seconds" name="polling_interval_seconds" value={draft.polling_interval_seconds ?? ""} onChange={update} type="number" min="5" max="86400" step="1" required={["REST_POLL","OPC_UA","MODBUS"].includes(draft.vendor_adapter ?? "REST_POLL")} />
            <Field label="Credential reference (optional)" name="credential_reference" value={draft.credential_reference ?? ""} onChange={update} required={false} hint="Use vault://, secrets://, kms:// or an AWS Secrets Manager ARN." />
            <div className="sm:col-span-2"><TextAreaField label="Non-secret configuration metadata (JSON object)" name="config_metadata" value={draft.config_metadata ?? "{}"} onChange={update} hint="Passwords, tokens, keys and credential fields are rejected." /></div>
          </div> : null}

          {editor === "BINDING_TRANSITION" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Expected record version" name="expected_version" value={draft.expected_version ?? ""} onChange={update} type="number" min="1" />
            <SelectField label="Action" name="action" value={draft.action ?? "ACTIVATE"} onChange={update} options={["ACTIVATE","DEACTIVATE","RETIRE"].map(value=>({value,label:value}))} />
            <div className="sm:col-span-2"><Field label="Reason" name="reason" value={draft.reason ?? ""} onChange={update} /></div>
            <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">Activation requires a different user than the binding creator. The server independently enforces this rule and the expected version.</p>
          </div> : null}

          {editor === "SOURCE_INGEST" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Source system code" name="source_system_code" value={draft.source_system_code ?? ""} onChange={update} />
            <Field label="Source meter code" name="source_meter_code" value={draft.source_meter_code ?? ""} onChange={update} />
            <Field label="Unique source event ID" name="source_event_id" value={draft.source_event_id ?? ""} onChange={update} />
            <Field label="Reading time" name="reading_at" value={draft.reading_at ?? ""} onChange={update} type="datetime-local" />
            <Field label="Source reading value" name="reading_value" value={draft.reading_value ?? ""} onChange={update} type="number" min="0" step="0.00000001" />
            <Field label="Source unit code" name="source_unit_code" value={draft.source_unit_code ?? ""} onChange={update} />
            <Field label="Production quantity (optional)" name="production_quantity" value={draft.production_quantity ?? ""} onChange={update} type="number" min="0.00000001" step="0.00000001" required={false} />
            <Field label="Notes (optional)" name="notes" value={draft.notes ?? ""} onChange={update} required={false} />
          </div> : null}

          {editor === "POLICY_CREATE" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Policy code" name="policy_code" value={draft.policy_code ?? ""} onChange={update} />
            <Field label="Policy name" name="name" value={draft.name ?? ""} onChange={update} />
            <SelectField label="Target meter (optional)" name="meter_id" value={draft.meter_id ?? ""} onChange={update} required={false} options={[{value:"",label:"Use utility type instead"},...meters.filter(item=>item.status==="ACTIVE").map(item=>({value:item.id,label:str(item.meter_code)+" · "+str(item.name)}))]} />
            <SelectField label="Utility type" name="utility_type" value={draft.utility_type ?? "ELECTRICITY"} onChange={update} options={[{value:"",label:"No type (meter-specific)"},...["ELECTRICITY","GAS","STEAM","WATER","COMPRESSED_AIR","FUEL","OTHER"].map(value=>({value,label:value.replaceAll("_"," ")}))]} />
            <SelectField label="Metric" name="metric" value={draft.metric ?? "CONSUMPTION"} onChange={update} options={[{value:"CONSUMPTION",label:"Consumption"},{value:"COST",label:"Cost"},{value:"INTENSITY",label:"Intensity"}]} />
            <SelectField label="Comparison" name="comparison" value={draft.comparison ?? "GT"} onChange={update} options={[{value:"GT",label:"Greater than"},{value:"GTE",label:"Greater than or equal"},{value:"LT",label:"Less than"},{value:"LTE",label:"Less than or equal"}]} />
            <Field label="Threshold value" name="threshold_value" value={draft.threshold_value ?? ""} onChange={update} type="number" min="0" step="0.00000001" />
            <Field label="Threshold unit code" name="threshold_unit_code" value={draft.threshold_unit_code ?? ""} onChange={update} hint="Must match the selected meter's metric unit." />
            <SelectField label="Severity" name="severity" value={draft.severity ?? "HIGH"} onChange={update} options={["LOW","MEDIUM","HIGH","CRITICAL"].map(value=>({value,label:value}))} />
          </div> : null}

          {editor === "POLICY_TRANSITION" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Expected record version" name="expected_version" value={draft.expected_version ?? ""} onChange={update} type="number" min="1" />
            <SelectField label="Action" name="action" value={draft.action ?? "ACTIVATE"} onChange={update} options={["ACTIVATE","DEACTIVATE","RETIRE"].map(value=>({value,label:value}))} />
            <div className="sm:col-span-2"><Field label="Reason" name="reason" value={draft.reason ?? ""} onChange={update} /></div>
            <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">Activation requires an independent user and the API validates metric units and expected record version.</p>
          </div> : null}

          {editor === "ALLOCATE" ? <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Released work order" name="work_order_id" value={draft.work_order_id ?? ""} onChange={update}
              options={[{value:"",label:"Select work order"},...workOrders.filter(item=>["IN_PROGRESS","COMPLETED"].includes(String(item.status))).map(item=>({value:item.id,label:str(item.work_order_number)+" · "+str(item.status)}))]} />
            <Field label="Allocated quantity" name="allocated_quantity" value={draft.allocated_quantity ?? ""} onChange={update} placeholder="Exact decimal quantity" hint={"Maximum available: " + numberLabel(allocationSource.remaining_quantity,8) + " " + str(selectedReading?.unit_code)} />
            <div className="sm:col-span-2"><Field label="Allocation reason" name="reason" value={draft.reason ?? ""} onChange={update} /></div>
            {!workOrders.length ? <p className="sm:col-span-2 text-[10px] text-amber-800">No production work orders were loaded. Check production.workorders.read permission and select a released work order.</p> : null}
          </div> : null}

          {editor === "REVERSE" ? <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Allocation ID" name="allocation_id" value={draft.allocation_id ?? ""} onChange={update} />
            <div className="sm:col-span-2"><Field label="Reversal reason" name="reason" value={draft.reason ?? ""} onChange={update} /></div>
            <p className="sm:col-span-2 rounded-lg bg-rose-50 p-3 text-[10px] leading-5 text-rose-900">This creates a separate reversal entry. A fully reversed allocation cannot be reversed again.</p>
          </div> : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
            <button type="button" onClick={closeEditor} disabled={busy} className={secondaryButton}>Cancel</button>
            <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Saving…" : "Submit"}</button>
          </div>
        </form>
      </section>
    </div> : null}
  </main>;
}
