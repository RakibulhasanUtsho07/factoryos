"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildErasureExecutionPayload,
  buildErasurePropagationPayload,
  buildErasureReviewPayload,
  buildExternalTargetPayload,
  buildExternalTargetReviewPayload,
  buildFinanceRetentionPayload,
  buildFinanceRetentionReviewPayload,
  buildFinanceRetentionRunPayload,
  buildLegalHoldPayload,
  buildLegalHoldReleasePayload,
  buildMigrationTransitionPayload,
  buildMigrationValidationPayload,
  buildRetentionPolicyPayload,
  buildRetentionRunPayload,
  buildTenantErasurePayload,
  buildTenantExportPayload,
  createSaasDataProtectionClient,
  normalizeDataProtectionRows,
} from "@/lib/saas-data-protection-workbench.mjs";
import type { SaasDataProtectionClient } from "@/lib/saas-data-protection-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "OVERVIEW" | "RETENTION" | "ERASURE" | "TRANSFERS" | "TARGETS" | "BACKUP";
type Notice = { tone: "success" | "error" | "warning"; message: string };
type WorkspaceData = Record<string, unknown[]>;

const CATEGORIES = [
  "BUSINESS_DATA", "AUDIT_LOG", "EVIDENCE", "APPROVALS", "EFFECTIVE_DATED_MASTER_DATA",
  "AI_CONTEXT", "LEARNING_EVALUATION", "INTEGRATION_METADATA", "FILE_REFERENCES", "IAM_ACCESS",
];
const STORE_KINDS = ["OBJECT_STORAGE", "CACHE", "SEARCH_INDEX", "VECTOR_STORE", "LEARNING_ARTIFACT", "EXTERNAL_PROVIDER", "REPLICA", "BACKUP"];
const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24 font-mono text-xs leading-5";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function list(value: unknown, key?: string): Row[] {
  return normalizeDataProtectionRows(value, key).map(row);
}
function valueOf(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}
function dateOf(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function errorOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The data protection request could not be completed.";
}
function idempotencyKey(prefix: string): string {
  return prefix + "-" + globalThis.crypto.randomUUID();
}
function statusClass(value: unknown): string {
  const status = valueOf(value, "UNKNOWN").toUpperCase();
  if (["ACTIVE", "APPROVED", "COMPLETED", "SUCCESS", "ACCEPTED", "SUPPORTED", "PASS"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["PENDING", "REVIEW", "DRY_RUN", "IN_PROGRESS", "UNRESOLVED", "NOT_RUN"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["REJECTED", "FAILED", "BLOCKED", "REVOKED", "DELETE", "INCOMPATIBLE", "FAIL"].includes(status)) return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}
function Status({ value }: { value: unknown }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + statusClass(value)}>{valueOf(value, "UNKNOWN").replaceAll("_", " ")}</span>;
}
function Panel({ title, subtitle, children, action }: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
      <div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}</div>
      {action}
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </section>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>{children}{hint ? <span className="mt-1 block text-[10px] leading-4 text-slate-500">{hint}</span> : null}</label>;
}
function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[10px] text-slate-500">{hint}</p></div>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function JsonPanel({ title, data }: { title: string; data: unknown }) {
  let serialized = "No evidence returned";
  try { serialized = JSON.stringify(data ?? null, null, 2); } catch { serialized = String(data); }
  return <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-950 p-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-100">{serialized}</pre></div>;
}
function Select({ value, onChange, options, placeholder }: { value: string; onChange: (value: string) => void; options: string[]; placeholder?: string }) {
  return <select className={INPUT} value={value} onChange={(event) => onChange(event.target.value)}>{placeholder ? <option value="">{placeholder}</option> : null}{options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select>;
}
function MultiCategories({ value, onChange, label }: { value: string[]; onChange: (value: string[]) => void; label: string }) {
  return <fieldset className="rounded-xl border border-slate-200 p-3"><legend className="px-1 text-xs font-semibold text-slate-700">{label}</legend><div className="grid gap-2 sm:grid-cols-2">
    {CATEGORIES.map((category) => <label key={category} className="flex items-center gap-2 text-[11px] text-slate-700"><input type="checkbox" checked={value.includes(category)} onChange={(event) => onChange(event.target.checked ? [...value, category] : value.filter((item) => item !== category))} />{category.replaceAll("_", " ")}</label>)}
  </div></fieldset>;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "OVERVIEW", label: "Overview" },
  { id: "RETENTION", label: "Retention & Holds" },
  { id: "ERASURE", label: "Erasure Governance" },
  { id: "TRANSFERS", label: "Export & Migration" },
  { id: "TARGETS", label: "External Targets" },
  { id: "BACKUP", label: "Backup Evidence" },
];

export default function SaasDataProtectionWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && !!activeFactoryId;
  const canReadRetention = hasPermission("saas.data_retention.read");
  const canWriteRetention = hasPermission("saas.data_retention.write");
  const canApproveRetention = hasPermission("saas.data_retention.approve");
  const canExecuteRetention = hasPermission("saas.data_retention.execute");
  const canPropagate = hasPermission("saas.data_retention.propagate");
  const canReviewFinance = hasPermission("saas.data_retention.finance_review");
  const canExecuteFinance = hasPermission("saas.data_retention.finance_execute");
  const canReadTransfers = hasPermission("saas.data_transfers.read");
  const canWriteTransfers = hasPermission("saas.data_transfers.write");
  const canExecuteTransfers = hasPermission("saas.data_transfers.execute");

  const [tab, setTab] = useState<Tab>("OVERVIEW");
  const [refreshTick, setRefreshTick] = useState(0);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [data, setData] = useState<WorkspaceData>({});
  const [latestResponse, setLatestResponse] = useState<{ factoryId: string; data: unknown } | null>(null);

  const [policyCategory, setPolicyCategory] = useState("BUSINESS_DATA");
  const [policyDays, setPolicyDays] = useState("365");
  const [policyDisposition, setPolicyDisposition] = useState("REVIEW");
  const [policyBasis, setPolicyBasis] = useState("");
  const [policyReason, setPolicyReason] = useState("");
  const [selectedPolicy, setSelectedPolicy] = useState<Row | null>(null);
  const [policyRunMode, setPolicyRunMode] = useState("DRY_RUN");
  const [policyRunReason, setPolicyRunReason] = useState("");
  const [policyExecuteConfirmed, setPolicyExecuteConfirmed] = useState(false);

  const [holdCategories, setHoldCategories] = useState<string[]>(["AUDIT_LOG"]);
  const [holdCase, setHoldCase] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [selectedHold, setSelectedHold] = useState<Row | null>(null);
  const [holdReleaseReason, setHoldReleaseReason] = useState("");

  const [erasureCategories, setErasureCategories] = useState<string[]>(["BUSINESS_DATA"]);
  const [erasureExportId, setErasureExportId] = useState("");
  const [erasureExportVersion, setErasureExportVersion] = useState("1");
  const [erasureDigest, setErasureDigest] = useState("");
  const [erasureReason, setErasureReason] = useState("");
  const [selectedErasure, setSelectedErasure] = useState<Row | null>(null);
  const [erasureDecision, setErasureDecision] = useState("APPROVE");
  const [erasureActionReason, setErasureActionReason] = useState("");
  const [erasureActionConfirmed, setErasureActionConfirmed] = useState(false);
  const [erasureRunRows, setErasureRunRows] = useState<{ factoryId: string; data: unknown } | null>(null);

  const [exportSchema, setExportSchema] = useState("2.1.0");
  const [exportCategories, setExportCategories] = useState<string[]>(["BUSINESS_DATA", "AUDIT_LOG", "EVIDENCE", "APPROVALS", "EFFECTIVE_DATED_MASTER_DATA", "IAM_ACCESS"]);
  const [exportReason, setExportReason] = useState("");
  const [migrationSourceId, setMigrationSourceId] = useState("");
  const [migrationSchema, setMigrationSchema] = useState("2.1.0");
  const [migrationReason, setMigrationReason] = useState("");
  const [selectedTransfer, setSelectedTransfer] = useState<Row | null>(null);
  const [transferHistory, setTransferHistory] = useState<{ factoryId: string; data: unknown } | null>(null);
  const [migrationAction, setMigrationAction] = useState("START");
  const [migrationActionReason, setMigrationActionReason] = useState("");
  const [migrationBundleReference, setMigrationBundleReference] = useState("");
  const [migrationBundleDigest, setMigrationBundleDigest] = useState("");
  const [migrationManifest, setMigrationManifest] = useState("{}");
  const [migrationPreservationVerified, setMigrationPreservationVerified] = useState(false);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);

  const [targetId, setTargetId] = useState("");
  const [targetStoreKind, setTargetStoreKind] = useState("OBJECT_STORAGE");
  const [targetAdapter, setTargetAdapter] = useState("");
  const [targetConfigReference, setTargetConfigReference] = useState("");
  const [targetCategories, setTargetCategories] = useState<string[]>(["EVIDENCE"]);
  const [targetReason, setTargetReason] = useState("");
  const [selectedTarget, setSelectedTarget] = useState<Row | null>(null);
  const [targetDecision, setTargetDecision] = useState("APPROVE");
  const [targetReviewReason, setTargetReviewReason] = useState("");

  const [financeDays, setFinanceDays] = useState("2555");
  const [financeBasis, setFinanceBasis] = useState("");
  const [financeAdapter, setFinanceAdapter] = useState("");
  const [financeReason, setFinanceReason] = useState("");
  const [selectedFinance, setSelectedFinance] = useState<Row | null>(null);
  const [financeDecision, setFinanceDecision] = useState("APPROVE");
  const [financeActionReason, setFinanceActionReason] = useState("");
  const [financeRunMode, setFinanceRunMode] = useState("DRY_RUN");
  const [financeRunConfirmed, setFinanceRunConfirmed] = useState(false);

  const [backupCategory, setBackupCategory] = useState("BUSINESS_DATA");
  const [backupEvidence, setBackupEvidence] = useState<Record<string, unknown>>({});
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupError, setBackupError] = useState("");

  const api = (): SaasDataProtectionClient => createSaasDataProtectionClient((path, options = {}) => request(path, options));

  const visibleData = loadedFactoryId === activeFactoryId ? data : {};
  const currentLatestResponse = latestResponse?.factoryId === activeFactoryId ? latestResponse.data : null;
  const currentTransferHistory = transferHistory?.factoryId === activeFactoryId ? transferHistory.data : null;
  const currentErasureRunRows = erasureRunRows?.factoryId === activeFactoryId ? erasureRunRows.data : null;
  const currentBackupEvidence = backupEvidence.__factoryId === activeFactoryId ? backupEvidence : {};
  const policies = canReadRetention ? list(visibleData.policies) : [];
  const holds = canReadRetention ? list(visibleData.holds) : [];
  const erasures = canReadRetention ? list(visibleData.erasures) : [];
  const retentionRuns = canReadRetention ? list(visibleData.retentionRuns) : [];
  const targets = canReadRetention ? list(visibleData.targets) : [];
  const exports = canReadTransfers ? list(visibleData.exports) : [];
  const migrations = canReadTransfers ? list(visibleData.migrations) : [];
  const compatibility = canReadTransfers ? list(visibleData.compatibility) : [];
  const financePolicies = canReadRetention ? list(visibleData.financePolicies) : [];
  const financeRuns = canReadRetention ? list(visibleData.financeRuns) : [];
  const factoryName = snapshot?.factories.find((factory) => factory.id === activeFactoryId)?.name ?? activeFactoryId;
  const unresolvedErasureCount = erasures.filter((item) => !["COMPLETED", "REJECTED", "CANCELLED"].includes(valueOf(item.status).toUpperCase())).length;
  const activeHoldCount = holds.filter((item) => !["RELEASED", "CLOSED"].includes(valueOf(item.status).toUpperCase())).length;
  const pendingTargetCount = targets.filter((item) => ["PENDING", "REVIEW"].includes(valueOf(item.status).toUpperCase())).length;
  const selectedPolicyInScope = selectedPolicy?.__factoryId === activeFactoryId ? selectedPolicy : null;
  const selectedHoldInScope = selectedHold?.__factoryId === activeFactoryId ? selectedHold : null;
  const selectedErasureInScope = selectedErasure?.__factoryId === activeFactoryId ? selectedErasure : null;
  const selectedTransferInScope = selectedTransfer?.__factoryId === activeFactoryId ? selectedTransfer : null;
  const selectedTargetInScope = selectedTarget?.__factoryId === activeFactoryId ? selectedTarget : null;
  const selectedFinanceInScope = selectedFinance?.__factoryId === activeFactoryId ? selectedFinance : null;

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      if (!connected) {
        setLoading(false);
        setLoadedFactoryId("");
        setData({});
        return;
      }
      setLoading(true);
      const client = createSaasDataProtectionClient((path, options = {}) => request(path, options));
      const tasks: Array<{ key: string; enabled: boolean; run: () => Promise<unknown> }> = [
        { key: "policies", enabled: canReadRetention, run: () => client.listPolicies() },
        { key: "holds", enabled: canReadRetention, run: () => client.listLegalHolds(undefined, 200) },
        { key: "erasures", enabled: canReadRetention, run: () => client.listErasureRequests(undefined, 200) },
        { key: "retentionRuns", enabled: canReadRetention, run: () => client.listRetentionRuns({ limit: 200 }) },
        { key: "targets", enabled: canReadRetention, run: () => client.listExternalTargets() },
        { key: "financePolicies", enabled: canReadRetention, run: () => client.listFinancePolicies() },
        { key: "financeRuns", enabled: canReadRetention, run: () => client.listFinanceRuns(100) },
        { key: "exports", enabled: canReadTransfers, run: () => client.listTransfers("EXPORT") },
        { key: "migrations", enabled: canReadTransfers, run: () => client.listTransfers("MIGRATION") },
        { key: "compatibility", enabled: canReadTransfers, run: () => client.listCompatibilityRules() },
      ];
      const results = await Promise.all(tasks.filter((task) => task.enabled).map(async (task) => {
        try { return { key: task.key, value: await task.run(), error: "" }; }
        catch (cause) { return { key: task.key, value: [], error: errorOf(cause) }; }
      }));
      if (!cancelled) {
        const next: WorkspaceData = {};
        const errors: Record<string, string> = {};
        for (const result of results) {
          next[result.key] = list(result.value);
          if (result.error) errors[result.key] = result.error;
        }
        setData(next);
        setLoadErrors(errors);
        setLoadedFactoryId(activeFactoryId);
        setLoading(false);
      }
    }
    void loadWorkspace();
    return () => { cancelled = true; };
  }, [
    connected, activeFactoryId, request, refreshTick, canReadRetention, canReadTransfers,
  ]);

  const categoryOptions = useMemo(() => CATEGORIES, []);

  async function perform(label: string, work: () => Promise<unknown>, refresh = true) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await work();
      setLatestResponse({ factoryId: activeFactoryId, data: result });
      setNotice({ tone: "success", message: label + " completed. The server response is recorded below." });
      if (refresh) setRefreshTick((value) => value + 1);
    } catch (cause) {
      setNotice({ tone: "error", message: errorOf(cause) });
    } finally {
      setBusy(false);
    }
  }
  async function loadBackupEvidence() {
    if (!connected || !canReadRetention) return;
    setBackupLoading(true);
    setBackupError("");
    const client = api();
    const requests = [
      ["providerLatest", () => client.latestBackupProviderAcceptance(backupCategory)],
      ["providerCurrent", () => client.currentBackupProviderAcceptance(backupCategory)],
      ["writerLatest", () => client.latestBackupWriterInventory(backupCategory)],
      ["writerCurrent", () => client.currentBackupWriterInventory(backupCategory)],
      ["copyClassCoverage", () => client.currentBackupCopyClassCoverage(backupCategory)],
      ["externalCopyCoverage", () => client.currentExternalCopyCoverage(backupCategory)],
    ] as const;
    const results = await Promise.all(requests.map(async ([key, run]) => {
      try { return [key, await run(), ""] as const; }
      catch (cause) { return [key, null, errorOf(cause)] as const; }
    }));
    const next: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const [key, value, error] of results) {
      next[key] = value;
      if (error) errors.push(key + ": " + error);
    }
    setBackupEvidence({ ...next, __factoryId: activeFactoryId });
    setBackupError(errors.join(" · "));
    setBackupLoading(false);
  }

  function submit(event: FormEvent<HTMLFormElement>, label: string, work: () => Promise<unknown>) {
    event.preventDefault();
    void perform(label, work);
  }

  if (!connected) {
    return <main className="mx-auto w-full max-w-7xl space-y-5 px-4 py-8 sm:px-6 lg:px-8">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-[10px] font-bold uppercase tracking-widest text-blue-700">SaaS governance</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950">Data Protection & Lifecycle</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Connect an authenticated FactoryOS session and select an active factory to inspect tenant retention, legal holds, erasure, transfer and backup evidence.</p>
        <Link href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white">Connect session</Link>
      </div>
    </main>;
  }

  return <main className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-slate-950 px-5 py-6 text-white sm:px-7">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">Tenant governance · {factoryName}</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Data Protection & Lifecycle</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">Retention schedules, legal holds, export-backed erasure, external data propagation, tenant portability and provider backup evidence.</p>
          </div>
          <button type="button" onClick={() => setRefreshTick((value) => value + 1)} disabled={loading} className="inline-flex min-h-9 items-center rounded-lg border border-white/20 px-3 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh workspace"}</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        {TABS.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} className={"min-h-9 rounded-lg px-3 text-xs font-semibold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
      </div>
    </section>

    {notice ? <div role="status" className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-amber-900")}>{notice.message}</div> : null}
    {Object.keys(loadErrors).length ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950"><strong>Some sections could not be loaded.</strong> {Object.entries(loadErrors).map(([key, value]) => key + ": " + value).join(" · ")}</div> : null}
    {loading ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">Loading tenant lifecycle records…</div> : null}

    {tab === "OVERVIEW" ? <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Retention policies" value={policies.length} hint="Rows returned by the API" />
        <Metric label="Active legal holds" value={activeHoldCount} hint="Not released or closed" />
        <Metric label="Open erasure requests" value={unresolvedErasureCount} hint="Not completed, rejected or cancelled" />
        <Metric label="External targets pending" value={pendingTargetCount} hint="Waiting for review" />
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title="Retention & legal hold posture" subtitle="Current server-returned records. Counts are bounded response rows, not tenant-wide totals.">
          {!canReadRetention ? <Empty>Missing permission: saas.data_retention.read.</Empty> : <div className="space-y-3">
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Retention policy records</span><strong>{policies.length}</strong></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Retention execution records</span><strong>{retentionRuns.length}</strong></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Finance retention policies</span><strong>{financePolicies.length}</strong></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Finance retention runs</span><strong>{financeRuns.length}</strong></div>
          </div>}
        </Panel>
        <Panel title="Tenant portability" subtitle="Export and migration operations remain separate from erasure approval and execution.">
          {!canReadTransfers ? <Empty>Missing permission: saas.data_transfers.read.</Empty> : <div className="space-y-3">
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Export records</span><strong>{exports.length}</strong></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Migration records</span><strong>{migrations.length}</strong></div>
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="text-slate-500">Compatibility rules</span><strong>{compatibility.length}</strong></div>
          </div>}
        </Panel>
      </section>
      <Panel title="Recent lifecycle activity" subtitle="Latest retention and finance executions returned by the API.">
        {retentionRuns.length || financeRuns.length ? <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="pb-2 pr-3">Operation</th><th className="pb-2 pr-3">Category / version</th><th className="pb-2 pr-3">Mode</th><th className="pb-2 pr-3">Status</th><th className="pb-2">Created</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{[...retentionRuns.slice(0, 12).map((item) => ({ ...item, _source: "RETENTION" })), ...financeRuns.slice(0, 8).map((item) => ({ ...item, _source: "FINANCE" }))].slice(0, 16).map((item, index) => <tr key={valueOf(item.id, String(index))}><td className="py-3 pr-3 font-semibold text-slate-800">{valueOf(item._source)}</td><td className="py-3 pr-3">{valueOf(item.categoryCode ?? item.category_code ?? item.version)}</td><td className="py-3 pr-3">{valueOf(item.mode)}</td><td className="py-3 pr-3"><Status value={item.status} /></td><td className="py-3">{dateOf(item.createdAt ?? item.created_at ?? item.startedAt)}</td></tr>)}</tbody>
        </table></div> : <Empty>No retention executions returned yet.</Empty>}
      </Panel>
    </> : null}

    {tab === "RETENTION" ? <div className="space-y-4">
      <Panel title="Create immutable retention policy" subtitle="Policy versions are append-only. Choose a dataset category, duration, disposition and legal basis; the API validates the policy and tenant scope.">
        {!canWriteRetention ? <Empty>Missing permission: saas.data_retention.write.</Empty> : <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => submit(event, "Retention policy creation", () => api().createPolicy(buildRetentionPolicyPayload({
          category_code: policyCategory, retention_days: policyDays, disposition: policyDisposition,
          legal_basis: policyBasis, reason: policyReason, idempotency_key: idempotencyKey("retention"),
        })))}>
          <Field label="Dataset category"><Select value={policyCategory} onChange={setPolicyCategory} options={categoryOptions} /></Field>
          <Field label="Retention days"><input className={INPUT} type="number" min="1" max="36500" value={policyDays} onChange={(event) => setPolicyDays(event.target.value)} required /></Field>
          <Field label="Disposition"><Select value={policyDisposition} onChange={setPolicyDisposition} options={["DELETE", "ANONYMIZE", "REVIEW"]} /></Field>
          <Field label="Legal basis"><input className={INPUT} value={policyBasis} onChange={(event) => setPolicyBasis(event.target.value)} minLength={3} maxLength={200} required placeholder="Regulatory / contractual basis" /></Field>
          <Field label="Change reason"><input className={INPUT} value={policyReason} onChange={(event) => setPolicyReason(event.target.value)} minLength={3} maxLength={1000} required /></Field>
          <div className="flex items-end"><button className={PRIMARY} disabled={busy}>Create policy version</button></div>
        </form>}
      </Panel>
      <Panel title="Retention policies" subtitle="Run a DRY_RUN first. EXECUTE is a destructive lifecycle action and requires execute permission plus explicit confirmation.">
        {policies.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="pb-2 pr-3">Category</th><th className="pb-2 pr-3">Retention</th><th className="pb-2 pr-3">Disposition</th><th className="pb-2 pr-3">Version</th><th className="pb-2 pr-3">Status</th><th className="pb-2">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{policies.map((item, index) => <tr key={valueOf(item.id, String(index))}><td className="py-3 pr-3 font-semibold">{valueOf(item.categoryCode ?? item.category_code)}</td><td className="py-3 pr-3">{valueOf(item.retentionDays ?? item.retention_days)} days</td><td className="py-3 pr-3">{valueOf(item.disposition)}</td><td className="py-3 pr-3">{valueOf(item.version)}</td><td className="py-3 pr-3"><Status value={item.status ?? "VERSIONED"} /></td><td className="py-3"><button type="button" className={SECONDARY} onClick={() => { setSelectedPolicy({ ...item, __factoryId: activeFactoryId }); setPolicyRunReason(""); setPolicyRunMode("DRY_RUN"); setPolicyExecuteConfirmed(false); }}>Run policy…</button></td></tr>)}</tbody></table></div> : <Empty>No retention policy versions returned.</Empty>}
        {selectedPolicyInScope ? <form className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2" onSubmit={(event) => submit(event, "Retention policy run", () => api().runPolicy(valueOf(selectedPolicyInScope.categoryCode ?? selectedPolicyInScope.category_code), buildRetentionRunPayload({
          mode: policyRunMode, expected_policy_version: selectedPolicyInScope.version, reason: policyRunReason,
          idempotency_key: idempotencyKey("retention-run"),
        })))}>
          <div className="sm:col-span-2"><p className="text-xs font-bold text-slate-900">Selected: {valueOf(selectedPolicyInScope.categoryCode ?? selectedPolicyInScope.category_code)} · version {valueOf(selectedPolicyInScope.version)}</p></div>
          <Field label="Run mode"><Select value={policyRunMode} onChange={setPolicyRunMode} options={["DRY_RUN", "EXECUTE"]} /></Field>
          <Field label="Reason"><input className={INPUT} value={policyRunReason} onChange={(event) => setPolicyRunReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>
          {policyRunMode === "EXECUTE" ? <label className="flex items-start gap-2 text-xs leading-5 text-rose-800 sm:col-span-2"><input type="checkbox" checked={policyExecuteConfirmed} onChange={(event) => setPolicyExecuteConfirmed(event.target.checked)} />I understand EXECUTE may delete or anonymize eligible tenant data according to this policy.</label> : null}
          <div className="flex flex-wrap gap-2 sm:col-span-2"><button className={policyRunMode === "EXECUTE" ? DANGER : PRIMARY} disabled={busy || !canExecuteRetention || (policyRunMode === "EXECUTE" && !policyExecuteConfirmed)}>{policyRunMode === "EXECUTE" ? "Execute retention policy" : "Run dry-run"}</button><button type="button" className={SECONDARY} onClick={() => setSelectedPolicy(null)}>Cancel</button>{!canExecuteRetention ? <span className="self-center text-[10px] text-slate-500">EXECUTE requires saas.data_retention.execute.</span> : null}</div>
        </form> : null}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Create legal hold" subtitle="A hold blocks affected data from routine retention processing until released through the approval route.">
          {!canWriteRetention ? <Empty>Missing permission: saas.data_retention.write.</Empty> : <form className="space-y-3" onSubmit={(event) => submit(event, "Legal hold creation", () => api().createLegalHold(buildLegalHoldPayload({
            categories: holdCategories, case_reference: holdCase, reason: holdReason, idempotency_key: idempotencyKey("legal-hold"),
          })))}>
            <MultiCategories value={holdCategories} onChange={setHoldCategories} label="Held dataset categories" />
            <Field label="Case reference"><input className={INPUT} value={holdCase} onChange={(event) => setHoldCase(event.target.value)} required maxLength={200} /></Field>
            <Field label="Legal hold reason"><textarea className={AREA} value={holdReason} onChange={(event) => setHoldReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>
            <button className={PRIMARY} disabled={busy}>Create legal hold</button>
          </form>}
        </Panel>
        <Panel title="Legal holds" subtitle="Release is a controlled approval action with optimistic version checking.">
          {holds.length ? <div className="space-y-2">{holds.map((item, index) => <div key={valueOf(item.id, String(index))} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{valueOf(item.caseReference ?? item.case_reference ?? item.id)}</strong><Status value={item.status} /></div><p className="mt-1 text-[10px] text-slate-500">{valueOf(item.categories)} · version {valueOf(item.version)}</p>{canApproveRetention && !["RELEASED", "CLOSED"].includes(valueOf(item.status).toUpperCase()) ? <button type="button" className={SECONDARY + " mt-2"} onClick={() => { setSelectedHold({ ...item, __factoryId: activeFactoryId }); setHoldReleaseReason(""); }}>Prepare release…</button> : null}</div>)}</div> : <Empty>No legal holds returned.</Empty>}
          {selectedHoldInScope ? <form className="mt-3 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3" onSubmit={(event) => submit(event, "Legal hold release", () => api().releaseLegalHold(valueOf(selectedHoldInScope.id), buildLegalHoldReleasePayload({ expected_version: selectedHoldInScope.version, reason: holdReleaseReason })))}>
            <p className="text-xs font-semibold text-amber-950">Release {valueOf(selectedHoldInScope.caseReference ?? selectedHoldInScope.case_reference)}?</p>
            <Field label="Release reason"><textarea className={AREA} value={holdReleaseReason} onChange={(event) => setHoldReleaseReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>
            <div className="flex gap-2"><button className={DANGER} disabled={busy}>Release hold</button><button type="button" className={SECONDARY} onClick={() => setSelectedHold(null)}>Cancel</button></div>
          </form> : null}
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Finance retention policy" subtitle="Finance retention has separate maker-checker and execute permissions; adapter health is still decided by the backend.">
          {!canWriteRetention ? <Empty>Missing permission: saas.data_retention.write.</Empty> : <form className="grid gap-3" onSubmit={(event) => submit(event, "Finance retention policy creation", () => api().createFinancePolicy(buildFinanceRetentionPayload({
            retention_days: financeDays, legal_basis: financeBasis, finance_adapter_key: financeAdapter,
            reason: financeReason, idempotency_key: idempotencyKey("finance-retention"),
          })))}>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Retention days"><input className={INPUT} type="number" min="1" max="36500" value={financeDays} onChange={(event) => setFinanceDays(event.target.value)} required /></Field><Field label="Finance adapter key"><input className={INPUT} value={financeAdapter} onChange={(event) => setFinanceAdapter(event.target.value)} required /></Field></div>
            <Field label="Legal basis"><input className={INPUT} value={financeBasis} onChange={(event) => setFinanceBasis(event.target.value)} required minLength={3} maxLength={200} /></Field>
            <Field label="Reason"><textarea className={AREA} value={financeReason} onChange={(event) => setFinanceReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>
            <button className={PRIMARY} disabled={busy}>Create finance policy</button>
          </form>}
        </Panel>
        <Panel title="Finance retention versions" subtitle="Review and run by immutable version. Finance-specific permissions are required in addition to ordinary read access.">
          {financePolicies.length ? <div className="space-y-2">{financePolicies.map((item, index) => <div key={valueOf(item.id, String(index))} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">Version {valueOf(item.version)}</strong><Status value={item.status} /></div><p className="mt-1 text-[10px] text-slate-500">{valueOf(item.financeAdapterKey ?? item.finance_adapter_key)} · {valueOf(item.retentionDays ?? item.retention_days)} days</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={SECONDARY} disabled={!canReviewFinance || busy} onClick={() => { setSelectedFinance({ ...item, __factoryId: activeFactoryId }); setFinanceDecision("APPROVE"); setFinanceActionReason(""); }}>Review…</button><button type="button" className={SECONDARY} disabled={!canExecuteFinance || busy} onClick={() => { setSelectedFinance({ ...item, __factoryId: activeFactoryId }); setFinanceRunMode("DRY_RUN"); setFinanceActionReason(""); setFinanceRunConfirmed(false); }}>Run…</button></div></div>)}</div> : <Empty>No finance retention versions returned.</Empty>}
          {selectedFinanceInScope ? <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold">Selected version {valueOf(selectedFinanceInScope.version)}</p>
            <form className="space-y-2" onSubmit={(event) => submit(event, "Finance retention review", () => api().reviewFinancePolicy(Number(selectedFinanceInScope.version), buildFinanceRetentionReviewPayload({ decision: financeDecision, expected_version: selectedFinanceInScope.version, reason: financeActionReason })))}>
              <div className="grid gap-2 sm:grid-cols-2"><Field label="Decision"><Select value={financeDecision} onChange={setFinanceDecision} options={["APPROVE", "REJECT"]} /></Field><Field label="Review reason"><input className={INPUT} value={financeActionReason} onChange={(event) => setFinanceActionReason(event.target.value)} required minLength={3} /></Field></div>
              <button className={SECONDARY} disabled={busy || !canReviewFinance}>Submit review</button>
            </form>
            <form className="space-y-2 border-t border-slate-200 pt-3" onSubmit={(event) => submit(event, "Finance retention run", () => api().runFinancePolicy(Number(selectedFinanceInScope.version), buildFinanceRetentionRunPayload({ mode: financeRunMode, expected_policy_version: selectedFinanceInScope.version, reason: financeActionReason, idempotency_key: idempotencyKey("finance-run") })))}>
              <div className="grid gap-2 sm:grid-cols-2"><Field label="Run mode"><Select value={financeRunMode} onChange={setFinanceRunMode} options={["DRY_RUN", "EXECUTE"]} /></Field><Field label="Run reason"><input className={INPUT} value={financeActionReason} onChange={(event) => setFinanceActionReason(event.target.value)} required minLength={3} /></Field></div>
              {financeRunMode === "EXECUTE" ? <label className="flex gap-2 text-[10px] leading-4 text-rose-800"><input type="checkbox" checked={financeRunConfirmed} onChange={(event) => setFinanceRunConfirmed(event.target.checked)} />I explicitly authorize execution for this reviewed finance policy version.</label> : null}
              <button className={financeRunMode === "EXECUTE" ? DANGER : SECONDARY} disabled={busy || !canExecuteFinance || (financeRunMode === "EXECUTE" && !financeRunConfirmed)}>Run finance retention</button>
            </form>
            <button type="button" className={SECONDARY} onClick={() => setSelectedFinance(null)}>Close</button>
          </div> : null}
        </Panel>
      </div>
    </div> : null}

    {tab === "ERASURE" ? <div className="space-y-4">
      <Panel title="Create export-backed erasure request" subtitle="The request must reference a completed export transfer, its exact version and a verified SHA-256 bundle digest. Review, execution and propagation are separate permission-gated steps.">
        {!canWriteRetention ? <Empty>Missing permission: saas.data_retention.write.</Empty> : <form className="space-y-3" onSubmit={(event) => submit(event, "Tenant erasure request creation", () => api().createErasureRequest(buildTenantErasurePayload({
          categories: erasureCategories, export_transfer_id: erasureExportId, export_transfer_version: erasureExportVersion,
          export_bundle_digest: erasureDigest, reason: erasureReason, idempotency_key: idempotencyKey("erasure"),
        })))}>
          <MultiCategories value={erasureCategories} onChange={setErasureCategories} label="Erasure categories" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Export transfer UUID"><input className={INPUT} value={erasureExportId} onChange={(event) => setErasureExportId(event.target.value)} required placeholder="Completed export UUID" /></Field>
            <Field label="Export version"><input className={INPUT} type="number" min="1" value={erasureExportVersion} onChange={(event) => setErasureExportVersion(event.target.value)} required /></Field>
            <Field label="Export bundle SHA-256"><input className={INPUT} value={erasureDigest} onChange={(event) => setErasureDigest(event.target.value)} required minLength={64} maxLength={64} /></Field>
          </div>
          <Field label="Erasure request reason"><textarea className={AREA} value={erasureReason} onChange={(event) => setErasureReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>
          <button className={PRIMARY} disabled={busy}>Create erasure request</button>
        </form>}
      </Panel>
      <Panel title="Erasure request register" subtitle="Select a request to inspect its current version and prepare review, execution or downstream propagation.">
        {erasures.length ? <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-xs"><thead className="text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="pb-2 pr-3">Request</th><th className="pb-2 pr-3">Categories</th><th className="pb-2 pr-3">Version</th><th className="pb-2 pr-3">Status</th><th className="pb-2 pr-3">Created</th><th className="pb-2">Detail</th></tr></thead><tbody className="divide-y divide-slate-100">{erasures.map((item, index) => <tr key={valueOf(item.id, String(index))}><td className="max-w-52 truncate py-3 pr-3 font-mono text-[10px]">{valueOf(item.id)}</td><td className="py-3 pr-3">{valueOf(item.categories)}</td><td className="py-3 pr-3">{valueOf(item.version)}</td><td className="py-3 pr-3"><Status value={item.status} /></td><td className="py-3 pr-3">{dateOf(item.createdAt ?? item.created_at)}</td><td className="py-3"><button type="button" className={SECONDARY} onClick={() => { setSelectedErasure({ ...item, __factoryId: activeFactoryId }); setErasureActionReason(""); setErasureActionConfirmed(false); setErasureRunRows(null); }}>Select</button></td></tr>)}</tbody></table></div> : <Empty>No erasure requests returned.</Empty>}
        {selectedErasureInScope ? <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">Request {valueOf(selectedErasureInScope.id)}</strong><Status value={selectedErasureInScope.status} /></div>
          <p className="text-[10px] text-slate-500">Expected version {valueOf(selectedErasureInScope.version)} · Export {valueOf(selectedErasureInScope.exportTransferId ?? selectedErasureInScope.export_transfer_id)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <form className="space-y-2 rounded-lg border border-slate-200 bg-white p-3" onSubmit={(event) => submit(event, "Erasure review", () => api().reviewErasureRequest(valueOf(selectedErasureInScope.id), buildErasureReviewPayload({ decision: erasureDecision, expected_version: selectedErasureInScope.version, reason: erasureActionReason })))}>
              <p className="text-xs font-bold">Maker-checker review</p>
              <Field label="Decision"><Select value={erasureDecision} onChange={setErasureDecision} options={["APPROVE", "REJECT"]} /></Field>
              <Field label="Review reason"><textarea className={AREA} value={erasureActionReason} onChange={(event) => setErasureActionReason(event.target.value)} required minLength={3} /></Field>
              <button className={SECONDARY} disabled={busy || !canApproveRetention}>Submit review</button>
            </form>
            <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs font-bold">Execution & propagation</p>
              <Field label="Action reason"><textarea className={AREA} value={erasureActionReason} onChange={(event) => setErasureActionReason(event.target.value)} required minLength={3} /></Field>
              <label className="flex gap-2 text-[10px] leading-4 text-rose-800"><input type="checkbox" checked={erasureActionConfirmed} onChange={(event) => setErasureActionConfirmed(event.target.checked)} />I have checked the approved request, legal holds and required external targets before taking the next step.</label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={DANGER} disabled={busy || !canExecuteRetention || !erasureActionConfirmed} onClick={() => void perform("Erasure execution", () => api().executeErasure(valueOf(selectedErasureInScope.id), buildErasureExecutionPayload({ expected_version: selectedErasureInScope.version, reason: erasureActionReason, idempotency_key: idempotencyKey("erasure-execute") })))}>Execute erasure</button>
                <button type="button" className={DANGER} disabled={busy || !canPropagate || !erasureActionConfirmed} onClick={() => void perform("Erasure propagation", () => api().propagateErasure(valueOf(selectedErasureInScope.id), buildErasurePropagationPayload({ expected_version: selectedErasureInScope.version, reason: erasureActionReason, idempotency_key: idempotencyKey("erasure-propagate") })))}>Propagate externally</button>
              </div>
              <div className="flex flex-wrap gap-2 pt-1"><button type="button" className={SECONDARY} disabled={busy || !canReadRetention} onClick={() => void perform("Erasure execution history", async () => { const value = await api().listErasureRuns(valueOf(selectedErasureInScope.id)); setErasureRunRows({ factoryId: activeFactoryId, data: value }); return value; }, false)}>Load execution history</button><button type="button" className={SECONDARY} disabled={busy || !canReadRetention} onClick={() => void perform("Erasure propagation history", async () => { const value = await api().listPropagationRuns(valueOf(selectedErasureInScope.id)); setErasureRunRows(value); return value; }, false)}>Load propagation history</button></div>
              {!canApproveRetention ? <p className="text-[10px] text-slate-500">Review requires saas.data_retention.approve.</p> : null}
              {!canExecuteRetention ? <p className="text-[10px] text-slate-500">Execution requires saas.data_retention.execute.</p> : null}
              {!canPropagate ? <p className="text-[10px] text-slate-500">Propagation requires saas.data_retention.propagate.</p> : null}
            </div>
          </div>
          {currentErasureRunRows !== null ? <JsonPanel title="Erasure history response" data={currentErasureRunRows} /> : null}
        </div> : null}
      </Panel>
    </div> : null}

    {tab === "TRANSFERS" ? <div className="space-y-4">
      <Panel title="Create tenant export" subtitle="Export creation records an immutable operation request. Processing is a separate execute-permission action; no export bundle is claimed until the API returns it.">
        {!canWriteTransfers ? <Empty>Missing permission: saas.data_transfers.write.</Empty> : <form className="space-y-3" onSubmit={(event) => submit(event, "Tenant export creation", () => api().createExport(buildTenantExportPayload({
          source_schema_version: exportSchema, dataset_categories: exportCategories, reason: exportReason,
          idempotency_key: idempotencyKey("tenant-export"),
        })))}>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Source schema version"><input className={INPUT} value={exportSchema} onChange={(event) => setExportSchema(event.target.value)} required pattern="^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$" /></Field><Field label="Purpose / reason"><input className={INPUT} value={exportReason} onChange={(event) => setExportReason(event.target.value)} required minLength={3} maxLength={1000} /></Field></div>
          <MultiCategories value={exportCategories} onChange={setExportCategories} label="Dataset categories (optional subset)" />
          <button className={PRIMARY} disabled={busy}>Create export operation</button>
        </form>}
      </Panel>
      <Panel title="Tenant export operations" subtitle="Only process an export after its request is reviewed under the applicable operational controls.">
        {exports.length ? <div className="space-y-2">{exports.map((item, index) => <div key={valueOf(item.id, String(index))} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{valueOf(item.id)}</strong><Status value={item.status} /></div><p className="mt-1 text-[10px] text-slate-500">Version {valueOf(item.version)} · schema {valueOf(item.sourceSchemaVersion ?? item.source_schema_version)} · {dateOf(item.createdAt ?? item.created_at)}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={SECONDARY} disabled={!canReadTransfers || busy} onClick={() => { setSelectedTransfer({ ...item, __factoryId: activeFactoryId }); void perform("Transfer history", async () => { const value = await api().listTransferHistory(valueOf(item.id)); setTransferHistory({ factoryId: activeFactoryId, data: value }); return value; }, false); }}>History</button><button type="button" className={PRIMARY} disabled={!canExecuteTransfers || busy} onClick={() => void perform("Export processing", () => api().processExport(valueOf(item.id)))}>Process export</button></div></div>)}</div> : <Empty>No tenant export operations returned.</Empty>}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Validate tenant migration" subtitle="Validation references an existing source transfer and a target semantic schema version.">
          {!canWriteTransfers ? <Empty>Missing permission: saas.data_transfers.write.</Empty> : <form className="space-y-3" onSubmit={(event) => submit(event, "Tenant migration validation", () => api().validateMigration(buildMigrationValidationPayload({
            source_transfer_id: migrationSourceId, target_schema_version: migrationSchema, reason: migrationReason,
            idempotency_key: idempotencyKey("tenant-migration"),
          })))}>
            <Field label="Source transfer UUID"><input className={INPUT} value={migrationSourceId} onChange={(event) => setMigrationSourceId(event.target.value)} required /></Field>
            <Field label="Target schema version"><input className={INPUT} value={migrationSchema} onChange={(event) => setMigrationSchema(event.target.value)} required pattern="^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$" /></Field>
            <Field label="Validation reason"><textarea className={AREA} value={migrationReason} onChange={(event) => setMigrationReason(event.target.value)} required minLength={3} /></Field>
            <button className={PRIMARY} disabled={busy}>Validate migration</button>
          </form>}
        </Panel>
        <Panel title="Schema compatibility" subtitle="Published compatibility rules are shown as read-only decision evidence.">
          {compatibility.length ? <div className="space-y-2">{compatibility.map((item, index) => <div key={valueOf(item.id, String(index))} className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{valueOf(item.sourceSchemaVersion ?? item.source_schema_version)} → {valueOf(item.targetSchemaVersion ?? item.target_schema_version)}</strong><Status value={item.decision} /></div><p className="mt-1 text-[10px] text-slate-500">{valueOf(item.requiredCategories ?? item.required_categories)}</p></div>)}</div> : <Empty>No compatibility rules returned.</Empty>}
        </Panel>
      </div>
      <Panel title="Migration operations" subtitle="Each transition is optimistic-version checked. COMPLETE requires a target bundle and explicit preservation verification.">
        {migrations.length ? <div className="space-y-2">{migrations.map((item, index) => <div key={valueOf(item.id, String(index))} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{valueOf(item.id)}</strong><Status value={item.status} /></div><p className="mt-1 text-[10px] text-slate-500">Version {valueOf(item.version)} · {valueOf(item.sourceSchemaVersion ?? item.source_schema_version)} → {valueOf(item.targetSchemaVersion ?? item.target_schema_version)}</p><button type="button" className={SECONDARY + " mt-2"} onClick={() => { setSelectedTransfer({ ...item, __factoryId: activeFactoryId }); setMigrationAction("START"); setMigrationActionReason(""); setMigrationConfirmed(false); }}>Prepare transition…</button></div>)}</div> : <Empty>No migration operations returned.</Empty>}
        {selectedTransferInScope && (selectedTransferInScope.operationType === "MIGRATION" || selectedTransferInScope.operation_type === "MIGRATION") ? <form className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4" onSubmit={(event) => submit(event, "Migration transition", () => api().transitionMigration(valueOf(selectedTransferInScope.id), buildMigrationTransitionPayload({
          action: migrationAction, expected_version: selectedTransferInScope.version, reason: migrationActionReason,
          idempotency_key: idempotencyKey("migration-transition"),
          ...(migrationAction === "COMPLETE" ? {
            target_bundle_reference: migrationBundleReference,
            target_bundle_digest: migrationBundleDigest,
            target_manifest: JSON.parse(migrationManifest),
            preservation_verified: migrationPreservationVerified,
          } : {}),
        })))}>
          <p className="text-xs font-bold">Transfer {valueOf(selectedTransferInScope.id)} · version {valueOf(selectedTransferInScope.version)}</p>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Transition"><Select value={migrationAction} onChange={setMigrationAction} options={["START", "COMPLETE", "FAIL", "CANCEL"]} /></Field><Field label="Reason"><input className={INPUT} value={migrationActionReason} onChange={(event) => setMigrationActionReason(event.target.value)} minLength={3} required /></Field></div>
          {migrationAction === "COMPLETE" ? <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3"><div className="grid gap-3 sm:grid-cols-2"><Field label="Target bundle reference"><input className={INPUT} value={migrationBundleReference} onChange={(event) => setMigrationBundleReference(event.target.value)} required /></Field><Field label="Target bundle SHA-256"><input className={INPUT} value={migrationBundleDigest} onChange={(event) => setMigrationBundleDigest(event.target.value)} required minLength={64} maxLength={64} /></Field></div><Field label="Target dataset manifest JSON"><textarea className={AREA} value={migrationManifest} onChange={(event) => setMigrationManifest(event.target.value)} required /></Field><label className="flex gap-2 text-[10px] text-amber-950"><input type="checkbox" checked={migrationPreservationVerified} onChange={(event) => setMigrationPreservationVerified(event.target.checked)} />I independently verified required preservation evidence.</label></div> : null}
          <label className="flex gap-2 text-[10px] text-rose-800"><input type="checkbox" checked={migrationConfirmed} onChange={(event) => setMigrationConfirmed(event.target.checked)} />I have verified the selected source/target transfer and current state before applying this transition.</label>
          <div className="flex flex-wrap gap-2"><button className={migrationAction === "COMPLETE" || migrationAction === "CANCEL" || migrationAction === "FAIL" ? DANGER : PRIMARY} disabled={busy || !canExecuteTransfers || !migrationConfirmed || (migrationAction === "COMPLETE" && !migrationPreservationVerified)}>Apply migration transition</button><button type="button" className={SECONDARY} onClick={() => setSelectedTransfer(null)}>Cancel</button></div>
        </form> : null}
      </Panel>
      {currentTransferHistory !== null ? <Panel title="Selected transfer history"><JsonPanel title="History response" data={currentTransferHistory} /></Panel> : null}
    </div> : null}

    {tab === "TARGETS" ? <div className="space-y-4">
      <Panel title="Register external data target" subtitle="Register a non-secret configuration reference only. Credentials, URLs and secret-like values are rejected before sending; API review is a separate state transition.">
        {!canWriteRetention ? <Empty>Missing permission: saas.data_retention.write.</Empty> : <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => submit(event, "External data target registration", () => api().registerExternalTarget(buildExternalTargetPayload({
          target_id: targetId, store_kind: targetStoreKind, adapter_key: targetAdapter, config_reference: targetConfigReference,
          categories: targetCategories, registration_reason: targetReason, idempotency_key: idempotencyKey("external-target"),
        })))}>
          <Field label="Target ID"><input className={INPUT} value={targetId} onChange={(event) => setTargetId(event.target.value)} required maxLength={100} /></Field>
          <Field label="Store kind"><Select value={targetStoreKind} onChange={setTargetStoreKind} options={STORE_KINDS} /></Field>
          <Field label="Adapter key"><input className={INPUT} value={targetAdapter} onChange={(event) => setTargetAdapter(event.target.value)} required maxLength={100} /></Field>
          <Field label="Non-secret configuration reference" hint="Example: vault.refs.archive-policy. Do not enter URLs, tokens, passwords or secrets."><input className={INPUT} value={targetConfigReference} onChange={(event) => setTargetConfigReference(event.target.value)} required maxLength={200} /></Field>
          <div className="sm:col-span-2"><MultiCategories value={targetCategories} onChange={setTargetCategories} label="Target data categories" /></div>
          <div className="sm:col-span-2"><Field label="Registration reason"><textarea className={AREA} value={targetReason} onChange={(event) => setTargetReason(event.target.value)} required minLength={3} maxLength={1000} /></Field></div>
          <div className="sm:col-span-2"><button className={PRIMARY} disabled={busy}>Register external target</button></div>
        </form>}
      </Panel>
      <Panel title="External target register" subtitle="Approve, reject, pause or resume using the server-returned expected state.">
        {targets.length ? <div className="space-y-2">{targets.map((item, index) => <div key={valueOf(item.id, String(index))} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{valueOf(item.targetId ?? item.target_id ?? item.id)}</strong><Status value={item.status} /></div><p className="mt-1 text-[10px] text-slate-500">{valueOf(item.storeKind ?? item.store_kind)} · {valueOf(item.adapterKey ?? item.adapter_key)} · {valueOf(item.categories)}</p>{canApproveRetention ? <button type="button" className={SECONDARY + " mt-2"} onClick={() => { setSelectedTarget({ ...item, __factoryId: activeFactoryId }); setTargetDecision("APPROVE"); setTargetReviewReason(""); }}>Review target…</button> : null}</div>)}</div> : <Empty>No external data targets returned.</Empty>}
        {selectedTargetInScope ? <form className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2" onSubmit={(event) => submit(event, "External target review", () => api().reviewExternalTarget(valueOf(selectedTargetInScope.targetId ?? selectedTargetInScope.target_id ?? selectedTargetInScope.id), buildExternalTargetReviewPayload({
          decision: targetDecision, expected_status: selectedTargetInScope.status, reason: targetReviewReason,
        })))}>
          <p className="text-xs font-bold sm:col-span-2">Selected {valueOf(selectedTargetInScope.targetId ?? selectedTargetInScope.target_id ?? selectedTargetInScope.id)} · expected status {valueOf(selectedTargetInScope.status)}</p>
          <Field label="Decision"><Select value={targetDecision} onChange={setTargetDecision} options={["APPROVE", "REJECT", "PAUSE", "RESUME"]} /></Field>
          <Field label="Review reason"><input className={INPUT} value={targetReviewReason} onChange={(event) => setTargetReviewReason(event.target.value)} required minLength={3} maxLength={1000} /></Field>
          <div className="flex gap-2 sm:col-span-2"><button className={SECONDARY} disabled={busy || !canApproveRetention}>Submit target review</button><button type="button" className={SECONDARY} onClick={() => setSelectedTarget(null)}>Cancel</button></div>
        </form> : null}
      </Panel>
    </div> : null}

    {tab === "BACKUP" ? <div className="space-y-4">
      <Panel title="Provider backup evidence" subtitle="Inspect server-owned latest/current acceptance, writer inventories and copy coverage for a dataset category. This view does not infer provider acceptance from a snapshot being present.">
        {!canReadRetention ? <Empty>Missing permission: saas.data_retention.read.</Empty> : <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Dataset category"><Select value={backupCategory} onChange={setBackupCategory} options={categoryOptions} /></Field>
          <div className="flex items-end"><button className={PRIMARY} onClick={() => void loadBackupEvidence()} disabled={backupLoading}>{backupLoading ? "Loading evidence…" : "Load backup evidence"}</button></div>
        </div>}
        {backupError ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[10px] leading-5 text-amber-950">{backupError}</p> : null}
      </Panel>
      {Object.keys(currentBackupEvidence).filter((key) => key !== "__factoryId").length ? <section className="grid gap-4 lg:grid-cols-2">
        <JsonPanel title="Provider acceptance · latest" data={currentBackupEvidence.providerLatest} />
        <JsonPanel title="Provider acceptance · current" data={currentBackupEvidence.providerCurrent} />
        <JsonPanel title="Backup writer inventory · latest" data={currentBackupEvidence.writerLatest} />
        <JsonPanel title="Backup writer inventory · current" data={currentBackupEvidence.writerCurrent} />
        <JsonPanel title="Backup copy-class coverage · current" data={currentBackupEvidence.copyClassCoverage} />
        <JsonPanel title="External copy coverage · current" data={currentBackupEvidence.externalCopyCoverage} />
      </section> : <Empty>Select a category and load its evidence records. No provider-level acceptance is assumed from missing or stale evidence.</Empty>}
    </div> : null}

    <Panel title="Latest API response" subtitle="The most recent successful command response is shown for operator traceability. Sensitive tokens are never requested or rendered by this page.">
      {currentLatestResponse === null ? <Empty>No write/action response recorded in this page session.</Empty> : <JsonPanel title="Server response" data={currentLatestResponse} />}
    </Panel>
    <p className="px-1 text-[10px] leading-5 text-slate-500">Tenant and active-factory identity are taken from the shared authenticated FactoryOS session. Browser permission checks only control visibility; backend IAM permission guards, tenant scoping, optimistic versions, legal holds, audit records and lifecycle validations remain authoritative. Execution must be independently reviewed and tested before production use.</p>
  </main>;
}
