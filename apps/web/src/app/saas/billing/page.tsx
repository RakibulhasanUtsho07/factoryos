"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildSaasBillingAccountPayload,
  buildSaasBillingClosePayload,
  buildSaasBillingActionPayload,
  buildSaasEntitlementModePayload,
  buildSaasSubscriptionPlanPayload,
  buildSaasSubscriptionTransitionPayload,
  buildSaasTrialPayload,
  createSaasCommercialClient,
  normalizeSaasCommercialRows,
} from "@/lib/saas-commercial-billing-workbench.mjs";
import type { SaasCommercialClient } from "@/lib/saas-commercial-billing-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "OVERVIEW" | "PLANS" | "SUBSCRIPTION" | "PROVIDER" | "BILLING";
type Notice = { tone: "success" | "error" | "warning"; message: string };

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24 font-mono text-xs leading-5";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";
const TAB_LIST: { id: Tab; label: string }[] = [
  { id: "OVERVIEW", label: "Overview" },
  { id: "PLANS", label: "Plans" },
  { id: "SUBSCRIPTION", label: "Subscription lifecycle" },
  { id: "PROVIDER", label: "Stripe account" },
  { id: "BILLING", label: "Billing & invoices" },
];

function newKey(prefix: string) {
  return prefix + "-" + globalThis.crypto.randomUUID();
}
function dateInput(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}
function localTimestamp(date: string) {
  return new Date(date + "T00:00:00").toISOString();
}
function localExclusiveEnd(date: string) {
  const value = new Date(date + "T00:00:00");
  value.setDate(value.getDate() + 1);
  return value.toISOString();
}
function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function rows(value: unknown, key?: string): Row[] {
  return normalizeSaasCommercialRows(value, key).map(row);
}
function valueOf(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}
function errorOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The commercial billing request could not be completed.";
}
function statusOf(cause: unknown): number {
  return cause && typeof cause === "object" && "status" in cause ? Number((cause as { status?: unknown }).status) : 0;
}
function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function money(value: unknown, currency: unknown): string {
  return valueOf(currency, "—") + " " + valueOf(value, "0") + " minor units";
}
function statusClass(value: unknown): string {
  const state = valueOf(value, "UNKNOWN").toUpperCase();
  if (["ACTIVE", "PAID", "MATCHED_PAID", "MATCHED_OPEN", "NO_CHARGE", "LEGACY_COMPATIBLE"].includes(state)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["TRIAL", "PREPARED", "ISSUING", "ISSUED", "PENDING", "SUBSCRIPTION_REQUIRED"].includes(state)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["SUSPENDED", "PAYMENT_FAILED", "RETRY_REQUIRED", "VARIANCE", "UNCOLLECTIBLE", "VOIDED", "TERMINATED", "EXPIRED"].includes(state)) return "border-rose-200 bg-rose-50 text-rose-800";
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
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p><p className="mt-2 break-words text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[10px] text-slate-500">{hint}</p></div>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center text-xs leading-5 text-slate-500">{children}</div>;
}
function JsonView({ title, data }: { title: string; data: unknown }) {
  let serialized = "No response";
  try { serialized = JSON.stringify(data, null, 2); } catch { serialized = String(data); }
  return <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-950 p-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-100">{serialized}</pre></div>;
}
function Select({ value, onChange, options, placeholder }: { value: string; onChange: (value: string) => void; options: string[]; placeholder?: string }) {
  return <select className={INPUT} value={value} onChange={(event) => onChange(event.target.value)}>{placeholder ? <option value="">{placeholder}</option> : null}{options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select>;
}

export default function SaasCommercialBillingWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(activeFactoryId);
  const canReadPlans = hasPermission("saas.subscription_plans.read");
  const canWritePlans = hasPermission("saas.subscription_plans.write");
  const canReadSubscription = hasPermission("saas.subscriptions.read");
  const canWriteSubscription = hasPermission("saas.subscriptions.write");
  const canReadMode = hasPermission("saas.entitlement_modes.read");
  const canWriteMode = hasPermission("saas.entitlement_modes.write");
  const canReadBilling = hasPermission("saas.billing.read");
  const canWriteAccount = hasPermission("saas.billing.account.write");
  const canCloseBilling = hasPermission("saas.billing.close");
  const canIssueBilling = hasPermission("saas.billing.issue");
  const canReconcileBilling = hasPermission("saas.billing.reconcile");
  const client = useMemo<SaasCommercialClient>(() => createSaasCommercialClient(request), [request]);

  const [tab, setTab] = useState<Tab>("OVERVIEW");
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Row[]>([]);
  const [subscription, setSubscription] = useState<Row | null>(null);
  const [subscriptionEvents, setSubscriptionEvents] = useState<Row[]>([]);
  const [entitlementMode, setEntitlementMode] = useState<Row | null>(null);
  const [billingAccount, setBillingAccount] = useState<Row | null>(null);
  const [billingCloses, setBillingCloses] = useState<Row[]>([]);
  const [selectedCloseId, setSelectedCloseId] = useState("");

  const [planCode, setPlanCode] = useState("BASIC");
  const [planName, setPlanName] = useState("Basic");
  const [planRank, setPlanRank] = useState("1");
  const [planDeployment, setPlanDeployment] = useState("SHARED_SAAS");
  const [planCapabilities, setPlanCapabilities] = useState("{}");
  const [trialPlan, setTrialPlan] = useState("");
  const [trialEnds, setTrialEnds] = useState(dateInput(14));
  const [transitionAction, setTransitionAction] = useState("ACTIVATE");
  const [transitionTarget, setTransitionTarget] = useState("");
  const [transitionStart, setTransitionStart] = useState(dateInput(0));
  const [transitionEnd, setTransitionEnd] = useState(dateInput(30));
  const [transitionReason, setTransitionReason] = useState("");
  const [entitlementTarget, setEntitlementTarget] = useState("LEGACY_COMPATIBLE");
  const [entitlementReason, setEntitlementReason] = useState("");
  const [entitlementConfirmed, setEntitlementConfirmed] = useState(false);

  const [stripeCustomerId, setStripeCustomerId] = useState("");
  const [billingCurrency, setBillingCurrency] = useState("BDT");
  const [collectionMethod, setCollectionMethod] = useState("charge_automatically");
  const [daysUntilDue, setDaysUntilDue] = useState("30");
  const [automaticTax, setAutomaticTax] = useState(false);
  const [taxBehavior, setTaxBehavior] = useState("exclusive");

  const [closeStart, setCloseStart] = useState(dateInput(-30));
  const [closeEnd, setCloseEnd] = useState(dateInput(0));
  const [closeCurrency, setCloseCurrency] = useState("BDT");
  const [issueConfirmed, setIssueConfirmed] = useState(false);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [reconcileConfirmed, setReconcileConfirmed] = useState(false);
  const [latestResponse, setLatestResponse] = useState<unknown>(null);
  const [latestReconciliation, setLatestReconciliation] = useState<Row | null>(null);

  useEffect(() => {
    let live = true;
    if (!connected) {
      setPlans([]);
      setSubscription(null);
      setSubscriptionEvents([]);
      setEntitlementMode(null);
      setBillingAccount(null);
      setBillingCloses([]);
      setSelectedCloseId("");
      setLoadErrors({});
      return () => { live = false; };
    }
    setLoading(true);
    const errors: Record<string, string> = {};
    const tasks: Promise<void>[] = [];
    if (canReadPlans) tasks.push((async () => {
      try {
        const value = await client.listPlans();
        if (live) {
          const next = rows(value, "items");
          setPlans(next);
          if (!trialPlan && next.length) setTrialPlan(valueOf(next.find((entry) => valueOf(entry.status) === "ACTIVE")?.planCode, valueOf(next[0]?.planCode, "")));
        }
      } catch (cause) { errors.plans = errorOf(cause); }
    })());
    if (canReadSubscription) tasks.push((async () => {
      try {
        const value = await client.getCurrentSubscription();
        const current = value ? row(value) : null;
        if (live) setSubscription(current);
        if (current && typeof current.id === "string") {
          const eventResponse = await client.listSubscriptionEvents(current.id);
          if (live) setSubscriptionEvents(rows(eventResponse, "items"));
        } else if (live) setSubscriptionEvents([]);
      } catch (cause) { errors.subscription = errorOf(cause); }
    })());
    if (canReadMode) tasks.push((async () => {
      try {
        const value = await client.getEntitlementMode();
        if (live) {
          const mode = row(value);
          setEntitlementMode(mode);
          setEntitlementTarget(valueOf(mode.mode, "LEGACY_COMPATIBLE"));
        }
      } catch (cause) { errors.entitlement = errorOf(cause); }
    })());
    if (canReadBilling) {
      tasks.push((async () => {
        try {
          const value = await client.getBillingAccount();
          if (live) {
            const account = row(row(value).account ?? value);
            setBillingAccount(account);
            setBillingCurrency(valueOf(account.currency, "BDT"));
            setCloseCurrency(valueOf(account.currency, "BDT"));
            setStripeCustomerId(valueOf(account.providerCustomerId, ""));
            setCollectionMethod(valueOf(account.collectionMethod, "charge_automatically"));
            setDaysUntilDue(valueOf(account.daysUntilDue, "30"));
            setAutomaticTax(account.automaticTaxEnabled === true);
            setTaxBehavior(valueOf(account.taxBehavior, "exclusive"));
          }
        } catch (cause) {
          if (statusOf(cause) === 404) {
            if (live) setBillingAccount(null);
          } else errors.billingAccount = errorOf(cause);
        }
      })());
      tasks.push((async () => {
        try {
          const value = await client.listBillingCloses({ limit: 50, offset: 0 });
          if (live) {
            const next = rows(value, "closes");
            setBillingCloses(next);
            setSelectedCloseId((current) => next.some((entry) => valueOf(row(entry.close).id) === current)
              ? current : valueOf(row(next[0]?.close).id, ""));
          }
        } catch (cause) { errors.closes = errorOf(cause); }
      })());
    }
    Promise.all(tasks).finally(() => {
      if (live) {
        setLoadErrors(errors);
        setLoading(false);
      }
    });
    return () => { live = false; };
  }, [
    connected, activeFactoryId, refreshTick, client,
    canReadPlans, canReadSubscription, canReadMode, canReadBilling,
  ]);

  const selectedCloseEntry = billingCloses.find((entry) => valueOf(row(entry.close).id) === selectedCloseId) ?? billingCloses[0] ?? null;
  const selectedClose = selectedCloseEntry ? row(selectedCloseEntry.close ?? selectedCloseEntry) : null;
  const selectedCloseEvents = selectedCloseEntry ? rows(selectedCloseEntry.events, "events") : [];
  const closeState = valueOf(selectedClose?.status, "UNKNOWN");
  const subscriptionStatus = valueOf(subscription?.status, "NONE");
  const activePlans = plans.filter((entry) => valueOf(entry.status) === "ACTIVE");
  const transitionOptions = subscriptionStatus === "TRIAL"
    ? ["ACTIVATE", "TERMINATE", "EXPIRE"]
    : subscriptionStatus === "ACTIVE"
      ? ["SUSPEND", "UPGRADE", "DOWNGRADE", "RENEW", "TERMINATE", "EXPIRE"]
      : subscriptionStatus === "SUSPENDED"
        ? ["RESUME", "TERMINATE", "EXPIRE"] : [];
  const transitionNeedsPeriod = ["ACTIVATE", "RESUME", "RENEW"].includes(transitionAction);
  const transitionNeedsPlan = ["UPGRADE", "DOWNGRADE"].includes(transitionAction);
  const canRetryPayment = canIssueBilling && closeState === "PAYMENT_FAILED"
    && valueOf(billingAccount?.collectionMethod) === "charge_automatically";

  async function perform(label: string, work: () => Promise<unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await work();
      setLatestResponse(response);
      setNotice({ tone: "success", message: label + " completed. The server response has been captured below." });
      setIssueConfirmed(false);
      setRetryConfirmed(false);
      setReconcileConfirmed(false);
      setEntitlementConfirmed(false);
      setRefreshTick((value) => value + 1);
      return response;
    } catch (cause) {
      setNotice({ tone: "error", message: errorOf(cause) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, label: string, work: () => Promise<unknown>) {
    event.preventDefault();
    void perform(label, work);
  }

  const canUseWorkspace = connected && Boolean(snapshot);
  const missingPermissions = [
    !canReadPlans && !canWritePlans ? "saas.subscription_plans.read/write" : "",
    !canReadSubscription && !canWriteSubscription ? "saas.subscriptions.read/write" : "",
    !canReadBilling && !canWriteAccount && !canCloseBilling ? "saas.billing.*" : "",
  ].filter(Boolean);

  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">SaaS administration</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Commercial billing & subscriptions</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Versioned subscription plans, controlled tenant lifecycle, entitlement enforcement and Stripe invoice operations. Usage metering and retention remain in their separate workbenches.</p>
      </div>
      <div className="flex items-center gap-2">
        <Status value={connected ? "SESSION_CONNECTED" : status.toUpperCase()} />
        <button type="button" className={SECONDARY} disabled={!canUseWorkspace || loading || busy} onClick={() => setRefreshTick((value) => value + 1)}>Refresh data</button>
      </div>
    </div>

    {!canUseWorkspace ? <Panel title="Connect a FactoryOS workspace session" subtitle="Commercial operations use the verified tenant identity and selected active factory transport context.">
      <Empty>Open Session, connect with a short-lived access token, verify the tenant and select an active factory before using this workbench.</Empty>
      <a href="/session" className={PRIMARY + " mt-3"}>Open session</a>
    </Panel> : null}

    {notice ? <div role="status" aria-live="polite" className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : notice.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-rose-200 bg-rose-50 text-rose-900")}>{notice.message}</div> : null}
    {Object.keys(loadErrors).length ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950"><p className="font-bold">Some commercial data could not be loaded.</p>{Object.entries(loadErrors).map(([key, message]) => <p key={key} className="mt-1"><span className="font-semibold">{key}:</span> {message}</p>)}</div> : null}
    {missingPermissions.length ? <p className="text-[10px] leading-5 text-slate-500">Unavailable areas are hidden or read-only according to the authenticated IAM permission snapshot. Missing permission families: {missingPermissions.join(", ")}. Backend guards remain authoritative.</p> : null}

    {canUseWorkspace ? <>
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {TAB_LIST.map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-pressed={tab === item.id} className={"min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
      </div>
      {loading ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">Loading authorized tenant billing records…</div> : null}

      {tab === "OVERVIEW" ? <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Subscription" value={subscriptionStatus.replaceAll("_", " ")} hint={subscription ? valueOf(subscription.planCode) + " · v" + valueOf(subscription.version) : "No current subscription returned"} />
          <Metric label="Available plans" value={canReadPlans ? plans.length : "—"} hint="Latest version per plan code" />
          <Metric label="Billing provider" value={valueOf(billingAccount?.provider, "Not configured")} hint={billingAccount ? valueOf(billingAccount.currency) + " · " + valueOf(billingAccount.collectionMethod) : "Stripe account configuration is separate"} />
          <Metric label="Billing close records" value={canReadBilling ? billingCloses.length : "—"} hint="Most recent API response page" />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Tenant subscription" subtitle="State and plan snapshots are returned by the subscription API; this is not a forecast of future renewals.">
            {canReadSubscription && subscription ? <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-lg font-bold text-slate-950">{valueOf(subscription.planName, valueOf(subscription.planCode))}</p><p className="text-xs text-slate-500">{valueOf(subscription.planCode)} · plan version {valueOf(subscription.planVersion)}</p></div><Status value={subscription.status} /></div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Trial ends</p><p className="mt-1 text-xs font-semibold">{formatDate(subscription.trialEndsAt)}</p></div>
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Current period</p><p className="mt-1 text-xs font-semibold">{formatDate(subscription.currentPeriodStart)} → {formatDate(subscription.currentPeriodEnd)}</p></div>
              </div>
              <p className="text-[10px] text-slate-500">Subscription ID {valueOf(subscription.id)} · last transition {formatDate(subscription.lastTransitionAt)}</p>
            </div> : <Empty>{canReadSubscription ? "No subscription record is currently returned for this tenant." : "saas.subscriptions.read is required."}</Empty>}
          </Panel>
          <Panel title="Entitlement enforcement" subtitle="Changing to subscription-required mode is a tenant-wide policy cutover. Confirm existing tenant eligibility and customer communication before enabling it.">
            {canReadMode && entitlementMode ? <div className="flex flex-wrap items-start justify-between gap-3">
              <div><Status value={entitlementMode.mode} /><p className="mt-2 text-xs text-slate-600">Version {valueOf(entitlementMode.version)} · source {valueOf(entitlementMode.source)}</p><p className="mt-1 max-w-lg text-xs text-slate-500">{valueOf(entitlementMode.reason, "No explicit reason; backend legacy-compatible default is active.")}</p></div>
              <p className="text-[10px] text-slate-500">Effective {formatDate(entitlementMode.effectiveAt)}</p>
            </div> : <Empty>{canReadMode ? "Entitlement mode is not available." : "saas.entitlement_modes.read is required."}</Empty>}
          </Panel>
        </div>
        <Panel title="Recent billing closes" subtitle="Prepared close snapshots are not invoices. Provider invoice creation and payment are separate explicit operations.">
          {canReadBilling && billingCloses.length ? <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="border-b border-slate-200 text-[10px] uppercase text-slate-500"><tr><th className="py-2 pr-3">Period</th><th className="py-2 pr-3">Expected subtotal</th><th className="py-2 pr-3">Invoice</th><th className="py-2 pr-3">Status</th><th className="py-2">Record</th></tr></thead><tbody>{billingCloses.slice(0, 8).map((entry) => { const close = row(entry.close ?? entry); return <tr key={valueOf(close.id)} className="border-b border-slate-100"><td className="py-3 pr-3">{formatDate(close.periodStart)} → {formatDate(close.periodEnd)}</td><td className="py-3 pr-3">{money(close.expectedSubtotalMinor, close.currency)}</td><td className="py-3 pr-3">{valueOf(close.providerInvoiceId, "Not issued")}</td><td className="py-3 pr-3"><Status value={close.status} /></td><td className="py-3"><button type="button" className="font-semibold text-blue-700 underline" onClick={() => { setSelectedCloseId(valueOf(close.id)); setTab("BILLING"); }}>Inspect</button></td></tr>; })}</tbody></table></div> : <Empty>{canReadBilling ? "No billing close has been prepared yet." : "saas.billing.read is required to view billing records."}</Empty>}
        </Panel>
      </> : null}

      {tab === "PLANS" ? <div className="space-y-4">
        <Panel title="Create a subscription plan version" subtitle="The API creates an immutable new version for a plan code. This workbench does not overwrite historical versions or automatically assign plans to a tenant.">
          {canWritePlans ? <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" onSubmit={(event) => submit(event, "Subscription plan version", () => client.createPlan(buildSaasSubscriptionPlanPayload({
            plan_code: planCode, display_name: planName, tier_rank: planRank, deployment_profile: planDeployment,
            status: "ACTIVE", capabilities: planCapabilities, idempotency_key: newKey("plan-version"),
          })))}>
            <Field label="Plan code"><input className={INPUT} value={planCode} onChange={(event) => setPlanCode(event.target.value.toUpperCase())} maxLength={80} required /></Field>
            <Field label="Display name"><input className={INPUT} value={planName} onChange={(event) => setPlanName(event.target.value)} maxLength={160} required /></Field>
            <Field label="Tier rank"><input className={INPUT} type="number" min="1" max="1000000" step="1" value={planRank} onChange={(event) => setPlanRank(event.target.value)} required /></Field>
            <Field label="Deployment profile"><Select value={planDeployment} onChange={setPlanDeployment} options={["SHARED_SAAS", "SINGLE_TENANT", "DEDICATED_VPC", "HYBRID_EDGE_CLOUD"]} /></Field>
            <Field label="Capability JSON" hint="Enter only capability keys supported by your tenant's product contract. The API stores this object as the plan snapshot."><textarea className={AREA} value={planCapabilities} onChange={(event) => setPlanCapabilities(event.target.value)} maxLength={16384} /></Field>
            <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy}>Create plan version</button></div>
          </form> : <Empty>saas.subscription_plans.write is required to create a plan version.</Empty>}
        </Panel>
        <Panel title="Current plan catalogue" subtitle="The subscription service returns the latest stored version per plan code. Older immutable versions remain in the API history but are not listed by this endpoint.">
          {canReadPlans && plans.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{plans.map((plan) => <article key={valueOf(plan.id)} className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-2"><div><p className="text-sm font-bold text-slate-950">{valueOf(plan.displayName)}</p><p className="mt-1 text-[10px] text-slate-500">{valueOf(plan.planCode)} · v{valueOf(plan.version)}</p></div><Status value={plan.status} /></div>
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-600"><span className="rounded-full bg-slate-100 px-2 py-1">Tier {valueOf(plan.tierRank)}</span><span className="rounded-full bg-slate-100 px-2 py-1">{valueOf(plan.deploymentProfile)}</span></div>
            <details className="mt-3"><summary className="cursor-pointer text-[10px] font-semibold text-blue-700">Capability snapshot</summary><pre className="mt-2 overflow-auto rounded-lg bg-slate-950 p-3 text-[10px] text-slate-100">{JSON.stringify(plan.capabilities ?? {}, null, 2)}</pre></details>
            <p className="mt-3 text-[10px] text-slate-400">Created {formatDate(plan.createdAt)}</p>
          </article>)}</div> : <Empty>{canReadPlans ? "No subscription plans are registered for this tenant." : "saas.subscription_plans.read is required."}</Empty>}
        </Panel>
      </div> : null}

      {tab === "SUBSCRIPTION" ? <div className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Start a trial" subtitle="Only one non-terminal subscription can exist for a tenant. Starting a trial is explicit and requires an active plan code.">
            {canWriteSubscription ? <form className="space-y-3" onSubmit={(event) => submit(event, "Subscription trial", () => client.startTrial(buildSaasTrialPayload({
              plan_code: trialPlan, trial_ends_at: localTimestamp(trialEnds), idempotency_key: newKey("trial"),
            })))}>
              <Field label="Active plan"><select className={INPUT} value={trialPlan} onChange={(event) => setTrialPlan(event.target.value)} required><option value="">Select a plan</option>{activePlans.map((plan) => <option key={valueOf(plan.id)} value={valueOf(plan.planCode)}>{valueOf(plan.displayName)} ({valueOf(plan.planCode)})</option>)}</select></Field>
              <Field label="Trial ends"><input className={INPUT} type="date" value={trialEnds} onChange={(event) => setTrialEnds(event.target.value)} required /></Field>
              <button type="submit" className={PRIMARY} disabled={busy || !trialPlan || Boolean(subscription && !["TERMINATED", "EXPIRED"].includes(subscriptionStatus))}>Start tenant trial</button>
              {subscription && !["TERMINATED", "EXPIRED"].includes(subscriptionStatus) ? <p className="text-[10px] text-amber-800">A non-terminal subscription already exists. End-state resolution remains a server-side requirement.</p> : null}
            </form> : <Empty>saas.subscriptions.write is required to start a trial.</Empty>}
          </Panel>
          <Panel title="Subscription lifecycle transition" subtitle="The server enforces valid state transitions, plan tier direction, version checks and event idempotency. Reload after a conflict; do not blindly retry with the same stale version.">
            {canWriteSubscription && subscription && transitionOptions.length ? <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => submit(event, "Subscription transition", () => client.transitionSubscription(String(subscription.id), buildSaasSubscriptionTransitionPayload({
              action: transitionAction, expected_version: subscription.version, target_plan_code: transitionTarget,
              period_start: transitionNeedsPeriod ? localTimestamp(transitionStart) : undefined,
              period_end: transitionNeedsPeriod ? localExclusiveEnd(transitionEnd) : undefined,
              reason: transitionReason, idempotency_key: newKey("subscription-transition"),
            })))}>
              <Field label="Allowed action"><Select value={transitionAction} onChange={(value) => { setTransitionAction(value); setTransitionTarget(""); }} options={transitionOptions} /></Field>
              {transitionNeedsPlan ? <Field label="Target active plan"><select className={INPUT} value={transitionTarget} onChange={(event) => setTransitionTarget(event.target.value)} required><option value="">Select a different plan</option>{activePlans.filter((plan) => valueOf(plan.planCode) !== valueOf(subscription.planCode)).map((plan) => <option key={valueOf(plan.id)} value={valueOf(plan.planCode)}>{valueOf(plan.displayName)} · tier {valueOf(plan.tierRank)}</option>)}</select></Field> : null}
              {transitionNeedsPeriod ? <><Field label="Period starts"><input className={INPUT} type="date" value={transitionStart} onChange={(event) => setTransitionStart(event.target.value)} required /></Field><Field label="Period ends (inclusive)"><input className={INPUT} type="date" value={transitionEnd} min={transitionStart} onChange={(event) => setTransitionEnd(event.target.value)} required /></Field></> : null}
              <Field label="Reason"><textarea className={AREA} value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} maxLength={1000} required placeholder="Record the approved business reason…" /></Field>
              <div className="flex items-end"><button className={transitionAction === "TERMINATE" ? DANGER : PRIMARY} type="submit" disabled={busy || !transitionReason.trim() || (transitionNeedsPlan && !transitionTarget)}>Apply {transitionAction.toLowerCase()} transition</button></div>
            </form> : <Empty>{!canWriteSubscription ? "saas.subscriptions.write is required." : !subscription ? "No current subscription is available to transition." : "This subscription is terminal; no further transitions are permitted."}</Empty>}
          </Panel>
        </div>
        <Panel title="Entitlement enforcement mode" subtitle="The mode update uses compare-and-swap expected_version and an audit reason. This is a tenant-wide authorization policy choice, not a billing switch.">
          {canReadMode && entitlementMode ? <div className="mb-4 flex flex-wrap items-center gap-3"><Status value={entitlementMode.mode} /><span className="text-xs text-slate-500">Version {valueOf(entitlementMode.version)} · {valueOf(entitlementMode.source)}</span></div> : <p className="mb-3 text-xs text-slate-500">Current mode details require saas.entitlement_modes.read.</p>}
          {canWriteMode ? <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => submit(event, "Entitlement enforcement mode", () => client.setEntitlementMode(buildSaasEntitlementModePayload({
            mode: entitlementTarget, expected_version: entitlementMode?.version ?? 0,
            reason: entitlementReason, idempotency_key: newKey("entitlement-mode"),
          })))}>
            <Field label="Target mode"><Select value={entitlementTarget} onChange={(value) => { setEntitlementTarget(value); setEntitlementConfirmed(false); }} options={["LEGACY_COMPATIBLE", "SUBSCRIPTION_REQUIRED"]} /></Field>
            <Field label="Change reason"><textarea className={AREA} value={entitlementReason} onChange={(event) => setEntitlementReason(event.target.value)} maxLength={2000} required /></Field>
            {entitlementTarget === "SUBSCRIPTION_REQUIRED" ? <label className="sm:col-span-2 flex items-start gap-2 text-xs leading-5 text-rose-800"><input className="mt-1 size-4" type="checkbox" checked={entitlementConfirmed} onChange={(event) => setEntitlementConfirmed(event.target.checked)} /><span>I confirm this tenant-wide cutover has an approved readiness review and a valid active/trial subscription where required.</span></label> : null}
            <div className="flex items-end"><button className={entitlementTarget === "SUBSCRIPTION_REQUIRED" ? DANGER : PRIMARY} type="submit" disabled={busy || !entitlementReason.trim() || (entitlementTarget === "SUBSCRIPTION_REQUIRED" && !entitlementConfirmed) || !canReadMode}>Update enforcement mode</button></div>
          </form> : <Empty>saas.entitlement_modes.write is required to change the enforcement mode.</Empty>}
        </Panel>
        <Panel title="Immutable subscription event history" subtitle="Ordered server events capture version, from/to status, plan version, effective time and the actor.">
          {canReadSubscription && subscriptionEvents.length ? <div className="space-y-2">{subscriptionEvents.map((entry) => <article key={valueOf(entry.id)} className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_auto] sm:items-center"><div><p className="text-xs font-bold text-slate-900">{valueOf(entry.eventType).replaceAll("_", " ")}</p><p className="mt-1 text-[10px] text-slate-500">Version {valueOf(entry.subscriptionVersion)} · {valueOf(entry.fromStatus, "Initial")} → {valueOf(entry.toStatus)}</p><p className="mt-1 text-[10px] text-slate-500">Plan {valueOf(entry.planCode)} v{valueOf(entry.planVersion)} · effective {formatDate(entry.effectiveAt)}</p>{entry.reason ? <p className="mt-1 text-xs text-slate-600">{valueOf(entry.reason)}</p> : null}</div><p className="text-[10px] text-slate-400">{formatDate(entry.createdAt)}</p></article>)}</div> : <Empty>{canReadSubscription ? "No subscription events are available yet." : "saas.subscriptions.read is required."}</Empty>}
        </Panel>
      </div> : null}

      {tab === "PROVIDER" ? <div className="space-y-4">
        <Panel title="Stripe customer binding" subtitle="The backend verifies the Stripe customer against its connected provider account before saving. Only the Stripe customer identifier is entered here; API keys, webhook secrets and bearer credentials are never collected by this page.">
          {billingAccount ? <div className="mb-4 grid gap-3 sm:grid-cols-3"><Metric label="Provider" value={valueOf(billingAccount.provider)} hint="Server configured provider adapter" /><Metric label="Account version" value={valueOf(billingAccount.version)} hint="Optimistic concurrency version" /><Metric label="Tax" value={billingAccount.automaticTaxEnabled ? "Enabled" : "Disabled"} hint={valueOf(billingAccount.taxBehavior, "No tax behavior")} /></div> : <p className="mb-4 text-xs text-amber-800">No Stripe billing account is configured for this tenant yet.</p>}
          {canWriteAccount ? <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" onSubmit={(event) => submit(event, "Stripe billing account", () => client.configureBillingAccount(buildSaasBillingAccountPayload({
            provider_customer_id: stripeCustomerId, currency: billingCurrency, collection_method: collectionMethod,
            days_until_due: collectionMethod === "send_invoice" ? daysUntilDue : undefined,
            automatic_tax_enabled: automaticTax, tax_behavior: automaticTax ? taxBehavior : undefined,
            expected_version: billingAccount?.version ?? 0, idempotency_key: newKey("stripe-account"),
          })))}>
            <Field label="Stripe customer ID"><input className={INPUT} value={stripeCustomerId} onChange={(event) => setStripeCustomerId(event.target.value)} maxLength={120} placeholder="cus_…" required /></Field>
            <Field label="Invoice currency"><input className={INPUT} value={billingCurrency} onChange={(event) => setBillingCurrency(event.target.value.toUpperCase())} maxLength={3} required /></Field>
            <Field label="Collection method"><Select value={collectionMethod} onChange={setCollectionMethod} options={["charge_automatically", "send_invoice"]} /></Field>
            {collectionMethod === "send_invoice" ? <Field label="Days until due"><input className={INPUT} type="number" min="1" max="120" value={daysUntilDue} onChange={(event) => setDaysUntilDue(event.target.value)} required /></Field> : null}
            <Field label="Automatic tax"><Select value={automaticTax ? "true" : "false"} onChange={(value) => setAutomaticTax(value === "true")} options={["false", "true"]} /></Field>
            {automaticTax ? <Field label="Tax behavior"><Select value={taxBehavior} onChange={setTaxBehavior} options={["exclusive", "inclusive"]} /></Field> : null}
            <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || !stripeCustomerId.trim()}>Validate and save Stripe customer</button></div>
          </form> : <Empty>saas.billing.account.write is required to configure the provider account.</Empty>}
          {billingAccount ? <p className="mt-4 text-[10px] leading-5 text-slate-500">Bound customer {valueOf(billingAccount.providerCustomerId)} · collection {valueOf(billingAccount.collectionMethod)} · last updated {formatDate(billingAccount.updatedAt)}. Updating requires expected version {valueOf(billingAccount.version)}; a stale update must be reloaded.</p> : null}
        </Panel>
        <Panel title="Provider setup safety" subtitle="Provider integration is performed on the backend using configured server credentials.">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-slate-600">
            <li>Customer validation is performed by the Stripe provider adapter.</li>
            <li>Automatic collection and send-invoice collection use different recovery paths.</li>
            <li>Send-invoice requires a due-days value; automatic collection must omit it.</li>
            <li>Tax behavior is only accepted when automatic tax is enabled.</li>
            <li>Stripe webhook verification and invoice metadata binding remain backend responsibilities.</li>
          </ul>
        </Panel>
      </div> : null}

      {tab === "BILLING" ? <div className="space-y-4">
        <Panel title="Prepare an immutable billing close" subtitle="The backend snapshots usage, append-only adjustments, subscription plan/version and provider configuration. Maximum period is 35 days. This step prepares evidence only; it does not issue an invoice.">
          {canCloseBilling ? <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => submit(event, "Billing close", () => client.createBillingClose(buildSaasBillingClosePayload({
            period_start: localTimestamp(closeStart), period_end: localExclusiveEnd(closeEnd),
            currency: closeCurrency, idempotency_key: newKey("billing-close"),
          })))}>
            <Field label="Period starts"><input className={INPUT} type="date" value={closeStart} onChange={(event) => setCloseStart(event.target.value)} required /></Field>
            <Field label="Period ends (inclusive)"><input className={INPUT} type="date" value={closeEnd} min={closeStart} onChange={(event) => setCloseEnd(event.target.value)} required /></Field>
            <Field label="Currency"><input className={INPUT} value={closeCurrency} onChange={(event) => setCloseCurrency(event.target.value.toUpperCase())} maxLength={3} required /></Field>
            <div className="flex items-end"><button className={PRIMARY} type="submit" disabled={busy || !billingAccount}>Prepare immutable close snapshot</button></div>
          </form> : <Empty>saas.billing.close is required to prepare a billing close.</Empty>}
          {!billingAccount ? <p className="mt-3 text-[10px] text-amber-800">Configure and validate a Stripe customer before preparing the close.</p> : null}
        </Panel>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Panel title="Billing close register" subtitle="A billing close is not an issued invoice. Select a record to inspect its line snapshot and provider event history.">
            {canReadBilling && billingCloses.length ? <div className="space-y-2">{billingCloses.map((entry) => { const close = row(entry.close ?? entry); const selected = valueOf(close.id) === selectedCloseId; return <button key={valueOf(close.id)} type="button" onClick={() => { setSelectedCloseId(valueOf(close.id)); setIssueConfirmed(false); setRetryConfirmed(false); setReconcileConfirmed(false); }} aria-pressed={selected} className={"w-full rounded-xl border p-3 text-left " + (selected ? "border-slate-950 bg-slate-50" : "border-slate-200 hover:bg-slate-50")}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-900">{formatDate(close.periodStart)} → {formatDate(close.periodEnd)}</span><Status value={close.status} /></div><p className="mt-1 text-[10px] text-slate-500">{money(close.expectedSubtotalMinor, close.currency)} · {valueOf(close.usageEventCount)} usage events · {valueOf(close.adjustmentCount)} adjustments</p><p className="mt-1 truncate text-[10px] text-slate-400">{valueOf(close.id)}</p></button>; })}</div> : <Empty>{canReadBilling ? "No billing closes are registered." : "saas.billing.read is required."}</Empty>}
          </Panel>
          <Panel title="Selected close snapshot" subtitle="Snapshot totals and provider receipts come from the server. Currency values remain exact integer minor units.">
            {selectedClose ? <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><Status value={selectedClose.status} /><span className="text-[10px] text-slate-500">Created {formatDate(selectedClose.createdAt)}</span></div>
              <Metric label="Expected subtotal" value={money(selectedClose.expectedSubtotalMinor, selectedClose.currency)} hint="Provider tax, discounts and final total are determined by Stripe." />
              <div className="grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Usage</p><p className="mt-1 font-semibold">{money(selectedClose.usageAmountMinor, selectedClose.currency)}</p><p className="text-[10px] text-slate-500">{valueOf(selectedClose.usageEventCount)} events</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Adjustments</p><p className="mt-1 font-semibold">{money(selectedClose.adjustmentAmountMinor, selectedClose.currency)}</p><p className="text-[10px] text-slate-500">{valueOf(selectedClose.adjustmentCount)} records</p></div></div>
              <p className="break-all text-[10px] text-slate-500">Snapshot SHA-256: {valueOf(selectedClose.snapshotHash)}</p>
              <p className="break-all text-[10px] text-slate-500">Stripe invoice: {valueOf(selectedClose.providerInvoiceId, "Not issued")}</p>
            </div> : <Empty>Select a billing close record to inspect its server snapshot.</Empty>}
          </Panel>
        </div>

        {selectedClose ? <>
          <Panel title="Explicit provider invoice actions" subtitle="Issue and payment recovery can trigger external Stripe operations. Review the immutable close and confirm the operation deliberately.">
            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs font-bold text-slate-900">Issue invoice</p>
                <p className="mt-1 text-[10px] leading-5 text-slate-500">Creates/finalizes the exact Stripe invoice bound to the close markers. Auto collection may attempt payment during issue.</p>
                {canIssueBilling && !["PAID", "VOIDED", "UNCOLLECTIBLE", "NO_CHARGE"].includes(closeState) ? <div className="mt-3 space-y-2"><label className="flex items-start gap-2 text-[10px] leading-4 text-rose-800"><input type="checkbox" className="mt-0.5 size-4" checked={issueConfirmed} onChange={(event) => setIssueConfirmed(event.target.checked)} /><span>I reviewed the exact close period and expected subtotal, and authorize an external Stripe invoice operation.</span></label><button type="button" className={PRIMARY} disabled={busy || !issueConfirmed} onClick={() => void perform("Stripe invoice issue", () => client.issueInvoice(String(selectedClose.id)))}>Issue provider invoice</button></div> : <p className="mt-3 text-[10px] text-slate-500">Invoice issuance is unavailable or already terminal.</p>}
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs font-bold text-slate-900">Retry failed automatic payment</p>
                <p className="mt-1 text-[10px] leading-5 text-slate-500">Only a recorded payment failure on an open invoice using charge_automatically can be retried. Send-invoice receivables must be recovered outside this automatic retry.</p>
                {canRetryPayment ? <div className="mt-3 space-y-2"><label className="flex items-start gap-2 text-[10px] leading-4 text-rose-800"><input type="checkbox" className="mt-0.5 size-4" checked={retryConfirmed} onChange={(event) => setRetryConfirmed(event.target.checked)} /><span>I authorize a new Stripe payment attempt for this failed close.</span></label><button type="button" className={DANGER} disabled={busy || !retryConfirmed} onClick={() => void perform("Stripe payment retry", () => client.retryPayment(String(selectedClose.id), buildSaasBillingActionPayload({ idempotency_key: newKey("payment-retry") })))}>Retry payment</button></div> : <p className="mt-3 text-[10px] text-slate-500">No eligible automatic payment retry is currently indicated by the server close state.</p>}
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs font-bold text-slate-900">Reconcile invoice</p>
                <p className="mt-1 text-[10px] leading-5 text-slate-500">Fetches the provider invoice and line items, then stores an immutable comparison of customer, currency, tax, discounts, amounts and line markers.</p>
                {canReconcileBilling && selectedClose.providerInvoiceId ? <div className="mt-3 space-y-2"><label className="flex items-start gap-2 text-[10px] leading-4 text-slate-700"><input type="checkbox" className="mt-0.5 size-4" checked={reconcileConfirmed} onChange={(event) => setReconcileConfirmed(event.target.checked)} /><span>I authorize a live provider read and immutable reconciliation snapshot.</span></label><button type="button" className={SECONDARY} disabled={busy || !reconcileConfirmed} onClick={() => void perform("Stripe invoice reconciliation", async () => { const value = await client.reconcileInvoice(String(selectedClose.id), buildSaasBillingActionPayload({ idempotency_key: newKey("billing-reconcile") })); setLatestReconciliation(row(row(value).reconciliation)); return value; })}>Reconcile provider invoice</button></div> : <p className="mt-3 text-[10px] text-slate-500">saas.billing.reconcile and an issued provider invoice are required.</p>}
              </div>
            </div>
          </Panel>
          <Panel title="Immutable provider event history" subtitle="Events are append-only; the server resolves paid and failed outcomes without trusting arrival order.">
            {selectedCloseEvents.length ? <div className="space-y-2">{selectedCloseEvents.map((entry) => <div key={valueOf(entry.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2"><div><p className="text-xs font-semibold text-slate-900">{valueOf(entry.type).replaceAll("_", " ")}</p><p className="mt-1 text-[10px] text-slate-500">Invoice {valueOf(entry.providerInvoiceId, "—")} · provider status {valueOf(entry.providerInvoiceStatus, "—")}</p></div><span className="text-[10px] text-slate-400">{formatDate(entry.createdAt)}</span></div>)}</div> : <Empty>No provider events were returned for this close.</Empty>}
          </Panel>
        </> : null}
        {latestReconciliation ? <Panel title="Latest provider reconciliation"><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Result" value={valueOf(latestReconciliation.status)} hint="Provider invoice comparison status" /><Metric label="Expected subtotal" value={money(latestReconciliation.expectedSubtotalMinor, latestReconciliation.currency)} hint="Immutable close amount" /><Metric label="Provider total" value={money(latestReconciliation.providerTotalMinor, latestReconciliation.currency)} hint="Stripe invoice total including tax" /><Metric label="Line binding" value={latestReconciliation.lineBindingValid === true ? "Valid" : "Not valid"} hint="Provider lines matched to FactoryOS close markers" /></div><div className="mt-3"><JsonView title="Reconciliation evidence" data={latestReconciliation} /></div></Panel> : null}
      </div> : null}
    </> : null}

    {latestResponse ? <Panel title="Latest operation receipt" subtitle="This displays the exact response returned by the API; success in the browser does not replace provider, finance or customer acceptance."><JsonView title="API response" data={latestResponse} /></Panel> : null}
    <footer className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[10px] leading-5 text-slate-500">
      Verified tenant identity and selected active factory session · permission-gated client actions · backend IAM remains authoritative · immutable versioned records · generated idempotency keys · Stripe secrets stay server-side · invoice issue, payment retry and reconciliation are separate explicit operations.
    </footer>
  </main>;
}
