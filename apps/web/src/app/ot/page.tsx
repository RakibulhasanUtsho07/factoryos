"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

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
  Select,
  StatusBadge,
} from "@/components/ui";
import { createOtConnectivityClient } from "@/lib/ot-connectivity-workbench.mjs";
import type { OtDeviceStatus, OtProtocol } from "@/lib/ot-connectivity-workbench.mjs";

type JsonRecord = Record<string, unknown>;
type DeviceResult = { key: string; items: JsonRecord[]; error: string };
type RecordResult = { key: string; item: JsonRecord | null; error: string };
type ItemsResult = { key: string; items: JsonRecord[]; error: string };

const DEVICE_STATUS_OPTIONS = [
  ["", "All device statuses"],
  ["PENDING_REVIEW", "Pending review"],
  ["ACTIVE", "Active"],
  ["PAUSED", "Paused"],
  ["REVOKED", "Revoked"],
] as const;

const PROTOCOL_OPTIONS = [
  ["", "All protocols"],
  ["OPC_UA", "OPC UA"],
  ["MQTT", "MQTT"],
  ["MODBUS_TCP", "Modbus TCP"],
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

function statusTone(value: unknown): "success" | "warning" | "danger" | "info" | "neutral" {
  const status = valueText(value, "").toUpperCase();
  if (status === "ON_TIME" || status === "ACTIVE") return "success";
  if (status === "PENDING_REVIEW" || status === "PAUSED" || status === "LATE") return "warning";
  if (status === "REVOKED" || status === "SEQUENCE_GAP") return "danger";
  return "neutral";
}

function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        {children}
      </table>
    </div>
  );
}

function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
      {children}
    </thead>
  );
}

export default function OtConnectivityWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const connected = sessionStatus === "connected" && snapshot !== null && Boolean(activeFactoryId);
  const canReadDevices = connected && hasPermission("ot.devices.read");
  const canReadTelemetry = connected && hasPermission("ot.telemetry.read");
  const permissionSnapshotKey = snapshot?.permissions
    .map((permission) => permission.code)
    .sort()
    .join(",") ?? "";

  const [deviceStatus, setDeviceStatus] = useState<OtDeviceStatus | "">("");
  const [protocol, setProtocol] = useState<OtProtocol | "">("");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [deviceResult, setDeviceResult] = useState<DeviceResult | null>(null);
  const [detailResult, setDetailResult] = useState<RecordResult | null>(null);
  const [historyResult, setHistoryResult] = useState<ItemsResult | null>(null);
  const [telemetryResult, setTelemetryResult] = useState<ItemsResult | null>(null);

  const client = useMemo(
    () => createOtConnectivityClient({ request }),
    [request],
  );

  const deviceQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    deviceStatus,
    protocol,
    refreshVersion,
  ].join("|");
  const visibleDeviceResult = deviceResult?.key === deviceQueryKey ? deviceResult : null;
  const devices = visibleDeviceResult?.items ?? [];
  const selectedDevice = devices.find((device) =>
    valueText(device.id, "").toLowerCase() === selectedDeviceId.toLowerCase())
    ?? devices[0]
    ?? null;
  const effectiveDeviceId = selectedDevice ? valueText(selectedDevice.id, "") : "";

  const detailQueryKey = [
    activeFactoryId,
    permissionSnapshotKey,
    effectiveDeviceId,
    refreshVersion,
  ].join("|");
  const visibleDetailResult = detailResult?.key === detailQueryKey ? detailResult : null;
  const visibleHistoryResult = historyResult?.key === detailQueryKey ? historyResult : null;
  const visibleTelemetryResult = telemetryResult?.key === detailQueryKey ? telemetryResult : null;

  useEffect(() => {
    if (!canReadDevices) return;
    let cancelled = false;
    void client.listDevices({
      ...(deviceStatus ? { status: deviceStatus } : {}),
      ...(protocol ? { protocol } : {}),
    }).then((payload) => {
      if (!cancelled) setDeviceResult({
        key: deviceQueryKey,
        items: itemsFrom(payload),
        error: "",
      });
    }).catch((error: unknown) => {
      if (!cancelled) setDeviceResult({
        key: deviceQueryKey,
        items: [],
        error: error instanceof Error ? error.message : "Could not load OT devices.",
      });
    });
    return () => { cancelled = true; };
  }, [canReadDevices, client, deviceQueryKey, deviceStatus, protocol]);

  useEffect(() => {
    if (!canReadDevices || !effectiveDeviceId) return;
    let cancelled = false;
    void Promise.all([
      client.getDevice({ deviceId: effectiveDeviceId }),
      client.listHistory({ deviceId: effectiveDeviceId }),
    ]).then(([detailPayload, historyPayload]) => {
      if (cancelled) return;
      setDetailResult({
        key: detailQueryKey,
        item: asRecord(detailPayload),
        error: "",
      });
      setHistoryResult({
        key: detailQueryKey,
        items: itemsFrom(historyPayload),
        error: "",
      });
    }).catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : "Could not load OT device detail.";
      setDetailResult({ key: detailQueryKey, item: null, error: message });
      setHistoryResult({ key: detailQueryKey, items: [], error: message });
    });
    return () => { cancelled = true; };
  }, [canReadDevices, client, detailQueryKey, effectiveDeviceId]);

  useEffect(() => {
    if (!canReadTelemetry || !effectiveDeviceId) return;
    let cancelled = false;
    void client.listTelemetry({ deviceId: effectiveDeviceId, limit: 100 })
      .then((payload) => {
        if (!cancelled) setTelemetryResult({
          key: detailQueryKey,
          items: itemsFrom(payload),
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setTelemetryResult({
          key: detailQueryKey,
          items: [],
          error: error instanceof Error ? error.message : "Could not load OT telemetry.",
        });
      });
    return () => { cancelled = true; };
  }, [canReadTelemetry, client, detailQueryKey, effectiveDeviceId]);

  const activeCount = devices.filter((device) =>
    valueText(device.status, "").toUpperCase() === "ACTIVE").length;
  const pendingCount = devices.filter((device) =>
    valueText(device.status, "").toUpperCase() === "PENDING_REVIEW").length;
  const telemetryItems = visibleTelemetryResult?.items ?? [];
  const lateCount = telemetryItems.filter((event) =>
    valueText(event.delivery_status, "").toUpperCase() === "LATE").length;
  const sequenceGapCount = telemetryItems.filter((event) =>
    valueText(event.delivery_status, "").toUpperCase() === "SEQUENCE_GAP").length;
  const selectedDetail = visibleDetailResult?.item ?? selectedDevice;

  const refresh = () => setRefreshVersion((current) => current + 1);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">FactoryOS · OT / Connectivity</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">OT Connectivity Workbench</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Review factory OT devices, protocol assignments, lifecycle history and telemetry delivery quality without sending commands to plant equipment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connected ? "success" : "neutral"}>
            {connected ? "Authenticated workspace" : "Session not connected"}
          </Badge>
          <Button variant="outline" onClick={refresh} disabled={!connected}>Refresh</Button>
        </div>
      </header>

      {!connected ? (
        <Alert tone="warning" title="Connect a FactoryOS workspace">
          Use the shared workspace session page to connect and select an active factory before opening OT device data.
        </Alert>
      ) : null}

      {connected && !canReadDevices ? (
        <EmptyState
          title="OT device read access is not assigned"
          description="The current IAM permission snapshot does not grant ot.devices.read. Ask a workspace administrator to assign the factory-scoped permission."
        />
      ) : null}

      {canReadDevices ? (
        <>
          <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Devices returned</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{visibleDeviceResult ? devices.length : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">API result · maximum 200</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active devices in result</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{visibleDeviceResult ? activeCount : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Current filter result only</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pending review</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{visibleDeviceResult ? pendingCount : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Devices awaiting review</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Telemetry exceptions</p>
                <p className="mt-2 text-2xl font-bold tabular-nums">{canReadTelemetry && visibleTelemetryResult ? lateCount + sequenceGapCount : "—"}</p>
                <p className="mt-1 text-xs text-slate-500">Late + sequence gaps in selected device's result</p>
              </CardContent>
            </Card>
          </section>

          <Card className="mb-5">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>OT device register</CardTitle>
                  <CardDescription>OPC UA, MQTT and Modbus TCP devices registered to the selected factory. Select a device to inspect its detail and telemetry record.</CardDescription>
                </div>
                <Badge tone="info">GET only</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Device status
                  <Select value={deviceStatus} onChange={(event) => setDeviceStatus(event.target.value as OtDeviceStatus | "")}>
                    {DEVICE_STATUS_OPTIONS.map(([value, label]) => (
                      <option key={value || "all"} value={value}>{label}</option>
                    ))}
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Protocol
                  <Select value={protocol} onChange={(event) => setProtocol(event.target.value as OtProtocol | "")}>
                    {PROTOCOL_OPTIONS.map(([value, label]) => (
                      <option key={value || "all"} value={value}>{label}</option>
                    ))}
                  </Select>
                </label>
              </div>

              {visibleDeviceResult?.error ? <Alert tone="danger" title="OT device register unavailable">{visibleDeviceResult.error}</Alert> : null}
              {!visibleDeviceResult ? <p className="py-8 text-center text-sm text-slate-500">Loading OT devices…</p> : null}
              {visibleDeviceResult && !visibleDeviceResult.error && devices.length === 0 ? (
                <EmptyState
                  title="No OT devices found"
                  description="No devices match the selected factory and filters. Device registration and protocol commissioning are intentionally outside this read-only workspace."
                />
              ) : null}

              {visibleDeviceResult && devices.length > 0 ? (
                <TableShell>
                  <TableHead>
                    <tr>
                      <th className="px-3 py-3">Device</th>
                      <th className="px-3 py-3">Device key</th>
                      <th className="px-3 py-3">Protocol</th>
                      <th className="px-3 py-3">Registered</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Selection</th>
                    </tr>
                  </TableHead>
                  <tbody className="divide-y divide-slate-100">
                    {devices.map((device, index) => {
                      const id = valueText(device.id, "");
                      const selected = effectiveDeviceId.toLowerCase() === id.toLowerCase();
                      return (
                        <tr key={id || index} className={selected ? "bg-blue-50/70" : "bg-white"}>
                          <td className="px-3 py-3 font-semibold">{valueText(device.display_name)}</td>
                          <td className="px-3 py-3 font-mono text-xs">{valueText(device.device_key)}</td>
                          <td className="px-3 py-3"><Badge tone="outline">{valueText(device.protocol).replaceAll("_", " ")}</Badge></td>
                          <td className="whitespace-nowrap px-3 py-3">{formatDateTime(device.created_at)}</td>
                          <td className="px-3 py-3"><StatusBadge status={valueText(device.status, "UNKNOWN")} /></td>
                          <td className="px-3 py-3">
                            <Button
                              size="sm"
                              variant={selected ? "secondary" : "outline"}
                              onClick={() => setSelectedDeviceId(id)}
                              disabled={!id}
                            >
                              {selected ? "Selected" : "Inspect"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableShell>
              ) : null}
              <p className="mt-3 text-xs text-slate-500">Backend returns at most 200 devices. The displayed count is not a factory-wide total. Connection references and raw protocol metadata are deliberately hidden.</p>
            </CardContent>
          </Card>

          {selectedDevice ? (
            <div className="space-y-5">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>{valueText(selectedDetail?.display_name, valueText(selectedDevice.display_name))}</CardTitle>
                      <CardDescription>
                        {valueText(selectedDetail?.device_key, valueText(selectedDevice.device_key))}
                        {" · "}
                        {valueText(selectedDetail?.protocol, valueText(selectedDevice.protocol)).replaceAll("_", " ")}
                      </CardDescription>
                    </div>
                    <StatusBadge status={valueText(selectedDetail?.status, valueText(selectedDevice.status, "UNKNOWN"))} />
                  </div>
                </CardHeader>
                <CardContent>
                  {visibleDetailResult?.error ? <Alert tone="danger" title="Device detail unavailable">{visibleDetailResult.error}</Alert> : null}
                  {!visibleDetailResult ? <p className="text-sm text-slate-500">Loading selected device detail…</p> : null}
                  {visibleDetailResult?.item ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Record version</p>
                        <p className="mt-1 font-semibold tabular-nums">{valueText(visibleDetailResult.item.row_version)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Last updated</p>
                        <p className="mt-1 text-sm font-semibold">{formatDateTime(visibleDetailResult.item.updated_at)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Reviewed at</p>
                        <p className="mt-1 text-sm font-semibold">{formatDateTime(visibleDetailResult.item.reviewed_at)}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">Paused / revoked</p>
                        <p className="mt-1 text-sm font-semibold">
                          {visibleDetailResult.item.revoked_at
                            ? formatDateTime(visibleDetailResult.item.revoked_at)
                            : visibleDetailResult.item.paused_at
                              ? formatDateTime(visibleDetailResult.item.paused_at)
                              : "Not recorded"}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <p className="mt-4 text-xs text-slate-500">This panel does not activate, pause or revoke the device. Lifecycle changes require separate governed workflows and approval.</p>
                </CardContent>
              </Card>

              <div className="grid items-start gap-5 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle>Lifecycle history</CardTitle>
                        <CardDescription>Latest recorded device lifecycle actions and their stated reasons.</CardDescription>
                      </div>
                      <Badge tone="info">Read only</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {!visibleHistoryResult ? <p className="py-5 text-sm text-slate-500">Loading history…</p> : null}
                    {visibleHistoryResult?.error ? <Alert tone="danger">{visibleHistoryResult.error}</Alert> : null}
                    {visibleHistoryResult && !visibleHistoryResult.error && visibleHistoryResult.items.length === 0 ? (
                      <EmptyState title="No lifecycle history" description="No history entries are available for this device." />
                    ) : null}
                    {visibleHistoryResult && visibleHistoryResult.items.length > 0 ? (
                      <ol className="space-y-3">
                        {visibleHistoryResult.items.map((entry, index) => (
                          <li key={valueText(entry.id, String(index))} className="border-l-2 border-slate-200 pl-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-semibold text-slate-900">{valueText(entry.action).replaceAll("_", " ")}</p>
                              <Badge tone="outline">v{valueText(entry.row_version)}</Badge>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">{formatDateTime(entry.occurred_at)}</p>
                            {typeof entry.reason === "string" && entry.reason.trim() ? (
                              <p className="mt-2 text-sm leading-6 text-slate-700">{entry.reason}</p>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    <p className="mt-3 text-xs text-slate-500">Actor IDs and internal history metadata are not displayed. Maximum 200 entries.</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle>Telemetry delivery</CardTitle>
                        <CardDescription>Accepted stream metadata and backend sequence classification.</CardDescription>
                      </div>
                      <Badge tone="info">GET only</Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {!canReadTelemetry ? (
                      <Alert tone="warning" title="Telemetry permission required">
                        The current IAM permission snapshot does not include ot.telemetry.read. Device detail and lifecycle history remain available.
                      </Alert>
                    ) : null}
                    {canReadTelemetry && !visibleTelemetryResult ? <p className="py-5 text-sm text-slate-500">Loading telemetry…</p> : null}
                    {visibleTelemetryResult?.error ? <Alert tone="danger" title="Telemetry unavailable">{visibleTelemetryResult.error}</Alert> : null}
                    {canReadTelemetry && visibleTelemetryResult && !visibleTelemetryResult.error && visibleTelemetryResult.items.length === 0 ? (
                      <EmptyState title="No telemetry received" description="No telemetry events are recorded for this device yet." />
                    ) : null}
                    {canReadTelemetry && visibleTelemetryResult && visibleTelemetryResult.items.length > 0 ? (
                      <div className="space-y-3">
                        {visibleTelemetryResult.items.map((event, index) => (
                          <article key={valueText(event.id, String(index))} className="rounded-xl border border-slate-200 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="font-semibold">{valueText(event.event_type)}</p>
                                <p className="mt-1 text-xs text-slate-500">{valueText(event.stream_key)}</p>
                              </div>
                              <Badge tone={statusTone(event.delivery_status)}>
                                {valueText(event.delivery_status, "UNKNOWN").replaceAll("_", " ")}
                              </Badge>
                            </div>
                            <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                              <p>Observed: {formatDateTime(event.observed_at)}</p>
                              <p>Received: {formatDateTime(event.received_at)}</p>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-3 text-xs text-slate-500">Late and sequence-gap classification is shown as stored by the API. Raw payloads, source event IDs and payload hashes are intentionally omitted. Maximum 100 events.</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <footer className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        Operational visibility only. All reads use the shared IAM-verified session and selected active factory. This page sends no OPC UA, MQTT or Modbus commands, ingests no telemetry, changes no device lifecycle state and does not certify physical OT commissioning or hardware connectivity.
      </footer>
    </main>
  );
}
