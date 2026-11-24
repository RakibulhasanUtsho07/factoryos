"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildOrderMaterialDispositionPayload,
  buildOrderProductionReportPayload,
  buildSalesOrderCreatePayload,
  buildSalesOrderTransitionPayload,
  createSalesOrderClient,
  normalizeSalesOrderPagination,
  normalizeSalesOrderRows,
  summarizeSalesOrders,
} from "@/lib/sales-order-workbench.mjs";
import type { SalesOrderClient, SalesOrderPagination, SalesOrderStatus } from "@/lib/sales-order-workbench.mjs";

type Row = Record<string, unknown>;
type LineDraft = {
  product_code: string;
  product_name: string;
  quantity: string;
  unit: string;
  inventory_item_id: string;
  unit_price: string;
  requested_delivery_date: string;
  notes: string;
};
type CreateDraft = {
  order_number: string;
  customer_name: string;
  customer_reference: string;
  order_date: string;
  requested_delivery_date: string;
  currency: string;
  notes: string;
  lines: LineDraft[];
};
type ProductionDraft = {
  order_line_id: string;
  good_quantity: string;
  scrap_quantity: string;
  scrap_reason: string;
  notes: string;
};
type DispositionDraft = {
  reservation_id: string;
  disposition_type: "RETURN_TO_STOCK" | "SCRAPPED";
  quantity: string;
  notes: string;
};

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const BUTTON = "inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = BUTTON + " bg-slate-950 text-white hover:bg-slate-800";
const SECONDARY = BUTTON + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const DANGER = BUTTON + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";
const STATUS_OPTIONS: SalesOrderStatus[] = ["DRAFT", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const TRANSITIONS: Record<string, SalesOrderStatus[]> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function textOf(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The sales order request could not be completed.";
}
function localDate(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}
function dateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function quantity(value: unknown, unit = ""): string {
  const parsed = numeric(value);
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 4 }) + (unit ? " " + unit : "");
}
function amount(value: unknown, currency = "BDT"): string {
  if (value === null || value === undefined || value === "") return "Not priced";
  return currency + " " + numeric(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function orderStatusClass(status: string): string {
  if (status === "COMPLETED") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "IN_PROGRESS") return "border-blue-200 bg-blue-50 text-blue-800";
  if (status === "CONFIRMED") return "border-cyan-200 bg-cyan-50 text-cyan-800";
  if (status === "CANCELLED") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}
function initialLine(): LineDraft {
  return {
    product_code: "", product_name: "", quantity: "1", unit: "PCS",
    inventory_item_id: "", unit_price: "", requested_delivery_date: "", notes: "",
  };
}
function initialCreateDraft(): CreateDraft {
  return {
    order_number: "", customer_name: "", customer_reference: "",
    order_date: localDate(), requested_delivery_date: "", currency: "BDT",
    notes: "", lines: [initialLine()],
  };
}
function initialProductionDraft(lineId = ""): ProductionDraft {
  return { order_line_id: lineId, good_quantity: "", scrap_quantity: "0", scrap_reason: "", notes: "" };
}
function initialDispositionDraft(): DispositionDraft {
  return { reservation_id: "", disposition_type: "RETURN_TO_STOCK", quantity: "", notes: "" };
}

function Panel({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-sm font-bold text-slate-950">{title}</h2>
          {subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-semibold text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-4 text-slate-500">{hint}</span> : null}
    </label>
  );
}
function Metric({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p>
      <p className="mt-1 text-[10px] leading-4 text-slate-500">{hint}</p>
    </article>
  );
}
function StatusPill({ status }: { status: string }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + orderStatusClass(status)}>{status.replaceAll("_", " ")}</span>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">{children}</div>;
}

export default function SalesOrderLifecycleWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot) && Boolean(activeFactoryId);
  const canRead = hasPermission("orders.read");
  const canWrite = hasPermission("orders.write");
  const client = useMemo<SalesOrderClient>(() => createSalesOrderClient(request), [request]);
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);

  const [orders, setOrders] = useState<Row[]>([]);
  const [pagination, setPagination] = useState<SalesOrderPagination>({ page: 1, limit: 20, total: 0, total_pages: 0 });
  const [selectedId, setSelectedId] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<Row | null>(null);
  const [reports, setReports] = useState<Row[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SalesOrderStatus | "ALL">("ALL");
  const [page, setPage] = useState(1);
  const [refreshTick, setRefreshTick] = useState(0);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(initialCreateDraft);
  const [transitionTarget, setTransitionTarget] = useState<SalesOrderStatus | "">("");
  const [productionDraft, setProductionDraft] = useState<ProductionDraft>(initialProductionDraft());
  const [dispositionDraft, setDispositionDraft] = useState<DispositionDraft>(initialDispositionDraft());

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!connected || !canRead) {
        await Promise.resolve();
        if (live) {
          setOrders([]);
          setSelectedId("");
          setSelectedOrder(null);
          setReports([]);
          setLoading(false);
        }
        return;
      }
      try {
        const response = await client.list({
          page, limit: 20, status: statusFilter, search: submittedSearch,
        });
        const nextRows = normalizeSalesOrderRows(response).map(row);
        const nextPagination = normalizeSalesOrderPagination(response);
        if (live) {
          setOrders(nextRows);
          setPagination(nextPagination);
          setSelectedId((current) => nextRows.some((item) => textOf(item.id, "") === current)
            ? current : textOf(nextRows[0]?.id, ""));
          setLoadError("");
        }
      } catch (cause) {
        if (live) setLoadError(messageOf(cause));
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [connected, canRead, client, activeFactoryId, page, statusFilter, submittedSearch, refreshTick]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (!connected || !canRead || !selectedId) {
        await Promise.resolve();
        if (live) {
          setSelectedOrder(null);
          setReports([]);
          setDetailLoading(false);
        }
        return;
      }
      try {
        const detail = await client.get(selectedId);
        if (live) {
          setSelectedOrder(row(detail));
          setDetailError("");
        }
      } catch (cause) {
        if (live) {
          setSelectedOrder(null);
          setDetailError(messageOf(cause));
        }
      }
      try {
        const reportResponse = await client.listProductionReports(selectedId, 50);
        if (live) setReports(normalizeSalesOrderRows(reportResponse).map(row));
      } catch {
        if (live) setReports([]);
      } finally {
        if (live) setDetailLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [connected, canRead, client, activeFactoryId, selectedId, detailRefreshTick]);

  const summary = useMemo(() => summarizeSalesOrders(orders), [orders]);
  const lines = useMemo(() => Array.isArray(selectedOrder?.lines) ? selectedOrder.lines.map(row) : [], [selectedOrder]);
  const selectedStatus = textOf(selectedOrder?.status, "");
  const allowedTransitions = TRANSITIONS[selectedStatus] ?? [];
  const selectedCurrency = textOf(selectedOrder?.currency, "BDT");
  const totalReportGood = reports.reduce((sum, item) => sum + numeric(item.good_quantity), 0);
  const totalReportScrap = reports.reduce((sum, item) => sum + numeric(item.scrap_quantity), 0);
  const reportYield = totalReportGood + totalReportScrap > 0
    ? (totalReportGood * 100 / (totalReportGood + totalReportScrap)).toFixed(2)
    : "—";

  const refreshWorkspace = useCallback(() => {
    setLoading(true);
    setDetailLoading(true);
    setRefreshTick((current) => current + 1);
    setDetailRefreshTick((current) => current + 1);
  }, []);

  const applySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setLoading(true);
    setSubmittedSearch(searchInput.trim());
  };

  const updateLine = (index: number, field: keyof LineDraft, value: string) => {
    setCreateDraft((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line),
    }));
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeFactoryId) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = buildSalesOrderCreatePayload({
        ...createDraft,
        factory_id: activeFactoryId,
      });
      const created = row(await client.create(payload, globalThis.crypto.randomUUID()));
      const createdId = textOf(created.id, "");
      setCreateOpen(false);
      setCreateDraft(initialCreateDraft());
      setNotice({ tone: "success", message: "Sales order " + textOf(created.order_number, "") + " was created as DRAFT." });
      setStatusFilter("ALL");
      setSubmittedSearch("");
      setSearchInput("");
      setPage(1);
      if (createdId) {
        setSelectedId(createdId);
        setSelectedOrder(created);
      }
      setRefreshTick((current) => current + 1);
      setDetailRefreshTick((current) => current + 1);
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  const submitTransition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedOrder || !transitionTarget) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = buildSalesOrderTransitionPayload({
        target_status: transitionTarget,
        expected_version: Number(selectedOrder.version),
      });
      await client.transition(textOf(selectedOrder.id), payload);
      setNotice({ tone: "success", message: "Order status changed to " + transitionTarget + ". Inventory reservation/consumption rules were enforced by the API." });
      setTransitionTarget("");
      refreshWorkspace();
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
      setDetailLoading(true);
      setDetailRefreshTick((current) => current + 1);
    } finally {
      setBusy(false);
    }
  };

  const submitProductionReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedOrder) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = buildOrderProductionReportPayload(productionDraft);
      const result = row(await client.createProductionReport(
        textOf(selectedOrder.id), payload, globalThis.crypto.randomUUID(),
      ));
      setNotice({
        tone: "success",
        message: "Production report posted. Good output " + quantity(result.good_quantity)
          + ", scrap " + quantity(result.scrap_quantity) + "; finished-good receipt and traceability references were returned by the API.",
      });
      setProductionDraft(initialProductionDraft(textOf(lines[0]?.id, "")));
      refreshWorkspace();
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
      setDetailLoading(true);
      setDetailRefreshTick((current) => current + 1);
    } finally {
      setBusy(false);
    }
  };

  const submitDisposition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedOrder) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = buildOrderMaterialDispositionPayload(dispositionDraft);
      const result = row(await client.createMaterialDisposition(
        textOf(selectedOrder.id), payload, globalThis.crypto.randomUUID(),
      ));
      setNotice({
        tone: "success",
        message: "Material disposition recorded as " + textOf(result.disposition_type, dispositionDraft.disposition_type)
          + ". Stock movement reference: " + textOf(result.movement_id, "not created for scrap"),
      });
      setDispositionDraft(initialDispositionDraft());
      refreshWorkspace();
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  const canShowWorkspace = connected && canRead;

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-700">Commercial operations / orders</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Sales Order Lifecycle</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Manage customer orders from draft through confirmation, production reporting and completion.
            Inventory and production side effects remain enforced by the FactoryOS API.
          </p>
          <p className="mt-2 text-xs font-medium text-slate-500">Factory scope: {activeFactory ? activeFactory.name : "No active factory selected"}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className={SECONDARY} onClick={refreshWorkspace} disabled={!canShowWorkspace || loading}>Refresh</button>
          <button type="button" className={PRIMARY} onClick={() => { setCreateOpen((open) => !open); setNotice(null); }} disabled={!canWrite || !connected}>
            {createOpen ? "Close order form" : "Create sales order"}
          </button>
        </div>
      </header>

      {notice ? (
        <div role="status" className={"rounded-xl border px-4 py-3 text-sm " + (notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900")}>
          {notice.message}
        </div>
      ) : null}
      {status !== "connected" ? (
        <Empty>Connect an authenticated FactoryOS session and select an active factory to open Sales Order Lifecycle.</Empty>
      ) : !canRead ? (
        <Empty>Your current IAM permissions do not include orders.read. Ask a tenant administrator to grant access.</Empty>
      ) : null}

      {createOpen && canWrite ? (
        <Panel title="Create sales order" subtitle="The selected active factory is attached by the authenticated workspace. New orders are created in DRAFT state.">
          <form className="space-y-5" onSubmit={submitCreate}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Order number">
                <input className={INPUT} value={createDraft.order_number} onChange={(event) => setCreateDraft((current) => ({ ...current, order_number: event.currentTarget.value }))} required maxLength={100} placeholder="SO-2026-001" />
              </Field>
              <Field label="Customer name">
                <input className={INPUT} value={createDraft.customer_name} onChange={(event) => setCreateDraft((current) => ({ ...current, customer_name: event.currentTarget.value }))} maxLength={255} placeholder="Customer / buyer" />
              </Field>
              <Field label="Customer reference">
                <input className={INPUT} value={createDraft.customer_reference} onChange={(event) => setCreateDraft((current) => ({ ...current, customer_reference: event.currentTarget.value }))} maxLength={255} placeholder="Customer PO / reference" />
              </Field>
              <Field label="Currency">
                <input className={INPUT} value={createDraft.currency} onChange={(event) => setCreateDraft((current) => ({ ...current, currency: event.currentTarget.value.toUpperCase() }))} required maxLength={3} minLength={3} />
              </Field>
              <Field label="Order date">
                <input className={INPUT} type="date" value={createDraft.order_date} onChange={(event) => setCreateDraft((current) => ({ ...current, order_date: event.currentTarget.value }))} />
              </Field>
              <Field label="Requested delivery date">
                <input className={INPUT} type="date" value={createDraft.requested_delivery_date} onChange={(event) => setCreateDraft((current) => ({ ...current, requested_delivery_date: event.currentTarget.value }))} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Order notes">
                  <input className={INPUT} value={createDraft.notes} onChange={(event) => setCreateDraft((current) => ({ ...current, notes: event.currentTarget.value }))} maxLength={4000} placeholder="Commercial instructions or customer notes" />
                </Field>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-sm font-bold text-slate-900">Order lines</h3><p className="mt-1 text-xs text-slate-500">Link an inventory item UUID to enable reservation and finished-good posting workflows.</p></div>
              <button type="button" className={SECONDARY} onClick={() => setCreateDraft((current) => ({ ...current, lines: [...current.lines, initialLine()] }))} disabled={createDraft.lines.length >= 100}>Add line</button>
            </div>
            <div className="space-y-3">
              {createDraft.lines.map((line, index) => (
                <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800">Line {index + 1}</span>
                    <button type="button" className="text-xs font-semibold text-rose-700 disabled:text-slate-400" onClick={() => setCreateDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))} disabled={createDraft.lines.length === 1}>Remove line</button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Field label="Product code"><input className={INPUT} required maxLength={100} value={line.product_code} onChange={(event) => updateLine(index, "product_code", event.currentTarget.value)} placeholder="FG-001" /></Field>
                    <Field label="Product name"><input className={INPUT} required maxLength={255} value={line.product_name} onChange={(event) => updateLine(index, "product_name", event.currentTarget.value)} placeholder="Finished product" /></Field>
                    <Field label="Quantity"><input className={INPUT} required type="number" min="0.0001" step="0.0001" value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.currentTarget.value)} /></Field>
                    <Field label="Unit"><input className={INPUT} required maxLength={50} value={line.unit} onChange={(event) => updateLine(index, "unit", event.currentTarget.value)} placeholder="PCS" /></Field>
                    <Field label="Inventory item UUID" hint="Optional. Must belong to this selected factory and use the same unit.">
                      <input className={INPUT} value={line.inventory_item_id} onChange={(event) => updateLine(index, "inventory_item_id", event.currentTarget.value)} placeholder="UUID from inventory item detail" />
                    </Field>
                    <Field label="Unit price"><input className={INPUT} type="number" min="0" step="0.0001" value={line.unit_price} onChange={(event) => updateLine(index, "unit_price", event.currentTarget.value)} placeholder="Optional" /></Field>
                    <Field label="Line delivery date"><input className={INPUT} type="date" value={line.requested_delivery_date} onChange={(event) => updateLine(index, "requested_delivery_date", event.currentTarget.value)} /></Field>
                    <Field label="Line notes"><input className={INPUT} value={line.notes} onChange={(event) => updateLine(index, "notes", event.currentTarget.value)} maxLength={2000} /></Field>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
              <button type="button" className={SECONDARY} onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
              <button type="submit" className={PRIMARY} disabled={busy}>{busy ? "Creating..." : "Create draft order"}</button>
            </div>
          </form>
        </Panel>
      ) : null}

      {canShowWorkspace ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric label="Orders on page" value={summary.total_loaded} hint={"Page " + pagination.page + " of " + pagination.total_pages + " · " + pagination.total + " server matches"} />
            <Metric label="Draft" value={summary.draft} hint="Awaiting confirmation" />
            <Metric label="Confirmed" value={summary.confirmed} hint="Materials may be reserved" />
            <Metric label="In production" value={summary.in_progress} hint="Production reporting enabled" />
            <Metric label="Overdue" value={summary.overdue} hint="Open orders past requested delivery date" />
          </section>

          <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1.08fr)_minmax(480px,0.92fr)]">
            <Panel title="Sales order register" subtitle="Search and status filters are server-side. The list is scoped to your authenticated tenant and selected factory."
              action={<span className="text-[10px] font-semibold text-slate-500">20 records per page</span>}>
              <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto]" onSubmit={applySearch}>
                <input className={INPUT} value={searchInput} onChange={(event) => setSearchInput(event.currentTarget.value)} maxLength={100} placeholder="Search order number, customer or reference" />
                <select className={INPUT} value={statusFilter} onChange={(event) => { setStatusFilter(event.currentTarget.value as SalesOrderStatus | "ALL"); setPage(1); setLoading(true); }}>
                  <option value="ALL">All statuses</option>
                  {STATUS_OPTIONS.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
                </select>
                <button type="submit" className={SECONDARY}>Search orders</button>
              </form>
              {loadError ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{loadError}</p> : null}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[680px] border-collapse text-left text-xs">
                  <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="px-2 py-3 font-bold">Order / customer</th><th className="px-2 py-3 font-bold">Status</th><th className="px-2 py-3 font-bold">Order date</th><th className="px-2 py-3 font-bold">Delivery promise</th><th className="px-2 py-3 font-bold">Currency</th>
                  </tr></thead>
                  <tbody>
                    {loading ? <tr><td colSpan={5} className="px-2 py-10 text-center text-slate-500">Loading sales orders...</td></tr>
                      : orders.length === 0 ? <tr><td colSpan={5} className="px-2 py-10"><Empty>No sales orders match the current filters.</Empty></td></tr>
                        : orders.map((item) => {
                          const id = textOf(item.id, "");
                          const active = selectedId === id;
                          return (
                            <tr key={id} className={"cursor-pointer border-b border-slate-100 transition hover:bg-slate-50 " + (active ? "bg-blue-50/70" : "")} onClick={() => { setSelectedId(id); setSelectedOrder(null); setDetailLoading(true); setDetailError(""); setNotice(null); }}>
                              <td className="px-2 py-3">
                                <p className="font-bold text-slate-900">{textOf(item.order_number)}</p>
                                <p className="mt-1 text-[10px] text-slate-500">{textOf(item.customer_name, "Customer not named")} · {textOf(item.customer_reference, "No reference")}</p>
                              </td>
                              <td className="px-2 py-3"><StatusPill status={textOf(item.status, "UNKNOWN")} /></td>
                              <td className="px-2 py-3 tabular-nums text-slate-600">{textOf(item.order_date)}</td>
                              <td className="px-2 py-3 tabular-nums text-slate-600">{textOf(item.requested_delivery_date, "Not scheduled")}</td>
                              <td className="px-2 py-3 font-semibold text-slate-700">{textOf(item.currency, "BDT")}</td>
                            </tr>
                          );
                        })}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <p className="text-[11px] text-slate-500">Showing {orders.length} of {pagination.total} matching records.</p>
                <div className="flex items-center gap-2">
                  <button type="button" className={SECONDARY} onClick={() => { setPage((current) => Math.max(1, current - 1)); setLoading(true); }} disabled={page <= 1 || loading}>Previous</button>
                  <span className="min-w-16 text-center text-[11px] font-semibold tabular-nums text-slate-600">{pagination.total_pages === 0 ? "0 / 0" : page + " / " + pagination.total_pages}</span>
                  <button type="button" className={SECONDARY} onClick={() => { setPage((current) => Math.min(pagination.total_pages, current + 1)); setLoading(true); }} disabled={page >= pagination.total_pages || loading}>Next</button>
                </div>
              </div>
            </Panel>

            <Panel title="Order detail & execution" subtitle="Select an order to inspect its line commitments, lifecycle state and production evidence."
              action={selectedOrder ? <StatusPill status={selectedStatus} /> : undefined}>
              {!selectedId ? <Empty>Select a sales order from the register.</Empty>
                : detailLoading && !selectedOrder ? <Empty>Loading selected order...</Empty>
                  : detailError ? <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{detailError}</div>
                    : !selectedOrder ? <Empty>Order detail is not available.</Empty>
                      : (
                        <div className="space-y-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Sales order</p><h3 className="mt-1 text-xl font-bold text-slate-950">{textOf(selectedOrder.order_number)}</h3><p className="mt-1 text-xs text-slate-500">{textOf(selectedOrder.customer_name, "Customer not named")} · {textOf(selectedOrder.customer_reference, "No customer reference")}</p></div>
                            <div className="text-right"><p className="text-[10px] uppercase tracking-wide text-slate-500">Aggregate version</p><p className="mt-1 text-lg font-bold tabular-nums text-slate-900">{textOf(selectedOrder.version)}</p></div>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-500">Order date</p><p className="mt-1 text-xs font-semibold text-slate-800">{textOf(selectedOrder.order_date)}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-500">Requested delivery</p><p className="mt-1 text-xs font-semibold text-slate-800">{textOf(selectedOrder.requested_delivery_date, "Not scheduled")}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-500">Currency</p><p className="mt-1 text-xs font-semibold text-slate-800">{selectedCurrency}</p></div>
                            <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-500">Last updated</p><p className="mt-1 text-xs font-semibold text-slate-800">{dateTime(selectedOrder.updated_at)}</p></div>
                          </div>

                          <div>
                            <div className="mb-2 flex items-center justify-between gap-2"><h4 className="text-xs font-bold text-slate-900">Order lines</h4><span className="text-[10px] text-slate-500">{lines.length} line(s)</span></div>
                            <div className="overflow-x-auto rounded-xl border border-slate-200">
                              <table className="w-full min-w-[520px] text-left text-[11px]">
                                <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Product</th><th className="px-3 py-2">Ordered</th><th className="px-3 py-2">Unit price</th><th className="px-3 py-2">Inventory binding</th></tr></thead>
                                <tbody>{lines.map((line) => <tr key={textOf(line.id)} className="border-t border-slate-100"><td className="px-3 py-2 tabular-nums">{textOf(line.line_number)}</td><td className="px-3 py-2"><p className="font-semibold text-slate-800">{textOf(line.product_name)}</p><p className="text-[10px] text-slate-500">{textOf(line.product_code)}</p></td><td className="px-3 py-2 font-semibold tabular-nums">{quantity(line.quantity, textOf(line.unit, ""))}</td><td className="px-3 py-2 tabular-nums">{amount(line.unit_price, selectedCurrency)}</td><td className="px-3 py-2 font-mono text-[9px] text-slate-500">{textOf(line.inventory_item_id, "Not linked")}</td></tr>)}</tbody>
                              </table>
                            </div>
                          </div>

                          {canWrite && allowedTransitions.length > 0 ? (
                            <div className="rounded-xl border border-slate-200 p-3">
                              <p className="text-xs font-bold text-slate-900">Lifecycle actions</p>
                              <p className="mt-1 text-[11px] leading-5 text-slate-500">Each action submits the detail version as an optimistic concurrency guard. Inventory reservations, material consumption and completion checks run on the server.</p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {allowedTransitions.map((target) => <button key={target} type="button" className={target === "CANCELLED" ? DANGER : PRIMARY} onClick={() => setTransitionTarget(target)}>{target === "IN_PROGRESS" ? "Start production" : target === "COMPLETED" ? "Complete order" : target === "CONFIRMED" ? "Confirm order" : "Cancel order"}</button>)}
                              </div>
                            </div>
                          ) : null}

                          {selectedStatus === "IN_PROGRESS" && canWrite ? (
                            <div className="space-y-4">
                              <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold text-blue-950">Production output report</h4><span className="text-[10px] font-semibold text-blue-800">Cumulative yield: {reportYield === "—" ? "Not reported" : reportYield + "%"}</span></div>
                                <p className="mt-1 text-[11px] leading-5 text-blue-900/80">Accepted good output posts a finished-good receipt and traceability reference. Scrap quantity requires a reason and is not stocked.</p>
                                <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={submitProductionReport}>
                                  <Field label="Order line"><select className={INPUT} value={productionDraft.order_line_id} onChange={(event) => setProductionDraft((current) => ({ ...current, order_line_id: event.currentTarget.value }))} required><option value="">Choose order line</option>{lines.map((line) => <option key={textOf(line.id)} value={textOf(line.id)}>{textOf(line.product_code)} · {textOf(line.product_name)}</option>)}</select></Field>
                                  <Field label="Good quantity"><input className={INPUT} required type="number" min="0" step="0.0001" value={productionDraft.good_quantity} onChange={(event) => setProductionDraft((current) => ({ ...current, good_quantity: event.currentTarget.value }))} /></Field>
                                  <Field label="Scrap quantity"><input className={INPUT} required type="number" min="0" step="0.0001" value={productionDraft.scrap_quantity} onChange={(event) => setProductionDraft((current) => ({ ...current, scrap_quantity: event.currentTarget.value }))} /></Field>
                                  <Field label="Scrap reason" hint="Required when scrap quantity is greater than zero."><input className={INPUT} value={productionDraft.scrap_reason} onChange={(event) => setProductionDraft((current) => ({ ...current, scrap_reason: event.currentTarget.value }))} maxLength={500} /></Field>
                                  <div className="sm:col-span-2"><Field label="Report notes"><textarea className={AREA} value={productionDraft.notes} onChange={(event) => setProductionDraft((current) => ({ ...current, notes: event.currentTarget.value }))} maxLength={2000} /></Field></div>
                                  <div className="sm:col-span-2"><button type="submit" className={PRIMARY} disabled={busy || !canWrite}>{busy ? "Posting..." : "Post production report"}</button></div>
                                </form>
                                <p className="mt-3 text-[10px] leading-4 text-blue-900/70">This direct order reporting endpoint rejects lines with production work-order history. For routed work-order lines, report output from the final routing operation instead.</p>
                              </div>

                              <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                                <h4 className="text-xs font-bold text-amber-950">Issued material disposition</h4>
                                <p className="mt-1 text-[11px] leading-5 text-amber-900/80">Record unused issued quantities back to stock or record scrap. Enter the reservation UUID from the inventory reservation evidence.</p>
                                <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={submitDisposition}>
                                  <Field label="Reservation UUID"><input className={INPUT} value={dispositionDraft.reservation_id} onChange={(event) => setDispositionDraft((current) => ({ ...current, reservation_id: event.currentTarget.value }))} required placeholder="Reservation ID" /></Field>
                                  <Field label="Disposition type"><select className={INPUT} value={dispositionDraft.disposition_type} onChange={(event) => setDispositionDraft((current) => ({ ...current, disposition_type: event.currentTarget.value as DispositionDraft["disposition_type"] }))}><option value="RETURN_TO_STOCK">Return to stock</option><option value="SCRAPPED">Scrapped</option></select></Field>
                                  <Field label="Quantity"><input className={INPUT} value={dispositionDraft.quantity} onChange={(event) => setDispositionDraft((current) => ({ ...current, quantity: event.currentTarget.value }))} required type="number" min="0.0001" step="0.0001" /></Field>
                                  <Field label="Notes"><input className={INPUT} value={dispositionDraft.notes} onChange={(event) => setDispositionDraft((current) => ({ ...current, notes: event.currentTarget.value }))} maxLength={1000} /></Field>
                                  <div className="sm:col-span-2"><button type="submit" className={SECONDARY} disabled={busy || !canWrite}>{busy ? "Recording..." : "Record material disposition"}</button></div>
                                </form>
                              </div>
                            </div>
                          ) : null}

                          <div>
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-bold text-slate-900">Production evidence</h4><span className="text-[10px] text-slate-500">{reports.length} report(s) loaded · {quantity(totalReportGood)} good · {quantity(totalReportScrap)} scrap</span></div>
                            {reports.length === 0 ? <Empty>No order-linked production reports were returned for this sales order.</Empty> : (
                              <div className="overflow-x-auto rounded-xl border border-slate-200">
                                <table className="w-full min-w-[580px] text-left text-[11px]">
                                  <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="px-3 py-2">Reported</th><th className="px-3 py-2">Good</th><th className="px-3 py-2">Scrap</th><th className="px-3 py-2">Yield</th><th className="px-3 py-2">Finished-good movement</th></tr></thead>
                                  <tbody>{reports.map((report) => <tr key={textOf(report.id)} className="border-t border-slate-100"><td className="px-3 py-2">{dateTime(report.created_at)}</td><td className="px-3 py-2 font-semibold text-emerald-800 tabular-nums">{quantity(report.good_quantity)}</td><td className="px-3 py-2 font-semibold text-rose-800 tabular-nums">{quantity(report.scrap_quantity)}</td><td className="px-3 py-2 tabular-nums">{textOf(report.report_yield_percent ?? report.yield_percent, "—")}%</td><td className="px-3 py-2 font-mono text-[9px] text-slate-500">{textOf(report.finished_good_movement_id, "Not linked")}</td></tr>)}</tbody>
                                </table>
                              </div>
                            )}
                          </div>
                          <div className="border-t border-slate-100 pt-3 text-[10px] leading-5 text-slate-500">
                            Created {dateTime(selectedOrder.created_at)} · Updated {dateTime(selectedOrder.updated_at)} · Order ID <span className="font-mono">{textOf(selectedOrder.id)}</span>
                          </div>
                        </div>
                      )}
            </Panel>
          </div>
        </>
      ) : null}

      {transitionTarget && selectedOrder ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="order-transition-title">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Confirm lifecycle change</p>
            <h2 id="order-transition-title" className="mt-2 text-lg font-bold text-slate-950">{textOf(selectedOrder.order_number)} → {transitionTarget.replaceAll("_", " ")}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Current status is {selectedStatus.replaceAll("_", " ")} at version {textOf(selectedOrder.version)}.
              {transitionTarget === "CONFIRMED" ? " The API will attempt factory-scoped inventory reservations for linked order lines." : ""}
              {transitionTarget === "IN_PROGRESS" ? " The API will apply the order material-consumption lifecycle." : ""}
              {transitionTarget === "COMPLETED" ? " The API will block completion if production-linked lines have remaining output targets." : ""}
              {transitionTarget === "CANCELLED" ? " Cancellation can be blocked until all consumed material has an explicit return-to-stock or scrap disposition." : ""}
            </p>
            <form className="mt-5 flex justify-end gap-2" onSubmit={submitTransition}>
              <button type="button" className={SECONDARY} onClick={() => setTransitionTarget("")} disabled={busy}>Keep current status</button>
              <button type="submit" className={transitionTarget === "CANCELLED" ? DANGER : PRIMARY} disabled={busy}>{busy ? "Applying..." : "Confirm transition"}</button>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}
