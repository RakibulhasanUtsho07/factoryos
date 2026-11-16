"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
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
  Input,
  PageHeader,
  Select,
  StatusBadge,
} from "@/components/ui";
import { createFinanceWorkbenchClient } from "@/lib/finance-workbench.mjs";
import type { FinanceWorkbenchClient } from "@/lib/finance-workbench.mjs";

type JsonRecord = Record<string, unknown>;
type FinanceTab = "performance" | "working-capital" | "reconciliation" | "close-periods";
type AppliedFilters = {
  from: string;
  to: string;
  currency: string;
  horizonDays: number;
};
type ReportResult = {
  key: string;
  payload?: JsonRecord;
  error: string;
};
type ClosePeriodResult = {
  key: string;
  items: JsonRecord[];
  error: string;
};

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

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: unknown, maximumFractionDigits = 2): string {
  const number = numberValue(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(number);
}

function formatMoney(value: unknown, currency: unknown): string {
  const number = numberValue(value);
  const code = valueText(currency, "").toUpperCase();
  if (number === null) return "—";
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 2,
      }).format(number);
    } catch {
      return formatNumber(number) + " " + code;
    }
  }
  return formatNumber(number) + (code ? " " + code : "");
}

function formatPercent(value: unknown): string {
  const number = numberValue(value);
  return number === null ? "—" : formatNumber(number, 2) + "%";
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
}

function formatDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
}

function dateInputValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function initialFilters(): AppliedFilters {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 180);
  return {
    from: dateInputValue(start),
    to: dateInputValue(end),
    currency: "",
    horizonDays: 30,
  };
}

function statusTone(value: unknown): "success" | "warning" | "danger" | "info" | "neutral" {
  const status = valueText(value, "").toUpperCase();
  if (["APPROVED", "ACTIVE", "READY", "RESOLVED", "TRUE"].includes(status)) return "success";
  if (["SUBMITTED", "DRAFT", "OPEN", "PENDING", "BLOCKED", "FALSE"].includes(status)) return "warning";
  if (["FAILED", "REJECTED", "MISSING", "DISABLED"].includes(status)) return "danger";
  return "neutral";
}

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>
    </Card>
  );
}

function DataTable({
  headers,
  children,
  emptyMessage,
}: {
  headers: string[];
  children: ReactNode;
  emptyMessage: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="whitespace-nowrap px-3 py-3 first:pl-4 last:pr-4">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {children}
        </tbody>
      </table>
      {emptyMessage ? (
        <p className="px-4 py-7 text-center text-sm text-slate-500">{emptyMessage}</p>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        "rounded-lg px-3 py-2 text-sm font-semibold transition",
        active
          ? "bg-slate-900 text-white shadow-sm"
          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default function FinanceWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadWorkbench = connected && hasPermission("finance.workbench.read");
  const canReadClosePeriods = connected && hasPermission("finance.close.read");

  const [requestedTab, setRequestedTab] = useState<FinanceTab>("performance");
  const [draftFrom, setDraftFrom] = useState(() => initialFilters().from);
  const [draftTo, setDraftTo] = useState(() => initialFilters().to);
  const [draftCurrency, setDraftCurrency] = useState("");
  const [draftHorizonDays, setDraftHorizonDays] = useState("30");
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>(() => initialFilters());
  const [closeStatus, setCloseStatus] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [reportResult, setReportResult] = useState<ReportResult | null>(null);
  const [closePeriodResult, setClosePeriodResult] = useState<ClosePeriodResult | null>(null);

  const activeTab: FinanceTab = requestedTab === "close-periods"
    ? (canReadClosePeriods ? "close-periods" : canReadWorkbench ? "performance" : "close-periods")
    : (canReadWorkbench ? requestedTab : canReadClosePeriods ? "close-periods" : requestedTab);

  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const tenantName = snapshot?.tenant.name ?? "Current tenant";

  const reportKey = JSON.stringify([
    sessionStatus,
    scopeKey,
    canReadWorkbench,
    appliedFilters.from,
    appliedFilters.to,
    appliedFilters.currency,
    appliedFilters.horizonDays,
    refreshVersion,
  ]);
  const currentReport = reportResult?.key === reportKey ? reportResult : null;
  const report = asRecord(currentReport?.payload);
  const reportLoading = canReadWorkbench && Boolean(activeFactoryId) && currentReport === null;

  const closePeriodKey = JSON.stringify([
    sessionStatus,
    scopeKey,
    canReadClosePeriods,
    closeStatus,
    appliedFilters.from,
    appliedFilters.to,
    appliedFilters.currency,
    refreshVersion,
  ]);
  const currentClosePeriods = closePeriodResult?.key === closePeriodKey ? closePeriodResult : null;
  const closePeriods = currentClosePeriods?.items ?? [];
  const closePeriodsLoading = activeTab === "close-periods"
    && canReadClosePeriods && Boolean(activeFactoryId) && currentClosePeriods === null;

  const filterError = draftFrom && draftTo && draftFrom > draftTo
    ? "Start date must be on or before the end date."
    : draftCurrency.trim() && !/^[A-Za-z]{3}$/.test(draftCurrency.trim())
      ? "Currency must be a three-letter ISO code, such as BDT or USD."
      : !/^\d+$/.test(draftHorizonDays) || Number(draftHorizonDays) < 1 || Number(draftHorizonDays) > 365
        ? "Cash horizon must be a whole number between 1 and 365 days."
        : "";

  useEffect(() => {
    if (!canReadWorkbench || !activeFactoryId) return;
    let active = true;
    const client: FinanceWorkbenchClient = createFinanceWorkbenchClient({ request });

    void client.readWorkbench({
      from: appliedFilters.from,
      to: appliedFilters.to,
      currency: appliedFilters.currency || undefined,
      horizonDays: appliedFilters.horizonDays,
      unreconciledLimit: 50,
    }).then((payload) => {
      if (!active) return;
      setReportResult({
        key: reportKey,
        payload: asRecord(payload),
        error: "",
      });
    }).catch((cause: unknown) => {
      if (!active) return;
      setReportResult({
        key: reportKey,
        error: cause instanceof Error ? cause.message : "Finance reporting data could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    canReadWorkbench,
    activeFactoryId,
    request,
    appliedFilters,
    reportKey,
  ]);

  useEffect(() => {
    if (activeTab !== "close-periods" || !canReadClosePeriods || !activeFactoryId) return;
    let active = true;
    const client: FinanceWorkbenchClient = createFinanceWorkbenchClient({ request });

    void client.listClosePeriods({
      status: closeStatus || undefined,
      currency: appliedFilters.currency || undefined,
      from: appliedFilters.from,
      to: appliedFilters.to,
    }).then((payload) => {
      if (!active) return;
      setClosePeriodResult({
        key: closePeriodKey,
        items: asRecords(payload),
        error: "",
      });
    }).catch((cause: unknown) => {
      if (!active) return;
      setClosePeriodResult({
        key: closePeriodKey,
        items: [],
        error: cause instanceof Error ? cause.message : "Finance close periods could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    activeTab,
    canReadClosePeriods,
    activeFactoryId,
    request,
    closeStatus,
    appliedFilters,
    closePeriodKey,
  ]);

  const periodMargin = asRecords(report.period_margin);
  const workingCapital = asRecords(report.working_capital);
  const operationalVariance = asRecords(report.operational_variance_attribution);
  const reportingDomains = asRecords(report.reporting_domains);
  const unreconciledFacts = asRecords(report.unreconciled_facts);
  const totalUnreconciled = numberValue(report.unreconciled_fact_count) ?? 0;
  const isReportingReady = report.reporting_ready === true;
  const missingDomains = Array.isArray(report.missing_reporting_domains)
    ? report.missing_reporting_domains.filter((entry): entry is string => typeof entry === "string")
    : [];
  const uninitializedDomains = Array.isArray(report.uninitialized_reporting_domains)
    ? report.uninitialized_reporting_domains.filter((entry): entry is string => typeof entry === "string")
    : [];
  const cashHorizon = asRecord(report.cash_horizon);
  const reportingActiveCount = reportingDomains.filter((domain) => domain.is_active === true).length;

  function applyFilters() {
    if (filterError) return;
    setAppliedFilters({
      from: draftFrom,
      to: draftTo,
      currency: draftCurrency.trim().toUpperCase(),
      horizonDays: Number(draftHorizonDays),
    });
  }

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  const showAnyPermission = canReadWorkbench || canReadClosePeriods;
  const availableTabs: { key: FinanceTab; label: string }[] = [
    ...(canReadWorkbench ? [
      { key: "performance" as const, label: "Margin & variance" },
      { key: "working-capital" as const, label: "Working capital" },
      { key: "reconciliation" as const, label: "Reconciliation" },
    ] : []),
    ...(canReadClosePeriods ? [{ key: "close-periods" as const, label: "Close periods" }] : []),
  ];

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Finance · reporting · reconciliation"
        title="Finance Workbench"
        description="Review factory financial performance, working-capital positions, reconciliation exceptions and finance-close evidence."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!showAnyPermission || !activeFactoryId || reportLoading || closePeriodsLoading}
            >
              Refresh finance
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Alert tone={connected && activeFactoryId ? "success" : "warning"} title="Workspace scope">
          {connected
            ? tenantName + (activeFactory
              ? " · " + activeFactory.code + " — " + activeFactory.name
              : " · Select an active factory")
            : "Connect an existing FactoryOS session to inspect finance records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={showAnyPermission ? "success" : "info"} title="Finance read permissions">
          {[
            canReadWorkbench ? "finance.workbench.read" : null,
            canReadClosePeriods ? "finance.close.read" : null,
          ].filter(Boolean).join(" · ") || "The current IAM snapshot has no Finance read permissions."}
          {" "}The API remains authoritative for factory scope and every access decision.
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory from the authenticated IAM session before opening the finance workspace."
        />
      ) : null}

      {connected && !showAnyPermission ? (
        <EmptyState
          title="Finance access is not available"
          description="The current IAM permission snapshot does not include finance.workbench.read or finance.close.read."
        />
      ) : null}

      {showAnyPermission && activeFactoryId ? (
        <>
          <Card className="mb-5">
            <CardHeader>
              <CardTitle>Reporting filters</CardTitle>
              <CardDescription>
                Dates are interpreted by the Finance API as an inclusive reporting period. Currency stays in the source currency; no implicit FX conversion is applied.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block text-sm font-medium text-slate-700">
                  From date
                  <Input
                    className="mt-1"
                    type="date"
                    value={draftFrom}
                    onChange={(event) => setDraftFrom(event.target.value)}
                  />
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  To date
                  <Input
                    className="mt-1"
                    type="date"
                    value={draftTo}
                    onChange={(event) => setDraftTo(event.target.value)}
                  />
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Currency
                  <Input
                    className="mt-1 uppercase"
                    value={draftCurrency}
                    maxLength={3}
                    placeholder="Any currency"
                    autoComplete="off"
                    onChange={(event) => setDraftCurrency(event.target.value)}
                  />
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Cash horizon (days)
                  <Input
                    className="mt-1"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={draftHorizonDays}
                    onChange={(event) => setDraftHorizonDays(event.target.value)}
                  />
                </label>
                <div className="flex items-end">
                  <Button className="w-full" onClick={applyFilters} disabled={Boolean(filterError)}>
                    Apply filters
                  </Button>
                </div>
              </div>
              {filterError ? <p role="alert" className="mt-3 text-xs font-medium text-rose-700">{filterError}</p> : null}
              <p className="mt-3 text-xs text-slate-500">
                Cash horizon ends {formatDate(cashHorizon.ends_at)} for {formatNumber(cashHorizon.days, 0)} days after the report end date.
              </p>
            </CardContent>
          </Card>

          <nav aria-label="Finance workbench sections" className="mb-5 flex flex-wrap gap-2">
            {availableTabs.map((item) => (
              <TabButton
                key={item.key}
                active={activeTab === item.key}
                onClick={() => setRequestedTab(item.key)}
              >
                {item.label}
              </TabButton>
            ))}
          </nav>

          {canReadWorkbench && currentReport?.error ? (
            <Alert tone="danger" title="Finance reporting request failed" className="mb-5">
              {currentReport.error}
            </Alert>
          ) : null}

          {canReadWorkbench && !currentReport && activeTab !== "close-periods" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {["Loading margin and variance", "Loading working capital", "Loading reconciliation"].map((label) => (
                <div key={label} className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white" aria-label={label} />
              ))}
            </div>
          ) : null}

          {canReadWorkbench && currentReport && !currentReport.error ? (
            <>
              <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric
                  label="Reporting readiness"
                  value={isReportingReady ? "Ready" : "Needs attention"}
                  hint={isReportingReady
                    ? "Required source domains are active and initialized; no open mismatch remains."
                    : "A required domain, first ingestion receipt or reconciliation item is still outstanding."}
                />
                <Metric
                  label="Open mismatches"
                  value={formatNumber(totalUnreconciled, 0)}
                  hint="Factory-scoped open mismatches in the selected reporting period."
                />
                <Metric
                  label="Reporting domains"
                  value={reportingActiveCount + " / " + reportingDomains.length}
                  hint="Active reporting sources among the required finance domains."
                />
                <Metric
                  label="Margin rows"
                  value={formatNumber(periodMargin.length, 0)}
                  hint="Returned period, currency and dimension combinations; not a factory-wide fact count."
                />
              </div>

              {activeTab === "performance" ? (
                <div className="space-y-5">
                  <Alert tone={isReportingReady ? "success" : "warning"} title={isReportingReady ? "Reporting sources are ready" : "Reporting readiness is incomplete"}>
                    {missingDomains.length
                      ? "Missing source domains: " + missingDomains.join(", ") + ". "
                      : ""}
                    {uninitializedDomains.length
                      ? "Active sources without a completed ingestion receipt: " + uninitializedDomains.join(", ") + ". "
                      : ""}
                    {totalUnreconciled > 0
                      ? formatNumber(totalUnreconciled, 0) + " open reconciliation mismatches remain."
                      : "No open reconciliation mismatches were returned for this period."}
                  </Alert>

                  <Panel
                    title="Period margin analysis"
                    description="Actuals are immutable source facts. Forecasts use the latest version for each source key and calendar month. Each row retains its own currency."
                  >
                    <DataTable
                      headers={["Period", "Currency", "Actual revenue", "Actual cost", "Gross margin", "Gross margin %", "Forecast revenue", "Revenue variance"]}
                      emptyMessage={periodMargin.length ? "" : "No margin facts were returned for this period and currency filter."}
                    >
                      {periodMargin.slice(0, 100).map((row, index) => (
                        <tr key={String(row.period ?? "period") + ":" + String(row.currency ?? "") + ":" + index}>
                          <td className="whitespace-nowrap px-3 py-3 font-medium text-slate-800">{valueText(row.period)}</td>
                          <td className="px-3 py-3">{valueText(row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.actual_revenue, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.actual_cost, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{formatMoney(row.actual_gross_margin, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatPercent(row.actual_gross_margin_percent)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.forecast_revenue, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.revenue_variance, row.currency)}</td>
                        </tr>
                      ))}
                    </DataTable>
                    {periodMargin.length > 100 ? (
                      <p className="mt-3 text-xs text-slate-500">Showing the first 100 of {periodMargin.length} API-returned margin rows.</p>
                    ) : null}
                  </Panel>

                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel
                      title="Required reporting domains"
                      description="The API defines General Ledger, Accounts Receivable, Accounts Payable, Bank Reconciliation and Tax E-invoice as required reporting domains."
                    >
                      <div className="space-y-3">
                        {reportingDomains.map((domain, index) => (
                          <div key={valueText(domain.domain, String(index))} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                            <div>
                              <p className="text-sm font-semibold text-slate-800">{valueText(domain.domain)}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {[domain.connector_code, domain.source_system].map((entry) => valueText(entry, "")).filter(Boolean).join(" · ") || "No active reporting connector"}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">Last completed run: {formatDateTime(domain.last_completed_at)}</p>
                            </div>
                            <StatusBadge status={domain.is_active === true ? "ACTIVE" : "MISSING"} />
                          </div>
                        ))}
                        {!reportingDomains.length ? <p className="text-sm text-slate-500">No reporting-domain status was returned.</p> : null}
                      </div>
                    </Panel>

                    <Panel
                      title="Finance reporting policies"
                      description="Source-of-record rules returned by the Finance API for the selected report."
                    >
                      <dl className="space-y-4 text-sm">
                        <div>
                          <dt className="font-semibold text-slate-800">Source of record</dt>
                          <dd className="mt-1 leading-6 text-slate-600">{valueText(report.source_of_record_policy, "Not supplied.")}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-slate-800">Actual vs forecast</dt>
                          <dd className="mt-1 leading-6 text-slate-600">{valueText(report.actual_forecast_policy, "Not supplied.")}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-slate-800">Currency treatment</dt>
                          <dd className="mt-1 leading-6 text-slate-600">{valueText(report.currency_policy, "Not supplied.")}</dd>
                        </div>
                      </dl>
                    </Panel>
                  </div>
                </div>
              ) : null}

              {activeTab === "working-capital" ? (
                <div className="space-y-5">
                  <Panel
                    title="Working-capital positions"
                    description="Latest eligible reporting-source positions by currency. Values are not combined across currencies."
                  >
                    <DataTable
                      headers={["Currency", "Receivables", "Payables", "Bank balance", "Inventory", "Net working capital", "Open PO commitment", "LC exposure", "Tax liability"]}
                      emptyMessage={workingCapital.length ? "" : "No working-capital positions were returned."}
                    >
                      {workingCapital.map((row, index) => (
                        <tr key={String(row.currency ?? index)}>
                          <td className="px-3 py-3 font-semibold">{valueText(row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.receivables, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.payables, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.bank_balance, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.inventory_value, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{formatMoney(row.net_working_capital, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.open_po_commitments, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.lc_exposure, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.tax_liability, row.currency)}</td>
                        </tr>
                      ))}
                    </DataTable>
                  </Panel>

                  <div className="grid gap-5 lg:grid-cols-2">
                    <Panel title="Overdue exposure" description="Amounts whose source due date is before the report end date.">
                      <DataTable
                        headers={["Currency", "Overdue receivables", "Overdue payables"]}
                        emptyMessage={workingCapital.length ? "" : "No overdue exposure was returned."}
                      >
                        {workingCapital.map((row, index) => (
                          <tr key={String(row.currency ?? index)}>
                            <td className="px-3 py-3 font-semibold">{valueText(row.currency)}</td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.overdue_receivables, row.currency)}</td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.overdue_payables, row.currency)}</td>
                          </tr>
                        ))}
                      </DataTable>
                    </Panel>

                    <Panel
                      title="Cash horizon forecast"
                      description={"Backend-calculated expected inflows and outflows over the next " + formatNumber(cashHorizon.days, 0) + " days. These are source-currency positions, not a payment instruction."}
                    >
                      <DataTable
                        headers={["Currency", "Forecast inflows", "Forecast outflows", "Projected cash"]}
                        emptyMessage={workingCapital.length ? "" : "No cash-horizon positions were returned."}
                      >
                        {workingCapital.map((row, index) => (
                          <tr key={String(row.currency ?? index)}>
                            <td className="px-3 py-3 font-semibold">{valueText(row.currency)}</td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.forecast_inflows, row.currency)}</td>
                            <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.forecast_outflows, row.currency)}</td>
                            <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{formatMoney(row.projected_cash_at_horizon, row.currency)}</td>
                          </tr>
                        ))}
                      </DataTable>
                    </Panel>
                  </div>

                  <Panel
                    title="Operational variance attribution"
                    description="The server groups source-to-operational quantity and rate differences by period, currency, source type and operational dimensions."
                  >
                    <DataTable
                      headers={["Period", "Currency", "Fact type", "Source type", "Open", "Resolved", "Quantity variance", "Rate variance", "Combined variance"]}
                      emptyMessage={operationalVariance.length ? "" : "No operational quantity or rate variances were returned."}
                    >
                      {operationalVariance.slice(0, 100).map((row, index) => (
                        <tr key={String(row.period ?? "") + ":" + String(row.fact_type ?? "") + ":" + index}>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.period)}</td>
                          <td className="px-3 py-3">{valueText(row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.fact_type)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.source_record_type)}</td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(row.open_mismatch_count, 0)}</td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(row.resolved_mismatch_count, 0)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.operational_quantity_variance, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.operational_rate_variance, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{formatMoney(row.operational_quantity_rate_variance, row.currency)}</td>
                        </tr>
                      ))}
                    </DataTable>
                    {operationalVariance.length > 100 ? (
                      <p className="mt-3 text-xs text-slate-500">Showing the first 100 of {operationalVariance.length} API-returned variance rows.</p>
                    ) : null}
                  </Panel>
                </div>
              ) : null}

              {activeTab === "reconciliation" ? (
                <div className="space-y-5">
                  <Alert tone={totalUnreconciled > 0 ? "warning" : "success"} title={totalUnreconciled > 0 ? "Open reconciliation mismatches need review" : "No open mismatches in the selected period"}>
                    The Finance API returned {formatNumber(unreconciledFacts.length, 0)} open fact rows for display out of {formatNumber(totalUnreconciled, 0)} open mismatches counted across the selected reporting period. This page does not resolve or waive exceptions.
                  </Alert>

                  <Panel
                    title="Open fact reconciliation exceptions"
                    description="Only non-matching, open records from active reporting sources are returned. Source fact keys, internal record IDs and actor identifiers are intentionally not shown."
                  >
                    <DataTable
                      headers={["Effective date", "Fact type", "Source type", "Amount", "Due date", "Quantity delta", "Rate delta", "Unit"]}
                      emptyMessage={unreconciledFacts.length ? "" : "No open fact-level reconciliation exceptions were returned."}
                    >
                      {unreconciledFacts.map((row, index) => (
                        <tr key={String(row.fact_type ?? "fact") + ":" + String(row.effective_at ?? "") + ":" + index}>
                          <td className="whitespace-nowrap px-3 py-3">{formatDate(row.effective_at)}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-medium">{valueText(row.fact_type)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.source_record_type)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(row.amount, row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{formatDate(row.due_at)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatNumber(row.quantity_delta, 4)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatNumber(row.rate_delta, 4)}</td>
                          <td className="px-3 py-3">{valueText(row.uom_code)}</td>
                        </tr>
                      ))}
                    </DataTable>
                    {totalUnreconciled > unreconciledFacts.length ? (
                      <p className="mt-3 text-xs text-slate-500">
                        Display limit reached: the API returned up to 50 detail rows. Refine the date or currency filter to inspect a smaller set.
                      </p>
                    ) : null}
                  </Panel>

                  <Panel
                    title="Quantity and rate attribution"
                    description="Aggregate comparison of source quantities and rates against operational expectations."
                  >
                    <DataTable
                      headers={["Period", "Currency", "Fact type", "Source type", "Facts", "Open", "Resolved", "Waived", "Quantity / rate variance"]}
                      emptyMessage={operationalVariance.length ? "" : "No operational reconciliation attribution was returned."}
                    >
                      {operationalVariance.slice(0, 100).map((row, index) => (
                        <tr key={String(row.period ?? "") + ":" + String(row.source_record_type ?? "") + ":" + index}>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.period)}</td>
                          <td className="px-3 py-3">{valueText(row.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.fact_type)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{valueText(row.source_record_type)}</td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(row.reconciled_fact_count, 0)}</td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(row.open_mismatch_count, 0)}</td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(row.resolved_mismatch_count, 0)}</td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(row.waived_mismatch_count, 0)}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold tabular-nums">{formatMoney(row.operational_quantity_rate_variance, row.currency)}</td>
                        </tr>
                      ))}
                    </DataTable>
                    {operationalVariance.length > 100 ? (
                      <p className="mt-3 text-xs text-slate-500">Showing the first 100 of {operationalVariance.length} API-returned rows.</p>
                    ) : null}
                  </Panel>
                </div>
              ) : null}
            </>
          ) : null}

          {activeTab === "close-periods" ? (
            <div className="space-y-5">
              {!canReadClosePeriods ? (
                <EmptyState
                  title="Finance-close access is not available"
                  description="The current IAM permission snapshot does not include finance.close.read."
                />
              ) : currentClosePeriods?.error ? (
                <Alert tone="danger" title="Finance close-period request failed">{currentClosePeriods.error}</Alert>
              ) : closePeriodsLoading ? (
                <div className="h-52 animate-pulse rounded-2xl border border-slate-200 bg-white" aria-label="Loading finance close periods" />
              ) : (
                <Panel
                  title="Finance close-period register"
                  description="Read-only view of existing close-period snapshots. At most 100 rows are returned by the API; creation, refresh, submission, recall and approval are not available here."
                  action={
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                      Status
                      <Select
                        value={closeStatus}
                        onChange={(event) => setCloseStatus(event.target.value)}
                        className="min-w-36"
                      >
                        <option value="">All statuses</option>
                        <option value="DRAFT">Draft</option>
                        <option value="SUBMITTED">Submitted</option>
                        <option value="APPROVED">Approved</option>
                      </Select>
                    </label>
                  }
                >
                  <DataTable
                    headers={["Period", "Currency", "Status", "Version", "Readiness", "Open mismatches", "Actual revenue", "Actual gross margin", "Approved at"]}
                    emptyMessage={closePeriods.length ? "" : "No finance-close periods match the current filters."}
                  >
                    {closePeriods.map((period, index) => {
                      const snapshotValue = asRecord(period.snapshot);
                      const readiness = asRecord(snapshotValue.readiness);
                      const performance = asRecord(snapshotValue.period_costing_profitability);
                      const ready = readiness.can_submit === true;
                      return (
                        <tr key={String(period.id ?? "close") + ":" + index}>
                          <td className="whitespace-nowrap px-3 py-3">
                            <p className="font-semibold text-slate-800">{formatDate(period.period_start)} – {formatDate(period.period_end)}</p>
                            <p className="mt-1 text-xs text-slate-500">Created {formatDateTime(period.created_at)}</p>
                          </td>
                          <td className="px-3 py-3">{valueText(period.currency)}</td>
                          <td className="px-3 py-3"><StatusBadge status={valueText(period.status, "UNKNOWN")} /></td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(period.row_version, 0)}</td>
                          <td className="px-3 py-3">
                            <Badge tone={statusTone(ready ? "READY" : "BLOCKED")}>{ready ? "Ready" : "Blocked"}</Badge>
                            <p className="mt-1 text-xs text-slate-500">
                              {(Array.isArray(readiness.missing_reporting_domains) ? readiness.missing_reporting_domains.length : 0)
                                + (Array.isArray(readiness.uninitialized_reporting_domains) ? readiness.uninitialized_reporting_domains.length : 0)} domain gaps
                            </p>
                          </td>
                          <td className="px-3 py-3 tabular-nums">{formatNumber(readiness.unresolved_reconciliation_count, 0)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(performance.actual_revenue, period.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3 tabular-nums">{formatMoney(performance.actual_gross_margin, period.currency)}</td>
                          <td className="whitespace-nowrap px-3 py-3">{formatDateTime(period.approved_at)}</td>
                        </tr>
                      );
                    })}
                  </DataTable>
                  <p className="mt-3 text-xs text-slate-500">
                    Displayed fields exclude creator/approver user IDs, snapshot hashes, idempotency keys and audit metadata.
                  </p>
                </Panel>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
