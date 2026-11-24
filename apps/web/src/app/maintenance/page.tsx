"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildMaintenanceAssetPayload,
  buildMaintenanceAssetUpdatePayload,
  buildMaintenanceBreakdownWorkOrderPayload,
  buildMaintenanceGenerateDuePayload,
  buildMaintenancePmPlanPayload,
  buildMaintenancePmTransitionPayload,
  buildMaintenanceQuery,
  buildMaintenanceSparePartIssuePayload,
  buildMaintenanceSparePartPayload,
  buildMaintenanceTaskCompletionPayload,
  buildMaintenanceWorkOrderTransitionPayload,
  filterMaintenanceRows,
  normalizeMaintenanceRows,
  parseMaintenanceChecklistDraft,
  summarizeMaintenanceWorkspace,
} from "@/lib/maintenance-workbench.mjs";

type Row = Record<string, unknown>;
type Tab = "ASSETS" | "PM" | "WORK_ORDERS" | "SPARE_PARTS";
type NoticeState = { tone: "success" | "error"; message: string };
type TaskDraft = { task: Row; reason: string; evidence: string };
type PartIssueDraft = { part: Row; quantity: string; reason: string };
type AssetEditDraft = {
  asset: Row; name: string; asset_type: string; parent_asset_id: string; manufacturer: string;
  model: string; serial_number: string; criticality: string; status: string; location: string;
  commissioned_on: string; warranty_expires_on: string; notes: string; reason: string;
};

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "ASSETS", label: "Asset register", description: "Hierarchy, criticality, lifecycle and warranty" },
  { id: "PM", label: "Preventive maintenance", description: "Revisioned plans, independent activation and due generation" },
  { id: "WORK_ORDERS", label: "Work orders", description: "Breakdown repair, execution and evidence" },
  { id: "SPARE_PARTS", label: "Spare parts", description: "Factory stock checks, requirements and controlled issue" },
];

const INPUT = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const AREA = INPUT + " min-h-24";
const PRIMARY = "inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER = "inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50";

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function list(value: unknown, key = "items"): Row[] {
  return normalizeMaintenanceRows(value, key).map((row) => object(row));
}

function display(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The maintenance request could not be completed.";
}

function dateTime(value: unknown) {
  if (!value) return "—";
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function localDate(date = new Date()) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 10);
}

function localDateTimeInput() {
  const adjusted = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function localDateTimeToIso(value: string) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) throw new Error("Choose a valid local date and time.");
  return parsed.toISOString();
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure idempotency-key generation is unavailable.");
  return "maintenance:" + globalThis.crypto.randomUUID();
}

function statusTone(value: unknown) {
  const status = display(value, "UNKNOWN").toUpperCase();
  if (["ACTIVE", "APPROVED", "IN_PROGRESS", "COMPLETED"].includes(status)) return "bg-emerald-50 text-emerald-800";
  if (["DRAFT", "PLANNED", "PAUSED", "ON_HOLD"].includes(status)) return "bg-amber-50 text-amber-900";
  if (["RETIRED", "INACTIVE", "CANCELLED"].includes(status)) return "bg-slate-100 text-slate-700";
  return "bg-rose-50 text-rose-800";
}

function StatusPill({ value }: { value: unknown }) {
  const status = display(value, "UNKNOWN").toUpperCase();
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + statusTone(status)}>{status.replaceAll("_", " ")}</span>;
}

function CriticalityPill({ value }: { value: unknown }) {
  const criticality = display(value, "MEDIUM").toUpperCase();
  const tone = criticality === "CRITICAL" || criticality === "HIGH"
    ? "bg-rose-50 text-rose-800"
    : criticality === "MEDIUM" ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide " + tone}>{criticality}</span>;
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

function Section({ title, subtitle, children, action }: { title: string; subtitle: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div><h2 className="text-sm font-bold text-slate-950">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p></div>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>{headers.map((header) => <th key={header} className="whitespace-nowrap px-3 py-3 font-bold">{header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
    </div>
  );
}

function checklistSummary(tasks: Row[]) {
  const complete = tasks.filter((task) => task.status === "COMPLETED").length;
  const required = tasks.filter((task) => task.is_required !== false).length;
  const requiredComplete = tasks.filter((task) => task.is_required !== false && task.status === "COMPLETED").length;
  return { complete, total: tasks.length, required, requiredComplete };
}

export default function MaintenanceAssetReliabilityPage() {
  const { status: sessionStatus, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const currentUserId = snapshot?.user.id ?? "";

  const permissions = {
    assetsRead: hasPermission("maintenance.assets.read"),
    assetsManage: hasPermission("maintenance.assets.manage"),
    pmRead: hasPermission("maintenance.pm.read"),
    pmManage: hasPermission("maintenance.pm.manage"),
    workOrdersRead: hasPermission("maintenance.workorders.read"),
    workOrdersManage: hasPermission("maintenance.workorders.manage"),
    workOrdersExecute: hasPermission("maintenance.workorders.execute"),
    partsManage: hasPermission("maintenance.parts.manage"),
  };
  const tabAccess: Record<Tab, boolean> = {
    ASSETS: permissions.assetsRead || permissions.assetsManage,
    PM: permissions.pmRead || permissions.pmManage,
    WORK_ORDERS: permissions.workOrdersRead || permissions.workOrdersManage || permissions.workOrdersExecute,
    SPARE_PARTS: permissions.partsManage && permissions.workOrdersRead,
  };
  const canRead = permissions.assetsRead || permissions.pmRead || permissions.workOrdersRead;

  const [tab, setTab] = useState<Tab>("ASSETS");
  const defaultTab: Tab = tabAccess.ASSETS ? "ASSETS" : tabAccess.PM ? "PM" : tabAccess.WORK_ORDERS ? "WORK_ORDERS" : "SPARE_PARTS";
  const visibleTab = tabAccess[tab] ? tab : defaultTab;

  const [loadedFactoryId, setLoadedFactoryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const [assets, setAssets] = useState<Row[]>([]);
  const [plans, setPlans] = useState<Row[]>([]);
  const [workOrders, setWorkOrders] = useState<Row[]>([]);
  const [assetSearch, setAssetSearch] = useState("");
  const [planSearch, setPlanSearch] = useState("");
  const [workOrderSearch, setWorkOrderSearch] = useState("");
  const [assetStatusFilter, setAssetStatusFilter] = useState("ALL");
  const [planStatusFilter, setPlanStatusFilter] = useState("ALL");
  const [workOrderStatusFilter, setWorkOrderStatusFilter] = useState("ALL");

  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [assetDetail, setAssetDetail] = useState<Row | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [planDetail, setPlanDetail] = useState<Row | null>(null);
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState("");
  const [workOrderDetail, setWorkOrderDetail] = useState<Row | null>(null);

  const [assetDraft, setAssetDraft] = useState({
    asset_code: "", name: "", asset_type: "MACHINE", parent_asset_id: "", manufacturer: "", model: "",
    serial_number: "", criticality: "MEDIUM", location: "", commissioned_on: "", warranty_expires_on: "", notes: "",
  });
  const [assetEditDraft, setAssetEditDraft] = useState<AssetEditDraft | null>(null);
  const [pmDraft, setPmDraft] = useState({
    asset_id: "", plan_code: "", name: "", description: "", interval_value: "30", interval_unit: "DAY",
    next_due_on: localDate(), estimated_duration_minutes: "60", requires_shutdown: false, checklistDraft: "",
  });
  const [pmTransitionReason, setPmTransitionReason] = useState("");
  const [pmGenerateReason, setPmGenerateReason] = useState("");
  const [breakdownDraft, setBreakdownDraft] = useState({
    asset_id: "", priority: "HIGH", title: "", description: "", failure_code: "",
    scheduled_start_at: "", due_at: "", assigned_to_user_id: "", checklistDraft: "",
  });
  const [workOrderTransitionReason, setWorkOrderTransitionReason] = useState("");
  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null);
  const [partDraft, setPartDraft] = useState({ inventory_item_id: "", required_quantity: "1", notes: "" });
  const [partIssueDraft, setPartIssueDraft] = useState<PartIssueDraft | null>(null);
  const [availabilityItemId, setAvailabilityItemId] = useState("");
  const [availability, setAvailability] = useState<Row | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);

  const visibleAssets = useMemo(() => filterMaintenanceRows(assets, assetSearch, assetStatusFilter), [assets, assetSearch, assetStatusFilter]);
  const visiblePlans = useMemo(() => filterMaintenanceRows(plans, planSearch, planStatusFilter), [plans, planSearch, planStatusFilter]);
  const visibleWorkOrders = useMemo(() => filterMaintenanceRows(workOrders, workOrderSearch, workOrderStatusFilter), [workOrders, workOrderSearch, workOrderStatusFilter]);
  const summary = useMemo(() => summarizeMaintenanceWorkspace({ assets, plans, workOrders }), [assets, plans, workOrders]);

  const load = useCallback(async () => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setNotice(null);
    setLoadedFactoryId("");
    try {
      const tasks: Promise<unknown>[] = [];
      const keys: string[] = [];
      const add = (key: string, enabled: boolean, pathName: string) => {
        if (enabled) { keys.push(key); tasks.push(request(pathName)); }
      };
      add("assets", permissions.assetsRead, "/maintenance/assets" + buildMaintenanceQuery({}, "assets"));
      add("plans", permissions.pmRead, "/maintenance/pm-plans" + buildMaintenanceQuery({}, "plans"));
      add("work_orders", permissions.workOrdersRead, "/maintenance/work-orders" + buildMaintenanceQuery({}, "work_orders"));
      const values = await Promise.all(tasks);
      const result = Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Record<string, unknown>;
      setAssets(list(result.assets, "assets"));
      setPlans(list(result.plans, "plans"));
      setWorkOrders(list(result.work_orders, "work_orders"));
      setLoadedFactoryId(activeFactoryId);
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    } finally {
      setLoading(false);
    }
  }, [
    sessionStatus, activeFactoryId, canRead, request,
    permissions.assetsRead, permissions.pmRead, permissions.workOrdersRead,
  ]);

  useEffect(() => {
    if (sessionStatus !== "connected" || !activeFactoryId || !canRead) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [sessionStatus, activeFactoryId, canRead, load]);

  async function refreshSelectedDetails() {
    const tasks: Promise<void>[] = [];
    if (selectedAssetId && permissions.assetsRead) {
      tasks.push(request("/maintenance/assets/" + selectedAssetId).then((value) => setAssetDetail(object(value))));
    }
    if (selectedPlanId && permissions.pmRead) {
      tasks.push(request("/maintenance/pm-plans/" + selectedPlanId).then((value) => setPlanDetail(object(value))));
    }
    if (selectedWorkOrderId && permissions.workOrdersRead) {
      tasks.push(request("/maintenance/work-orders/" + selectedWorkOrderId).then((value) => setWorkOrderDetail(object(value))));
    }
    await Promise.all(tasks);
  }

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await load();
      await refreshSelectedDetails();
      setNotice({ tone: "success", message: success });
      return true;
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openAsset(id: string) {
    if (!permissions.assetsRead) return;
    setSelectedAssetId(id);
    setAssetDetail(null);
    try {
      const result = object(await request("/maintenance/assets/" + id));
      setAssetDetail(result);
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    }
  }

  async function openPlan(id: string) {
    if (!permissions.pmRead) return;
    setSelectedPlanId(id);
    setPlanDetail(null);
    try {
      setPlanDetail(object(await request("/maintenance/pm-plans/" + id)));
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    }
  }

  async function openWorkOrder(id: string) {
    if (!permissions.workOrdersRead) return;
    setSelectedWorkOrderId(id);
    setWorkOrderDetail(null);
    try {
      setWorkOrderDetail(object(await request("/maintenance/work-orders/" + id)));
      setTab("WORK_ORDERS");
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    }
  }

  async function createAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try { body = buildMaintenanceAssetPayload(assetDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/maintenance/assets", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Asset registered in the selected factory.",
    );
    if (saved) setAssetDraft({ asset_code: "", name: "", asset_type: "MACHINE", parent_asset_id: "", manufacturer: "", model: "", serial_number: "", criticality: "MEDIUM", location: "", commissioned_on: "", warranty_expires_on: "", notes: "" });
  }

  async function updateAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assetEditDraft) return;
    let body: Row;
    try {
      body = buildMaintenanceAssetUpdatePayload({
        expected_version: assetEditDraft.asset.row_version,
        name: assetEditDraft.name,
        asset_type: assetEditDraft.asset_type,
        parent_asset_id: assetEditDraft.parent_asset_id,
        manufacturer: assetEditDraft.manufacturer,
        model: assetEditDraft.model,
        serial_number: assetEditDraft.serial_number,
        criticality: assetEditDraft.criticality,
        status: assetEditDraft.status,
        location: assetEditDraft.location,
        commissioned_on: assetEditDraft.commissioned_on,
        warranty_expires_on: assetEditDraft.warranty_expires_on,
        current_commissioned_on: assetEditDraft.asset.commissioned_on,
        current_warranty_expires_on: assetEditDraft.asset.warranty_expires_on,
        notes: assetEditDraft.notes,
        reason: assetEditDraft.reason,
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const id = String(assetEditDraft.asset.id);
    const saved = await perform(
      () => request("/maintenance/assets/" + id + "/update", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Asset revision saved using the observed row version.",
    );
    if (saved) setAssetEditDraft(null);
  }

  async function createPmPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildMaintenancePmPlanPayload({
        ...pmDraft,
        checklist: parseMaintenanceChecklistDraft(pmDraft.checklistDraft),
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/maintenance/pm-plans", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Preventive-maintenance plan revision drafted.",
    );
    if (saved) setPmDraft({ asset_id: "", plan_code: "", name: "", description: "", interval_value: "30", interval_unit: "DAY", next_due_on: localDate(), estimated_duration_minutes: "60", requires_shutdown: false, checklistDraft: "" });
  }

  async function transitionPmPlan(action: "ACTIVATE" | "PAUSE" | "RESUME" | "RETIRE") {
    const plan = object(planDetail?.plan);
    if (!plan.id) return;
    let body: Row;
    try { body = buildMaintenancePmTransitionPayload({ expected_version: plan.row_version, action, reason: pmTransitionReason }) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/maintenance/pm-plans/" + String(plan.id) + "/transition", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Preventive-maintenance plan transitioned.",
    );
    if (saved) setPmTransitionReason("");
  }

  async function generateDueWorkOrder() {
    const plan = object(planDetail?.plan);
    if (!plan.id) return;
    let body: Row;
    try { body = buildMaintenanceGenerateDuePayload({ expected_version: plan.row_version, reason: pmGenerateReason }) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    let generatedWorkOrderId = "";
    const saved = await perform(
      async () => {
        const result = object(await request("/maintenance/pm-plans/" + String(plan.id) + "/generate-due", { method: "POST", body, idempotencyKey: newIdempotencyKey() }));
        generatedWorkOrderId = String(object(result.work_order).id ?? result.id ?? "");
        return result;
      },
      "Due preventive-maintenance work order generated.",
    );
    if (saved) {
      setPmGenerateReason("");
      setTab("WORK_ORDERS");
      if (generatedWorkOrderId) await openWorkOrder(generatedWorkOrderId);
    }
  }

  async function createBreakdownWorkOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let body: Row;
    try {
      body = buildMaintenanceBreakdownWorkOrderPayload({
        ...breakdownDraft,
        scheduled_start_at: breakdownDraft.scheduled_start_at ? localDateTimeToIso(breakdownDraft.scheduled_start_at) : "",
        due_at: breakdownDraft.due_at ? localDateTimeToIso(breakdownDraft.due_at) : "",
        checklist: parseMaintenanceChecklistDraft(breakdownDraft.checklistDraft),
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/maintenance/work-orders", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Breakdown work order created.",
    );
    if (saved) setBreakdownDraft({ asset_id: "", priority: "HIGH", title: "", description: "", failure_code: "", scheduled_start_at: "", due_at: "", assigned_to_user_id: "", checklistDraft: "" });
  }

  async function transitionWorkOrder(action: "APPROVE" | "START" | "HOLD" | "RESUME" | "COMPLETE" | "CANCEL") {
    const wo = object(workOrderDetail?.work_order);
    if (!wo.id) return;
    let body: Row;
    try { body = buildMaintenanceWorkOrderTransitionPayload({ expected_version: wo.row_version, action, reason: workOrderTransitionReason }) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/maintenance/work-orders/" + String(wo.id) + "/transition", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Maintenance work order transitioned.",
    );
    if (saved) setWorkOrderTransitionReason("");
  }

  async function completeChecklistTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskDraft || !selectedWorkOrderId) return;
    let evidence: Row;
    try {
      const parsed: unknown = JSON.parse(taskDraft.evidence);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Evidence must be a JSON object.");
      evidence = parsed as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    let body: Row;
    try { body = buildMaintenanceTaskCompletionPayload({ expected_version: taskDraft.task.row_version, reason: taskDraft.reason, evidence }) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const taskId = String(taskDraft.task.id);
    const saved = await perform(
      () => request("/maintenance/work-orders/" + selectedWorkOrderId + "/tasks/" + taskId + "/complete", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Checklist task completed with structured evidence.",
    );
    if (saved) setTaskDraft(null);
  }

  async function addSparePart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorkOrderId) return;
    let body: Row;
    try { body = buildMaintenanceSparePartPayload(partDraft) as Row; }
    catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const saved = await perform(
      () => request("/maintenance/work-orders/" + selectedWorkOrderId + "/spare-parts", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Spare-part requirement added to the selected work order.",
    );
    if (saved) setPartDraft({ inventory_item_id: "", required_quantity: "1", notes: "" });
  }

  async function issueSparePart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!partIssueDraft || !selectedWorkOrderId) return;
    let body: Row;
    try {
      body = buildMaintenanceSparePartIssuePayload({
        expected_version: partIssueDraft.part.row_version,
        quantity: partIssueDraft.quantity,
        reason: partIssueDraft.reason,
      }) as Row;
    } catch (cause) { setNotice({ tone: "error", message: messageOf(cause) }); return; }
    const partId = String(partIssueDraft.part.id);
    const saved = await perform(
      () => request("/maintenance/work-orders/" + selectedWorkOrderId + "/spare-parts/" + partId + "/issue", { method: "POST", body, idempotencyKey: newIdempotencyKey() }),
      "Spare-part issue recorded as an inventory ISSUE movement.",
    );
    if (saved) setPartIssueDraft(null);
  }

  async function checkPartAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAvailabilityLoading(true);
    setAvailability(null);
    setNotice(null);
    try {
      const id = availabilityItemId.trim();
      const value = await request("/maintenance/spare-parts/availability/" + id);
      setAvailability(object(value));
    } catch (cause) {
      setNotice({ tone: "error", message: messageOf(cause) });
    } finally {
      setAvailabilityLoading(false);
    }
  }

  const hasSession = sessionStatus === "connected" && Boolean(activeFactoryId);
  const currentWorkOrder = object(workOrderDetail?.work_order);
  const tasks = list(workOrderDetail, "checklist");
  const parts = list(workOrderDetail, "spare_parts");
  const events = list(workOrderDetail, "events");
  const taskCounts = checklistSummary(tasks);
  const assetOptions = assets.filter((row) => row.status === "ACTIVE");
  const pmPlan = object(planDetail?.plan);
  const assetRecord = object(assetDetail?.asset ?? assetDetail);
  const selectedPartRemaining = partIssueDraft
    ? Math.max(0, Number(partIssueDraft.part.required_quantity ?? 0) - Number(partIssueDraft.part.issued_quantity ?? 0))
    : 0;

  const workOrderActions: Array<"APPROVE" | "START" | "HOLD" | "RESUME" | "COMPLETE" | "CANCEL"> =
    currentWorkOrder.status === "PLANNED" ? ["APPROVE", "CANCEL"]
      : currentWorkOrder.status === "APPROVED" ? ["START", "CANCEL"]
        : currentWorkOrder.status === "IN_PROGRESS" ? ["HOLD", "COMPLETE"]
          : currentWorkOrder.status === "ON_HOLD" ? ["RESUME", "CANCEL"] : [];

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-3xl bg-slate-950 px-5 py-6 text-white shadow-sm sm:px-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">FactoryOS · Asset reliability</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Maintenance & Asset Reliability</h1>
              <p className="mt-2 max-w-2xl text-xs leading-6 text-slate-300 sm:text-sm">
                Factory-scoped equipment register, preventive-maintenance schedules, breakdown response, evidence-led work orders and controlled spare-part issue.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={"rounded-full px-3 py-1.5 text-[10px] font-bold " + (hasSession ? "bg-emerald-400/15 text-emerald-200" : "bg-amber-400/15 text-amber-200")}>{hasSession ? "SESSION CONNECTED" : "SESSION REQUIRED"}</span>
              <button type="button" onClick={() => void load()} disabled={!hasSession || !canRead || loading} className="inline-flex min-h-9 items-center rounded-lg border border-white/20 px-3 text-xs font-semibold text-white hover:bg-white/10 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh data"}</button>
            </div>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Active assets</p><p className="mt-1 text-xl font-bold">{summary.activeAssets}</p></div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">High / critical assets</p><p className="mt-1 text-xl font-bold">{summary.criticalAssets}</p></div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Due PM plans</p><p className="mt-1 text-xl font-bold">{summary.duePlans}</p></div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Open / overdue work</p><p className="mt-1 text-xl font-bold">{summary.openWorkOrders} / {summary.overdueWorkOrders}</p></div>
          </div>
          {loadedFactoryId ? <p className="mt-4 text-[10px] text-slate-400">Loaded active factory context: {loadedFactoryId} · Metrics describe the loaded first 100 API records, not an unbounded factory-wide export.</p> : null}
        </header>

        {notice ? (
          <div role="status" className={"rounded-xl border px-4 py-3 text-xs " + (notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>
            <div className="flex items-start justify-between gap-3"><span>{notice.message}</span><button type="button" className="font-bold" onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>
          </div>
        ) : null}

        {!hasSession ? (
          <Empty>Connect an authenticated FactoryOS session and select an active factory to open maintenance records.</Empty>
        ) : !canRead && !permissions.assetsManage && !permissions.pmManage && !permissions.workOrdersManage && !permissions.workOrdersExecute ? (
          <Empty>Your session does not include a Maintenance permission. Ask a factory administrator to grant the specific maintenance permissions required for your role.</Empty>
        ) : loadedFactoryId !== activeFactoryId && canRead ? (
          <Empty>{loading ? "Loading maintenance records for the selected factory…" : "No current-factory snapshot is available. Refresh to retry."}</Empty>
        ) : (
          <>
            <nav aria-label="Maintenance workspaces" className="flex gap-2 overflow-x-auto pb-1">
              {TABS.filter((item) => tabAccess[item.id]).map((item) => (
                <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-pressed={visibleTab === item.id} className={"min-w-max rounded-xl px-4 py-3 text-left transition " + (visibleTab === item.id ? "bg-slate-950 text-white shadow-sm" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100")}>
                  <span className="block text-xs font-bold">{item.label}</span><span className={"mt-1 block text-[10px] " + (visibleTab === item.id ? "text-slate-300" : "text-slate-400")}>{item.description}</span>
                </button>
              ))}
            </nav>

            {visibleTab === "ASSETS" ? (
              <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
                <div className="space-y-5">
                  {permissions.assetsRead ? <Section title="Asset register" subtitle="Hierarchy and criticality are constrained to the authenticated factory." action={<span className="text-[10px] text-slate-500">{visibleAssets.length} visible · {assets.length} loaded</span>}>
                    <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_180px]">
                      <input aria-label="Search assets" className={INPUT} placeholder="Search asset code, name or type" value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} />
                      <select aria-label="Asset status filter" className={INPUT} value={assetStatusFilter} onChange={(event) => setAssetStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="RETIRED">Retired</option></select>
                    </div>
                    {visibleAssets.length ? <Table headers={["Asset", "Type / hierarchy", "Criticality", "Warranty", "Status", "Details"]}>
                      {visibleAssets.map((row) => <tr key={String(row.id)}>
                        <td className="px-3 py-3"><p className="font-bold text-slate-900">{display(row.asset_code)}</p><p className="mt-1 text-[11px] text-slate-500">{display(row.name)}</p></td>
                        <td className="px-3 py-3"><p>{display(row.asset_type)}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{row.parent_asset_id ? String(row.parent_asset_id).slice(0, 8) : "Root asset"}</p></td>
                        <td className="px-3 py-3"><CriticalityPill value={row.criticality} /></td>
                        <td className="whitespace-nowrap px-3 py-3">{display(row.warranty_expires_on)}</td>
                        <td className="px-3 py-3"><StatusPill value={row.status} /></td>
                        <td className="px-3 py-3"><button type="button" className={SECONDARY} onClick={() => void openAsset(String(row.id))}>Open</button></td>
                      </tr>)}
                    </Table> : <Empty>No assets match the current filter.</Empty>}
                  </Section> : <Empty>You can create an asset with maintenance.assets.manage, but asset listing requires maintenance.assets.read.</Empty>}

                  {permissions.assetsManage ? <Section title="Register asset" subtitle="Create a factory asset. Parent assets must already exist and be active.">
                    <form onSubmit={createAsset} className="grid gap-3 sm:grid-cols-2">
                      <Field label="Asset code"><input required maxLength={100} className={INPUT} value={assetDraft.asset_code} onChange={(event) => setAssetDraft({ ...assetDraft, asset_code: event.target.value })} /></Field>
                      <Field label="Asset name"><input required maxLength={255} className={INPUT} value={assetDraft.name} onChange={(event) => setAssetDraft({ ...assetDraft, name: event.target.value })} /></Field>
                      <Field label="Asset type"><input required maxLength={80} className={INPUT} value={assetDraft.asset_type} onChange={(event) => setAssetDraft({ ...assetDraft, asset_type: event.target.value })} /></Field>
                      <Field label="Parent asset UUID (optional)"><input className={INPUT} value={assetDraft.parent_asset_id} onChange={(event) => setAssetDraft({ ...assetDraft, parent_asset_id: event.target.value })} /></Field>
                      <Field label="Manufacturer"><input maxLength={160} className={INPUT} value={assetDraft.manufacturer} onChange={(event) => setAssetDraft({ ...assetDraft, manufacturer: event.target.value })} /></Field>
                      <Field label="Model"><input maxLength={160} className={INPUT} value={assetDraft.model} onChange={(event) => setAssetDraft({ ...assetDraft, model: event.target.value })} /></Field>
                      <Field label="Serial number"><input maxLength={160} className={INPUT} value={assetDraft.serial_number} onChange={(event) => setAssetDraft({ ...assetDraft, serial_number: event.target.value })} /></Field>
                      <Field label="Criticality"><select className={INPUT} value={assetDraft.criticality} onChange={(event) => setAssetDraft({ ...assetDraft, criticality: event.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="CRITICAL">Critical</option></select></Field>
                      <Field label="Location"><input maxLength={255} className={INPUT} value={assetDraft.location} onChange={(event) => setAssetDraft({ ...assetDraft, location: event.target.value })} /></Field>
                      <Field label="Commissioned on"><input type="date" className={INPUT} value={assetDraft.commissioned_on} onChange={(event) => setAssetDraft({ ...assetDraft, commissioned_on: event.target.value })} /></Field>
                      <Field label="Warranty expires on"><input type="date" className={INPUT} value={assetDraft.warranty_expires_on} onChange={(event) => setAssetDraft({ ...assetDraft, warranty_expires_on: event.target.value })} /></Field>
                      <div className="sm:col-span-2"><Field label="Notes"><textarea maxLength={4000} className={AREA} value={assetDraft.notes} onChange={(event) => setAssetDraft({ ...assetDraft, notes: event.target.value })} /></Field></div>
                      <div><button type="submit" className={PRIMARY} disabled={busy}>Register asset</button></div>
                    </form>
                  </Section> : null}
                </div>

                <div className="space-y-5">
                  {assetDetail ? <Section title="Asset detail" subtitle="Child hierarchy, preventive plans and recent maintenance history are returned by the scoped asset endpoint." action={<button type="button" className={SECONDARY} onClick={() => setAssetDetail(null)}>Close detail</button>}>
                    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-bold">{display(assetRecord.asset_code)} · {display(assetRecord.name)}</p><p className="mt-1 text-[10px] text-slate-500">{display(assetRecord.manufacturer)} {display(assetRecord.model)} · {display(assetRecord.serial_number)}</p></div><div className="flex gap-2"><CriticalityPill value={assetRecord.criticality} /><StatusPill value={assetRecord.status} /></div></div>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Location</p><p className="mt-1 font-semibold">{display(assetRecord.location)}</p></div>
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Commissioned</p><p className="mt-1 font-semibold">{display(assetRecord.commissioned_on)}</p></div>
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Warranty expiry</p><p className="mt-1 font-semibold">{display(assetRecord.warranty_expires_on)}</p></div>
                    </div>
                    {permissions.assetsManage ? <button type="button" className={SECONDARY + " mt-4"} onClick={() => setAssetEditDraft({
                      asset: assetRecord, name: String(assetRecord.name ?? ""), asset_type: String(assetRecord.asset_type ?? ""),
                      parent_asset_id: String(assetRecord.parent_asset_id ?? ""), manufacturer: String(assetRecord.manufacturer ?? ""),
                      model: String(assetRecord.model ?? ""), serial_number: String(assetRecord.serial_number ?? ""),
                      criticality: String(assetRecord.criticality ?? "MEDIUM"), status: String(assetRecord.status ?? "ACTIVE"),
                      location: String(assetRecord.location ?? ""), commissioned_on: String(assetRecord.commissioned_on ?? "").slice(0,10),
                      warranty_expires_on: String(assetRecord.warranty_expires_on ?? "").slice(0,10), notes: String(assetRecord.notes ?? ""), reason: "",
                    })}>Edit asset revision</button> : null}
                    <div className="mt-5 space-y-3">
                      <div><h3 className="mb-2 text-xs font-bold">Child assets</h3>{list(assetDetail, "children").length ? list(assetDetail, "children").map((child) => <div key={String(child.id)} className="flex justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs"><span>{display(child.asset_code)} · {display(child.name)}</span><StatusPill value={child.status} /></div>) : <p className="text-[11px] text-slate-400">No child assets.</p>}</div>
                      <div><h3 className="mb-2 text-xs font-bold">Preventive plans</h3>{list(assetDetail, "pm_plans").length ? list(assetDetail, "pm_plans").map((plan) => <button key={String(plan.id)} type="button" className="mb-1 flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-xs" onClick={() => { setTab("PM"); void openPlan(String(plan.id)); }}><span>{display(plan.plan_code)} · {display(plan.name)}</span><StatusPill value={plan.status} /></button>) : <p className="text-[11px] text-slate-400">No preventive plans yet.</p>}</div>
                      <div><h3 className="mb-2 text-xs font-bold">Recent work orders</h3>{list(assetDetail, "recent_work_orders").length ? list(assetDetail, "recent_work_orders").map((wo) => <button key={String(wo.id)} type="button" className="mb-1 flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-xs" onClick={() => void openWorkOrder(String(wo.id))}><span>{display(wo.work_order_number)} · {display(wo.title)}</span><StatusPill value={wo.status} /></button>) : <p className="text-[11px] text-slate-400">No recent maintenance work.</p>}</div>
                    </div>
                  </Section> : <Empty>Select an asset to inspect its hierarchy, PM plan revisions and recent work orders.</Empty>}
                </div>
              </div>
            ) : null}

            {visibleTab === "PM" ? (
              <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
                <div className="space-y-5">
                  {permissions.pmRead ? <Section title="Preventive-maintenance plan register" subtitle="Every plan has a revision, lifecycle status, next due date and row version.">
                    <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_170px]">
                      <input aria-label="Search PM plans" className={INPUT} placeholder="Search plan code, asset or name" value={planSearch} onChange={(event) => setPlanSearch(event.target.value)} />
                      <select aria-label="PM plan status filter" className={INPUT} value={planStatusFilter} onChange={(event) => setPlanStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="RETIRED">Retired</option></select>
                    </div>
                    {visiblePlans.length ? <Table headers={["Plan", "Asset", "Interval", "Next due", "Status", "Detail"]}>
                      {visiblePlans.map((row) => <tr key={String(row.id)}>
                        <td className="px-3 py-3"><p className="font-bold">{display(row.plan_code)} · v{display(row.revision)}</p><p className="mt-1 text-[11px] text-slate-500">{display(row.name)}</p></td>
                        <td className="px-3 py-3">{display(row.asset_code)}<p className="text-[10px] text-slate-500">{display(row.asset_name)}</p></td>
                        <td className="px-3 py-3">{display(row.interval_value)} {display(row.interval_unit).toLowerCase()}</td>
                        <td className="whitespace-nowrap px-3 py-3">{display(row.next_due_on)}</td>
                        <td className="px-3 py-3"><StatusPill value={row.status} /></td>
                        <td className="px-3 py-3"><button type="button" className={SECONDARY} onClick={() => void openPlan(String(row.id))}>Open</button></td>
                      </tr>)}
                    </Table> : <Empty>No PM plans match the current filter.</Empty>}
                  </Section> : <Empty>You can manage PM plans, but listing requires maintenance.pm.read.</Empty>}
                  {permissions.pmManage && permissions.assetsRead ? <Section title="Create PM plan revision" subtitle="Plans start in DRAFT. Activation requires a different user from the plan creator.">
                    <form onSubmit={createPmPlan} className="grid gap-3 sm:grid-cols-2">
                      <Field label="Active asset"><select required className={INPUT} value={pmDraft.asset_id} onChange={(event) => setPmDraft({ ...pmDraft, asset_id: event.target.value })}><option value="">Select asset</option>{assetOptions.map((asset) => <option key={String(asset.id)} value={String(asset.id)}>{display(asset.asset_code)} · {display(asset.name)}</option>)}</select></Field>
                      <Field label="Plan code"><input required maxLength={100} className={INPUT} value={pmDraft.plan_code} onChange={(event) => setPmDraft({ ...pmDraft, plan_code: event.target.value })} /></Field>
                      <Field label="Plan name"><input required maxLength={255} className={INPUT} value={pmDraft.name} onChange={(event) => setPmDraft({ ...pmDraft, name: event.target.value })} /></Field>
                      <Field label="Interval value"><input required type="number" min="1" max="3650" className={INPUT} value={pmDraft.interval_value} onChange={(event) => setPmDraft({ ...pmDraft, interval_value: event.target.value })} /></Field>
                      <Field label="Interval unit"><select className={INPUT} value={pmDraft.interval_unit} onChange={(event) => setPmDraft({ ...pmDraft, interval_unit: event.target.value })}><option value="DAY">Days</option><option value="WEEK">Weeks</option><option value="MONTH">Months</option></select></Field>
                      <Field label="Next due date"><input required type="date" className={INPUT} value={pmDraft.next_due_on} onChange={(event) => setPmDraft({ ...pmDraft, next_due_on: event.target.value })} /></Field>
                      <Field label="Estimated duration (minutes)"><input type="number" min="1" max="100000" className={INPUT} value={pmDraft.estimated_duration_minutes} onChange={(event) => setPmDraft({ ...pmDraft, estimated_duration_minutes: event.target.value })} /></Field>
                      <Field label="Description"><input maxLength={4000} className={INPUT} value={pmDraft.description} onChange={(event) => setPmDraft({ ...pmDraft, description: event.target.value })} /></Field>
                      <div className="sm:col-span-2"><Field label="Checklist (one per line)" hint="Format: CODE | description | required or optional. At most 100 unique task codes."><textarea className={AREA} value={pmDraft.checklistDraft} onChange={(event) => setPmDraft({ ...pmDraft, checklistDraft: event.target.value })} placeholder={"LOCKOUT | Isolate the equipment\nBELT | Inspect drive belt | required\nCLEAN | Clean external casing | optional"} /></Field></div>
                      <label className="flex items-center gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" checked={pmDraft.requires_shutdown} onChange={(event) => setPmDraft({ ...pmDraft, requires_shutdown: event.target.checked })} /> Requires production shutdown</label>
                      <div><button type="submit" className={PRIMARY} disabled={busy || !assetOptions.length}>Create PM plan</button></div>
                    </form>
                  </Section> : null}
                </div>

                <div className="space-y-5">
                  {planDetail ? <Section title="PM plan detail & governance" subtitle="Lifecycle history is sourced from maintenance_events; stale row versions are rejected by the API." action={<button type="button" className={SECONDARY} onClick={() => { setPlanDetail(null); setSelectedPlanId(""); }}>Close</button>}>
                    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-bold">{display(pmPlan.plan_code)} · v{display(pmPlan.revision)} · {display(pmPlan.name)}</p><p className="mt-1 text-[10px] text-slate-500">{display(pmPlan.asset_code)} · {display(pmPlan.asset_name)}</p></div><StatusPill value={pmPlan.status} /></div>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Next due</p><p className="mt-1 font-semibold">{display(pmPlan.next_due_on)}</p></div>
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Interval</p><p className="mt-1 font-semibold">{display(pmPlan.interval_value)} {display(pmPlan.interval_unit).toLowerCase()}</p></div>
                      <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Row version</p><p className="mt-1 font-semibold">{display(pmPlan.row_version)}</p></div>
                    </div>
                    <div className="mt-4 rounded-xl border border-slate-200 p-3 text-xs">
                      <p className="font-bold text-slate-900">Maker-checker</p>
                      <p className="mt-1 text-[11px] text-slate-500">Created by {display(pmPlan.created_by_user_id)} · Approved by {display(pmPlan.approved_by_user_id)}</p>
                      {pmPlan.status === "DRAFT" && String(pmPlan.created_by_user_id ?? "").toLowerCase() === currentUserId.toLowerCase() ? <p className="mt-2 text-[11px] font-semibold text-amber-700">You created this plan. A different authorised user must activate it.</p> : null}
                    </div>
                    {permissions.pmManage ? (
                      <div className="mt-4 space-y-2">
                        <Field label="Transition reason"><input className={INPUT} value={pmTransitionReason} onChange={(event) => setPmTransitionReason(event.target.value)} placeholder="Mandatory reason for plan lifecycle action" /></Field>
                        <div className="flex flex-wrap gap-2">
                          {pmPlan.status === "DRAFT" ? <button type="button" className={PRIMARY} disabled={busy || String(pmPlan.created_by_user_id ?? "").toLowerCase() === currentUserId.toLowerCase()} onClick={() => void transitionPmPlan("ACTIVATE")}>Activate / approve</button> : null}
                          {pmPlan.status === "ACTIVE" ? <button type="button" className={SECONDARY} disabled={busy} onClick={() => void transitionPmPlan("PAUSE")}>Pause</button> : null}
                          {pmPlan.status === "PAUSED" ? <button type="button" className={PRIMARY} disabled={busy || String(pmPlan.created_by_user_id ?? "").toLowerCase() === currentUserId.toLowerCase()} onClick={() => void transitionPmPlan("RESUME")}>Resume / approve</button> : null}
                          {["ACTIVE", "PAUSED", "DRAFT"].includes(String(pmPlan.status)) ? <button type="button" className={DANGER} disabled={busy} onClick={() => void transitionPmPlan("RETIRE")}>Retire plan</button> : null}
                        </div>
                      </div>
                    ) : null}
                    {permissions.pmManage && pmPlan.status === "ACTIVE" ? <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
                      <p className="text-xs font-bold text-blue-950">Generate a due occurrence</p>
                      <p className="mt-1 text-[11px] text-blue-800">The API checks the plan due date against its database current date and advances the schedule in the same transaction.</p>
                      <Field label="Generation reason (optional)"><input className={INPUT} value={pmGenerateReason} onChange={(event) => setPmGenerateReason(event.target.value)} placeholder="Scheduled preventive-maintenance occurrence" /></Field>
                      <button type="button" className={PRIMARY + " mt-2"} disabled={busy} onClick={() => void generateDueWorkOrder()}>Generate due work order</button>
                    </div> : null}
                    <div className="mt-5"><h3 className="mb-2 text-xs font-bold">Lifecycle events</h3>{list(planDetail, "events").length ? <div className="space-y-2">{list(planDetail, "events").map((event, index) => <div key={String(event.created_at ?? index)} className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><p className="text-xs font-bold">{display(event.action)}</p><p className="text-[10px] text-slate-500">{dateTime(event.created_at)}</p></div><p className="mt-1 text-[11px] text-slate-600">{display(event.reason)}</p><p className="mt-1 text-[10px] text-slate-400">{display(event.from_status)} → {display(event.to_status)} · {display(event.actor_user_id)}</p></div>)}</div> : <Empty>No lifecycle events returned.</Empty>}</div>
                  </Section> : <Empty>Select a PM plan to inspect revisions, approvals, audit history and due generation.</Empty>}
                </div>
              </div>
            ) : null}

            {visibleTab === "WORK_ORDERS" ? (
              <div className="space-y-5">
                {permissions.workOrdersRead ? <Section title="Maintenance work-order queue" subtitle="Prioritised by urgency and due date. Use detail to execute the versioned lifecycle and checklist." action={<span className="text-[10px] text-slate-500">{visibleWorkOrders.length} visible · {workOrders.length} loaded</span>}>
                  <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_160px]">
                    <input aria-label="Search work orders" className={INPUT} placeholder="Search work-order number, asset or title" value={workOrderSearch} onChange={(event) => setWorkOrderSearch(event.target.value)} />
                    <select aria-label="Work-order status filter" className={INPUT} value={workOrderStatusFilter} onChange={(event) => setWorkOrderStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="PLANNED">Planned</option><option value="APPROVED">Approved</option><option value="IN_PROGRESS">In progress</option><option value="ON_HOLD">On hold</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option></select>
                  </div>
                  {visibleWorkOrders.length ? <Table headers={["Work order", "Asset", "Type / priority", "Due", "Status", "Detail"]}>
                    {visibleWorkOrders.map((row) => <tr key={String(row.id)}>
                      <td className="px-3 py-3"><p className="font-bold">{display(row.work_order_number)}</p><p className="mt-1 text-[11px] text-slate-500">{display(row.title)}</p></td>
                      <td className="px-3 py-3">{display(row.asset_code)}<p className="text-[10px] text-slate-500">{display(row.asset_name)}</p></td>
                      <td className="px-3 py-3"><p>{display(row.work_order_type)}</p><p className="mt-1"><CriticalityPill value={row.priority} /></p></td>
                      <td className="whitespace-nowrap px-3 py-3">{dateTime(row.due_at)}</td>
                      <td className="px-3 py-3"><StatusPill value={row.status} /></td>
                      <td className="px-3 py-3"><button type="button" className={SECONDARY} onClick={() => void openWorkOrder(String(row.id))}>Open</button></td>
                    </tr>)}
                  </Table> : <Empty>No maintenance work orders match the filter.</Empty>}
                </Section> : <Empty>Creating breakdown work orders requires maintenance.workorders.manage; listing requires maintenance.workorders.read.</Empty>}

                {permissions.workOrdersManage && permissions.assetsRead ? <Section title="Report equipment breakdown" subtitle="Creates a breakdown work order in PLANNED state with optional scheduling, assignment and ordered checklist tasks.">
                  <form onSubmit={createBreakdownWorkOrder} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Active asset"><select required className={INPUT} value={breakdownDraft.asset_id} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, asset_id: event.target.value })}><option value="">Select asset</option>{assetOptions.map((asset) => <option key={String(asset.id)} value={String(asset.id)}>{display(asset.asset_code)} · {display(asset.name)}</option>)}</select></Field>
                    <Field label="Priority"><select className={INPUT} value={breakdownDraft.priority} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, priority: event.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></Field>
                    <Field label="Title"><input required maxLength={255} className={INPUT} value={breakdownDraft.title} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, title: event.target.value })} /></Field>
                    <Field label="Failure code (optional)"><input maxLength={100} className={INPUT} value={breakdownDraft.failure_code} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, failure_code: event.target.value })} /></Field>
                    <Field label="Scheduled start (local)"><input type="datetime-local" className={INPUT} value={breakdownDraft.scheduled_start_at} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, scheduled_start_at: event.target.value })} /></Field>
                    <Field label="Due at (local)"><input type="datetime-local" className={INPUT} value={breakdownDraft.due_at} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, due_at: event.target.value })} /></Field>
                    <Field label="Assigned user UUID (optional)" hint="Must be an active tenant member."><input className={INPUT} value={breakdownDraft.assigned_to_user_id} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, assigned_to_user_id: event.target.value })} /></Field>
                    <div className="sm:col-span-2 lg:col-span-3"><Field label="Failure description"><textarea required maxLength={4000} className={AREA} value={breakdownDraft.description} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, description: event.target.value })} /></Field></div>
                    <div className="sm:col-span-2 lg:col-span-3"><Field label="Checklist" hint="One per line: CODE | description | required or optional."><textarea className={AREA} value={breakdownDraft.checklistDraft} onChange={(event) => setBreakdownDraft({ ...breakdownDraft, checklistDraft: event.target.value })} placeholder={"ISOLATE | Apply lockout-tagout\nDIAGNOSE | Record failure diagnosis\nVERIFY | Run no-load verification | optional"} /></Field></div>
                    <div><button type="submit" className={PRIMARY} disabled={busy || !assetOptions.length}>Create breakdown work order</button></div>
                  </form>
                </Section> : null}

                {workOrderDetail ? <Section title="Work-order execution detail" subtitle="Work-order state changes, checklist evidence and stock issues are all versioned and event-audited." action={<button type="button" className={SECONDARY} onClick={() => { setWorkOrderDetail(null); setSelectedWorkOrderId(""); }}>Close detail</button>}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div><p className="text-sm font-bold">{display(currentWorkOrder.work_order_number)} · {display(currentWorkOrder.title)}</p><p className="mt-1 text-[10px] text-slate-500">{display(currentWorkOrder.asset_code)} · {display(currentWorkOrder.asset_name)} · {display(currentWorkOrder.work_order_type)}</p></div>
                    <div className="flex gap-2"><CriticalityPill value={currentWorkOrder.priority} /><StatusPill value={currentWorkOrder.status} /></div>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Row version</p><p className="mt-1 text-xs font-bold">{display(currentWorkOrder.row_version)}</p></div>
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Scheduled start</p><p className="mt-1 text-xs font-bold">{dateTime(currentWorkOrder.scheduled_start_at)}</p></div>
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Due at</p><p className="mt-1 text-xs font-bold">{dateTime(currentWorkOrder.due_at)}</p></div>
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Checklist complete</p><p className="mt-1 text-xs font-bold">{taskCounts.complete} / {taskCounts.total}</p></div>
                  </div>
                  {permissions.workOrdersExecute && workOrderActions.length ? <div className="mt-4 rounded-xl border border-slate-200 p-3">
                    <Field label="Transition reason"><input className={INPUT} value={workOrderTransitionReason} onChange={(event) => setWorkOrderTransitionReason(event.target.value)} placeholder="Mandatory reason for transition" /></Field>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {workOrderActions.map((action) => <button key={action} type="button" className={action === "CANCEL" ? DANGER : PRIMARY} disabled={busy} onClick={() => void transitionWorkOrder(action)}>{action.replaceAll("_", " ")}</button>)}
                    </div>
                    {currentWorkOrder.status === "IN_PROGRESS" && taskCounts.requiredComplete < taskCounts.required ? <p className="mt-2 text-[11px] text-amber-800">Required checklist tasks remain incomplete ({taskCounts.requiredComplete}/{taskCounts.required}). The API remains the source of truth for work-order completion controls.</p> : null}
                  </div> : null}

                  <div className="mt-5 grid gap-5 xl:grid-cols-2">
                    <div>
                      <h3 className="mb-2 text-xs font-bold">Execution checklist</h3>
                      {tasks.length ? <div className="space-y-2">{tasks.map((task) => <article key={String(task.id)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold">{display(task.task_code)} · {display(task.description)}</p><p className="mt-1 text-[10px] text-slate-500">{task.is_required === false ? "Optional" : "Required"} · row version {display(task.row_version)}</p></div><StatusPill value={task.status} /></div>
                        {task.status === "PENDING" && permissions.workOrdersExecute && currentWorkOrder.status === "IN_PROGRESS" ? <button type="button" className={SECONDARY + " mt-3"} onClick={() => setTaskDraft({ task, reason: "", evidence: '{\n  "result": "PASS",\n  "inspection_reference": ""\n}' })}>Complete with evidence</button> : null}
                        {task.evidence ? <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-2 text-[10px] text-slate-600">{JSON.stringify(task.evidence, null, 2)}</pre> : null}
                        {task.completion_reason ? <p className="mt-1 text-[10px] text-slate-500">Reason: {display(task.completion_reason)}</p> : null}
                      </article>)}</div> : <Empty>No checklist tasks were attached to this work order.</Empty>}
                    </div>
                    <div>
                      <h3 className="mb-2 text-xs font-bold">Spare-part requirements</h3>
                      {parts.length ? <div className="space-y-2">{parts.map((part) => {
                        const remaining = Math.max(0, Number(part.required_quantity ?? 0) - Number(part.issued_quantity ?? 0));
                        return <article key={String(part.id)} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold">{display(part.sku)} · {display(part.item_name)}</p><p className="mt-1 text-[10px] text-slate-500">Required {display(part.required_quantity)} {display(part.unit)} · Issued {display(part.issued_quantity)} · Remaining {remaining}</p></div><StatusPill value={remaining > 0 ? "OUTSTANDING" : "FULFILLED"} /></div>
                          <p className="mt-2 text-[10px] text-slate-500">On hand {display(part.quantity_on_hand)} · Reserved {display(part.quantity_reserved)} · Available {display(part.quantity_available)}</p>
                          {permissions.partsManage && currentWorkOrder.status === "IN_PROGRESS" && remaining > 0 && Number(part.quantity_available ?? 0) > 0 ? <button type="button" className={SECONDARY + " mt-2"} onClick={() => setPartIssueDraft({ part, quantity: String(Math.min(remaining, Number(part.quantity_available))), reason: "" })}>Issue spare part</button> : null}
                        </article>;
                      })}</div> : <Empty>No spare-part requirements for this work order.</Empty>}
                      {permissions.partsManage && ["PLANNED", "APPROVED"].includes(String(currentWorkOrder.status)) ? <form onSubmit={addSparePart} className="mt-4 space-y-3 rounded-xl border border-dashed border-slate-300 p-3">
                        <p className="text-xs font-bold">Add spare-part requirement</p>
                        <Field label="Inventory item UUID" hint="Use an existing inventory item UUID from this same factory."><input required className={INPUT} value={partDraft.inventory_item_id} onChange={(event) => setPartDraft({ ...partDraft, inventory_item_id: event.target.value })} /></Field>
                        <Field label="Required quantity (up to 4 decimals)"><input required type="number" min="0.0001" step="0.0001" className={INPUT} value={partDraft.required_quantity} onChange={(event) => setPartDraft({ ...partDraft, required_quantity: event.target.value })} /></Field>
                        <Field label="Notes"><input maxLength={1000} className={INPUT} value={partDraft.notes} onChange={(event) => setPartDraft({ ...partDraft, notes: event.target.value })} /></Field>
                        <button type="submit" className={PRIMARY} disabled={busy}>Add requirement</button>
                      </form> : null}
                    </div>
                  </div>
                  <div className="mt-5"><h3 className="mb-2 text-xs font-bold">Maintenance event history</h3>{events.length ? <div className="max-h-80 space-y-2 overflow-y-auto">{events.map((event, index) => <div key={String(event.created_at ?? index)} className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap justify-between gap-2"><p className="text-xs font-bold">{display(event.action)}</p><p className="text-[10px] text-slate-500">{dateTime(event.created_at)}</p></div><p className="mt-1 text-[11px] text-slate-600">{display(event.reason)}</p><p className="mt-1 text-[10px] text-slate-400">{display(event.entity_type)} · {display(event.from_status)} → {display(event.to_status)} · {display(event.actor_user_id)}</p></div>)}</div> : <Empty>No work-order events returned.</Empty>}</div>
                </Section> : null}
              </div>
            ) : null}

            {visibleTab === "SPARE_PARTS" ? (
              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="Factory spare-part availability" subtitle="The endpoint calculates on-hand minus reserved stock for one inventory item in the selected factory.">
                  <form onSubmit={checkPartAvailability} className="space-y-3">
                    <Field label="Inventory item UUID"><input required className={INPUT} value={availabilityItemId} onChange={(event) => setAvailabilityItemId(event.target.value)} /></Field>
                    <button className={PRIMARY} type="submit" disabled={availabilityLoading}>{availabilityLoading ? "Checking…" : "Check available stock"}</button>
                  </form>
                  {availability ? <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Item</p><p className="mt-1 text-xs font-bold">{display(availability.sku)}</p><p className="text-[10px] text-slate-500">{display(availability.name)}</p></div>
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">On hand</p><p className="mt-1 text-xs font-bold">{display(availability.quantity_on_hand)}</p></div>
                    <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Reserved</p><p className="mt-1 text-xs font-bold">{display(availability.quantity_reserved)}</p></div>
                    <div className="rounded-lg bg-emerald-50 p-3"><p className="text-[10px] text-emerald-700">Available</p><p className="mt-1 text-xs font-bold text-emerald-900">{display(availability.quantity_available)}</p></div>
                  </div> : <p className="mt-4 text-[11px] text-slate-500">Enter an inventory item UUID. This view does not invent or enumerate inventory items; the maintenance API validates factory scope.</p>}
                </Section>
                <Section title="Issue workflow" subtitle="Spare parts are issued only against an IN_PROGRESS work order and a versioned requirement. The API creates the inventory ISSUE movement and prevents consuming reserved stock.">
                  {permissions.workOrdersRead ? (
                    <>
                      <Field label="Select open work order"><select className={INPUT} value={selectedWorkOrderId} onChange={(event) => { if (event.target.value) void openWorkOrder(event.target.value); }}><option value="">Choose work order</option>{workOrders.filter((row) => row.status === "IN_PROGRESS").map((row) => <option key={String(row.id)} value={String(row.id)}>{display(row.work_order_number)} · {display(row.asset_code)} · {display(row.title)}</option>)}</select></Field>
                      {selectedWorkOrderId && workOrderDetail ? <div className="mt-3 rounded-xl border border-slate-200 p-3"><p className="text-xs font-bold">{display(currentWorkOrder.work_order_number)} · {display(currentWorkOrder.title)}</p><p className="mt-1 text-[10px] text-slate-500">Select “Issue spare part” on an outstanding part requirement in Work Orders detail.</p><button type="button" className={SECONDARY + " mt-2"} onClick={() => setTab("WORK_ORDERS")}>Open work-order detail</button></div> : null}
                    </>
                  ) : <Empty>Work-order read permission is required to access this issue workspace.</Empty>}
                </Section>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 text-[10px] text-slate-500">
              <span>All writes use idempotency keys. The API enforces factory scope, permissions, parent-asset rules, maker-checker, row versions and stock reservations.</span>
              <span>{loading ? "Refreshing selected factory data…" : loadedFactoryId === activeFactoryId ? "Data loaded for current factory" : "No current factory snapshot"}</span>
            </div>
          </>
        )}
      </div>

      {assetEditDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={updateAsset} className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-sm font-bold">Edit asset revision</h2>
            <p className="mt-1 text-xs text-slate-500">{display(assetEditDraft.asset.asset_code)} · observed row version {display(assetEditDraft.asset.row_version)}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Name"><input required className={INPUT} value={assetEditDraft.name} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, name: event.target.value })} /></Field>
              <Field label="Asset type"><input required className={INPUT} value={assetEditDraft.asset_type} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, asset_type: event.target.value })} /></Field>
              <Field label="Parent asset UUID (blank clears)"><input className={INPUT} value={assetEditDraft.parent_asset_id} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, parent_asset_id: event.target.value })} /></Field>
              <Field label="Manufacturer"><input className={INPUT} value={assetEditDraft.manufacturer} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, manufacturer: event.target.value })} /></Field>
              <Field label="Model"><input className={INPUT} value={assetEditDraft.model} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, model: event.target.value })} /></Field>
              <Field label="Serial number"><input className={INPUT} value={assetEditDraft.serial_number} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, serial_number: event.target.value })} /></Field>
              <Field label="Criticality"><select className={INPUT} value={assetEditDraft.criticality} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, criticality: event.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="CRITICAL">Critical</option></select></Field>
              <Field label="Status"><select className={INPUT} value={assetEditDraft.status} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, status: event.target.value })}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="RETIRED">Retired</option></select></Field>
              <Field label="Location"><input className={INPUT} value={assetEditDraft.location} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, location: event.target.value })} /></Field>
              <Field label="Commissioned on"><input type="date" className={INPUT} value={assetEditDraft.commissioned_on} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, commissioned_on: event.target.value })} /></Field>
              <Field label="Warranty expires on"><input type="date" className={INPUT} value={assetEditDraft.warranty_expires_on} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, warranty_expires_on: event.target.value })} /></Field>
              <Field label="Notes"><textarea className={AREA} value={assetEditDraft.notes} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, notes: event.target.value })} /></Field>
              <div className="sm:col-span-2"><Field label="Mandatory reason"><textarea required minLength={3} maxLength={1000} className={AREA} value={assetEditDraft.reason} onChange={(event) => setAssetEditDraft({ ...assetEditDraft, reason: event.target.value })} /></Field></div>
            </div>
            <div className="mt-4 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setAssetEditDraft(null)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Save asset revision</button></div>
          </form>
        </div>
      ) : null}

      {taskDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={completeChecklistTask} className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-sm font-bold">Complete checklist task</h2>
            <p className="mt-1 text-xs text-slate-500">{display(taskDraft.task.task_code)} · {display(taskDraft.task.description)} · row version {display(taskDraft.task.row_version)}</p>
            <div className="mt-4 space-y-3">
              <Field label="Completion reason"><textarea required minLength={3} maxLength={2000} className={AREA} value={taskDraft.reason} onChange={(event) => setTaskDraft({ ...taskDraft, reason: event.target.value })} /></Field>
              <Field label="Structured evidence JSON" hint="Provide a non-empty JSON object; for example inspection result, measurement and reference. Do not include secrets or raw personal data."><textarea required className={AREA + " font-mono text-xs"} value={taskDraft.evidence} onChange={(event) => setTaskDraft({ ...taskDraft, evidence: event.target.value })} /></Field>
            </div>
            <div className="mt-4 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setTaskDraft(null)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Save evidence & complete</button></div>
          </form>
        </div>
      ) : null}

      {partIssueDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={issueSparePart} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-sm font-bold">Issue spare part</h2>
            <p className="mt-1 text-xs text-slate-500">{display(partIssueDraft.part.sku)} · {display(partIssueDraft.part.item_name)}</p>
            <p className="mt-2 text-[11px] text-slate-500">Outstanding requirement: {selectedPartRemaining} · Available unreserved stock: {display(partIssueDraft.part.quantity_available)}</p>
            <div className="mt-4 space-y-3">
              <Field label="Issue quantity (up to 4 decimals)"><input type="number" required min="0.0001" step="0.0001" max={Math.min(selectedPartRemaining, Number(partIssueDraft.part.quantity_available ?? 0))} className={INPUT} value={partIssueDraft.quantity} onChange={(event) => setPartIssueDraft({ ...partIssueDraft, quantity: event.target.value })} /></Field>
              <Field label="Issue reason"><textarea required minLength={3} maxLength={1000} className={AREA} value={partIssueDraft.reason} onChange={(event) => setPartIssueDraft({ ...partIssueDraft, reason: event.target.value })} /></Field>
            </div>
            <div className="mt-4 flex justify-end gap-2"><button type="button" className={SECONDARY} onClick={() => setPartIssueDraft(null)}>Cancel</button><button type="submit" className={PRIMARY} disabled={busy}>Confirm inventory issue</button></div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
