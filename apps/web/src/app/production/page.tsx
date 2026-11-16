"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createProductionWorkspaceClient } from "@/lib/production-workspace.mjs";
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
type ProductionView = "work-orders" | "material-readiness";
type ListResult = {
  key: string;
  items: JsonRecord[];
  payload?: JsonRecord;
  error: string;
};
type DetailResult = {
  key: string;
  payload?: JsonRecord;
  error: string;
};

const WORK_ORDER_STATUS_OPTIONS = [
  { value: "", label: "All work-order statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "RELEASED", label: "Released" },
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

function valueText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function formatQuantity(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(number)
    : valueText(value);
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not scheduled";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
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

function displayLabel(value: unknown): string {
  return valueText(value, "Unknown").replaceAll("_", " ").toLowerCase();
}

function getItems(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return asRecords(payload);
  return asRecords(asRecord(payload).items);
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value)}</dd>
    </div>
  );
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

export default function ProductionWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [view, setView] = useState<ProductionView>("work-orders");
  const [workOrderStatus, setWorkOrderStatus] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selection, setSelection] = useState<{ scopeKey: string; workOrderId: string } | null>(null);
  const [listResult, setListResult] = useState<ListResult | null>(null);
  const [detailResult, setDetailResult] = useState<DetailResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadProduction = connected && hasPermission("production.workorders.read");
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const selectedWorkOrderId = selection?.scopeKey === scopeKey ? selection.workOrderId : "";

  const listKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canReadProduction,
    view,
    workOrderStatus,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canReadProduction,
    view,
    workOrderStatus,
    refreshVersion,
  ]);

  const detailKey = JSON.stringify([
    listKey,
    view,
    selectedWorkOrderId,
  ]);

  const currentList = listResult?.key === listKey ? listResult : null;
  const currentDetail = detailResult?.key === detailKey ? detailResult : null;
  const items = currentList?.items ?? [];
  const selectedWorkOrder = items.find((item) => valueText(item.id, "") === selectedWorkOrderId) ?? null;
  const loadingList = connected && Boolean(activeFactoryId) && canReadProduction && currentList === null;
  const loadingDetail = view === "work-orders" && Boolean(selectedWorkOrderId)
    && canReadProduction && currentDetail === null;

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadProduction) return;

    let active = true;
    const client = createProductionWorkspaceClient({ request });
    const load = async () => {
      try {
        if (view === "work-orders") {
          const payload = await client.listWorkOrders({
            status: workOrderStatus || undefined,
            limit: 100,
          });
          if (!active) return;
          setListResult({ key: listKey, items: getItems(payload), error: "" });
        } else {
          const payload = await client.getMaterialShortageRadar({ limit: 100 });
          if (!active) return;
          setListResult({
            key: listKey,
            items: getItems(payload),
            payload: asRecord(payload),
            error: "",
          });
        }
      } catch (cause) {
        if (!active) return;
        setListResult({
          key: listKey,
          items: [],
          error: cause instanceof Error ? cause.message : "Production records could not be loaded.",
        });
      }
    };
    void load();

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadProduction,
    request,
    view,
    workOrderStatus,
    refreshVersion,
    listKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadProduction
      || view !== "work-orders" || !selectedWorkOrderId) return;

    let active = true;
    const client = createProductionWorkspaceClient({ request });
    void client.getWorkOrder(selectedWorkOrderId).then((payload) => {
      if (!active) return;
      setDetailResult({ key: detailKey, payload: asRecord(payload), error: "" });
    }).catch((cause: unknown) => {
      if (!active) return;
      setDetailResult({
        key: detailKey,
        error: cause instanceof Error ? cause.message : "Work-order detail could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadProduction,
    request,
    view,
    selectedWorkOrderId,
    detailKey,
  ]);

  const detail = asRecord(currentDetail?.payload);
  const materials = asRecords(detail.materials);
  const operations = asRecords(detail.operations);
  const radarPayload = asRecord(currentList?.payload);
  const shortages = items.filter((item) => Number(item.projected_shortage_quantity ?? 0) > 0);
  const selectedStatus = valueText(selectedWorkOrder?.status, "UNKNOWN");

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  function changeView(next: ProductionView) {
    setSelection(null);
    setView(next);
  }

  function changeStatus(value: string) {
    setSelection(null);
    setWorkOrderStatus(value);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Manufacturing · execution & material readiness"
        title="Production Workbench"
        description="Review work-order execution, routing progress and the server-calculated material shortage outlook for the selected factory."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!connected || !activeFactoryId || !canReadProduction || loadingList || loadingDetail}
            >
              Refresh production
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
            : "Connect an existing FactoryOS session to inspect production records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canReadProduction ? "success" : "info"} title="Production read permission">
          {canReadProduction
            ? "The workbench requires production.workorders.read. The API independently enforces permission and factory scope on each request."
            : "Work orders, operation detail and the material shortage radar require production.workorders.read."}
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory returned by the authenticated IAM session. Production records are never loaded across all factories."
        />
      ) : null}

      {connected && activeFactoryId && !canReadProduction ? (
        <EmptyState
          title="Production access is not available"
          description="The current IAM permission snapshot does not include production.workorders.read. Ask an authorized administrator to review your access."
        />
      ) : null}

      {connected && activeFactoryId && canReadProduction ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Production workspaces">
            <button
              type="button"
              role="tab"
              aria-selected={view === "work-orders"}
              onClick={() => changeView("work-orders")}
              className={[
                "min-h-10 rounded-lg border px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                view === "work-orders"
                  ? "border-brand-300 bg-brand-50 text-brand-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              ].join(" ")}
            >
              Work orders
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "material-readiness"}
              onClick={() => changeView("material-readiness")}
              className={[
                "min-h-10 rounded-lg border px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                view === "material-readiness"
                  ? "border-brand-300 bg-brand-50 text-brand-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              ].join(" ")}
            >
              Material readiness
            </button>
          </div>

          {view === "work-orders" ? (
            <>
              <div className="mb-5 grid gap-3 sm:grid-cols-3">
                <MetricCard
                  label="Work orders returned"
                  value={String(items.length)}
                  hint="Current status filter · maximum 100 rows"
                />
                <MetricCard
                  label="Selected order status"
                  value={selectedWorkOrder ? displayLabel(selectedStatus) : "—"}
                  hint="From the current work-order queue"
                />
                <MetricCard
                  label="Material requirements"
                  value={currentDetail?.payload ? String(materials.length) : "—"}
                  hint="Selected work order · pinned BOM"
                />
              </div>

              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle>Work-order register</CardTitle>
                      <CardDescription>
                        Review order priority, dates, production output totals and the detailed operation route.
                      </CardDescription>
                    </div>
                    <Badge tone="neutral">Maximum 100 rows</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-4 max-w-sm">
                    <label htmlFor="production-work-order-status" className="block text-xs font-semibold text-slate-700">
                      Work-order status
                    </label>
                    <select
                      id="production-work-order-status"
                      value={workOrderStatus}
                      onChange={(event) => changeStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                    >
                      {WORK_ORDER_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  {currentList?.error ? (
                    <Alert tone="danger" title="Could not load work orders">{currentList.error}</Alert>
                  ) : loadingList ? (
                    <div className="space-y-3" aria-label="Loading work orders">
                      {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
                    </div>
                  ) : items.length === 0 ? (
                    <EmptyState
                      title="No work orders returned"
                      description="No work orders were returned for this factory and the current status filter."
                    />
                  ) : (
                    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                      <div className="space-y-2">
                        {items.map((item) => {
                          const id = valueText(item.id, "");
                          const selected = id !== "" && id === selectedWorkOrderId;
                          const good = Number(item.good_quantity ?? 0);
                          const scrap = Number(item.scrap_quantity ?? 0);
                          return (
                            <button
                              type="button"
                              key={id}
                              disabled={!id}
                              onClick={() => setSelection({ scopeKey, workOrderId: id })}
                              aria-pressed={selected}
                              className={[
                                "w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                                selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                              ].join(" ")}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-semibold text-slate-950">{valueText(item.work_order_number)}</p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    Priority {valueText(item.priority)} · {valueText(item.operation_count, "0")} operations
                                  </p>
                                </div>
                                <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600">
                                <span>Target: {formatQuantity(item.target_quantity)}</span>
                                <span>Good: {formatQuantity(item.good_quantity)}</span>
                                <span>Scrap: {formatQuantity(item.scrap_quantity)}</span>
                                <span>Due: {formatDate(item.due_date)}</span>
                              </div>
                              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-label="Reported good output against target">
                                <div
                                  className="h-full rounded-full bg-brand-600"
                                  style={{ width: String(Math.max(0, Math.min(100, Number.isFinite(good) && Number(item.target_quantity) > 0 ? good / Number(item.target_quantity) * 100 : 0))) + "%" }}
                                />
                              </div>
                              <p className="mt-1 text-[11px] text-slate-500">
                                {Number.isFinite(good) && Number(item.target_quantity) > 0
                                  ? Math.round(good / Number(item.target_quantity) * 100) + "% good output reported"
                                  : "No good output reported"}
                                {scrap > 0 ? " · Scrap " + formatQuantity(scrap) : ""}
                              </p>
                            </button>
                          );
                        })}
                        <p className="pt-1 text-[11px] text-slate-500">
                          Showing {items.length} of up to 100 work orders returned.
                        </p>
                      </div>

                      <div className="min-w-0">
                        {!selectedWorkOrderId || !selectedWorkOrder ? (
                          <EmptyState
                            title="Select a work order"
                            description="Choose a work order to inspect its pinned material requirements, operation route and recorded output."
                          />
                        ) : loadingDetail ? (
                          <div className="h-80 animate-pulse rounded-xl bg-slate-100" aria-label="Loading work-order detail" />
                        ) : currentDetail?.error ? (
                          <Alert tone="danger" title="Could not load work-order detail">{currentDetail.error}</Alert>
                        ) : currentDetail?.payload ? (
                          <div className="space-y-4">
                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Work-order detail</p>
                                  <h3 className="mt-1 text-lg font-semibold text-slate-950">{valueText(detail.work_order_number)}</h3>
                                  <p className="mt-1 text-xs text-slate-500">
                                    Priority {valueText(detail.priority)} · Version {valueText(detail.row_version)}
                                  </p>
                                </div>
                                <StatusBadge status={valueText(detail.status, "UNKNOWN")} />
                              </div>
                              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                                <DetailField label="Target quantity" value={formatQuantity(detail.target_quantity)} />
                                <DetailField label="Processed quantity" value={formatQuantity(detail.processed_quantity)} />
                                <DetailField label="Good quantity" value={formatQuantity(detail.good_quantity)} />
                                <DetailField label="Scrap quantity" value={formatQuantity(detail.scrap_quantity)} />
                                <DetailField label="Yield" value={detail.yield_percentage === undefined ? "—" : formatQuantity(detail.yield_percentage) + "%"} />
                                <DetailField label="Stock posted" value={formatQuantity(detail.finished_good_stock_posted_quantity)} />
                                <DetailField label="Planned start" value={formatDate(detail.planned_start_date)} />
                                <DetailField label="Due date" value={formatDate(detail.due_date)} />
                                <DetailField label="Created" value={formatDateTime(detail.created_at)} />
                                <DetailField label="Last updated" value={formatDateTime(detail.updated_at)} />
                              </dl>
                              {detail.hold_reason ? (
                                <Alert tone="warning" title="Work order on hold">
                                  {valueText(detail.hold_reason)}
                                </Alert>
                              ) : null}
                              {detail.notes ? (
                                <div className="mt-3">
                                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Planning notes</p>
                                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{valueText(detail.notes)}</p>
                                </div>
                              ) : null}
                            </section>

                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="font-semibold text-slate-950">Pinned material requirements</h3>
                                <Badge tone="neutral">{materials.length} returned</Badge>
                              </div>
                              {materials.length === 0 ? (
                                <p className="mt-3 text-sm text-slate-500">No material requirements were returned for this work order.</p>
                              ) : (
                                <div className="mt-3 space-y-2">
                                  {materials.map((material) => (
                                    <article key={valueText(material.requirement_id)} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div>
                                          <p className="text-sm font-semibold text-slate-900">
                                            {valueText(material.component_sku)} · {valueText(material.component_name)}
                                          </p>
                                          <p className="mt-1 text-xs text-slate-500">BOM line {valueText(material.line_number)}</p>
                                        </div>
                                        <Badge tone="neutral">{valueText(material.component_unit)}</Badge>
                                      </div>
                                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-3">
                                        <span>Required: {formatQuantity(material.required_quantity)}</span>
                                        <span>Base per: {formatQuantity(material.base_quantity_per)}</span>
                                        <span>Yield: {formatQuantity(material.expected_yield_percent)}%</span>
                                        <span>Wastage: {formatQuantity(material.wastage_percent)}%</span>
                                        <span>Reservation records: {asRecords(material.reservations).length}</span>
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>

                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="font-semibold text-slate-950">Operation route</h3>
                                <Badge tone="neutral">{operations.length} steps returned</Badge>
                              </div>
                              {operations.length === 0 ? (
                                <p className="mt-3 text-sm text-slate-500">No routing operations were returned.</p>
                              ) : (
                                <div className="mt-3 space-y-2">
                                  {operations.map((operation) => (
                                    <article key={valueText(operation.id)} className="rounded-lg border border-slate-100 bg-white p-3">
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                                            Step {valueText(operation.step_number)} · {valueText(operation.operation_code)}
                                          </p>
                                          <p className="mt-1 font-semibold text-slate-900">{valueText(operation.operation_name)}</p>
                                          <p className="mt-1 text-xs text-slate-500">
                                            {valueText(operation.work_centre_code)} · {valueText(operation.work_centre_name)}
                                          </p>
                                        </div>
                                        <StatusBadge status={valueText(operation.status, "UNKNOWN")} />
                                      </div>
                                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-3">
                                        <span>Setup: {formatQuantity(operation.setup_minutes)} min</span>
                                        <span>Run/unit: {formatQuantity(operation.run_minutes_per_unit)} min</span>
                                        <span>Actual run: {formatQuantity(operation.actual_run_minutes)} min</span>
                                        <span>Downtime: {formatQuantity(operation.downtime_minutes)} min</span>
                                        <span>WIP: {formatQuantity(operation.wip_quantity)}</span>
                                        <span>Good: {formatQuantity(operation.reported_good_quantity)}</span>
                                        <span>Scrap: {formatQuantity(operation.reported_scrap_quantity)}</span>
                                      </div>
                                      {operation.is_quality_gate === true ? (
                                        <p className="mt-2 text-xs font-semibold text-amber-700">Quality gate operation</p>
                                      ) : null}
                                      {operation.required_skill ? (
                                        <p className="mt-1 text-xs text-slate-500">Required skill: {valueText(operation.required_skill)}</p>
                                      ) : null}
                                      {operation.instructions ? (
                                        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-600">{valueText(operation.instructions)}</p>
                                      ) : null}
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              <div className="mb-5 grid gap-3 sm:grid-cols-3">
                <MetricCard
                  label="Work orders considered"
                  value={formatQuantity(radarPayload.work_order_count)}
                  hint="Server-selected active work-order demand"
                />
                <MetricCard
                  label="Material requirements"
                  value={formatQuantity(radarPayload.requirement_count)}
                  hint="Rows returned from the priority-allocated radar"
                />
                <MetricCard
                  label="Rows with projected shortage"
                  value={String(shortages.length)}
                  hint="Based only on server-returned projected shortage quantities"
                />
              </div>

              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle>Material shortage radar</CardTitle>
                      <CardDescription>
                        Server-calculated material readiness using eligible on-hand stock, existing reservations and approved purchase-order supply.
                      </CardDescription>
                    </div>
                    <Badge tone="info">Read only · maximum 100 work orders</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {currentList?.error ? (
                    <Alert tone="danger" title="Could not load material readiness">{currentList.error}</Alert>
                  ) : loadingList ? (
                    <div className="space-y-3" aria-label="Loading material readiness">
                      {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
                    </div>
                  ) : items.length === 0 ? (
                    <EmptyState
                      title="No material requirements returned"
                      description="The API returned no material demand for active work orders in this factory."
                    />
                  ) : (
                    <>
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>As of {formatDate(radarPayload.as_of_date)}</span>
                        <span>·</span>
                        <span>{displayLabel(radarPayload.planning_basis)}</span>
                      </div>
                      <div className="space-y-3">
                        {items.map((item) => {
                          const shortage = Number(item.projected_shortage_quantity ?? 0);
                          return (
                            <article
                              key={valueText(item.requirement_id, valueText(item.work_order_id) + ":" + valueText(item.component_item_id))}
                              className="rounded-xl border border-slate-200 p-4"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-semibold text-slate-950">
                                    {valueText(item.component_sku)} · {valueText(item.component_name)}
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {valueText(item.work_order_number)} · Step line {valueText(item.line_number)}
                                  </p>
                                </div>
                                <Badge tone={shortage > 0 ? "warning" : "success"}>
                                  {shortage > 0 ? "Projected shortage" : "Covered"}
                                </Badge>
                              </div>
                              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                <DetailField label="Required" value={formatQuantity(item.required_quantity) + " " + valueText(item.unit)} />
                                <DetailField label="Allocated" value={formatQuantity(item.allocated_quantity)} />
                                <DetailField label="Consumed" value={formatQuantity(item.consumed_quantity)} />
                                <DetailField label="Unfulfilled" value={formatQuantity(item.unfulfilled_quantity)} />
                                <DetailField label="Eligible free stock pool" value={formatQuantity(item.eligible_on_hand_pool_quantity)} />
                                <DetailField label="Projected on-hand" value={formatQuantity(item.projected_on_hand_quantity)} />
                                <DetailField label="Approved PO open pool" value={formatQuantity(item.approved_po_open_pool_quantity)} />
                                <DetailField label="Projected incoming" value={formatQuantity(item.projected_incoming_quantity)} />
                                <DetailField label="Projected shortage" value={formatQuantity(item.projected_shortage_quantity)} />
                                <DetailField label="Projected ready date" value={formatDate(item.projected_material_ready_date)} />
                                <DetailField label="Shortage date" value={formatDate(item.shortage_date)} />
                                <DetailField label="Work-order due" value={formatDate(item.due_date)} />
                              </div>
                              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                                <span>Allocation: {displayLabel(item.allocation_policy)}</span>
                                <span>Traceability: {item.traceability_required === true ? "Required" : "Not required by returned policy"}</span>
                                <span>PO unit mismatches: {formatQuantity(item.incoming_unit_mismatch_line_count)}</span>
                                <span>Basis: {displayLabel(item.material_ready_basis)}</span>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </>
      ) : null}
    </main>
  );
}
