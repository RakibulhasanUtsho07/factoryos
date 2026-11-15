"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import { createProcurementWorkspaceClient } from "@/lib/procurement-workspace.mjs";
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
type ProcurementView = "purchase-orders" | "suppliers";
type ListResult = {
  key: string;
  items: JsonRecord[];
  pagination: JsonRecord;
  payload?: JsonRecord;
  error: string;
};
type DetailResult = {
  key: string;
  payload?: JsonRecord;
  error: string;
};
type ReceiptListResult = {
  key: string;
  items: JsonRecord[];
  error: string;
};

const PURCHASE_ORDER_STATUS_OPTIONS = [
  { value: "", label: "All purchase-order statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

const SUPPLIER_STATUS_OPTIONS = [
  { value: "", label: "All supplier statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DISABLED", label: "Disabled" },
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
  if (typeof value !== "string" || !value) return "Not recorded";
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

function formatMoney(value: unknown, currency: unknown): string {
  const amount = typeof value === "number" ? value : Number(value);
  const code = valueText(currency, "").toUpperCase();
  if (!Number.isFinite(amount)) return "—";
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return formatQuantity(amount) + " " + code;
    }
  }
  return formatQuantity(amount) + (code ? " " + code : "");
}

function getItems(payload: unknown): JsonRecord[] {
  return asRecords(asRecord(payload).items);
}

function getPagination(payload: unknown): JsonRecord {
  return asRecord(asRecord(payload).pagination);
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-slate-800">{valueText(value)}</dd>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  onPrevious,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
      <p className="text-xs text-slate-500">
        Page {page} of {totalPages} · {total} matching records
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={onPrevious}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={totalPages === 0 || page >= totalPages} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}

export default function ProcurementWorkbenchPage() {
  const {
    status: sessionStatus,
    snapshot,
    activeFactoryId,
    request,
    hasPermission,
  } = useFactoryOsSession();

  const [view, setView] = useState<ProcurementView>("purchase-orders");
  const [purchaseOrderStatus, setPurchaseOrderStatus] = useState("");
  const [purchaseOrderSearchInput, setPurchaseOrderSearchInput] = useState("");
  const [purchaseOrderSearch, setPurchaseOrderSearch] = useState("");
  const [purchaseOrderPage, setPurchaseOrderPage] = useState(1);
  const [supplierStatus, setSupplierStatus] = useState("");
  const [supplierSearchInput, setSupplierSearchInput] = useState("");
  const [supplierSearch, setSupplierSearch] = useState("");
  const [supplierPage, setSupplierPage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selection, setSelection] = useState<{ scopeKey: string; recordId: string } | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<{ scopeKey: string; receiptId: string } | null>(null);
  const [listResult, setListResult] = useState<ListResult | null>(null);
  const [detailResult, setDetailResult] = useState<DetailResult | null>(null);
  const [receiptListResult, setReceiptListResult] = useState<ReceiptListResult | null>(null);
  const [receiptDetailResult, setReceiptDetailResult] = useState<DetailResult | null>(null);

  const connected = sessionStatus === "connected" && snapshot !== null;
  const canReadPurchaseOrders = connected && hasPermission("purchase_orders.read");
  const canReadSuppliers = connected && hasPermission("suppliers.read");
  const canReadGoodsReceipts = connected && hasPermission("goods_receipts.read");
  const activeView: ProcurementView = view === "purchase-orders"
    ? (canReadPurchaseOrders ? "purchase-orders" : canReadSuppliers ? "suppliers" : "purchase-orders")
    : (canReadSuppliers ? "suppliers" : canReadPurchaseOrders ? "purchase-orders" : "suppliers");
  const canReadCurrentView = activeView === "purchase-orders" ? canReadPurchaseOrders : canReadSuppliers;
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const scopeKey = [snapshot?.tenant.id ?? "", activeFactoryId].join(":");
  const selectedRecordId = selection?.scopeKey === scopeKey ? selection.recordId : "";
  const selectedReceiptId = selectedReceipt?.scopeKey === scopeKey ? selectedReceipt.receiptId : "";

  const listKey = JSON.stringify([
    sessionStatus,
    snapshot?.tenant.id ?? "",
    activeFactoryId,
    activeView,
    canReadPurchaseOrders,
    canReadSuppliers,
    purchaseOrderStatus,
    purchaseOrderSearch,
    purchaseOrderPage,
    supplierStatus,
    supplierSearch,
    supplierPage,
    refreshVersion,
  ]);

  const currentList = listResult?.key === listKey ? listResult : null;
  const items = currentList?.items ?? [];
  const pagination = currentList?.pagination ?? {};
  const page = Number(pagination.page ?? 1);
  const totalPages = Number(pagination.total_pages ?? 0);
  const total = Number(pagination.total ?? 0);
  const selectedPurchaseOrder = activeView === "purchase-orders"
    ? items.find((item) => valueText(item.id, "") === selectedRecordId) ?? null
    : null;
  const selectedSupplier = activeView === "suppliers"
    ? items.find((item) => valueText(item.id, "") === selectedRecordId) ?? null
    : null;
  const selectedPurchaseOrderId = selectedPurchaseOrder ? valueText(selectedPurchaseOrder.id, "") : "";
  const detailKey = JSON.stringify([listKey, activeView, selectedPurchaseOrderId]);
  const currentDetail = detailResult?.key === detailKey ? detailResult : null;
  const receiptListKey = JSON.stringify([detailKey, selectedPurchaseOrderId, canReadGoodsReceipts]);
  const currentReceiptList = receiptListResult?.key === receiptListKey ? receiptListResult : null;
  const receiptItems = currentReceiptList?.items ?? [];
  const receiptDetailKey = JSON.stringify([receiptListKey, selectedReceiptId]);
  const currentReceiptDetail = receiptDetailResult?.key === receiptDetailKey ? receiptDetailResult : null;

  const loadingList = connected && Boolean(activeFactoryId) && canReadCurrentView && currentList === null;
  const loadingDetail = activeView === "purchase-orders" && Boolean(selectedPurchaseOrderId)
    && currentDetail === null;
  const loadingReceipts = Boolean(selectedPurchaseOrderId) && canReadGoodsReceipts
    && currentReceiptList === null;
  const loadingReceiptDetail = Boolean(selectedReceiptId) && currentReceiptDetail === null;

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadCurrentView) return;
    let active = true;
    const client = createProcurementWorkspaceClient({ request });

    const load = async () => {
      try {
        const payload = activeView === "purchase-orders"
          ? await client.listPurchaseOrders({
            page: purchaseOrderPage,
            limit: 20,
            status: purchaseOrderStatus || undefined,
            search: purchaseOrderSearch || undefined,
          })
          : await client.listSuppliers({
            page: supplierPage,
            limit: 20,
            status: supplierStatus || undefined,
            search: supplierSearch || undefined,
          });

        if (!active) return;
        setListResult({
          key: listKey,
          items: getItems(payload),
          pagination: getPagination(payload),
          payload: asRecord(payload),
          error: "",
        });
      } catch (cause) {
        if (!active) return;
        setListResult({
          key: listKey,
          items: [],
          pagination: {},
          error: cause instanceof Error ? cause.message : "Procurement records could not be loaded.",
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
    canReadCurrentView,
    request,
    activeView,
    purchaseOrderPage,
    purchaseOrderStatus,
    purchaseOrderSearch,
    supplierPage,
    supplierStatus,
    supplierSearch,
    refreshVersion,
    listKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadPurchaseOrders
      || activeView !== "purchase-orders" || !selectedPurchaseOrderId) return;

    let active = true;
    const client = createProcurementWorkspaceClient({ request });
    void client.getPurchaseOrder(selectedPurchaseOrderId).then((payload) => {
      if (!active) return;
      setDetailResult({ key: detailKey, payload: asRecord(payload), error: "" });
    }).catch((cause: unknown) => {
      if (!active) return;
      setDetailResult({
        key: detailKey,
        error: cause instanceof Error ? cause.message : "Purchase-order detail could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadPurchaseOrders,
    request,
    activeView,
    selectedPurchaseOrderId,
    detailKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadPurchaseOrders
      || !canReadGoodsReceipts || activeView !== "purchase-orders" || !selectedPurchaseOrderId) return;

    let active = true;
    const client = createProcurementWorkspaceClient({ request });
    void client.listGoodsReceipts(selectedPurchaseOrderId, { limit: 50 }).then((payload) => {
      if (!active) return;
      setReceiptListResult({
        key: receiptListKey,
        items: asRecords(asRecord(payload).receipts),
        error: "",
      });
    }).catch((cause: unknown) => {
      if (!active) return;
      setReceiptListResult({
        key: receiptListKey,
        items: [],
        error: cause instanceof Error ? cause.message : "Goods-receipt history could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadPurchaseOrders,
    canReadGoodsReceipts,
    request,
    activeView,
    selectedPurchaseOrderId,
    receiptListKey,
  ]);

  useEffect(() => {
    if (!connected || !activeFactoryId || !canReadGoodsReceipts
      || activeView !== "purchase-orders" || !selectedReceiptId) return;

    let active = true;
    const client = createProcurementWorkspaceClient({ request });
    void client.getGoodsReceipt(selectedReceiptId).then((payload) => {
      if (!active) return;
      setReceiptDetailResult({ key: receiptDetailKey, payload: asRecord(payload), error: "" });
    }).catch((cause: unknown) => {
      if (!active) return;
      setReceiptDetailResult({
        key: receiptDetailKey,
        error: cause instanceof Error ? cause.message : "Goods-receipt detail could not be loaded.",
      });
    });

    return () => {
      active = false;
    };
  }, [
    connected,
    activeFactoryId,
    canReadGoodsReceipts,
    request,
    activeView,
    selectedReceiptId,
    receiptDetailKey,
  ]);

  const detail = asRecord(currentDetail?.payload);
  const poLines = asRecords(detail.lines);
  const poHistory = asRecords(detail.status_history);
  const receiptDetail = asRecord(currentReceiptDetail?.payload);
  const receiptLines = asRecords(receiptDetail.lines);

  function refresh() {
    setRefreshVersion((value) => value + 1);
  }

  function changeView(next: ProcurementView) {
    setSelection(null);
    setSelectedReceipt(null);
    setView(next);
  }

  function changePurchaseOrderStatus(value: string) {
    setSelection(null);
    setSelectedReceipt(null);
    setPurchaseOrderPage(1);
    setPurchaseOrderStatus(value);
  }

  function changeSupplierStatus(value: string) {
    setSelection(null);
    setSupplierPage(1);
    setSupplierStatus(value);
  }

  function submitPurchaseOrderSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelection(null);
    setSelectedReceipt(null);
    setPurchaseOrderPage(1);
    setPurchaseOrderSearch(purchaseOrderSearchInput.trim());
  }

  function submitSupplierSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelection(null);
    setSupplierPage(1);
    setSupplierSearch(supplierSearchInput.trim());
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Procurement · suppliers · receiving"
        title="Procurement Workbench"
        description="Review factory purchase orders, tenant supplier records and posted goods-receipt evidence."
        actions={
          <>
            <Badge tone="info">Read only</Badge>
            <Button
              variant="outline"
              onClick={refresh}
              disabled={!connected || !activeFactoryId || !canReadCurrentView || loadingList || loadingDetail || loadingReceipts}
            >
              Refresh procurement
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
            : "Connect an existing FactoryOS session to inspect procurement records."}
          {!connected ? (
            <p className="mt-2">
              <Link href="/session" className="font-semibold underline underline-offset-2">
                Open session setup
              </Link>
            </p>
          ) : null}
        </Alert>
        <Alert tone={canReadPurchaseOrders ? "success" : "info"} title="Procurement read permissions">
          {[
            canReadPurchaseOrders ? "purchase_orders.read" : null,
            canReadSuppliers ? "suppliers.read" : null,
            canReadGoodsReceipts ? "goods_receipts.read" : null,
          ].filter(Boolean).join(" · ") || "No procurement read permissions are present in the current IAM snapshot."}
          {" "}Purchase orders and posted receipts are factory-scoped; the supplier directory is tenant-scoped. The API remains authoritative for all access decisions.
        </Alert>
      </div>

      {connected && !activeFactoryId ? (
        <EmptyState
          title="Select an active factory"
          description="Choose an active factory from the authenticated IAM session before opening the procurement workspace."
        />
      ) : null}

      {connected && activeFactoryId && !canReadPurchaseOrders && !canReadSuppliers ? (
        <EmptyState
          title="Procurement access is not available"
          description="The current IAM permission snapshot does not include purchase_orders.read or suppliers.read."
        />
      ) : null}

      {connected && activeFactoryId && (canReadPurchaseOrders || canReadSuppliers) ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Procurement workspaces">
            {canReadPurchaseOrders ? (
              <button
                type="button"
                role="tab"
                aria-selected={activeView === "purchase-orders"}
                onClick={() => changeView("purchase-orders")}
                className={[
                  "min-h-10 rounded-lg border px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                  activeView === "purchase-orders"
                    ? "border-brand-300 bg-brand-50 text-brand-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                ].join(" ")}
              >
                Purchase orders
              </button>
            ) : null}
            {canReadSuppliers ? (
              <button
                type="button"
                role="tab"
                aria-selected={activeView === "suppliers"}
                onClick={() => changeView("suppliers")}
                className={[
                  "min-h-10 rounded-lg border px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                  activeView === "suppliers"
                    ? "border-brand-300 bg-brand-50 text-brand-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                ].join(" ")}
              >
                Supplier directory
              </button>
            ) : null}
          </div>

          {activeView === "purchase-orders" && canReadPurchaseOrders ? (
            <>
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle>Purchase-order register</CardTitle>
                      <CardDescription>
                        Search by PO number or supplier; review supplier, expected delivery, order value and posted receipt history.
                      </CardDescription>
                    </div>
                    <Badge tone="neutral">20 records per page</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <form onSubmit={submitPurchaseOrderSearch} className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
                    <div>
                      <label htmlFor="procurement-po-search" className="block text-xs font-semibold text-slate-700">Search PO or supplier</label>
                      <input
                        id="procurement-po-search"
                        value={purchaseOrderSearchInput}
                        onChange={(event) => setPurchaseOrderSearchInput(event.target.value)}
                        maxLength={100}
                        placeholder="PO number, supplier name or code"
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="procurement-po-status" className="block text-xs font-semibold text-slate-700">Purchase-order status</label>
                      <select
                        id="procurement-po-status"
                        value={purchaseOrderStatus}
                        onChange={(event) => changePurchaseOrderStatus(event.target.value)}
                        className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                      >
                        {PURCHASE_ORDER_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <Button type="submit" disabled={loadingList}>Search</Button>
                    </div>
                  </form>

                  {currentList?.error ? (
                    <Alert tone="danger" title="Could not load purchase orders">{currentList.error}</Alert>
                  ) : loadingList ? (
                    <div className="space-y-3" aria-label="Loading purchase orders">
                      {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
                    </div>
                  ) : items.length === 0 ? (
                    <EmptyState
                      title="No purchase orders returned"
                      description="No records matched this factory, status and search filter."
                    />
                  ) : (
                    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                      <div className="space-y-2">
                        {items.map((item) => {
                          const id = valueText(item.id, "");
                          const selected = id !== "" && id === selectedRecordId;
                          return (
                            <button
                              type="button"
                              key={id}
                              disabled={!id}
                              onClick={() => {
                                setSelection({ scopeKey, recordId: id });
                                setSelectedReceipt(null);
                              }}
                              aria-pressed={selected}
                              className={[
                                "w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                                selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                              ].join(" ")}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-semibold text-slate-950">{valueText(item.po_number)}</p>
                                  <p className="mt-1 text-sm text-slate-700">{valueText(item.supplier_name)}</p>
                                  <p className="mt-1 text-xs text-slate-500">
                                    {valueText(item.supplier_code)} · {valueText(item.currency)}
                                  </p>
                                </div>
                                <StatusBadge status={valueText(item.status, "UNKNOWN")} />
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600">
                                <span>Value: {formatMoney(item.total_amount, item.currency)}</span>
                                <span>Lines: {valueText(item.line_count, "0")}</span>
                                <span>Order date: {formatDate(item.order_date)}</span>
                                <span>Expected: {formatDate(item.expected_delivery_date)}</span>
                              </div>
                            </button>
                          );
                        })}
                        <Pagination
                          page={page}
                          totalPages={totalPages}
                          total={total}
                          onPrevious={() => {
                            setSelection(null);
                            setSelectedReceipt(null);
                            setPurchaseOrderPage((value) => Math.max(1, value - 1));
                          }}
                          onNext={() => {
                            setSelection(null);
                            setSelectedReceipt(null);
                            setPurchaseOrderPage((value) => value + 1);
                          }}
                        />
                      </div>

                      <div className="min-w-0">
                        {!selectedPurchaseOrderId || !selectedPurchaseOrder ? (
                          <EmptyState
                            title="Select a purchase order"
                            description="Choose a PO to inspect its lines, status history and posted goods receipts."
                          />
                        ) : loadingDetail ? (
                          <div className="h-80 animate-pulse rounded-xl bg-slate-100" aria-label="Loading purchase-order detail" />
                        ) : currentDetail?.error ? (
                          <Alert tone="danger" title="Could not load purchase-order detail">{currentDetail.error}</Alert>
                        ) : currentDetail?.payload ? (
                          <div className="space-y-4">
                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Purchase-order detail</p>
                                  <h3 className="mt-1 text-lg font-semibold text-slate-950">{valueText(detail.po_number)}</h3>
                                  <p className="mt-1 text-xs text-slate-500">{valueText(detail.supplier_code)} · {valueText(detail.supplier_name)}</p>
                                </div>
                                <StatusBadge status={valueText(detail.status, "UNKNOWN")} />
                              </div>
                              <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                                <DetailField label="Order date" value={formatDate(detail.order_date)} />
                                <DetailField label="Expected delivery" value={formatDate(detail.expected_delivery_date)} />
                                <DetailField label="Total value" value={formatMoney(detail.total_amount, detail.currency)} />
                                <DetailField label="Payment terms" value={valueText(detail.payment_terms_days) + " days"} />
                                <DetailField label="Lines" value={detail.line_count} />
                                <DetailField label="Version" value={detail.version} />
                                <DetailField label="Created" value={formatDateTime(detail.created_at)} />
                                <DetailField label="Updated" value={formatDateTime(detail.updated_at)} />
                              </dl>
                              {detail.notes ? (
                                <div className="mt-3">
                                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Notes</p>
                                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{valueText(detail.notes)}</p>
                                </div>
                              ) : null}
                              {detail.rejection_reason ? (
                                <Alert tone="warning" title="Rejection reason">{valueText(detail.rejection_reason)}</Alert>
                              ) : null}
                              {detail.cancellation_reason ? (
                                <Alert tone="warning" title="Cancellation reason">{valueText(detail.cancellation_reason)}</Alert>
                              ) : null}
                            </section>

                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="font-semibold text-slate-950">Purchase-order lines</h3>
                                <Badge tone="neutral">{poLines.length} returned</Badge>
                              </div>
                              {poLines.length === 0 ? (
                                <p className="mt-3 text-sm text-slate-500">No purchase-order lines were returned.</p>
                              ) : (
                                <div className="mt-3 space-y-2">
                                  {poLines.map((line) => (
                                    <article key={valueText(line.id)} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                                      <div className="flex items-start justify-between gap-2">
                                        <div>
                                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Line {valueText(line.line_number)}</p>
                                          <p className="mt-1 text-sm font-semibold text-slate-900">{valueText(line.description)}</p>
                                        </div>
                                        <p className="text-sm font-semibold text-slate-900">{formatMoney(line.line_amount, detail.currency)}</p>
                                      </div>
                                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600">
                                        <span>Qty: {formatQuantity(line.quantity)}</span>
                                        <span>Unit: {valueText(line.unit)}</span>
                                        <span>Unit price: {formatMoney(line.unit_price, detail.currency)}</span>
                                      </div>
                                      {line.notes ? <p className="mt-2 text-xs text-slate-500">{valueText(line.notes)}</p> : null}
                                    </article>
                                  ))}
                                </div>
                              )}
                            </section>

                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="font-semibold text-slate-950">Posted goods receipts</h3>
                                {canReadGoodsReceipts ? (
                                  <Badge tone="neutral">{receiptItems.length} returned</Badge>
                                ) : (
                                  <Badge tone="warning">Permission required</Badge>
                                )}
                              </div>
                              {!canReadGoodsReceipts ? (
                                <p className="mt-3 text-sm text-slate-500">
                                  Posted receipt history requires goods_receipts.read.
                                </p>
                              ) : currentReceiptList?.error ? (
                                <Alert tone="danger" title="Could not load goods receipts">{currentReceiptList.error}</Alert>
                              ) : loadingReceipts ? (
                                <div className="mt-3 space-y-2" aria-label="Loading goods receipts">
                                  {[1, 2].map((item) => <div key={item} className="h-14 animate-pulse rounded-lg bg-slate-100" />)}
                                </div>
                              ) : receiptItems.length === 0 ? (
                                <p className="mt-3 text-sm text-slate-500">No posted goods receipts were returned for this purchase order.</p>
                              ) : (
                                <div className="mt-3 space-y-2">
                                  {receiptItems.map((receipt) => {
                                    const receiptId = valueText(receipt.id, "");
                                    const selected = receiptId !== "" && receiptId === selectedReceiptId;
                                    return (
                                      <button
                                        type="button"
                                        key={receiptId}
                                        disabled={!receiptId}
                                        onClick={() => setSelectedReceipt({ scopeKey, receiptId })}
                                        aria-pressed={selected}
                                        className={[
                                          "w-full rounded-lg border p-3 text-left",
                                          selected ? "border-brand-300 bg-brand-50" : "border-slate-100 bg-slate-50 hover:bg-slate-100",
                                        ].join(" ")}
                                      >
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                          <div>
                                            <p className="text-sm font-semibold text-slate-900">{valueText(receipt.receipt_number)}</p>
                                            <p className="mt-1 text-xs text-slate-500">Received {formatDateTime(receipt.received_at)}</p>
                                          </div>
                                          <StatusBadge status={valueText(receipt.status, "UNKNOWN")} />
                                        </div>
                                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4">
                                          <span>Lines: {valueText(receipt.line_count, "0")}</span>
                                          <span>Received: {formatQuantity(receipt.total_received)}</span>
                                          <span>Accepted: {formatQuantity(receipt.total_accepted)}</span>
                                          <span>Rejected: {formatQuantity(receipt.total_rejected)}</span>
                                        </div>
                                      </button>
                                    );
                                  })}
                                  <p className="text-[11px] text-slate-500">Maximum 50 posted receipts returned for this order.</p>
                                </div>
                              )}
                              {canReadGoodsReceipts && selectedReceiptId ? (
                                <div className="mt-4 border-t border-slate-100 pt-4">
                                  {loadingReceiptDetail ? (
                                    <div className="h-36 animate-pulse rounded-lg bg-slate-100" aria-label="Loading goods-receipt detail" />
                                  ) : currentReceiptDetail?.error ? (
                                    <Alert tone="danger" title="Could not load goods-receipt detail">{currentReceiptDetail.error}</Alert>
                                  ) : currentReceiptDetail?.payload ? (
                                    <div>
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div>
                                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Receipt detail</p>
                                          <h4 className="mt-1 font-semibold text-slate-950">{valueText(receiptDetail.receipt_number)}</h4>
                                        </div>
                                        <StatusBadge status={valueText(receiptDetail.status, "UNKNOWN")} />
                                      </div>
                                      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                                        <DetailField label="Supplier reference" value={receiptDetail.supplier_delivery_reference} />
                                        <DetailField label="Received at" value={formatDateTime(receiptDetail.received_at)} />
                                        <DetailField label="Posted at" value={formatDateTime(receiptDetail.posted_at)} />
                                        <DetailField label="Created" value={formatDateTime(receiptDetail.created_at)} />
                                      </dl>
                                      {receiptDetail.notes ? (
                                        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-600">{valueText(receiptDetail.notes)}</p>
                                      ) : null}
                                      <div className="mt-3 space-y-2">
                                        {receiptLines.map((line) => (
                                          <article key={valueText(line.id)} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                                            <p className="text-sm font-semibold text-slate-900">
                                              Line {valueText(line.po_line_number)} · {valueText(line.description)}
                                            </p>
                                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-3">
                                              <span>Ordered: {formatQuantity(line.ordered_quantity)} {valueText(line.unit)}</span>
                                              <span>Received: {formatQuantity(line.received_quantity)}</span>
                                              <span>Accepted: {formatQuantity(line.accepted_quantity)}</span>
                                              <span>Rejected: {formatQuantity(line.rejected_quantity)}</span>
                                              <span>Stock after: {formatQuantity(line.stock_quantity_after)}</span>
                                            </div>
                                            {line.rejection_reason ? (
                                              <p className="mt-2 text-xs text-amber-700">Rejection reason: {valueText(line.rejection_reason)}</p>
                                            ) : null}
                                          </article>
                                        ))}
                                      </div>
                                      <p className="mt-3 text-[11px] text-slate-500">
                                        Inventory movement identifiers and internal request/audit metadata are not displayed.
                                      </p>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </section>

                            <section className="rounded-xl border border-slate-200 p-4">
                              <div className="flex items-center justify-between gap-2">
                                <h3 className="font-semibold text-slate-950">Status history</h3>
                                <Badge tone="neutral">{poHistory.length} events</Badge>
                              </div>
                              {poHistory.length === 0 ? (
                                <p className="mt-3 text-sm text-slate-500">No status history was returned.</p>
                              ) : (
                                <ol className="mt-3 space-y-3">
                                  {poHistory.map((event) => (
                                    <li key={valueText(event.id)} className="border-l-2 border-slate-200 pl-3">
                                      <p className="text-sm font-semibold text-slate-900">
                                        {valueText(event.from_status, "Created")} → {valueText(event.to_status)}
                                      </p>
                                      <p className="mt-1 text-xs text-slate-500">{formatDateTime(event.created_at)}</p>
                                      {event.reason ? <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{valueText(event.reason)}</p> : null}
                                    </li>
                                  ))}
                                </ol>
                              )}
                              <p className="mt-3 text-[11px] text-slate-500">
                                Actor IDs, request IDs and trace IDs are intentionally omitted.
                              </p>
                            </section>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}

          {activeView === "suppliers" && canReadSuppliers ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle>Supplier directory</CardTitle>
                    <CardDescription>
                      Tenant-scoped supplier records used by factory purchasing. Contact details are shown only to users with suppliers.read.
                    </CardDescription>
                  </div>
                  <Badge tone="neutral">20 records per page</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitSupplierSearch} className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
                  <div>
                    <label htmlFor="procurement-supplier-search" className="block text-xs font-semibold text-slate-700">Search supplier</label>
                    <input
                      id="procurement-supplier-search"
                      value={supplierSearchInput}
                      onChange={(event) => setSupplierSearchInput(event.target.value)}
                      maxLength={100}
                      placeholder="Supplier name or code"
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="procurement-supplier-status" className="block text-xs font-semibold text-slate-700">Supplier status</label>
                    <select
                      id="procurement-supplier-status"
                      value={supplierStatus}
                      onChange={(event) => changeSupplierStatus(event.target.value)}
                      className="mt-2 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                    >
                      {SUPPLIER_STATUS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <Button type="submit" disabled={loadingList}>Search</Button>
                  </div>
                </form>

                {currentList?.error ? (
                  <Alert tone="danger" title="Could not load suppliers">{currentList.error}</Alert>
                ) : loadingList ? (
                  <div className="space-y-3" aria-label="Loading suppliers">
                    {[1, 2, 3].map((item) => <div key={item} className="h-20 animate-pulse rounded-xl bg-slate-100" />)}
                  </div>
                ) : items.length === 0 ? (
                  <EmptyState
                    title="No suppliers returned"
                    description="No supplier records matched this tenant, status and search filter."
                  />
                ) : (
                  <>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {items.map((supplier) => {
                        const id = valueText(supplier.id, "");
                        const selected = id !== "" && id === selectedRecordId;
                        return (
                          <button
                            type="button"
                            key={id}
                            disabled={!id}
                            onClick={() => setSelection({ scopeKey, recordId: id })}
                            aria-pressed={selected}
                            className={[
                              "rounded-xl border p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600",
                              selected ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
                            ].join(" ")}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-950">{valueText(supplier.name)}</p>
                                <p className="mt-1 text-xs text-slate-500">{valueText(supplier.code)}</p>
                              </div>
                              <StatusBadge status={valueText(supplier.status, "UNKNOWN")} />
                            </div>
                            <div className="mt-3 space-y-1 text-sm text-slate-700">
                              <p className="break-all">{valueText(supplier.email, "No email recorded")}</p>
                              <p>{valueText(supplier.phone, "No phone recorded")}</p>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                              <span>{valueText(supplier.country_code, "Country not recorded")}</span>
                              <span>{valueText(supplier.currency, "Currency not set")}</span>
                              <span>{valueText(supplier.payment_terms_days)} day terms</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {selectedSupplier ? (
                      <section className="mt-5 rounded-xl border border-slate-200 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Supplier record</p>
                            <h3 className="mt-1 text-lg font-semibold text-slate-950">{valueText(selectedSupplier.name)}</h3>
                            <p className="mt-1 text-xs text-slate-500">{valueText(selectedSupplier.code)}</p>
                          </div>
                          <StatusBadge status={valueText(selectedSupplier.status, "UNKNOWN")} />
                        </div>
                        <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          <DetailField label="Email" value={selectedSupplier.email} />
                          <DetailField label="Phone" value={selectedSupplier.phone} />
                          <DetailField label="Country code" value={selectedSupplier.country_code} />
                          <DetailField label="Currency" value={selectedSupplier.currency} />
                          <DetailField label="Payment terms" value={valueText(selectedSupplier.payment_terms_days) + " days"} />
                          <DetailField label="Version" value={selectedSupplier.version} />
                          <DetailField label="Address" value={selectedSupplier.address} />
                          <DetailField label="Created" value={formatDateTime(selectedSupplier.created_at)} />
                          <DetailField label="Updated" value={formatDateTime(selectedSupplier.updated_at)} />
                        </dl>
                        {selectedSupplier.notes ? (
                          <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-600">{valueText(selectedSupplier.notes)}</p>
                        ) : null}
                        <p className="mt-3 text-[11px] text-slate-500">
                          Tax reference and internal actor metadata are intentionally not displayed.
                        </p>
                      </section>
                    ) : null}

                    <Pagination
                      page={page}
                      totalPages={totalPages}
                      total={total}
                      onPrevious={() => {
                        setSelection(null);
                        setSupplierPage((value) => Math.max(1, value - 1));
                      }}
                      onNext={() => {
                        setSelection(null);
                        setSupplierPage((value) => value + 1);
                      }}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
