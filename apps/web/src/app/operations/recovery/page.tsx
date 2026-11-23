"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildNotificationAcknowledgePayload,
  buildOperationsDlqQuery,
  buildOperationsInboxQuery,
  filterOperationsDeadLetters,
  filterOperationsNotifications,
  normalizeOperationsRows,
  summarizeOperationsRecovery,
  validateOperationsIdempotencyKey,
} from "@/lib/operations-recovery-workbench.mjs";
import type {
  BrokerDeadLetter,
  OperationalNotification,
  QuarantinedOutboxEvent,
} from "@/lib/operations-recovery-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "NOTIFICATIONS" | "OUTBOX" | "BROKER";
type RecoveryAction = {
  kind: "OUTBOX" | "BROKER";
  id: string;
  eventType: string;
  attempts: number;
  replayCount: number;
  idempotencyKey: string;
  confirmed: boolean;
};
type AcknowledgeDraft = {
  id: string;
  title: string;
  version: number;
  reason: string;
};

const TABS: { id: Tab; label: string }[] = [
  { id: "NOTIFICATIONS", label: "My notifications" },
  { id: "OUTBOX", label: "Outbox quarantine" },
  { id: "BROKER", label: "Broker dead letters" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown) {
  return normalizeOperationsRows(value) as Row[];
}

function display(value: unknown, fallback = "—") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString() : "—";
}

function shortId(value: unknown) {
  return typeof value === "string" ? value.slice(0, 8).toUpperCase() : "—";
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure idempotency-key generation is unavailable.");
  return validateOperationsIdempotencyKey("operations-recovery:" + globalThis.crypto.randomUUID());
}

function StatusPill({ value }: { value: unknown }) {
  const status = display(value, "UNKNOWN").toUpperCase();
  const tone = ["ACKNOWLEDGED", "REDRIVEN", "PUBLISHED", "COMPLETED"].includes(status)
    ? "bg-emerald-50 text-emerald-800"
    : ["UNREAD", "QUARANTINED", "REDRIVE_PENDING", "PROCESSING"].includes(status)
      ? "bg-amber-50 text-amber-900"
      : ["FAILED", "REJECTED"].includes(status)
        ? "bg-rose-50 text-rose-800"
        : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{status.replaceAll("_", " ")}</span>;
}

function SeverityPill({ value }: { value: unknown }) {
  const severity = display(value, "UNKNOWN").toUpperCase();
  const tone = ["CRITICAL", "HIGH"].includes(severity)
    ? "bg-rose-50 text-rose-800"
    : severity === "MEDIUM"
      ? "bg-amber-50 text-amber-900"
      : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{severity}</span>;
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

function Metric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{typeof value === "number" ? value.toLocaleString() : value}</p>
      <p className="mt-1 text-[10px] text-slate-500">{detail}</p>
    </article>
  );
}

function Pagination({ offset, limit, total, onPrevious, onNext, disabled }: {
  offset: number;
  limit: number;
  total: number;
  onPrevious(): void;
  onNext(): void;
  disabled: boolean;
}) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
      <p className="text-[11px] text-slate-500">Showing {number(start)}–{number(end)} of {number(total)}</p>
      <div className="flex gap-2">
        <button type="button" className={SECONDARY} disabled={disabled || offset === 0} onClick={onPrevious}>Previous</button>
        <button type="button" className={SECONDARY} disabled={disabled || end >= total} onClick={onNext}>Next</button>
      </div>
    </div>
  );
}

export default function OperationsRecoveryWorkbenchPage() {
  const {
    status: sessionStatus,
    activeFactoryId,
    hasPermission,
    request,
  } = useFactoryOsSession();

  const canReadNotifications = hasPermission("notifications.inbox.read");
  const canManageNotifications = hasPermission("notifications.inbox.manage");
  const canReadDlq = hasPermission("outbox.dlq.read");
  const canReplayDlq = hasPermission("outbox.dlq.replay");
  const canRead = canReadNotifications || canReadDlq;

  const [tab, setTab] = useState<Tab>("NOTIFICATIONS");
  const [notifications, setNotifications] = useState<OperationalNotification[]>([]);
  const [outboxEvents, setOutboxEvents] = useState<QuarantinedOutboxEvent[]>([]);
  const [brokerEvents, setBrokerEvents] = useState<BrokerDeadLetter[]>([]);
  const [outboxPagination, setOutboxPagination] = useState({ limit: 50, offset: 0, total: 0, has_more: false });
  const [brokerPagination, setBrokerPagination] = useState({ limit: 50, offset: 0, total: 0, has_more: false });
  const [loadedFactoryId, setLoadedFactoryId] = useState("");

  const [inboxStatus, setInboxStatus] = useState("UNREAD");
  const [notificationSearch, setNotificationSearch] = useState("");
  const [notificationSeverity, setNotificationSeverity] = useState("ALL");
  const [selectedNotificationId, setSelectedNotificationId] = useState("");

  const [outboxSearch, setOutboxSearch] = useState("");
  const [selectedOutboxId, setSelectedOutboxId] = useState("");
  const [brokerSearch, setBrokerSearch] = useState("");
  const [selectedBrokerId, setSelectedBrokerId] = useState("");

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [acknowledgeDraft, setAcknowledgeDraft] = useState<AcknowledgeDraft | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction | null>(null);

  const selectedNotification = notifications.find((row) => row.id === selectedNotificationId) ?? null;
  const selectedOutbox = outboxEvents.find((row) => row.id === selectedOutboxId) ?? null;
  const selectedBroker = brokerEvents.find((row) => row.id === selectedBrokerId) ?? null;

  const visibleNotifications = useMemo(
    () => filterOperationsNotifications(notifications as unknown as Row[], notificationSearch, notificationSeverity) as unknown as OperationalNotification[],
    [notifications, notificationSearch, notificationSeverity],
  );
  const visibleOutbox = useMemo(
    () => filterOperationsDeadLetters(outboxEvents as unknown as Row[], outboxSearch) as unknown as QuarantinedOutboxEvent[],
    [outboxEvents, outboxSearch],
  );
  const visibleBroker = useMemo(
    () => filterOperationsDeadLetters(brokerEvents as unknown as Row[], brokerSearch) as unknown as BrokerDeadLetter[],
    [brokerEvents, brokerSearch],
  );

  const summary = useMemo(
    () => summarizeOperationsRecovery(notifications, outboxEvents, brokerEvents),
    [notifications, outboxEvents, brokerEvents],
  );

  const load = useCallback(async () => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setError("");
    setLoadedFactoryId("");
    setNotifications([]);
    setOutboxEvents([]);
    setBrokerEvents([]);
    setSelectedNotificationId("");
    setSelectedOutboxId("");
    setSelectedBrokerId("");
    try {
      const [inboxResponse, outboxResponse, brokerResponse] = await Promise.all([
        canReadNotifications
          ? request("/notifications/inbox" + buildOperationsInboxQuery(100, inboxStatus))
          : Promise.resolve({ items: [] }),
        canReadDlq
          ? request("/outbox/quarantined" + buildOperationsDlqQuery(activeFactoryId, 50, outboxPagination.offset, "outbox"))
          : Promise.resolve({ items: [], pagination: { limit: 50, offset: 0, total: 0, has_more: false } }),
        canReadDlq
          ? request("/outbox/bus-dead-letters" + buildOperationsDlqQuery(activeFactoryId, 50, brokerPagination.offset, "broker"))
          : Promise.resolve({ items: [], pagination: { limit: 50, offset: 0, total: 0, has_more: false } }),
      ]);
      setNotifications(rows(inboxResponse) as OperationalNotification[]);
      setOutboxEvents(rows(outboxResponse) as QuarantinedOutboxEvent[]);
      setBrokerEvents(rows(brokerResponse) as BrokerDeadLetter[]);
      setOutboxPagination(object(outboxResponse).pagination as typeof outboxPagination ?? {
        limit: 50, offset: outboxPagination.offset, total: 0, has_more: false,
      });
      setBrokerPagination(object(brokerResponse).pagination as typeof brokerPagination ?? {
        limit: 50, offset: brokerPagination.offset, total: 0, has_more: false,
      });
      setLoadedFactoryId(activeFactoryId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [
    sessionStatus, activeFactoryId, canRead, canReadNotifications, canReadDlq, request,
    inboxStatus, outboxPagination.offset, brokerPagination.offset,
  ]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, activeFactoryId, canRead, load]);

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

  async function acknowledgeNotification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!acknowledgeDraft) return;
    let body: Row;
    try {
      body = buildNotificationAcknowledgePayload(acknowledgeDraft.version, acknowledgeDraft.reason) as Row;
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const saved = await perform(
      () => request("/notifications/" + acknowledgeDraft.id + "/acknowledge", { method: "POST", body }),
      "Notification acknowledged.",
    );
    if (saved) setAcknowledgeDraft(null);
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recoveryAction || !recoveryAction.confirmed) return;
    let key: string;
    try {
      key = validateOperationsIdempotencyKey(recoveryAction.idempotencyKey);
    } catch (cause) {
      setError(messageOf(cause));
      return;
    }
    const endpoint = recoveryAction.kind === "OUTBOX"
      ? "/outbox/" + recoveryAction.id + "/replay"
      : "/outbox/bus-dead-letters/" + recoveryAction.id + "/redrive";
    const saved = await perform(
      () => request(endpoint, { method: "POST", idempotencyKey: key }),
      recoveryAction.kind === "OUTBOX"
        ? "Outbox replay accepted. The dispatcher will retry the event; delivery is not yet confirmed."
        : "Broker dead-letter redrive published. Verify the receiving consumer and downstream reconciliation.",
    );
    if (saved) setRecoveryAction(null);
  }

  function openRecovery(kind: "OUTBOX" | "BROKER", id: string, eventType: string, attempts: number, replayCount: number) {
    try {
      setRecoveryAction({
        kind, id, eventType, attempts, replayCount,
        idempotencyKey: newIdempotencyKey(),
        confirmed: false,
      });
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);
  const factoryChanged = Boolean(loadedFactoryId && loadedFactoryId !== activeFactoryId);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-5 bg-gradient-to-br from-slate-950 via-slate-900 to-rose-950 p-6 text-white sm:p-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-rose-200">FactoryOS · Operations reliability</p>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Operations Alert & Recovery</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              Review factory-scoped notifications, inspect quarantined outbox events and control broker dead-letter recovery with explicit confirmation.
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
          <Metric label="Unread notifications" value={loading ? "…" : canReadNotifications ? summary.unreadNotifications : "—"} detail={canReadNotifications ? summary.actionRequired + " require action" : "Inbox read permission not granted"} />
          <Metric label="Quarantined outbox" value={loading ? "…" : canReadDlq ? summary.quarantinedEvents : "—"} detail="Application outbox events awaiting replay" />
          <Metric label="Broker dead letters" value={loading ? "…" : canReadDlq ? summary.brokerQuarantined : "—"} detail={summary.brokerRedrivePending + " pending · " + summary.brokerRedriven + " redriven"} />
          <Metric label="Acknowledged" value={loading ? "…" : canReadNotifications ? summary.acknowledgedNotifications : "—"} detail="Notifications acknowledged in this inbox view" />
        </div>
      </section>

      {!hasSession ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          Connect an authenticated FactoryOS session and select an active factory before opening this workbench.
          <div className="mt-3"><Link href="/session" className="font-semibold underline underline-offset-2">Open session setup</Link></div>
        </section>
      ) : !canRead ? (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
          Your current permission snapshot does not include notification inbox read or outbox dead-letter read access.
        </section>
      ) : null}

      {factoryChanged ? (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Factory context changed. Previous factory data is cleared while the new workspace snapshot loads.
        </div>
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
                  tab === item.id ? "border-rose-700 text-rose-800" : "border-transparent text-slate-500 hover:text-slate-900"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === "NOTIFICATIONS" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-4">
                  <h2 className="text-sm font-bold text-slate-950">Personal operational inbox</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Only notifications addressed to the signed-in user in the active factory are returned.</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_160px_180px]">
                    <input aria-label="Search notifications" className={INPUT} placeholder="Search title, category or message" value={notificationSearch} onChange={(event) => setNotificationSearch(event.target.value)} />
                    <select aria-label="Notification severity" className={INPUT} value={notificationSeverity} onChange={(event) => setNotificationSeverity(event.target.value)}>
                      <option value="ALL">All severity</option><option value="CRITICAL">Critical</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
                    </select>
                    <select aria-label="Inbox status" className={INPUT} value={inboxStatus} onChange={(event) => setInboxStatus(event.target.value)}>
                      <option value="UNREAD">Unread</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="ALL">All statuses</option>
                    </select>
                  </div>
                </div>
                {!canReadNotifications ? <Empty>Inbox read access is not included in your current permissions.</Empty> : visibleNotifications.length === 0 ? <Empty>No notifications match the current filters.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {visibleNotifications.map((notification) => (
                      <button
                        key={notification.id}
                        type="button"
                        onClick={() => setSelectedNotificationId(notification.id)}
                        className={"flex w-full flex-wrap items-start justify-between gap-3 px-4 py-4 text-left hover:bg-slate-50 " + (selectedNotificationId === notification.id ? "bg-rose-50/60" : "")}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-bold text-slate-900">{notification.title}</span>
                            {notification.action_required ? <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[9px] font-bold text-rose-700">Action required</span> : null}
                          </span>
                          <span className="mt-1 block line-clamp-2 text-[11px] leading-5 text-slate-600">{notification.body}</span>
                          <span className="mt-2 block text-[10px] text-slate-400">{notification.category} · {dateTime(notification.created_at)}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2"><SeverityPill value={notification.severity} /><StatusPill value={notification.status} /></span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="border-t border-slate-100 px-4 py-3 text-[11px] text-slate-500">The inbox API returns at most 100 recent rows; select a status to reduce the result set.</div>
              </div>

              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-sm font-bold text-slate-950">Notification detail</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Acknowledgement is recorded against the notification row version.</p>
                </div>
                {!selectedNotification ? <Empty>Select a notification to inspect its message and available action.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-slate-900">{selectedNotification.title}</p><StatusPill value={selectedNotification.status} /></div>
                      <div className="mt-2 flex flex-wrap gap-2"><SeverityPill value={selectedNotification.severity} /><span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-600">{selectedNotification.category}</span></div>
                      <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-slate-700">{selectedNotification.body}</p>
                      <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 text-[11px]">
                        <div><dt className="text-slate-500">Created</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedNotification.created_at)}</dd></div>
                        <div><dt className="text-slate-500">Row version</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{selectedNotification.row_version}</dd></div>
                        <div><dt className="text-slate-500">Action required</dt><dd className="mt-1 font-semibold text-slate-800">{selectedNotification.action_required ? "Yes" : "No"}</dd></div>
                        <div><dt className="text-slate-500">Acknowledged</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedNotification.acknowledged_at)}</dd></div>
                      </dl>
                    </div>
                    {selectedNotification.status === "UNREAD" && canManageNotifications ? (
                      <button
                        type="button"
                        className={PRIMARY}
                        disabled={busy}
                        onClick={() => setAcknowledgeDraft({
                          id: selectedNotification.id,
                          title: selectedNotification.title,
                          version: Number(selectedNotification.row_version),
                          reason: "",
                        })}
                      >
                        Acknowledge notification
                      </button>
                    ) : selectedNotification.status === "UNREAD" ? (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">Read-only: notification inbox manage permission is not included in your current permissions.</p>
                    ) : null}
                    <p className="text-[10px] leading-4 text-slate-400">Source payload, user identifiers, correlation metadata and internal audit fields are not displayed.</p>
                  </>
                )}
              </aside>
            </section>
          ) : null}

          {tab === "OUTBOX" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-4">
                  <h2 className="text-sm font-bold text-slate-950">Quarantined application outbox</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Factory-scoped events marked QUARANTINED after exhausted delivery attempts.</p>
                  <input aria-label="Search quarantined outbox" className={INPUT + " mt-3"} placeholder="Search event type or aggregate type" value={outboxSearch} onChange={(event) => setOutboxSearch(event.target.value)} />
                </div>
                {!canReadDlq ? <Empty>Outbox dead-letter read access is not included in your current permissions.</Empty> : visibleOutbox.length === 0 ? <Empty>No quarantined application outbox events on this page.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {visibleOutbox.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedOutboxId(item.id)}
                        className={"flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 " + (selectedOutboxId === item.id ? "bg-rose-50/60" : "")}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-slate-900">{item.event_type}</span>
                          <span className="mt-1 block truncate text-[10px] text-slate-500">{item.aggregate_type} · version {item.event_version}</span>
                          <span className="mt-1 block text-[10px] text-slate-400">Quarantined {dateTime(item.quarantined_at)}</span>
                        </span>
                        <span className="flex items-center gap-2"><StatusPill value={item.status} /><span className="text-[10px] text-slate-400">{number(item.attempts)} attempts</span></span>
                      </button>
                    ))}
                  </div>
                )}
                <Pagination
                  offset={outboxPagination.offset}
                  limit={outboxPagination.limit}
                  total={outboxPagination.total}
                  disabled={loading || busy}
                  onPrevious={() => setOutboxPagination((current) => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}
                  onNext={() => setOutboxPagination((current) => ({ ...current, offset: current.offset + current.limit }))}
                />
              </div>

              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div><h2 className="text-sm font-bold text-slate-950">Outbox event review</h2><p className="mt-1 text-[11px] text-slate-500">Replay re-queues an event; it does not guarantee successful downstream delivery.</p></div>
                {!selectedOutbox ? <Empty>Select a quarantined event to inspect safe metadata and replay eligibility.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-slate-900">{selectedOutbox.event_type}</p><StatusPill value={selectedOutbox.status} /></div>
                      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div><dt className="text-slate-500">Aggregate</dt><dd className="mt-1 font-semibold text-slate-800">{selectedOutbox.aggregate_type}</dd></div>
                        <div><dt className="text-slate-500">Event version</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{selectedOutbox.event_version}</dd></div>
                        <div><dt className="text-slate-500">Delivery attempts</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{number(selectedOutbox.attempts)}</dd></div>
                        <div><dt className="text-slate-500">Replay count</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{number(selectedOutbox.replay_count)}</dd></div>
                        <div><dt className="text-slate-500">Occurred</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedOutbox.occurred_at)}</dd></div>
                        <div><dt className="text-slate-500">Last replay</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedOutbox.last_replayed_at)}</dd></div>
                      </dl>
                    </div>
                    {canReplayDlq && selectedOutbox.status === "QUARANTINED" ? (
                      <button type="button" className={DANGER} disabled={busy} onClick={() => openRecovery("OUTBOX", selectedOutbox.id, selectedOutbox.event_type, Number(selectedOutbox.attempts), Number(selectedOutbox.replay_count))}>Request outbox replay</button>
                    ) : selectedOutbox.status === "QUARANTINED" ? (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">Read-only: outbox dead-letter replay permission is not included in your current permissions.</p>
                    ) : null}
                    <p className="text-[10px] leading-4 text-slate-400">Payload, correlation IDs, actor/source objects, raw errors and quarantine diagnostics are withheld from this UI.</p>
                  </>
                )}
              </aside>
            </section>
          ) : null}

          {tab === "BROKER" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-4">
                  <h2 className="text-sm font-bold text-slate-950">Kafka consumer dead-letter queue</h2>
                  <p className="mt-1 text-[11px] text-slate-500">Inspect failed consumer events and their redrive lifecycle state.</p>
                  <input aria-label="Search broker dead letters" className={INPUT + " mt-3"} placeholder="Search event type, consumer or topic" value={brokerSearch} onChange={(event) => setBrokerSearch(event.target.value)} />
                </div>
                {!canReadDlq ? <Empty>Broker dead-letter read access is not included in your current permissions.</Empty> : visibleBroker.length === 0 ? <Empty>No broker dead letters on this page.</Empty> : (
                  <div className="divide-y divide-slate-100">
                    {visibleBroker.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedBrokerId(item.id)}
                        className={"flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 " + (selectedBrokerId === item.id ? "bg-rose-50/60" : "")}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-slate-900">{item.event_type}</span>
                          <span className="mt-1 block truncate text-[10px] text-slate-500">{item.consumer_name} · {item.source_topic}</span>
                          <span className="mt-1 block text-[10px] text-slate-400">Failed {dateTime(item.failed_at)}</span>
                        </span>
                        <span className="flex items-center gap-2"><StatusPill value={item.status} /><span className="text-[10px] text-slate-400">{number(item.failed_attempts)} attempts</span></span>
                      </button>
                    ))}
                  </div>
                )}
                <Pagination
                  offset={brokerPagination.offset}
                  limit={brokerPagination.limit}
                  total={brokerPagination.total}
                  disabled={loading || busy}
                  onPrevious={() => setBrokerPagination((current) => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}
                  onNext={() => setBrokerPagination((current) => ({ ...current, offset: current.offset + current.limit }))}
                />
              </div>

              <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div><h2 className="text-sm font-bold text-slate-950">Broker dead-letter review</h2><p className="mt-1 text-[11px] text-slate-500">Redrive publishes the event to the configured Kafka transport.</p></div>
                {!selectedBroker ? <Empty>Select a broker dead letter to inspect safe event metadata and redrive eligibility.</Empty> : (
                  <>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-slate-900">{selectedBroker.event_type}</p><StatusPill value={selectedBroker.status} /></div>
                      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                        <div><dt className="text-slate-500">Consumer</dt><dd className="mt-1 break-words font-semibold text-slate-800">{selectedBroker.consumer_name}</dd></div>
                        <div><dt className="text-slate-500">Source topic</dt><dd className="mt-1 break-words font-semibold text-slate-800">{selectedBroker.source_topic}</dd></div>
                        <div><dt className="text-slate-500">Failed attempts</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{number(selectedBroker.failed_attempts)}</dd></div>
                        <div><dt className="text-slate-500">Failure count</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{number(selectedBroker.failure_count)}</dd></div>
                        <div><dt className="text-slate-500">Redrive count</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{number(selectedBroker.redrive_count)}</dd></div>
                        <div><dt className="text-slate-500">Row version</dt><dd className="mt-1 font-semibold tabular-nums text-slate-800">{number(selectedBroker.row_version)}</dd></div>
                        <div><dt className="text-slate-500">Failed at</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedBroker.failed_at)}</dd></div>
                        <div><dt className="text-slate-500">Last redriven</dt><dd className="mt-1 font-semibold text-slate-800">{dateTime(selectedBroker.last_redriven_at)}</dd></div>
                      </dl>
                    </div>
                    {canReplayDlq && selectedBroker.status === "QUARANTINED" ? (
                      <button type="button" className={DANGER} disabled={busy} onClick={() => openRecovery("BROKER", selectedBroker.id, selectedBroker.event_type, Number(selectedBroker.failed_attempts), Number(selectedBroker.redrive_count))}>Redrive to Kafka</button>
                    ) : selectedBroker.status === "QUARANTINED" ? (
                      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">Read-only: outbox dead-letter replay permission is not included in your current permissions.</p>
                    ) : null}
                    <p className="text-[10px] leading-4 text-slate-400">Event payload, broker offsets, correlation metadata and raw failure details are withheld from this UI.</p>
                  </>
                )}
              </aside>
            </section>
          ) : null}
        </>
      ) : null}

      {acknowledgeDraft ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:items-center">
          <form onSubmit={acknowledgeNotification} className="my-6 w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <h2 className="text-lg font-bold text-slate-950">Acknowledge notification</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">{acknowledgeDraft.title} · expected row version {acknowledgeDraft.version}</p>
            <div className="mt-4">
              <Field label="Acknowledgement reason" hint="1–2000 characters. The API records this reason with the acknowledgement.">
                <textarea required maxLength={2000} rows={4} className={AREA} value={acknowledgeDraft.reason} onChange={(event) => setAcknowledgeDraft({ ...acknowledgeDraft, reason: event.target.value })} />
              </Field>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setAcknowledgeDraft(null)}>Cancel</button>
              <button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Saving…" : "Confirm acknowledgement"}</button>
            </div>
          </form>
        </div>
      ) : null}

      {recoveryAction ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4 sm:items-center">
          <form onSubmit={submitRecovery} className="my-6 w-full max-w-xl rounded-2xl border border-rose-200 bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-700">!</span>
              <div>
                <h2 className="text-lg font-bold text-slate-950">{recoveryAction.kind === "OUTBOX" ? "Request application outbox replay?" : "Publish broker dead-letter redrive?"}</h2>
                <p className="mt-1 text-xs leading-5 text-slate-600">{recoveryAction.eventType}</p>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
              {recoveryAction.kind === "OUTBOX"
                ? "This changes the quarantined event back to PENDING so the application outbox dispatcher can attempt delivery again. It does not mean the downstream consumer has accepted the event."
                : "This invokes the configured Kafka publisher. The backend requires OUTBOX_TRANSPORT=kafka, claims a redrive receipt and publishes the stored event envelope. A successful publish still requires downstream consumer verification."}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-[11px]">
              <div><dt className="text-slate-500">Attempts so far</dt><dd className="mt-1 font-semibold text-slate-900">{number(recoveryAction.attempts)}</dd></div>
              <div><dt className="text-slate-500">Previous replays / redrives</dt><dd className="mt-1 font-semibold text-slate-900">{number(recoveryAction.replayCount)}</dd></div>
              <div className="col-span-2"><dt className="text-slate-500">Event reference</dt><dd className="mt-1 font-mono text-slate-800">{shortId(recoveryAction.id)}</dd></div>
            </dl>
            <label className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs leading-5 text-slate-700">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-rose-700"
                checked={recoveryAction.confirmed}
                onChange={(event) => setRecoveryAction({ ...recoveryAction, confirmed: event.target.checked })}
              />
              I reviewed the event and understand this action may trigger downstream processing.
            </label>
            <p className="mt-3 break-all text-[10px] text-slate-400">Idempotency key: {recoveryAction.idempotencyKey}</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setRecoveryAction(null)}>Cancel</button>
              <button type="submit" className={DANGER} disabled={busy || !recoveryAction.confirmed}>{busy ? "Submitting…" : "Confirm recovery action"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
