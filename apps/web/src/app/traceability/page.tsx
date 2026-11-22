"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  asTraceabilityRows,
  buildRecallAcknowledgementPayload,
  buildRecallDeclarationPayload,
  buildRecallNotificationIntentPayload,
  buildTraceabilityStatusPayload,
  summarizeTraceabilityUnits,
  traceabilityStatusLabel,
  traceabilityUnitTypeLabel,
} from "@/lib/traceability-workbench.mjs";
import type {
  RecallDeclaration,
  RecallImpact,
  RecallNotification,
  TraceabilityRelationship,
  TraceabilityStatusEvent,
  TraceabilityUnit,
  TraceabilityWalk,
} from "@/lib/traceability-workbench.mjs";

type Tab = "IDENTITY" | "GENEALOGY" | "RECALL";
type TraceDirection = "FORWARD" | "REVERSE";

type RecallDraft = { reason: string; depth: string; limit: string };
type NotificationDraft = {
  recipient_type: "CUSTOMER" | "SITE";
  recipient_reference: string;
  channel: "EMAIL" | "PORTAL" | "EDI" | "MANUAL";
  reason: string;
};
type AcknowledgementDraft = {
  outcome: string;
  notes: string;
  evidence_reference: string;
};

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const subtleButton = buttonClass + " border border-transparent text-slate-600 hover:bg-slate-100";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function rowsOf<T>(value: unknown, key = "units"): T[] {
  return asTraceabilityRows(value, key) as T[];
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function quantity(value: string | number | null | undefined, unit?: string) {
  const parsed = Number(value);
  const display = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : "—";
  return display + (unit ? " " + unit : "");
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string; value: string | number; detail: string;
  tone?: "slate" | "blue" | "amber" | "red" | "emerald";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    red: "border-red-100 bg-red-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return (
    <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
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

function StatusPill({ value }: { value: string }) {
  const status = value.toUpperCase();
  const tone = status === "ACTIVE" ? "bg-emerald-50 text-emerald-800"
    : status === "RECALLED" ? "bg-red-100 text-red-800"
      : status === "QUARANTINED" ? "bg-amber-50 text-amber-800"
        : status === "SHIPPED" ? "bg-blue-50 text-blue-800"
          : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{traceabilityStatusLabel(status)}</span>;
}

function PanelTitle({ title, description, action }: {
  title: string; description: string; action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-bold text-slate-950">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

function RelationshipList({ rows, empty }: { rows: TraceabilityRelationship[]; empty: string }) {
  if (!rows.length) return <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500">{empty}</div>;
  return (
    <div className="divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.id} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-slate-900">{row.source_unit_code}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{traceabilityUnitTypeLabel(row.source_unit_type)}</p>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-semibold text-blue-700 sm:flex-col sm:gap-0.5">
            <span className="rounded-full bg-blue-50 px-2 py-1">{row.relationship_type.replaceAll("_", " ")}</span>
            <span className="text-slate-400">{quantity(row.quantity, row.unit)}</span>
          </div>
          <div className="min-w-0 sm:text-right">
            <p className="truncate text-xs font-bold text-slate-900">{row.target_unit_code}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{traceabilityUnitTypeLabel(row.target_unit_type)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function TraceabilityRecallWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const [units, setUnits] = useState<TraceabilityUnit[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [selectedUnit, setSelectedUnit] = useState<TraceabilityUnit | null>(null);
  const [statusEvents, setStatusEvents] = useState<TraceabilityStatusEvent[]>([]);
  const [search, setSearch] = useState("");
  const [unitType, setUnitType] = useState("ALL");
  const [productRole, setProductRole] = useState("ALL");
  const [unitStatus, setUnitStatus] = useState("ALL");
  const [tab, setTab] = useState<Tab>("IDENTITY");
  const [traceDirection, setTraceDirection] = useState<TraceDirection>("FORWARD");
  const [traceWalk, setTraceWalk] = useState<TraceabilityWalk | null>(null);
  const [impact, setImpact] = useState<RecallImpact | null>(null);
  const [recallDepth, setRecallDepth] = useState("5");
  const [recallLimit, setRecallLimit] = useState("200");
  const [recallReason, setRecallReason] = useState("");
  const [recallResult, setRecallResult] = useState<RecallDeclaration | null>(null);
  const [notifications, setNotifications] = useState<RecallNotification[]>([]);
  const [notificationDraft, setNotificationDraft] = useState<NotificationDraft>({
    recipient_type: "CUSTOMER", recipient_reference: "", channel: "PORTAL", reason: "",
  });
  const [acknowledgingId, setAcknowledgingId] = useState("");
  const [ackDraft, setAckDraft] = useState<AcknowledgementDraft>({
    outcome: "RECEIVED", notes: "", evidence_reference: "",
  });
  const [statusTarget, setStatusTarget] = useState("QUARANTINED");
  const [statusReason, setStatusReason] = useState("");
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canRead = hasPermission("traceability.read");
  const canWrite = hasPermission("traceability.write");
  const connected = status === "connected" && Boolean(snapshot) && Boolean(activeFactoryId);
  const selectedSummary = useMemo(() => summarizeTraceabilityUnits(units), [units]);
  const impactComplete = Boolean(
    impact
    && !impact.impact_truncated
    && !impact.provenance_truncated
    && impact.max_depth === Number(recallDepth)
    && impact.node_limit === Number(recallLimit),
  );

  const loadUnits = useCallback(async () => {
    if (!connected || !canRead) {
      setUnits([]);
      setSelectedUnitId("");
      setSelectedUnit(null);
      setStatusEvents([]);
      return;
    }
    setLoadingUnits(true);
    setError("");
    const params = new URLSearchParams({ limit: "100" });
    if (search.trim()) params.set("search", search.trim());
    if (unitType !== "ALL") params.set("unit_type", unitType);
    if (productRole !== "ALL") params.set("product_role", productRole);
    if (unitStatus !== "ALL") params.set("status", unitStatus);
    try {
      const result = await request("/traceability/units?" + params.toString());
      const next = rowsOf<TraceabilityUnit>(result);
      setUnits(next);
      setSelectedUnitId((current) => next.some((unit) => unit.id === current) ? current : next[0]?.id ?? "");
      if (!next.length) {
        setSelectedUnit(null);
        setStatusEvents([]);
        setTraceWalk(null);
        setImpact(null);
      }
    } catch (cause) {
      setError(messageOf(cause));
      setUnits([]);
      setSelectedUnitId("");
    } finally {
      setLoadingUnits(false);
    }
  }, [connected, canRead, request, search, unitType, productRole, unitStatus]);

  const loadSelectedUnit = useCallback(async () => {
    if (!connected || !canRead || !selectedUnitId) {
      setSelectedUnit(null);
      setStatusEvents([]);
      return;
    }
    setLoadingDetail(true);
    try {
      const results = await Promise.allSettled([
        request("/traceability/units/" + selectedUnitId),
        request("/traceability/units/" + selectedUnitId + "/status-history"),
      ]);
      if (results[0].status === "rejected") throw results[0].reason;
      setSelectedUnit(results[0].value as TraceabilityUnit);
      setStatusEvents(results[1].status === "fulfilled"
        ? rowsOf<TraceabilityStatusEvent>(results[1].value, "events") : []);
      setTraceWalk(null);
      setImpact(null);
      setNotifications([]);
      setAcknowledgingId("");
    } catch (cause) {
      setSelectedUnit(null);
      setStatusEvents([]);
      setError(messageOf(cause));
    } finally {
      setLoadingDetail(false);
    }
  }, [connected, canRead, selectedUnitId, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadUnits(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadUnits]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSelectedUnit(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSelectedUnit]);

  const loadTrace = useCallback(async (direction: TraceDirection) => {
    if (!selectedUnitId || !canRead) return;
    setLoadingTrace(true);
    setError("");
    setTraceDirection(direction);
    try {
      const result = await request(
        "/traceability/units/" + selectedUnitId + "/" + direction.toLowerCase() + "?depth=8&limit=300",
      );
      setTraceWalk(result as TraceabilityWalk);
    } catch (cause) {
      setTraceWalk(null);
      setError(messageOf(cause));
    } finally {
      setLoadingTrace(false);
    }
  }, [selectedUnitId, canRead, request]);

  const loadImpact = useCallback(async () => {
    if (!selectedUnitId || !canRead) return;
    setLoadingImpact(true);
    setError("");
    try {
      const payload = buildRecallDeclarationPayload({
        reason: recallReason || "Impact preview only",
        depth: recallDepth,
        limit: recallLimit,
      });
      const result = await request(
        "/traceability/units/" + selectedUnitId + "/recall-impact?depth=" + payload.depth + "&limit=" + payload.limit,
      );
      setImpact(result as RecallImpact);
    } catch (cause) {
      setImpact(null);
      setError(messageOf(cause));
    } finally {
      setLoadingImpact(false);
    }
  }, [selectedUnitId, canRead, request, recallDepth, recallLimit, recallReason]);

  const loadNotifications = useCallback(async (recallCaseId: string) => {
    if (!canRead || !recallCaseId) return;
    setLoadingNotifications(true);
    try {
      const result = await request("/traceability/recall-cases/" + recallCaseId + "/notifications");
      setNotifications(rowsOf<RecallNotification>(result, "items"));
    } catch (cause) {
      setNotifications([]);
      setError(messageOf(cause));
    } finally {
      setLoadingNotifications(false);
    }
  }, [canRead, request]);

  const declareRecall = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedUnit || !canWrite || !impactComplete) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildRecallDeclarationPayload({
        reason: recallReason, depth: recallDepth, limit: recallLimit,
      });
      const result = await request("/traceability/units/" + selectedUnit.id + "/recall", {
        method: "POST",
        idempotencyKey: "traceability-recall-declare-" + crypto.randomUUID(),
        body,
      }) as RecallDeclaration;
      setRecallResult(result);
      setNotifications([]);
      setNotice("Recall case declared. Eligible identities were moved to RECALLED; shipped identities remain unchanged and require follow-up.");
      await loadSelectedUnit();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const createNotification = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const caseId = recallResult?.recall_case.id;
    if (!caseId || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildRecallNotificationIntentPayload(notificationDraft);
      await request("/traceability/recall-cases/" + caseId + "/notifications", {
        method: "POST",
        idempotencyKey: "traceability-recall-notification-" + crypto.randomUUID(),
        body,
      });
      setNotificationDraft({ recipient_type: "CUSTOMER", recipient_reference: "", channel: "PORTAL", reason: "" });
      await loadNotifications(caseId);
      setNotice("Notification intent recorded. This is not evidence that an email, portal message or EDI payload was sent or delivered.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeNotification = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const caseId = recallResult?.recall_case.id;
    if (!caseId || !acknowledgingId || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildRecallAcknowledgementPayload(ackDraft);
      await request(
        "/traceability/recall-cases/" + caseId + "/notifications/" + acknowledgingId + "/acknowledgements",
        {
          method: "POST",
          idempotencyKey: "traceability-recall-ack-" + crypto.randomUUID(),
          body,
        },
      );
      setAcknowledgingId("");
      setAckDraft({ outcome: "RECEIVED", notes: "", evidence_reference: "" });
      await loadNotifications(caseId);
      setNotice("Operator-reported acknowledgement recorded. It is not externally authenticated.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const changeUnitStatus = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedUnit || !canWrite) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildTraceabilityStatusPayload({ target_status: statusTarget, reason: statusReason });
      await request("/traceability/units/" + selectedUnit.id + "/status", {
        method: "POST",
        idempotencyKey: "traceability-status-change-" + crypto.randomUUID(),
        body,
      });
      setStatusReason("");
      await Promise.all([loadSelectedUnit(), loadUnits()]);
      setNotice("Traceability status transition recorded with an audit event.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const openTab = (next: Tab) => {
    setTab(next);
    if (next === "GENEALOGY" && selectedUnitId && !traceWalk) void loadTrace("FORWARD");
    if (next === "RECALL" && selectedUnitId && !impact) void loadImpact();
    if (next === "RECALL" && recallResult?.recall_case.id) void loadNotifications(recallResult.recall_case.id);
  };

  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      onClick={() => openTab(value)}
      aria-pressed={tab === value}
      className={[
        "min-h-10 rounded-lg px-3 text-xs font-semibold transition-colors",
        tab === value ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100",
      ].join(" ")}
    >
      {label}
    </button>
  );

  if (!connected) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-950 sm:px-6">
        <div className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Traceability workspace</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">Connect your FactoryOS session</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">Identity registers and recall actions require a verified user, tenant and active factory context.</p>
          <Link href="/session" className={"mt-6 " + primaryButton}>Open session</Link>
        </div>
      </main>
    );
  }

  if (!canRead) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-950 sm:px-6">
        <div className="mx-auto max-w-3xl rounded-3xl border border-amber-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Permission required</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">Traceability read access is missing</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">Ask a workspace administrator to grant <code>traceability.read</code>. The server remains the authorization authority.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-700">Product integrity · genealogy · market action</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Traceability & Recall Workbench</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Follow LOT/SERIAL identity through production, packing and shipment. Assess downstream recall exposure before declaring a controlled recall case.</p>
            <p className="mt-2 text-[11px] text-slate-500">Active factory scope: {snapshot?.factories.find((factory) => factory.id === activeFactoryId)?.code ?? shortId(activeFactoryId)} · Authenticated session</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/inventory" className={secondaryButton}>Inventory</Link>
            <Link href="/wms" className={secondaryButton}>WMS operations</Link>
            <button type="button" onClick={() => { void loadUnits(); }} disabled={loadingUnits} className={primaryButton}>{loadingUnits ? "Refreshing…" : "Refresh identities"}</button>
          </div>
        </header>

        {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}
        {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Identity register" value={selectedSummary.total} detail="Units returned by current filters" />
          <Metric label="Active LOT / SERIAL" value={selectedSummary.active} detail={selectedSummary.lots + " LOT · " + selectedSummary.serials + " SERIAL"} tone="emerald" />
          <Metric label="Quarantined" value={selectedSummary.quarantined} detail="Held for controlled disposition" tone="amber" />
          <Metric label="Recalled" value={selectedSummary.recalled} detail="Identities already in recall state" tone="red" />
          <Metric label="Expiring in 30 days" value={selectedSummary.expiringSoon} detail="Based on identity expiry dates" tone="blue" />
        </section>

        <section className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <PanelTitle title="Identity register" description="Search unit code or barcode; narrow by identity role and lifecycle state." />
            <Field label="Search identity">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="LOT-2026-001 / barcode" className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Unit type">
                <select value={unitType} onChange={(event) => setUnitType(event.target.value)} className={inputClass}>
                  <option value="ALL">All types</option>
                  {["LOT", "SERIAL", "PALLET", "CARTON", "BUNDLE", "FINISHED_GOOD", "SHIPMENT"].map((value) => <option key={value} value={value}>{traceabilityUnitTypeLabel(value)}</option>)}
                </select>
              </Field>
              <Field label="Product role">
                <select value={productRole} onChange={(event) => setProductRole(event.target.value)} className={inputClass}>
                  <option value="ALL">All roles</option>
                  {["MATERIAL", "FINISHED_GOOD", "PACKAGING", "SHIPMENT", "OTHER"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Lifecycle status">
              <select value={unitStatus} onChange={(event) => setUnitStatus(event.target.value)} className={inputClass}>
                <option value="ALL">All statuses</option>
                {["ACTIVE", "QUARANTINED", "RECALLED", "DISPOSED", "SHIPPED"].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </Field>
            <div className="flex items-center justify-between border-b border-slate-100 pb-2 text-[11px] text-slate-500">
              <span>{units.length} identities · max 100 per query</span>
              <span>{loadingUnits ? "Loading…" : "Factory scoped"}</span>
            </div>
            <div className="max-h-[640px] space-y-2 overflow-y-auto pr-1">
              {units.map((unit) => (
                <button
                  key={unit.id}
                  type="button"
                  onClick={() => { setSelectedUnitId(unit.id); setRecallResult(null); setNotifications([]); setImpact(null); setTraceWalk(null); setAcknowledgingId(""); }}
                  aria-pressed={selectedUnitId === unit.id}
                  className={[
                    "w-full rounded-xl border p-3 text-left transition",
                    selectedUnitId === unit.id ? "border-blue-300 bg-blue-50 ring-1 ring-blue-100" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-bold text-slate-950">{unit.unit_code}</span>
                    <StatusPill value={unit.status} />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">{unit.unit_type} · {unit.product_role}</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-500">
                    <span>{unit.inventory_sku || unit.external_reference || "No inventory link"}</span>
                    <span className="font-semibold text-slate-700">{quantity(unit.quantity, unit.unit)}</span>
                  </div>
                </button>
              ))}
              {!units.length && !loadingUnits ? <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500">No traceability identities match the current filters.</div> : null}
            </div>
          </aside>

          <section className="min-w-0 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              {selectedUnit ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Selected identity · {traceabilityUnitTypeLabel(selectedUnit.unit_type)}</p>
                      <h2 className="mt-1 break-all text-xl font-bold tracking-tight text-slate-950">{selectedUnit.unit_code}</h2>
                      <p className="mt-1 text-xs text-slate-500">{selectedUnit.product_role.replaceAll("_", " ")} · ID {shortId(selectedUnit.id)} · Version {selectedUnit.version ?? "—"}</p>
                    </div>
                    <StatusPill value={selectedUnit.status} />
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold text-slate-500">Quantity</p><p className="mt-1 text-sm font-bold">{quantity(selectedUnit.quantity, selectedUnit.unit)}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold text-slate-500">Inventory item</p><p className="mt-1 truncate text-sm font-bold">{selectedUnit.inventory_sku || "—"}</p><p className="text-[10px] text-slate-500">{selectedUnit.inventory_item_name || ""}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold text-slate-500">Manufactured</p><p className="mt-1 text-xs font-bold">{dateTime(selectedUnit.manufactured_at)}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold text-slate-500">Expires</p><p className="mt-1 text-xs font-bold">{dateTime(selectedUnit.expires_at)}</p></div>
                  </div>
                  <div className="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                    <p><span className="text-slate-500">Barcode:</span> <span className="font-mono text-slate-800">{selectedUnit.barcode_value || "—"}</span></p>
                    <p><span className="text-slate-500">RFID EPC:</span> <span className="font-mono text-slate-800">{selectedUnit.rfid_epc || "—"}</span></p>
                    <p><span className="text-slate-500">Supplier:</span> <span className="font-semibold text-slate-800">{selectedUnit.supplier_code || "—"} {selectedUnit.supplier_name || ""}</span></p>
                    <p><span className="text-slate-500">Goods receipt:</span> <span className="font-semibold text-slate-800">{selectedUnit.receipt_number || "—"}</span></p>
                    <p><span className="text-slate-500">Sales order:</span> <span className="font-semibold text-slate-800">{selectedUnit.order_number || "—"}</span></p>
                    <p><span className="text-slate-500">Product:</span> <span className="font-semibold text-slate-800">{selectedUnit.product_code || "—"} {selectedUnit.product_name || ""}</span></p>
                    <p><span className="text-slate-500">Created:</span> <span className="font-semibold text-slate-800">{dateTime(selectedUnit.created_at)}</span></p>
                    <p><span className="text-slate-500">Correlation:</span> <span className="font-mono text-slate-800">{shortId(selectedUnit.correlation_id)}</span></p>
                  </div>
                </>
              ) : (
                <div className="py-9 text-center">
                  <p className="font-semibold text-slate-800">{loadingDetail ? "Loading identity…" : "Select a traceability identity"}</p>
                  <p className="mt-1 text-xs text-slate-500">Identity details, lifecycle history and linked genealogy will appear here.</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
              {tabButton("IDENTITY", "Lifecycle & status")}
              {tabButton("GENEALOGY", "Forward / reverse trace")}
              {tabButton("RECALL", "Recall impact & response")}
            </div>

            {tab === "IDENTITY" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <PanelTitle title="Lifecycle history" description="Versioned status transitions and their recorded reasons." />
                  <div className="mt-4 space-y-3">
                    {statusEvents.map((event) => (
                      <div key={event.id} className="relative border-l-2 border-slate-200 pb-2 pl-4 last:pb-0">
                        <span className="absolute -left-[5px] top-1 size-2 rounded-full bg-blue-600" />
                        <p className="text-xs font-bold">{event.from_status} <span className="text-slate-400">→</span> {event.to_status}</p>
                        <p className="mt-1 text-[11px] leading-5 text-slate-600">{event.reason}</p>
                        <p className="mt-1 text-[10px] text-slate-400">v{event.version} · {dateTime(event.created_at)}</p>
                      </div>
                    ))}
                    {!statusEvents.length ? <p className="rounded-xl bg-slate-50 p-4 text-xs text-slate-500">No status transitions have been recorded for this identity.</p> : null}
                  </div>
                </section>
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <PanelTitle title="Change lifecycle status" description="Use an authorized, reasoned transition; the API enforces the lifecycle state machine." />
                  {canWrite ? (
                    <form onSubmit={(event) => { void changeUnitStatus(event); }} className="mt-4 space-y-3">
                      <Field label="Target status">
                        <select value={statusTarget} onChange={(event) => setStatusTarget(event.target.value)} className={inputClass} disabled={!selectedUnit}>
                          {["ACTIVE", "QUARANTINED", "RECALLED", "DISPOSED", "SHIPPED"].filter((value) => value !== selectedUnit?.status).map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </Field>
                      <Field label="Reason">
                        <textarea value={statusReason} onChange={(event) => setStatusReason(event.target.value)} rows={3} maxLength={2000} className={inputClass} placeholder="Explain the status transition…" disabled={!selectedUnit} />
                      </Field>
                      <button type="submit" disabled={!selectedUnit || busy || !statusReason.trim()} className={primaryButton}>{busy ? "Saving…" : "Record status transition"}</button>
                    </form>
                  ) : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-xs text-slate-500">Read-only access. traceability.write is required to change identity status.</p>}
                </section>
              </div>
            ) : null}

            {tab === "GENEALOGY" ? (
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <PanelTitle
                  title="Product genealogy explorer"
                  description="Walk downstream to finished goods, containers and shipments, or upstream to consumed material provenance."
                  action={<div className="flex gap-1 rounded-lg bg-slate-100 p-1"><button type="button" onClick={() => { void loadTrace("FORWARD"); }} className={traceDirection === "FORWARD" ? primaryButton : subtleButton}>Forward</button><button type="button" onClick={() => { void loadTrace("REVERSE"); }} className={traceDirection === "REVERSE" ? primaryButton : subtleButton}>Reverse</button></div>}
                />
                {loadingTrace ? <p className="mt-4 text-xs text-slate-500">Traversing genealogy graph…</p> : null}
                {traceWalk ? (
                  <>
                    <div className="mt-4 grid gap-3 sm:grid-cols-4">
                      <Metric label="Identities" value={traceWalk.units.length} detail="Nodes in bounded traversal" />
                      <Metric label="Relationships" value={traceWalk.relationships.length} detail="Genealogy edges returned" />
                      <Metric label="Maximum depth" value={traceWalk.max_depth} detail="Configured traversal bound" />
                      <Metric label="Graph completeness" value={traceWalk.truncated ? "TRUNCATED" : "WITHIN BOUNDS"} detail={traceWalk.truncated ? "Load a wider bound before relying on results" : "No truncation reported"} tone={traceWalk.truncated ? "amber" : "emerald"} />
                    </div>
                    {traceWalk.truncated ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">This genealogy view is truncated. It is useful for exploration but must not be treated as a complete impact assessment.</div> : null}
                    <div className="mt-5 space-y-3">
                      <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-blue-700">Root identity</p>
                        <p className="mt-1 text-sm font-bold">{traceWalk.root.unit_code}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">{traceWalk.root.unit_type} · {traceWalk.root.product_role}</p>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {traceWalk.units.filter((row) => row.id !== traceWalk.root.id).map((row) => (
                          <button key={row.id} type="button" onClick={() => { setSelectedUnitId(row.id); setTab("IDENTITY"); }} className="rounded-xl border border-slate-200 p-3 text-left hover:border-blue-300 hover:bg-blue-50/40">
                            <div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-bold">{row.unit_code}</span><span className="text-[10px] text-slate-500">Depth {row.depth}</span></div>
                            <p className="mt-1 text-[10px] text-slate-500">{row.unit_type} · {row.product_role}</p>
                            <div className="mt-2"><StatusPill value={row.status} /></div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-5">
                      <h3 className="mb-2 text-xs font-bold text-slate-900">Genealogy relationships</h3>
                      <RelationshipList rows={traceWalk.relationships} empty="No genealogy relationships were found in this direction." />
                    </div>
                  </>
                ) : (
                  <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">Select a direction to explore linked source and target identities.</div>
                )}
              </section>
            ) : null}

            {tab === "RECALL" ? (
              <div className="space-y-4">
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <PanelTitle title="Recall impact assessment" description="Read-only assessment of downstream genealogy, upstream provenance and affected dispatched shipments." action={<button type="button" onClick={() => { void loadImpact(); }} disabled={!selectedUnit || loadingImpact} className={secondaryButton}>{loadingImpact ? "Assessing…" : "Refresh impact"}</button>} />
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <Field label="Traversal depth" hint="1–12 levels. Must match the assessment used for declaration.">
                      <input type="number" min="1" max="12" step="1" value={recallDepth} onChange={(event) => { setRecallDepth(event.target.value); setImpact(null); }} className={inputClass} />
                    </Field>
                    <Field label="Maximum identity nodes" hint="1–500 nodes. The API refuses partial recall declarations.">
                      <input type="number" min="1" max="500" step="1" value={recallLimit} onChange={(event) => { setRecallLimit(event.target.value); setImpact(null); }} className={inputClass} />
                    </Field>
                  </div>
                  {impact ? (
                    <>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <Metric label="Downstream identities" value={impact.impacted_unit_count} detail="Not including selected root unit" tone="blue" />
                        <Metric label="Affected shipments" value={impact.affected_shipment_count} detail="Dispatched shipments linked by genealogy" tone="amber" />
                        <Metric label="Upstream provenance" value={impact.upstream_provenance.length} detail="Source identities connected upstream" />
                        <Metric label="Assessment status" value={impactComplete ? "COMPLETE" : "INCOMPLETE"} detail={impactComplete ? "Within configured bounds" : "Truncated or bounds changed"} tone={impactComplete ? "emerald" : "red"} />
                      </div>
                      {!impactComplete ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">Recall declaration is disabled. The forward or reverse graph is truncated, or the configured bounds have changed. Refresh the assessment using the current bounds and do not declare against a partial genealogy.</div> : null}
                      {impact.affected_shipments.length ? (
                        <div className="mt-5 overflow-x-auto">
                          <h3 className="mb-2 text-xs font-bold">Potentially affected shipments</h3>
                          <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Shipment</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Quantity</th><th className="px-3 py-2">Carrier / Tracking</th><th className="px-3 py-2">Dispatched</th><th className="px-3 py-2">Latest event / POD</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                              {impact.affected_shipments.map((shipment) => <tr key={shipment.shipment_unit_id}><td className="px-3 py-3 font-bold">{shipment.shipment_code}</td><td className="px-3 py-3">{shipment.customer_name}<p className="text-[10px] text-slate-500">{shipment.customer_order_reference}</p></td><td className="px-3 py-3 tabular-nums">{quantity(shipment.quantity, shipment.unit)}</td><td className="px-3 py-3">{shipment.carrier_name || "—"}<p className="text-[10px] text-slate-500">{shipment.tracking_reference || "No tracking ref"}</p></td><td className="px-3 py-3">{dateTime(shipment.dispatched_at)}</td><td className="px-3 py-3">{shipment.latest_delivery_event_type || "No event"}<p className="text-[10px] text-slate-500">{shipment.pod_reference || "No POD reference"}</p></td></tr>)}
                            </tbody>
                          </table>
                        </div>
                      ) : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-xs text-slate-500">No downstream dispatched shipment was returned for this identity.</p>}
                      <div className="mt-5 grid gap-4 lg:grid-cols-2">
                        <div><h3 className="mb-2 text-xs font-bold">Impacted downstream identities</h3><div className="max-h-64 space-y-2 overflow-y-auto">{impact.impacted_units.map((row) => <div key={row.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 p-2"><div className="min-w-0"><p className="truncate text-xs font-semibold">{row.unit_code}</p><p className="text-[10px] text-slate-500">{row.unit_type} · depth {row.depth}</p></div><StatusPill value={row.status} /></div>)}</div></div>
                        <div><h3 className="mb-2 text-xs font-bold">Upstream source identities</h3><div className="max-h-64 space-y-2 overflow-y-auto">{impact.upstream_provenance.map((row) => <div key={row.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 p-2"><div className="min-w-0"><p className="truncate text-xs font-semibold">{row.unit_code}</p><p className="text-[10px] text-slate-500">{row.unit_type} · depth {row.depth}</p></div><StatusPill value={row.status} /></div>)}</div></div>
                      </div>
                    </>
                  ) : <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-7 text-center text-xs text-slate-500">{loadingImpact ? "Calculating genealogy impact…" : "Run an impact assessment to inspect downstream exposure before taking recall action."}</div>}
                </section>

                {canWrite ? (
                  <section className="rounded-2xl border border-red-200 bg-white p-4 shadow-sm sm:p-5">
                    <PanelTitle title="Declare a traceability recall" description="This is a controlled, audited action. Eligible ACTIVE or QUARANTINED identities will transition to RECALLED; shipped identities remain SHIPPED and require follow-up." />
                    <form onSubmit={(event) => { void declareRecall(event); }} className="mt-4 space-y-3">
                      <Field label="Recall reason">
                        <textarea value={recallReason} onChange={(event) => setRecallReason(event.target.value)} rows={3} maxLength={1800} placeholder="Describe the confirmed hazard, nonconformance or supplier issue…" className={inputClass} disabled={!selectedUnit} />
                      </Field>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="max-w-xl text-[11px] leading-5 text-slate-500">The API rechecks the graph under a transaction lock, snapshots its fingerprint, and records status/audit/outbox events. It refuses depth or fan-out truncation.</p>
                        <button type="submit" disabled={!selectedUnit || !canWrite || busy || !recallReason.trim() || !impactComplete} className={buttonClass + " bg-red-700 text-white hover:bg-red-800"}>{busy ? "Declaring…" : "Declare recall case"}</button>
                      </div>
                    </form>
                    {recallResult ? (
                      <div className="mt-5 rounded-xl border border-red-200 bg-red-50/60 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold text-red-900">Recall case recorded</p><p className="mt-1 font-mono text-[10px] text-red-800">{recallResult.recall_case.id}</p></div><span className="rounded-full bg-red-100 px-2.5 py-1 text-[10px] font-bold text-red-800">{recallResult.units.length} identities in case</span></div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-3"><p className="text-xs text-slate-700"><strong>{recallResult.units.filter((row) => row.unit_action === "RECALLED").length}</strong> changed to RECALLED</p><p className="text-xs text-slate-700"><strong>{recallResult.units.filter((row) => row.unit_action === "ALREADY_RECALLED").length}</strong> already recalled</p><p className="text-xs text-slate-700"><strong>{recallResult.follow_up_required}</strong> shipped identities need follow-up</p></div>
                        <div className="mt-3 max-h-48 space-y-1 overflow-y-auto">{recallResult.units.map((row) => <div key={row.unit_id} className="flex items-center justify-between gap-2 rounded-lg bg-white/80 px-2.5 py-2 text-[10px]"><span className="font-semibold">{row.unit_code_snapshot}</span><span className="text-right text-slate-600">{row.unit_action.replaceAll("_", " ")}</span></div>)}</div>
                      </div>
                    ) : null}
                  </section>
                ) : <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">Read-only access. traceability.write is required to declare recall cases or contact intents.</div>}

                {recallResult ? (
                  <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                    <PanelTitle title="Customer & site response register" description="Record dispatch intents and operator-reported acknowledgement outcomes for this recall case." action={<button type="button" onClick={() => { void loadNotifications(recallResult.recall_case.id); }} disabled={loadingNotifications} className={secondaryButton}>{loadingNotifications ? "Loading…" : "Refresh responses"}</button>} />
                    {canWrite ? (
                      <form onSubmit={(event) => { void createNotification(event); }} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <Field label="Recipient type"><select value={notificationDraft.recipient_type} onChange={(event) => setNotificationDraft((current) => ({ ...current, recipient_type: event.target.value as NotificationDraft["recipient_type"] }))} className={inputClass}><option value="CUSTOMER">Customer</option><option value="SITE">Site</option></select></Field>
                        <Field label="Customer / site reference" hint="Use a reference token, not an email address or URL."><input required value={notificationDraft.recipient_reference} onChange={(event) => setNotificationDraft((current) => ({ ...current, recipient_reference: event.target.value }))} className={inputClass} placeholder="CUST-ACME-01" /></Field>
                        <Field label="Channel"><select value={notificationDraft.channel} onChange={(event) => setNotificationDraft((current) => ({ ...current, channel: event.target.value as NotificationDraft["channel"] }))} className={inputClass}><option value="PORTAL">Portal</option><option value="EMAIL">Email</option><option value="EDI">EDI</option><option value="MANUAL">Manual</option></select></Field>
                        <div className="flex items-end"><button type="submit" disabled={busy || !notificationDraft.recipient_reference.trim()} className={primaryButton}>Record notification intent</button></div>
                      </form>
                    ) : null}
                    <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">Dispatch status is INTENT_RECORDED_NOT_DELIVERY_CONFIRMED. The API records an outbox intent; this page does not claim the message was sent or delivered. Acknowledgements are operator-reported and not externally authenticated.</p>
                    <div className="mt-4 space-y-2">
                      {notifications.map((notification) => (
                        <div key={notification.id} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div><p className="text-xs font-bold">{notification.recipient_type} · {notification.recipient_reference}</p><p className="mt-1 text-[10px] text-slate-500">{notification.channel} · {dateTime(notification.created_at)}</p></div>
                            <span className={"rounded-full px-2 py-1 text-[10px] font-bold " + (notification.acknowledgement_id ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800")}>{notification.acknowledgement_outcome || "AWAITING ACKNOWLEDGEMENT"}</span>
                          </div>
                          {notification.acknowledgement_id ? <p className="mt-2 text-[11px] text-slate-600">Operator-reported acknowledgement · {notification.acknowledgement_source || "OPERATOR_REPORTED"} · {notification.acknowledgement_evidence_reference || "No evidence reference"}</p> : canWrite ? (
                            <div className="mt-3">
                              {acknowledgingId === notification.id ? (
                                <form onSubmit={(event) => { void acknowledgeNotification(event); }} className="grid gap-2 sm:grid-cols-3">
                                  <Field label="Outcome"><select value={ackDraft.outcome} onChange={(event) => setAckDraft((current) => ({ ...current, outcome: event.target.value }))} className={inputClass}><option value="RECEIVED">Received</option><option value="NO_ACTION_REQUIRED">No action required</option><option value="ACTION_IN_PROGRESS">Action in progress</option><option value="ACTION_COMPLETED">Action completed</option><option value="UNABLE_TO_CONFIRM">Unable to confirm</option></select></Field>
                                  <Field label="Evidence reference" hint="Reference token, not a URL."><input value={ackDraft.evidence_reference} onChange={(event) => setAckDraft((current) => ({ ...current, evidence_reference: event.target.value }))} className={inputClass} /></Field>
                                  <Field label="Notes"><input value={ackDraft.notes} onChange={(event) => setAckDraft((current) => ({ ...current, notes: event.target.value }))} className={inputClass} /></Field>
                                  <div className="flex gap-2 sm:col-span-3"><button type="submit" disabled={busy} className={primaryButton}>Save acknowledgement</button><button type="button" onClick={() => setAcknowledgingId("")} className={secondaryButton}>Cancel</button></div>
                                </form>
                              ) : <button type="button" onClick={() => { setAcknowledgingId(notification.id); setAckDraft({ outcome: "RECEIVED", notes: "", evidence_reference: "" }); }} className={secondaryButton}>Record acknowledgement</button>}
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {!notifications.length ? <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500">{loadingNotifications ? "Loading response register…" : "No customer/site notification intents have been recorded for this recall case."}</div> : null}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}
          </section>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-slate-100 p-4 text-xs leading-5 text-slate-700 sm:p-5">
          <h2 className="font-semibold text-slate-900">Safety and acceptance boundaries</h2>
          <p className="mt-1">Every read and write uses the shared authenticated session, selected active factory and traceability.read / traceability.write permissions. No tenant, factory, actor or bearer token is accepted from form input. The API is authoritative for graph traversal, scope isolation, state transitions, locking, idempotency, audit and outbox records.</p>
          <p className="mt-2">A recall impact preview is read-only. Declaring a recall changes eligible ACTIVE/QUARANTINED traceability statuses and records a case; SHIPPED identities are preserved and flagged for follow-up. Creating a notification records an intent only—not delivery. Acknowledgements are operator-reported, not externally authenticated. Inventory quantities are not directly changed by this workbench.</p>
        </section>
      </div>
    </main>
  );
}
