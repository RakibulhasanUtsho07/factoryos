"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildSaasAlertAcknowledgementPayload,
  buildSaasBudgetPayload,
  buildSaasProviderCostEventPayload,
  buildSaasProviderReconciliationPayload,
  buildSaasRateCardPayload,
  buildSaasUsageAdjustmentPayload,
  buildSaasUsageEventPayload,
  buildSaasUsageReconciliationPayload,
  buildSaasWorkloadControlPayload,
  createSaasUsageClient,
  normalizeSaasRows,
} from "@/lib/saas-usage-cost-workbench.mjs";
import type { SaasUsageClient } from "@/lib/saas-usage-cost-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "OVERVIEW" | "METERING" | "BUDGETS" | "ALERTS" | "PROVIDER" | "RECONCILIATION";
type Notice = { tone: "success" | "error" | "warning"; message: string };

const METRICS = [
  "ACTIVE_USER", "ROLE_ASSIGNMENT", "TRANSACTION", "STORAGE_BYTE_HOUR", "TELEMETRY_EVENT",
  "AI_INPUT_TOKEN", "AI_OUTPUT_TOKEN", "AI_TOOL_CALL", "PREMIUM_WORKLOAD", "INTEGRATION_CALL", "EDGE_INFERENCE",
];
const WORKLOADS = ["PRODUCTION", "EVALUATION", "RED_TEAM", "SHADOW_MODE", "DEVELOPMENT", "NON_AI"];
const SOURCES = ["API", "AI_GATEWAY", "TOOL_GATEWAY", "TELEMETRY", "CONNECTOR", "EDGE_GATEWAY", "MANUAL"];
const PROVIDER_METRICS = ["AI_INPUT_TOKEN", "AI_OUTPUT_TOKEN", "AI_TOOL_CALL", "PREMIUM_WORKLOAD", "EDGE_INFERENCE", "INTEGRATION_CALL"];
const NONCRITICAL = ["EVALUATION", "RED_TEAM", "SHADOW_MODE", "DEVELOPMENT"];
const ADJUSTMENT_REASONS = ["METER_CORRECTION", "PRICING_CORRECTION", "CUSTOMER_CREDIT", "CUSTOMER_DEBIT", "TAX_CORRECTION", "OTHER"];
const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24 font-mono text-xs leading-5";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function nowLocalInput() {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}
function dayInput(offset = 0) {
  return new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
}
function newKey(prefix: string) {
  return prefix + "-" + globalThis.crypto.randomUUID();
}
function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function list(value: unknown, key?: string): Row[] {
  return normalizeSaasRows(value, key).map(row);
}
function valueOf(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}
function errorOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The SaaS usage request could not be completed.";
}
function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function amount(value: unknown, currency: unknown): string {
  if (value === null || value === undefined) return "Unpriced";
  return valueOf(currency, "—") + " " + String(value) + " minor units";
}
function statusClass(value: unknown): string {
  const state = valueOf(value, "UNKNOWN").toUpperCase();
  if (["SAFE", "MATCHED", "RESUMED", "ACKNOWLEDGED"].includes(state)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["WARNING", "ANOMALY", "UNPRICED_USAGE", "NO_PROVIDER_DATA", "PENDING"].includes(state)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["HARD_LIMIT", "VARIANCE", "PAUSED", "FAILED"].includes(state)) return "border-rose-200 bg-rose-50 text-rose-800";
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
function JsonView({ title, data }: { title: string; data: unknown }) {
  let serialized = "No response";
  try { serialized = JSON.stringify(data, null, 2); } catch { serialized = String(data); }
  return <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-950 p-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-100">{serialized}</pre></div>;
}
function Select({ value, onChange, options, placeholder }: { value: string; onChange: (value: string) => void; options: string[]; placeholder?: string }) {
  return <select className={INPUT} value={value} onChange={(event) => onChange(event.target.value)}>{placeholder ? <option value="">{placeholder}</option> : null}{options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select>;
}

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: "OVERVIEW", label: "Overview" },
  { id: "METERING", label: "Metering & Rates" },
  { id: "BUDGETS", label: "Budgets & Controls" },
  { id: "ALERTS", label: "Budget Alerts" },
  { id: "PROVIDER", label: "Provider Costs" },
  { id: "RECONCILIATION", label: "Reconciliation" },
];

export default function SaasUsageCostWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && !!activeFactoryId;
  const canReadUsage = hasPermission("saas.usage.read");
  const canWriteUsage = hasPermission("saas.usage.write");
  const canWriteRates = hasPermission("saas.rates.write");
  const canAdjust = hasPermission("saas.adjustments.write");
  const canReconcileUsage = hasPermission("saas.reconciliation.write");
  const canReadBudgets = hasPermission("saas.budgets.read");
  const canWriteBudgets = hasPermission("saas.budgets.write");
  const canControlWorkloads = hasPermission("saas.workloads.control");
  const canReadAlerts = hasPermission("saas.alerts.read");
  const canAckAlerts = hasPermission("saas.alerts.ack");
  const canReadProvider = hasPermission("saas.provider_costs.read");
  const canWriteProvider = hasPermission("saas.provider_costs.write");
  const canReconcileProvider = hasPermission("saas.provider_costs.reconcile");

  const [tab, setTab] = useState<Tab>("OVERVIEW");
  const [refreshTick, setRefreshTick] = useState(0);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Row[]>([]);
  const [usageReport, setUsageReport] = useState<Row | null>(null);
  const [budgets, setBudgets] = useState<Row[]>([]);
  const [budgetEvaluations, setBudgetEvaluations] = useState<Row[]>([]);
  const [workloadControls, setWorkloadControls] = useState<Row[]>([]);
  const [alerts, setAlerts] = useState<Row[]>([]);
  const [usageReconciliations, setUsageReconciliations] = useState<Row[]>([]);
  const [providerReconciliations, setProviderReconciliations] = useState<Row[]>([]);
  const [latestResponse, setLatestResponse] = useState<unknown>(null);
  const [reportFrom, setReportFrom] = useState(dayInput(29));
  const [reportTo, setReportTo] = useState(dayInput(0));
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [rateMetric, setRateMetric] = useState("AI_INPUT_TOKEN");
  const [rateVersion, setRateVersion] = useState("1");
  const [rateMinor, setRateMinor] = useState("50");
  const [rateBlock, setRateBlock] = useState("1000");
  const [rateCurrency, setRateCurrency] = useState("BDT");
  const [rateEffectiveFrom, setRateEffectiveFrom] = useState(nowLocalInput());
  const [eventMetric, setEventMetric] = useState("AI_INPUT_TOKEN");
  const [eventCapability, setEventCapability] = useState("ai.runtime.inference");
  const [eventWorkload, setEventWorkload] = useState("PRODUCTION");
  const [eventQuantity, setEventQuantity] = useState("1");
  const [eventOccurredAt, setEventOccurredAt] = useState(nowLocalInput());
  const [eventSource, setEventSource] = useState("AI_GATEWAY");
  const [eventSourceRef, setEventSourceRef] = useState("");
  const [budgetCode, setBudgetCode] = useState("ai-monthly");
  const [budgetVersion, setBudgetVersion] = useState("1");
  const [budgetPeriod, setBudgetPeriod] = useState("MONTHLY");
  const [budgetScope, setBudgetScope] = useState("FACTORY");
  const [budgetMetric, setBudgetMetric] = useState("");
  const [budgetCapability, setBudgetCapability] = useState("");
  const [budgetWorkload, setBudgetWorkload] = useState("");
  const [budgetCurrency, setBudgetCurrency] = useState("BDT");
  const [budgetSoftLimit, setBudgetSoftLimit] = useState("100000");
  const [budgetHardLimit, setBudgetHardLimit] = useState("150000");
  const [budgetPauseNoncritical, setBudgetPauseNoncritical] = useState(false);
  const [budgetPauseConfirmed, setBudgetPauseConfirmed] = useState(false);
  const [budgetAnomalyMultiplier, setBudgetAnomalyMultiplier] = useState("3");
  const [budgetAnomalyMinEvents, setBudgetAnomalyMinEvents] = useState("10");
  const [budgetEffectiveFrom, setBudgetEffectiveFrom] = useState(nowLocalInput());
  const [controlClass, setControlClass] = useState("EVALUATION");
  const [controlState, setControlState] = useState("PAUSED");
  const [controlScope, setControlScope] = useState("FACTORY");
  const [controlReason, setControlReason] = useState("");
  const [controlConfirmed, setControlConfirmed] = useState(false);
  const [adjustStart, setAdjustStart] = useState(dayInput(29));
  const [adjustEnd, setAdjustEnd] = useState(dayInput(0));
  const [adjustMetric, setAdjustMetric] = useState("");
  const [adjustQuantity, setAdjustQuantity] = useState("0");
  const [adjustCost, setAdjustCost] = useState("0");
  const [adjustCurrency, setAdjustCurrency] = useState("BDT");
  const [adjustReasonCode, setAdjustReasonCode] = useState("METER_CORRECTION");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustReference, setAdjustReference] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [invoiceVersion, setInvoiceVersion] = useState("1");
  const [invoiceStart, setInvoiceStart] = useState(dayInput(29));
  const [invoiceEnd, setInvoiceEnd] = useState(dayInput(0));
  const [invoiceCurrency, setInvoiceCurrency] = useState("BDT");
  const [invoiceAmount, setInvoiceAmount] = useState("0");
  const [providerCode, setProviderCode] = useState("openai");
  const [modelCode, setModelCode] = useState("");
  const [providerMetric, setProviderMetric] = useState("AI_INPUT_TOKEN");
  const [providerWorkload, setProviderWorkload] = useState("PRODUCTION");
  const [providerQuantity, setProviderQuantity] = useState("1");
  const [providerCurrency, setProviderCurrency] = useState("USD");
  const [providerCostMinor, setProviderCostMinor] = useState("0");
  const [providerOccurredAt, setProviderOccurredAt] = useState(nowLocalInput());
  const [providerInvoiceRef, setProviderInvoiceRef] = useState("");
  const [providerSource, setProviderSource] = useState("PROVIDER_EXPORT");
  const [providerSourceRef, setProviderSourceRef] = useState("");
  const [providerReconCode, setProviderReconCode] = useState("openai");
  const [providerReconInvoice, setProviderReconInvoice] = useState("");
  const [providerReconVersion, setProviderReconVersion] = useState("1");
  const [providerReconStart, setProviderReconStart] = useState(dayInput(29));
  const [providerReconEnd, setProviderReconEnd] = useState(dayInput(0));
  const [providerReconCurrency, setProviderReconCurrency] = useState("USD");
  const [providerReconAmount, setProviderReconAmount] = useState("0");

  function api(): SaasUsageClient {
    return createSaasUsageClient((path, options = {}) => request(path, options));
  }

  const visibleRates = loadedFactoryId === activeFactoryId ? rates : [];
  const visibleBudgets = loadedFactoryId === activeFactoryId ? budgets : [];
  const visibleBudgetEvaluations = loadedFactoryId === activeFactoryId ? budgetEvaluations : [];
  const visibleControls = loadedFactoryId === activeFactoryId ? workloadControls : [];
  const visibleAlerts = loadedFactoryId === activeFactoryId ? alerts : [];
  const visibleUsageRecon = loadedFactoryId === activeFactoryId ? usageReconciliations : [];
  const visibleProviderRecon = loadedFactoryId === activeFactoryId ? providerReconciliations : [];
  const visibleReport = loadedFactoryId === activeFactoryId ? usageReport : null;
  const factoryName = snapshot?.factories.find((factory) => factory.id === activeFactoryId)?.name ?? activeFactoryId;
  const eventCount = Number(visibleReport?.eventCount ?? 0);
  const unpricedCount = Number(visibleReport?.unpricedEventCount ?? 0);
  const budgetWarningCount = visibleBudgetEvaluations.filter((item) => ["WARNING", "HARD_LIMIT", "UNPRICED_USAGE", "ANOMALY"].includes(String(item.status))).length;
  const unresolvedAlertCount = visibleAlerts.filter((item) => !item.acknowledgedAt).length;

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      if (!connected) {
        setLoading(false);
        setLoadedFactoryId("");
        return;
      }
      setLoading(true);
      const client = createSaasUsageClient((path, options = {}) => request(path, options));
      const tasks: Array<{ key: string; enabled: boolean; run: () => Promise<unknown>; field: string }> = [
        { key: "rates", enabled: canReadUsage, run: () => client.listRates(), field: "rates" },
        { key: "budgets", enabled: canReadBudgets, run: () => client.listBudgets(), field: "budgets" },
        { key: "evaluations", enabled: canReadBudgets, run: () => client.listBudgetEvaluations(25, 0), field: "evaluations" },
        { key: "controls", enabled: canReadBudgets, run: () => client.listWorkloadControls(), field: "controls" },
        { key: "alerts", enabled: canReadAlerts, run: () => client.listAlerts({ limit: 50, offset: 0, unread_only: unreadOnly }), field: "alerts" },
        { key: "usageReconciliations", enabled: canReadUsage, run: () => client.listReconciliations(25, 0), field: "reconciliations" },
        { key: "providerReconciliations", enabled: canReadProvider, run: () => client.listProviderReconciliations(25, 0), field: "providerReconciliations" },
      ];
      const results = await Promise.all(tasks.filter((task) => task.enabled).map(async (task) => {
        try { return { key: task.key, field: task.field, result: await task.run(), error: "" }; }
        catch (cause) { return { key: task.key, field: task.field, result: null, error: errorOf(cause) }; }
      }));
      if (cancelled) return;
      const errors: Record<string, string> = {};
      for (const result of results) {
        if (result.error) errors[result.key] = result.error;
        if (result.key === "rates") setRates(list(result.result, result.field));
        if (result.key === "budgets") setBudgets(list(result.result, result.field));
        if (result.key === "evaluations") setBudgetEvaluations(list(result.result, result.field));
        if (result.key === "controls") setWorkloadControls(list(result.result, result.field));
        if (result.key === "alerts") setAlerts(list(result.result, result.field));
        if (result.key === "usageReconciliations") setUsageReconciliations(list(result.result, result.field));
        if (result.key === "providerReconciliations") setProviderReconciliations(list(result.result, result.field));
      }
      setLoadErrors(errors);
      setLoadedFactoryId(activeFactoryId);
      setLoading(false);
    }
    const timer = window.setTimeout(() => {
      void loadWorkspace().catch((cause) => {
        if (!cancelled) { setLoadErrors({ workspace: errorOf(cause) }); setLoading(false); }
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connected, activeFactoryId, canReadUsage, canReadBudgets, canReadAlerts, canReadProvider, request, refreshTick, unreadOnly]);

  async function perform(title: string, action: () => Promise<unknown>, onSuccess?: (result: unknown) => void) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      onSuccess?.(result);
      setLatestResponse(result);
      setNotice({ tone: "success", message: title + " completed. Check the returned record and ledger status before continuing." });
      setRefreshTick((current) => current + 1);
      return result;
    } catch (cause) {
      setNotice({ tone: "error", message: errorOf(cause) });
      return null;
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>, title: string, action: () => Promise<unknown>, onSuccess?: (result: unknown) => void) {
    event.preventDefault();
    void perform(title, action, onSuccess);
  }
  async function loadUsageReport() {
    if (!canReadUsage) return;
    await perform("Usage report", () => api().report(reportFrom, reportTo), (result) => setUsageReport(row(result)));
  }
  async function evaluateBudgets() {
    if (!canReadBudgets) return;
    await perform("Budget evaluation", () => api().evaluateBudgets(), (result) => {
      const data = row(result);
      setLatestResponse(data);
      setNotice({
        tone: "success",
        message: "Budget evaluation completed at " + formatDate(data.evaluatedAt) + ". Review every status and alert; pause controls may have been created by configured hard-limit policies.",
      });
    });
  }

  const allowedTabs = ALL_TABS.filter((item) => {
    if (item.id === "OVERVIEW") return canReadUsage || canReadBudgets || canReadAlerts || canReadProvider;
    if (item.id === "METERING") return canReadUsage || canWriteUsage || canWriteRates;
    if (item.id === "BUDGETS") return canReadBudgets || canWriteBudgets || canControlWorkloads;
    if (item.id === "ALERTS") return canReadAlerts || canAckAlerts;
    if (item.id === "PROVIDER") return canReadProvider || canWriteProvider || canReconcileProvider;
    return canReadUsage || canAdjust || canReconcileUsage || canReadProvider || canReconcileProvider;
  });
  const activeTab = allowedTabs.some((item) => item.id === tab) ? tab : allowedTabs[0]?.id ?? "OVERVIEW";

  if (!connected) return <main className="space-y-5 p-4 sm:p-6">
    <header className="rounded-2xl bg-slate-950 px-5 py-6 text-white"><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-200">SaaS cost governance</p><h1 className="mt-2 text-2xl font-bold">Usage & Cost Control Tower</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Connect the shared FactoryOS session and select an active factory to manage tenant usage, budgets and provider costs.</p></header>
    <Panel title="Factory session required"><Empty>Connect from the workspace session panel and select an active factory. This module does not store a separate API token.</Empty></Panel>
  </main>;
  if (!allowedTabs.length) return <main className="p-4 sm:p-6"><Panel title="SaaS usage access unavailable"><Empty>This factory session has no SaaS usage, budgets, alerts or provider-cost permissions. Ask an administrator for the exact permissions required by your role.</Empty></Panel></main>;

  return <main className="space-y-5 p-4 sm:p-6">
    <header className="rounded-2xl bg-slate-950 text-white">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-6 sm:px-7">
        <div className="max-w-3xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-200">SaaS usage economics</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Usage, Cost & Budget Control Tower</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">Inspect effective-dated meter rates, price usage snapshots, set tenant or factory budgets, manage non-critical workload controls and reconcile platform/provider costs to invoices.</p>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-300">
            <span className="rounded-full border border-white/20 px-3 py-1">{factoryName}</span>
            <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-emerald-200">Authenticated factory context</span>
            <span className="rounded-full border border-white/20 px-3 py-1">Immutable metering · idempotent writes</span>
          </div>
        </div>
        <button type="button" className="min-h-9 rounded-lg border border-white/20 px-3 text-xs font-semibold hover:bg-white/10 disabled:opacity-50" disabled={busy || loading} onClick={() => setRefreshTick((current) => current + 1)}>{loading ? "Refreshing…" : "Refresh control tower"}</button>
      </div>
    </header>

    <section className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-950">
      <span className="mr-2 rounded-full bg-blue-100 px-2 py-1 text-[10px] font-bold uppercase text-blue-800">Billing semantics</span>
      Usage reports are metered cost estimates, not invoices. Provider-cost records are separate from tenant usage prices. Invoice reconciliation snapshots show MATCHED, VARIANCE or UNPRICED_USAGE; this page never represents an estimate as a final payable invoice.
    </section>

    {notice ? <div className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : notice.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-rose-200 bg-rose-50 text-rose-900")}>
      <div className="flex items-start justify-between gap-3"><p>{notice.message}</p><button type="button" className="text-[10px] font-bold uppercase" onClick={() => setNotice(null)}>Dismiss</button></div>
    </div> : null}
    {Object.keys(loadErrors).length ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"><p className="text-xs font-bold text-amber-900">Some SaaS data could not be loaded</p>{Object.entries(loadErrors).map(([key, message]) => <p key={key} className="mt-1 text-xs text-amber-800">{key}: {message}</p>)}</div> : null}

    <nav className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1" aria-label="SaaS usage sections">
      {allowedTabs.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-current={activeTab === item.id ? "page" : undefined} className={"min-w-max rounded-lg px-3 py-2 text-xs font-semibold " + (activeTab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
    </nav>

    {activeTab === "OVERVIEW" ? <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Usage events" value={visibleReport ? eventCount.toLocaleString() : "—"} hint={visibleReport ? "Selected report period" : "Load a report to calculate"} />
        <Metric label="Unpriced events" value={visibleReport ? unpricedCount.toLocaleString() : "—"} hint="No effective rate snapshot" />
        <Metric label="Budget warnings" value={visibleBudgetEvaluations.length ? budgetWarningCount.toLocaleString() : "—"} hint="Latest 25 evaluations returned" />
        <Metric label="Unacknowledged alerts" value={visibleAlerts.length ? unresolvedAlertCount.toLocaleString() : "—"} hint="Current alert page only" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Usage estimate snapshot" subtitle="Choose an inclusive date range. The API translates it to an exclusive next-day end boundary and limits reports to 366 days.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From"><input type="date" className={INPUT} value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /></Field>
            <Field label="Through (inclusive)"><input type="date" className={INPUT} value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></Field>
          </div>
          <button type="button" className={PRIMARY + " mt-3"} disabled={busy || !canReadUsage} onClick={() => void loadUsageReport()}>Load usage estimate</button>
          {visibleReport ? <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><Status value="USAGE_ESTIMATE_NOT_AN_INVOICE" /><span className="text-[10px] text-slate-500">{valueOf(visibleReport.periodStart)} → {valueOf(visibleReport.periodEnd)} (exclusive)</span></div>
            {list(visibleReport.events, "events").slice(0, 8).map((entry, index) => <div key={String(entry.metricCode) + String(entry.capabilityCode) + index} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-900">{valueOf(entry.metricCode)}</span><span className="text-[10px] text-slate-500">{valueOf(entry.workloadClass)}</span></div>
              <p className="mt-1 text-[10px] text-slate-500">{valueOf(entry.capabilityCode)} · {valueOf(entry.eventCount, "0")} events · {valueOf(entry.quantity, "0")} {valueOf(entry.unit)}</p>
              <p className="mt-1 text-xs font-semibold text-slate-800">{amount(entry.estimatedCostMinor, entry.currency)}</p>
              {Number(entry.unpricedCount ?? 0) > 0 ? <p className="mt-1 text-[10px] text-amber-800">{valueOf(entry.unpricedCount)} unpriced events</p> : null}
            </div>)}
            {list(visibleReport.events, "events").length > 8 ? <p className="text-[10px] text-slate-500">Showing 8 of {list(visibleReport.events, "events").length} grouped rows; the full report response is available below.</p> : null}
          </div> : <div className="mt-4"><Empty>Load a usage estimate for this factory and date range.</Empty></div>}
        </Panel>
        <Panel title="Budget and workload health" subtitle="Evaluation states are recorded by the API. Configured hard-limit policies can automatically pause only non-critical AI workload classes.">
          <div className="flex flex-wrap items-center gap-2"><button type="button" className={PRIMARY} disabled={busy || !canReadBudgets} onClick={() => void evaluateBudgets()}>Evaluate budgets now</button><button type="button" className={SECONDARY} disabled={busy || !canReadBudgets} onClick={() => setTab("BUDGETS")}>Inspect budget policies</button></div>
          <div className="mt-4 space-y-2">
            {visibleBudgetEvaluations.slice(0, 6).map((entry) => <div key={String(entry.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
              <div><p className="text-xs font-bold text-slate-900">{amount(entry.usageCostMinor, valueOf(budgets.find((budget) => budget.id === entry.budgetId)?.currency))}</p><p className="mt-1 text-[10px] text-slate-500">{formatDate(entry.evaluatedAt)} · {valueOf(entry.eventCount, "0")} events · unpriced {valueOf(entry.unpricedEventCount, "0")}</p></div><Status value={entry.status} />
            </div>)}
            {!visibleBudgetEvaluations.length ? <Empty>No budget evaluations have been loaded for this factory.</Empty> : null}
          </div>
          {visibleControls.length ? <div className="mt-4 border-t border-slate-100 pt-3"><p className="mb-2 text-xs font-bold text-slate-900">Latest non-critical workload controls</p><div className="flex flex-wrap gap-2">{visibleControls.map((entry) => <div key={String(entry.id) + String(entry.workloadClass)} className="rounded-lg border border-slate-200 px-3 py-2 text-[10px]"><span className="font-semibold">{valueOf(entry.workloadClass)}</span><span className="mx-2 text-slate-400">·</span><Status value={entry.state} /></div>)}</div></div> : null}
        </Panel>
      </div>
      <Panel title="Permission coverage" subtitle="Every API request is also checked server-side against this tenant and selected factory context.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["saas.usage.read", canReadUsage], ["saas.usage.write", canWriteUsage], ["saas.rates.write", canWriteRates],
            ["saas.adjustments.write", canAdjust], ["saas.reconciliation.write", canReconcileUsage], ["saas.budgets.read", canReadBudgets],
            ["saas.budgets.write", canWriteBudgets], ["saas.workloads.control", canControlWorkloads], ["saas.alerts.read", canReadAlerts],
            ["saas.alerts.ack", canAckAlerts], ["saas.provider_costs.read", canReadProvider], ["saas.provider_costs.write", canWriteProvider],
            ["saas.provider_costs.reconcile", canReconcileProvider],
          ].map(([name, granted]) => <div key={String(name)} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"><code className="text-[10px] text-slate-700">{name}</code><Status value={granted ? "GRANTED" : "NOT_GRANTED"} /></div>)}
        </div>
      </Panel>
      {latestResponse ? <Panel title="Latest API response"><JsonView title="Response" data={latestResponse} /></Panel> : null}
    </div> : null}

    {activeTab === "METERING" ? <div className="space-y-4">
      <Panel title="Effective-dated meter rates" subtitle="Rates are immutable versions by metric and effective timestamp. Existing usage events retain the exact rate snapshot used at ingestion.">
        {canReadUsage ? <div className="overflow-x-auto">
          {visibleRates.length ? <table className="w-full min-w-[680px] text-left text-xs"><thead className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="py-2 pr-3">Metric</th><th className="py-2 pr-3">Unit</th><th className="py-2 pr-3">Version</th><th className="py-2 pr-3">Rate / block</th><th className="py-2 pr-3">Block quantity</th><th className="py-2 pr-3">Effective from</th></tr></thead><tbody>{visibleRates.map((entry) => <tr key={String(entry.id)} className="border-b border-slate-100"><td className="py-3 pr-3 font-semibold text-slate-900">{valueOf(entry.metricCode)}</td><td className="py-3 pr-3 text-slate-600">{valueOf(entry.unit)}</td><td className="py-3 pr-3">{valueOf(entry.rateVersion)}</td><td className="py-3 pr-3">{amount(entry.rateMinorPerBlock, entry.currency)}</td><td className="py-3 pr-3">{valueOf(entry.blockQuantity)}</td><td className="py-3 pr-3">{formatDate(entry.effectiveFrom)}</td></tr>)}</tbody></table> : <Empty>No meter rate cards were returned.</Empty>}
        </div> : <Empty>saas.usage.read is required to view meter rates.</Empty>}
        {canWriteRates ? <form className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => submit(event, "Meter rate card", () => api().createRate(buildSaasRateCardPayload({ metric_code: rateMetric, rate_version: rateVersion, rate_minor_per_block: rateMinor, block_quantity: rateBlock, currency: rateCurrency, effective_from: new Date(rateEffectiveFrom).toISOString(), idempotency_key: newKey("rate") })))}>
          <Field label="Metric"><Select value={rateMetric} onChange={setRateMetric} options={METRICS} /></Field>
          <Field label="Rate version"><input className={INPUT} type="number" min="1" step="1" value={rateVersion} onChange={(event) => setRateVersion(event.target.value)} /></Field>
          <Field label="Rate (minor units)"><input className={INPUT} type="number" min="0" step="1" value={rateMinor} onChange={(event) => setRateMinor(event.target.value)} /></Field>
          <Field label="Block quantity"><input className={INPUT} type="number" min="0.000001" step="0.000001" value={rateBlock} onChange={(event) => setRateBlock(event.target.value)} /></Field>
          <Field label="Currency"><input className={INPUT} value={rateCurrency} maxLength={3} onChange={(event) => setRateCurrency(event.target.value.toUpperCase())} /></Field>
          <Field label="Effective from"><input className={INPUT} type="datetime-local" value={rateEffectiveFrom} onChange={(event) => setRateEffectiveFrom(event.target.value)} /></Field>
          <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy}>Create new rate version</button></div>
        </form> : null}
      </Panel>

      <Panel title="Record a metered usage event" subtitle="The backend prices an event using the rate effective at occurred_at, stores a fixed-point snapshot and evaluates budget enforcement at processing time. Source identity and idempotency prevent duplicate ingestion.">
        {canWriteUsage ? <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => submit(event, "Usage event", () => api().recordEvent(buildSaasUsageEventPayload({
          metric_code: eventMetric, capability_code: eventCapability, workload_class: eventWorkload, quantity: eventQuantity,
          occurred_at: new Date(eventOccurredAt).toISOString(), source_system: eventSource, source_event_ref: eventSourceRef,
          idempotency_key: newKey("usage"),
        })))}>
          <Field label="Meter metric"><Select value={eventMetric} onChange={setEventMetric} options={METRICS} /></Field>
          <Field label="Capability code"><input className={INPUT} value={eventCapability} onChange={(event) => setEventCapability(event.target.value)} placeholder="ai.runtime.inference" /></Field>
          <Field label="Workload class"><Select value={eventWorkload} onChange={setEventWorkload} options={WORKLOADS} /></Field>
          <Field label="Quantity (up to 6 decimals)"><input className={INPUT} type="number" min="0.000001" step="0.000001" value={eventQuantity} onChange={(event) => setEventQuantity(event.target.value)} /></Field>
          <Field label="Occurred at"><input className={INPUT} type="datetime-local" value={eventOccurredAt} onChange={(event) => setEventOccurredAt(event.target.value)} /></Field>
          <Field label="Source system"><Select value={eventSource} onChange={setEventSource} options={SOURCES} /></Field>
          <Field label="Source event reference"><input className={INPUT} value={eventSourceRef} onChange={(event) => setEventSourceRef(event.target.value)} maxLength={255} placeholder="provider or gateway event ID" /></Field>
          <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || !eventSourceRef.trim()}>Record immutable usage event</button></div>
        </form> : <Empty>saas.usage.write is required to record metered events.</Empty>}
      </Panel>
      {visibleReport ? <Panel title="Selected usage report detail" subtitle="Grouped by metric, capability, workload class and currency; provider cost data is intentionally not included in this report."><JsonView title="Usage report" data={visibleReport} /></Panel> : null}
    </div> : null}

    {activeTab === "BUDGETS" ? <div className="space-y-4">
      <Panel title="Create budget policy" subtitle="Soft and hard thresholds use minor currency units. Tenant policies apply across factories; factory scope requires the selected factory. A policy may pause only non-critical AI classes when a hard limit is reached.">
        {canWriteBudgets ? <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => submit(event, "Budget policy", () => api().createBudget(buildSaasBudgetPayload({
          budget_code: budgetCode, policy_version: budgetVersion, period_kind: budgetPeriod, scope_level: budgetScope,
          metric_code: budgetMetric, capability_code: budgetCapability, workload_class: budgetWorkload,
          currency: budgetCurrency, soft_limit_minor: budgetSoftLimit, hard_limit_minor: budgetHardLimit,
          pause_noncritical_on_hard_limit: budgetPauseNoncritical, anomaly_multiplier: budgetAnomalyMultiplier,
          anomaly_min_events: budgetAnomalyMinEvents, effective_from: new Date(budgetEffectiveFrom).toISOString(),
          idempotency_key: newKey("budget"),
        })))}>
          <Field label="Budget code"><input className={INPUT} value={budgetCode} onChange={(event) => setBudgetCode(event.target.value)} maxLength={80} /></Field>
          <Field label="Policy version"><input className={INPUT} type="number" min="1" step="1" value={budgetVersion} onChange={(event) => setBudgetVersion(event.target.value)} /></Field>
          <Field label="Period"><Select value={budgetPeriod} onChange={setBudgetPeriod} options={["DAILY", "MONTHLY"]} /></Field>
          <Field label="Scope level"><Select value={budgetScope} onChange={setBudgetScope} options={["TENANT", "FACTORY"]} /></Field>
          <Field label="Metric filter (optional)"><Select value={budgetMetric} onChange={setBudgetMetric} options={METRICS} placeholder="All metrics" /></Field>
          <Field label="Capability filter (optional)"><input className={INPUT} value={budgetCapability} onChange={(event) => setBudgetCapability(event.target.value)} placeholder="ai.runtime.inference" /></Field>
          <Field label="Workload filter (optional)"><Select value={budgetWorkload} onChange={setBudgetWorkload} options={WORKLOADS} placeholder="All workload classes" /></Field>
          <Field label="Currency"><input className={INPUT} value={budgetCurrency} maxLength={3} onChange={(event) => setBudgetCurrency(event.target.value.toUpperCase())} /></Field>
          <Field label="Soft limit (minor units)"><input className={INPUT} type="number" min="0" step="1" value={budgetSoftLimit} onChange={(event) => setBudgetSoftLimit(event.target.value)} /></Field>
          <Field label="Hard limit (minor units)"><input className={INPUT} type="number" min="0" step="1" value={budgetHardLimit} onChange={(event) => setBudgetHardLimit(event.target.value)} /></Field>
          <Field label="Anomaly multiplier"><input className={INPUT} type="number" min="1.5" max="100" step="0.1" value={budgetAnomalyMultiplier} onChange={(event) => setBudgetAnomalyMultiplier(event.target.value)} /></Field>
          <Field label="Minimum anomaly events"><input className={INPUT} type="number" min="3" max="100000" step="1" value={budgetAnomalyMinEvents} onChange={(event) => setBudgetAnomalyMinEvents(event.target.value)} /></Field>
          <Field label="Effective from"><input className={INPUT} type="datetime-local" value={budgetEffectiveFrom} onChange={(event) => setBudgetEffectiveFrom(event.target.value)} /></Field>
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:col-span-2">
            <input id="pause-noncritical" type="checkbox" checked={budgetPauseNoncritical} onChange={(event) => { setBudgetPauseNoncritical(event.target.checked); setBudgetPauseConfirmed(false); }} className="size-4" />
            <label htmlFor="pause-noncritical" className="text-xs leading-5 text-amber-950">Automatically pause EVALUATION, RED_TEAM, SHADOW_MODE and DEVELOPMENT if this policy reaches its hard limit.</label>
          </div>
          {budgetPauseNoncritical ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 sm:col-span-2 lg:col-span-4">
            <label className="flex items-start gap-2 text-xs leading-5 text-rose-950">
              <input type="checkbox" className="mt-1 size-4" checked={budgetPauseConfirmed} onChange={(event) => setBudgetPauseConfirmed(event.target.checked)} />
              <span>I explicitly authorize this budget policy to automatically pause EVALUATION, RED_TEAM, SHADOW_MODE and DEVELOPMENT workloads when its hard limit is reached. PRODUCTION and NON_AI are never paused by this control.</span>
            </label>
          </div> : null}
          <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || (budgetScope === "FACTORY" && !activeFactoryId) || (budgetPauseNoncritical && !budgetPauseConfirmed)}>Create budget policy</button></div>
        </form> : <Empty>saas.budgets.write is required to create budget policies.</Empty>}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Budget policies" subtitle="The API returns tenant-wide policies plus factory policies for the selected factory.">
          {visibleBudgets.length ? <div className="space-y-2">
            {visibleBudgets.map((entry) => <article key={String(entry.id)} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-900">{valueOf(entry.budgetCode)} · v{valueOf(entry.policyVersion)}</span><Status value={entry.periodKind} /></div>
              <p className="mt-1 text-[11px] text-slate-600">{valueOf(entry.factoryId, "TENANT-WIDE")} · {valueOf(entry.metricCode, "All metrics")} · {valueOf(entry.workloadClass, "All workload classes")}</p>
              <p className="mt-1 text-xs font-semibold text-slate-800">Soft {amount(entry.softLimitMinor, entry.currency)} · Hard {amount(entry.hardLimitMinor, entry.currency)}</p>
              <p className="mt-1 text-[10px] text-slate-500">Pause non-critical: {String(entry.pauseNoncriticalOnHardLimit)} · anomaly ×{valueOf(entry.anomalyMultiplier)} · from {formatDate(entry.effectiveFrom)}</p>
            </article>)}
          </div> : <Empty>No budget policies are available for this factory.</Empty>}
        </Panel>
        <Panel title="Evaluate policies and inspect results" subtitle="Budget evaluation records the calculated status and may persist alerts or policy-driven workload pause events.">
          <button type="button" className={PRIMARY} disabled={busy || !canReadBudgets} onClick={() => void evaluateBudgets()}>Evaluate current budget window</button>
          <div className="mt-3 space-y-2">
            {visibleBudgetEvaluations.slice(0, 12).map((entry) => <article key={String(entry.id)} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold">{valueOf(entry.budgetId)}</span><Status value={entry.status} /></div>
              <p className="mt-1 text-[11px] text-slate-600">{amount(entry.usageCostMinor, visibleBudgets.find((budget) => budget.id === entry.budgetId)?.currency)} · {valueOf(entry.eventCount)} events · unpriced {valueOf(entry.unpricedEventCount)}</p>
              <p className="mt-1 text-[10px] text-slate-500">Period {valueOf(entry.periodStart)} to {valueOf(entry.periodEnd)} · evaluated {formatDate(entry.evaluatedAt)}</p>
            </article>)}
            {!visibleBudgetEvaluations.length ? <Empty>No stored budget evaluations are available.</Empty> : null}
          </div>
        </Panel>
      </div>

      <Panel title="Manual non-critical workload control" subtitle="This control changes the runtime gate. It cannot pause PRODUCTION or NON_AI, and a FACTORY scope requires the active factory. Enter a clear operational reason before pausing or resuming.">
        {canControlWorkloads ? <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => submit(event, "Non-critical workload control", () => api().setWorkloadControl(buildSaasWorkloadControlPayload({
          workload_class: controlClass, control_state: controlState, scope_level: controlScope,
          reason: controlReason, idempotency_key: newKey("workload-control"),
        })), () => { setControlConfirmed(false); setControlReason(""); })}>
          <Field label="Workload class"><Select value={controlClass} onChange={setControlClass} options={NONCRITICAL} /></Field>
          <Field label="Control action"><Select value={controlState} onChange={(next) => { setControlState(next); setControlConfirmed(false); }} options={["PAUSED", "RESUMED"]} /></Field>
          <Field label="Scope"><Select value={controlScope} onChange={setControlScope} options={["TENANT", "FACTORY"]} /></Field>
          <Field label="Reason"><input className={INPUT} value={controlReason} onChange={(event) => setControlReason(event.target.value)} maxLength={1000} required /></Field>
          <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 sm:col-span-2 lg:col-span-3">
            <input id="control-confirm" type="checkbox" checked={controlConfirmed} onChange={(event) => setControlConfirmed(event.target.checked)} className="size-4" />
            <label htmlFor="control-confirm" className="text-xs leading-5 text-rose-950">I understand this changes the runtime execution gate for the selected non-critical workload class and scope.</label>
          </div>
          <div className="flex items-end"><button className={controlState === "PAUSED" ? DANGER : PRIMARY} type="submit" disabled={busy || !controlReason.trim() || !controlConfirmed || (controlScope === "FACTORY" && !activeFactoryId)}>{controlState === "PAUSED" ? "Pause workload" : "Resume workload"}</button></div>
        </form> : <Empty>saas.workloads.control permission is required to pause or resume non-critical workloads.</Empty>}
        {visibleControls.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{visibleControls.map((entry) => <div key={String(entry.id) + String(entry.workloadClass)} className="rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-bold">{valueOf(entry.workloadClass)}</span><Status value={entry.state} /></div><p className="mt-1 text-[10px] text-slate-500">{valueOf(entry.source)} · {valueOf(entry.reasonCode)}</p><p className="mt-1 text-[10px] text-slate-400">{formatDate(entry.createdAt)}</p></div>)}</div> : null}
      </Panel>
    </div> : null}

    {activeTab === "ALERTS" ? <Panel title="Budget and spend alerts" subtitle="Alerts can be WARNING, HARD_LIMIT, UNPRICED_USAGE or ANOMALY. Acknowledgement is per user and idempotent; it does not resolve the underlying budget or workload condition.">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} className="size-4" />Unread only</label>
        <button type="button" className={SECONDARY} disabled={busy || !canReadAlerts} onClick={() => setRefreshTick((current) => current + 1)}>Refresh alerts</button>
      </div>
      {canReadAlerts && visibleAlerts.length ? <div className="space-y-2">
        {visibleAlerts.map((entry) => <article key={String(entry.id)} className="rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="text-sm font-bold text-slate-900">{valueOf(entry.title)}</p><p className="mt-1 text-[11px] text-slate-500">{valueOf(entry.messageCode)} · {valueOf(entry.type)} · {formatDate(entry.createdAt)}</p></div>
            <div className="flex items-center gap-2"><Status value={entry.severity} />{entry.acknowledgedAt ? <Status value="ACKNOWLEDGED" /> : <Status value="UNREAD" />}</div>
          </div>
          <p className="mt-2 text-[11px] text-slate-600">Budget {valueOf(entry.budgetId)} · evaluation {valueOf(entry.evaluationId)} · scope {valueOf(entry.factoryId, "Tenant-wide")}</p>
          <JsonView title="Alert evidence payload" data={entry.payload} />
          {!entry.acknowledgedAt && canAckAlerts ? <button type="button" className={SECONDARY + " mt-3"} disabled={busy} onClick={() => void perform("Alert acknowledgement", () => api().acknowledgeAlert(String(entry.id), buildSaasAlertAcknowledgementPayload({ idempotency_key: newKey("alert-ack") })))}>Acknowledge alert</button> : null}
        </article>)}
      </div> : <Empty>{canReadAlerts ? "No alerts match the current unread filter." : "saas.alerts.read is required to view alerts."}</Empty>}
      <p className="mt-3 text-[10px] text-slate-500">Current response page: {visibleAlerts.length} alerts. The API returns the requested first 50 records; later pages are available through the same limit/offset API.</p>
    </Panel> : null}

    {activeTab === "PROVIDER" ? <div className="space-y-4">
      <Panel title="Record infrastructure/provider cost event" subtitle="This ledger records actual or exported provider cost separately from tenant-billable metering. A provider cost event must be tied to a source reference and idempotency key.">
        {canWriteProvider ? <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => submit(event, "Provider cost event", () => api().recordProviderCost(buildSaasProviderCostEventPayload({
          provider_code: providerCode, model_code: modelCode, metric_code: providerMetric, workload_class: providerWorkload,
          quantity: providerQuantity, currency: providerCurrency, provider_cost_minor: providerCostMinor,
          occurred_at: new Date(providerOccurredAt).toISOString(), provider_invoice_reference: providerInvoiceRef,
          source_system: providerSource, source_event_ref: providerSourceRef, idempotency_key: newKey("provider-cost"),
        })))}>
          <Field label="Provider code"><input className={INPUT} value={providerCode} onChange={(event) => setProviderCode(event.target.value)} maxLength={60} /></Field>
          <Field label="Model code (optional)"><input className={INPUT} value={modelCode} onChange={(event) => setModelCode(event.target.value)} maxLength={100} /></Field>
          <Field label="Provider metric"><Select value={providerMetric} onChange={setProviderMetric} options={PROVIDER_METRICS} /></Field>
          <Field label="Workload class"><Select value={providerWorkload} onChange={setProviderWorkload} options={WORKLOADS} /></Field>
          <Field label="Quantity"><input className={INPUT} type="number" min="0.000001" step="0.000001" value={providerQuantity} onChange={(event) => setProviderQuantity(event.target.value)} /></Field>
          <Field label="Currency"><input className={INPUT} maxLength={3} value={providerCurrency} onChange={(event) => setProviderCurrency(event.target.value.toUpperCase())} /></Field>
          <Field label="Provider cost (minor units)"><input className={INPUT} type="number" min="0" step="1" value={providerCostMinor} onChange={(event) => setProviderCostMinor(event.target.value)} /></Field>
          <Field label="Occurred at"><input className={INPUT} type="datetime-local" value={providerOccurredAt} onChange={(event) => setProviderOccurredAt(event.target.value)} /></Field>
          <Field label="Provider source"><Select value={providerSource} onChange={setProviderSource} options={["PROVIDER_EXPORT", "PROVIDER_API", "MANUAL"]} /></Field>
          <Field label="Provider invoice ref (optional)"><input className={INPUT} value={providerInvoiceRef} onChange={(event) => setProviderInvoiceRef(event.target.value)} maxLength={180} /></Field>
          <Field label="Source event reference"><input className={INPUT} value={providerSourceRef} onChange={(event) => setProviderSourceRef(event.target.value)} maxLength={255} /></Field>
          <div className="flex items-end"><button type="submit" className={PRIMARY} disabled={busy || !providerSourceRef.trim()}>Record provider cost</button></div>
        </form> : <Empty>saas.provider_costs.write is required to record provider cost events.</Empty>}
      </Panel>
      <Panel title="Provider invoice reconciliation history" subtitle="The API reconciles exact provider, invoice reference, currency and period. NO_PROVIDER_DATA means no events matched that invoice scope.">
        {visibleProviderRecon.length ? <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="border-b border-slate-200 text-[10px] uppercase text-slate-500"><tr><th className="py-2 pr-3">Provider / invoice</th><th className="py-2 pr-3">Period</th><th className="py-2 pr-3">Events</th><th className="py-2 pr-3">Ledger</th><th className="py-2 pr-3">Invoiced</th><th className="py-2 pr-3">Variance</th><th className="py-2">Status</th></tr></thead><tbody>{visibleProviderRecon.map((entry) => <tr key={String(entry.id)} className="border-b border-slate-100"><td className="py-3 pr-3"><p className="font-semibold">{valueOf(entry.providerCode)}</p><p className="text-[10px] text-slate-500">{valueOf(entry.invoiceReference)}</p></td><td className="py-3 pr-3">{valueOf(entry.periodStart)} → {valueOf(entry.periodEnd)}</td><td className="py-3 pr-3">{valueOf(entry.eventCount)}</td><td className="py-3 pr-3">{amount(entry.ledgerProviderCostMinor, entry.currency)}</td><td className="py-3 pr-3">{amount(entry.invoicedProviderCostMinor, entry.currency)}</td><td className="py-3 pr-3">{amount(entry.varianceMinor, entry.currency)}</td><td className="py-3"><Status value={entry.status} /></td></tr>)}</tbody></table></div> : <Empty>No provider invoice reconciliation snapshots are available.</Empty>}
      </Panel>
      <Panel title="Reconcile a provider invoice" subtitle="Reconciliation uses provider-cost records already linked to the selected invoice reference. It does not combine platform usage ledger estimates.">
        {canReconcileProvider ? <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => submit(event, "Provider invoice reconciliation", () => api().reconcileProviderInvoice(buildSaasProviderReconciliationPayload({
          provider_code: providerReconCode, invoice_reference: providerReconInvoice, reconciliation_version: providerReconVersion,
          period_start: providerReconStart, period_end: providerReconEnd, currency: providerReconCurrency,
          invoiced_provider_cost_minor: providerReconAmount, idempotency_key: newKey("provider-recon"),
        })))}>
          <Field label="Provider code"><input className={INPUT} value={providerReconCode} onChange={(event) => setProviderReconCode(event.target.value)} maxLength={60} /></Field>
          <Field label="Invoice reference"><input className={INPUT} value={providerReconInvoice} onChange={(event) => setProviderReconInvoice(event.target.value)} maxLength={180} /></Field>
          <Field label="Reconciliation version"><input className={INPUT} type="number" min="1" step="1" value={providerReconVersion} onChange={(event) => setProviderReconVersion(event.target.value)} /></Field>
          <Field label="Currency"><input className={INPUT} maxLength={3} value={providerReconCurrency} onChange={(event) => setProviderReconCurrency(event.target.value.toUpperCase())} /></Field>
          <Field label="Period from"><input className={INPUT} type="date" value={providerReconStart} onChange={(event) => setProviderReconStart(event.target.value)} /></Field>
          <Field label="Period through"><input className={INPUT} type="date" value={providerReconEnd} onChange={(event) => setProviderReconEnd(event.target.value)} /></Field>
          <Field label="Invoiced provider cost (minor units)"><input className={INPUT} type="number" min="0" step="1" value={providerReconAmount} onChange={(event) => setProviderReconAmount(event.target.value)} /></Field>
          <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || !providerReconInvoice.trim()}>Reconcile provider invoice</button></div>
        </form> : <Empty>saas.provider_costs.reconcile is required to reconcile provider invoices.</Empty>}
      </Panel>
    </div> : null}

    {activeTab === "RECONCILIATION" ? <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Record usage adjustment" subtitle="Adjustments are append-only billing records with mandatory reason code, reason and idempotency. Prefer narrow periods and reference an approved source document.">
          {canAdjust ? <form className="space-y-3" onSubmit={(event) => submit(event, "Usage adjustment", () => api().createAdjustment(buildSaasUsageAdjustmentPayload({
            period_start: adjustStart, period_end: adjustEnd, metric_code: adjustMetric,
            quantity_delta: adjustQuantity, cost_delta_minor: adjustCost, currency: adjustCurrency,
            reason_code: adjustReasonCode, reason: adjustReason, reference_ref: adjustReference, idempotency_key: newKey("adjustment"),
          })))}>
            <div className="grid grid-cols-2 gap-2"><Field label="Period from"><input className={INPUT} type="date" value={adjustStart} onChange={(event) => setAdjustStart(event.target.value)} /></Field><Field label="Period through"><input className={INPUT} type="date" value={adjustEnd} onChange={(event) => setAdjustEnd(event.target.value)} /></Field></div>
            <Field label="Metric filter (optional)"><Select value={adjustMetric} onChange={setAdjustMetric} options={METRICS} placeholder="All metrics" /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Quantity delta"><input className={INPUT} type="number" step="0.000001" value={adjustQuantity} onChange={(event) => setAdjustQuantity(event.target.value)} /></Field><Field label="Cost delta (minor units)"><input className={INPUT} type="number" step="1" value={adjustCost} onChange={(event) => setAdjustCost(event.target.value)} /></Field></div>
            <div className="grid grid-cols-2 gap-2"><Field label="Currency"><input className={INPUT} maxLength={3} value={adjustCurrency} onChange={(event) => setAdjustCurrency(event.target.value.toUpperCase())} /></Field><Field label="Reason code"><Select value={adjustReasonCode} onChange={setAdjustReasonCode} options={ADJUSTMENT_REASONS} /></Field></div>
            <Field label="Reason"><textarea className={AREA} value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} maxLength={2000} required placeholder="Approved usage correction or customer credit rationale…" /></Field>
            <Field label="Reference (optional)"><input className={INPUT} value={adjustReference} onChange={(event) => setAdjustReference(event.target.value)} maxLength={255} /></Field>
            <button className={PRIMARY} type="submit" disabled={busy || !adjustReason.trim()}>Record append-only adjustment</button>
          </form> : <Empty>saas.adjustments.write is required to record corrections or credits.</Empty>}
        </Panel>
        <Panel title="Reconcile tenant usage to customer invoice" subtitle="The API compares the scoped usage ledger estimate plus overlapping adjustments with invoiced minor units. A period over 35 days, unpriced usage or mixed currencies is not silently accepted.">
          {canReconcileUsage ? <form className="space-y-3" onSubmit={(event) => submit(event, "Usage invoice reconciliation", () => api().reconcileUsage(buildSaasUsageReconciliationPayload({
            invoice_reference: invoiceRef, reconciliation_version: invoiceVersion,
            period_start: invoiceStart, period_end: invoiceEnd, currency: invoiceCurrency,
            invoiced_amount_minor: invoiceAmount, idempotency_key: newKey("usage-recon"),
          })))}>
            <Field label="Invoice reference"><input className={INPUT} value={invoiceRef} onChange={(event) => setInvoiceRef(event.target.value)} maxLength={180} required /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Reconciliation version"><input className={INPUT} type="number" min="1" step="1" value={invoiceVersion} onChange={(event) => setInvoiceVersion(event.target.value)} /></Field><Field label="Currency"><input className={INPUT} maxLength={3} value={invoiceCurrency} onChange={(event) => setInvoiceCurrency(event.target.value.toUpperCase())} /></Field></div>
            <div className="grid grid-cols-2 gap-2"><Field label="Period from"><input className={INPUT} type="date" value={invoiceStart} onChange={(event) => setInvoiceStart(event.target.value)} /></Field><Field label="Period through"><input className={INPUT} type="date" value={invoiceEnd} onChange={(event) => setInvoiceEnd(event.target.value)} /></Field></div>
            <Field label="Invoiced amount (minor units)"><input className={INPUT} type="number" min="0" step="1" value={invoiceAmount} onChange={(event) => setInvoiceAmount(event.target.value)} /></Field>
            <button className={PRIMARY} type="submit" disabled={busy || !invoiceRef.trim()}>Create usage reconciliation snapshot</button>
          </form> : <Empty>saas.reconciliation.write is required to reconcile customer invoices.</Empty>}
        </Panel>
      </div>
      <Panel title="Usage invoice reconciliation history" subtitle="Immutable snapshots preserve ledger total, adjustment total, invoice amount, variance, event count and unpriced count.">
        {visibleUsageRecon.length ? <div className="overflow-x-auto"><table className="w-full min-w-[740px] text-left text-xs"><thead className="border-b border-slate-200 text-[10px] uppercase text-slate-500"><tr><th className="py-2 pr-3">Invoice</th><th className="py-2 pr-3">Period</th><th className="py-2 pr-3">Events</th><th className="py-2 pr-3">Unpriced</th><th className="py-2 pr-3">Expected</th><th className="py-2 pr-3">Invoiced</th><th className="py-2 pr-3">Variance</th><th className="py-2">Status</th></tr></thead><tbody>{visibleUsageRecon.map((entry) => <tr key={String(entry.id)} className="border-b border-slate-100"><td className="py-3 pr-3"><p className="font-semibold">{valueOf(entry.invoiceReference)}</p><p className="text-[10px] text-slate-500">v{valueOf(entry.reconciliationVersion)}</p></td><td className="py-3 pr-3">{valueOf(entry.periodStart)} → {valueOf(entry.periodEnd)}</td><td className="py-3 pr-3">{valueOf(entry.eventCount)}</td><td className="py-3 pr-3">{valueOf(entry.unpricedEventCount)}</td><td className="py-3 pr-3">{amount(entry.expectedAmountMinor, entry.currency)}</td><td className="py-3 pr-3">{amount(entry.invoicedAmountMinor, entry.currency)}</td><td className="py-3 pr-3">{amount(entry.varianceMinor, entry.currency)}</td><td className="py-3"><Status value={entry.status} /></td></tr>)}</tbody></table></div> : <Empty>No usage invoice reconciliation snapshots are available.</Empty>}
      </Panel>
      {latestResponse ? <Panel title="Latest operation response"><JsonView title="Immutable API response" data={latestResponse} /></Panel> : null}
    </div> : null}

    <footer className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[10px] leading-5 text-slate-500">
      Shared FactoryOS session · active factory {activeFactoryId} · tenant/factory scope applied by the backend · all writes use generated idempotency keys · amounts are displayed in exact minor currency units · estimated usage is not an invoice.
    </footer>
  </main>;
}
