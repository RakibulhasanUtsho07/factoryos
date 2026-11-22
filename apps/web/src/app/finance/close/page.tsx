"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildFinanceCloseActionPayload,
  buildFinanceCloseCreatePayload,
  filterFinanceClosePeriods,
  financeCloseReadiness,
  normalizeFinanceCloseRows,
  summarizeFinanceClosePeriods,
} from "@/lib/finance-period-close.mjs";
import type {
  FinanceClosePeriod,
  FinanceClosePerformance,
  FinanceCloseWorkingCapitalPosition,
} from "@/lib/finance-period-close.mjs";

type CreateDraft = {
  period_start: string;
  period_end: string;
  currency: string;
  reason: string;
};
type TransitionKind = "REFRESH" | "SUBMIT" | "RECALL" | "APPROVE";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function dateOnly(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function monthDraft(): CreateDraft {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    period_start: dateOnly(start),
    period_end: dateOnly(end),
    currency: "BDT",
    reason: "",
  };
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function numeric(value: unknown, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })
    : "—";
}

function money(value: unknown, currency: string) {
  const result = numeric(value);
  return result === "—" ? result : currency + " " + result;
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function StatusPill({ value }: { value: string }) {
  const status = value.toUpperCase();
  const tone = status === "APPROVED"
    ? "bg-emerald-50 text-emerald-800"
    : status === "SUBMITTED"
      ? "bg-blue-50 text-blue-800"
      : "bg-amber-50 text-amber-900";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide " + tone}>{status}</span>;
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "slate" | "blue" | "amber" | "emerald";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return (
    <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p>
    </article>
  );
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

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";

function PerformanceCard({ performance, currency }: { performance: FinanceClosePerformance | null; currency: string }) {
  if (!performance) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-4 text-xs text-slate-500">No period-costing facts were available in the persisted close snapshot.</p>;
  }
  const values = [
    ["Actual revenue", performance.actual_revenue],
    ["Actual cost", performance.actual_cost],
    ["Contribution cost", performance.actual_contribution_cost],
    ["Gross margin", performance.actual_gross_margin],
    ["Contribution margin", performance.actual_contribution_margin],
    ["Forecast revenue", performance.forecast_revenue],
    ["Forecast cost", performance.forecast_cost],
    ["Revenue variance", performance.revenue_variance],
    ["Cost variance", performance.cost_variance],
    ["Gross margin variance", performance.gross_margin_variance],
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {values.map(([label, value]) => (
        <div key={label} className="rounded-xl bg-slate-50 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-1 text-sm font-bold tabular-nums text-slate-950">{money(value, currency)}</p>
        </div>
      ))}
      <p className="sm:col-span-2 xl:col-span-5 text-[10px] text-slate-500">
        {numeric(performance.actual_fact_count, 0)} actual facts · {numeric(performance.forecast_fact_count, 0)} forecast facts. Forecast and actual amounts remain separated; no implicit FX conversion is performed.
      </p>
    </div>
  );
}

function WorkingCapitalCard({ rows, currency }: { rows: FinanceCloseWorkingCapitalPosition[]; currency: string }) {
  if (!rows?.length) return <p className="text-xs text-slate-500">No reporting-position facts were available for this close snapshot.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-xs">
        <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
          <th className="py-2 pr-3 font-semibold">Position type</th>
          <th className="py-2 pr-3 text-right font-semibold">Amount</th>
          <th className="py-2 text-right font-semibold">Facts</th>
        </tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.fact_type + "-" + index} className="border-b border-slate-100 last:border-0">
              <td className="py-2.5 pr-3 font-medium text-slate-800">{row.fact_type.replaceAll("_", " ")}</td>
              <td className="py-2.5 pr-3 text-right font-semibold tabular-nums text-slate-950">{money(row.amount, currency)}</td>
              <td className="py-2.5 text-right tabular-nums text-slate-600">{numeric(row.fact_count, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FinancePeriodCloseWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("finance.close.read");
  const canWrite = hasPermission("finance.close.write");
  const canSubmit = hasPermission("finance.close.submit");
  const canApprove = hasPermission("finance.close.approve");
  const currentUserId = snapshot?.user?.id ?? "";

  const [periods, setPeriods] = useState<FinanceClosePeriod[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [createDraft, setCreateDraft] = useState<CreateDraft>(monthDraft);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [currencyFilter, setCurrencyFilter] = useState("ALL");
  const [transitionReason, setTransitionReason] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = periods.find((period) => period.id === selectedId) ?? null;
  const summary = useMemo(() => summarizeFinanceClosePeriods(periods), [periods]);
  const visiblePeriods = useMemo(
    () => filterFinanceClosePeriods(periods, { status: statusFilter, currency: currencyFilter, search }),
    [periods, statusFilter, currencyFilter, search],
  );
  const currencies = useMemo(
    () => [...new Set(periods.map((period) => period.currency))].sort(),
    [periods],
  );
  const readiness = useMemo(() => financeCloseReadiness(selected?.snapshot), [selected?.snapshot]);

  const loadPeriods = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setPeriods([]);
      setSelectedId("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await request("/finance/close-periods");
      const next = normalizeFinanceCloseRows<FinanceClosePeriod>(result);
      setPeriods(next);
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
    } catch (cause) {
      setError(messageOf(cause));
      setPeriods([]);
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadPeriods(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPeriods]);

  async function createClosePeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildFinanceCloseCreatePayload(createDraft as unknown as Record<string, unknown>);
      const result = await request("/finance/close-periods", {
        method: "POST",
        body: payload,
        idempotencyKey: "finance-close-" + window.crypto.randomUUID(),
      }) as FinanceClosePeriod;
      setCreateOpen(false);
      setCreateDraft(monthDraft());
      setSelectedId(result.id);
      await loadPeriods();
      setNotice("Draft close created from a server-calculated, source-currency snapshot. Refresh it before submission if source facts change.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runTransition(kind: TransitionKind) {
    if (!selected) return;
    const allowed = kind === "REFRESH" ? canWrite
      : kind === "SUBMIT" || kind === "RECALL" ? canSubmit
        : canApprove;
    if (!allowed) return;
    if (kind === "SUBMIT" && !readiness.ready) return;
    if (kind === "RECALL" && selected.submitted_by_user_id !== currentUserId) return;
    if (kind === "APPROVE" && (!currentUserId || selected.created_by_user_id === currentUserId || selected.submitted_by_user_id === currentUserId)) return;

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildFinanceCloseActionPayload({
        expected_version: selected.row_version,
        reason: transitionReason,
      });
      const routes: Record<TransitionKind, string> = {
        REFRESH: "refresh",
        SUBMIT: "submit",
        RECALL: "recall",
        APPROVE: "approve",
      };
      const result = await request("/finance/close-periods/" + selected.id + "/" + routes[kind], {
        method: "POST",
        body: payload,
        idempotencyKey: "finance-close-" + kind.toLowerCase() + "-" + window.crypto.randomUUID(),
      }) as FinanceClosePeriod;
      setTransitionReason("");
      await loadPeriods();
      setSelectedId(result.id);
      const messages: Record<TransitionKind, string> = {
        REFRESH: "Draft snapshot refreshed. Its version and fingerprint have changed.",
        SUBMIT: "Close snapshot submitted. Independent approval is now required.",
        RECALL: "Submitted snapshot recalled to Draft. Refresh and re-submit after correcting source readiness.",
        APPROVE: "Close snapshot approved. The approved snapshot remains versioned and immutable.",
      };
      setNotice(messages[kind] + (result.replayed ? " The API returned an idempotent replay." : ""));
    } catch (cause) {
      setError(messageOf(cause));
      if (String(messageOf(cause)).toLowerCase().includes("version") || String(messageOf(cause)).includes("changed")) {
        setNotice("The API reported a stale version or changed source snapshot. Reload the register before another action.");
      }
    } finally {
      setBusy(false);
    }
  }

  function updateCreateDraft<K extends keyof CreateDraft>(key: K, value: CreateDraft[K]) {
    setCreateDraft((current) => ({ ...current, [key]: value }));
  }

  const ready = status === "connected" && Boolean(activeFactoryId);
  const canSelfReview = Boolean(currentUserId)
    && selected !== null
    && selected.created_by_user_id !== currentUserId
    && selected.submitted_by_user_id !== currentUserId;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Finance / Period governance</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Finance Period Close</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Build a versioned month-end snapshot, check reporting-source and reconciliation readiness, submit it for independent review, and approve only when the source fingerprint remains unchanged.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/" className={secondaryButton}>Workspace overview</Link>
            <button type="button" onClick={() => void loadPeriods()} disabled={!ready || !canRead || loading || busy} className={secondaryButton}>
              Refresh register
            </button>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 text-[10px] font-semibold text-slate-600">
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Factory scoped</span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Version checked</span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Maker-checker approval</span>
          <span className="rounded-full bg-slate-100 px-3 py-1.5">Source fingerprint</span>
        </div>
      </header>

      {!ready ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Connect an authenticated FactoryOS session and select an active factory to load finance-close records.
        </section>
      ) : null}
      {ready && !canRead ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Your permission snapshot does not include finance.close.read. The API remains the final authorization authority.
        </section>
      ) : null}
      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{notice}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Close records" value={summary.total} detail="Up to 100 rows returned" tone="blue" />
        <Metric label="Drafts" value={summary.drafts} detail="Awaiting a refresh or submit" />
        <Metric label="Ready drafts" value={summary.readyDrafts} detail="Backend readiness gate cleared" tone="emerald" />
        <Metric label="Blocked drafts" value={summary.blockedDrafts} detail="Missing source or reconciliation evidence" tone="amber" />
        <Metric label="Submitted" value={summary.submitted} detail="Awaiting independent reviewer" tone="blue" />
        <Metric label="Approved" value={summary.approved} detail="Final approved close snapshots" tone="emerald" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">01 / Close register</p>
              <h2 className="mt-1 text-lg font-bold text-slate-950">Period snapshots</h2>
            </div>
            <button type="button" onClick={() => { setCreateDraft(monthDraft()); setCreateOpen((current) => !current); setError(""); }} disabled={!canWrite} className={primaryButton}>
              {createOpen ? "Close form" : "Create close draft"}
            </button>
          </div>

          {createOpen ? (
            <form onSubmit={createClosePeriod} className="mt-4 space-y-3 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Period start">
                  <input type="date" className={inputClass} value={createDraft.period_start} onChange={(event) => updateCreateDraft("period_start", event.target.value)} required />
                </Field>
                <Field label="Period end">
                  <input type="date" className={inputClass} value={createDraft.period_end} onChange={(event) => updateCreateDraft("period_end", event.target.value)} required />
                </Field>
                <Field label="Source currency" hint="No implicit FX conversion or mixed-currency summation.">
                  <input className={inputClass} value={createDraft.currency} onChange={(event) => updateCreateDraft("currency", event.target.value.toUpperCase())} maxLength={3} minLength={3} required />
                </Field>
                <Field label="Creation reason">
                  <input className={inputClass} value={createDraft.reason} onChange={(event) => updateCreateDraft("reason", event.target.value)} minLength={8} maxLength={1000} placeholder="e.g. Monthly close preparation" required />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={!canWrite || busy} className={primaryButton}>{busy ? "Creating…" : "Create source snapshot"}</button>
                <button type="button" onClick={() => setCreateOpen(false)} className={secondaryButton}>Cancel</button>
              </div>
            </form>
          ) : null}

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Field label="Status">
              <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="ALL">All</option>
                <option value="DRAFT">Draft</option>
                <option value="SUBMITTED">Submitted</option>
                <option value="APPROVED">Approved</option>
              </select>
            </Field>
            <Field label="Currency">
              <select className={inputClass} value={currencyFilter} onChange={(event) => setCurrencyFilter(event.target.value)}>
                <option value="ALL">All currencies</option>
                {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
              </select>
            </Field>
            <Field label="Search">
              <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Period, currency, record ID…" />
            </Field>
          </div>
          {loading ? <p className="mt-3 text-xs text-slate-500">Loading finance-close register…</p> : null}
          {visiblePeriods.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center">
              <p className="text-sm font-semibold text-slate-800">No close periods match this view</p>
              <p className="mt-1 text-xs text-slate-500">Create a draft for a currency and date range when the reporting sources are ready.</p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {visiblePeriods.map((period) => {
                const periodReadiness = financeCloseReadiness(period.snapshot);
                return (
                  <button
                    key={period.id}
                    type="button"
                    onClick={() => { setSelectedId(period.id); setTransitionReason(""); }}
                    aria-pressed={selectedId === period.id}
                    className={"w-full rounded-xl border p-3 text-left transition " + (selectedId === period.id ? "border-slate-950 bg-slate-50 shadow-sm" : "border-slate-200 hover:border-slate-400")}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-slate-950">{period.currency} · {dateLabel(period.period_start)} — {dateLabel(period.period_end)}</p>
                        <p className="mt-1 text-[10px] text-slate-500">Version {period.row_version} · Updated {dateTime(period.updated_at)}</p>
                      </div>
                      <StatusPill value={period.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
                      {period.status === "DRAFT" ? (
                        <span className={"rounded-md px-2 py-1 " + (periodReadiness.ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")}>
                          {periodReadiness.ready ? "Ready to submit" : periodReadiness.blockers.length + " blockers"}
                        </span>
                      ) : null}
                      <span>Hash {period.snapshot_hash.slice(0, 10)}…</span>
                      <span>Record {shortId(period.id)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-[10px] leading-4 text-slate-500">The API returns at most 100 close periods. Counts above summarize only returned rows, not an unlimited ledger total.</p>
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          {!selected ? (
            <div className="flex min-h-64 flex-col items-center justify-center text-center">
              <p className="text-sm font-semibold text-slate-800">Select a close snapshot</p>
              <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">Read the stored financial summary, reporting-domain readiness and reconciliation gate before taking a lifecycle action.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">02 / Close snapshot</p>
                  <h2 className="mt-1 text-lg font-bold text-slate-950">{selected.currency} · {dateLabel(selected.period_start)} — {dateLabel(selected.period_end)}</h2>
                  <p className="mt-1 text-[10px] text-slate-500">Record {selected.id} · Version {selected.row_version} · Schema {selected.snapshot?.schema ?? "unknown"}</p>
                </div>
                <StatusPill value={selected.status} />
              </div>

              <div className={"rounded-xl border p-4 " + (readiness.ready ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-bold text-slate-950">Backend submission readiness</p>
                  <span className={"rounded-full px-2.5 py-1 text-[10px] font-bold " + (readiness.ready ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
                    {readiness.ready ? "READY" : "BLOCKED"}
                  </span>
                </div>
                {readiness.blockers.length > 0 ? (
                  <ul className="mt-3 space-y-1.5 text-xs leading-5 text-amber-950">
                    {readiness.blockers.map((blocker) => <li key={blocker}>• {blocker}</li>)}
                  </ul>
                ) : <p className="mt-2 text-xs text-emerald-900">All backend submission gates are currently clear for this stored snapshot.</p>}
              </div>

              <section>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-950">Required reporting domains</h3>
                  <span className="text-[10px] text-slate-500">{selected.snapshot.reporting_domains?.filter((domain) => domain.is_active && domain.last_completed_at).length ?? 0} of {selected.snapshot.reporting_domains?.length ?? 0} active + initialized</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(selected.snapshot.reporting_domains ?? []).map((domain) => (
                    <div key={domain.domain} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold text-slate-900">{domain.domain}</p>
                        <span className={"text-[10px] font-semibold " + (domain.is_active && domain.last_completed_at ? "text-emerald-700" : "text-amber-800")}>
                          {domain.is_active ? domain.last_completed_at ? "Initialized" : "No ingestion receipt" : "No active source"}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">{domain.connector_code ?? "No connector"} · {domain.source_system ?? "Source not configured"}</p>
                      <p className="mt-1 text-[10px] text-slate-500">Last completed: {dateTime(domain.last_completed_at)}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-sm font-bold text-slate-950">Period performance</h3>
                <div className="mt-3">
                  <PerformanceCard performance={selected.snapshot.period_costing_profitability} currency={selected.currency} />
                </div>
              </section>

              <section>
                <h3 className="text-sm font-bold text-slate-950">Working-capital positions</h3>
                <div className="mt-3">
                  <WorkingCapitalCard rows={selected.snapshot.working_capital_positions ?? []} currency={selected.currency} />
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-950">Snapshot integrity</h3>
                  <span className="text-[10px] font-semibold text-slate-600">Row version {selected.row_version}</span>
                </div>
                <p className="mt-2 break-all font-mono text-[10px] leading-5 text-slate-600">{selected.snapshot_hash}</p>
                <p className="mt-2 text-[10px] leading-4 text-slate-500">Creator {shortId(selected.created_by_user_id)} · Submitter {shortId(selected.submitted_by_user_id)} · Approver {shortId(selected.approved_by_user_id)}</p>
                <p className="mt-1 text-[10px] text-slate-500">Created {dateTime(selected.created_at)} · Submitted {dateTime(selected.submitted_at)} · Approved {dateTime(selected.approved_at)}</p>
                {selected.approval_reason ? <p className="mt-2 text-xs text-slate-700">Approval reason: {selected.approval_reason}</p> : null}
              </section>

              <section className="rounded-xl border border-slate-200 p-4">
                <h3 className="text-sm font-bold text-slate-950">Lifecycle actions</h3>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  Every transition requires the current row version and a reason. A source change after submission requires the submitter to recall, refresh and submit again before approval.
                </p>
                <Field label="Transition reason">
                  <textarea className={inputClass + " mt-1 min-h-20 py-2"} value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} minLength={8} maxLength={1000} placeholder="Explain why this transition is being requested…" />
                </Field>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selected.status === "DRAFT" ? (
                    <>
                      <button type="button" disabled={!canWrite || busy || transitionReason.trim().length < 8} onClick={() => void runTransition("REFRESH")} className={secondaryButton}>Refresh snapshot</button>
                      <button type="button" disabled={!canSubmit || busy || !readiness.ready || transitionReason.trim().length < 8} onClick={() => void runTransition("SUBMIT")} className={primaryButton}>Submit for review</button>
                    </>
                  ) : null}
                  {selected.status === "SUBMITTED" ? (
                    <>
                      <button type="button" disabled={!canSubmit || busy || selected.submitted_by_user_id !== currentUserId || transitionReason.trim().length < 8} onClick={() => void runTransition("RECALL")} className={secondaryButton}>Recall to draft</button>
                      <button type="button" disabled={!canApprove || busy || !canSelfReview || transitionReason.trim().length < 8} onClick={() => void runTransition("APPROVE")} className={primaryButton}>Approve close</button>
                    </>
                  ) : null}
                  {selected.status === "APPROVED" ? <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">Final approved state — no further transition is available.</span> : null}
                </div>
                {selected.status === "SUBMITTED" && selected.submitted_by_user_id === currentUserId ? (
                  <p className="mt-2 text-[10px] text-blue-800">You are the submitter. You may recall this close but cannot approve it.</p>
                ) : null}
                {selected.status === "SUBMITTED" && !canSelfReview ? (
                  <p className="mt-2 text-[10px] text-amber-800">The creator or submitter cannot approve this close; another authorized reviewer is required.</p>
                ) : null}
                {!canWrite && selected.status === "DRAFT" ? <p className="mt-2 text-[10px] text-amber-800">finance.close.write is required to refresh a draft.</p> : null}
                {!canSubmit && selected.status !== "APPROVED" ? <p className="mt-2 text-[10px] text-amber-800">finance.close.submit is required to submit or recall.</p> : null}
                {!canApprove && selected.status === "SUBMITTED" ? <p className="mt-2 text-[10px] text-amber-800">finance.close.approve is required for independent approval.</p> : null}
              </section>
            </div>
          )}
        </article>
      </section>

      <footer className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-[11px] leading-5 text-slate-600">
        <strong className="text-slate-800">Scope boundary:</strong> this workspace creates and governs reporting snapshots only. It does not post general-ledger journals, execute payments, write bank transactions, or submit tax returns. Source-currency amounts remain separate, and the backend recalculates readiness and verifies the snapshot fingerprint during submit and approval.
      </footer>
    </main>
  );
}
