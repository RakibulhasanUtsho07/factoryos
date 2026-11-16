"use client";

import { useEffect, useMemo, useState } from "react";

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
import { createUtilitiesWorkbenchClient } from "@/lib/utilities-workbench.mjs";

type JsonRecord = Record<string, unknown>;
type UtilitiesTab = "meters" | "events" | "alerts" | "sources";
type ItemsResult = { key: string; items: JsonRecord[]; error: string };
type AlertResult = { key: string; alerts: JsonRecord[]; policies: JsonRecord[]; error: string };

const UTILITY_TYPE_OPTIONS = [
  ["", "All utility types"],
  ["ELECTRICITY", "Electricity"],
  ["GAS", "Gas"],
  ["STEAM", "Steam"],
  ["WATER", "Water"],
  ["COMPRESSED_AIR", "Compressed air"],
  ["FUEL", "Fuel"],
  ["OTHER", "Other"],
] as const;

const METER_STATUS_OPTIONS = [
  ["", "All meter statuses"],
  ["ACTIVE", "Active"],
  ["INACTIVE", "Inactive"],
  ["RETIRED", "Retired"],
] as const;

const EVENT_STATUS_OPTIONS = [
  ["", "All event statuses"],
  ["OPEN", "Open"],
  ["ACKNOWLEDGED", "Acknowledged"],
  ["RESOLVED", "Resolved"],
  ["CANCELLED", "Cancelled"],
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

function itemsFrom(value: unknown): JsonRecord[] {
  return asRecords(asRecord(value).items);
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

function formatNumber(value: unknown, digits = 3): string {
  const number = numberValue(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(number);
}

function formatMoney(value: unknown, currency: unknown): string {
  const amount = numberValue(value);
  const code = valueText(currency, "").toUpperCase();
  if (amount === null) return "—";
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return formatNumber(amount, 2) + " " + code;
    }
  }
  return formatNumber(amount, 2) + (code ? " " + code : "");
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

function severityTone(value: unknown): "danger" | "warning" | "info" | "neutral" {
  const severity = valueText(value, "").toUpperCase();
  if (severity === "CRITICAL") return "danger";
  if (severity === "HIGH") return "warning";
  if (severity === "MEDIUM") return "info";
  return "neutral";
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        {children}
      </table>
    </div>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
      {children}
    </thead>
  );
}

function UtilitiesWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const connected = sessionStatus === "connected" && snapshot !== null && Boolean(activeFactoryId);
  const canReadMeters = connected && hasPermission("utilities.meters.read");
  const canReadReadings = connected && hasPermission("utilities.readings.read");
  const canReadEvents = connected && hasPermission("utilities.events.read");
  const canReadAlerts = connected && hasPermission("utilities.alerts.read");

  const [requestedTab, setRequestedTab] = useState<UtilitiesTab>("meters");
  const [utilityType, setUtilityType] = useState("");
  const [meterStatus, setMeterStatus] = useState("");
  const [selectedMeterId, setSelectedMeterId] = useState("");
  const [readingFrom, setReadingFrom] = useState("");
  const [readingTo, setReadingTo] = useState("");
  const [eventStatus, setEventStatus] = useState("");
  const [alertStatus, setAlertStatus] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [meterResult, setMeterResult] = useState<ItemsResult | null>(null);
  const [readingResult, setReadingResult] = useState<ItemsResult | null>(null);
  const [eventResult, setEventResult] = useState<ItemsResult | null>(null);
  const [sourceResult, setSourceResult] = useState<ItemsResult | null>(null);
  const [alertResult, setAlertResult] = useState<AlertResult | null>(null);

  const client = useMemo(
    () => createUtilitiesWorkbenchClient({ request }),
    [request],
  );

  const tabs: { id: UtilitiesTab; label: string; enabled: boolean }[] = [
    { id: "meters", label: "Meters & readings", enabled: canReadMeters },
    { id: "events", label: "Utility events", enabled: canReadEvents },
    { id: "alerts", label: "Threshold alerts", enabled: canReadAlerts },
    { id: "sources", label: "Source mappings", enabled: canReadMeters },
  ];
  const activeTab = tabs.some((tab) => tab.id === requestedTab && tab.enabled)
    ? requestedTab
    : tabs.find((tab) => tab.enabled)?.id ?? null;

  const meterQueryKey = [
    activeFactoryId,
    utilityType,
    meterStatus,
    refreshVersion,
  ].join("|");
  const visibleMeterResult = meterResult?.key === meterQueryKey ? meterResult : null;
  const meterItems = visibleMeterResult?.items ?? [];
  const selectedMeter = meterItems.find((meter) =>
    valueText(meter.id, "").toLowerCase() === selectedMeterId.toLowerCase())
    ?? meterItems[0]
    ?? null;
  const effectiveMeterId = selectedMeter ? valueText(selectedMeter.id, "") : "";
  const readingQueryKey = [
    activeFactoryId,
    effectiveMeterId,
    readingFrom,
    readingTo,
    refreshVersion,
  ].join("|");
  const visibleReadingResult = readingResult?.key === readingQueryKey ? readingResult : null;

  const eventQueryKey = [activeFactoryId, eventStatus, refreshVersion].join("|");
  const visibleEventResult = eventResult?.key === eventQueryKey ? eventResult : null;

  const alertQueryKey = [activeFactoryId, alertStatus, refreshVersion].join("|");
  const visibleAlertResult = alertResult?.key === alertQueryKey ? alertResult : null;

  const sourceQueryKey = [activeFactoryId, refreshVersion].join("|");
  const visibleSourceResult = sourceResult?.key === sourceQueryKey ? sourceResult : null;

  useEffect(() => {
    if (!canReadMeters || activeTab !== "meters") return;
    let cancelled = false;
    void client.listMeters({
      limit: 100,
      ...(utilityType ? { utilityType } : {}),
      ...(meterStatus ? { status: meterStatus } : {}),
    }).then((payload) => {
      if (!cancelled) setMeterResult({ key: meterQueryKey, items: itemsFrom(payload), error: "" });
    }).catch((error: unknown) => {
      if (!cancelled) setMeterResult({
        key: meterQueryKey,
        items: [],
        error: error instanceof Error ? error.message : "Could not load utility meters.",
      });
    });
    return () => { cancelled = true; };
  }, [activeTab, canReadMeters, client, meterQueryKey, meterStatus, utilityType]);

  useEffect(() => {
    if (!canReadReadings || activeTab !== "meters" || !effectiveMeterId) return;
    let cancelled = false;
    void client.listReadings({
      meterId: effectiveMeterId,
      limit: 50,
      ...(readingFrom ? { from: readingFrom } : {}),
      ...(readingTo ? { to: readingTo } : {}),
    }).then((payload) => {
      if (!cancelled) setReadingResult({ key: readingQueryKey, items: itemsFrom(payload), error: "" });
    }).catch((error: unknown) => {
      if (!cancelled) setReadingResult({
        key: readingQueryKey,
        items: [],
        error: error instanceof Error ? error.message : "Could not load meter readings.",
      });
    });
    return () => { cancelled = true; };
  }, [
    activeTab,
    canReadReadings,
    client,
    effectiveMeterId,
    readingFrom,
    readingQueryKey,
    readingTo,
  ]);

  useEffect(() => {
    if (!canReadEvents || activeTab !== "events") return;
    let cancelled = false;
    void client.listEvents({
      limit: 100,
      ...(eventStatus ? { status: eventStatus } : {}),
    }).then((payload) => {
      if (!cancelled) setEventResult({ key: eventQueryKey, items: itemsFrom(payload), error: "" });
    }).catch((error: unknown) => {
      if (!cancelled) setEventResult({
        key: eventQueryKey,
        items: [],
        error: error instanceof Error ? error.message : "Could not load utility events.",
      });
    });
    return () => { cancelled = true; };
  }, [activeTab, canReadEvents, client, eventQueryKey, eventStatus]);

  useEffect(() => {
    if (!canReadAlerts || activeTab !== "alerts") return;
    let cancelled = false;
    void Promise.all([
      client.listThresholdAlerts({
        limit: 100,
        ...(alertStatus ? { status: alertStatus } : {}),
      }),
      client.listThresholdPolicies({ limit: 100 }),
    ]).then(([alertsPayload, policiesPayload]) => {
      if (!cancelled) setAlertResult({
        key: alertQueryKey,
        alerts: itemsFrom(alertsPayload),
        policies: itemsFrom(policiesPayload),
        error: "",
      });
    }).catch((error: unknown) => {
      if (!cancelled) setAlertResult({
        key: alertQueryKey,
        alerts: [],
        policies: [],
        error: error instanceof Error ? error.message : "Could not load utility alert data.",
      });
    });
    return () => { cancelled = true; };
  }, [activeTab, alertQueryKey, alertStatus, canReadAlerts, client]);

  useEffect(() => {
    if (!canReadMeters || activeTab !== "sources") return;
    let cancelled = false;
    void client.listSourceBindings({ limit: 100 }).then((payload) => {
      if (!cancelled) setSourceResult({ key: sourceQueryKey, items: itemsFrom(payload), error: "" });
    }).catch((error: unknown) => {
      if (!cancelled) setSourceResult({
        key: sourceQueryKey,
        items: [],
        error: error instanceof Error ? error.message : "Could not load source mappings.",
      });
    });
    return () => { cancelled = true; };
  }, [activeTab, canReadMeters, client, sourceQueryKey]);

  const activeMeterCount = meterItems.filter((meter) =>
    valueText(meter.status, "").toUpperCase() === "ACTIVE").length;
  const criticalAlertCount = (visibleAlertResult?.alerts ?? []).filter((alert) =>
    valueText(alert.severity, "").toUpperCase() === "CRITICAL").length;
  const openEventCount = (visibleEventResult?.items ?? []).filter((event) =>
    ["OPEN", "ACKNOWLEDGED"].includes(valueText(event.status, "").toUpperCase())).length;

  const refresh = () => setRefreshVersion((current) => current + 1);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="FactoryOS · Utilities"
        title="Utilities & Energy Workbench"
        description="Review factory utility meters, consumption history, operational events, threshold alerts and approved source mappings."
        actions={
          <>
            <Badge tone={connected ? "success" : "neutral"}>
              {connected ? "Authenticated workspace" : "Session not connected"}
            </Badge>
            <Button variant="outline" onClick={refresh} disabled={!connected}>
              Refresh
            </Button>
          </>
        }
      />

      {!connected ? (
        <Alert tone="warning" title="Connect a FactoryOS workspace">
          This workbench uses the shared authenticated session. Connect on the workspace session page and select an active factory before opening utility data.
        </Alert>
      ) : null}

      {connected && tabs.every((tab) => !tab.enabled) ? (
        <EmptyState
          title="Utilities access is not assigned"
          description="The current IAM permission snapshot does not grant utility meter, reading, event or alert access. Ask a workspace administrator to assign the required factory-scoped permission."
        />
      ) : null}

      {connected && tabs.some((tab) => tab.enabled) ? (
        <>
          <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Meters returned</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{canReadMeters && visibleMeterResult ? meterItems.length : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Bounded list · maximum 100 rows</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active meters in result</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{canReadMeters && visibleMeterResult ? activeMeterCount : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Current filter result only</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open utility events</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{canReadEvents && visibleEventResult ? openEventCount : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Open and acknowledged in latest result</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Critical threshold alerts</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{canReadAlerts && visibleAlertResult ? criticalAlertCount : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Current status filter result only</p>
              </CardContent>
            </Card>
          </section>

          <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-3" role="tablist" aria-label="Utilities workbench views">
            {tabs.filter((tab) => tab.enabled).map((tab) => (
              <Button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                variant={activeTab === tab.id ? "primary" : "ghost"}
                size="sm"
                onClick={() => setRequestedTab(tab.id)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          {activeTab === "meters" ? (
            <div className="space-y-5">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>Utility meter register</CardTitle>
                      <CardDescription>Factory-scoped meters and their configured measurement units. Select a meter to view its bounded reading history.</CardDescription>
                    </div>
                    <Badge tone="info">GET only</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium">
                      Utility type
                      <Select value={utilityType} onChange={(event) => setUtilityType(event.target.value)}>
                        {UTILITY_TYPE_OPTIONS.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                      </Select>
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Meter status
                      <Select value={meterStatus} onChange={(event) => setMeterStatus(event.target.value)}>
                        {METER_STATUS_OPTIONS.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                      </Select>
                    </label>
                  </div>
                  {visibleMeterResult?.error ? <Alert tone="danger" title="Meter list unavailable">{visibleMeterResult.error}</Alert> : null}
                  {!visibleMeterResult ? <p className="py-8 text-center text-sm text-slate-500">Loading utility meters…</p> : null}
                  {visibleMeterResult && !visibleMeterResult.error && meterItems.length === 0 ? (
                    <EmptyState title="No utility meters found" description="No meters match the current factory and filters." />
                  ) : null}
                  {visibleMeterResult && meterItems.length > 0 ? (
                    <TableShell>
                      <TableHead>
                        <tr>
                          <th className="px-3 py-3">Meter</th>
                          <th className="px-3 py-3">Utility</th>
                          <th className="px-3 py-3">Mode / unit</th>
                          <th className="px-3 py-3">Location</th>
                          <th className="px-3 py-3">Children</th>
                          <th className="px-3 py-3">Status</th>
                          <th className="px-3 py-3">Action</th>
                        </tr>
                      </TableHead>
                      <tbody className="divide-y divide-slate-100">
                        {meterItems.map((meter, index) => {
                          const id = valueText(meter.id, "");
                          const selected = effectiveMeterId.toLowerCase() === id.toLowerCase();
                          return (
                            <tr key={id || index} className={selected ? "bg-blue-50/70" : "bg-white"}>
                              <td className="px-3 py-3">
                                <p className="font-semibold text-slate-900">{valueText(meter.meter_code)}</p>
                                <p className="mt-0.5 text-xs text-slate-500">{valueText(meter.name)}</p>
                              </td>
                              <td className="px-3 py-3">{valueText(meter.utility_type).replaceAll("_", " ")}</td>
                              <td className="px-3 py-3">
                                <p>{valueText(meter.reading_mode)}</p>
                                <p className="text-xs text-slate-500">{valueText(meter.unit_code)}</p>
                              </td>
                              <td className="px-3 py-3">{valueText(meter.location, "Not assigned")}</td>
                              <td className="px-3 py-3 tabular-nums">{formatNumber(meter.child_count, 0)}</td>
                              <td className="px-3 py-3"><StatusBadge status={valueText(meter.status, "UNKNOWN")} /></td>
                              <td className="px-3 py-3">
                                <Button
                                  size="sm"
                                  variant={selected ? "secondary" : "outline"}
                                  onClick={() => setSelectedMeterId(id)}
                                  disabled={!id}
                                >
                                  {selected ? "Selected" : "View readings"}
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </TableShell>
                  ) : null}
                  <p className="mt-3 text-xs text-slate-500">The API returns at most 100 meters here; counts are not a factory-wide total.</p>
                </CardContent>
              </Card>

              {selectedMeter ? (
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle>Reading history · {valueText(selectedMeter.meter_code)}</CardTitle>
                        <CardDescription>{valueText(selectedMeter.name)} · {valueText(selectedMeter.utility_type).replaceAll("_", " ")} · {valueText(selectedMeter.unit_code)}</CardDescription>
                      </div>
                      <StatusBadge status={valueText(selectedMeter.status, "UNKNOWN")} />
                    </div>
                  </CardHeader>
                  <CardContent>
                    {!canReadReadings ? (
                      <Alert tone="warning" title="Reading permission required">
                        You can view the meter register, but the current permission snapshot does not include utilities.readings.read.
                      </Alert>
                    ) : (
                      <>
                        <div className="mb-4 grid gap-3 sm:grid-cols-2">
                          <label className="grid gap-1.5 text-sm font-medium">
                            From date
                            <Input type="date" value={readingFrom} max={readingTo || undefined} onChange={(event) => setReadingFrom(event.target.value)} />
                          </label>
                          <label className="grid gap-1.5 text-sm font-medium">
                            To date
                            <Input type="date" value={readingTo} min={readingFrom || undefined} onChange={(event) => setReadingTo(event.target.value)} />
                          </label>
                        </div>
                        {visibleReadingResult?.error ? <Alert tone="danger" title="Reading history unavailable">{visibleReadingResult.error}</Alert> : null}
                        {!visibleReadingResult ? <p className="py-6 text-center text-sm text-slate-500">Loading meter readings…</p> : null}
                        {visibleReadingResult && !visibleReadingResult.error && visibleReadingResult.items.length === 0 ? (
                          <EmptyState title="No readings in this range" description="The selected meter has no readings matching the selected date window." />
                        ) : null}
                        {visibleReadingResult && visibleReadingResult.items.length > 0 ? (
                          <TableShell>
                            <TableHead>
                              <tr>
                                <th className="px-3 py-3">Reading time</th>
                                <th className="px-3 py-3">Value</th>
                                <th className="px-3 py-3">Previous</th>
                                <th className="px-3 py-3">Consumption</th>
                                <th className="px-3 py-3">Cost</th>
                                <th className="px-3 py-3">Source</th>
                              </tr>
                            </TableHead>
                            <tbody className="divide-y divide-slate-100">
                              {visibleReadingResult.items.map((reading, index) => (
                                <tr key={valueText(reading.id, String(index))}>
                                  <td className="whitespace-nowrap px-3 py-3">{formatDateTime(reading.reading_at)}</td>
                                  <td className="px-3 py-3 tabular-nums">{formatNumber(reading.reading_value)} {valueText(reading.unit_code)}</td>
                                  <td className="px-3 py-3 tabular-nums">{formatNumber(reading.previous_reading_value)}</td>
                                  <td className="px-3 py-3 tabular-nums font-semibold">{formatNumber(reading.consumption_quantity)} {valueText(reading.unit_code)}</td>
                                  <td className="px-3 py-3 tabular-nums">{formatMoney(reading.cost_amount, reading.currency_code_snapshot)}</td>
                                  <td className="px-3 py-3"><Badge tone="outline">{valueText(reading.source_type)}</Badge></td>
                                </tr>
                              ))}
                            </tbody>
                          </TableShell>
                        ) : null}
                        <p className="mt-3 text-xs text-slate-500">The API result is limited to 50 readings. No new consumption or cost calculations are performed in the browser.</p>
                      </>
                    )}
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : null}

          {activeTab === "events" ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Utility event log</CardTitle>
                    <CardDescription>Outages, peak loads, leaks, pressure drops, meter faults and efficiency exceptions reported to this factory.</CardDescription>
                  </div>
                  <Badge tone="info">GET only</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 max-w-sm">
                  <label className="grid gap-1.5 text-sm font-medium">
                    Event status
                    <Select value={eventStatus} onChange={(event) => setEventStatus(event.target.value)}>
                      {EVENT_STATUS_OPTIONS.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                    </Select>
                  </label>
                </div>
                {visibleEventResult?.error ? <Alert tone="danger" title="Event log unavailable">{visibleEventResult.error}</Alert> : null}
                {!visibleEventResult ? <p className="py-8 text-center text-sm text-slate-500">Loading utility events…</p> : null}
                {visibleEventResult && !visibleEventResult.error && visibleEventResult.items.length === 0 ? (
                  <EmptyState title="No utility events found" description="No events match the selected factory and status filter." />
                ) : null}
                {visibleEventResult && visibleEventResult.items.length > 0 ? (
                  <div className="space-y-3">
                    {visibleEventResult.items.map((event, index) => (
                      <article key={valueText(event.event_number, String(index))} className="rounded-xl border border-slate-200 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-slate-950">{valueText(event.title)}</p>
                              <Badge tone={severityTone(event.severity)}>{valueText(event.severity, "UNKNOWN")}</Badge>
                              <StatusBadge status={valueText(event.status, "UNKNOWN")} />
                            </div>
                            <p className="mt-1 text-xs text-slate-500">{valueText(event.event_number)} · {valueText(event.event_type).replaceAll("_", " ")} · {formatDateTime(event.occurred_at)}</p>
                          </div>
                          <div className="text-right text-xs text-slate-500">
                            <p>{formatNumber(event.impact_minutes, 0)} impact minutes</p>
                            {event.impact_quantity !== null && event.impact_quantity !== undefined ? <p>{formatNumber(event.impact_quantity)} impact quantity</p> : null}
                          </div>
                        </div>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{valueText(event.description)}</p>
                        {typeof event.cause === "string" && event.cause.trim() ? <p className="mt-2 text-xs text-slate-500">Cause: {event.cause}</p> : null}
                      </article>
                    ))}
                  </div>
                ) : null}
                <p className="mt-4 text-xs text-slate-500">Maximum 100 events are requested. This view does not acknowledge, resolve or cancel events.</p>
              </CardContent>
            </Card>
          ) : null}

          {activeTab === "alerts" ? (
            <div className="space-y-5">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>Threshold alert queue</CardTitle>
                      <CardDescription>Review observed values against their approved threshold policies and linked utility events.</CardDescription>
                    </div>
                    <Badge tone="info">GET only</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 max-w-sm">
                    <label className="grid gap-1.5 text-sm font-medium">
                      Alert status
                      <Select value={alertStatus} onChange={(event) => setAlertStatus(event.target.value)}>
                        {EVENT_STATUS_OPTIONS.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                      </Select>
                    </label>
                  </div>
                  {visibleAlertResult?.error ? <Alert tone="danger" title="Threshold alert data unavailable">{visibleAlertResult.error}</Alert> : null}
                  {!visibleAlertResult ? <p className="py-8 text-center text-sm text-slate-500">Loading threshold alerts and policies…</p> : null}
                  {visibleAlertResult && !visibleAlertResult.error && visibleAlertResult.alerts.length === 0 ? (
                    <EmptyState title="No threshold alerts found" description="No linked alerts match the selected status and active factory." />
                  ) : null}
                  {visibleAlertResult && visibleAlertResult.alerts.length > 0 ? (
                    <div className="space-y-3">
                      {visibleAlertResult.alerts.map((alert, index) => (
                        <article key={valueText(alert.alert_id, String(index))} className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-950">{valueText(alert.title, valueText(alert.policy_name))}</p>
                              <p className="mt-1 text-xs text-slate-500">{valueText(alert.policy_code)} · {valueText(alert.metric).replaceAll("_", " ")} · {formatDateTime(alert.occurred_at)}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge tone={severityTone(alert.severity)}>{valueText(alert.severity, "UNKNOWN")}</Badge>
                              <StatusBadge status={valueText(alert.status, "UNKNOWN")} />
                            </div>
                          </div>
                          <div className="mt-3 grid gap-3 sm:grid-cols-3">
                            <div className="rounded-lg bg-slate-50 p-3">
                              <p className="text-xs text-slate-500">Observed</p>
                              <p className="mt-1 font-semibold tabular-nums">{formatNumber(alert.observed_value)} {valueText(alert.unit_code)}</p>
                            </div>
                            <div className="rounded-lg bg-slate-50 p-3">
                              <p className="text-xs text-slate-500">Threshold</p>
                              <p className="mt-1 font-semibold tabular-nums">{formatNumber(alert.threshold_value)} {valueText(alert.unit_code)}</p>
                            </div>
                            <div className="rounded-lg bg-slate-50 p-3">
                              <p className="text-xs text-slate-500">Consumption at reading</p>
                              <p className="mt-1 font-semibold tabular-nums">{formatNumber(alert.consumption_quantity)} {valueText(alert.unit_code)}</p>
                            </div>
                          </div>
                          <p className="mt-3 text-sm text-slate-600">Reading recorded {formatDateTime(alert.reading_at)}. Threshold details are shown as stored by the API; the browser does not evaluate or re-trigger alerts.</p>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Threshold policy register</CardTitle>
                  <CardDescription>Current factory policy configuration, shown without approval identities or internal audit fields.</CardDescription>
                </CardHeader>
                <CardContent>
                  {visibleAlertResult && visibleAlertResult.policies.length === 0 ? (
                    <EmptyState title="No threshold policies found" description="No utility threshold policies are registered for this factory." />
                  ) : null}
                  {visibleAlertResult && visibleAlertResult.policies.length > 0 ? (
                    <TableShell>
                      <TableHead>
                        <tr>
                          <th className="px-3 py-3">Policy</th>
                          <th className="px-3 py-3">Metric</th>
                          <th className="px-3 py-3">Threshold</th>
                          <th className="px-3 py-3">Severity</th>
                          <th className="px-3 py-3">Status</th>
                        </tr>
                      </TableHead>
                      <tbody className="divide-y divide-slate-100">
                        {visibleAlertResult.policies.map((policy, index) => (
                          <tr key={valueText(policy.policy_code, String(index))}>
                            <td className="px-3 py-3">
                              <p className="font-semibold">{valueText(policy.name)}</p>
                              <p className="text-xs text-slate-500">{valueText(policy.policy_code)} · {valueText(policy.utility_type, "All utility types").replaceAll("_", " ")}</p>
                            </td>
                            <td className="px-3 py-3">{valueText(policy.metric).replaceAll("_", " ")} {valueText(policy.comparison)}</td>
                            <td className="px-3 py-3 tabular-nums">{formatNumber(policy.threshold_value)} {valueText(policy.threshold_unit_code)}</td>
                            <td className="px-3 py-3"><Badge tone={severityTone(policy.severity)}>{valueText(policy.severity)}</Badge></td>
                            <td className="px-3 py-3"><StatusBadge status={valueText(policy.status, "UNKNOWN")} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </TableShell>
                  ) : null}
                  <p className="mt-3 text-xs text-slate-500">Both alert and policy lists are limited to 100 rows. This view has no acknowledge, resolve or policy-management actions.</p>
                </CardContent>
              </Card>
            </div>
          ) : null}

          {activeTab === "sources" ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Approved meter source mappings</CardTitle>
                    <CardDescription>Review external meter identifiers and approved unit conversions without exposing credential references or raw connector configuration.</CardDescription>
                  </div>
                  <Badge tone="info">GET only</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {visibleSourceResult?.error ? <Alert tone="danger" title="Source mapping list unavailable">{visibleSourceResult.error}</Alert> : null}
                {!visibleSourceResult ? <p className="py-8 text-center text-sm text-slate-500">Loading source mappings…</p> : null}
                {visibleSourceResult && !visibleSourceResult.error && visibleSourceResult.items.length === 0 ? (
                  <EmptyState title="No meter source mappings found" description="No source-to-meter bindings are registered for this factory." />
                ) : null}
                {visibleSourceResult && visibleSourceResult.items.length > 0 ? (
                  <TableShell>
                    <TableHead>
                      <tr>
                        <th className="px-3 py-3">External source</th>
                        <th className="px-3 py-3">Mapped meter</th>
                        <th className="px-3 py-3">Unit conversion</th>
                        <th className="px-3 py-3">Polling</th>
                        <th className="px-3 py-3">Credential</th>
                        <th className="px-3 py-3">Status</th>
                      </tr>
                    </TableHead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleSourceResult.items.map((binding, index) => (
                        <tr key={valueText(binding.source_system_code) + ":" + valueText(binding.source_meter_code) + ":" + index}>
                          <td className="px-3 py-3">
                            <p className="font-semibold">{valueText(binding.source_system_code)}</p>
                            <p className="text-xs text-slate-500">{valueText(binding.source_meter_code)} · {valueText(binding.vendor_adapter)}</p>
                          </td>
                          <td className="px-3 py-3">
                            <p className="font-semibold">{valueText(binding.meter_code)}</p>
                            <p className="text-xs text-slate-500">{valueText(binding.meter_unit_code)}</p>
                          </td>
                          <td className="px-3 py-3 tabular-nums">
                            <p>{formatNumber(binding.factor_to_meter_unit, 8)} ×</p>
                            <p className="text-xs text-slate-500">{valueText(binding.source_unit_code)} → {valueText(binding.meter_unit_code)}</p>
                          </td>
                          <td className="px-3 py-3">{binding.polling_interval_seconds === null || binding.polling_interval_seconds === undefined ? "Not set" : formatNumber(binding.polling_interval_seconds, 0) + " sec"}</td>
                          <td className="px-3 py-3">
                            <Badge tone={binding.credential_configured === true ? "success" : "neutral"}>
                              {binding.credential_configured === true ? "Configured" : "Not configured"}
                            </Badge>
                          </td>
                          <td className="px-3 py-3"><StatusBadge status={valueText(binding.status, "UNKNOWN")} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                ) : null}
                <p className="mt-3 text-xs text-slate-500">Maximum 100 mappings are requested. Credential references, secret values, raw config metadata and approval-user identifiers are never rendered.</p>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}

      <footer className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        Read-only operational visibility. All API requests use the shared IAM-verified session and selected active factory. Backend authorization remains authoritative; this page does not create meters, capture readings, change utility events, transition alerts or edit threshold policies.
      </footer>
    </main>
  );
}

export default UtilitiesWorkbenchPage;
