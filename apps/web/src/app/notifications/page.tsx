"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildOperationalNotificationAcknowledgementPayload,
  createOperationalNotificationClient,
  filterOperationalNotifications,
  normalizeOperationalNotificationRows,
  summarizeOperationalNotifications,
} from "@/lib/operational-notification-workbench.mjs";
import type { OperationalNotificationClient } from "@/lib/operational-notification-workbench.mjs";

type Row = Record<string, unknown>;
type InboxStatus = "ALL" | "UNREAD" | "ACKNOWLEDGED";

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function valueOf(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}
function booleanOf(value: unknown): boolean {
  return value === true;
}
function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function getVersion(item: Row): number {
  const value = item.row_version ?? item.rowVersion;
  return typeof value === "number" ? value : Number(value ?? 0);
}
function getStatus(item: Row): string {
  return valueOf(item.status, "UNKNOWN");
}
function getCategory(item: Row): string {
  return valueOf(item.category, "GENERAL");
}
function getSeverity(item: Row): string {
  return valueOf(item.severity, "LOW");
}
function getTitle(item: Row): string {
  return valueOf(item.title, "Operational notification");
}
function getBody(item: Row): string {
  return valueOf(item.body, "No additional notification detail was provided.");
}
function errorOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The notification inbox request could not be completed.";
}
function statusClass(value: string): string {
  if (value === "UNREAD") return "border-blue-200 bg-blue-50 text-blue-800";
  if (value === "ACKNOWLEDGED") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}
function severityClass(value: string): string {
  if (value === "CRITICAL") return "border-rose-300 bg-rose-100 text-rose-900";
  if (value === "HIGH") return "border-orange-200 bg-orange-50 text-orange-800";
  if (value === "MEDIUM") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-slate-200 bg-slate-50 text-slate-700";
}
function Badge({ value, kind = "status" }: { value: string; kind?: "status" | "severity" }) {
  const cls = kind === "severity" ? severityClass(value) : statusClass(value);
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + cls}>{value.replaceAll("_", " ")}</span>;
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
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>{children}</label>;
}
function Metric({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p><p className="mt-1 text-[10px] text-slate-500">{hint}</p></div>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">{children}</div>;
}

export default function NotificationInboxPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot) && Boolean(activeFactoryId);
  const canRead = hasPermission("notifications.inbox.read");
  const canManage = hasPermission("notifications.inbox.manage");
  const client = useMemo<OperationalNotificationClient>(() => createOperationalNotificationClient(request), [request]);

  const [notifications, setNotifications] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [statusFilter, setStatusFilter] = useState<InboxStatus>("ALL");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [actionOnly, setActionOnly] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmAcknowledge, setConfirmAcknowledge] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [latestReceipt, setLatestReceipt] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    if (!connected || !canRead) return () => { live = false; };
    const load = async () => {
      try {
        const response = await client.listInbox({
          limit: 200,
          status: statusFilter === "ALL" ? undefined : statusFilter,
        });
        if (live) {
          const next = normalizeOperationalNotificationRows(response).map(row);
          setNotifications(next);
          setSelectedId((current) => next.some((entry) => valueOf(entry.id) === current)
            ? current : valueOf(next[0]?.id, ""));
          setLoadError("");
        }
      } catch (cause) {
        if (live) setLoadError(errorOf(cause));
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [connected, canRead, client, activeFactoryId, statusFilter, refreshTick]);

  const summary = useMemo(() => summarizeOperationalNotifications(notifications), [notifications]);
  const categories = useMemo(() => Array.from(new Set(notifications.map(getCategory))).sort(), [notifications]);
  const severities = useMemo(() => Array.from(new Set(notifications.map(getSeverity))).sort(), [notifications]);
  const filtered = useMemo(() => filterOperationalNotifications(notifications, {
    query, category: categoryFilter, severity: severityFilter, actionOnly,
  }).map(row), [notifications, query, categoryFilter, severityFilter, actionOnly]);
  const selected = notifications.find((entry) => valueOf(entry.id) === selectedId) ?? null;
  const actionRequired = selected ? booleanOf(selected.action_required ?? selected.actionRequired) : false;
  const isUnread = selected ? getStatus(selected) === "UNREAD" : false;
  const selectedVersion = selected ? getVersion(selected) : 0;
  const payload = selected?.payload ?? null;

  async function acknowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canManage || !isUnread) return;
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await client.acknowledge(String(selected.id), buildOperationalNotificationAcknowledgementPayload({
        expected_version: selectedVersion,
        reason,
      }));
      setLatestReceipt(receipt);
      setNotice({ tone: "success", message: "Notification acknowledged. The server has recorded the actor, reason and new row version." });
      setReason("");
      setConfirmAcknowledge(false);
      setRefreshTick((value) => value + 1);
    } catch (cause) {
      setNotice({ tone: "error", message: errorOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  const factory = snapshot?.factories.find((entry) => entry.id === activeFactoryId);

  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Factory operations</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Notification Inbox</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Factory-scoped operational alerts from utilities and EHS lifecycle events, with recipient-specific acknowledgement history.</p>
        <p className="mt-1 text-[10px] text-slate-500">{valueOf(snapshot?.tenant.name, "Tenant unavailable")} · {valueOf(factory?.name, "No active factory selected")}</p>
      </div>
      <div className="flex items-center gap-2">
        <Badge value={connected ? "CONNECTED" : status.toUpperCase()} />
        <button type="button" className={SECONDARY} disabled={!connected || !canRead || loading || busy} onClick={() => { setLoading(true); setRefreshTick((value) => value + 1); }}>Refresh inbox</button>
      </div>
    </div>

    {!connected ? <Panel title="Connect an active factory session" subtitle="The notification inbox cannot be queried without a verified tenant and active factory.">
      <Empty>Open Session, connect using the authenticated FactoryOS flow, and select an active factory from the workspace header.</Empty>
      <a href="/session" className={PRIMARY + " mt-3"}>Open session</a>
    </Panel> : null}

    {connected && !canRead ? <Panel title="Inbox permission required"><Empty>The authenticated user does not have notifications.inbox.read. Ask a tenant administrator to grant the permission through the approved IAM workflow.</Empty></Panel> : null}

    {notice ? <div role="status" aria-live="polite" className={"rounded-xl border px-4 py-3 text-xs leading-5 " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900")}>{notice.message}</div> : null}
    {loadError ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-900"><p className="font-bold">Could not load notification inbox</p><p className="mt-1">{loadError}</p></div> : null}

    {connected && canRead ? <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Inbox records" value={summary.total} hint="Current server response page" />
        <Metric label="Unread" value={summary.unread} hint="Requires review or acknowledgement" />
        <Metric label="Action required" value={summary.actionRequired} hint="Source notification marked action-required" />
        <Metric label="Critical" value={summary.critical} hint="Critical severity in current response" />
      </div>

      <Panel title="Find notifications" subtitle="Status is filtered by the server; search, category, severity and action-required filters apply to the returned inbox page.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="Status"><select className={INPUT} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as InboxStatus); setLoading(true); }}><option value="ALL">All statuses</option><option value="UNREAD">Unread</option><option value="ACKNOWLEDGED">Acknowledged</option></select></Field>
          <Field label="Search"><input className={INPUT} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, message, source, ID…" /></Field>
          <Field label="Category"><select className={INPUT} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="ALL">All categories</option>{categories.map((category) => <option key={category} value={category}>{category.replaceAll("_", " ")}</option>)}</select></Field>
          <Field label="Severity"><select className={INPUT} value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}><option value="ALL">All severities</option>{severities.map((severity) => <option key={severity} value={severity}>{severity}</option>)}</select></Field>
          <label className="flex min-h-10 items-center gap-2 self-end rounded-lg border border-slate-200 px-3 text-xs text-slate-700"><input type="checkbox" className="size-4" checked={actionOnly} onChange={(event) => setActionOnly(event.target.checked)} />Action required only</label>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500"><span>Showing {filtered.length} of {notifications.length} loaded records</span><button type="button" className="font-semibold text-blue-700 underline" onClick={() => { setQuery(""); setCategoryFilter("ALL"); setSeverityFilter("ALL"); setActionOnly(false); }}>Clear local filters</button></div>
      </Panel>

      {loading ? <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">Loading recipient-specific notifications…</div> : null}

      <div className="grid items-start gap-4 xl:grid-cols-[1.02fr_0.98fr]">
        <Panel title="Inbox" subtitle="Newest unread notifications appear first, as ordered by the server.">
          {filtered.length ? <div className="space-y-2">{filtered.map((item) => {
            const selectedItem = valueOf(item.id) === selectedId;
            const itemStatus = getStatus(item);
            return <button key={valueOf(item.id)} type="button" onClick={() => { setSelectedId(valueOf(item.id)); setReason(""); setConfirmAcknowledge(false); }} aria-pressed={selectedItem} className={"w-full rounded-xl border p-3 text-left transition-colors " + (selectedItem ? "border-slate-950 bg-slate-50" : "border-slate-200 hover:bg-slate-50")}>
              <div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 flex-1 text-xs font-bold text-slate-950">{getTitle(item)}</p><Badge value={itemStatus} /></div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-600">{getBody(item)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2"><Badge value={getSeverity(item)} kind="severity" /><span className="text-[10px] text-slate-500">{getCategory(item).replaceAll("_", " ")}</span>{booleanOf(item.action_required ?? item.actionRequired) ? <span className="rounded-full bg-amber-100 px-2 py-1 text-[9px] font-bold text-amber-900">ACTION REQUIRED</span> : null}</div>
              <p className="mt-2 text-[10px] text-slate-400">{formatDate(item.created_at ?? item.createdAt)} · v{getVersion(item)}</p>
            </button>;
          })}</div> : <Empty>{loading ? "Loading notifications…" : "No notifications match the current filters."}</Empty>}
          <p className="mt-3 text-[10px] text-slate-400">Inbox request is capped at 200 records. This page does not claim that older pages beyond the server response are loaded.</p>
        </Panel>

        <div className="space-y-4">
          <Panel title="Notification details" subtitle="Source references and payload are display-only evidence; this page does not mutate the source utility or EHS record.">
            {selected ? <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2"><Badge value={getStatus(selected)} /><Badge value={getSeverity(selected)} kind="severity" />{actionRequired ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold text-amber-900">ACTION REQUIRED</span> : null}</div>
              <h2 className="text-base font-bold text-slate-950">{getTitle(selected)}</h2>
              <p className="whitespace-pre-wrap text-xs leading-6 text-slate-700">{getBody(selected)}</p>
              <dl className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase text-slate-500">Category</dt><dd className="mt-1 text-xs font-semibold">{getCategory(selected)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase text-slate-500">Source event</dt><dd className="mt-1 break-all text-xs font-semibold">{valueOf(selected.source_event_type ?? selected.sourceEventType)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase text-slate-500">Aggregate</dt><dd className="mt-1 break-all text-xs font-semibold">{valueOf(selected.aggregate_type ?? selected.aggregateType)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase text-slate-500">Aggregate ID</dt><dd className="mt-1 break-all text-xs font-semibold">{valueOf(selected.aggregate_id ?? selected.aggregateId)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase text-slate-500">Created</dt><dd className="mt-1 text-xs font-semibold">{formatDate(selected.created_at ?? selected.createdAt)}</dd></div>
                <div className="rounded-lg bg-slate-50 p-3"><dt className="text-[10px] uppercase text-slate-500">Row version</dt><dd className="mt-1 text-xs font-semibold">{selectedVersion}</dd></div>
              </dl>
              {selected.acknowledged_at || selected.acknowledgedAt ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"><p className="font-bold">Acknowledged</p><p className="mt-1">{formatDate(selected.acknowledged_at ?? selected.acknowledgedAt)}</p><p className="mt-1">Actor {valueOf(selected.acknowledged_by_user_id ?? selected.acknowledgedByUserId)}</p><p className="mt-1">Reason: {valueOf(selected.last_change_reason ?? selected.lastChangeReason)}</p></div> : null}
              {payload && typeof payload === "object" ? <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-semibold text-blue-700">Source payload evidence</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-[10px] leading-5 text-slate-100">{JSON.stringify(payload, null, 2)}</pre></details> : null}
            </div> : <Empty>Select a notification from the inbox to inspect its source and acknowledgement state.</Empty>}
          </Panel>

          <Panel title="Acknowledge notification" subtitle="Acknowledgement is recipient-specific, version-checked and requires an audit reason. It does not close or resolve the underlying utility alert or EHS record.">
            {selected && isUnread && canManage ? <form className="space-y-3" onSubmit={(event) => void acknowledge(event)}>
              <Field label="Acknowledgement reason"><textarea className={AREA} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} required placeholder="Describe what was reviewed, who owns the follow-up and any next action…" /></Field>
              <label className="flex items-start gap-2 text-xs leading-5 text-slate-700"><input className="mt-1 size-4" type="checkbox" checked={confirmAcknowledge} onChange={(event) => setConfirmAcknowledge(event.target.checked)} /><span>I have reviewed this notification and understand acknowledgement does not resolve its source event.</span></label>
              <button className={PRIMARY} type="submit" disabled={busy || !reason.trim() || !confirmAcknowledge}>Acknowledge notification</button>
            </form> : <Empty>{!selected ? "Select an unread notification first." : !canManage ? "notifications.inbox.manage is required to acknowledge notifications." : "This notification is already acknowledged."}</Empty>}
          </Panel>
        </div>
      </div>
    </> : null}

    {latestReceipt ? <Panel title="Acknowledgement receipt" subtitle="The exact server response is shown for audit traceability."><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-[10px] leading-5 text-slate-100">{JSON.stringify(latestReceipt, null, 2)}</pre></Panel> : null}

    <footer className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[10px] leading-5 text-slate-500">
      Authenticated recipient + tenant + active factory scope · server-side IAM permission guards · maximum 200 loaded records · optimistic row-version acknowledgement · required reason · source events remain unchanged.
    </footer>
  </main>;
}
