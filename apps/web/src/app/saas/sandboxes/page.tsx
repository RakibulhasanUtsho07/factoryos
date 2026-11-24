"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildCreateSandboxPayload, buildMaskedApprovalPayload, buildSandboxPhysicalPayload,
  buildSandboxTransitionPayload, createSaasSandboxClient, filterSandboxes,
  normalizePhysicalRunDetail, normalizePhysicalRunRows, normalizeSandboxEvents,
  normalizeSandboxMutation, normalizeSandboxRows, summarizeSandboxes,
} from "@/lib/saas-sandbox-governance.mjs";
import type { SaasSandboxClient } from "@/lib/saas-sandbox-governance.mjs";

type Row = Record<string, unknown>;
type Tab = "ENVIRONMENTS" | "APPROVALS" | "PHYSICAL";
type DataMode = "SYNTHETIC" | "MASKED";
type Purpose = "DEMO" | "TEST" | "EVALUATION" | "TRAINING";
type Transition = "SUSPEND" | "RESUME" | "RETIRE";

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const BUTTON = "inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = BUTTON + " bg-slate-950 text-white hover:bg-slate-800";
const SECONDARY = BUTTON + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const DANGER = BUTTON + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

function row(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function textOf(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function dateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function errorOf(cause: unknown): string { return cause instanceof Error ? cause.message : "The SaaS sandbox request could not be completed."; }
function digestShort(value: unknown): string {
  const digest = textOf(value, ""); return digest ? digest.slice(0, 12) + "…" + digest.slice(-8) : "Not recorded";
}
function badgeClass(value: string): string {
  if (["ACTIVE", "SUCCEEDED", "RESUMED"].includes(value)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["PENDING_APPROVAL", "APPROVAL_EXPIRED", "IN_PROGRESS", "MASKED_APPROVAL_REQUESTED"].includes(value)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["SUSPENDED", "HALTED"].includes(value)) return "border-orange-200 bg-orange-50 text-orange-900";
  if (["FAILED", "ROLLBACK_FAILED"].includes(value)) return "border-rose-200 bg-rose-50 text-rose-800";
  if (value === "RETIRED") return "border-slate-300 bg-slate-100 text-slate-600";
  return "border-blue-200 bg-blue-50 text-blue-800";
}
function Badge({ value }: { value: string }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + badgeClass(value)}>{value.replaceAll("_", " ")}</span>;
}
function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
      <div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}</div>
      {action}
    </div><div className="p-4 sm:p-5">{children}</div>
  </section>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>{children}{hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}</label>;
}
function Metric({ label, value, hint }: { label: string; value: number; hint: string }) {
  return <article className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[10px] text-slate-500">{hint}</p></article>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function safeManifest(value: unknown): Array<[string, string]> {
  const manifest = row(value); const fields: Array<[string, string]> = [];
  for (const key of ["generator", "generator_version", "schema_version", "seed", "record_count", "dataset_reference", "masking_policy_version", "masked_at", "checksum_sha256"]) {
    if (manifest[key] !== undefined && manifest[key] !== null) fields.push([key, key === "checksum_sha256" ? digestShort(manifest[key]) : textOf(manifest[key])]);
  }
  return fields;
}
function safePrivacy(value: unknown): Array<[string, string]> {
  const assessment = row(value); const fields: Array<[string, string]> = [];
  for (const key of ["data_minimization_status", "residual_risk", "assessed_at"]) if (assessment[key] !== undefined) fields.push([key, textOf(assessment[key])]);
  if (Array.isArray(assessment.reviewed_fields)) fields.push(["reviewed_fields", assessment.reviewed_fields.map((item) => textOf(item)).join(", ")]);
  return fields;
}
function FieldList({ fields }: { fields: Array<[string, string]> }) {
  return fields.length ? <dl className="grid gap-2 sm:grid-cols-2">{fields.map(([key, value]) => <div key={key} className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase tracking-wide text-slate-500">{key.replaceAll("_", " ")}</dt><dd className="mt-1 break-all text-xs font-semibold text-slate-800">{value}</dd></div>)}</dl> : <p className="text-xs text-slate-500">No metadata recorded.</p>;
}

export default function SaasSandboxGovernancePage() {
  const { status, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot);
  const client = useMemo<SaasSandboxClient>(() => createSaasSandboxClient(request), [request]);
  const canRead = hasPermission("saas.sandboxes.read");
  const canWrite = hasPermission("saas.sandboxes.write");
  const canApprove = hasPermission("saas.sandboxes.approve_masked_data");
  const canControl = hasPermission("saas.sandboxes.control");
  const canReadPhysical = hasPermission("saas.physical_provisioning.read");

  const [tab, setTab] = useState<Tab>("ENVIRONMENTS");
  const [environments, setEnvironments] = useState<Row[]>([]);
  const [events, setEvents] = useState<Row[]>([]);
  const [runs, setRuns] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<Row | null>(null);
  const [runEvents, setRunEvents] = useState<Row[]>([]);
  const [filters, setFilters] = useState({ query: "", status: "ALL", dataMode: "ALL", purpose: "ALL" });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [clockNow, setClockNow] = useState(0);
  const selectedIdRef = useRef("");

  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<DataMode>("SYNTHETIC");
  const [draft, setDraft] = useState({
    environment_code: "", display_name: "", purpose: "TEST" as Purpose,
    generator: "factoryos-synthetic-fixture-generator", generator_version: "1.0.0",
    schema_version: "v1", seed: "factoryos-demo-seed", record_count: "1000",
    dataset_reference: "", masking_policy_version: "masking-v1",
    masked_at: "",
    checksum_sha256: "", residual_risk: "LOW" as "LOW" | "MEDIUM",
    reviewed_fields: "email, phone", assessed_at: "",
  });
  const [approval, setApproval] = useState({
    approval_expires_at: "", reason: "",
  });
  const [transition, setTransition] = useState({ action: "SUSPEND" as Transition, reason: "" });
  const [physicalTargetId, setPhysicalTargetId] = useState("");
  const [physicalTimeout, setPhysicalTimeout] = useState("60");
  const [physicalAcknowledged, setPhysicalAcknowledged] = useState(false);

  const summary = useMemo(() => summarizeSandboxes(environments), [environments]);
  const filtered = useMemo(() => filterSandboxes(environments, filters), [environments, filters]);
  const queue = useMemo(() => environments.filter((item) => item.dataMode === "MASKED" && (
    item.effectiveStatus === "PENDING_APPROVAL" || item.effectiveStatus === "APPROVAL_EXPIRED" ||
    (clockNow > 0 && item.status === "SUSPENDED" && item.approvalExpiresAt && Date.parse(textOf(item.approvalExpiresAt)) <= clockNow)
  )), [environments, clockNow]);
  const currentUserId = textOf(snapshot?.user.id, "");
  const requesterSelf = Boolean(selected && textOf(selected.approvalRequestedBy, "") === currentUserId);
  const selectedStatus = textOf(selected?.status, "");
  const selectedEffective = textOf(selected?.effectiveStatus, selectedStatus);
  const selectedMode = textOf(selected?.dataMode, "");
  const approvalExpired = selectedMode === "MASKED" && (
    selectedEffective === "APPROVAL_EXPIRED" ||
    (clockNow > 0 && selected?.approvalExpiresAt !== null && selected?.approvalExpiresAt !== undefined && Date.parse(textOf(selected.approvalExpiresAt)) <= clockNow)
  );
  const canReview = Boolean(selected && selectedMode === "MASKED" && canApprove && !requesterSelf &&
    (selectedStatus === "PENDING_APPROVAL" || approvalExpired));
  const transitionOptions: Transition[] = selectedStatus === "ACTIVE" ? ["SUSPEND", "RETIRE"]
    : selectedStatus === "SUSPENDED" ? ["RESUME", "RETIRE"] : [];
  const selectedTransition = transitionOptions.includes(transition.action) ? transition.action : transitionOptions[0] ?? "RETIRE";
  const canProvision = Boolean(selected && canControl && selectedStatus === "ACTIVE" && selectedEffective === "ACTIVE" && !approvalExpired);

  const refreshAll = useCallback(() => { setLoading(true); setRefreshTick((value) => value + 1); }, []);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!connected) {
        await Promise.resolve();
        if (live) { setEnvironments([]); setEvents([]); setRuns([]); setSelected(null); setSelectedRun(null); setLoading(false); }
        return;
      }
      const [envResult, runResult] = await Promise.allSettled([
        canRead ? client.listEnvironments() : Promise.resolve({ items: [] }),
        canReadPhysical ? client.listPhysicalRuns(50, 0) : Promise.resolve({ runs: [] }),
      ]);
      if (!live) return;
      setClockNow(Date.now());
      if (envResult.status === "fulfilled") {
        const next = normalizeSandboxRows(envResult.value).map(row);
        setEnvironments(next);
        const currentSelectedId = selectedIdRef.current;
        const chosenId = next.some((item) => textOf(item.id, "") === currentSelectedId) ? currentSelectedId : textOf(next[0]?.id, "");
        selectedIdRef.current = chosenId;
        setSelectedId(chosenId);
        const chosen = next.find((item) => textOf(item.id, "") === chosenId) ?? null;
        setSelected(chosen ? row(chosen) : null);
        if (chosenId) {
          try { const history = await client.events(chosenId); if (live) setEvents(normalizeSandboxEvents(history).map(row)); }
          catch (cause) { if (live) setDetailError(errorOf(cause)); }
        } else setEvents([]);
        setLoadError("");
      } else if (canRead) setLoadError(errorOf(envResult.reason));
      if (runResult.status === "fulfilled") {
        setRuns(normalizePhysicalRunRows(runResult.value).map(row).filter((item) => item.operation === "SANDBOX_PROVISION"));
      } else if (canReadPhysical) setLoadError(errorOf(runResult.reason));
      setLoading(false);
    };
    void load();
    return () => { live = false; };
  }, [connected, canRead, canReadPhysical, client, refreshTick]);

  const selectEnvironment = async (id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelected(row(environments.find((item) => textOf(item.id) === id)));
    setDetailLoading(true); setDetailError("");
    try { setEvents(normalizeSandboxEvents(await client.events(id)).map(row)); }
    catch (cause) { setDetailError(errorOf(cause)); }
    finally { setDetailLoading(false); }
  };
  const selectRun = async (id: string) => {
    setSelectedRunId(id); setSelectedRun(null); setRunEvents([]); setDetailLoading(true); setDetailError("");
    try {
      const detail = normalizePhysicalRunDetail(await client.physicalRun(id));
      setSelectedRun(detail.run); setRunEvents(detail.events.map(row));
    } catch (cause) { setDetailError(errorOf(cause)); }
    finally { setDetailLoading(false); }
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const payload = buildCreateSandboxPayload({
        ...draft, data_mode: createMode, record_count: Number(draft.record_count),
        reviewed_fields: draft.reviewed_fields.split(",").map((item) => item.trim()).filter(Boolean),
        masked_at: new Date(draft.masked_at).toISOString(), assessed_at: new Date(draft.assessed_at).toISOString(),
        idempotency_key: globalThis.crypto.randomUUID(),
      });
      const result = normalizeSandboxMutation(await client.createEnvironment(payload));
      const code = textOf(result.environment.environmentCode, draft.environment_code.toUpperCase());
      setNotice({ tone: "success", message: createMode === "MASKED"
        ? "Masked sandbox " + code + " was registered as PENDING_APPROVAL. An independent reviewer must approve it before access or provisioning."
        : "Synthetic sandbox " + code + " was registered ACTIVE. Physical provisioning remains a separate provider operation." });
      setShowCreate(false); setSelectedId(textOf(result.environment.id, ""));
      setDraft((current) => ({ ...current, environment_code: "", display_name: "", dataset_reference: "", checksum_sha256: "" }));
      refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };
  const submitApproval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selected) return; setBusy(true); setNotice(null);
    try {
      const payload = buildMaskedApprovalPayload({
        expected_version: Number(selected.version), reason: approval.reason,
        approval_expires_at: new Date(approval.approval_expires_at).toISOString(),
        idempotency_key: globalThis.crypto.randomUUID(),
      });
      const result = normalizeSandboxMutation(await client.approveMaskedData(textOf(selected.id), payload));
      setNotice({ tone: "success", message: "Independent masked-data approval recorded until " + dateTime(result.environment.approvalExpiresAt) + "." });
      setApproval((current) => ({ ...current, reason: "" })); refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };
  const submitTransition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selected) return; setBusy(true); setNotice(null);
    try {
      await client.transition(textOf(selected.id), buildSandboxTransitionPayload({
        action: selectedTransition, expected_version: Number(selected.version), reason: transition.reason,
        idempotency_key: globalThis.crypto.randomUUID(),
      }));
      setNotice({ tone: "success", message: "Sandbox " + selectedTransition + " transition was recorded in the versioned lifecycle ledger." });
      setTransition((current) => ({ ...current, reason: "" })); refreshAll();
    } catch (cause) { setNotice({ tone: "error", message: errorOf(cause) }); }
    finally { setBusy(false); }
  };
  const submitProvision = async () => {
    if (!selected || physicalTargetId !== textOf(selected.id)) return; setBusy(true); setNotice(null);
    try {
      const payload = buildSandboxPhysicalPayload({
        expected_version: Number(selected.version), idempotency_key: globalThis.crypto.randomUUID(),
        health_timeout_seconds: Number(physicalTimeout),
      });
      const result = normalizePhysicalRunDetail(await client.provision(physicalTargetId, payload));
      setSelectedRun(result.run); setSelectedRunId(textOf(result.run.id, "")); setRunEvents(result.events.map(row));
      setNotice({ tone: "success", message: "Provider operation returned " + textOf(result.run.status, "unknown") + ". Inspect the physical receipt before assuming the sandbox is ready." });
      setPhysicalTargetId(""); setPhysicalAcknowledged(false); setTab("PHYSICAL"); refreshAll();
    } catch (cause) {
      setNotice({ tone: "error", message: errorOf(cause) + " Do not assume the environment was provisioned; inspect immutable run evidence." });
      refreshAll();
    } finally { setBusy(false); }
  };

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">SaaS operations / data governance</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Sandbox & Masked-Data Governance</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Create synthetic or privacy-assessed masked environments, review time-bound access approvals, manage lifecycle and inspect provider provisioning evidence.</p>
          <p className="mt-2 text-xs font-medium text-slate-500">Tenant: {textOf(snapshot?.tenant.name, "Not connected")} · Operator: {textOf(snapshot?.user.displayName, "Not connected")}</p>
        </div>
        <div className="flex flex-wrap gap-2"><button type="button" className={SECONDARY} onClick={refreshAll} disabled={!connected || loading}>Refresh workbench</button>{canWrite ? <button type="button" className={PRIMARY} onClick={() => setShowCreate((value) => !value)}>{showCreate ? "Close create form" : "Create sandbox"}</button> : null}</div>
      </header>
      {notice ? <div role="status" className={"rounded-xl border px-4 py-3 text-sm " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900")}>{notice.message}</div> : null}
      {!connected ? <Empty>Connect an authenticated FactoryOS session to access tenant sandbox environments.</Empty> : null}
      {connected && !canRead && !canWrite && !canApprove && !canControl && !canReadPhysical ? <Empty>Your IAM permissions do not include SaaS sandbox read, create, approval, lifecycle or physical evidence access.</Empty> : null}

      {connected ? (
        <>
          {canRead ? <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Environments" value={summary.total} hint="Latest tenant register, max 100" />
            <Metric label="Synthetic" value={summary.synthetic} hint="Synthetic dataset metadata" />
            <Metric label="Masked" value={summary.masked} hint="Independent approval required" />
            <Metric label="Pending review" value={summary.pendingApproval} hint="Not accessible until approved" />
            <Metric label="Active" value={summary.active} hint="Effective active status" />
            <Metric label="Approval expired" value={summary.approvalExpired} hint="Access and provisioning blocked" />
            <Metric label="Suspended" value={summary.suspended} hint="Resume only when eligible" />
            <Metric label="Retired" value={summary.retired} hint="Terminal lifecycle state" />
          </section> : null}
          <nav className="flex flex-wrap gap-2" aria-label="SaaS sandbox sections">
            <button type="button" className={tab === "ENVIRONMENTS" ? PRIMARY : SECONDARY} onClick={() => setTab("ENVIRONMENTS")}>Environment register</button>
            <button type="button" className={tab === "APPROVALS" ? PRIMARY : SECONDARY} onClick={() => setTab("APPROVALS")}>Masked-data approvals <span className="ml-1 rounded-full bg-white/20 px-1.5 py-0.5">{queue.length}</span></button>
            <button type="button" className={tab === "PHYSICAL" ? PRIMARY : SECONDARY} onClick={() => setTab("PHYSICAL")}>Provisioning evidence</button>
          </nav>

          {tab === "ENVIRONMENTS" ? <div className="space-y-5">
            {canRead ? <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(460px,0.9fr)]">
              <Panel title="Sandbox environment register" subtitle="The API returns up to 100 tenant-owned environments. Metrics and local filters apply to this loaded set.">
                {loadError ? <p role="alert" className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{loadError}</p> : null}
                <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <Field label="Search"><input className={INPUT} value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.currentTarget.value }))} placeholder="Code or name" /></Field>
                  <Field label="Effective status"><select className={INPUT} value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.currentTarget.value }))}><option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="PENDING_APPROVAL">Pending approval</option><option value="APPROVAL_EXPIRED">Approval expired</option><option value="SUSPENDED">Suspended</option><option value="RETIRED">Retired</option></select></Field>
                  <Field label="Data mode"><select className={INPUT} value={filters.dataMode} onChange={(event) => setFilters((current) => ({ ...current, dataMode: event.currentTarget.value }))}><option value="ALL">All modes</option><option value="SYNTHETIC">Synthetic</option><option value="MASKED">Masked</option></select></Field>
                  <Field label="Purpose"><select className={INPUT} value={filters.purpose} onChange={(event) => setFilters((current) => ({ ...current, purpose: event.currentTarget.value }))}><option value="ALL">All purposes</option><option value="DEMO">Demo</option><option value="TEST">Test</option><option value="EVALUATION">Evaluation</option><option value="TRAINING">Training</option></select></Field>
                </div>
                <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs">
                  <thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-3">Environment</th><th className="px-2 py-3">Purpose</th><th className="px-2 py-3">Mode</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Version</th><th className="px-2 py-3">Approval expiry</th></tr></thead>
                  <tbody>{loading ? <tr><td colSpan={6} className="px-2 py-10 text-center text-slate-500">Loading sandbox environments...</td></tr>
                    : filtered.length === 0 ? <tr><td colSpan={6} className="px-2 py-8"><Empty>No environments match the current filters.</Empty></td></tr>
                      : filtered.map((item) => <tr key={textOf(item.id)} onClick={() => void selectEnvironment(textOf(item.id))} className={"cursor-pointer border-b border-slate-100 hover:bg-slate-50 " + (selectedId === textOf(item.id) ? "bg-blue-50/70" : "")}>
                        <td className="px-2 py-3"><p className="font-bold text-slate-900">{textOf(item.environmentCode)}</p><p className="mt-1 text-[10px] text-slate-500">{textOf(item.displayName)}</p></td><td className="px-2 py-3">{textOf(item.purpose)}</td><td className="px-2 py-3"><Badge value={textOf(item.dataMode, "UNKNOWN")} /></td><td className="px-2 py-3"><Badge value={textOf(item.effectiveStatus, textOf(item.status, "UNKNOWN"))} /></td><td className="px-2 py-3 tabular-nums">{textOf(item.version)}</td><td className="px-2 py-3 text-[10px] text-slate-500">{dateTime(item.approvalExpiresAt)}</td>
                      </tr>)}</tbody>
                </table></div>
              </Panel>
              <Panel title="Selected sandbox" subtitle="Metadata, privacy assessment, independent review, lifecycle and provider controls for the selected tenant environment.">
                {!selected ? <Empty>Select an environment to inspect.</Empty> : <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Environment</p><h3 className="mt-1 text-xl font-bold text-slate-950">{textOf(selected.environmentCode)}</h3><p className="mt-1 text-xs text-slate-500">{textOf(selected.displayName)} · {textOf(selected.purpose)}</p></div><div className="text-right"><Badge value={selectedEffective} /><p className="mt-1 text-[10px] text-slate-500">Version {textOf(selected.version)}</p></div></div>
                  <div className="grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Data mode</p><p className="mt-1 text-xs font-semibold">{textOf(selected.dataMode)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Stored status</p><p className="mt-1 text-xs font-semibold">{textOf(selected.status)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Created</p><p className="mt-1 text-xs font-semibold">{dateTime(selected.createdAt)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Updated</p><p className="mt-1 text-xs font-semibold">{dateTime(selected.updatedAt)}</p></div></div>
                  {selectedMode === "MASKED" ? <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-amber-950">Masked-data approval</p><Badge value={approvalExpired ? "APPROVAL_EXPIRED" : selectedStatus} /></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><div><p className="text-[10px] uppercase text-amber-900/70">Requested by</p><p className="mt-1 break-all text-xs font-semibold text-amber-950">{textOf(selected.approvalRequestedBy)}</p></div><div><p className="text-[10px] uppercase text-amber-900/70">Approved by</p><p className="mt-1 break-all text-xs font-semibold text-amber-950">{textOf(selected.approvedBy)}</p></div><div><p className="text-[10px] uppercase text-amber-900/70">Approved at</p><p className="mt-1 text-xs font-semibold text-amber-950">{dateTime(selected.approvedAt)}</p></div><div><p className="text-[10px] uppercase text-amber-900/70">Expires at</p><p className="mt-1 text-xs font-semibold text-amber-950">{dateTime(selected.approvalExpiresAt)}</p></div></div>{requesterSelf ? <p className="mt-3 rounded-lg border border-amber-300 bg-white/80 p-2 text-[11px] leading-5 text-amber-950">You requested this environment. The backend requires a different reviewer; self-approval is blocked.</p> : null}{selectedStatus === "PENDING_APPROVAL" && !canApprove ? <p className="mt-3 text-[11px] text-amber-950">You do not have masked-data approval permission.</p> : null}</div> : null}
                  <div><h4 className="mb-2 text-xs font-bold text-slate-900">Dataset provenance manifest</h4><FieldList fields={safeManifest(selected.datasetManifest)} /><p className="mt-2 text-[10px] leading-4 text-slate-500">Only allow-listed provenance metadata is displayed. Raw dataset rows and customer payloads are not accepted by this API contract.</p></div>
                  {selectedMode === "MASKED" ? <div><h4 className="mb-2 text-xs font-bold text-slate-900">Privacy assessment</h4><FieldList fields={safePrivacy(selected.privacyAssessment)} /></div> : null}
                  {canReview ? <form className="rounded-xl border border-amber-200 p-3" onSubmit={submitApproval}><h4 className="text-xs font-bold text-slate-900">{approvalExpired ? "Renew masked-data approval" : "Review masked-data approval"}</h4><p className="mt-1 text-[11px] leading-5 text-slate-500">An independent reviewer must attest the assessment. Approval expires automatically; maximum validity is 90 days.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Approval expiry"><input className={INPUT} type="datetime-local" required value={approval.approval_expires_at} onChange={(event) => setApproval((current) => ({ ...current, approval_expires_at: event.currentTarget.value }))} /></Field><Field label="Reviewer reason"><input className={INPUT} required maxLength={1000} value={approval.reason} onChange={(event) => setApproval((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field></div><button type="submit" className={PRIMARY + " mt-3"} disabled={busy}>{busy ? "Recording approval..." : "Approve masked data"}</button></form> : null}
                  {canControl && transitionOptions.length ? <form className="rounded-xl border border-slate-200 p-3" onSubmit={submitTransition}><h4 className="text-xs font-bold text-slate-900">Sandbox lifecycle</h4><div className="mt-3 grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)]"><Field label="Action"><select className={INPUT} value={selectedTransition} onChange={(event) => setTransition((current) => ({ ...current, action: event.currentTarget.value as Transition }))}>{transitionOptions.map((action) => <option key={action} value={action}>{action}</option>)}</select></Field><Field label="Reason"><input className={INPUT} required maxLength={1000} value={transition.reason} onChange={(event) => setTransition((current) => ({ ...current, reason: event.currentTarget.value }))} /></Field></div><button type="submit" className={DANGER + " mt-3"} disabled={busy || (selectedTransition === "RESUME" && selectedMode === "MASKED" && approvalExpired)}>Apply lifecycle transition</button></form> : null}
                  {canProvision ? <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3"><h4 className="text-xs font-bold text-rose-950">Physical provider provisioning</h4><p className="mt-1 text-[11px] leading-5 text-rose-900/80">Provisioning invokes an approved infrastructure adapter. It must prove isolated storage, dataset materialization, exact manifest digest, topology and provider evidence. No approved adapter means fail-closed behavior.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Health timeout (seconds)"><input className={INPUT} type="number" min={5} max={300} value={physicalTimeout} onChange={(event) => setPhysicalTimeout(event.currentTarget.value)} /></Field><div className="flex items-end"><button type="button" className={DANGER} onClick={() => { setPhysicalTargetId(textOf(selected.id)); setPhysicalAcknowledged(false); }}>Review provider authorization</button></div></div></div> : null}
                  {detailError ? <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{detailError}</p> : null}
                  <div className="border-t border-slate-100 pt-3"><h4 className="text-xs font-bold text-slate-900">Versioned lifecycle events</h4>{detailLoading ? <p className="mt-2 text-xs text-slate-500">Loading event history...</p> : events.length === 0 ? <p className="mt-2 text-xs text-slate-500">No lifecycle events returned.</p> : <ol className="mt-3 space-y-2">{events.map((item) => <li key={textOf(item.id)} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2"><div><p className="text-xs font-semibold text-slate-800">v{textOf(item.environmentVersion)} · {textOf(item.eventType)}</p><p className="mt-1 text-[10px] text-slate-500">{textOf(item.reason, "No reason recorded")}</p><p className="mt-1 text-[10px] text-slate-400">Actor {textOf(item.actorUserId)} · {dateTime(item.createdAt)}</p></div><Badge value={textOf(item.toStatus, "UNKNOWN")} /></li>)}</ol>}</div>
                </div>}
              </Panel>
            </div> : <Empty>You do not have SaaS sandbox read permission to list environments.</Empty>}
            {showCreate && canWrite ? <Panel title="Create sandbox environment" subtitle="Synthetic data becomes ACTIVE at registration. Masked data starts PENDING_APPROVAL and remains unavailable until an independent reviewer approves it.">
              <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitCreate}>
                <Field label="Environment code"><input className={INPUT} required maxLength={48} value={draft.environment_code} onChange={(event) => setDraft((current) => ({ ...current, environment_code: event.currentTarget.value.toUpperCase() }))} placeholder="QA-TRAINING-01" /></Field>
                <Field label="Display name"><input className={INPUT} required maxLength={160} value={draft.display_name} onChange={(event) => setDraft((current) => ({ ...current, display_name: event.currentTarget.value }))} placeholder="Quality training environment" /></Field>
                <Field label="Purpose"><select className={INPUT} value={draft.purpose} onChange={(event) => setDraft((current) => ({ ...current, purpose: event.currentTarget.value as Purpose }))}><option value="DEMO">Demo</option><option value="TEST">Test</option><option value="EVALUATION">Evaluation</option><option value="TRAINING">Training</option></select></Field>
                <Field label="Data mode"><select className={INPUT} value={createMode} onChange={(event) => setCreateMode(event.currentTarget.value as DataMode)}><option value="SYNTHETIC">Synthetic only</option><option value="MASKED">Masked dataset (review required)</option></select></Field>
                {createMode === "SYNTHETIC" ? <>
                  <Field label="Synthetic generator"><input className={INPUT} required value={draft.generator} onChange={(event) => setDraft((current) => ({ ...current, generator: event.currentTarget.value }))} maxLength={100} /></Field>
                  <Field label="Generator version"><input className={INPUT} required value={draft.generator_version} onChange={(event) => setDraft((current) => ({ ...current, generator_version: event.currentTarget.value }))} maxLength={80} /></Field>
                  <Field label="Schema version"><input className={INPUT} required value={draft.schema_version} onChange={(event) => setDraft((current) => ({ ...current, schema_version: event.currentTarget.value }))} maxLength={80} /></Field>
                  <Field label="Seed"><input className={INPUT} required value={draft.seed} onChange={(event) => setDraft((current) => ({ ...current, seed: event.currentTarget.value }))} maxLength={128} /></Field>
                </> : <>
                  <Field label="Opaque dataset reference" hint="Reference ID only; URL/path/credentials are rejected."><input className={INPUT} required value={draft.dataset_reference} onChange={(event) => setDraft((current) => ({ ...current, dataset_reference: event.currentTarget.value }))} maxLength={200} /></Field>
                  <Field label="Schema version"><input className={INPUT} required value={draft.schema_version} onChange={(event) => setDraft((current) => ({ ...current, schema_version: event.currentTarget.value }))} maxLength={80} /></Field>
                  <Field label="Masking policy version"><input className={INPUT} required value={draft.masking_policy_version} onChange={(event) => setDraft((current) => ({ ...current, masking_policy_version: event.currentTarget.value }))} maxLength={80} /></Field>
                  <Field label="Masked at"><input className={INPUT} type="datetime-local" required value={draft.masked_at} onChange={(event) => setDraft((current) => ({ ...current, masked_at: event.currentTarget.value }))} /></Field>
                  <Field label="Dataset SHA-256" hint="64 hexadecimal characters."><input className={INPUT + " font-mono"} required minLength={64} maxLength={64} value={draft.checksum_sha256} onChange={(event) => setDraft((current) => ({ ...current, checksum_sha256: event.currentTarget.value.toLowerCase() }))} /></Field>
                  <Field label="Residual risk"><select className={INPUT} value={draft.residual_risk} onChange={(event) => setDraft((current) => ({ ...current, residual_risk: event.currentTarget.value as "LOW" | "MEDIUM" }))}><option value="LOW">Low</option><option value="MEDIUM">Medium</option></select></Field>
                  <Field label="Reviewed schema fields" hint="Comma-separated field identifiers only; no field values."><input className={INPUT} required value={draft.reviewed_fields} onChange={(event) => setDraft((current) => ({ ...current, reviewed_fields: event.currentTarget.value }))} placeholder="email, phone, address" /></Field>
                  <Field label="Privacy assessed at"><input className={INPUT} type="datetime-local" required value={draft.assessed_at} onChange={(event) => setDraft((current) => ({ ...current, assessed_at: event.currentTarget.value }))} /></Field>
                </>}
                <Field label="Record count"><input className={INPUT} type="number" required min={0} max={100000000} value={draft.record_count} onChange={(event) => setDraft((current) => ({ ...current, record_count: event.currentTarget.value }))} /></Field>
                <div className="sm:col-span-2 xl:col-span-4"><p className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-[11px] leading-5 text-blue-950">{createMode === "SYNTHETIC" ? "Synthetic mode accepts only generator/version/schema/seed/count metadata and no privacy assessment payload." : "Masked mode requires opaque dataset provenance, a SHA-256 checksum, completed data-minimization assessment, reviewed schema field names and LOW/MEDIUM residual risk. A different reviewer must approve before use."}</p></div>
                <div className="flex flex-wrap justify-end gap-2 sm:col-span-2 xl:col-span-4"><button type="button" className={SECONDARY} onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Creating..." : createMode === "MASKED" ? "Register pending-review sandbox" : "Create synthetic sandbox"}</button></div>
              </form>
            </Panel> : null}
          </div> : null}

          {tab === "APPROVALS" ? <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,0.9fr)_minmax(450px,1fr)]">
            <Panel title="Masked-data approval queue" subtitle="Pending or expired requests only. The API requires an independent reviewer and an expiry no more than 90 days ahead.">
              {!canRead ? <Empty>You do not have sandbox read permission.</Empty> : queue.length === 0 ? <Empty>No masked-data requests need review.</Empty> : <div className="space-y-2">{queue.map((item) => <button key={textOf(item.id)} type="button" onClick={() => void selectEnvironment(textOf(item.id))} className={"w-full rounded-xl border p-3 text-left transition hover:bg-slate-50 " + (selectedId === textOf(item.id) ? "border-blue-300 bg-blue-50/70" : "border-slate-200 bg-white")}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{textOf(item.environmentCode)} · {textOf(item.displayName)}</p><Badge value={textOf(item.effectiveStatus, "PENDING_APPROVAL")} /></div><p className="mt-1 text-[10px] text-slate-500">Requested by {textOf(item.approvalRequestedBy)} · Version {textOf(item.version)}</p><p className="mt-1 text-[10px] text-slate-500">Expiry {dateTime(item.approvalExpiresAt)}</p></button>)}</div>}
            </Panel>
            <Panel title="Independent privacy reviewer" subtitle="Select a masked request. Requesters cannot approve their own dataset; backend IAM and tenant checks remain authoritative.">
              {!selected || selectedMode !== "MASKED" ? <Empty>Select a masked dataset from the approval queue.</Empty> : requesterSelf ? <Empty>This environment was requested by your user. A different authorized reviewer must approve it.</Empty> : !canApprove ? <Empty>You do not have masked-data approval permission.</Empty> : !canReview ? <Empty>The current environment status does not accept a new approval. Refresh and inspect the latest approval expiry.</Empty> : <form className="space-y-3" onSubmit={submitApproval}>
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-sm font-bold text-slate-900">{textOf(selected.environmentCode)}</p><p className="mt-1 text-xs text-slate-600">{textOf(selected.displayName)}</p><p className="mt-2 text-[10px] text-slate-500">Residual risk: {textOf(row(selected.privacyAssessment).residual_risk)} · Fields reviewed: {Array.isArray(row(selected.privacyAssessment).reviewed_fields) ? row(selected.privacyAssessment).reviewed_fields.length : 0}</p></div>
                <Field label="Approval expiry"><input className={INPUT} type="datetime-local" required value={approval.approval_expires_at} onChange={(event) => setApproval((current) => ({ ...current, approval_expires_at: event.currentTarget.value }))} /></Field>
                <Field label="Reviewer reason"><textarea className={AREA} required maxLength={1000} value={approval.reason} onChange={(event) => setApproval((current) => ({ ...current, reason: event.currentTarget.value }))} placeholder="Independent privacy review outcome" /></Field>
                <button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Saving approval..." : "Approve masked data"}</button>
              </form>}
            </Panel>
          </div> : null}

          {tab === "PHYSICAL" ? <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,0.9fr)_minmax(450px,1fr)]">
            {canReadPhysical ? <>
              <Panel title="Sandbox provisioning runs" subtitle="Latest 50 physical run records are loaded, then filtered to SANDBOX_PROVISION. This is provider evidence, not the sandbox status register.">
                <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-3">Environment</th><th className="px-2 py-3">Topology</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Version</th><th className="px-2 py-3">Started</th></tr></thead><tbody>{loading ? <tr><td colSpan={5} className="px-2 py-10 text-center text-slate-500">Loading provider runs...</td></tr> : runs.length === 0 ? <tr><td colSpan={5} className="px-2 py-8"><Empty>No sandbox provisioning runs found in the loaded run set.</Empty></td></tr> : runs.map((item) => <tr key={textOf(item.id)} onClick={() => void selectRun(textOf(item.id))} className={"cursor-pointer border-b border-slate-100 hover:bg-slate-50 " + (selectedRunId === textOf(item.id) ? "bg-blue-50/70" : "")}><td className="px-2 py-3"><p className="font-semibold">{textOf(item.resourceKey)}</p><p className="mt-1 font-mono text-[9px] text-slate-500">{textOf(item.id)}</p></td><td className="px-2 py-3">{textOf(item.topology)}</td><td className="px-2 py-3"><Badge value={textOf(item.status, "REQUESTED")} /></td><td className="px-2 py-3 tabular-nums">{textOf(item.resourceVersion)}</td><td className="px-2 py-3 text-[10px] text-slate-500">{dateTime(item.createdAt)}</td></tr>)}</tbody></table></div>
              </Panel>
              <Panel title="Physical provider evidence timeline" subtitle="Shows provider IDs and allow-listed evidence metadata; raw provider payloads and credentials are not exposed.">
                {detailLoading ? <Empty>Loading physical run timeline...</Empty> : !selectedRun ? <Empty>Select a sandbox provisioning run.</Empty> : <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-lg font-bold text-slate-950">{textOf(selectedRun.resourceKey)}</h3><p className="mt-1 text-xs text-slate-500">{textOf(selectedRun.operation)} · {textOf(selectedRun.topology)}</p></div><Badge value={textOf(selectedRun.status, "UNKNOWN")} /></div>
                  <div className="grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Run ID</p><p className="mt-1 break-all font-mono text-[10px]">{textOf(selectedRun.id)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Resource version</p><p className="mt-1 text-xs font-semibold">{textOf(selectedRun.resourceVersion)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Dataset manifest digest</p><p className="mt-1 font-mono text-[10px]">{digestShort(selectedRun.datasetManifestDigest)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Health timeout</p><p className="mt-1 text-xs font-semibold">{textOf(selectedRun.healthTimeoutSeconds)} seconds</p></div></div>
                  {detailError ? <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{detailError}</p> : null}
                  {runEvents.length === 0 ? <Empty>No event evidence returned.</Empty> : <ol className="space-y-3">{runEvents.map((item) => {
                    const evidence = row(item.evidence);
                    const keys = ["topology", "isolationVerified", "storageProvisioned", "datasetMaterialized", "datasetMode", "datasetManifestDigest", "maskingPolicyVersion"].filter((key) => evidence[key] !== undefined && evidence[key] !== null);
                    return <li key={textOf(item.version)} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">Event v{textOf(item.version)}</p><Badge value={textOf(item.status, "UNKNOWN")} /></div><div className="mt-2 grid gap-2 sm:grid-cols-2"><div><p className="text-[10px] uppercase text-slate-500">Provider</p><p className="mt-1 text-xs font-semibold">{textOf(item.providerCode)}</p></div><div><p className="text-[10px] uppercase text-slate-500">Reason code</p><p className="mt-1 text-xs font-semibold">{textOf(item.reasonCode)}</p></div><div><p className="text-[10px] uppercase text-slate-500">Provider reference</p><p className="mt-1 break-all font-mono text-[10px]">{textOf(item.providerReference)}</p></div><div><p className="text-[10px] uppercase text-slate-500">Evidence digest</p><p className="mt-1 break-all font-mono text-[10px]">{digestShort(item.evidenceDigest)}</p></div></div>{keys.length ? <ul className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] text-slate-600">{keys.map((key) => <li key={key}>{key}: {key.toLowerCase().includes("digest") ? digestShort(evidence[key]) : textOf(evidence[key])}</li>)}</ul> : null}<p className="mt-2 text-[10px] text-slate-400">{dateTime(item.createdAt)}</p></li>;
                  })}</ol>}
                </div>}
              </Panel>
            </> : <Empty>You do not have physical provisioning read permission. The authorized operation response still returns a run receipt.</Empty>}
          </div> : null}
        </>
      ) : null}

      {physicalTargetId ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="sandbox-physical-title"><div className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl">
        <p className="text-[10px] font-bold uppercase tracking-widest text-rose-700">Infrastructure provider operation</p><h2 id="sandbox-physical-title" className="mt-2 text-lg font-bold text-slate-950">Provision {textOf(selected?.environmentCode)}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">This sends a real SANDBOX_PROVISION request to an approved infrastructure adapter. The provider must prove isolation, storage provisioning, dataset materialization and the exact manifest digest. An unavailable adapter fails closed. An unknown result must be inspected in the immutable run ledger before retrying.</p>
        <Field label="Health-check timeout (seconds)"><input className={INPUT + " mt-2"} type="number" min={5} max={300} value={physicalTimeout} onChange={(event) => setPhysicalTimeout(event.currentTarget.value)} /></Field>
        <label className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-900"><input type="checkbox" className="mt-1" checked={physicalAcknowledged} onChange={(event) => setPhysicalAcknowledged(event.currentTarget.checked)} /><span>I explicitly authorize physical infrastructure provisioning for this exact tenant sandbox and version. I understand provider side effects and evidence-based recovery requirements.</span></label>
        <div className="mt-5 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => { setPhysicalTargetId(""); setPhysicalAcknowledged(false); }} disabled={busy}>Cancel</button><button type="button" className={DANGER} onClick={() => void submitProvision()} disabled={!physicalAcknowledged || busy}>{busy ? "Submitting..." : "Authorize provisioning"}</button></div>
      </div></div> : null}
    </main>
  );
}
