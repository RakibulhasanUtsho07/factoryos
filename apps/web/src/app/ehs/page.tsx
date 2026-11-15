"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createEhsWorkspaceClient } from "@/lib/ehs-workspace.mjs";
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
type EhsView = "incidents" | "permits";
type ListResult = {
  key: string;
  items: JsonRecord[];
  error: string;
};
type ActionsResult = {
  key: string;
  items: JsonRecord[];
  error: string;
};

const INCIDENT_STATUS_OPTIONS = [
  { value: "", label: "All incident statuses" },
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "ACTION_REQUIRED", label: "Action required" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

const SEVERITY_OPTIONS = [
  { value: "", label: "All severities" },
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
] as const;

const PERMIT_STATUS_OPTIONS = [
  { value: "", label: "All permit statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ACTIVE", label: "Active" },
  { value: "CLOSED", label: "Closed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "EXPIRED", label: "Expired" },
] as const;

const RISK_OPTIONS = [
  { value: "", label: "All risk levels" },
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
] as const;

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

function displayLabel(value: unknown): string {
  return valueText(value, "Unknown").replaceAll("_", " ").toLowerCase();
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

function getItems(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return asRecords(payload);
  return asRecords(asRecord(payload).items);
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value)}</dd>
    </div>
  );
}

function RecordCount({ count, label }: { count: number; label: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{count}</p>
      <p className="mt-1 text-xs text-slate-500">Rows returned · maximum 100</p>
    </div>
  );
}

export default function EhsWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [requestedView, setRequestedView] = useState<EhsView>("incidents");
  const [incidentStatus, setIncidentStatus] = useState("");
  const [incidentSeverity, setIncidentSeverity] = useState("");
  const [permitStatus, setPermitStatus] = useState("");
  const [permitRisk, setPermitRisk] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selection, setSelection] = useState<{ scopeKey: string; recordId: string } | null>(null);
  const [listResult, setListResult] = useState<ListResult | null>(null);
  const [actionsResult, setActionsResult] = useState<ActionsResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadIncidents = connected && hasPermission("ehs.incidents.read");
  const canReadPermits = connected && hasPermission("ehs.permits.read");
  const canReadEhs = canReadIncidents || canReadPermits;
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const view: EhsView = requestedView === "incidents"
    ? canReadIncidents ? "incidents" : "permits"
    : canReadPermits ? "permits" : "incidents";

  const listKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadIncidents,
    canReadPermits,
    view,
    incidentStatus,
    incidentSeverity,
    permitStatus,
    permitRisk,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadIncidents,
    canReadPermits,
    view,
    incidentStatus,
    incidentSeverity,
    permitStatus,
    permitRisk,
    refreshVersion,
  ]);

  const currentList = listResult?.key === listKey ? listResult : null;
  const items = currentList?.items ?? [];
  const selectedRecordId = selection?.scopeKey === scopeKey ? selection.recordId : "";
  const selectedRecord = items.find((item) => valueText(item.id, "") === selectedRecordId) ?? null;
  const selectedIncidentId = view === "incidents" && selectedRecord
    ? valueText(selectedRecord.id, "")
    : "";
  const actionsKey = useMemo(
    () => JSON.stringify([listKey, selectedIncidentId]),
    [listKey, selectedIncidentId],
  );
  const currentActions = actionsResult?.key === actionsKey ? actionsResult : null;
  const loadingList = connected && Boolean(activeFactoryId) && canReadEhs && currentList === null;
  const loadingActions = view === "incidents" && Boolean(selectedIncidentId) && currentActions === null;

  useEffect(() => {
    if (!connected || !activeFactoryId) return;
    if (view === "incidents" && !canReadIncidents) return;
    if (view === "permits" && !canReadPermits) return;

    let active = true;
    const client = createEhsWorkspaceClient({ request });
    const load = async () => {
      try {
        const payload = view === "incidents"
          ? await client.listIncidents({
            status: incidentStatus || undefined,
            severity: incidentSeverity || undefined,
            limit: 100,
          })
          : await client.listPermits({
            status: permitStatus || undefined,
            riskLevel: permitRisk || undefined,
            limit: 100,
          });
        if (!active) return;
        setListResult({ key: listKey, items: getItems(payload), error: "" });
      } catch (cause) {
        if (!active) return;
        setListResult({
          key: listKey,
          items: [],
          error: cause instanceof Error ? cause.message : "EHS records could not be loaded.",
        });
      }
    };
    void load();

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadIncidents,
    canReadPermits,
    request,
    view,
    incidentStatus,
    incidentSeverity,
    permitStatus,
    permitRisk,
    refreshVersion,
    listKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadIncidents
      || view !== "incidents" || !selectedIncidentId) return;

    let active = true;
    const client = createEhsWorkspaceClient({ request });
    void client.listCorrectiveActions(selectedIncidentId, { limit: 100 }).then((payload) => {
      if (!active) return;
      setActionsResult({ key: actionsKey, items: getItems(payload), error: "" });
    }).catch((cause: unknown) => {
      if (!active) return;
      setActionsResult({
        key: actionsKey,
        items: [],
        error: cause instanceof Error ? cause.message : "Corrective actions could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadIncidents,
    request,
    view,
    selectedIncidentId,
    actionsKey,
  ]);

  const correctiveActions = currentActions?.items ?? [];

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  function changeView(next: EhsView) {
    setSelection(null);
    setRequestedView(next);
  }

  function changeIncidentStatus(value: string) {
    setSelection(null);
    setIncidentStatus(value);
  }

  function changeIncidentSeverity(value: string) {
    setSelection(null);
    setIncidentSeverity(value);
  }

  function changePermitStatus(value: string) {
    setSelection(null);
    setPermitStatus(value);
  }

  function changePermitRisk(value: string) {
    setSelection(null);
    setPermitRisk(value);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Environmental · health · safety"
        title="EHS & Safety Workbench"
        description="Review factory-scoped safety incidents, corrective actions and permit-to-work records."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!connected || !activeFactoryId || !canReadEhs || loadingList || loadingActions}
            >
              Refresh EHS
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
            : "Connect an existing FactoryOS session to inspect EHS records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canReadEhs ? "success" : "info"} title="EHS read permissions">
          {canReadIncidents && canReadPermits
            ? "Incident and corrective-action reads require ehs.incidents.read; permit reads require ehs.permits.read. The API independently enforces factory scope."
            : canReadIncidents
              ? "Incident and corrective-action reads are available. Permit records require ehs.permits.read."
              : canReadPermits
                ? "Permit records are available. Incident and corrective-action reads require ehs.incidents.read."
                : "The current IAM permission snapshot does not include ehs.incidents.read or ehs.permits.read."}
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory returned by the authenticated IAM session. EHS records are never loaded across all factories."
        />
      ) : null}

      {connected && activeFactoryId && !canReadEhs ? (
        <EmptyState
          title="EHS access is not available"
          description="Ask an authorized administrator to review ehs.incidents.read and/or ehs.permits.read for this workspace."
        />
      ) : null}

      {connected && activeFactoryId && canReadEhs ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            {canReadIncidents ? (
              <button
                type="button"
                onClick={() => changeView("incidents")}
                aria-pressed={view === "incidents"}
                className={[
                  "rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                  view === "incidents"
                    ? "border-brand-300 bg-brand-50"
                    : "border-slate-200 bg-white hover:bg-slate-50",
                ].join(" ")}
              >
                <span className="block text-sm font-semibold text-slate-950">Safety incidents</span>
                <span className="mt-1 block text-xs text-slate-500">Incidents, near misses and corrective actions</span>
              </button>
            ) : null}
            {canReadPermits ? (
              <button
                type="button"
                onClick={() => changeView("permits")}
                aria-pressed={view === "permits"}
                className={[
                  "rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                  view === "permits"
                    ? "border-brand-300 bg-brand-50"
                    : "border-slate-200 bg-white hover:bg-slate-50",
                ].join(" ")}
              >
                <span className="block text-sm font-semibold text-slate-950">Permit to work</span>
                <span className="mt-1 block text-xs text-slate-500">Hot work, LOTO, confined space and other permits</span>
              </button>
            ) : null}
          </div>

          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <RecordCount
              label={view === "incidents" ? "Incidents returned" : "Permits returned"}
              count={items.length}
            />
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current view</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {view === "incidents" ? "Incident & corrective actions" : "Safety permits"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {view === "incidents"
                  ? "Corrective-action list loads only for a selected incident."
                  : "Permit details are limited to the 100 returned records."}
              </p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>{view === "incidents" ? "Safety incident register" : "Permit-to-work register"}</CardTitle>
                  <CardDescription>
                    {view === "incidents"
                      ? "Filter incident status and severity, then review the corrective-action register."
                      : "Filter permit status and risk level, then review scope, validity and isolation requirements."}
                  </CardDescription>
                </div>
                <Badge tone="neutral">Maximum 100 rows</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                {view === "incidents" ? (
                  <>
                    <div>
                      <label htmlFor="ehs-incident-status" className="block text-xs font-semibold text-slate-700">Incident status</label>
                      <select
                        id="ehs-incident-status"
                        value={incidentStatus}
                        onChange={(event) => changeIncidentStatus(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {INCIDENT_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="ehs-incident-severity" className="block text-xs font-semibold text-slate-700">Severity</label>
                      <select
                        id="ehs-incident-severity"
                        value={incidentSeverity}
                        onChange={(event) => changeIncidentSeverity(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {SEVERITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label htmlFor="ehs-permit-status" className="block text-xs font-semibold text-slate-700">Permit status</label>
                      <select
                        id="ehs-permit-status"
                        value={permitStatus}
                        onChange={(event) => changePermitStatus(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {PERMIT_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="ehs-permit-risk" className="block text-xs font-semibold text-slate-700">Risk level</label>
                      <select
                        id="ehs-permit-risk"
                        value={permitRisk}
                        onChange={(event) => changePermitRisk(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {RISK_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </div>

              {currentList?.error ? (
                <Alert tone="danger" title="Could not load EHS records">{currentList.error}</Alert>
              ) : loadingList ? (
                <div className="space-y-3" aria-label="Loading EHS records">
                  {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
                </div>
              ) : items.length === 0 ? (
                <EmptyState
                  title={view === "incidents" ? "No safety incidents returned" : "No safety permits returned"}
                  description="No records were returned for this factory and the current filters."
                />
              ) : view === "incidents" ? (
                <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                  <div className="space-y-2">
                    {items.map((item) => {
                      const id = valueText(item.id, "");
                      const selected = id !== "" && id === selectedRecordId;
                      return (
                        <button
                          type="button"
                          key={id}
                          disabled={!id}
                          onClick={() => setSelection({ scopeKey, recordId: id })}
                          aria-pressed={selected}
                          className={[
                            "w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                            selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                          ].join(" ")}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-950">{valueText(item.incident_number, "Incident")}</p>
                              <p className="mt-1 text-sm text-slate-700">{valueText(item.title)}</p>
                            </div>
                            <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                            <span>{displayLabel(item.incident_type)}</span>
                            <span>Severity: {displayLabel(item.severity)}</span>
                            <span>{valueText(item.location, "Location not recorded")}</span>
                          </div>
                          <p className="mt-2 text-[11px] text-slate-500">
                            Occurred {formatDateTime(item.occurred_at)} · Due {formatDate(item.due_at)}
                          </p>
                        </button>
                      );
                    })}
                    <p className="pt-1 text-[11px] text-slate-500">
                      Showing {items.length} of up to 100 incidents returned.
                    </p>
                  </div>

                  <div className="min-w-0">
                    {!selectedIncidentId || !selectedRecord ? (
                      <EmptyState
                        title="Select a safety incident"
                        description="Choose an incident to review its description, investigation summary, root cause and corrective-action register."
                      />
                    ) : (
                      <div className="space-y-4">
                        <section className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Incident record</p>
                              <h3 className="mt-1 text-lg font-semibold text-slate-950">{valueText(selectedRecord.title)}</h3>
                              <p className="mt-1 text-xs text-slate-500">
                                {valueText(selectedRecord.incident_number)} · {displayLabel(selectedRecord.incident_type)}
                              </p>
                            </div>
                            <StatusBadge status={valueText(selectedRecord.status, "UNKNOWN")} />
                          </div>
                          <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                            <DetailField label="Severity" value={displayLabel(selectedRecord.severity)} />
                            <DetailField label="Location" value={selectedRecord.location} />
                            <DetailField label="Occurred at" value={formatDateTime(selectedRecord.occurred_at)} />
                            <DetailField label="Action due" value={formatDate(selectedRecord.due_at)} />
                            <DetailField label="Created" value={formatDateTime(selectedRecord.created_at)} />
                            <DetailField label="Last updated" value={formatDateTime(selectedRecord.updated_at)} />
                          </dl>
                          <div className="mt-4 space-y-3">
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Description</p>
                              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                                {valueText(selectedRecord.description, "No description recorded.")}
                              </p>
                            </div>
                            {selectedRecord.immediate_action ? (
                              <div>
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Immediate action</p>
                                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                                  {valueText(selectedRecord.immediate_action)}
                                </p>
                              </div>
                            ) : null}
                            {selectedRecord.investigation_summary ? (
                              <div>
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Investigation summary</p>
                                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                                  {valueText(selectedRecord.investigation_summary)}
                                </p>
                              </div>
                            ) : null}
                            {selectedRecord.root_cause ? (
                              <div>
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Root cause</p>
                                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                                  {valueText(selectedRecord.root_cause)}
                                </p>
                              </div>
                            ) : null}
                          </div>
                        </section>

                        <section className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="font-semibold text-slate-950">Corrective actions</h3>
                            <Badge tone="neutral">{correctiveActions.length} returned</Badge>
                          </div>
                          {currentActions?.error ? (
                            <Alert tone="danger" title="Could not load corrective actions">{currentActions.error}</Alert>
                          ) : loadingActions ? (
                            <div className="mt-3 space-y-2" aria-label="Loading corrective actions">
                              {[1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded-lg bg-slate-100" />)}
                            </div>
                          ) : correctiveActions.length === 0 ? (
                            <p className="mt-3 text-sm text-slate-500">No corrective actions were returned for this incident.</p>
                          ) : (
                            <div className="mt-3 space-y-2">
                              {correctiveActions.map((action) => (
                                <article key={valueText(action.id, valueText(action.action_number))} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                                  <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                      <p className="text-sm font-semibold text-slate-900">{valueText(action.action_number, "Corrective action")}</p>
                                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{valueText(action.description)}</p>
                                    </div>
                                    <StatusBadge status={valueText(action.status, "UNKNOWN")} />
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                                    <span>Due {formatDate(action.due_at)}</span>
                                    <span>Updated {formatDateTime(action.updated_at)}</span>
                                  </div>
                                  {action.root_cause ? (
                                    <p className="mt-2 text-xs text-slate-600">Root cause: {valueText(action.root_cause)}</p>
                                  ) : null}
                                </article>
                              ))}
                            </div>
                          )}
                          <p className="mt-3 text-[11px] text-slate-500">
                            Evidence payloads, actor IDs and internal audit metadata are not displayed.
                          </p>
                        </section>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                  <div className="space-y-2">
                    {items.map((item) => {
                      const id = valueText(item.id, "");
                      const selected = id !== "" && id === selectedRecordId;
                      return (
                        <button
                          type="button"
                          key={id}
                          disabled={!id}
                          onClick={() => setSelection({ scopeKey, recordId: id })}
                          aria-pressed={selected}
                          className={[
                            "w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                            selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                          ].join(" ")}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-950">{valueText(item.permit_number, "Safety permit")}</p>
                              <p className="mt-1 text-sm text-slate-700">{valueText(item.title)}</p>
                            </div>
                            <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                            <span>{displayLabel(item.permit_type)}</span>
                            <span>Risk: {displayLabel(item.risk_level)}</span>
                            <span>{valueText(item.location, "Location not recorded")}</span>
                          </div>
                          <p className="mt-2 text-[11px] text-slate-500">
                            Valid until {formatDateTime(item.expires_at)}
                          </p>
                        </button>
                      );
                    })}
                    <p className="pt-1 text-[11px] text-slate-500">
                      Showing {items.length} of up to 100 permits returned.
                    </p>
                  </div>

                  <div className="min-w-0">
                    {!selectedRecord ? (
                      <EmptyState
                        title="Select a safety permit"
                        description="Choose a permit to review its work scope, validity window, risk level and isolation requirements."
                      />
                    ) : (
                      <section className="rounded-xl border border-slate-200 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Permit record</p>
                            <h3 className="mt-1 text-lg font-semibold text-slate-950">{valueText(selectedRecord.title)}</h3>
                            <p className="mt-1 text-xs text-slate-500">{valueText(selectedRecord.permit_number)}</p>
                          </div>
                          <StatusBadge status={valueText(selectedRecord.status, "UNKNOWN")} />
                        </div>
                        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                          <DetailField label="Permit type" value={displayLabel(selectedRecord.permit_type)} />
                          <DetailField label="Risk level" value={displayLabel(selectedRecord.risk_level)} />
                          <DetailField label="Location" value={selectedRecord.location} />
                          <DetailField label="Linked work order" value={selectedRecord.work_order_id ? "Linked" : "Not linked"} />
                          <DetailField label="Valid from" value={formatDateTime(selectedRecord.valid_from)} />
                          <DetailField label="Expires at" value={formatDateTime(selectedRecord.expires_at)} />
                          <DetailField label="Isolation required" value={selectedRecord.requires_isolation === true ? "Yes" : "No"} />
                          <DetailField label="Isolation points declared" value={asRecords(selectedRecord.isolation_points).length} />
                        </dl>
                        <div className="mt-4">
                          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Work scope</p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                            {valueText(selectedRecord.work_scope, "No work scope recorded.")}
                          </p>
                        </div>
                        {selectedRecord.decision_reason ? (
                          <div className="mt-4">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Decision reason</p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                              {valueText(selectedRecord.decision_reason)}
                            </p>
                          </div>
                        ) : null}
                        <p className="mt-4 text-[11px] text-slate-500">
                          Isolation verification evidence, actor IDs and internal audit metadata are not displayed.
                        </p>
                      </section>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </main>
  );
}
