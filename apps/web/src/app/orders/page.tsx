"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createOrdersWorkspaceClient } from "@/lib/orders-workspace.mjs";
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

type OrderPageResult = {
  key: string;
  status: "success" | "error";
  items?: JsonRecord[];
  pagination?: JsonRecord;
  message?: string;
};

type OrderDetailResult = {
  key: string;
  status: "success" | "error";
  order?: JsonRecord;
  reports?: JsonRecord[];
  reportMessage?: string;
  message?: string;
};

const ORDER_STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "IN_PROGRESS", label: "In progress" },
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

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function formatNumber(value: unknown): string {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(number)
    : valueText(value);
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
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

export default function SalesOrdersPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selection, setSelection] = useState<{ scopeKey: string; orderId: string } | null>(null);

  const [listResult, setListResult] = useState<OrderPageResult | null>(null);
  const [detailResult, setDetailResult] = useState<OrderDetailResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canRead = connected && hasPermission("orders.read");
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);

  const listKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canRead,
    page,
    statusFilter,
    appliedSearch,
    refreshVersion,
  ]), [
    sessionStatus,
    snapshot?.tenant.id,
    activeFactoryId,
    canRead,
    page,
    statusFilter,
    appliedSearch,
    refreshVersion,
  ]);

  const activeScopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const selectedOrderId = selection?.scopeKey === activeScopeKey ? selection.orderId : "";
  const detailKey = useMemo(() => JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    canRead,
    selectedOrderId,
  ]), [sessionStatus, snapshot?.tenant.id, activeFactoryId, canRead, selectedOrderId]);

  const currentList = listResult?.key === listKey ? listResult : null;
  const currentDetail = detailResult?.key === detailKey ? detailResult : null;
  const loadingList = canRead && Boolean(activeFactoryId) && currentList === null;
  const loadingDetail = Boolean(selectedOrderId) && canRead && Boolean(activeFactoryId) && currentDetail === null;

  useEffect(() => {
    if (!canRead || !activeFactoryId) return;

    let active = true;
    const client = createOrdersWorkspaceClient({ request });
    void client.listOrders({
      page,
      limit: 20,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(appliedSearch ? { search: appliedSearch } : {}),
    }).then((payload) => {
      if (!active) return;
      const response = asRecord(payload);
      const pagination = asRecord(response.pagination);
      setListResult({
        key: listKey,
        status: "success",
        items: asRecords(response.items),
        pagination,
      });
    }).catch((cause: unknown) => {
      if (!active) return;
      setListResult({
        key: listKey,
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not load sales orders.",
      });
    });

    return () => {
      active = false;
    };
  }, [canRead, activeFactoryId, request, page, statusFilter, appliedSearch, refreshVersion, listKey]);

  useEffect(() => {
    if (!canRead || !activeFactoryId || !selectedOrderId) return;

    let active = true;
    const client = createOrdersWorkspaceClient({ request });
    const load = async () => {
      const [orderResult, reportResult] = await Promise.allSettled([
        client.getOrder(selectedOrderId),
        client.listProductionReports(selectedOrderId, { limit: 50 }),
      ]);
      if (!active) return;

      if (orderResult.status === "rejected") {
        setDetailResult({
          key: detailKey,
          status: "error",
          message: orderResult.reason instanceof Error
            ? orderResult.reason.message
            : "Could not load order details.",
        });
        return;
      }

      setDetailResult({
        key: detailKey,
        status: "success",
        order: asRecord(orderResult.value),
        reports: reportResult.status === "fulfilled"
          ? asRecords(reportResult.value)
          : [],
        ...(reportResult.status === "rejected"
          ? {
              reportMessage: reportResult.reason instanceof Error
                ? reportResult.reason.message
                : "Production reports are currently unavailable.",
            }
          : {}),
      });
    };
    void load();

    return () => {
      active = false;
    };
  }, [canRead, activeFactoryId, selectedOrderId, request, detailKey]);

  const items = currentList?.status === "success" ? currentList.items ?? [] : [];
  const pagination = asRecord(currentList?.pagination);
  const total = typeof pagination.total === "number" ? pagination.total : Number(pagination.total ?? 0);
  const totalPages = typeof pagination.total_pages === "number"
    ? pagination.total_pages
    : Number(pagination.total_pages ?? 0);
  const selectedOrder = currentDetail?.status === "success"
    ? asRecord(currentDetail.order)
    : {};
  const orderLines = asRecords(selectedOrder.lines);
  const reports = currentDetail?.status === "success" ? currentDetail.reports ?? [] : [];
  const orderMetaFields: Array<[string, unknown]> = [
    ["Customer reference", selectedOrder.customer_reference],
    ["Order date", formatDate(selectedOrder.order_date)],
    ["Requested delivery", formatDate(selectedOrder.requested_delivery_date)],
    ["Version", selectedOrder.version],
    ["Currency", selectedOrder.currency],
    ["Created", formatDate(selectedOrder.created_at)],
    ["Last updated", formatDate(selectedOrder.updated_at)],
  ];

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(searchInput.trim());
  }

  function handleStatusChange(value: string) {
    setPage(1);
    setStatusFilter(value);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Commercial operations · order intake"
        title="Sales Orders"
        description="Search factory-scoped customer orders, inspect order lines and review recorded production output without changing operational records."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={() => setRefreshVersion((value) => value + 1)}
              disabled={!canRead || !activeFactoryId || loadingList}
            >
              Refresh orders
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Alert tone={connected && activeFactoryId ? "success" : "warning"} title="Workspace scope">
          {connected && snapshot
            ? snapshot.tenant.name + (activeFactory ? " · " + activeFactory.code + " — " + activeFactory.name : " · Select an active factory")
            : "Connect an existing FactoryOS session to load customer orders."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">Open session setup</Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canRead ? "success" : "info"} title="Order read permission">
          {canRead
            ? "IAM permission orders.read is present. The API still checks tenant, factory and permission scope on every request."
            : "This workspace requires orders.read from the current IAM permission snapshot."}
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose a factory returned by the authenticated IAM session. Orders are never loaded across all factories."
        />
      ) : null}

      {connected && activeFactoryId && !canRead ? (
        <EmptyState
          title="Order access is not available"
          description="The current IAM permission snapshot does not include orders.read. Ask an authorized administrator to review your access."
        />
      ) : null}

      {canRead && activeFactoryId ? (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <MetricCard label="Matching orders" value={Number.isFinite(total) ? formatNumber(total) : "—"} hint="Current search and status filters" />
            <MetricCard label="Current page" value={String(page)} hint={totalPages > 0 ? "of " + totalPages : "No result pages"} />
            <MetricCard label="Page size" value="20" hint="Orders requested per page" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Order board</CardTitle>
              <CardDescription>Search by order number, customer name or customer reference. Results are limited to the selected factory.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submitSearch} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto] md:items-end">
                <div>
                  <label htmlFor="order-search" className="block text-sm font-semibold text-slate-800">Search orders</label>
                  <input
                    id="order-search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Order number, customer or reference"
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  />
                </div>
                <div>
                  <label htmlFor="order-status-filter" className="block text-sm font-semibold text-slate-800">Status</label>
                  <select
                    id="order-status-filter"
                    value={statusFilter}
                    onChange={(event) => handleStatusChange(event.target.value)}
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    {ORDER_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <Button type="submit">Search</Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSearchInput("");
                      setAppliedSearch("");
                      setStatusFilter("");
                      setPage(1);
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </form>

              {currentList?.status === "error" ? (
                <Alert tone="danger" title="Could not load orders" className="mt-5">{currentList.message}</Alert>
              ) : null}

              {loadingList ? (
                <div className="mt-5 space-y-3" aria-label="Loading orders">
                  {[1, 2, 3].map((item) => (
                    <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />
                  ))}
                </div>
              ) : currentList?.status === "success" && items.length === 0 ? (
                <div className="mt-5">
                  <EmptyState
                    title="No matching orders"
                    description="No orders were returned for this factory and filter combination. Clear the filters or search with another order reference."
                  />
                </div>
              ) : currentList?.status === "success" ? (
                <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
                  <div className="hidden grid-cols-[1.1fr_1fr_0.8fr_0.9fr_0.8fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500 lg:grid">
                    <span>Order</span>
                    <span>Customer</span>
                    <span>Order date</span>
                    <span>Requested delivery</span>
                    <span>Status</span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {items.map((order) => {
                      const selected = selectedOrderId === valueText(order.id, "");
                      return (
                        <button
                          type="button"
                          key={valueText(order.id)}
                          onClick={() => setSelection({ scopeKey: activeScopeKey, orderId: valueText(order.id, "") })}
                          aria-pressed={selected}
                          className={[
                            "grid w-full gap-2 px-4 py-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-brand-700",
                            "lg:grid-cols-[1.1fr_1fr_0.8fr_0.9fr_0.8fr] lg:items-center lg:gap-3",
                            selected ? "bg-brand-50/70" : "bg-white",
                          ].join(" ")}
                        >
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-950">{valueText(order.order_number, "Unnamed order")}</p>
                            <p className="mt-1 break-all font-mono text-[10px] text-slate-400">{valueText(order.customer_reference, "No customer reference")}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800">{valueText(order.customer_name, "Customer not recorded")}</p>
                            <p className="mt-1 text-xs text-slate-500">{valueText(order.currency, "")}</p>
                          </div>
                          <div className="text-sm text-slate-600 lg:text-xs">{formatDate(order.order_date)}</div>
                          <div className="text-sm text-slate-600 lg:text-xs">{formatDate(order.requested_delivery_date)}</div>
                          <div><StatusBadge status={valueText(order.status, "UNKNOWN")} /></div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  {items.length ? "Showing " + items.length + " of " + formatNumber(total) + " matching orders" : "No order rows on this page"}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1 || loadingList}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    Previous
                  </Button>
                  <span className="min-w-16 text-center text-xs font-semibold tabular-nums text-slate-600">
                    {page} / {Math.max(totalPages, 1)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={totalPages === 0 || page >= totalPages || loadingList}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {selectedOrderId ? (
            <section className="mt-7 space-y-5" aria-label="Selected order details">
              {currentDetail?.status === "error" ? (
                <Alert tone="danger" title="Could not load order details">{currentDetail.message}</Alert>
              ) : null}
              {loadingDetail ? (
                <div className="h-64 animate-pulse rounded-2xl bg-slate-100" aria-label="Loading order details" />
              ) : currentDetail?.status === "success" ? (
                <>
                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.15em] text-brand-700">Selected order</p>
                          <CardTitle className="mt-1 text-xl">{valueText(selectedOrder.order_number)}</CardTitle>
                          <CardDescription>{valueText(selectedOrder.customer_name, "Customer not recorded")}</CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={valueText(selectedOrder.status, "UNKNOWN")} />
                          <Button size="sm" variant="outline" onClick={() => setSelectedOrderId("")}>Close details</Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        {orderMetaFields.map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                            <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value)}</dd>
                          </div>
                        ))}
                      </dl>
                      {typeof selectedOrder.notes === "string" && selectedOrder.notes.trim() ? (
                        <div className="mt-5 rounded-xl bg-slate-50 p-4">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Order notes</p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{selectedOrder.notes}</p>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle>Order lines</CardTitle>
                        <Badge tone="neutral">{orderLines.length} lines</Badge>
                      </div>
                      <CardDescription>Products and quantities recorded on this customer order.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {orderLines.length ? (
                        <div className="space-y-3">
                          {orderLines.map((line, index) => (
                            <article key={valueText(line.id, "line-" + index)} className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-slate-950">
                                    {valueText(line.product_name, "Product not recorded")}
                                  </p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {valueText(line.product_code, "No product code")} · Line {valueText(line.line_number, String(index + 1))}
                                  </p>
                                </div>
                                <Badge tone="info">{formatNumber(line.quantity)} {valueText(line.unit, "")}</Badge>
                              </div>
                              <dl className="mt-4 grid gap-3 sm:grid-cols-3">
                                <div>
                                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Requested delivery</dt>
                                  <dd className="mt-1 text-xs font-medium text-slate-700">{formatDate(line.requested_delivery_date)}</dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Unit price</dt>
                                  <dd className="mt-1 text-xs font-medium text-slate-700">
                                    {line.unit_price === null || line.unit_price === undefined ? "Not recorded" : formatNumber(line.unit_price) + " " + valueText(selectedOrder.currency, "")}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Inventory link</dt>
                                  <dd className="mt-1 break-all font-mono text-[10px] text-slate-500">{valueText(line.inventory_item_id, "Not linked")}</dd>
                                </div>
                              </dl>
                              {typeof line.notes === "string" && line.notes.trim() ? (
                                <p className="mt-3 text-xs leading-5 text-slate-600">{line.notes}</p>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <EmptyState title="No order lines returned" description="The order detail endpoint returned no line records for this order." />
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle>Production output history</CardTitle>
                        <Badge tone="neutral">{reports.length} reports</Badge>
                      </div>
                      <CardDescription>Persisted good output, scrap and yield summaries for this order.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {currentDetail.reportMessage ? (
                        <Alert tone="warning" title="Production reports unavailable">{currentDetail.reportMessage}</Alert>
                      ) : reports.length ? (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[680px] text-left text-sm">
                            <thead>
                              <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                <th className="px-3 py-3">Recorded</th>
                                <th className="px-3 py-3">Line</th>
                                <th className="px-3 py-3">Good qty</th>
                                <th className="px-3 py-3">Scrap qty</th>
                                <th className="px-3 py-3">Cumulative yield</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {reports.map((report, index) => {
                                const line = orderLines.find((item) => item.id === report.order_line_id);
                                const yieldValue = report.yield_percent;
                                return (
                                  <tr key={valueText(report.id, "report-" + index)}>
                                    <td className="px-3 py-3 text-xs text-slate-600">{formatDate(report.created_at)}</td>
                                    <td className="px-3 py-3 text-xs font-medium text-slate-800">{valueText(line?.product_code, "Order line")}</td>
                                    <td className="px-3 py-3 tabular-nums text-slate-700">{formatNumber(report.good_quantity)}</td>
                                    <td className="px-3 py-3 tabular-nums text-slate-700">{formatNumber(report.scrap_quantity)}</td>
                                    <td className="px-3 py-3">
                                      {yieldValue === null || yieldValue === undefined
                                        ? "—"
                                        : <Badge tone="neutral">{formatNumber(yieldValue)}%</Badge>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <EmptyState title="No production output recorded" description="There are no production reports recorded for this order yet, or the order is not in a reporting state." />
                      )}
                    </CardContent>
                  </Card>

                  <Alert tone="info" title="Operational records are read-only">
                    This workspace only reads orders and production reports. Order status changes, production reporting, inventory reservations and delivery-risk decisions must use their separately authorized workflows.
                  </Alert>
                </>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
