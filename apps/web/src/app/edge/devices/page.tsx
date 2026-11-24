"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildEdgeCredentialPayload,
  buildEdgeDevicePayload,
  buildEdgePackageControlPayload,
  buildEdgeSigningKeyPayload,
  buildEdgeSigningKeyRevocationPayload,
  filterEdgeDevices,
  normalizeEdgeRows,
  summarizeEdgeDevices,
} from "@/lib/edge-device-workbench.mjs";
import type { EdgeDevice } from "@/lib/edge-device-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "DEVICES" | "TELEMETRY" | "PACKAGES";
type DeviceStatus = "ACTIVE" | "PAUSED" | "REVOKED";

type DeviceDraft = {
  device_key: string;
  display_name: string;
  protocol: string;
  device_group: string;
  capability_profile: string;
};

type CredentialReceipt = {
  id: string;
  deviceId: string;
  deviceName: string;
  token: string;
  tokenHint: string;
  expiresAt: string;
  previousCredentialCount: number;
};

type EdgeControl = {
  id: string;
  packageId: string;
  packageVersion: string;
  targetKind: string;
  targetKey: string;
  status: string;
  reason: string;
  createdAt?: string;
  updatedAt?: string;
};

const TABS: { id: Tab; label: string }[] = [
  { id: "DEVICES", label: "Device fleet" },
  { id: "TELEMETRY", label: "Health & telemetry" },
  { id: "PACKAGES", label: "Package governance" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-28";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";
const PANEL = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
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

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function deviceRows(value: unknown) {
  return normalizeEdgeRows(value, "devices") as EdgeDevice[];
}

function healthRows(value: unknown) {
  return normalizeEdgeRows(value, "reports") as Row[];
}

function observationRows(value: unknown) {
  return normalizeEdgeRows(value, "observations") as Row[];
}

function signingKeyRows(value: unknown) {
  return normalizeEdgeRows(value, "signingKeys") as Row[];
}

function controlRows(value: unknown) {
  return normalizeEdgeRows(value, "controls") as EdgeControl[];
}

function Metric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <article className={PANEL}>
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className="mt-1 text-[10px] text-slate-500">{detail}</p>
    </article>
  );
}

function StatusPill({ value }: { value: unknown }) {
  const status = textValue(value, "UNKNOWN").toUpperCase();
  const tone = ["ACTIVE", "HEALTHY"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["PAUSED", "DEGRADED", "NEEDS_ATTENTION", "UNCERTAIN"].includes(status)
      ? "bg-amber-50 text-amber-900"
      : ["REVOKED", "BAD", "CRITICAL"].includes(status)
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

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{children}</div>;
}

function initialDevice(): DeviceDraft {
  return {
    device_key: "",
    display_name: "",
    protocol: "OPC_UA",
    device_group: "",
    capability_profile: JSON.stringify({ signals: [], supportsBufferedSync: true }, null, 2),
  };
}

function initialKeyDraft() {
  return { key_id: "", public_key_pem: "", replaces_key_id: "" };
}

function initialControlDraft() {
  return {
    package_id: "",
    package_version: "*",
    target_kind: "FACTORY",
    target_key: "*",
    action: "PAUSE",
    reason: "",
  };
}

export default function EdgeDeviceFleetWorkbenchPage() {
  const {
    status: sessionStatus,
    activeFactoryId,
    hasPermission,
    request,
  } = useFactoryOsSession();

  const canReadDevices = hasPermission("edge.devices.read");
  const canRegisterDevices = hasPermission("edge.devices.write");
  const canControlDevices = hasPermission("edge.devices.control");
  const canManageCredentials = hasPermission("edge.devices.credentials.manage");
  const canReadHealth = hasPermission("edge.devices.health.read");
  const canReadTelemetry = hasPermission("edge.telemetry.read");
  const canReadKeys = hasPermission("edge.packages.keys.read");
  const canManageKeys = hasPermission("edge.packages.keys.manage");
  const canReadControls = hasPermission("edge.packages.controls.read");
  const canManageControls = hasPermission("edge.packages.controls.manage");
  const canRead = canReadDevices || canReadKeys || canReadControls;

  const [tab, setTab] = useState<Tab>("DEVICES");
  const [devices, setDevices] = useState<EdgeDevice[]>([]);
  const [signingKeys, setSigningKeys] = useState<Row[]>([]);
  const [controls, setControls] = useState<EdgeControl[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [healthReports, setHealthReports] = useState<Row[]>([]);
  const [observations, setObservations] = useState<Row[]>([]);
  const [deviceOffset, setDeviceOffset] = useState(0);
  const [deviceHasMore, setDeviceHasMore] = useState(false);
  const [loadedFactoryId, setLoadedFactoryId] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [protocolFilter, setProtocolFilter] = useState("ALL");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [deviceDraft, setDeviceDraft] = useState<DeviceDraft>(initialDevice());
  const [credentialDays, setCredentialDays] = useState("90");
  const [credentialReceipt, setCredentialReceipt] = useState<CredentialReceipt | null>(null);
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState(initialKeyDraft());
  const [keyRevocation, setKeyRevocation] = useState<{ keyId: string; reason: string } | null>(null);
  const [controlFormOpen, setControlFormOpen] = useState(false);
  const [controlDraft, setControlDraft] = useState(initialControlDraft());
  const [controlDecision, setControlDecision] = useState<{ control: EdgeControl; action: "RESUME" | "REVOKE"; reason: string } | null>(null);

  const [loading, setLoading] = useState(false);
  const [detailLoadedDeviceId, setDetailLoadedDeviceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleDevices = useMemo(
    () => filterEdgeDevices(devices, search, statusFilter, protocolFilter),
    [devices, search, statusFilter, protocolFilter],
  );
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) ?? visibleDevices[0] ?? null;
  const detailLoading = Boolean(selectedDevice && detailLoadedDeviceId !== selectedDevice.id);
  const currentHealthReports = detailLoadedDeviceId === selectedDevice?.id ? healthReports : [];
  const currentObservations = detailLoadedDeviceId === selectedDevice?.id ? observations : [];
  const summary = useMemo(() => summarizeEdgeDevices(devices), [devices]);

  const load = useCallback(async () => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setError("");
    setLoadedFactoryId("");
    setDevices([]);
    setSigningKeys([]);
    setControls([]);
    setHealthReports([]);
    setObservations([]);
    setCredentialReceipt(null);

    const tasks = await Promise.allSettled([
      canReadDevices
        ? request("/v2/edge/devices?limit=25&offset=" + deviceOffset)
        : Promise.resolve(null),
      canReadKeys
        ? request("/v2/edge/package-signing-keys?limit=50&offset=0")
        : Promise.resolve(null),
      canReadControls
        ? request("/v2/edge/package-controls?limit=50&offset=0")
        : Promise.resolve(null),
    ]);

    const failures: string[] = [];
    if (tasks[0].status === "fulfilled" && tasks[0].value) {
      const response = record(tasks[0].value);
      const returnedDevices = deviceRows(response);
      setDevices(returnedDevices);
      setDeviceHasMore(Boolean(response.hasMore));
      setSelectedDeviceId((current) => current && returnedDevices.some((device) => device.id === current)
        ? current
        : returnedDevices[0]?.id ?? "");
    } else if (tasks[0].status === "rejected") failures.push("Device register: " + messageOf(tasks[0].reason));

    if (tasks[1].status === "fulfilled" && tasks[1].value) {
      setSigningKeys(signingKeyRows(tasks[1].value));
    } else if (tasks[1].status === "rejected") failures.push("Signing keys: " + messageOf(tasks[1].reason));

    if (tasks[2].status === "fulfilled" && tasks[2].value) {
      setControls(controlRows(tasks[2].value));
    } else if (tasks[2].status === "rejected") failures.push("Package controls: " + messageOf(tasks[2].reason));

    setLoadedFactoryId(activeFactoryId);
    if (failures.length) setError(failures.join(" · "));
    setLoading(false);
  }, [
    sessionStatus, activeFactoryId, canRead, canReadDevices, canReadKeys, canReadControls,
    request, deviceOffset,
  ]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    void load();
  }, [sessionStatus, activeFactoryId, canRead, load]);

  useEffect(() => {
    if (!selectedDevice || loadedFactoryId !== activeFactoryId) return;
    let current = true;
    const tasks = Promise.allSettled([
      canReadHealth
        ? request("/v2/edge/devices/" + encodeURIComponent(selectedDevice.id) + "/health?limit=25&offset=0")
        : Promise.resolve(null),
      canReadTelemetry
        ? request("/v2/edge/devices/" + encodeURIComponent(selectedDevice.id) + "/observations?limit=25&offset=0")
        : Promise.resolve(null),
    ]);
    void tasks.then((results) => {
      if (!current) return;
      if (results[0].status === "fulfilled" && results[0].value) setHealthReports(healthRows(results[0].value));
      else {
        setHealthReports([]);
        if (results[0].status === "rejected") setError("Device health: " + messageOf(results[0].reason));
      }
      if (results[1].status === "fulfilled" && results[1].value) setObservations(observationRows(results[1].value));
      else {
        setObservations([]);
        if (results[1].status === "rejected") setError("Telemetry: " + messageOf(results[1].reason));
      }
      setDetailLoadedDeviceId(selectedDevice.id);
    });
    return () => { current = false; };
  }, [selectedDevice?.id, loadedFactoryId, activeFactoryId, canReadHealth, canReadTelemetry, request]);

  async function refresh() {
    setNotice("");
    await load();
  }

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

  async function registerDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildEdgeDevicePayload(deviceDraft) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/v2/edge/devices", { method: "POST", body }),
      "Device registration saved to the active factory.",
    );
    if (saved) {
      setRegisterOpen(false);
      setDeviceDraft(initialDevice());
    }
  }

  async function changeDeviceStatus(device: EdgeDevice, status: DeviceStatus) {
    if (!canControlDevices || busy) return;
    if (status === "REVOKED" && !window.confirm(
      "Revoke this device permanently? Revoked devices cannot be reactivated and device ingestion will be blocked.",
    )) return;
    const saved = await perform(
      () => request("/v2/edge/devices/" + encodeURIComponent(device.id) + "/status", {
        method: "POST", body: { status },
      }),
      status === "REVOKED" ? "Device permanently revoked." : "Device status changed to " + status + ".",
    );
    if (saved && status === "REVOKED") setCredentialReceipt(null);
  }

  async function issueCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDevice || !canManageCredentials) return;
    if (!window.confirm(
      "Issue a new device credential? The API revokes all existing active credentials for this device. The new bearer token is shown once and cannot be retrieved again.",
    )) return;
    let body: Row;
    try {
      body = buildEdgeCredentialPayload(credentialDays) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = record(await request(
        "/v2/edge/devices/" + encodeURIComponent(selectedDevice.id) + "/credentials",
        { method: "POST", body },
      ));
      const credential = record(result.credential);
      if (typeof credential.token !== "string" || typeof credential.id !== "string") {
        throw new Error("Credential issued but the one-time token was not returned. Check API response before retrying.");
      }
      setCredentialReceipt({
        id: credential.id,
        deviceId: selectedDevice.id,
        deviceName: selectedDevice.displayName,
        token: credential.token,
        tokenHint: textValue(credential.tokenHint, ""),
        expiresAt: textValue(credential.expiresAt, ""),
        previousCredentialCount: Number(result.previousCredentialCount ?? 0),
      });
      setNotice("New credential issued. Copy and store it securely before closing this one-time display.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revokeIssuedCredential() {
    if (!credentialReceipt || !canManageCredentials || busy) return;
    if (!window.confirm("Revoke this credential now? The device will no longer be able to authenticate with it.")) return;
    const receipt = credentialReceipt;
    const saved = await perform(
      () => request(
        "/v2/edge/devices/" + encodeURIComponent(receipt.deviceId) + "/credentials/" + encodeURIComponent(receipt.id) + "/revoke",
        { method: "POST" },
      ),
      "The displayed credential has been revoked.",
    );
    if (saved) setCredentialReceipt(null);
  }

  async function copyCredential() {
    if (!credentialReceipt) return;
    try {
      await navigator.clipboard.writeText(credentialReceipt.token);
      setNotice("One-time bearer token copied. Store it in the approved device secret store.");
    } catch {
      setError("Clipboard access is unavailable. Select and copy the token manually from this one-time panel.");
    }
  }

  async function registerSigningKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildEdgeSigningKeyPayload(keyDraft) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/v2/edge/package-signing-keys", { method: "POST", body }),
      "Public signing key registered. Private-key material was not submitted.",
    );
    if (saved) {
      setKeyFormOpen(false);
      setKeyDraft(initialKeyDraft());
    }
  }

  async function revokeSigningKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!keyRevocation) return;
    let body: Row;
    try {
      body = buildEdgeSigningKeyRevocationPayload(keyRevocation.reason) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    if (!window.confirm("Revoke signing key " + keyRevocation.keyId + "? Devices will receive this revoked-key state in their next trusted key snapshot.")) return;
    const keyId = keyRevocation.keyId;
    const saved = await perform(
      () => request("/v2/edge/package-signing-keys/" + encodeURIComponent(keyId) + "/revoke", { method: "POST", body }),
      "Signing key revoked.",
    );
    if (saved) setKeyRevocation(null);
  }

  async function createPackageControl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildEdgePackageControlPayload(controlDraft) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    if (body.action === "REVOKE" && !window.confirm("Package REVOKE is permanent for this scope. Continue?")) return;
    const saved = await perform(
      () => request("/v2/edge/package-controls", { method: "POST", body }),
      "Package control saved.",
    );
    if (saved) {
      setControlFormOpen(false);
      setControlDraft(initialControlDraft());
    }
  }

  async function submitControlDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!controlDecision) return;
    let body: Row;
    try {
      body = buildEdgePackageControlPayload({
        package_id: controlDecision.control.packageId,
        package_version: controlDecision.control.packageVersion,
        target_kind: controlDecision.control.targetKind,
        target_key: controlDecision.control.targetKey,
        action: controlDecision.action,
        reason: controlDecision.reason,
      }) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    if (controlDecision.action === "REVOKE" && !window.confirm("This package revocation is permanent. Continue?")) return;
    const saved = await perform(
      () => request("/v2/edge/package-controls", { method: "POST", body }),
      controlDecision.action === "RESUME" ? "Package pause lifted." : "Package control permanently revoked.",
    );
    if (saved) setControlDecision(null);
  }

  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);
  const latestHealth = record(selectedDevice?.latestHealth);
  const activeKeys = signingKeys.filter((key) => String(key.status).toUpperCase() === "ACTIVE").length;
  const activeControls = controls.filter((control) => String(control.status).toUpperCase() === "PAUSED").length;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-5 text-white shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">Factory edge operations</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Edge Device Fleet & Package Governance</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              Factory-scoped gateway registry, signed runtime trust, device credentials, operational health and telemetry visibility.
            </p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={!hasSession || loading || busy || !canRead} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/15 disabled:opacity-50">
            <span aria-hidden="true">↻</span> Refresh workspace
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
          <span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-cyan-100">Factory scoped</span>
          <span className="rounded-full border border-white/15 px-2.5 py-1">Authenticated IAM context</span>
          <span className="rounded-full border border-white/15 px-2.5 py-1">Public-key only registry</span>
        </div>
      </section>

      {!hasSession ? (
        <section className={PANEL}>
          <h2 className="text-sm font-bold text-slate-950">Connect a FactoryOS session</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">Choose an active factory in the workspace header before loading edge devices and package controls.</p>
          <a href="/session" className="mt-4 inline-flex min-h-9 items-center rounded-lg bg-slate-950 px-3 text-xs font-semibold text-white">Open session setup</a>
        </section>
      ) : null}

      {hasSession && !canRead ? (
        <section className={PANEL}>
          <h2 className="text-sm font-bold text-slate-950">No edge governance read permission</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">The connected identity has none of the edge device, signing-key or package-control read permissions required by this workbench.</p>
        </section>
      ) : null}

      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">{notice}</div> : null}

      {hasSession && canRead ? (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Loaded devices" value={summary.total} detail="Current factory device page" />
            <Metric label="Active devices" value={summary.active} detail="Eligible for authenticated ingest" />
            <Metric label="Health attention" value={summary.attention} detail="Degraded or needs attention" />
            <Metric label="Paused package controls" value={activeControls} detail={activeKeys + " active trusted signing keys"} />
          </section>

          <nav aria-label="Edge workbench sections" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            {TABS.map((item) => (
              <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-pressed={tab === item.id}
                className={"min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>
                {item.label}
              </button>
            ))}
          </nav>

          {tab === "DEVICES" ? (
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
              <div className={PANEL}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-950">Factory device register</h2>
                    <p className="mt-1 text-xs text-slate-500">Device identity, protocol, group and latest reported runtime health.</p>
                  </div>
                  {canRegisterDevices ? <button type="button" className={PRIMARY} onClick={() => setRegisterOpen((value) => !value)}>{registerOpen ? "Close registration" : "Register device"}</button> : null}
                </div>

                {registerOpen && canRegisterDevices ? (
                  <form onSubmit={registerDevice} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                    <Field label="Device key" hint="Stable identifier; letters, digits, dot, underscore, colon or hyphen.">
                      <input className={INPUT} required maxLength={100} value={deviceDraft.device_key} onChange={(event) => setDeviceDraft({ ...deviceDraft, device_key: event.target.value })} placeholder="LINE-01-GATEWAY" />
                    </Field>
                    <Field label="Display name">
                      <input className={INPUT} required maxLength={180} value={deviceDraft.display_name} onChange={(event) => setDeviceDraft({ ...deviceDraft, display_name: event.target.value })} placeholder="Packaging line gateway" />
                    </Field>
                    <Field label="Protocol">
                      <select className={INPUT} value={deviceDraft.protocol} onChange={(event) => setDeviceDraft({ ...deviceDraft, protocol: event.target.value })}>
                        <option value="OPC_UA">OPC UA</option><option value="MQTT">MQTT</option><option value="MODBUS">Modbus</option><option value="GENERIC">Generic</option>
                      </select>
                    </Field>
                    <Field label="Device group" hint="Optional stable group identifier.">
                      <input className={INPUT} maxLength={120} value={deviceDraft.device_group} onChange={(event) => setDeviceDraft({ ...deviceDraft, device_group: event.target.value })} placeholder="PACKAGING_LINE" />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="Capability profile (JSON)" hint="Metadata only. Credential-like fields and payload material are rejected.">
                        <textarea className={AREA} rows={4} value={deviceDraft.capability_profile} onChange={(event) => setDeviceDraft({ ...deviceDraft, capability_profile: event.target.value })} spellCheck={false} />
                      </Field>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
                      <button type="button" className={SECONDARY} onClick={() => { setRegisterOpen(false); setDeviceDraft(initialDevice()); }}>Cancel</button>
                      <button type="submit" className={PRIMARY} disabled={busy}>Save device</button>
                    </div>
                  </form>
                ) : null}

                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <input className={INPUT} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, device key or group" aria-label="Search devices" />
                  <select className={INPUT} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by device status">
                    <option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="REVOKED">Revoked</option>
                  </select>
                  <select className={INPUT} value={protocolFilter} onChange={(event) => setProtocolFilter(event.target.value)} aria-label="Filter by protocol">
                    <option value="ALL">All protocols</option><option value="OPC_UA">OPC UA</option><option value="MQTT">MQTT</option><option value="MODBUS">Modbus</option><option value="GENERIC">Generic</option>
                  </select>
                </div>

                {loading ? <p className="py-8 text-center text-xs text-slate-500">Loading factory device register…</p> : null}
                {!loading && !visibleDevices.length ? <div className="mt-4"><Empty>No devices match the current filters, or the current factory has no registered gateways.</Empty></div> : null}
                {visibleDevices.length ? (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[700px] text-left text-xs">
                      <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500"><th className="px-2 py-2">Device</th><th className="px-2 py-2">Protocol / group</th><th className="px-2 py-2">Device status</th><th className="px-2 py-2">Runtime health</th><th className="px-2 py-2">Last seen</th></tr></thead>
                      <tbody>
                        {visibleDevices.map((device) => (
                          <tr key={device.id} className={"cursor-pointer border-b border-slate-100 hover:bg-slate-50 " + (selectedDevice?.id === device.id ? "bg-blue-50/70" : "")} onClick={() => { setSelectedDeviceId(device.id); setCredentialReceipt(null); }}>
                            <td className="px-2 py-3"><p className="font-semibold text-slate-900">{device.displayName}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{device.deviceKey}</p></td>
                            <td className="px-2 py-3"><p className="font-semibold text-slate-700">{device.protocol}</p><p className="mt-1 text-[10px] text-slate-500">{textValue(device.deviceGroup)}</p></td>
                            <td className="px-2 py-3"><StatusPill value={device.status} /></td>
                            <td className="px-2 py-3"><StatusPill value={device.latestHealth?.runtimeStatus ?? "NO_REPORT"} /></td>
                            <td className="px-2 py-3 text-slate-600">{dateTime(device.lastSeenAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span>{devices.length} records loaded · offset {deviceOffset}</span>
                      <div className="flex gap-2">
                        <button type="button" className={SECONDARY} disabled={deviceOffset === 0 || loading} onClick={() => setDeviceOffset((value) => Math.max(0, value - 25))}>Previous page</button>
                        <button type="button" className={SECONDARY} disabled={!deviceHasMore || loading} onClick={() => setDeviceOffset((value) => value + 25)}>Next page</button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <aside className={PANEL}>
                <div className="flex items-start justify-between gap-3">
                  <div><h2 className="text-base font-bold text-slate-950">Selected gateway</h2><p className="mt-1 text-xs text-slate-500">Control requires a separate edge permission.</p></div>
                  {selectedDevice ? <StatusPill value={selectedDevice.status} /> : null}
                </div>
                {!selectedDevice ? <div className="mt-4"><Empty>Select a device to inspect runtime health and controls.</Empty></div> : (
                  <>
                    <div className="mt-4 rounded-xl bg-slate-50 p-3">
                      <p className="text-sm font-bold text-slate-950">{selectedDevice.displayName}</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{selectedDevice.id}</p>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                        <div><p className="text-[10px] text-slate-500">Protocol</p><p className="mt-1 font-semibold text-slate-800">{selectedDevice.protocol}</p></div>
                        <div><p className="text-[10px] text-slate-500">Group</p><p className="mt-1 font-semibold text-slate-800">{textValue(selectedDevice.deviceGroup)}</p></div>
                        <div><p className="text-[10px] text-slate-500">Last sync</p><p className="mt-1 font-semibold text-slate-800">{dateTime(selectedDevice.lastSyncAt)}</p></div>
                        <div><p className="text-[10px] text-slate-500">Agent version</p><p className="mt-1 font-semibold text-slate-800">{textValue(latestHealth.agentVersion)}</p></div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-lg border border-slate-200 p-3"><p className="text-[10px] text-slate-500">Pending batches</p><p className="mt-1 text-lg font-bold text-slate-950">{countValue(latestHealth.pendingBatches)}</p></div>
                      <div className="rounded-lg border border-slate-200 p-3"><p className="text-[10px] text-slate-500">Pending bytes</p><p className="mt-1 text-lg font-bold text-slate-950">{countValue(latestHealth.pendingBytes)}</p></div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {canControlDevices && selectedDevice.status === "ACTIVE" ? <button type="button" className={SECONDARY} disabled={busy} onClick={() => void changeDeviceStatus(selectedDevice, "PAUSED")}>Pause device</button> : null}
                      {canControlDevices && selectedDevice.status === "PAUSED" ? <button type="button" className={SECONDARY} disabled={busy} onClick={() => void changeDeviceStatus(selectedDevice, "ACTIVE")}>Reactivate device</button> : null}
                      {canControlDevices && selectedDevice.status !== "REVOKED" ? <button type="button" className={DANGER} disabled={busy} onClick={() => void changeDeviceStatus(selectedDevice, "REVOKED")}>Revoke permanently</button> : null}
                    </div>
                    {canManageCredentials && selectedDevice.status === "ACTIVE" ? (
                      <form onSubmit={issueCredential} className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                        <h3 className="text-xs font-bold text-amber-950">Issue / rotate device credential</h3>
                        <p className="mt-1 text-[10px] leading-4 text-amber-900">Issuing a new credential revokes every previous active credential for this device. The bearer token is returned once only.</p>
                        <div className="mt-3 flex gap-2">
                          <input className={INPUT} type="number" min={1} max={366} value={credentialDays} onChange={(event) => setCredentialDays(event.target.value)} aria-label="Credential validity days" />
                          <button type="submit" className={PRIMARY} disabled={busy}>Issue token</button>
                        </div>
                      </form>
                    ) : null}
                  </>
                )}
              </aside>
            </section>
          ) : null}

          {tab === "TELEMETRY" ? (
            <section className="grid gap-4">
              <div className={PANEL}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><h2 className="text-base font-bold text-slate-950">Health reports & telemetry observations</h2><p className="mt-1 text-xs text-slate-500">Reported device evidence is telemetry, not an independently verified model decision.</p></div>
                  <select className={INPUT + " max-w-sm"} value={selectedDevice?.id ?? ""} onChange={(event) => { setSelectedDeviceId(event.target.value); setCredentialReceipt(null); }} aria-label="Choose telemetry device">
                    <option value="">Choose a device</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.displayName} · {device.deviceKey}</option>)}
                  </select>
                </div>
                {!selectedDevice ? <div className="mt-4"><Empty>Select a registered device with health or telemetry read permission.</Empty></div> : (
                  <>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <Metric label="Runtime" value={textValue(latestHealth.runtimeStatus)} detail={"Agent " + textValue(latestHealth.agentVersion)} />
                      <Metric label="Pending batches" value={countValue(latestHealth.pendingBatches)} detail={countValue(latestHealth.pendingBytes) + " queued bytes"} />
                      <Metric label="Last successful sync" value={dateTime(latestHealth.lastSuccessfulSyncAt)} detail={"Device seen " + dateTime(selectedDevice.lastSeenAt)} />
                    </div>
                    {detailLoading ? <p className="py-5 text-center text-xs text-slate-500">Loading device evidence…</p> : null}
                    <div className="mt-4 grid gap-4 xl:grid-cols-2">
                      <div className="rounded-xl border border-slate-200 p-3">
                        <h3 className="text-xs font-bold text-slate-900">Health report history</h3>
                        {!canReadHealth ? <p className="mt-3 text-xs text-slate-500">Missing permission: edge.devices.health.read.</p> : null}
                        {canReadHealth && !detailLoading && !currentHealthReports.length ? <div className="mt-3"><Empty>No health reports recorded for this device.</Empty></div> : null}
                        {canReadHealth && healthReports.length ? (
                          <div className="mt-3 space-y-2">
                            {currentHealthReports.map((report) => (
                              <article key={String(report.id ?? report.healthEventId)} className="rounded-lg bg-slate-50 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill value={report.runtimeStatus} /><span className="text-[10px] text-slate-500">{dateTime(report.reportedAt)}</span></div>
                                <p className="mt-2 text-[11px] text-slate-700">Agent {textValue(report.agentVersion)} · {countValue(report.pendingBatches)} pending batches · {countValue(report.pendingBytes)} bytes</p>
                                {Array.isArray(report.driftSignals) && report.driftSignals.length ? (
                                  <div className="mt-2 flex flex-wrap gap-1.5">{(report.driftSignals as Row[]).map((signal, index) => <span key={String(signal.signal_id ?? index)} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">{textValue(signal.signal_type)} · {textValue(signal.severity)}</span>)}</div>
                                ) : <p className="mt-2 text-[10px] text-slate-500">No drift signals in this report.</p>}
                              </article>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="rounded-xl border border-slate-200 p-3">
                        <h3 className="text-xs font-bold text-slate-900">Recent observation stream</h3>
                        {!canReadTelemetry ? <p className="mt-3 text-xs text-slate-500">Missing permission: edge.telemetry.read.</p> : null}
                        {canReadTelemetry && !detailLoading && !currentObservations.length ? <div className="mt-3"><Empty>No telemetry observations recorded for this device.</Empty></div> : null}
                        {canReadTelemetry && observations.length ? (
                          <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[520px] text-left text-[11px]">
                              <thead><tr className="border-b border-slate-200 text-[10px] uppercase text-slate-500"><th className="px-2 py-2">Signal</th><th className="px-2 py-2">Quality</th><th className="px-2 py-2">Source</th><th className="px-2 py-2">Observed</th><th className="px-2 py-2">Evidence</th></tr></thead>
                              <tbody>{currentObservations.map((observation) => <tr key={String(observation.id)} className="border-b border-slate-100"><td className="px-2 py-2 font-semibold text-slate-800">{textValue(observation.signalKey)}</td><td className="px-2 py-2"><StatusPill value={observation.quality} /></td><td className="px-2 py-2 text-slate-600">{textValue(observation.sourceMode)}</td><td className="px-2 py-2 text-slate-600">{dateTime(observation.observedAt)}</td><td className="px-2 py-2 font-mono text-[10px] text-slate-500">{textValue(observation.payloadHash).slice(0, 12)}</td></tr>)}</tbody>
                            </table>
                          </div>
                        ) : null}
                        <p className="mt-3 text-[10px] leading-4 text-slate-500">Raw telemetry payloads are intentionally not rendered in this workbench. The observation hash and safe metadata are shown instead.</p>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          ) : null}

          {tab === "PACKAGES" ? (
            <section className="grid gap-4 xl:grid-cols-2">
              <div className={PANEL}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><h2 className="text-base font-bold text-slate-950">Trusted package signing keys</h2><p className="mt-1 text-xs text-slate-500">Public Ed25519 key fingerprints and rotation/revocation state.</p></div>
                  {canManageKeys ? <button type="button" className={PRIMARY} onClick={() => setKeyFormOpen((value) => !value)}>{keyFormOpen ? "Close form" : "Register public key"}</button> : null}
                </div>
                {keyFormOpen && canManageKeys ? (
                  <form onSubmit={registerSigningKey} className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <Field label="Key ID"><input className={INPUT} required maxLength={128} value={keyDraft.key_id} onChange={(event) => setKeyDraft({ ...keyDraft, key_id: event.target.value })} placeholder="edge-release-2026-01" /></Field>
                    <Field label="Public key PEM" hint="Only -----BEGIN PUBLIC KEY----- material is accepted. Never paste a private key.">
                      <textarea className={AREA} required maxLength={4096} rows={5} spellCheck={false} value={keyDraft.public_key_pem} onChange={(event) => setKeyDraft({ ...keyDraft, public_key_pem: event.target.value })} placeholder="-----BEGIN PUBLIC KEY-----" />
                    </Field>
                    <Field label="Replaces key ID (optional)" hint="The old key remains trusted during overlap; revoke it separately after the grace window.">
                      <input className={INPUT} maxLength={128} value={keyDraft.replaces_key_id} onChange={(event) => setKeyDraft({ ...keyDraft, replaces_key_id: event.target.value })} placeholder="previous-key-id" />
                    </Field>
                    <div className="flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => { setKeyFormOpen(false); setKeyDraft(initialKeyDraft()); }}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Register key</button></div>
                  </form>
                ) : null}
                {!canReadKeys ? <div className="mt-4"><Empty>Missing permission: edge.packages.keys.read.</Empty></div> : null}
                {canReadKeys && !signingKeys.length ? <div className="mt-4"><Empty>No package signing keys are registered for this factory.</Empty></div> : null}
                {canReadKeys && signingKeys.length ? (
                  <div className="mt-4 space-y-2">
                    {signingKeys.map((key) => (
                      <article key={String(key.id)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{textValue(key.keyId)}</p><StatusPill value={key.status} /></div>
                        <p className="mt-2 break-all font-mono text-[10px] text-slate-500">SHA-256 · {textValue(key.fingerprintSha256)}</p>
                        <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] text-slate-500"><span>Created {dateTime(key.createdAt)}</span><span>Replaces {textValue(key.replacesKeyId)}</span></div>
                        {key.revokeReason ? <p className="mt-2 text-[10px] text-rose-700">Revocation: {String(key.revokeReason)}</p> : null}
                        {canManageKeys && String(key.status).toUpperCase() === "ACTIVE" ? <button type="button" className={DANGER + " mt-3"} disabled={busy} onClick={() => setKeyRevocation({ keyId: String(key.keyId), reason: "" })}>Revoke key</button> : null}
                      </article>
                    ))}
                  </div>
                ) : null}
                {keyRevocation ? (
                  <form onSubmit={revokeSigningKey} className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
                    <h3 className="text-xs font-bold text-rose-950">Revoke {keyRevocation.keyId}</h3>
                    <Field label="Revocation reason (8–300 characters)">
                      <textarea className={AREA} rows={3} minLength={8} maxLength={300} required value={keyRevocation.reason} onChange={(event) => setKeyRevocation({ ...keyRevocation, reason: event.target.value })} />
                    </Field>
                    <div className="mt-3 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setKeyRevocation(null)}>Cancel</button><button type="submit" className={DANGER} disabled={busy}>Confirm revocation</button></div>
                  </form>
                ) : null}
              </div>

              <div className={PANEL}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><h2 className="text-base font-bold text-slate-950">Package controls</h2><p className="mt-1 text-xs text-slate-500">Scope-specific PAUSE, RESUME and permanent REVOKE decisions.</p></div>
                  {canManageControls ? <button type="button" className={PRIMARY} onClick={() => setControlFormOpen((value) => !value)}>{controlFormOpen ? "Close form" : "New package control"}</button> : null}
                </div>
                {controlFormOpen && canManageControls ? (
                  <form onSubmit={createPackageControl} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                    <Field label="Package ID"><input className={INPUT} required maxLength={128} value={controlDraft.package_id} onChange={(event) => setControlDraft({ ...controlDraft, package_id: event.target.value })} placeholder="edge-runtime" /></Field>
                    <Field label="Package version"><input className={INPUT} maxLength={32} value={controlDraft.package_version} onChange={(event) => setControlDraft({ ...controlDraft, package_version: event.target.value })} placeholder="* for every version" /></Field>
                    <Field label="Target type">
                      <select className={INPUT} value={controlDraft.target_kind} onChange={(event) => setControlDraft({ ...controlDraft, target_kind: event.target.value, target_key: event.target.value === "FACTORY" ? "*" : event.target.value === "DEVICE" ? (selectedDevice?.id ?? "") : "" })}>
                        <option value="FACTORY">Factory-wide</option><option value="DEVICE">Single device</option><option value="DEVICE_GROUP">Device group</option><option value="USE_CASE">Use case</option>
                      </select>
                    </Field>
                    <Field label="Target key" hint={controlDraft.target_kind === "FACTORY" ? "Factory-wide scope uses '*'.": "Device UUID, registered group ID or stable use-case ID."}>
                      <input className={INPUT} disabled={controlDraft.target_kind === "FACTORY"} required={controlDraft.target_kind !== "FACTORY"} value={controlDraft.target_kind === "FACTORY" ? "*" : controlDraft.target_key} onChange={(event) => setControlDraft({ ...controlDraft, target_key: event.target.value })} placeholder="Target identifier" />
                    </Field>
                    <Field label="Action">
                      <select className={INPUT} value={controlDraft.action} onChange={(event) => setControlDraft({ ...controlDraft, action: event.target.value })}><option value="PAUSE">Pause package</option><option value="REVOKE">Permanently revoke package</option></select>
                    </Field>
                    <Field label="Decision reason (8–300 characters)">
                      <textarea className={AREA} rows={2} minLength={8} maxLength={300} required value={controlDraft.reason} onChange={(event) => setControlDraft({ ...controlDraft, reason: event.target.value })} />
                    </Field>
                    <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className={SECONDARY} onClick={() => { setControlFormOpen(false); setControlDraft(initialControlDraft()); }}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Save control</button></div>
                  </form>
                ) : null}
                {!canReadControls ? <div className="mt-4"><Empty>Missing permission: edge.packages.controls.read.</Empty></div> : null}
                {canReadControls && !controls.length ? <div className="mt-4"><Empty>No package controls are registered for this factory.</Empty></div> : null}
                {canReadControls && controls.length ? (
                  <div className="mt-4 space-y-2">
                    {controls.map((control) => (
                      <article key={control.id} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{control.packageId} · {control.packageVersion}</p><StatusPill value={control.status} /></div>
                        <p className="mt-2 text-[10px] text-slate-600">{control.targetKind} · {control.targetKey}</p>
                        <p className="mt-2 text-[11px] leading-5 text-slate-700">{control.reason}</p>
                        <p className="mt-2 text-[10px] text-slate-500">Updated {dateTime(control.updatedAt)}</p>
                        {canManageControls && String(control.status).toUpperCase() === "PAUSED" ? <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={SECONDARY} onClick={() => setControlDecision({ control, action: "RESUME", reason: "" })}>Resume control</button><button type="button" className={DANGER} onClick={() => setControlDecision({ control, action: "REVOKE", reason: "" })}>Revoke permanently</button></div> : null}
                      </article>
                    ))}
                  </div>
                ) : null}
                {controlDecision ? (
                  <form onSubmit={submitControlDecision} className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                    <h3 className="text-xs font-bold text-amber-950">{controlDecision.action} · {controlDecision.control.packageId}</h3>
                    <Field label="Decision reason (8–300 characters)">
                      <textarea className={AREA} rows={3} minLength={8} maxLength={300} required value={controlDecision.reason} onChange={(event) => setControlDecision({ ...controlDecision, reason: event.target.value })} />
                    </Field>
                    <div className="mt-3 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setControlDecision(null)}>Cancel</button><button type="submit" className={controlDecision.action === "REVOKE" ? DANGER : PRIMARY} disabled={busy}>Confirm {controlDecision.action.toLowerCase()}</button></div>
                  </form>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {credentialReceipt ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-sm font-bold text-amber-950">One-time device bearer credential</h2><p className="mt-1 text-xs text-amber-900">{credentialReceipt.deviceName} · expires {dateTime(credentialReceipt.expiresAt)}</p></div>
            <button type="button" className={SECONDARY} onClick={() => setCredentialReceipt(null)}>Close & clear token</button>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-amber-950">This secret will not be shown again after closing or changing factory. Store it in the approved device secret manager; never commit it or paste it into source code.</p>
          <textarea readOnly aria-label="One-time device bearer token" className={AREA + " mt-3 font-mono text-xs"} rows={3} value={credentialReceipt.token} onFocus={(event) => event.currentTarget.select()} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={PRIMARY} onClick={() => void copyCredential()}>Copy one-time token</button>
            {canManageCredentials ? <button type="button" className={DANGER} disabled={busy} onClick={() => void revokeIssuedCredential()}>Revoke just-issued token</button> : null}
            <span className="text-[10px] text-amber-900">Hint · {credentialReceipt.tokenHint} · {credentialReceipt.previousCredentialCount} previous active credentials revoked</span>
          </div>
        </section>
      ) : null}

      <footer className="border-t border-slate-200 pt-4 text-[10px] leading-5 text-slate-500">
        Tenant and factory scope are supplied by the authenticated FactoryOS session. Device health, drift and telemetry are reported evidence, not proof of a safe control state. Device revocation and package-key/package revocation are permanent lifecycle actions.
      </footer>
    </main>
  );
}
