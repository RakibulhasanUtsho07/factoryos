"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildIntegrationCaseDecisionPayload,
  buildIntegrationConnectorPayload,
  buildIntegrationDecisionPayload,
  buildIntegrationQuery,
  buildIntegrationSecretRotationPayload,
  filterIntegrationConnectors,
  integrationCaseVersion,
  normalizeIntegrationRows,
  summarizeIntegrationWorkspace,
} from "@/lib/integration-workbench.mjs";
import type { IntegrationCase, IntegrationConnector, IntegrationEvent } from "@/lib/integration-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "CONNECTORS" | "EVENTS" | "CASES";
type ConnectorAction = "ACTIVATE" | "REJECT" | "PAUSE" | "RESUME" | "ROTATE_SECRET";

type ConnectorDraft = {
  display_name: string;
  source_system: string;
  secret_reference: string;
  schema_version: string;
  allowed_event_types: string;
  payload_schema: string;
};

const TABS: { id: Tab; label: string }[] = [
  { id: "CONNECTORS", label: "Connectors" },
  { id: "EVENTS", label: "Operational events" },
  { id: "CASES", label: "Reconciliation cases" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-28";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function items(value: unknown) {
  return normalizeIntegrationRows(value) as Row[];
}

function textValue(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function countValue(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? count.toLocaleString() : "—";
}

function shortId(value: unknown) {
  return typeof value === "string" ? value.slice(0, 8).toUpperCase() : "—";
}

function secureKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure idempotency-key generation is unavailable.");
  return "integration:" + globalThis.crypto.randomUUID();
}

function StatusPill({ value }: { value: unknown }) {
  const status = textValue(value, "UNKNOWN").toUpperCase();
  const tone = ["ACTIVE", "ON_TIME", "RESOLVED"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["PENDING_REVIEW", "OPEN", "LATE", "PAUSED", "WAIVED"].includes(status)
      ? "bg-amber-50 text-amber-900"
      : ["REJECTED", "ERROR", "FAILED"].includes(status)
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

function initialConnector(): ConnectorDraft {
  return {
    display_name: "",
    source_system: "",
    secret_reference: "",
    schema_version: "1",
    allowed_event_types: "",
    payload_schema: JSON.stringify({ type: "object", properties: {}, additionalProperties: false }, null, 2),
  };
}

function safeHistoryRows(value: unknown) {
  return items(value).map((row) => ({
    id: row.id,
    action: row.action,
    reason: row.reason,
    schema_version: row.schema_version,
    created_at: row.created_at,
  }));
}

export default function IntegrationsWorkbenchPage() {
  const {
    status: sessionStatus,
    activeFactoryId,
    hasPermission,
    request,
  } = useFactoryOsSession();

  const canReadConnectors = hasPermission("integrations.connectors.read");
  const canWriteConnectors = hasPermission("integrations.connectors.write");
  const canApproveConnectors = hasPermission("integrations.connectors.approve");
  const canReadReconciliation = hasPermission("integrations.reconciliation.read");
  const canReviewReconciliation = hasPermission("integrations.reconciliation.review");
  const canRead = canReadConnectors || canReadReconciliation;

  const [tab, setTab] = useState<Tab>("CONNECTORS");
  const [connectors, setConnectors] = useState<IntegrationConnector[]>([]);
  const [events, setEvents] = useState<IntegrationEvent[]>([]);
  const [cases, setCases] = useState<IntegrationCase[]>([]);
  const [report, setReport] = useState<Row | null>(null);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");

  const [connectorStatus, setConnectorStatus] = useState("ALL");
  const [connectorSearch, setConnectorSearch] = useState("");
  const [selectedConnectorId, setSelectedConnectorId] = useState("");
  const [connectorDetail, setConnectorDetail] = useState<Row | null>(null);
  const [connectorHistory, setConnectorHistory] = useState<Row[]>([]);

  const [domainFilter, setDomainFilter] = useState("ALL");
  const [deliveryFilter, setDeliveryFilter] = useState("ALL");
  const [caseStatusFilter, setCaseStatusFilter] = useState("OPEN");
  const [caseTypeFilter, setCaseTypeFilter] = useState("ALL");
  const [eventSourceFilter, setEventSourceFilter] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [caseHistory, setCaseHistory] = useState<Row[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [registerOpen, setRegisterOpen] = useState(false);
  const [connectorDraft, setConnectorDraft] = useState<ConnectorDraft>(initialConnector());
  const [connectorAction, setConnectorAction] = useState<{
    connectorId: string;
    action: ConnectorAction;
    reason: string;
    secret_reference: string;
  } | null>(null);
  const [caseAction, setCaseAction] = useState<{
    caseId: string;
    action: "RESOLVE" | "WAIVE";
    version: number;
    reason: string;
  } | null>(null);

  const visibleConnectors = useMemo(
    () => filterIntegrationConnectors(connectors, connectorSearch, connectorStatus),
    [connectors, connectorSearch, connectorStatus],
  );
  const selectedConnector = connectors.find((connector) => connector.id === selectedConnectorId) ?? null;
  const selectedCase = cases.find((row) => row.id === selectedCaseId) ?? null;

  const summary = useMemo(
    () => summarizeIntegrationWorkspace(connectors, events, cases, report),
    [connectors, events, cases, report],
  );

  const load = useCallback(async () => {
    if (!canRead || sessionStatus !== "connected" || !activeFactoryId) return;
    setLoading(true);
    setError("");
    setLoadedFactoryId("");
    setConnectors([]);
    setEvents([]);
    setCases([]);
    setReport(null);
    setConnectorDetail(null);
    setConnectorHistory([]);
    setCaseHistory([]);
    try {
      const connectorQuery = connectorStatus === "ALL" ? "" : "?status=" + encodeURIComponent(connectorStatus);
      const reportQuery = buildIntegrationQuery({ domain: domainFilter, since, until }, "report");
      const eventQuery = buildIntegrationQuery({
        domain: domainFilter, delivery_class: deliveryFilter, source_system: eventSourceFilter, limit: 100,
      }, "events");
      const caseQuery = buildIntegrationQuery({
        domain: domainFilter, status: caseStatusFilter, case_type: caseTypeFilter, limit: 100,
      }, "cases");
      const [connectorResponse, reportResponse, eventResponse, caseResponse] = await Promise.all([
        canReadConnectors ? request("/integrations/connectors" + connectorQuery) : Promise.resolve({ items: [] }),
        canReadReconciliation ? request("/integrations/reconciliation/report" + reportQuery) : Promise.resolve(null),
        canReadReconciliation ? request("/integrations/reconciliation/events" + eventQuery) : Promise.resolve({ items: [] }),
        canReadReconciliation ? request("/integrations/reconciliation/cases" + caseQuery) : Promise.resolve({ items: [] }),
      ]);
      setConnectors(items(connectorResponse) as IntegrationConnector[]);
      setReport(reportResponse ? object(reportResponse) : null);
      setEvents(items(eventResponse) as IntegrationEvent[]);
      setCases(items(caseResponse) as IntegrationCase[]);
      setLoadedFactoryId(activeFactoryId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [
    canRead, canReadConnectors, canReadReconciliation, sessionStatus, activeFactoryId, request,
    connectorStatus, domainFilter, deliveryFilter, eventSourceFilter, caseStatusFilter, caseTypeFilter, since, until,
  ]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, activeFactoryId, canRead, load]);

  useEffect(() => {
    if (!selectedConnectorId || !canReadConnectors || loadedFactoryId !== activeFactoryId) return;
    let current = true;
    void Promise.all([
      request("/integrations/connectors/" + selectedConnectorId),
      request("/integrations/connectors/" + selectedConnectorId + "/history"),
    ]).then(([detail, history]) => {
      if (!current) return;
      setConnectorDetail(object(detail));
      setConnectorHistory(safeHistoryRows(history));
    }).catch((cause) => {
      if (current) setError(messageOf(cause));
    });
    return () => { current = false; };
  }, [selectedConnectorId, canReadConnectors, loadedFactoryId, activeFactoryId, request]);

  useEffect(() => {
    if (!selectedCaseId || !canReadReconciliation || loadedFactoryId !== activeFactoryId) return;
    let current = true;
    void request("/integrations/reconciliation/cases/" + selectedCaseId + "/history")
      .then((history) => {
        if (current) setCaseHistory(safeHistoryRows(history));
      })
      .catch((cause) => {
        if (current) setError(messageOf(cause));
      });
    return () => { current = false; };
  }, [selectedCaseId, canReadReconciliation, loadedFactoryId, activeFactoryId, request]);

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      setNotice(success);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function registerConnector(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    let idempotencyKey: string;
    try {
      body = buildIntegrationConnectorPayload(connectorDraft) as Row;
      idempotencyKey = secureKey();
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/integrations/connectors", { method: "POST", body, idempotencyKey }),
      "Connector registration created. It remains pending until an independent reviewer decides.",
    );
    if (saved) {
      setRegisterOpen(false);
      setConnectorDraft(initialConnector());
    }
  }

  async function submitConnectorAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connectorAction) return;
    const { connectorId, action, reason, secret_reference } = connectorAction;
    let body: Row;
    try {
      body = action === "ROTATE_SECRET"
        ? buildIntegrationSecretRotationPayload(secret_reference, reason) as Row
        : buildIntegrationDecisionPayload(reason) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const route = action === "ROTATE_SECRET" ? "rotate-secret" : action.toLowerCase();
    const saved = await perform(
      () => request("/integrations/connectors/" + connectorId + "/" + route, { method: "POST", body }),
      action === "ROTATE_SECRET" ? "Signing-secret reference updated." : "Connector lifecycle decision recorded.",
    );
    if (saved) setConnectorAction(null);
  }

  async function submitCaseDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!caseAction) return;
    let body: Row;
    try {
      body = buildIntegrationCaseDecisionPayload(
        caseAction.action, caseAction.version, caseAction.reason,
      ) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/integrations/reconciliation/cases/" + caseAction.caseId + "/decision", { method: "POST", body }),
      "Reconciliation case decision recorded.",
    );
    if (saved) setCaseAction(null);
  }

  const domainRows = items(report);
  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-5 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-6 text-white sm:p-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-blue-200">FactoryOS · Integration operations</p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Integration Reliability Workbench</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              Govern connector lifecycles and reconcile attendance, production and quality event streams in the selected factory.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold">
              {hasSession ? "Factory scope active" : "Session required"}
            </span>
            <button type="button" className={SECONDARY} onClick={() => void load()} disabled={!canRead || loading || !hasSession}>
              {loading ? "Refreshing…" : "Refresh workspace"}
            </button>
          </div>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Connectors" value={loading ? "…" : canReadConnectors ? summary.connectors : "—"} detail={canReadConnectors ? summary.activeConnectors + " active · " + summary.pendingConnectors + " pending review" : "Connector read access not granted"} />
          <Metric label="Paused connectors" value={loading ? "…" : canReadConnectors ? summary.pausedConnectors : "—"} detail="Paused pending a controlled resume or key change" />
          <Metric label="Late events" value={loading ? "…" : canReadReconciliation ? summary.lateEvents : "—"} detail={canReadReconciliation ? summary.events + " events in the selected view" : "Reconciliation read access not granted"} />
          <Metric label="Open cases" value={loading ? "…" : canReadReconciliation ? summary.openCases : "—"} detail={canReadReconciliation ? summary.errorCases + " open cases classified as errors" : "Reconciliation read access not granted"} />
        </div>
      </section>

      {!hasSession ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          Connect an authenticated FactoryOS session and select an active factory before opening this workbench.
          <div className="mt-3"><Link href="/session" className="font-semibold underline underline-offset-2">Open session setup</Link></div>
        </section>
      ) : !canRead ? (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
          Your current permission snapshot does not include connector read or reconciliation read access.
        </section>
      ) : null}

      {error ? (
        <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <span>{error}</span>
          <button type="button" className="text-xs font-semibold underline" onClick={() => setError("")}>Dismiss</button>
        </div>
      ) : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div> : null}

      {canRead && hasSession ? (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-pressed={tab === item.id}
                className={"-mb-px min-h-10 border-b-2 px-3 text-xs font-semibold " + (
                  tab === item.id ? "border-blue-700 text-blue-800" : "border-transparent text-slate-500 hover:text-slate-900"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === "CONNECTORS" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
                  <div>
                    <h2 className="text-sm font-bold text-slate-950">Connector register</h2>
                    <p className="mt-1 text-[11px] text-slate-500">Maximum 200 factory-scoped connectors returned by the API.</p>
                  </div>
                  {canWriteConnectors ? <button type="button" className={PRIMARY} onClick={() => setRegisterOpen(true)}>Register connector</button> : null}
                </div>
                <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[1fr_180px]">
                  <input aria-label="Search connectors" className={INPUT} placeholder="Search name, source system or status" value={connectorSearch} onChange={(event) => setConnectorSearch(event.target.value)} />
                  <select aria-label="Connector status" className={INPUT} value={connectorStatus} onChange={(event) => setConnectorStatus(event.target.value)}>
                    <option value="ALL">All statuses</option>
                    <option value="PENDING_REVIEW">Pending review</option>
                    <option value="ACTIVE">Active</option>
                    <option value="PAUSED">Paused</option>
                    <option value="REJECTED">Rejected</option>
                  </select>
                </div>
                {!canReadConnectors ? <Empty>Connector register access is not included in your current permissions.</Empty> : visibleConnectors.length === 0 ? <Empty>No connectors match the current filters.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {visibleConnectors.map((connector) => (
                      <button
                        type="button"
                        key={connector.id}
                        onClick={() => setSelectedConnectorId(connector.id)}
                        className={"flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 " + (selectedConnectorId === connector.id ? "bg-blue-50/70" : "")}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-slate-900">{connector.display_name}</span>
                          <span className="mt-1 block truncate text-[11px] text-slate-500">{connector.source_system} · schema v{connector.schema_version}</span>
                        </span>
                        <span className="flex items-center gap-2"><StatusPill value={connector.status} /><span className="text-[10px] text-slate-400">{shortId(connector.id)}</span></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-sm font-bold text-slate-950">Connector detail & history</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Secret values and secret references are never returned to this UI.</p>
                </div>
                {!selectedConnector ? <Empty>Select a connector to inspect its registered events and lifecycle history.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-900">{selectedConnector.display_name}</p>
                        <StatusPill value={selectedConnector.status} />
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div><dt className="text-slate-500">Source system</dt><dd className="mt-1 font-semibold text-slate-800">{selectedConnector.source_system}</dd></div>
                        <div><dt className="text-slate-500">Schema version</dt><dd className="mt-1 font-semibold text-slate-800">{selectedConnector.schema_version}</dd></div>
                        <div><dt className="text-slate-500">Signing secret</dt><dd className="mt-1 font-semibold text-slate-800">{selectedConnector.has_secret_reference ? "Configured" : "Missing"}</dd></div>
                        <div><dt className="text-slate-500">Registered</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedConnector.created_at)}</dd></div>
                      </dl>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Webhook endpoint</p>
                      <code className="mt-1 block break-all rounded-lg bg-slate-950 p-3 text-[11px] text-emerald-200">{textValue(connectorDetail?.webhook_path, "Loading endpoint…")}</code>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Allowed event types</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(Array.isArray(selectedConnector.allowed_event_types) ? selectedConnector.allowed_event_types : []).map((eventType) => (
                          <span key={eventType} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-700">{eventType}</span>
                        ))}
                      </div>
                    </div>
                    {selectedConnector.decision_reason ? <p className="rounded-lg border border-slate-200 p-3 text-[11px] leading-5 text-slate-600">Latest decision: {selectedConnector.decision_reason}</p> : null}
                    <div className="flex flex-wrap gap-2">
                      {selectedConnector.status === "PENDING_REVIEW" && canApproveConnectors ? <>
                        <button type="button" className={PRIMARY} disabled={busy} onClick={() => setConnectorAction({ connectorId: selectedConnector.id, action: "ACTIVATE", reason: "", secret_reference: "" })}>Approve</button>
                        <button type="button" className={DANGER} disabled={busy} onClick={() => setConnectorAction({ connectorId: selectedConnector.id, action: "REJECT", reason: "", secret_reference: "" })}>Reject</button>
                      </> : null}
                      {selectedConnector.status === "ACTIVE" && canWriteConnectors ? (
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConnectorAction({ connectorId: selectedConnector.id, action: "PAUSE", reason: "", secret_reference: "" })}>Pause</button>
                      ) : null}
                      {selectedConnector.status === "PAUSED" && canApproveConnectors ? <>
                        <button type="button" className={PRIMARY} disabled={busy} onClick={() => setConnectorAction({ connectorId: selectedConnector.id, action: "RESUME", reason: "", secret_reference: "" })}>Resume</button>
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConnectorAction({ connectorId: selectedConnector.id, action: "ROTATE_SECRET", reason: "", secret_reference: "" })}>Rotate secret reference</button>
                      </> : null}
                    </div>
                    <div className="border-t border-slate-100 pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Lifecycle history</p>
                      {connectorHistory.length === 0 ? <p className="mt-2 text-[11px] text-slate-500">No history rows returned.</p> : (
                        <ol className="mt-2 space-y-2">
                          {connectorHistory.map((entry) => (
                            <li key={String(entry.id)} className="border-l-2 border-slate-200 pl-3">
                              <p className="text-[11px] font-bold text-slate-800">{textValue(entry.action)}</p>
                              <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{textValue(entry.reason)} · {dateTime(entry.created_at)}</p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </>
                )}
              </aside>
            </section>
          ) : null}

          {tab === "EVENTS" ? (
            <section className="flex flex-col gap-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-950">Operational event stream</h2>
                    <p className="mt-1 text-[11px] text-slate-500">Received event metadata only; raw payload, payload hashes and external identifiers are excluded.</p>
                  </div>
                  <div className="grid w-full gap-2 sm:grid-cols-3 lg:w-auto">
                    <select aria-label="Event domain" className={INPUT} value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}>
                      <option value="ALL">All domains</option><option value="ATTENDANCE">Attendance</option><option value="PRODUCTION">Production</option><option value="QUALITY">Quality</option>
                    </select>
                    <select aria-label="Delivery classification" className={INPUT} value={deliveryFilter} onChange={(event) => setDeliveryFilter(event.target.value)}>
                      <option value="ALL">All delivery classes</option><option value="ON_TIME">On time</option><option value="LATE">Late</option>
                    </select>
                    <input aria-label="Source system filter" className={INPUT} placeholder="Source system (optional)" value={eventSourceFilter} onChange={(event) => setEventSourceFilter(event.target.value)} />
                  </div>
                </div>
                {!canReadReconciliation ? <div className="mt-4"><Empty>Reconciliation read access is not included in your current permissions.</Empty></div> : events.length === 0 ? <div className="mt-4"><Empty>No operational events match the selected filters.</Empty></div> : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                      <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-2">Domain / source</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Stream sequence</th><th className="px-3 py-2">Occurred</th><th className="px-3 py-2">Delivery</th><th className="px-3 py-2">Received</th>
                      </tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {events.map((event) => (
                          <tr key={event.id}>
                            <td className="px-3 py-3"><p className="font-semibold text-slate-900">{event.domain}</p><p className="mt-1 text-[10px] text-slate-500">{event.source_system}</p></td>
                            <td className="px-3 py-3"><p className="font-semibold text-slate-800">{event.event_type}</p><p className="mt-1 text-[10px] text-slate-500">Schema v{event.schema_version}</p></td>
                            <td className="px-3 py-3 tabular-nums text-slate-700">{textValue(event.source_sequence)}{event.watermark_through_sequence !== null && event.watermark_through_sequence !== undefined ? " · watermark " + event.watermark_through_sequence : ""}</td>
                            <td className="px-3 py-3 text-slate-600">{dateTime(event.occurred_at)}</td>
                            <td className="px-3 py-3"><StatusPill value={event.delivery_class} /></td>
                            <td className="px-3 py-3 text-slate-600">{dateTime(event.received_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <h3 className="text-xs font-bold text-slate-900">Reconciliation report by domain</h3>
                <p className="mt-1 text-[11px] text-slate-500">Values are returned by the API for this selected factory and time window.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {domainRows.map((row) => (
                    <article key={String(row.domain)} className="rounded-xl border border-slate-200 p-3">
                      <p className="text-xs font-bold text-slate-900">{String(row.domain)}</p>
                      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
                        <div><dt className="text-slate-500">Accepted</dt><dd className="font-bold tabular-nums">{countValue(row.accepted_events)}</dd></div>
                        <div><dt className="text-slate-500">Late</dt><dd className="font-bold tabular-nums">{countValue(row.late_events)}</dd></div>
                        <div><dt className="text-slate-500">Open cases</dt><dd className="font-bold tabular-nums">{countValue(row.open_cases)}</dd></div>
                        <div><dt className="text-slate-500">Open errors</dt><dd className="font-bold tabular-nums">{countValue(row.open_errors)}</dd></div>
                        <div><dt className="text-slate-500">Duplicate replays</dt><dd className="font-bold tabular-nums">{countValue(row.duplicate_replays)}</dd></div>
                        <div><dt className="text-slate-500">Conflicting duplicates</dt><dd className="font-bold tabular-nums">{countValue(row.conflicting_duplicates)}</dd></div>
                      </dl>
                    </article>
                  ))}
                  {domainRows.length === 0 ? <Empty>No report rows returned.</Empty> : null}
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Field label="Window starts"><input type="datetime-local" className={INPUT} value={since} onChange={(event) => setSince(event.target.value)} /></Field>
                  <Field label="Window ends"><input type="datetime-local" className={INPUT} value={until} onChange={(event) => setUntil(event.target.value)} /></Field>
                  <button type="button" className={SECONDARY + " self-end"} onClick={() => void load()} disabled={loading}>Apply time window</button>
                </div>
              </div>
            </section>
          ) : null}

          {tab === "CASES" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-4">
                  <h2 className="text-sm font-bold text-slate-950">Reconciliation exception queue</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Review missing/invalid event times, sequence gaps, duplicates and cross-source conflicts.</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    <select aria-label="Case domain" className={INPUT} value={domainFilter} onChange={(event) => setDomainFilter(event.target.value)}>
                      <option value="ALL">All domains</option><option value="ATTENDANCE">Attendance</option><option value="PRODUCTION">Production</option><option value="QUALITY">Quality</option>
                    </select>
                    <select aria-label="Case status" className={INPUT} value={caseStatusFilter} onChange={(event) => setCaseStatusFilter(event.target.value)}>
                      <option value="ALL">All statuses</option><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option><option value="WAIVED">Waived</option>
                    </select>
                    <select aria-label="Case type" className={INPUT} value={caseTypeFilter} onChange={(event) => setCaseTypeFilter(event.target.value)}>
                      <option value="ALL">All case types</option>
                      <option value="MISSING_EVENT_TIME">Missing event time</option>
                      <option value="INVALID_EVENT_TIME">Invalid event time</option>
                      <option value="INVALID_SEQUENCE">Invalid sequence</option>
                      <option value="MISSING_SEQUENCE_RANGE">Missing sequence range</option>
                      <option value="SEQUENCE_COLLISION">Sequence collision</option>
                      <option value="CROSS_SOURCE_CONFLICT">Cross-source conflict</option>
                      <option value="CONFLICTING_DUPLICATE">Conflicting duplicate</option>
                      <option value="DUPLICATE_BUSINESS_EVENT">Duplicate business event</option>
                      <option value="BUSINESS_EVENT_CONFLICT">Business event conflict</option>
                    </select>
                  </div>
                </div>
                {!canReadReconciliation ? <Empty>Reconciliation read access is not included in your current permissions.</Empty> : cases.length === 0 ? <Empty>No cases match the current filters.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {cases.map((row) => (
                      <button
                        type="button"
                        key={row.id}
                        onClick={() => setSelectedCaseId(row.id)}
                        className={"flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 " + (selectedCaseId === row.id ? "bg-blue-50/70" : "")}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-slate-900">{row.case_type.replaceAll("_", " ")}</span>
                          <span className="mt-1 block text-[10px] text-slate-500">{row.domain} · opened {dateTime(row.opened_at)}</span>
                        </span>
                        <span className="flex items-center gap-2"><StatusPill value={row.severity} /><StatusPill value={row.status} /></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-sm font-bold text-slate-950">Case review</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Decisions are optimistic-versioned and recorded by the API.</p>
                </div>
                {!selectedCase ? <Empty>Select an exception to inspect its lifecycle and decision history.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-900">{selectedCase.case_type.replaceAll("_", " ")}</p>
                        <StatusPill value={selectedCase.status} />
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div><dt className="text-slate-500">Domain</dt><dd className="mt-1 font-semibold">{selectedCase.domain}</dd></div>
                        <div><dt className="text-slate-500">Severity</dt><dd className="mt-1 font-semibold">{selectedCase.severity}</dd></div>
                        <div><dt className="text-slate-500">Row version</dt><dd className="mt-1 font-semibold tabular-nums">{selectedCase.row_version}</dd></div>
                        <div><dt className="text-slate-500">Opened</dt><dd className="mt-1 font-semibold">{dateTime(selectedCase.opened_at)}</dd></div>
                      </dl>
                      {selectedCase.resolution_reason ? <p className="mt-3 border-t border-slate-200 pt-3 text-[11px] leading-5 text-slate-600">Decision reason: {selectedCase.resolution_reason}</p> : null}
                    </div>
                    {selectedCase.status === "OPEN" && canReviewReconciliation ? (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={PRIMARY} disabled={busy} onClick={() => setCaseAction({ caseId: selectedCase.id, action: "RESOLVE", version: integrationCaseVersion(selectedCase.row_version) ?? 0, reason: "" })}>Resolve case</button>
                        <button type="button" className={SECONDARY} disabled={busy} onClick={() => setCaseAction({ caseId: selectedCase.id, action: "WAIVE", version: integrationCaseVersion(selectedCase.row_version) ?? 0, reason: "" })}>Waive case</button>
                      </div>
                    ) : selectedCase.status === "OPEN" ? (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">Read-only: the current permission snapshot does not include reconciliation review access.</p>
                    ) : null}
                    <div className="border-t border-slate-100 pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Decision history</p>
                      {caseHistory.length === 0 ? <p className="mt-2 text-[11px] text-slate-500">No history rows returned.</p> : (
                        <ol className="mt-2 space-y-2">
                          {caseHistory.map((entry) => (
                            <li key={String(entry.id)} className="border-l-2 border-slate-200 pl-3">
                              <p className="text-[11px] font-bold text-slate-800">{textValue(entry.action)} · {textValue(entry.status)}</p>
                              <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{textValue(entry.reason)} · {dateTime(entry.happened_at)}</p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </>
                )}
              </aside>
            </section>
          ) : null}
        </>
      ) : null}

      {registerOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center">
          <form onSubmit={registerConnector} className="my-6 w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-lg font-bold text-slate-950">Register integration connector</h2><p className="mt-1 text-xs text-slate-500">Registration creates a pending record; activation requires an independent reviewer.</p></div>
              <button type="button" className={SECONDARY} onClick={() => setRegisterOpen(false)}>Close</button>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Display name"><input required minLength={2} maxLength={160} className={INPUT} value={connectorDraft.display_name} onChange={(event) => setConnectorDraft({ ...connectorDraft, display_name: event.target.value })} /></Field>
              <Field label="Source system" hint="Canonical uppercase code, 2–120 characters."><input required maxLength={120} className={INPUT} placeholder="WORKFORCE_PAYROLL" value={connectorDraft.source_system} onChange={(event) => setConnectorDraft({ ...connectorDraft, source_system: event.target.value })} /></Field>
              <Field label="Signing-secret reference" hint="Only the environment alias is supplied; the secret value is never entered here.">
                <input required maxLength={100} className={INPUT} placeholder="env://WEBHOOK_SECRET_PAYROLL" value={connectorDraft.secret_reference} onChange={(event) => setConnectorDraft({ ...connectorDraft, secret_reference: event.target.value })} />
              </Field>
              <Field label="Schema version"><input required type="number" min={1} max={10000} step={1} className={INPUT} value={connectorDraft.schema_version} onChange={(event) => setConnectorDraft({ ...connectorDraft, schema_version: event.target.value })} /></Field>
              <div className="sm:col-span-2">
                <Field label="Allowed event types" hint="Comma- or newline-separated unique uppercase event identifiers; maximum 100.">
                  <textarea required rows={3} className={AREA} placeholder={"WORKFORCE.ATTENDANCE.CLOCK_IN\nWORKFORCE.ATTENDANCE.CLOCK_OUT"} value={connectorDraft.allowed_event_types} onChange={(event) => setConnectorDraft({ ...connectorDraft, allowed_event_types: event.target.value })} />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Webhook payload JSON schema" hint="Root must be an object; schema depth, allowed keywords and credential-like field names are validated before submission.">
                  <textarea required rows={10} spellCheck={false} className={AREA + " font-mono text-xs"} value={connectorDraft.payload_schema} onChange={(event) => setConnectorDraft({ ...connectorDraft, payload_schema: event.target.value })} />
                </Field>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setRegisterOpen(false)}>Cancel</button>
              <button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Submitting…" : "Create pending connector"}</button>
            </div>
          </form>
        </div>
      ) : null}

      {connectorAction ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center">
          <form onSubmit={submitConnectorAction} className="my-6 w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <h2 className="text-lg font-bold text-slate-950">{connectorAction.action === "ROTATE_SECRET" ? "Rotate signing-secret reference" : connectorAction.action + " connector"}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {connectorAction.action === "ROTATE_SECRET"
                ? "The connector must already be paused. Enter the new environment alias only; the backend verifies that its configured secret exists."
                : "The API validates the lifecycle state, permission and maker-checker separation before recording this decision."}
            </p>
            {connectorAction.action === "ROTATE_SECRET" ? (
              <Field label="New secret reference"><input required maxLength={100} className={INPUT} placeholder="env://WEBHOOK_SECRET_PAYROLL_NEXT" value={connectorAction.secret_reference} onChange={(event) => setConnectorAction({ ...connectorAction, secret_reference: event.target.value })} /></Field>
            ) : null}
            <div className="mt-4">
              <Field label="Reason" hint="3–500 characters; retained in connector history.">
                <textarea required minLength={3} maxLength={500} rows={3} className={AREA} value={connectorAction.reason} onChange={(event) => setConnectorAction({ ...connectorAction, reason: event.target.value })} />
              </Field>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setConnectorAction(null)}>Cancel</button>
              <button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Saving…" : "Confirm action"}</button>
            </div>
          </form>
        </div>
      ) : null}

      {caseAction ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center">
          <form onSubmit={submitCaseDecision} className="my-6 w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <h2 className="text-lg font-bold text-slate-950">{caseAction.action === "RESOLVE" ? "Resolve reconciliation case" : "Waive reconciliation case"}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">This submits row version {caseAction.version}. If another reviewer has changed the case, reload it before deciding.</p>
            <div className="mt-4">
              <Field label="Decision reason" hint="10–500 characters; required for both resolve and waive.">
                <textarea required minLength={10} maxLength={500} rows={4} className={AREA} value={caseAction.reason} onChange={(event) => setCaseAction({ ...caseAction, reason: event.target.value })} />
              </Field>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setCaseAction(null)}>Cancel</button>
              <button type="submit" className={PRIMARY} disabled={busy || caseAction.version < 1}>{busy ? "Saving…" : "Confirm " + caseAction.action.toLowerCase()}</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
