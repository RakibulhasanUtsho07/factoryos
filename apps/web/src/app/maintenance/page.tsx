"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createMaintenanceWorkspaceClient } from "@/lib/maintenance-workspace.mjs";
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
type SectionResult = {
  permitted: boolean;
  items: JsonRecord[];
  count: number;
  error: string;
};
type MaintenanceListsResult = {
  key: string;
  assets: SectionResult;
  plans: SectionResult;
  workOrders: SectionResult;
};
type WorkOrderDetailResult = {
  key: string;
  status: "success" | "error";
  payload?: JsonRecord;
  message?: string;
};

const ASSET_STATUS_OPTIONS = [
  { value: "", label: "All asset statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "RETIRED", label: "Retired" },
] as const;

const PM_STATUS_OPTIONS = [
  { value: "", label: "All plan statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "RETIRED", label: "Retired" },
] as const;

const WORK_ORDER_STATUS_OPTIONS = [
  { value: "", label: "All work-order statuses" },
  { value: "PLANNED", label: "Planned" },
  { value: "APPROVED", label: "Approved" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
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

function valueText(value: unknown, fallback = "Not recorded"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(number)
    : valueText(value);
}

function sectionResult(
  permitted: boolean,
  items: JsonRecord[] = [],
  count = 0,
  error = "",
): SectionResult {
  return { permitted, items, count, error };
}

async function loadSection(
  permitted: boolean,
  load: () => Promise<unknown>,
  collectionKey: string,
): Promise<SectionResult> {
  if (!permitted) return sectionResult(false);
  try {
    const response = asRecord(await load());
    const items = asRecords(response[collectionKey]);
    const rawCount = response.count;
    const count = typeof rawCount === "number" && Number.isFinite(rawCount)
      ? rawCount
      : items.length;
    return sectionResult(true, items, count);
  } catch (cause) {
    return sectionResult(
      true,
      [],
      0,
      cause instanceof Error ? cause.message : "The maintenance list could not be loaded.",
    );
  }
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      </CardContent>
    </Card>
  );
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value, "—")}</dd>
    </div>
  );
}

export default function MaintenanceWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [assetStatus, setAssetStatus] = useState("");
  const [pmStatus, setPmStatus] = useState("");
  const [workOrderStatus, setWorkOrderStatus] = useState("");
  const [workOrderType, setWorkOrderType] = useState("");
  const [priority, setPriority] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selection, setSelection] = useState<{ scopeKey: string; workOrderId: string } | null>(null);
  const [listsResult, setListsResult] = useState<MaintenanceListsResult | null>(null);
  const [detailResult, setDetailResult] = useState<WorkOrderDetailResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadAssets = connected && hasPermission("maintenance.assets.read");
  const canReadPlans = connected && hasPermission("maintenance.pm.read");
  const canReadWorkOrders = connected && hasPermission("maintenance.workorders.read");
  const canReadAny = canReadAssets || canReadPlans || canReadWorkOrders;
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const selectedWorkOrderId = selection?.scopeKey === scopeKey ? selection.workOrderId : "";

  const listKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadAssets,
    canReadPlans,
    canReadWorkOrders,
    assetStatus,
    pmStatus,
    workOrderStatus,
    workOrderType,
    priority,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadAssets,
    canReadPlans,
    canReadWorkOrders,
    assetStatus,
    pmStatus,
    workOrderStatus,
    workOrderType,
    priority,
    refreshVersion,
  ]);

  const detailKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadWorkOrders,
    selectedWorkOrderId,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadWorkOrders,
    selectedWorkOrderId,
    refreshVersion,
  ]);

  const currentLists = listsResult?.key === listKey ? listsResult : null;
  const currentDetail = detailResult?.key === detailKey ? detailResult : null;
  const loadingLists = connected && Boolean(activeFactoryId) && canReadAny && currentLists === null;
  const loadingDetail = Boolean(selectedWorkOrderId) && canReadWorkOrders && currentDetail === null;

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadAny) return;

    let active = true;
    const client = createMaintenanceWorkspaceClient({ request });
    const load = async () => {
      const [assets, plans, workOrders] = await Promise.all([
        loadSection(
          canReadAssets,
          () => client.listAssets({ status: assetStatus || undefined, limit: 50 }),
          "assets",
        ),
        loadSection(
          canReadPlans,
          () => client.listPmPlans({ status: pmStatus || undefined, limit: 50 }),
          "plans",
        ),
        loadSection(
          canReadWorkOrders,
          () => client.listWorkOrders({
            status: workOrderStatus || undefined,
            type: workOrderType || undefined,
            priority: priority || undefined,
            limit: 50,
          }),
          "work_orders",
        ),
      ]);
      if (!active) return;
      setListsResult({ key: listKey, assets, plans, workOrders });
    };
    void load();

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadAny,
    canReadAssets,
    canReadPlans,
    canReadWorkOrders,
    request,
    assetStatus,
    pmStatus,
    workOrderStatus,
    workOrderType,
    priority,
    refreshVersion,
    listKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadWorkOrders || !selectedWorkOrderId) return;

    let active = true;
    const client = createMaintenanceWorkspaceClient({ request });
    void client.getWorkOrder(selectedWorkOrderId).then((payload) => {
      if (!active) return;
      setDetailResult({ key: detailKey, status: "success", payload: asRecord(payload) });
    }).catch((cause: unknown) => {
      if (!active) return;
      setDetailResult({
        key: detailKey,
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not load work-order details.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadWorkOrders,
    selectedWorkOrderId,
    request,
    detailKey,
  ]);

  const assets = currentLists?.assets.items ?? [];
  const plans = currentLists?.plans.items ?? [];
  const workOrders = currentLists?.workOrders.items ?? [];
  const detail = asRecord(currentDetail?.payload);
  const workOrder = asRecord(detail.work_order);
  const checklist = asRecords(detail.checklist);
  const spareParts = asRecords(detail.spare_parts);
  const events = asRecords(detail.events);

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Factory operations · asset reliability"
        title="Maintenance Workbench"
        description="Review the factory asset register, preventive-maintenance schedule and maintenance work orders with their checklists, parts availability and recorded history."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!connected || !activeFactoryId || !canReadAny || loadingLists}
            >
              Refresh maintenance
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
            : "Connect an existing FactoryOS session to inspect maintenance records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canReadAny ? "success" : "info"} title="Maintenance read permissions">
          {canReadAny
            ? "Your IAM snapshot grants at least one maintenance read permission. The API rechecks factory scope and permission for every request."
            : "Asset, preventive-plan and work-order sections each require their corresponding maintenance read permission."}
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory returned by the authenticated IAM session. Maintenance records are never loaded across all factories."
        />
      ) : null}

      {connected && activeFactoryId && !canReadAny ? (
        <EmptyState
          title="Maintenance access is not available"
          description="The current IAM permission snapshot does not include a maintenance read permission. Ask an authorized administrator to review your access."
        />
      ) : null}

      {connected && activeFactoryId && canReadAny ? (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <MetricCard
              label="Assets returned"
              value={currentLists?.assets.permitted ? formatNumber(currentLists.assets.count) : "—"}
              hint="Asset register · maximum 50 rows"
            />
            <MetricCard
              label="PM plans returned"
              value={currentLists?.plans.permitted ? formatNumber(currentLists.plans.count) : "—"}
              hint="Preventive-maintenance list · maximum 50 rows"
            />
            <MetricCard
              label="Work orders returned"
              value={currentLists?.workOrders.permitted ? formatNumber(currentLists.workOrders.count) : "—"}
              hint="Priority-ordered list · maximum 50 rows"
            />
          </div>

          {loadingLists ? (
            <div className="mb-6 grid gap-5 lg:grid-cols-2" aria-label="Loading maintenance lists">
              {[1, 2].map((item) => (
                <div key={item} className="h-64 animate-pulse rounded-2xl bg-slate-100" />
              ))}
            </div>
          ) : null}

          <div className="mb-6 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Asset register</CardTitle>
                    <CardDescription>Factory equipment, criticality, location and lifecycle state.</CardDescription>
                  </div>
                  <Badge tone="neutral">50-row limit</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!canReadAssets ? (
                  <EmptyState title="Asset read permission required" description="This section requires maintenance.assets.read." />
                ) : currentLists?.assets.error ? (
                  <Alert tone="danger" title="Could not load assets">{currentLists.assets.error}</Alert>
                ) : assets.length === 0 && !loadingLists ? (
                  <EmptyState title="No assets returned" description="No matching assets were returned for this factory and status filter." />
                ) : (
                  <>
                    <label htmlFor="asset-status" className="block text-xs font-semibold text-slate-700">Asset status</label>
                    <select
                      id="asset-status"
                      value={assetStatus}
                      onChange={(event) => setAssetStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                    >
                      {ASSET_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <div className="mt-4 space-y-2">
                      {assets.map((asset) => (
                        <article key={valueText(asset.id)} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-950">{valueText(asset.asset_code, "Uncoded asset")}</p>
                              <p className="mt-1 text-sm text-slate-700">{valueText(asset.name)}</p>
                            </div>
                            <StatusBadge status={valueText(asset.status, "UNKNOWN")} />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                            <span>{valueText(asset.asset_type, "Type not recorded")}</span>
                            <span>·</span>
                            <span>Criticality: {valueText(asset.criticality, "Not rated")}</span>
                            <span>·</span>
                            <span>{valueText(asset.location, "Location not recorded")}</span>
                          </div>
                        </article>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Preventive-maintenance plans</CardTitle>
                    <CardDescription>Planned maintenance intervals and next due dates.</CardDescription>
                  </div>
                  <Badge tone="neutral">50-row limit</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {!canReadPlans ? (
                  <EmptyState title="PM plan read permission required" description="This section requires maintenance.pm.read." />
                ) : currentLists?.plans.error ? (
                  <Alert tone="danger" title="Could not load PM plans">{currentLists.plans.error}</Alert>
                ) : plans.length === 0 && !loadingLists ? (
                  <EmptyState title="No PM plans returned" description="No matching preventive-maintenance plans were returned for this factory and status filter." />
                ) : (
                  <>
                    <label htmlFor="pm-status" className="block text-xs font-semibold text-slate-700">Plan status</label>
                    <select
                      id="pm-status"
                      value={pmStatus}
                      onChange={(event) => setPmStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                    >
                      {PM_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <div className="mt-4 space-y-2">
                      {plans.map((plan) => (
                        <article key={valueText(plan.id)} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-950">{valueText(plan.plan_code, "Uncoded plan")} · {valueText(plan.name)}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {valueText(plan.asset_code, "Asset not recorded")} · {valueText(plan.asset_name)}
                              </p>
                            </div>
                            <StatusBadge status={valueText(plan.status, "UNKNOWN")} />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                            <span>Next due: {formatDate(plan.next_due_on)}</span>
                            <span>Interval: {valueText(plan.interval_value, "—")} {valueText(plan.interval_unit, "")}</span>
                            <span>Revision: {valueText(plan.revision, "—")}</span>
                          </div>
                          <p className="mt-2 text-xs text-slate-500">
                            {plan.requires_shutdown === true ? "Shutdown required" : "No shutdown flag recorded"}
                            {plan.estimated_duration_minutes !== undefined
                              ? " · Estimated duration: " + formatNumber(plan.estimated_duration_minutes) + " min"
                              : ""}
                          </p>
                        </article>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Maintenance work orders</CardTitle>
                  <CardDescription>Priority-ordered work orders with persisted checklist, spare-part and event details.</CardDescription>
                </div>
                <Badge tone="neutral">50-row limit</Badge>
              </div>
            </CardHeader>
            <CardContent>
              {!canReadWorkOrders ? (
                <EmptyState title="Work-order read permission required" description="This section requires maintenance.workorders.read." />
              ) : (
                <>
                  <div className="mb-4 grid gap-3 sm:grid-cols-3">
                    <div>
                      <label htmlFor="work-order-status" className="block text-xs font-semibold text-slate-700">Status</label>
                      <select
                        id="work-order-status"
                        value={workOrderStatus}
                        onChange={(event) => setWorkOrderStatus(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {WORK_ORDER_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="work-order-type" className="block text-xs font-semibold text-slate-700">Type</label>
                      <select
                        id="work-order-type"
                        value={workOrderType}
                        onChange={(event) => setWorkOrderType(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        <option value="">All work types</option>
                        <option value="PM">Preventive maintenance</option>
                        <option value="BREAKDOWN">Breakdown</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="work-order-priority" className="block text-xs font-semibold text-slate-700">Priority</label>
                      <select
                        id="work-order-priority"
                        value={priority}
                        onChange={(event) => setPriority(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        <option value="">All priorities</option>
                        <option value="URGENT">Urgent</option>
                        <option value="HIGH">High</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="LOW">Low</option>
                      </select>
                    </div>
                  </div>

                  {currentLists?.workOrders.error ? (
                    <Alert tone="danger" title="Could not load work orders">{currentLists.workOrders.error}</Alert>
                  ) : null}

                  <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <div className="space-y-2">
                      {loadingLists ? (
                        [1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)
                      ) : workOrders.length === 0 && !currentLists?.workOrders.error ? (
                        <EmptyState title="No work orders returned" description="No work orders match the current type, priority and status filters." />
                      ) : (
                        workOrders.map((item) => {
                          const id = valueText(item.id, "");
                          const selected = id !== "" && id === selectedWorkOrderId;
                          return (
                            <button
                              type="button"
                              key={id || valueText(item.work_order_number)}
                              onClick={() => setSelection({ scopeKey, workOrderId: id })}
                              aria-pressed={selected}
                              disabled={!id}
                              className={[
                                "w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                                selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                              ].join(" ")}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-semibold text-slate-950">{valueText(item.work_order_number, "Unnamed work order")}</p>
                                  <p className="mt-1 text-sm text-slate-700">{valueText(item.title)}</p>
                                </div>
                                <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                              </div>
                              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                                <span>{valueText(item.asset_code, "Asset not recorded")} · {valueText(item.asset_name)}</span>
                                <span>Priority: {valueText(item.priority, "Not rated")}</span>
                                <span>Due: {formatDate(item.due_at)}</span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="min-w-0">
                      {!selectedWorkOrderId ? (
                        <EmptyState
                          title="Select a work order"
                          description="Choose a work order to inspect its checklist, spare-part availability and recorded maintenance events."
                        />
                      ) : loadingDetail ? (
                        <div className="h-64 animate-pulse rounded-xl bg-slate-100" aria-label="Loading work-order detail" />
                      ) : currentDetail?.status === "error" ? (
                        <Alert tone="danger" title="Could not load work-order detail">{currentDetail.message}</Alert>
                      ) : currentDetail?.status === "success" ? (
                        <div className="space-y-4">
                          <section className="rounded-xl border border-slate-200 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Work order</p>
                                <h3 className="mt-1 text-lg font-semibold text-slate-950">{valueText(workOrder.work_order_number)}</h3>
                                <p className="mt-1 text-sm text-slate-600">{valueText(workOrder.title)}</p>
                              </div>
                              <StatusBadge status={valueText(workOrder.status, "UNKNOWN")} />
                            </div>
                            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{valueText(workOrder.description, "No description recorded.")}</p>
                            <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                              <DetailField label="Asset" value={valueText(workOrder.asset_code, "—") + " · " + valueText(workOrder.asset_name, "—")} />
                              <DetailField label="Type / priority" value={valueText(workOrder.work_order_type, "—") + " · " + valueText(workOrder.priority, "—")} />
                              <DetailField label="Scheduled start" value={formatDate(workOrder.scheduled_start_at)} />
                              <DetailField label="Due date" value={formatDate(workOrder.due_at)} />
                              <DetailField label="PM plan" value={valueText(workOrder.plan_code, "Not linked")} />
                              <DetailField label="Asset criticality" value={valueText(workOrder.asset_criticality, "Not rated")} />
                              <DetailField label="Failure code" value={workOrder.failure_code} />
                              <DetailField label="Record version" value={workOrder.row_version} />
                            </dl>
                          </section>

                          <section className="rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="font-semibold text-slate-950">Checklist</h4>
                              <Badge tone="neutral">{checklist.length} recorded tasks</Badge>
                            </div>
                            {checklist.length ? (
                              <div className="mt-3 space-y-2">
                                {checklist.map((task) => (
                                  <div key={valueText(task.id, valueText(task.code))} className="rounded-lg bg-slate-50 p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-sm font-medium text-slate-800">{valueText(task.code, "Task")}</p>
                                      <Badge tone={task.completed_at ? "success" : "warning"}>
                                        {task.completed_at ? "Recorded complete" : "Not recorded complete"}
                                      </Badge>
                                    </div>
                                    <p className="mt-1 text-sm text-slate-600">{valueText(task.description)}</p>
                                    {task.required === true ? <p className="mt-1 text-[11px] font-semibold text-slate-500">Required task</p> : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-3 text-sm text-slate-500">No checklist tasks were returned for this work order.</p>
                            )}
                          </section>

                          <section className="rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="font-semibold text-slate-950">Spare parts</h4>
                              <Badge tone="neutral">{spareParts.length} recorded lines</Badge>
                            </div>
                            {spareParts.length ? (
                              <div className="mt-3 space-y-2">
                                {spareParts.map((part) => (
                                  <div key={valueText(part.id, valueText(part.sku))} className="rounded-lg bg-slate-50 p-3">
                                    <p className="text-sm font-semibold text-slate-800">{valueText(part.sku)} · {valueText(part.item_name)}</p>
                                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-3">
                                      <span>Required: {formatNumber(part.required_quantity)} {valueText(part.unit, "")}</span>
                                      <span>Issued: {formatNumber(part.issued_quantity)} {valueText(part.unit, "")}</span>
                                      <span>Available: {formatNumber(part.quantity_available)} {valueText(part.unit, "")}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-3 text-sm text-slate-500">No spare-part lines were returned for this work order.</p>
                            )}
                          </section>

                          <section className="rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="font-semibold text-slate-950">Recorded history</h4>
                              <Badge tone="neutral">{events.length} events</Badge>
                            </div>
                            {events.length ? (
                              <ol className="mt-3 space-y-3">
                                {events.map((event, index) => (
                                  <li key={valueText(event.entity_id) + ":" + valueText(event.entity_version, String(index))} className="border-l-2 border-slate-200 pl-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <p className="text-sm font-semibold text-slate-800">{valueText(event.action, valueText(event.entity_type))}</p>
                                      <span className="text-[11px] text-slate-500">{formatDate(event.created_at)}</span>
                                    </div>
                                    <p className="mt-1 text-xs text-slate-600">
                                      {valueText(event.from_status, "—")} → {valueText(event.to_status, "—")}
                                    </p>
                                    {typeof event.reason === "string" && event.reason.trim()
                                      ? <p className="mt-1 text-xs leading-5 text-slate-500">{event.reason}</p>
                                      : null}
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p className="mt-3 text-sm text-slate-500">No event history was returned for this work order.</p>
                            )}
                          </section>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <p className="mt-4 text-xs leading-5 text-slate-500">
            This workbench is read-only. It does not create assets, activate PM plans, approve or transition work orders, complete checklist tasks, or issue spare parts. All displayed records are returned by the selected factory's authenticated API scope.
          </p>
        </>
      ) : null}
    </main>
  );
}
