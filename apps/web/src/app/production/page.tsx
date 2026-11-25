"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildOperationEventPayload,
  buildProductionOutputPayload,
  buildWorkOrderListQuery,
  buildWorkOrderPayload,
  buildWorkOrderTransitionPayload,
  filterWorkOrders,
  normalizeProductionRows,
  summarizeProduction,
} from "@/lib/production-workbench.mjs";

type Row = Record<string, unknown>;
type WorkOrderStatus = "DRAFT" | "RELEASED" | "IN_PROGRESS" | "ON_HOLD" | "COMPLETED" | "CANCELLED";
type OperationStatus = "PLANNED" | "READY" | "IN_PROGRESS" | "PAUSED" | "ON_HOLD" | "COMPLETED" | "SKIPPED";
type WorkOrder = Row & {
  id: string; work_order_number: string; status: WorkOrderStatus;
  source_order_id: string; source_order_line_id: string; target_quantity: string;
  planned_start_date: string; due_date: string | null; priority: number;
  row_version: number; notes: string | null; product_code?: string; product_name?: string;
};
type Operation = Row & {
  id: string; step_number: number; operation_code: string; operation_name: string;
  work_centre_id: string; work_centre_code: string; work_centre_name: string;
  setup_minutes: string; run_minutes_per_unit: string; queue_minutes: string; transfer_minutes: string;
  required_skill: string | null; instructions: string | null; is_quality_gate: boolean;
  status: OperationStatus; active_started_at: string | null; downtime_started_at: string | null;
  actual_run_minutes: string; downtime_minutes: string; wip_quantity: string;
  row_version: number; reported_good_quantity: string; reported_scrap_quantity: string;
  reported_wip_quantity: string; reported_rework_quantity: string;
  finished_good_stock_posted_quantity: string;
};
type WorkOrderDetail = WorkOrder & {
  materials?: Array<Row & { reservations?: Array<Row> }>;
  operations?: Operation[];
  events?: Array<Row>;
  good_quantity?: string; scrap_quantity?: string; processed_quantity?: string;
  yield_percentage?: string; finished_good_stock_posted_quantity?: string;
  output_posting_count?: number;
};
type MaterialShortage = Row & {
  work_order_id: string; work_order_number: string; work_order_status: WorkOrderStatus;
  component_sku: string; component_name: string; unit: string;
  required_quantity: string; allocated_quantity: string; consumed_quantity: string;
  unfulfilled_quantity: string; eligible_on_hand_pool_quantity: string;
  projected_on_hand_quantity: string; approved_po_open_pool_quantity: string;
  projected_incoming_quantity: string; projected_shortage_quantity: string;
  shortage_by_due_date_quantity: string | null; projected_material_ready_date: string | null;
  material_ready_basis: string; traceability_required: boolean;
};
type SourceOrder = {
  id: string; order_number: string; customer_name: string | null; status: string;
  requested_delivery_date: string | null; currency: string;
};
type SourceOrderLine = {
  id: string; line_number: number; product_code: string; product_name: string;
  inventory_item_id: string | null; quantity: string; unit: string;
  requested_delivery_date: string | null; notes: string | null;
};
type Tab = "work-orders" | "materials";
type WorkOrderAction = "RELEASE" | "HOLD" | "RESUME" | "COMPLETE" | "CANCEL";
type OperationCommand =
  | "START" | "PAUSE" | "RESUME" | "HOLD" | "COMPLETE" | "SKIP"
  | "DOWNTIME_START" | "DOWNTIME_END" | "WIP_REPORTED" | "WIP_TRANSFERRED" | "REWORK_REPORTED";

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function textOf(value: unknown, fallback = "—") {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function numberOf(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
function quantity(value: unknown, unit = "") {
  return numberOf(value).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 }) + (unit ? " " + unit : "");
}
function dateLabel(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
function dateTime(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The production request could not be completed.";
}
function statusClasses(value: string) {
  const status = value.toUpperCase();
  if (["COMPLETED", "READY", "RELEASED"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["IN_PROGRESS"].includes(status)) return "border-blue-200 bg-blue-50 text-blue-800";
  if (["ON_HOLD", "PAUSED"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-900";
  if (["CANCELLED", "SKIPPED"].includes(status)) return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}
function StatusPill({ value }: { value: string }) {
  return <span className={"inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " + statusClasses(value)}>{value.replaceAll("_", " ")}</span>;
}
function Metric({ label, value, hint, tone = "slate" }: {
  label: string; value: string | number; hint: string; tone?: "slate" | "blue" | "amber" | "emerald";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return (
    <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</p>
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
function Panel({ title, subtitle, children, action }: {
  title: string; subtitle?: string; children: ReactNode; action?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div><h2 className="text-sm font-bold text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">{subtitle}</p> : null}</div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}
const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-9 items-center justify-center rounded-lg px-3 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const warningButton = buttonClass + " border border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

const WORK_ORDER_ACTIONS: Array<{ command: WorkOrderAction; label: string; route: string }> = [
  { command: "RELEASE", label: "Release", route: "release" },
  { command: "HOLD", label: "Hold", route: "hold" },
  { command: "RESUME", label: "Resume", route: "resume" },
  { command: "COMPLETE", label: "Complete", route: "complete" },
  { command: "CANCEL", label: "Cancel", route: "cancel" },
];

function initialWorkOrderDraft(): Record<string, string> {
  return {
    order_line_id: "", target_quantity: "", planned_start_date: localDate(),
    due_date: "", priority: "3", notes: "",
  };
}
function initialOperationDraft(command: OperationCommand): Record<string, string> {
  return { command, quantity: "", target_operation_id: "", reason: "" };
}
function operationCommands(operation: Operation, workOrder: WorkOrderDetail): OperationCommand[] {
  const commands: OperationCommand[] = [];
  if (operation.status === "READY" && ["RELEASED", "IN_PROGRESS"].includes(workOrder.status)) commands.push("START");
  if (["IN_PROGRESS", "PAUSED", "READY"].includes(operation.status)) commands.push("HOLD");
  if (operation.status === "IN_PROGRESS") {
    commands.push("PAUSE", "COMPLETE");
    if (operation.active_started_at && !operation.downtime_started_at) commands.push("DOWNTIME_START");
    if (operation.downtime_started_at) commands.push("DOWNTIME_END");
  }
  if (operation.status === "PAUSED") commands.push("RESUME");
  if (operation.status === "ON_HOLD" && workOrder.status === "IN_PROGRESS") commands.push("RESUME");
  if (["PLANNED", "READY"].includes(operation.status) && !operation.is_quality_gate) commands.push("SKIP");
  if (["IN_PROGRESS", "PAUSED"].includes(operation.status)) {
    commands.push("WIP_REPORTED", "REWORK_REPORTED");
    if ((workOrder.operations ?? []).some((target) => target.step_number > operation.step_number && ["READY", "PLANNED"].includes(target.status))) {
      commands.push("WIP_TRANSFERRED");
    }
  }
  return [...new Set(commands)];
}
function operationActionLabel(command: OperationCommand) {
  const labels: Record<OperationCommand, string> = {
    START: "Start", PAUSE: "Pause", RESUME: "Resume", HOLD: "Hold",
    COMPLETE: "Complete", SKIP: "Skip", DOWNTIME_START: "Start downtime",
    DOWNTIME_END: "End downtime", WIP_REPORTED: "Report WIP",
    WIP_TRANSFERRED: "Transfer WIP", REWORK_REPORTED: "Report rework",
  };
  return labels[command];
}
function initialOutputDraft() {
  return { good_quantity: "", scrap_quantity: "0", scrap_reason: "", finished_good_serial_codes: "", notes: "" };
}

export default function ProductionShopFloorWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const connected = status === "connected" && Boolean(snapshot) && Boolean(activeFactoryId);
  const canRead = hasPermission("production.workorders.read");
  const canCreate = hasPermission("production.workorders.write");
  const canRelease = hasPermission("production.workorders.release");
  const canOperate = hasPermission("production.operations.operate");
  const canReportOutput = hasPermission("production.output.report");
  const canReadOrders = hasPermission("orders.read");

  const [tab, setTab] = useState<Tab>("work-orders");
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [materialRadar, setMaterialRadar] = useState<MaterialShortage[]>([]);
  const [materialAsOf, setMaterialAsOf] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [materialLoading, setMaterialLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const [createOpen, setCreateOpen] = useState(false);
  const [workOrderDraft, setWorkOrderDraft] = useState(initialWorkOrderDraft);
  const [sourceOrders, setSourceOrders] = useState<SourceOrder[]>([]);
  const [sourceOrderId, setSourceOrderId] = useState("");
  const [sourceOrderDetail, setSourceOrderDetail] = useState<{ order: SourceOrder; lines: SourceOrderLine[] } | null>(null);
  const [sourceOrderLoading, setSourceOrderLoading] = useState(false);

  const [transitionCommand, setTransitionCommand] = useState<WorkOrderAction | "">("");
  const [transitionReason, setTransitionReason] = useState("");
  const [operationEditor, setOperationEditor] = useState<{ operationId: string; command: OperationCommand } | null>(null);
  const [operationDraft, setOperationDraft] = useState<Record<string, string>>(initialOperationDraft("START"));
  const [outputEditorId, setOutputEditorId] = useState("");
  const [outputDraft, setOutputDraft] = useState(initialOutputDraft);

  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const visibleWorkOrders = useMemo(
    () => filterWorkOrders(workOrders, { search, status: statusFilter }) as WorkOrder[],
    [workOrders, search, statusFilter],
  );
  const summary = useMemo(() => summarizeProduction(
    workOrders as Array<Record<string, unknown>>,
    materialRadar as Array<Record<string, unknown>>,
  ), [workOrders, materialRadar]);
  const operations = detail?.operations ?? [];
  const finalOperation = operations.length
    ? [...operations].sort((a, b) => a.step_number - b.step_number)[operations.length - 1] ?? null
    : null;
  const processedQuantity = numberOf(detail?.processed_quantity ?? (numberOf(detail?.good_quantity) + numberOf(detail?.scrap_quantity)));
  const outputRemaining = Math.max(0, numberOf(detail?.target_quantity) - processedQuantity);
  const workOrderMaterials = detail?.materials ?? [];
  const workOrderEvents = detail?.events ?? [];
  const hasLiveFactory = connected && activeFactoryId.length > 0;

  const loadWorkOrders = useCallback(async () => {
    if (!hasLiveFactory || !canRead) {
      setWorkOrders([]);
      setSelectedId("");
      setDetail(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const query = buildWorkOrderListQuery({ limit: 100, status: statusFilter });
      const result = await request("/production/work-orders" + query);
      const next = normalizeProductionRows(result) as WorkOrder[];
      setWorkOrders(next);
      setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id ?? "");
    } catch (cause) {
      setError(messageOf(cause));
      setWorkOrders([]);
    } finally {
      setLoading(false);
    }
  }, [hasLiveFactory, canRead, request, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkOrders(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkOrders]);

  const loadDetail = useCallback(async (id: string) => {
    if (!id || !hasLiveFactory || !canRead) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setError("");
    try {
      const result = await request("/production/work-orders/" + encodeURIComponent(id));
      setDetail(record(result) as WorkOrderDetail);
    } catch (cause) {
      setDetail(null);
      setError(messageOf(cause));
    } finally {
      setDetailLoading(false);
    }
  }, [hasLiveFactory, canRead, request]);

  useEffect(() => {
    if (!selectedId || tab !== "work-orders") return;
    const timer = window.setTimeout(() => { void loadDetail(selectedId); }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedId, tab, loadDetail]);

  const loadMaterialRadar = useCallback(async () => {
    if (!hasLiveFactory || !canRead) return;
    setMaterialLoading(true);
    setError("");
    try {
      const result = record(await request("/production/work-orders/material-shortage-radar?limit=100"));
      setMaterialRadar(normalizeProductionRows(result, "items") as MaterialShortage[]);
      setMaterialAsOf(textOf(result.as_of_date, ""));
      setNotice("Material readiness radar refreshed using shared stock and approved purchase-order supply.");
    } catch (cause) {
      setMaterialRadar([]);
      setError(messageOf(cause));
    } finally {
      setMaterialLoading(false);
    }
  }, [hasLiveFactory, canRead, request]);

  useEffect(() => {
    if (tab !== "materials") return;
    const timer = window.setTimeout(() => { void loadMaterialRadar(); }, 0);
    return () => window.clearTimeout(timer);
  }, [tab, loadMaterialRadar]);

  async function refreshWorkspace() {
    await loadWorkOrders();
    if (selectedId) await loadDetail(selectedId);
    if (tab === "materials") await loadMaterialRadar();
  }

  async function openCreateWorkOrder() {
    if (!canCreate || !canReadOrders) return;
    setError("");
    setNotice("");
    setCreateOpen(true);
    setWorkOrderDraft(initialWorkOrderDraft());
    setSourceOrderId("");
    setSourceOrderDetail(null);
    setBusy(true);
    try {
      const response = await request("/orders?page=1&limit=100");
      const rows = normalizeProductionRows(response) as SourceOrder[];
      setSourceOrders(rows.filter((order) => ["DRAFT", "CONFIRMED", "IN_PROGRESS"].includes(order.status)));
    } catch (cause) {
      setError("Could not load source sales orders: " + messageOf(cause));
      setSourceOrders([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!sourceOrderId || !createOpen || !canReadOrders) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        setSourceOrderLoading(true);
        setSourceOrderDetail(null);
        try {
          const result = record(await request("/orders/" + encodeURIComponent(sourceOrderId)));
          if (live) {
            const lines = Array.isArray(result.lines) ? result.lines.map(record) as unknown as SourceOrderLine[] : [];
            setSourceOrderDetail({ order: result as unknown as SourceOrder, lines });
          }
        } catch (cause) {
          if (live) setError(messageOf(cause));
        } finally {
          if (live) setSourceOrderLoading(false);
        }
      })();
    }, 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [sourceOrderId, createOpen, canReadOrders, request]);

  function chooseSourceLine(line: SourceOrderLine) {
    setWorkOrderDraft((current) => ({
      ...current,
      order_line_id: line.id,
      target_quantity: line.quantity,
      due_date: line.requested_delivery_date ?? current.due_date,
    }));
  }

  async function submitWorkOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildWorkOrderPayload(workOrderDraft);
      const result = record(await request("/production/work-orders", {
        method: "POST",
        body: payload,
        idempotencyKey: "production-work-order-" + window.crypto.randomUUID(),
      }));
      const newId = textOf(result.id, "");
      setCreateOpen(false);
      setNotice("Draft work order " + textOf(result.work_order_number, newId) + " created. Pinned BOM requirements and routing operations were generated by the API.");
      await loadWorkOrders();
      if (newId) {
        setSelectedId(newId);
        await loadDetail(newId);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function transitionWorkOrder(command: WorkOrderAction) {
    if (!detail) return;
    const permitted = command === "HOLD" || command === "RESUME"
      ? canOperate : canRelease;
    if (!permitted) return;
    if (command === "CANCEL" && !window.confirm("Cancel " + detail.work_order_number + "? This is a terminal work-order state.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const route = WORK_ORDER_ACTIONS.find((item) => item.command === command)?.route;
      if (!route) throw new Error("Unsupported work-order transition.");
      const payload = buildWorkOrderTransitionPayload(command, detail.row_version, transitionReason);
      await request("/production/work-orders/" + encodeURIComponent(detail.id) + "/" + route, {
        method: "POST",
        body: payload,
        idempotencyKey: "production-work-order-" + command.toLowerCase() + "-" + window.crypto.randomUUID(),
      });
      setTransitionCommand("");
      setTransitionReason("");
      setNotice("Work-order " + command.toLowerCase() + " command accepted. Material reservations and lifecycle events were committed by the API.");
      await loadWorkOrders();
      await loadDetail(detail.id);
    } catch (cause) {
      setError(messageOf(cause));
      await loadDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  function openOperationEvent(operation: Operation, command: OperationCommand) {
    if (!canOperate) return;
    setOperationEditor({ operationId: operation.id, command });
    setOperationDraft(initialOperationDraft(command));
    setError("");
    setNotice("");
  }

  async function submitOperationEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !operationEditor) return;
    const operation = operations.find((item) => item.id === operationEditor.operationId);
    if (!operation) {
      setError("The selected operation is no longer in the loaded work-order detail.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildOperationEventPayload({
        ...operationDraft,
        command: operationEditor.command,
        operation_id: operation.id,
        expected_work_order_version: detail.row_version,
        expected_operation_version: operation.row_version,
      });
      await request("/production/work-orders/" + encodeURIComponent(detail.id)
        + "/operations/" + encodeURIComponent(operation.id) + "/events", {
        method: "POST",
        body: payload,
        idempotencyKey: "production-operation-" + operationEditor.command.toLowerCase() + "-" + window.crypto.randomUUID(),
      });
      setOperationEditor(null);
      setNotice("Operation event " + operationEditor.command + " recorded with expected work-order and operation versions.");
      await loadWorkOrders();
      await loadDetail(detail.id);
    } catch (cause) {
      setError(messageOf(cause));
      await loadDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  function openOutputReport(operation: Operation) {
    setOutputEditorId(operation.id);
    setOutputDraft(initialOutputDraft());
    setError("");
    setNotice("");
  }

  async function submitOutputReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !outputEditorId) return;
    const operation = operations.find((item) => item.id === outputEditorId);
    if (!operation) {
      setError("The final routing operation is no longer in the loaded detail.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildProductionOutputPayload({
        ...outputDraft,
        operation_id: operation.id,
        expected_work_order_version: detail.row_version,
        expected_operation_version: operation.row_version,
      });
      const result = record(await request("/production/work-orders/" + encodeURIComponent(detail.id) + "/output-reports", {
        method: "POST",
        body: payload,
        idempotencyKey: "production-output-" + window.crypto.randomUUID(),
      }));
      setOutputEditorId("");
      setNotice("Output report and finished-good posting committed. Finished-good movement "
        + textOf(result.finished_good_movement_id, "recorded by API")
        + " · cumulative yield " + textOf(result.output_yield_percentage, "—") + "%.");
      await loadWorkOrders();
      await loadDetail(detail.id);
    } catch (cause) {
      setError(messageOf(cause));
      await loadDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  const outputReady = Boolean(finalOperation
    && finalOperation.status === "IN_PROGRESS"
    && finalOperation.active_started_at
    && !finalOperation.downtime_started_at
    && detail?.status === "IN_PROGRESS");
  const allowedWorkOrderActions = detail ? WORK_ORDER_ACTIONS.filter(({ command }) => {
    if (command === "RELEASE") return detail.status === "DRAFT" && canRelease;
    if (command === "HOLD") return ["RELEASED", "IN_PROGRESS"].includes(detail.status) && canOperate;
    if (command === "RESUME") return detail.status === "ON_HOLD" && canOperate;
    if (command === "COMPLETE") return detail.status === "IN_PROGRESS" && canRelease;
    return ["DRAFT", "RELEASED", "IN_PROGRESS", "ON_HOLD"].includes(detail.status) && canRelease;
  }) : [];

  if (status !== "connected" || !snapshot) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Production · shop floor</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">Connect a FactoryOS session</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Work orders, routing operations, WIP and output posting are factory-scoped. Connect a session to use the production workbench.</p>
          <Link href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white">Open session</Link>
        </section>
      </main>
    );
  }
  if (!activeFactoryId) {
    return <main className="mx-auto max-w-5xl px-4 py-12"><section className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-lg font-bold text-slate-950">Select an active factory</h1><p className="mt-2 text-sm text-slate-700">The shop-floor workbench uses work orders and material reservations within the selected active factory.</p></section></main>;
  }

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="overflow-hidden rounded-3xl bg-slate-950 p-6 text-white shadow-sm sm:p-8">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">Manufacturing execution · routing · WIP</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Production & Shop Floor Operations</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Turn eligible sales-order lines into pinned work orders, release material reservations, execute routing operations, record downtime and WIP, and post good/scrap output at the final operation.</p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-xs">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Selected factory</p>
            <p className="mt-1 font-semibold text-white">{activeFactory?.name ?? "Active factory"}</p>
            <p className="mt-0.5 text-slate-400">{snapshot.tenant.name}</p>
          </div>
        </div>
      </header>

      {error ? <div role="alert" className="flex flex-col justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 sm:flex-row sm:items-center"><p className="text-sm text-rose-800">{error}</p><button type="button" onClick={() => setError("")} className={secondaryButton}>Dismiss</button></div> : null}
      {notice ? <div role="status" className="flex flex-col justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 sm:flex-row sm:items-center"><p className="text-sm text-emerald-900">{notice}</p><button type="button" onClick={() => setNotice("")} className={secondaryButton}>Dismiss</button></div> : null}

      {!canRead ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="text-base font-bold text-slate-950">Production work-order access required</h2>
          <p className="mt-2 text-sm text-amber-900">Your current IAM permission snapshot does not include <code>production.workorders.read</code>.</p>
        </section>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric label="Work orders" value={summary.workOrderCount} hint="Latest 100 in this factory" tone="blue" />
            <Metric label="In progress" value={summary.inProgressCount} hint={summary.releasedCount + " released · " + summary.onHoldCount + " on hold"} tone="emerald" />
            <Metric label="Draft / completed" value={summary.draftCount + " / " + summary.completedCount} hint="Work-order lifecycle snapshot" />
            <Metric label="Material requirements" value={summary.materialRequirementCount} hint="Priority-allocated BOM demand" />
            <Metric label="Projected shortage lines" value={summary.shortageRequirementCount} hint="Shortage against current stock and dated approved PO supply" tone="amber" />
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Production views">
              <button type="button" role="tab" aria-selected={tab === "work-orders"} onClick={() => setTab("work-orders")} className={"min-h-10 rounded-xl px-4 text-xs font-semibold " + (tab === "work-orders" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>Work orders & operations</button>
              <button type="button" role="tab" aria-selected={tab === "materials"} onClick={() => setTab("materials")} className={"min-h-10 rounded-xl px-4 text-xs font-semibold " + (tab === "materials" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>Material shortage radar</button>
              <div className="ml-auto flex items-center gap-2 px-2">
                {loading ? <span className="text-[10px] text-slate-500">Refreshing…</span> : null}
                <button type="button" className={secondaryButton} disabled={loading || materialLoading} onClick={() => void refreshWorkspace()}>Refresh</button>
              </div>
            </div>
          </section>

          {tab === "work-orders" ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
              <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div><h2 className="text-base font-bold text-slate-950">Work-order register</h2><p className="mt-1 text-xs text-slate-500">Pinned product revision, BOM and routing snapshots</p></div>
                  <button type="button" onClick={() => void openCreateWorkOrder()} disabled={!canCreate || !canReadOrders || busy} className={primaryButton}>Create work order</button>
                </div>
                {!canReadOrders ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[11px] text-amber-900">Source order selection requires <code>orders.read</code>.</p> : null}
                <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search work order or product…" className={inputClass} aria-label="Search work orders" />
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={inputClass} aria-label="Filter work-order status">
                    <option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="RELEASED">Released</option><option value="IN_PROGRESS">In progress</option><option value="ON_HOLD">On hold</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option>
                  </select>
                </div>
                <div className="mt-4 space-y-2">
                  {visibleWorkOrders.map((workOrder) => (
                    <button key={workOrder.id} type="button" onClick={() => setSelectedId(workOrder.id)} className={"w-full rounded-xl border p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/30 " + (selectedId === workOrder.id ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white")}>
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-950">{workOrder.work_order_number}</span><StatusPill value={workOrder.status} /></div>
                      <p className="mt-1 text-[11px] text-slate-600">{textOf(workOrder.product_code, "Product")} · {textOf(workOrder.product_name, "Pinned product revision")}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500"><span>Target {quantity(workOrder.target_quantity)}</span><span>Due {dateLabel(workOrder.due_date)}</span><span>Priority P{workOrder.priority}</span><span>v{workOrder.row_version}</span></div>
                    </button>
                  ))}
                  {!visibleWorkOrders.length ? <p className="rounded-xl border border-dashed border-slate-300 p-7 text-center text-xs text-slate-500">{loading ? "Loading work orders…" : "No work orders match this filter."}</p> : null}
                </div>
                <p className="mt-3 text-[10px] leading-4 text-slate-500">Latest 100 work orders are loaded by the API. Select a row to see materials, routing and event evidence.</p>
              </div>

              <div className="min-w-0 space-y-5">
                {!detail || detail.id !== selectedId ? (
                  <section className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500 shadow-sm">{detailLoading ? "Loading work-order detail…" : "Select a work order to open the shop-floor execution view."}</section>
                ) : (
                  <>
                    <Panel title="Work-order execution" subtitle="Expected row versions protect transitions and operation events from stale writes." action={<StatusPill value={detail.status} />}>
                      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                        <div className="min-w-0">
                          <h2 className="text-lg font-bold text-slate-950">{detail.work_order_number}</h2>
                          <p className="mt-1 text-xs text-slate-600">{textOf(detail.product_code, "Product")} · {textOf(detail.product_name, "Product revision pinned")}</p>
                          <p className="mt-1 text-[10px] text-slate-500">Source sales order {textOf(detail.source_order_number, detail.source_order_id.slice(0, 8))} · product revision {textOf(detail.product_version_number, textOf(detail.product_version_id).slice(0, 8))}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-xs sm:min-w-48">
                          <div><p className="text-[10px] uppercase text-slate-500">Target</p><p className="mt-1 font-bold text-slate-950">{quantity(detail.target_quantity)}</p></div>
                          <div><p className="text-[10px] uppercase text-slate-500">Version</p><p className="mt-1 font-bold text-slate-950">v{detail.row_version}</p></div>
                          <div><p className="text-[10px] uppercase text-slate-500">Planned start</p><p className="mt-1 font-semibold text-slate-800">{dateLabel(detail.planned_start_date)}</p></div>
                          <div><p className="text-[10px] uppercase text-slate-500">Due date</p><p className="mt-1 font-semibold text-slate-800">{dateLabel(detail.due_date)}</p></div>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <Metric label="Good output" value={quantity(detail.good_quantity)} hint="Persisted production reports" tone="emerald" />
                        <Metric label="Scrap output" value={quantity(detail.scrap_quantity)} hint="Requires recorded scrap rationale" tone="amber" />
                        <Metric label="Processed / target" value={quantity(processedQuantity) + " / " + quantity(detail.target_quantity)} hint={quantity(outputRemaining) + " remaining to target"} tone="blue" />
                        <Metric label="Finished stock posted" value={quantity(detail.finished_good_stock_posted_quantity)} hint={textOf(detail.output_posting_count, "0") + " output postings"} />
                      </div>
                      {detail.hold_reason ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[11px] text-amber-900">Hold reason: {String(detail.hold_reason)}</p> : null}
                      {detail.notes ? <p className="mt-3 text-xs leading-5 text-slate-600">{detail.notes}</p> : null}
                      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                        {allowedWorkOrderActions.map(({ command, label }) => (
                          <button key={command} type="button" disabled={busy} onClick={() => {
                            if (command === "HOLD" || command === "CANCEL") setTransitionCommand(command);
                            else void transitionWorkOrder(command);
                          }} className={command === "CANCEL" ? dangerButton : command === "HOLD" ? warningButton : command === "RELEASE" || command === "RESUME" ? primaryButton : secondaryButton}>{label}</button>
                        ))}
                        {canOperate && detail.status === "IN_PROGRESS" ? <span className="self-center text-[10px] text-slate-500">Release reserves each BOM requirement before shop-floor execution.</span> : null}
                      </div>
                      {transitionCommand ? (
                        <form className="mt-4 space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3" onSubmit={(event) => { event.preventDefault(); if (transitionCommand) void transitionWorkOrder(transitionCommand); }}>
                          <Field label={transitionCommand === "CANCEL" ? "Cancellation reason" : "Hold reason"}>
                            <textarea required rows={2} maxLength={1000} value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} className={inputClass} placeholder="Explain the production decision…" />
                          </Field>
                          <div className="flex justify-end gap-2"><button type="button" className={secondaryButton} onClick={() => { setTransitionCommand(""); setTransitionReason(""); }}>Close</button><button type="submit" className={primaryButton} disabled={busy}>{busy ? "Saving…" : "Confirm " + transitionCommand.toLowerCase()}</button></div>
                        </form>
                      ) : null}
                    </Panel>

                    <Panel title="Routing & operation control" subtitle="Start, pause, hold, complete and record operation events. Preceding steps, active work centres and single-running-operation rules are enforced by the API.">
                      <div className="space-y-3">
                        {operations.map((operation, index) => {
                          const commands = operationCommands(operation, detail);
                          const isFinal = finalOperation?.id === operation.id;
                          return (
                            <article key={operation.id} className="rounded-xl border border-slate-200 p-3 sm:p-4">
                              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-bold text-slate-500">STEP {String(operation.step_number).padStart(2, "0")}</span><h3 className="text-sm font-bold text-slate-950">{operation.operation_name}</h3><StatusPill value={operation.status} />{operation.is_quality_gate ? <span className="rounded-full bg-violet-50 px-2 py-1 text-[9px] font-bold uppercase text-violet-800">Quality gate</span> : null}{isFinal ? <span className="rounded-full bg-blue-50 px-2 py-1 text-[9px] font-bold uppercase text-blue-800">Final operation</span> : null}</div>
                                  <p className="mt-1 text-xs text-slate-600">{operation.operation_code} · {operation.work_centre_code} · {operation.work_centre_name}</p>
                                  <p className="mt-1 text-[10px] text-slate-500">Required skill: {textOf(operation.required_skill)} · Setup {quantity(operation.setup_minutes)} min · Run {quantity(operation.run_minutes_per_unit)} min/unit · Queue {quantity(operation.queue_minutes)} min · Transfer {quantity(operation.transfer_minutes)} min</p>
                                  {operation.instructions ? <p className="mt-2 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-5 text-slate-600">{operation.instructions}</p> : null}
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-[10px] sm:min-w-40">
                                  <div><p className="text-slate-500">Actual run</p><p className="font-bold tabular-nums text-slate-900">{quantity(operation.actual_run_minutes)} min</p></div>
                                  <div><p className="text-slate-500">Downtime</p><p className="font-bold tabular-nums text-slate-900">{quantity(operation.downtime_minutes)} min</p></div>
                                  <div><p className="text-slate-500">WIP</p><p className="font-bold tabular-nums text-slate-900">{quantity(operation.wip_quantity)}</p></div>
                                  <div><p className="text-slate-500">Row version</p><p className="font-bold text-slate-900">v{operation.row_version}</p></div>
                                </div>
                              </div>
                              <div className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-4">
                                <div><p className="text-[9px] uppercase tracking-wide text-slate-500">Good</p><p className="mt-1 text-xs font-bold text-emerald-800">{quantity(operation.reported_good_quantity)}</p></div>
                                <div><p className="text-[9px] uppercase tracking-wide text-slate-500">Scrap</p><p className="mt-1 text-xs font-bold text-rose-800">{quantity(operation.reported_scrap_quantity)}</p></div>
                                <div><p className="text-[9px] uppercase tracking-wide text-slate-500">Rework</p><p className="mt-1 text-xs font-bold text-amber-800">{quantity(operation.reported_rework_quantity)}</p></div>
                                <div><p className="text-[9px] uppercase tracking-wide text-slate-500">Posted stock</p><p className="mt-1 text-xs font-bold text-slate-900">{quantity(operation.finished_good_stock_posted_quantity)}</p></div>
                              </div>
                              {operation.downtime_started_at ? <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[10px] font-medium text-amber-900">Downtime interval open since {dateTime(operation.downtime_started_at)}. End downtime before pausing or completing this operation.</p> : null}
                              {canOperate && commands.length ? <div className="mt-3 flex flex-wrap gap-2">
                                {commands.map((command) => (
                                  <button key={command} type="button" disabled={busy} onClick={() => openOperationEvent(operation, command)} className={["HOLD", "SKIP", "DOWNTIME_START", "REWORK_REPORTED"].includes(command) ? warningButton : command === "COMPLETE" ? primaryButton : secondaryButton}>{operationActionLabel(command)}</button>
                                ))}
                              </div> : null}
                              {isFinal && outputReady && canReportOutput ? <div className="mt-3 border-t border-slate-100 pt-3"><button type="button" className={primaryButton} disabled={busy} onClick={() => openOutputReport(operation)}>Report good & scrap output</button><p className="mt-1 text-[10px] text-slate-500">Output is posted only while the final operation is actively running outside downtime. Finished-good stock/traceability effects come from the API.</p></div> : null}
                              {index < operations.length - 1 ? <p className="mt-2 text-[9px] text-slate-400">Next step cannot start until this operation is completed or validly skipped.</p> : null}
                            </article>
                          );
                        })}
                        {!operations.length ? <p className="rounded-lg border border-dashed border-slate-300 p-5 text-xs text-slate-500">No routing operations were returned for this work order.</p> : null}
                      </div>
                    </Panel>

                    <Panel title="Pinned BOM materials & reservations" subtitle="The release transition reserves BOM quantities. Reservation identity and inventory locations are returned by the factory-scoped API.">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[620px] text-left text-[11px]">
                          <thead><tr className="border-b border-slate-200 text-[9px] uppercase tracking-wide text-slate-500"><th className="py-2 pr-3">Component</th><th className="py-2 pr-3 text-right">Required</th><th className="py-2 pr-3">Reservation status</th><th className="py-2">Location / reference</th></tr></thead>
                          <tbody>
                            {workOrderMaterials.map((material, index) => {
                              const reservations = Array.isArray(material.reservations) ? material.reservations : [];
                              return <tr key={String(material.requirement_id ?? index)} className="border-b border-slate-100 last:border-0 align-top">
                                <td className="py-3 pr-3"><p className="font-bold text-slate-900">{textOf(material.component_sku)} · {textOf(material.component_name)}</p><p className="mt-0.5 text-[10px] text-slate-500">BOM line {textOf(material.line_number)}</p></td>
                                <td className="py-3 pr-3 text-right font-semibold tabular-nums">{quantity(material.required_quantity, textOf(material.component_unit, ""))}</td>
                                <td className="py-3 pr-3">{reservations.length ? reservations.map((reservation, itemIndex) => <div key={String(reservation.reservation_id ?? itemIndex)} className="mb-1"><StatusPill value={textOf(reservation.status, "UNKNOWN")} /><p className="mt-1 text-[10px] text-slate-500">{quantity(reservation.quantity)}</p></div>) : <span className="text-slate-500">Not reserved</span>}</td>
                                <td className="py-3 text-[10px] text-slate-600">{reservations.length ? reservations.map((reservation, itemIndex) => <p key={itemIndex} className="mb-1">{textOf(reservation.location_id)}<br />{textOf(reservation.reservation_id)}</p>) : "—"}</td>
                              </tr>;
                            })}
                          </tbody>
                        </table>
                        {!workOrderMaterials.length ? <p className="py-5 text-xs text-slate-500">No BOM material requirements were returned.</p> : null}
                      </div>
                    </Panel>

                    <Panel title="Shop-floor event ledger" subtitle="Latest 100 append-only work-order and operation event records returned by the API.">
                      <div className="space-y-2">
                        {workOrderEvents.map((entry, index) => {
                          const payload = record(entry.payload);
                          return <div key={String(entry.id ?? index)} className="rounded-xl border border-slate-200 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{textOf(entry.event_type)}</p><p className="text-[10px] text-slate-500">{dateTime(entry.recorded_at)}</p></div>
                            <p className="mt-1 text-[10px] text-slate-600">{textOf(entry.event_source, "API")} · {textOf(entry.from_status, "—")} → {textOf(entry.to_status, "—")} · {textOf(entry.device_id, "No device ID")}</p>
                            {payload.reason ? <p className="mt-1 text-[10px] text-slate-600">Reason: {String(payload.reason)}</p> : null}
                            {payload.quantity !== undefined ? <p className="mt-1 text-[10px] text-slate-600">Quantity: {quantity(payload.quantity)}</p> : null}
                          </div>;
                        })}
                        {!workOrderEvents.length ? <p className="rounded-lg bg-slate-50 p-4 text-xs text-slate-500">No event history is available for this work order.</p> : null}
                      </div>
                    </Panel>
                  </>
                )}
              </div>
            </section>
          ) : null}

          {tab === "materials" ? (
            <Panel title="Priority-allocated material shortage radar" subtitle="Read-only projection based on pinned work-order BOM demand, actual reservations, eligible inventory stock and existing approved PO supply. Shared item pools are allocated once by work-order status, due date, priority and planned start." action={<button type="button" className={secondaryButton} disabled={materialLoading} onClick={() => void loadMaterialRadar()}>{materialLoading ? "Calculating…" : "Refresh radar"}</button>}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-slate-500">As-of date: {materialAsOf || "Not returned"} · {summary.materialRequirementCount} requirement lines</p>
                <div className="flex flex-wrap gap-2 text-[10px]"><span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-800">{summary.materialRequirementCount - summary.shortageRequirementCount} covered / no projected shortage</span><span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-900">{summary.shortageRequirementCount} projected shortages</span></div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1040px] text-left text-[11px]">
                  <thead><tr className="border-b border-slate-200 text-[9px] uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">Work order / component</th><th className="py-2 pr-3 text-right">Required</th><th className="py-2 pr-3 text-right">Allocated</th><th className="py-2 pr-3 text-right">Eligible stock</th><th className="py-2 pr-3 text-right">PO incoming</th><th className="py-2 pr-3 text-right">Projected shortage</th><th className="py-2 pr-3">Ready date</th><th className="py-2">Basis</th>
                  </tr></thead>
                  <tbody>
                    {materialRadar.map((item, index) => {
                      const shortage = numberOf(item.projected_shortage_quantity) > 0;
                      return <tr key={String(item.requirement_id ?? index)} className="border-b border-slate-100 last:border-0">
                        <td className="py-3 pr-3"><button type="button" className="text-left font-bold text-blue-800 hover:underline" onClick={() => { setTab("work-orders"); setSelectedId(item.work_order_id); }}>{item.work_order_number}</button><p className="mt-0.5 font-semibold text-slate-900">{item.component_sku} · {item.component_name}</p><p className="mt-0.5 text-[10px] text-slate-500">Due {dateLabel(item.due_date)} · P{numberOf(item.priority)} · {item.work_order_status}</p></td>
                        <td className="py-3 pr-3 text-right tabular-nums">{quantity(item.required_quantity, item.unit)}</td>
                        <td className="py-3 pr-3 text-right tabular-nums">{quantity(item.allocated_quantity)}</td>
                        <td className="py-3 pr-3 text-right tabular-nums">{quantity(item.eligible_on_hand_pool_quantity)}</td>
                        <td className="py-3 pr-3 text-right tabular-nums">{quantity(item.projected_incoming_quantity)}</td>
                        <td className="py-3 pr-3 text-right"><span className={shortage ? "font-bold text-rose-700" : "font-semibold text-emerald-700"}>{quantity(item.projected_shortage_quantity)}</span>{numberOf(item.incoming_unit_mismatch_line_count) > 0 ? <p className="mt-0.5 text-[9px] text-amber-800">{numberOf(item.incoming_unit_mismatch_line_count)} PO unit mismatch</p> : null}</td>
                        <td className="py-3 pr-3">{dateLabel(item.projected_material_ready_date)}{item.shortage_by_due_date_quantity !== null ? <p className="mt-0.5 text-[9px] text-rose-700">Due exposure {quantity(item.shortage_by_due_date_quantity)}</p> : null}</td>
                        <td className="py-3"><span className="text-[9px] font-semibold text-slate-600">{String(item.material_ready_basis).replaceAll("_", " ")}</span>{item.traceability_required ? <p className="mt-1 text-[9px] text-violet-800">Traceability required</p> : null}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
                {!materialRadar.length ? <p className="py-8 text-center text-xs text-slate-500">{materialLoading ? "Calculating material readiness…" : "No active work-order material requirements were returned."}</p> : null}
              </div>
              <p className="mt-4 rounded-xl bg-slate-50 p-3 text-[10px] leading-5 text-slate-600">This is a read-only projection, not a reservation or purchase-order command. Dated approved PO supply may improve projected readiness, but the API release transaction still verifies and creates real material reservations. Different UOMs are not implicitly converted here.</p>
            </Panel>
          ) : null}
        </>
      )}

      {createOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="create-work-order-title" className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="create-work-order-title" className="text-lg font-bold text-slate-950">Create production work order</h2><p className="mt-1 text-xs text-slate-500">Choose an existing sales order line with an inventory-linked finished good.</p></div><button type="button" className={secondaryButton} disabled={busy} onClick={() => setCreateOpen(false)}>Close</button></div>
            <form onSubmit={submitWorkOrder} className="mt-5 space-y-5">
              <Field label="Source sales order">
                <select value={sourceOrderId} onChange={(event) => { setSourceOrderId(event.target.value); setWorkOrderDraft((current) => ({ ...current, order_line_id: "", target_quantity: "" })); }} className={inputClass} required>
                  <option value="">Select a source order</option>
                  {sourceOrders.map((order) => <option key={order.id} value={order.id}>{order.order_number} · {textOf(order.customer_name, "Customer")} · {order.status}</option>)}
                </select>
              </Field>
              {sourceOrderLoading ? <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">Loading sales order lines…</p> : null}
              {sourceOrderDetail ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{sourceOrderDetail.order.order_number} · {textOf(sourceOrderDetail.order.customer_name, "Customer")}</p><StatusPill value={sourceOrderDetail.order.status} /></div>
                  {sourceOrderDetail.order.status !== "IN_PROGRESS" ? <p className="rounded-lg bg-amber-50 p-3 text-[10px] text-amber-900">The work order can be created from this source state, but release requires the source sales order to be IN_PROGRESS.</p> : null}
                  <div className="space-y-2">
                    {sourceOrderDetail.lines.map((line) => (
                      <button type="button" key={line.id} onClick={() => chooseSourceLine(line)} disabled={!line.inventory_item_id} className={"w-full rounded-xl border p-3 text-left " + (workOrderDraft.order_line_id === line.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50") + (!line.inventory_item_id ? " opacity-50" : "")}>
                        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">Line {line.line_number} · {line.product_code} · {line.product_name}</p>{workOrderDraft.order_line_id === line.id ? <StatusPill value="SELECTED" /> : null}</div>
                        <p className="mt-1 text-[10px] text-slate-500">{quantity(line.quantity, line.unit)} · inventory item {line.inventory_item_id ? line.inventory_item_id.slice(0, 8) + "…" : "not linked"}</p>
                        {!line.inventory_item_id ? <p className="mt-1 text-[10px] text-rose-700">Link the order line to a finished-good inventory item before production.</p> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Field label="Target quantity"><input required inputMode="decimal" value={workOrderDraft.target_quantity} onChange={(event) => setWorkOrderDraft((current) => ({ ...current, target_quantity: event.target.value }))} className={inputClass} placeholder="0.0000" /></Field>
                <Field label="Planned start"><input type="date" required value={workOrderDraft.planned_start_date} onChange={(event) => setWorkOrderDraft((current) => ({ ...current, planned_start_date: event.target.value }))} className={inputClass} /></Field>
                <Field label="Due date"><input type="date" value={workOrderDraft.due_date} onChange={(event) => setWorkOrderDraft((current) => ({ ...current, due_date: event.target.value }))} className={inputClass} /></Field>
                <Field label="Priority (1 highest)"><select value={workOrderDraft.priority} onChange={(event) => setWorkOrderDraft((current) => ({ ...current, priority: event.target.value }))} className={inputClass}><option value="1">1 · Critical</option><option value="2">2 · High</option><option value="3">3 · Normal</option><option value="4">4 · Low</option><option value="5">5 · Lowest</option></select></Field>
              </div>
              <Field label="Production notes"><textarea rows={2} maxLength={2000} value={workOrderDraft.notes} onChange={(event) => setWorkOrderDraft((current) => ({ ...current, notes: event.target.value }))} className={inputClass} /></Field>
              <div className="rounded-xl bg-slate-50 p-3 text-[10px] leading-5 text-slate-600">The API resolves the approved product revision effective on the planned start date, then snapshots its BOM, routing and active work centres. This creates a DRAFT only; release and material reservations are a separate permission-controlled action.</div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={busy || !canCreate || !workOrderDraft.order_line_id}>{busy ? "Creating…" : "Create draft work order"}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {operationEditor && detail ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="operation-event-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="operation-event-title" className="text-lg font-bold text-slate-950">Record shop-floor event</h2><p className="mt-1 text-xs text-slate-500">{detail.work_order_number} · {operations.find((item) => item.id === operationEditor.operationId)?.operation_name}</p></div><button type="button" className={secondaryButton} disabled={busy} onClick={() => setOperationEditor(null)}>Close</button></div>
            <form onSubmit={submitOperationEvent} className="mt-5 space-y-4">
              <Field label="Operation command">
                <select value={operationEditor.command} onChange={(event) => { const command = event.target.value as OperationCommand; setOperationEditor((current) => current ? { ...current, command } : current); setOperationDraft(initialOperationDraft(command)); }} className={inputClass}>
                  {operations.find((item) => item.id === operationEditor.operationId)
                    ? operationCommands(operations.find((item) => item.id === operationEditor.operationId)!, detail).map((command) => <option key={command} value={command}>{operationActionLabel(command)}</option>)
                    : null}
                </select>
              </Field>
              {["WIP_REPORTED", "WIP_TRANSFERRED", "REWORK_REPORTED"].includes(operationEditor.command) ? <Field label={operationEditor.command === "WIP_REPORTED" ? "Current WIP quantity (zero clears the snapshot)" : operationEditor.command === "WIP_TRANSFERRED" ? "Transfer quantity" : "Rework quantity"}><input required inputMode="decimal" value={operationDraft.quantity} onChange={(event) => setOperationDraft((current) => ({ ...current, quantity: event.target.value }))} className={inputClass} placeholder="0.0000" /></Field> : null}
              {operationEditor.command === "WIP_TRANSFERRED" ? <Field label="Target operation"><select required value={operationDraft.target_operation_id} onChange={(event) => setOperationDraft((current) => ({ ...current, target_operation_id: event.target.value }))} className={inputClass}><option value="">Select a later operation</option>{operations.filter((item) => item.step_number > (operations.find((operation) => operation.id === operationEditor.operationId)?.step_number ?? 0)).map((item) => <option key={item.id} value={item.id}>Step {item.step_number} · {item.operation_name}</option>)}</select></Field> : null}
              {["HOLD", "SKIP", "DOWNTIME_START", "REWORK_REPORTED"].includes(operationEditor.command) ? <Field label="Reason"><textarea required rows={3} maxLength={1000} value={operationDraft.reason} onChange={(event) => setOperationDraft((current) => ({ ...current, reason: event.target.value }))} className={inputClass} placeholder="Add event reason…" /></Field> : null}
              <div className="rounded-lg bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">Each event submits the current work-order and operation row versions. Preceding-step sequence, active downtime, WIP ceilings and quality-gate skip protection remain API-enforced.</div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={() => setOperationEditor(null)}>Cancel</button><button type="submit" className={primaryButton} disabled={busy}>{busy ? "Recording…" : "Record " + operationEditor.command.replaceAll("_", " ").toLowerCase()}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {outputEditorId && detail ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="output-report-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="output-report-title" className="text-lg font-bold text-slate-950">Report final production output</h2><p className="mt-1 text-xs text-slate-500">{detail.work_order_number} · {finalOperation?.operation_name}</p></div><button type="button" className={secondaryButton} disabled={busy} onClick={() => setOutputEditorId("")}>Close</button></div>
            <form onSubmit={submitOutputReport} className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Good quantity"><input required inputMode="decimal" value={outputDraft.good_quantity} onChange={(event) => setOutputDraft((current) => ({ ...current, good_quantity: event.target.value }))} className={inputClass} placeholder="0.0000" /></Field>
                <Field label="Scrap quantity"><input required inputMode="decimal" value={outputDraft.scrap_quantity} onChange={(event) => setOutputDraft((current) => ({ ...current, scrap_quantity: event.target.value }))} className={inputClass} placeholder="0.0000" /></Field>
              </div>
              {numberOf(outputDraft.scrap_quantity) > 0 ? <Field label="Scrap reason"><textarea required rows={2} maxLength={1000} value={outputDraft.scrap_reason} onChange={(event) => setOutputDraft((current) => ({ ...current, scrap_reason: event.target.value }))} className={inputClass} /></Field> : null}
              <Field label="Finished-good serial codes (optional)" hint="One code per line, comma or semicolon separated. For SERIAL control, code count must equal whole accepted good units.">
                <textarea rows={3} value={outputDraft.finished_good_serial_codes} onChange={(event) => setOutputDraft((current) => ({ ...current, finished_good_serial_codes: event.target.value }))} className={inputClass} placeholder={"FG-2026-0001\nFG-2026-0002"} />
              </Field>
              <Field label="Output notes"><textarea rows={2} maxLength={2000} value={outputDraft.notes} onChange={(event) => setOutputDraft((current) => ({ ...current, notes: event.target.value }))} className={inputClass} /></Field>
              <div className="rounded-lg bg-slate-50 p-3 text-[10px] leading-5 text-slate-600">The server checks the final routing step, active operation timer, total target quantity, source order state, inventory traceability rules and unique serial identities. Good quantities and scrap evidence are persisted with finished-good stock/traceability postings in one transaction.</div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={() => setOutputEditorId("")}>Cancel</button><button type="submit" className={primaryButton} disabled={busy || !canReportOutput}>{busy ? "Posting…" : "Post output"}</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
