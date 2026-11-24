"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  buildGoodsReceiptPayload,
  buildProcurementListQuery,
  buildPurchaseOrderPayload,
  buildPurchaseOrderTransitionPayload,
  buildPurchaseOrderUpdatePayload,
  buildSupplierPayload,
  buildSupplierPerformanceQuery,
  buildSupplierStatusPayload,
  buildSupplierUpdatePayload,
  filterProcurementRows,
  normalizeProcurementRows,
  summarizeProcurement,
} from "@/lib/procurement-workbench.mjs";

type Supplier = {
  id: string; code: string; name: string; status: "ACTIVE" | "DISABLED";
  country_code: string; email: string | null; phone: string | null; tax_reference: string | null;
  payment_terms_days: number; currency: string; address: string | null; notes: string | null;
  version: string; created_at: string; updated_at: string;
};
type PurchaseOrderLine = {
  id: string; line_number: number; inventory_item_id: string | null;
  description: string; quantity: string; unit: string; unit_price: string;
  line_amount: string; notes: string | null;
};
type PurchaseOrderHistory = {
  id: string; from_status: string | null; to_status: string; version: string;
  actor_user_id: string; reason: string | null; created_at: string;
};
type PurchaseOrder = {
  id: string; supplier_id: string; supplier_code: string; supplier_name: string;
  po_number: string; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED";
  order_date: string; expected_delivery_date: string | null; currency: string;
  payment_terms_days: number; notes: string | null; created_by_user_id: string;
  created_at: string; updated_at: string; version: string;
  total_amount: string; line_count: number; lines?: PurchaseOrderLine[];
  status_history?: PurchaseOrderHistory[];
};
type Receipt = {
  id: string; receipt_number: string; status: string; supplier_delivery_reference: string | null;
  received_at: string; posted_at: string; line_count: number;
  total_received: string; total_rejected: string; total_accepted: string;
};
type SupplierPerformance = {
  supplier?: { id: string; code: string; name: string } | null;
  period?: { from: string; to: string; as_of: string; date_comparison_timezone: string };
  summary?: Record<string, unknown>;
  quantities_by_unit?: Array<Record<string, unknown>>;
  delivery_exceptions?: Array<Record<string, unknown>>;
  delivery_exceptions_truncated?: boolean;
  quality?: {
    event_count?: number; distinct_defect_count?: number;
    by_defect?: Array<Record<string, unknown>>;
    evidence?: Array<Record<string, unknown>>;
    evidence_truncated?: boolean; coverage?: string;
  };
  methodology?: Record<string, unknown>;
};

type SupplierDraft = {
  code: string; name: string; country_code: string; email: string; phone: string;
  tax_reference: string; payment_terms_days: string; currency: string; address: string; notes: string;
};
type PoLineDraft = {
  line_number: number; inventory_item_id: string; description: string;
  quantity: string; unit: string; unit_price: string; notes: string;
};
type PoDraft = {
  supplier_id: string; po_number: string; order_date: string;
  expected_delivery_date: string; currency: string; payment_terms_days: string;
  notes: string; lines: PoLineDraft[];
};
type ReceiptLineDraft = {
  purchase_order_line_id: string; line_number: number; description: string; unit: string;
  ordered_quantity: string; received_quantity: string; rejected_quantity: string; rejection_reason: string;
};
type ReceiptDraft = {
  location_id: string; supplier_delivery_reference: string; received_at: string; notes: string;
  lines: ReceiptLineDraft[];
};
type Tab = "purchase-orders" | "suppliers" | "performance";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function numeric(value: unknown, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  const result = Number(value);
  return Number.isFinite(result)
    ? result.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })
    : "—";
}
function money(value: unknown, currency: string) {
  const formatted = numeric(value);
  return formatted === "—" ? formatted : currency + " " + formatted;
}
function percent(value: unknown) {
  return value === null || value === undefined ? "—" : numeric(value) + "%";
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
function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function daysAgo(days: number) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The procurement request could not be completed.";
}
function statusTone(value: string) {
  const status = value.toUpperCase();
  if (["ACTIVE", "APPROVED", "POSTED", "ON_TIME"].includes(status)) return "bg-emerald-50 text-emerald-800";
  if (["SUBMITTED", "OPEN_NOT_DUE"].includes(status)) return "bg-blue-50 text-blue-800";
  if (["DISABLED", "REJECTED", "CANCELLED", "OVERDUE_OPEN", "LATE"].includes(status)) return "bg-amber-50 text-amber-900";
  return "bg-slate-100 text-slate-700";
}
function StatusPill({ value }: { value: string }) {
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide " + statusTone(value)}>{value.replaceAll("_", " ")}</span>;
}
function Metric({ label, value, detail, tone = "slate" }: {
  label: string; value: string | number; detail: string; tone?: "slate" | "blue" | "amber" | "emerald";
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
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{detail}</p>
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
const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";
const emptySupplierDraft: SupplierDraft = {
  code: "", name: "", country_code: "BD", email: "", phone: "", tax_reference: "",
  payment_terms_days: "0", currency: "BDT", address: "", notes: "",
};
function emptyPoDraft(): PoDraft {
  return {
    supplier_id: "", po_number: "", order_date: today(), expected_delivery_date: "",
    currency: "BDT", payment_terms_days: "0", notes: "",
    lines: [{ line_number: 1, inventory_item_id: "", description: "", quantity: "", unit: "PCS", unit_price: "", notes: "" }],
  };
}
function emptyReceiptDraft(po: PurchaseOrder): ReceiptDraft {
  return {
    location_id: "", supplier_delivery_reference: "", received_at: "", notes: "",
    lines: (po.lines ?? []).map((line) => ({
      purchase_order_line_id: line.id, line_number: line.line_number, description: line.description,
      unit: line.unit, ordered_quantity: line.quantity, received_quantity: "",
      rejected_quantity: "0", rejection_reason: "",
    })),
  };
}

export default function ProcurementSupplierOperationsPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const canReadSuppliers = hasPermission("suppliers.read");
  const canWriteSuppliers = hasPermission("suppliers.write");
  const canReadOrders = hasPermission("purchase_orders.read");
  const canWriteOrders = hasPermission("purchase_orders.write");
  const canApproveOrders = hasPermission("purchase_orders.approve");
  const canReadReceipts = hasPermission("goods_receipts.read");
  const canWriteReceipts = hasPermission("goods_receipts.write");
  const canReadPerformance = hasPermission("suppliers.performance.read");
  const currentUserId = snapshot?.user?.id ?? "";

  const [tab, setTab] = useState<Tab>("purchase-orders");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [supplierSearch, setSupplierSearch] = useState("");
  const [supplierStatus, setSupplierStatus] = useState("ALL");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [supplierEditorOpen, setSupplierEditorOpen] = useState(false);
  const [supplierEditingId, setSupplierEditingId] = useState("");
  const [supplierDraft, setSupplierDraft] = useState<SupplierDraft>(emptySupplierDraft);

  const [poSearch, setPoSearch] = useState("");
  const [poStatus, setPoStatus] = useState("ALL");
  const [selectedPoId, setSelectedPoId] = useState("");
  const [poDetail, setPoDetail] = useState<PurchaseOrder | null>(null);
  const [poDetailLoading, setPoDetailLoading] = useState(false);
  const [poEditorOpen, setPoEditorOpen] = useState(false);
  const [poEditingId, setPoEditingId] = useState("");
  const [poDraft, setPoDraft] = useState<PoDraft>(emptyPoDraft);
  const [transitionReason, setTransitionReason] = useState("");
  const [receiptEditorOpen, setReceiptEditorOpen] = useState(false);
  const [receiptDraft, setReceiptDraft] = useState<ReceiptDraft | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);

  const [performanceFrom, setPerformanceFrom] = useState(daysAgo(89));
  const [performanceTo, setPerformanceTo] = useState(today());
  const [performanceAsOf, setPerformanceAsOf] = useState(today());
  const [performance, setPerformance] = useState<SupplierPerformance | null>(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);

  const summary = useMemo(() => summarizeProcurement(suppliers, purchaseOrders), [suppliers, purchaseOrders]);
  const openValueLabel = summary.openCurrencyCount === 1
    ? money(summary.totalOpenValue, summary.openValueCurrency)
    : summary.openCurrencyCount > 1 ? "Multi-currency" : "—";
  const openValueDetail = summary.openCurrencyCount > 1
    ? summary.openCurrencyCount + " currencies · totals are not added or FX-converted"
    : summary.openCurrencyCount === 1
      ? "Server-calculated total in " + summary.openValueCurrency
      : "No draft, submitted or approved PO value loaded";
  const visibleSuppliers = useMemo(
    () => filterProcurementRows(suppliers, { search: supplierSearch, status: supplierStatus }, "suppliers") as Supplier[],
    [suppliers, supplierSearch, supplierStatus],
  );
  const visibleOrders = useMemo(
    () => filterProcurementRows(purchaseOrders, { search: poSearch, status: poStatus }, "purchase-orders") as PurchaseOrder[],
    [purchaseOrders, poSearch, poStatus],
  );
  const selectedSupplier = suppliers.find((supplier) => supplier.id === selectedSupplierId) ?? null;

  const loadWorkspace = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId) {
      setSuppliers([]);
      setPurchaseOrders([]);
      setSelectedSupplierId("");
      setSelectedPoId("");
      setPoDetail(null);
      setReceipts([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [supplierResponse, orderResponse] = await Promise.all([
        canReadSuppliers
          ? request("/suppliers" + buildProcurementListQuery({ page: 1, limit: 100 }, "suppliers"))
          : Promise.resolve(null),
        canReadOrders
          ? request("/purchase-orders" + buildProcurementListQuery({ page: 1, limit: 100 }, "purchase-orders"))
          : Promise.resolve(null),
      ]);
      const nextSuppliers = normalizeProcurementRows(supplierResponse, "items") as Supplier[];
      const nextOrders = normalizeProcurementRows(orderResponse, "items") as PurchaseOrder[];
      setSuppliers(nextSuppliers);
      setPurchaseOrders(nextOrders);
      setSelectedSupplierId((current) => nextSuppliers.some((item) => item.id === current) ? current : nextSuppliers[0]?.id ?? "");
      setSelectedPoId((current) => nextOrders.some((item) => item.id === current) ? current : nextOrders[0]?.id ?? "");
    } catch (cause) {
      setError(messageOf(cause));
      setSuppliers([]);
      setPurchaseOrders([]);
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canReadSuppliers, canReadOrders, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  const openPurchaseOrder = useCallback(async (purchaseOrderId: string) => {
    setSelectedPoId(purchaseOrderId);
    setPoDetail(null);
    setReceipts([]);
    setPoDetailLoading(true);
    setError("");
    try {
      const detail = await request("/purchase-orders/" + encodeURIComponent(purchaseOrderId)) as PurchaseOrder;
      setPoDetail(detail);
      if (canReadReceipts) {
        const receiptResponse = await request("/purchase-orders/" + encodeURIComponent(purchaseOrderId) + "/goods-receipts?limit=50");
        setReceipts(normalizeProcurementRows(receiptResponse, "receipts") as Receipt[]);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setPoDetailLoading(false);
    }
  }, [request, canReadReceipts]);

  useEffect(() => {
    if (tab !== "purchase-orders" || !selectedPoId || !canReadOrders || status !== "connected" || !activeFactoryId) return;
    const timer = window.setTimeout(() => { void openPurchaseOrder(selectedPoId); }, 0);
    return () => window.clearTimeout(timer);
  }, [tab, selectedPoId, canReadOrders, status, activeFactoryId, openPurchaseOrder]);

  function startSupplierCreate() {
    setSupplierEditingId("");
    setSupplierDraft(emptySupplierDraft);
    setSupplierEditorOpen(true);
    setError("");
    setNotice("");
  }

  function startSupplierEdit(supplier: Supplier) {
    setSupplierEditingId(supplier.id);
    setSupplierDraft({
      code: supplier.code, name: supplier.name, country_code: supplier.country_code,
      email: supplier.email ?? "", phone: supplier.phone ?? "", tax_reference: supplier.tax_reference ?? "",
      payment_terms_days: String(supplier.payment_terms_days), currency: supplier.currency,
      address: supplier.address ?? "", notes: supplier.notes ?? "",
    });
    setSupplierEditorOpen(true);
    setError("");
    setNotice("");
  }

  async function saveSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWriteSuppliers) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (supplierEditingId) {
        const current = suppliers.find((item) => item.id === supplierEditingId);
        if (!current) throw new Error("The supplier is no longer in the loaded list. Refresh before editing.");
        await request("/suppliers/" + encodeURIComponent(supplierEditingId), {
          method: "PATCH",
          body: buildSupplierUpdatePayload(supplierDraft as unknown as Record<string, unknown>, current.version),
        });
        setNotice("Supplier profile updated with optimistic version protection.");
      } else {
        const result = await request("/suppliers", {
          method: "POST",
          body: buildSupplierPayload(supplierDraft as unknown as Record<string, unknown>),
        }) as Supplier;
        if (result?.id) setSelectedSupplierId(result.id);
        setNotice("Supplier registered in the authenticated tenant.");
      }
      setSupplierEditorOpen(false);
      await loadWorkspace();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function transitionSupplier(supplier: Supplier) {
    if (!canWriteSuppliers) return;
    const nextStatus = supplier.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    const label = nextStatus === "DISABLED" ? "disable" : "reactivate";
    if (nextStatus === "DISABLED" && !window.confirm("Disable " + supplier.code + "? Suppliers with draft, submitted, or approved POs cannot be disabled.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request("/suppliers/" + encodeURIComponent(supplier.id) + "/status", {
        method: "POST",
        body: buildSupplierStatusPayload(nextStatus, supplier.version),
      });
      setNotice("Supplier " + label + " request completed.");
      await loadWorkspace();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function startPoCreate() {
    const firstSupplier = suppliers.find((supplier) => supplier.status === "ACTIVE");
    setPoEditingId("");
    setPoDraft({ ...emptyPoDraft(), supplier_id: firstSupplier?.id ?? "" });
    setPoEditorOpen(true);
    setError("");
    setNotice("");
  }

  function startPoEdit(po: PurchaseOrder) {
    if (!poDetail || poDetail.id !== po.id || po.status !== "DRAFT") return;
    setPoEditingId(po.id);
    setPoDraft({
      supplier_id: po.supplier_id,
      po_number: po.po_number,
      order_date: po.order_date?.slice(0, 10) ?? today(),
      expected_delivery_date: po.expected_delivery_date?.slice(0, 10) ?? "",
      currency: po.currency,
      payment_terms_days: String(po.payment_terms_days),
      notes: po.notes ?? "",
      lines: (poDetail.lines ?? []).map((line) => ({
        line_number: line.line_number, inventory_item_id: line.inventory_item_id ?? "",
        description: line.description, quantity: line.quantity, unit: line.unit,
        unit_price: line.unit_price, notes: line.notes ?? "",
      })),
    });
    setPoEditorOpen(true);
    setError("");
    setNotice("");
  }

  function updatePoLine(index: number, field: keyof PoLineDraft, value: string) {
    setPoDraft((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line),
    }));
  }

  async function savePurchaseOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWriteOrders) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (poEditingId) {
        const current = poDetail;
        if (!current || current.id !== poEditingId) throw new Error("Reload the purchase order before saving this draft.");
        await request("/purchase-orders/" + encodeURIComponent(poEditingId), {
          method: "PATCH",
          body: buildPurchaseOrderUpdatePayload(poDraft as unknown as Record<string, unknown>, current.version),
        });
        setNotice("Draft purchase order updated with expected-version protection.");
      } else {
        await request("/purchase-orders", {
          method: "POST",
          body: buildPurchaseOrderPayload(poDraft as unknown as Record<string, unknown>),
          idempotencyKey: "procurement-po-" + window.crypto.randomUUID(),
        });
        setNotice("Draft purchase order created. The server calculated the persisted line totals.");
      }
      setPoEditorOpen(false);
      await loadWorkspace();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function transitionPurchaseOrder(target: "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED") {
    if (!poDetail) return;
    const allowed = target === "SUBMITTED" || target === "CANCELLED" ? canWriteOrders : canApproveOrders;
    if (!allowed) return;
    if (target === "APPROVED" && poDetail.created_by_user_id === currentUserId) {
      setError("The purchase-order creator cannot approve their own order.");
      return;
    }
    if (target === "CANCELLED" && !window.confirm("Cancel purchase order " + poDetail.po_number + "? This is a terminal lifecycle state.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const action = target.toLowerCase();
      await request("/purchase-orders/" + encodeURIComponent(poDetail.id) + "/" + action, {
        method: "POST",
        body: buildPurchaseOrderTransitionPayload(target, poDetail.version, transitionReason),
        idempotencyKey: "procurement-po-" + action + "-" + window.crypto.randomUUID(),
      });
      setTransitionReason("");
      setNotice("Purchase order transition " + target + " completed and version history was refreshed.");
      await loadWorkspace();
      await openPurchaseOrder(poDetail.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function startGoodsReceipt() {
    if (!poDetail || poDetail.status !== "APPROVED") return;
    setReceiptDraft(emptyReceiptDraft(poDetail));
    setReceiptEditorOpen(true);
    setError("");
    setNotice("");
  }

  function updateReceiptLine(index: number, field: keyof ReceiptLineDraft, value: string) {
    setReceiptDraft((current) => current ? ({
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line),
    }) : current);
  }

  async function postGoodsReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!poDetail || !receiptDraft || !canWriteReceipts) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildGoodsReceiptPayload(receiptDraft as unknown as Record<string, unknown>);
      const result = await request("/purchase-orders/" + encodeURIComponent(poDetail.id) + "/goods-receipts", {
        method: "POST",
        body: payload,
        idempotencyKey: "procurement-grn-" + window.crypto.randomUUID(),
      }) as Record<string, unknown>;
      setReceiptEditorOpen(false);
      setReceiptDraft(null);
      setNotice("Goods receipt posted: " + stringValue(result.receipt_number, stringValue(result.id, "receipt created")) + ". Accepted stock is posted only by the API transaction.");
      await loadWorkspace();
      await openPurchaseOrder(poDetail.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadSupplierPerformance() {
    if (!selectedSupplierId || !canReadPerformance) return;
    setPerformanceLoading(true);
    setError("");
    setNotice("");
    try {
      const query = buildSupplierPerformanceQuery({
        from: performanceFrom, to: performanceTo, as_of: performanceAsOf,
      });
      const result = await request("/suppliers/" + encodeURIComponent(selectedSupplierId) + "/performance" + query) as SupplierPerformance;
      setPerformance(result);
    } catch (cause) {
      setPerformance(null);
      setError(messageOf(cause));
    } finally {
      setPerformanceLoading(false);
    }
  }

  function switchTab(next: Tab) {
    setTab(next);
    setError("");
    setNotice("");
  }

  const activeSupplierOptions = suppliers.filter((supplier) => supplier.status === "ACTIVE");
  const performanceSummary = object(performance?.summary);
  const performanceQuality = object(performance?.quality);
  const qualityEvents = Array.isArray(performanceQuality.evidence) ? performanceQuality.evidence as Array<Record<string, unknown>> : [];
  const qualityDefects = Array.isArray(performanceQuality.by_defect) ? performanceQuality.by_defect as Array<Record<string, unknown>> : [];
  const quantityRows = performance?.quantities_by_unit ?? [];
  const deliveryExceptions = Array.isArray(performance?.delivery_exceptions) ? performance?.delivery_exceptions : [];

  if (status !== "connected") {
    return (
      <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">Procurement operations</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Connect a FactoryOS session</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Supplier and purchase-order data are loaded only from the authenticated workspace. Connect a session and select an active factory to open this workbench.</p>
          <a href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white">Open session</a>
        </section>
      </main>
    );
  }

  if (!activeFactoryId) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-8">
          <h1 className="text-xl font-bold text-slate-950">Select an active factory</h1>
          <p className="mt-2 text-sm text-slate-700">Purchase orders, goods receipts and supplier performance use the active factory returned by the authenticated IAM session.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-3xl bg-slate-950 p-6 text-white shadow-sm sm:p-8">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="max-w-3xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300">WP02 · Procurement & supplier lifecycle</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Procurement operations workbench</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Manage supplier records, versioned purchase orders and posted goods receipts. Inspect factory-scoped supplier delivery and GRN-linked quality evidence without inventing a supplier score.</p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-xs">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Active factory</p>
            <p className="mt-1 font-semibold text-white">{snapshot?.factories.find((factory) => factory.id === activeFactoryId)?.name ?? "Selected factory"}</p>
            <p className="mt-0.5 text-slate-400">{snapshot?.tenant.name ?? "Authenticated tenant"}</p>
          </div>
        </div>
      </section>

      {error ? (
        <div role="alert" className="flex flex-col justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 sm:flex-row sm:items-center">
          <p className="text-sm text-rose-800">{error}</p>
          <button type="button" className={secondaryButton} onClick={() => setError("")}>Dismiss</button>
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="flex flex-col justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 sm:flex-row sm:items-center">
          <p className="text-sm text-emerald-900">{notice}</p>
          <button type="button" className={secondaryButton} onClick={() => setNotice("")}>Dismiss</button>
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Active suppliers" value={numeric(summary.activeSuppliers, 0)} detail={numeric(summary.supplierCount, 0) + " supplier records loaded"} tone="blue" />
        <Metric label="Purchase orders" value={numeric(summary.purchaseOrderCount, 0)} detail={numeric(summary.draftCount, 0) + " draft · " + numeric(summary.submittedCount, 0) + " awaiting decision"} />
        <Metric label="Approved POs" value={numeric(summary.approvedCount, 0)} detail="Approved orders eligible for receipt posting" tone="emerald" />
        <Metric label="Open PO value" value={money(summary.totalOpenValue, "Loaded PO currencies*")} detail="Server-calculated total; values are not FX-converted" tone="amber" />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Procurement workbench views">
          {([
            ["purchase-orders", "Purchase orders"],
            ["suppliers", "Suppliers"],
            ["performance", "Supplier evidence"],
          ] as Array<[Tab, string]>).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => switchTab(key)}
              className={"min-h-10 rounded-xl px-4 text-xs font-semibold transition-colors " + (tab === key ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pr-2">
            {loading ? <span className="text-[11px] text-slate-500">Refreshing…</span> : null}
            <button type="button" onClick={() => void loadWorkspace()} disabled={loading} className={secondaryButton}>Refresh</button>
          </div>
        </div>
      </section>

      {tab === "purchase-orders" ? (
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(420px,0.9fr)]">
          <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-base font-bold text-slate-950">Purchase-order register</h2>
                <p className="mt-1 text-xs text-slate-500">Factory-scoped lifecycle with optimistic version checks</p>
              </div>
              <button type="button" disabled={!canWriteOrders || activeSupplierOptions.length === 0} onClick={startPoCreate} className={primaryButton}>Create purchase order</button>
            </div>
            {!canReadOrders ? (
              <p className="mt-5 rounded-xl border border-dashed border-slate-300 p-5 text-xs text-slate-600">Your session does not include <code>purchase_orders.read</code>.</p>
            ) : (
              <>
                <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
                  <input value={poSearch} onChange={(event) => setPoSearch(event.target.value)} placeholder="Search PO number or supplier…" className={inputClass} aria-label="Search purchase orders" />
                  <select value={poStatus} onChange={(event) => setPoStatus(event.target.value)} className={inputClass} aria-label="Filter purchase orders by status">
                    <option value="ALL">All statuses</option>
                    <option value="DRAFT">Draft</option><option value="SUBMITTED">Submitted</option>
                    <option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option>
                  </select>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[650px] text-left text-xs">
                    <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-3 font-semibold">PO / supplier</th><th className="py-2 pr-3 font-semibold">Expected</th>
                      <th className="py-2 pr-3 font-semibold">Value</th><th className="py-2 pr-3 font-semibold">Status</th><th className="py-2 font-semibold">Lines</th>
                    </tr></thead>
                    <tbody>
                      {visibleOrders.map((po) => (
                        <tr key={po.id} className={"border-b border-slate-100 last:border-0 hover:bg-slate-50 " + (po.id === selectedPoId ? "bg-blue-50/70" : "")}>
                          <td className="py-3 pr-3">
                            <button type="button" onClick={() => setSelectedPoId(po.id)} className="text-left font-bold text-slate-950 hover:text-blue-700">{po.po_number}</button>
                            <p className="mt-0.5 text-[11px] text-slate-500">{po.supplier_code} · {po.supplier_name}</p>
                          </td>
                          <td className="py-3 pr-3 text-slate-600">{dateLabel(po.expected_delivery_date)}</td>
                          <td className="py-3 pr-3 font-semibold tabular-nums text-slate-900">{money(po.total_amount, po.currency)}</td>
                          <td className="py-3 pr-3"><StatusPill value={po.status} /></td>
                          <td className="py-3 tabular-nums text-slate-600">{numeric(po.line_count, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visibleOrders.length ? <p className="py-8 text-center text-xs text-slate-500">{loading ? "Loading purchase orders…" : "No purchase orders match these filters."}</p> : null}
                </div>
                <p className="mt-3 text-[10px] leading-4 text-slate-500">Showing up to 100 most recently updated records. Search and status filters apply to the loaded workspace results.</p>
              </>
            )}
          </div>

          <div className="min-w-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-950">Purchase-order detail</h2>
                <p className="mt-1 text-xs text-slate-500">Commercial terms, workflow history and posted receipts</p>
              </div>
              {poDetail?.status === "DRAFT" && canWriteOrders ? (
                <button type="button" className={secondaryButton} onClick={() => startPoEdit(poDetail)}>Edit draft</button>
              ) : null}
            </div>
            {poDetailLoading ? <p className="rounded-xl bg-slate-50 p-5 text-xs text-slate-500">Loading purchase-order detail…</p> : null}
            {!poDetail && !poDetailLoading ? <p className="rounded-xl border border-dashed border-slate-300 p-5 text-xs text-slate-500">Select a purchase order to inspect its lines, approvals and receipt history.</p> : null}
            {poDetail ? (
              <>
                <div className="rounded-xl bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-slate-950">{poDetail.po_number}</p>
                    <StatusPill value={poDetail.status} />
                  </div>
                  <p className="mt-1 text-xs text-slate-600">{poDetail.supplier_code} · {poDetail.supplier_name}</p>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div><p className="text-[10px] uppercase tracking-wide text-slate-500">Order date</p><p className="mt-1 font-semibold text-slate-900">{dateLabel(poDetail.order_date)}</p></div>
                    <div><p className="text-[10px] uppercase tracking-wide text-slate-500">Expected delivery</p><p className="mt-1 font-semibold text-slate-900">{dateLabel(poDetail.expected_delivery_date)}</p></div>
                    <div><p className="text-[10px] uppercase tracking-wide text-slate-500">PO total</p><p className="mt-1 font-bold text-slate-950">{money(poDetail.total_amount, poDetail.currency)}</p></div>
                    <div><p className="text-[10px] uppercase tracking-wide text-slate-500">Version / payment terms</p><p className="mt-1 font-semibold text-slate-900">v{poDetail.version} · {poDetail.payment_terms_days} days</p></div>
                  </div>
                  {poDetail.notes ? <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-600">{poDetail.notes}</p> : null}
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-bold text-slate-900">Ordered lines</h3>
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full min-w-[420px] text-left text-[11px]">
                      <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="p-2.5">Line / description</th><th className="p-2.5 text-right">Qty</th><th className="p-2.5 text-right">Rate</th><th className="p-2.5 text-right">Amount</th></tr></thead>
                      <tbody>
                        {(poDetail.lines ?? []).map((line) => (
                          <tr key={line.id} className="border-t border-slate-100">
                            <td className="p-2.5"><p className="font-semibold text-slate-900">{line.line_number}. {line.description}</p><p className="mt-0.5 text-[10px] text-slate-500">{line.inventory_item_id ? "Inventory item linked" : "No inventory item linked"} · {line.unit}</p></td>
                            <td className="p-2.5 text-right tabular-nums">{numeric(line.quantity, 4)}</td>
                            <td className="p-2.5 text-right tabular-nums">{numeric(line.unit_price, 4)}</td>
                            <td className="p-2.5 text-right font-semibold tabular-nums">{numeric(line.line_amount, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-bold text-slate-900">Lifecycle actions</h3>
                    {poDetail.status === "APPROVED" && canWriteReceipts ? <button type="button" className={primaryButton} onClick={startGoodsReceipt}>Post goods receipt</button> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {poDetail.status === "DRAFT" && canWriteOrders ? <button type="button" className={secondaryButton} disabled={busy} onClick={() => void transitionPurchaseOrder("SUBMITTED")}>Submit for approval</button> : null}
                    {poDetail.status === "SUBMITTED" && canApproveOrders && poDetail.created_by_user_id !== currentUserId ? <button type="button" className={primaryButton} disabled={busy} onClick={() => void transitionPurchaseOrder("APPROVED")}>Approve</button> : null}
                    {poDetail.status === "SUBMITTED" && canApproveOrders ? <button type="button" className={secondaryButton} disabled={busy} onClick={() => void transitionPurchaseOrder("REJECTED")}>Reject</button> : null}
                    {["DRAFT", "SUBMITTED"].includes(poDetail.status) && canWriteOrders ? <button type="button" className={dangerButton} disabled={busy} onClick={() => void transitionPurchaseOrder("CANCELLED")}>Cancel PO</button> : null}
                  </div>
                  {((poDetail.status === "SUBMITTED" && (canApproveOrders || canWriteOrders)) || (poDetail.status === "DRAFT" && canWriteOrders)) ? (
                    <Field label="Decision / cancellation reason" hint="Required for rejection and cancellation; optional for submission and approval.">
                      <textarea value={transitionReason} onChange={(event) => setTransitionReason(event.target.value)} rows={2} maxLength={2000} className={inputClass} placeholder="Add a concise operational reason…" />
                    </Field>
                  ) : null}
                  {poDetail.status === "SUBMITTED" && poDetail.created_by_user_id === currentUserId ? <p className="text-[10px] text-amber-800">Self-approval is blocked: the PO creator cannot approve this order.</p> : null}
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-bold text-slate-900">Status history</h3>
                  <div className="space-y-2">
                    {(poDetail.status_history ?? []).map((entry) => (
                      <div key={entry.id} className="flex gap-3 rounded-lg border border-slate-100 p-2.5">
                        <div className="mt-1 size-2 shrink-0 rounded-full bg-blue-600" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] font-semibold text-slate-900">{entry.from_status ? entry.from_status + " → " : ""}{entry.to_status} · v{entry.version}</p><p className="text-[10px] text-slate-500">{dateTime(entry.created_at)}</p></div>
                          {entry.reason ? <p className="mt-1 text-[10px] text-slate-600">{entry.reason}</p> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {canReadReceipts ? (
                  <div>
                    <h3 className="mb-2 text-xs font-bold text-slate-900">Posted goods receipts</h3>
                    {receipts.length ? (
                      <div className="space-y-2">
                        {receipts.map((receipt) => (
                          <div key={receipt.id} className="rounded-xl border border-slate-200 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{receipt.receipt_number}</p><StatusPill value={receipt.status} /></div>
                            <p className="mt-1 text-[10px] text-slate-500">{dateTime(receipt.posted_at)} · {receipt.supplier_delivery_reference ?? "No delivery reference"}</p>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600"><span>Received {numeric(receipt.total_received, 4)}</span><span>Accepted {numeric(receipt.total_accepted, 4)}</span><span>Rejected {numeric(receipt.total_rejected, 4)}</span><span>{numeric(receipt.line_count, 0)} lines</span></div>
                          </div>
                        ))}
                      </div>
                    ) : <p className="rounded-lg bg-slate-50 p-3 text-[11px] text-slate-500">No posted goods receipts are recorded for this PO.</p>}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {tab === "suppliers" ? (
        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
          <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div><h2 className="text-base font-bold text-slate-950">Supplier master</h2><p className="mt-1 text-xs text-slate-500">Tenant-scoped supplier records · disable rather than delete</p></div>
              <button type="button" disabled={!canWriteSuppliers} onClick={startSupplierCreate} className={primaryButton}>Register supplier</button>
            </div>
            {!canReadSuppliers ? <p className="mt-5 rounded-xl border border-dashed border-slate-300 p-5 text-xs text-slate-600">Your session does not include <code>suppliers.read</code>.</p> : (
              <>
                <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
                  <input value={supplierSearch} onChange={(event) => setSupplierSearch(event.target.value)} placeholder="Search code, name, tax reference…" className={inputClass} aria-label="Search suppliers" />
                  <select value={supplierStatus} onChange={(event) => setSupplierStatus(event.target.value)} className={inputClass} aria-label="Filter supplier status">
                    <option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option>
                  </select>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[550px] text-left text-xs">
                    <thead><tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500"><th className="py-2 pr-3">Supplier</th><th className="py-2 pr-3">Country / currency</th><th className="py-2 pr-3">Payment terms</th><th className="py-2">Status</th></tr></thead>
                    <tbody>
                      {visibleSuppliers.map((supplier) => (
                        <tr key={supplier.id} className={"border-b border-slate-100 last:border-0 hover:bg-slate-50 " + (supplier.id === selectedSupplierId ? "bg-blue-50/70" : "")}>
                          <td className="py-3 pr-3"><button type="button" onClick={() => setSelectedSupplierId(supplier.id)} className="text-left font-bold text-slate-950 hover:text-blue-700">{supplier.name}</button><p className="mt-0.5 text-[11px] text-slate-500">{supplier.code} · {supplier.email ?? "No email"}</p></td>
                          <td className="py-3 pr-3 text-slate-600">{supplier.country_code} · {supplier.currency}</td>
                          <td className="py-3 pr-3 text-slate-600">{supplier.payment_terms_days} days</td>
                          <td className="py-3"><StatusPill value={supplier.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visibleSuppliers.length ? <p className="py-8 text-center text-xs text-slate-500">{loading ? "Loading suppliers…" : "No suppliers match these filters."}</p> : null}
                </div>
              </>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h2 className="text-base font-bold text-slate-950">Supplier profile</h2><p className="mt-1 text-xs text-slate-500">Versioned master data and access-controlled actions</p></div>
              {selectedSupplier ? <StatusPill value={selectedSupplier.status} /> : null}
            </div>
            {selectedSupplier ? (
              <>
                <div className="mt-4 rounded-xl bg-slate-50 p-4">
                  <p className="text-lg font-bold text-slate-950">{selectedSupplier.name}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">{selectedSupplier.code} · version {selectedSupplier.version}</p>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div><p className="text-[10px] uppercase text-slate-500">Email</p><p className="mt-1 break-all font-medium text-slate-800">{stringValue(selectedSupplier.email)}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Phone</p><p className="mt-1 font-medium text-slate-800">{stringValue(selectedSupplier.phone)}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Tax reference</p><p className="mt-1 font-medium text-slate-800">{stringValue(selectedSupplier.tax_reference)}</p></div>
                    <div><p className="text-[10px] uppercase text-slate-500">Payment terms</p><p className="mt-1 font-medium text-slate-800">{selectedSupplier.payment_terms_days} days</p></div>
                  </div>
                  {selectedSupplier.address ? <p className="mt-3 border-t border-slate-200 pt-3 text-xs leading-5 text-slate-600">{selectedSupplier.address}</p> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" disabled={!canWriteSuppliers || busy} className={secondaryButton} onClick={() => startSupplierEdit(selectedSupplier)}>Edit profile</button>
                  <button type="button" disabled={!canWriteSuppliers || busy} className={selectedSupplier.status === "ACTIVE" ? dangerButton : secondaryButton} onClick={() => void transitionSupplier(selectedSupplier)}>{selectedSupplier.status === "ACTIVE" ? "Disable supplier" : "Reactivate supplier"}</button>
                  <button type="button" disabled={!canReadPerformance} className={primaryButton} onClick={() => { setTab("performance"); setPerformance(null); }}>View delivery evidence</button>
                </div>
                <p className="mt-3 text-[10px] leading-4 text-slate-500">Supplier code and creator provenance are immutable. A supplier with draft, submitted or approved POs cannot be disabled.</p>
              </>
            ) : <p className="mt-5 rounded-xl border border-dashed border-slate-300 p-5 text-xs text-slate-500">Select a supplier to inspect its master record.</p>}
          </div>
        </section>
      ) : null}

      {tab === "performance" ? (
        <section className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
              <div><h2 className="text-base font-bold text-slate-950">Supplier delivery & quality evidence</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">Read-only evidence from approved purchase orders, POSTED GRNs and GRN-linked quality events. Delivery completion uses cumulative physical receipts and UTC dates.</p></div>
              <button type="button" disabled={!canReadPerformance || !selectedSupplierId || performanceLoading} onClick={() => void loadSupplierPerformance()} className={primaryButton}>{performanceLoading ? "Loading evidence…" : "Load supplier evidence"}</button>
            </div>
            {!canReadPerformance ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Your session does not include <code>suppliers.performance.read</code>.</p> : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Supplier">
                <select value={selectedSupplierId} onChange={(event) => { setSelectedSupplierId(event.target.value); setPerformance(null); }} className={inputClass} disabled={!canReadSuppliers}>
                  <option value="">Select supplier</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}
                </select>
              </Field>
              <Field label="Period from"><input type="date" value={performanceFrom} onChange={(event) => setPerformanceFrom(event.target.value)} className={inputClass} /></Field>
              <Field label="Period to"><input type="date" value={performanceTo} onChange={(event) => setPerformanceTo(event.target.value)} className={inputClass} /></Field>
              <Field label="Evidence as-of (UTC)"><input type="date" value={performanceAsOf} onChange={(event) => setPerformanceAsOf(event.target.value)} className={inputClass} /></Field>
            </div>
            <p className="mt-3 text-[10px] text-slate-500">Maximum period: 366 inclusive calendar days. The as-of date is inclusive through that UTC calendar day.</p>
          </div>
          {performance ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="Approved POs" value={numeric(performanceSummary.approved_purchase_order_count, 0)} detail={numeric(performanceSummary.due_purchase_order_count, 0) + " due · " + numeric(performanceSummary.undated_approved_po_count, 0) + " undated"} />
                <Metric label="Line completion" value={percent(performanceSummary.completion_rate_percent)} detail={numeric(performanceSummary.completed_line_count, 0) + " / " + numeric(performanceSummary.due_line_count, 0) + " due lines complete"} tone="blue" />
                <Metric label="On-time completion" value={percent(performanceSummary.on_time_rate_percent)} detail={numeric(performanceSummary.on_time_complete_line_count, 0) + " on-time · " + numeric(performanceSummary.late_complete_line_count, 0) + " late"} tone="emerald" />
                <Metric label="Delivery exceptions" value={numeric(performanceSummary.overdue_open_line_count, 0) + " open"} detail={numeric(performanceSummary.late_complete_line_count, 0) + " late-completed lines" + (performance.delivery_exceptions_truncated ? " · list truncated" : "")} tone="amber" />
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <h3 className="text-sm font-bold text-slate-950">Quantity reconciliation by UOM</h3>
                  <p className="mt-1 text-[10px] text-slate-500">Units are grouped independently; quantities across different UOMs are never added.</p>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[520px] text-left text-[11px]">
                      <thead><tr className="border-b border-slate-200 text-[10px] uppercase text-slate-500"><th className="py-2 pr-2">UOM</th><th className="py-2 pr-2 text-right">Ordered</th><th className="py-2 pr-2 text-right">Received</th><th className="py-2 pr-2 text-right">Accepted</th><th className="py-2 pr-2 text-right">Rejected</th><th className="py-2 text-right">Outstanding</th></tr></thead>
                      <tbody>{quantityRows.map((row, index) => <tr key={String(row.unit) + index} className="border-b border-slate-100 last:border-0"><td className="py-2.5 font-bold text-slate-900">{stringValue(row.unit)}</td><td className="py-2.5 pr-2 text-right tabular-nums">{numeric(row.ordered_quantity, 4)}</td><td className="py-2.5 pr-2 text-right tabular-nums">{numeric(row.received_quantity, 4)}</td><td className="py-2.5 pr-2 text-right tabular-nums text-emerald-700">{numeric(row.accepted_quantity, 4)}</td><td className="py-2.5 pr-2 text-right tabular-nums text-rose-700">{numeric(row.rejected_quantity, 4)}</td><td className="py-2.5 text-right tabular-nums">{numeric(row.outstanding_quantity, 4)}</td></tr>)}</tbody>
                    </table>
                    {!quantityRows.length ? <p className="py-5 text-xs text-slate-500">No approved-PO quantity evidence in this period.</p> : null}
                  </div>
                </section>
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <h3 className="text-sm font-bold text-slate-950">Delivery exceptions</h3>
                  <p className="mt-1 text-[10px] text-slate-500">Late-completed or overdue-open PO lines, as of the selected UTC date.</p>
                  <div className="mt-4 space-y-2">
                    {deliveryExceptions.map((row, index) => (
                      <div key={String(row.purchase_order_line_id ?? index)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-950">{stringValue(row.po_number)} · Line {stringValue(row.line_number, String(index + 1))}</p><StatusPill value={String(row.delivery_status ?? "UNKNOWN")} /></div>
                        <p className="mt-1 text-[11px] text-slate-600">{stringValue(row.description)} · {numeric(row.received_quantity, 4)} / {numeric(row.ordered_quantity, 4)} {stringValue(row.unit, "")}</p>
                        <p className="mt-1 text-[10px] text-slate-500">Expected {dateLabel(row.expected_delivery_date)} · Completed {dateLabel(row.completion_date_utc)}</p>
                      </div>
                    ))}
                    {!deliveryExceptions.length ? <p className="rounded-lg bg-slate-50 p-4 text-xs text-slate-500">No late or overdue delivery exceptions were returned.</p> : null}
                    {performance.delivery_exceptions_truncated ? <p className="text-[10px] text-amber-800">Only the first 50 exceptions are returned by the API.</p> : null}
                  </div>
                </section>
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <h3 className="text-sm font-bold text-slate-950">GRN-linked quality summary</h3>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Metric label="Quality events" value={numeric(performanceQuality.event_count, 0)} detail="Persisted GRN-linked event evidence" />
                    <Metric label="Distinct defects" value={numeric(performanceQuality.distinct_defect_count, 0)} detail="Distinct recorded defect identities" tone="amber" />
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[360px] text-left text-[11px]">
                      <thead><tr className="border-b border-slate-200 text-[10px] uppercase text-slate-500"><th className="py-2">Severity / defect</th><th className="py-2 text-right">Events</th><th className="py-2 text-right">Affected qty</th></tr></thead>
                      <tbody>{qualityDefects.map((row, index) => <tr key={String(row.defect_code) + index} className="border-b border-slate-100 last:border-0"><td className="py-2.5"><p className="font-semibold text-slate-900">{stringValue(row.defect_code)}</p><p className="text-[10px] text-slate-500">{stringValue(row.severity)} · {stringValue(row.unit, "")}</p></td><td className="py-2.5 text-right tabular-nums">{numeric(row.event_count, 0)}</td><td className="py-2.5 text-right tabular-nums">{numeric(row.affected_quantity, 4)}</td></tr>)}</tbody>
                    </table>
                    {!qualityDefects.length ? <p className="py-5 text-xs text-slate-500">No GRN-linked supplier quality events in this period.</p> : null}
                  </div>
                </section>
                <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                  <h3 className="text-sm font-bold text-slate-950">Quality evidence trail</h3>
                  <div className="mt-3 space-y-2">
                    {qualityEvents.map((row, index) => (
                      <div key={String(row.event_id ?? index)} className="rounded-xl border border-slate-200 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{stringValue(row.defect_code)} · {stringValue(row.severity)}</p><p className="text-[10px] text-slate-500">{dateTime(row.created_at)}</p></div>
                        <p className="mt-1 text-[11px] text-slate-600">{stringValue(row.event_type)} · {stringValue(row.po_number)} · GRN {stringValue(row.receipt_number)}</p>
                        <p className="mt-1 text-[10px] text-slate-500">Inspection {stringValue(row.inspection_id)} · affected {numeric(row.affected_quantity, 4)} {stringValue(row.unit, "")}</p>
                      </div>
                    ))}
                    {!qualityEvents.length ? <p className="rounded-lg bg-slate-50 p-4 text-xs text-slate-500">No individual quality events were returned.</p> : null}
                    {performanceQuality.evidence_truncated ? <p className="text-[10px] text-amber-800">Only the most recent 50 quality events are returned.</p> : null}
                  </div>
                </section>
              </div>
              <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                <h3 className="text-xs font-bold text-amber-950">Evidence boundary</h3>
                <p className="mt-1 text-[11px] leading-5 text-amber-900">Supplier score: NOT CALCULATED · Ranking: NOT CALCULATED · Automatic recommendation: NOT PROVIDED. {stringValue(performanceQuality.coverage, "Quality evidence is limited to GRN-linked defect events.")}</p>
                <p className="mt-1 text-[10px] leading-4 text-amber-800">This report is read-only evidence, not a complete supplier inspection census, weighted scorecard, commercial ranking or AP-provider acceptance.</p>
              </section>
            </>
          ) : <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-xs text-slate-500">{performanceLoading ? "Loading supplier evidence…" : "Select a supplier and period, then load the read-only delivery and quality report."}</p>}
        </section>
      ) : null}

      {supplierEditorOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="supplier-editor-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="supplier-editor-title" className="text-lg font-bold text-slate-950">{supplierEditingId ? "Edit supplier profile" : "Register supplier"}</h2><p className="mt-1 text-xs text-slate-500">Tenant-scoped supplier master data</p></div><button type="button" className={secondaryButton} onClick={() => setSupplierEditorOpen(false)} disabled={busy}>Close</button></div>
            <form onSubmit={saveSupplier} className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Supplier code"><input required maxLength={100} disabled={!!supplierEditingId} value={supplierDraft.code} onChange={(event) => setSupplierDraft((current) => ({ ...current, code: event.target.value }))} className={inputClass} /></Field>
                <Field label="Supplier name"><input required maxLength={255} value={supplierDraft.name} onChange={(event) => setSupplierDraft((current) => ({ ...current, name: event.target.value }))} className={inputClass} /></Field>
                <Field label="Country code"><input required maxLength={2} value={supplierDraft.country_code} onChange={(event) => setSupplierDraft((current) => ({ ...current, country_code: event.target.value }))} className={inputClass} /></Field>
                <Field label="Currency"><input required maxLength={3} value={supplierDraft.currency} onChange={(event) => setSupplierDraft((current) => ({ ...current, currency: event.target.value }))} className={inputClass} /></Field>
                <Field label="AP email"><input type="email" maxLength={320} value={supplierDraft.email} onChange={(event) => setSupplierDraft((current) => ({ ...current, email: event.target.value }))} className={inputClass} /></Field>
                <Field label="Phone"><input maxLength={80} value={supplierDraft.phone} onChange={(event) => setSupplierDraft((current) => ({ ...current, phone: event.target.value }))} className={inputClass} /></Field>
                <Field label="Tax reference"><input maxLength={120} value={supplierDraft.tax_reference} onChange={(event) => setSupplierDraft((current) => ({ ...current, tax_reference: event.target.value }))} className={inputClass} /></Field>
                <Field label="Payment terms (days)"><input type="number" min="0" max="3650" step="1" value={supplierDraft.payment_terms_days} onChange={(event) => setSupplierDraft((current) => ({ ...current, payment_terms_days: event.target.value }))} className={inputClass} /></Field>
              </div>
              <Field label="Address"><textarea rows={2} value={supplierDraft.address} onChange={(event) => setSupplierDraft((current) => ({ ...current, address: event.target.value }))} className={inputClass} /></Field>
              <Field label="Internal notes"><textarea rows={2} value={supplierDraft.notes} onChange={(event) => setSupplierDraft((current) => ({ ...current, notes: event.target.value }))} className={inputClass} /></Field>
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={() => setSupplierEditorOpen(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={busy || !canWriteSuppliers}>{busy ? "Saving…" : supplierEditingId ? "Save profile" : "Register supplier"}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {poEditorOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="po-editor-title" className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="po-editor-title" className="text-lg font-bold text-slate-950">{poEditingId ? "Edit draft purchase order" : "Create purchase order"}</h2><p className="mt-1 text-xs text-slate-500">Persisted totals and lifecycle versions are calculated by the server</p></div><button type="button" className={secondaryButton} onClick={() => setPoEditorOpen(false)} disabled={busy}>Close</button></div>
            <form onSubmit={savePurchaseOrder} className="mt-5 space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Field label="Supplier"><select required disabled={!!poEditingId} value={poDraft.supplier_id} onChange={(event) => setPoDraft((current) => ({ ...current, supplier_id: event.target.value }))} className={inputClass}><option value="">Select active supplier</option>{activeSupplierOptions.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}</select></Field>
                <Field label="PO number"><input required maxLength={100} disabled={!!poEditingId} value={poDraft.po_number} onChange={(event) => setPoDraft((current) => ({ ...current, po_number: event.target.value }))} className={inputClass} /></Field>
                <Field label="Currency"><input required maxLength={3} value={poDraft.currency} onChange={(event) => setPoDraft((current) => ({ ...current, currency: event.target.value }))} className={inputClass} /></Field>
                <Field label="Order date"><input type="date" value={poDraft.order_date} onChange={(event) => setPoDraft((current) => ({ ...current, order_date: event.target.value }))} className={inputClass} /></Field>
                <Field label="Expected delivery"><input type="date" value={poDraft.expected_delivery_date} onChange={(event) => setPoDraft((current) => ({ ...current, expected_delivery_date: event.target.value }))} className={inputClass} /></Field>
                <Field label="Payment terms (days)"><input type="number" min="0" max="3650" step="1" value={poDraft.payment_terms_days} onChange={(event) => setPoDraft((current) => ({ ...current, payment_terms_days: event.target.value }))} className={inputClass} /></Field>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold text-slate-950">Purchase-order lines</h3><p className="mt-1 text-[10px] text-slate-500">Quantity and price support up to four decimal places. Totals are never calculated in the browser.</p></div><button type="button" className={secondaryButton} onClick={() => setPoDraft((current) => ({ ...current, lines: [...current.lines, { line_number: current.lines.length + 1, inventory_item_id: "", description: "", quantity: "", unit: "PCS", unit_price: "", notes: "" }] }))}>Add line</button></div>
              <div className="space-y-3">
                {poDraft.lines.map((line, index) => (
                  <div key={index} className="rounded-xl border border-slate-200 p-3">
                    <div className="mb-3 flex items-center justify-between"><p className="text-xs font-bold text-slate-900">Line {index + 1}</p>{poDraft.lines.length > 1 ? <button type="button" className="text-[11px] font-semibold text-rose-700" onClick={() => setPoDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index).map((item, lineIndex) => ({ ...item, line_number: lineIndex + 1 })) }))}>Remove line</button> : null}</div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="sm:col-span-2 xl:col-span-2"><Field label="Description"><input required maxLength={500} value={line.description} onChange={(event) => updatePoLine(index, "description", event.target.value)} className={inputClass} /></Field></div>
                      <Field label="Quantity"><input required inputMode="decimal" placeholder="0.0000" value={line.quantity} onChange={(event) => updatePoLine(index, "quantity", event.target.value)} className={inputClass} /></Field>
                      <Field label="Unit / UOM"><input required maxLength={50} value={line.unit} onChange={(event) => updatePoLine(index, "unit", event.target.value)} className={inputClass} /></Field>
                      <Field label="Unit price"><input required inputMode="decimal" placeholder="0.0000" value={line.unit_price} onChange={(event) => updatePoLine(index, "unit_price", event.target.value)} className={inputClass} /></Field>
                      <div className="sm:col-span-2"><Field label="Inventory item UUID (optional)" hint="Accepted GRN stock requires an active inventory item and an exact UOM match."><input value={line.inventory_item_id} onChange={(event) => updatePoLine(index, "inventory_item_id", event.target.value)} placeholder="Existing inventory item UUID" className={inputClass} /></Field></div>
                    </div>
                  </div>
                ))}
              </div>
              <Field label="Purchase-order notes"><textarea rows={2} value={poDraft.notes} onChange={(event) => setPoDraft((current) => ({ ...current, notes: event.target.value }))} className={inputClass} /></Field>
              <div className="rounded-xl bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">Draft creation does not approve a purchase. After submission, commercial fields are locked. Approval is a separate permission-controlled action; the creator cannot approve their own PO.</div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={() => setPoEditorOpen(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={busy || !canWriteOrders || (!poEditingId && activeSupplierOptions.length === 0)}>{busy ? "Saving…" : poEditingId ? "Save draft" : "Create draft PO"}</button></div>
            </form>
          </section>
        </div>
      ) : null}

      {receiptEditorOpen && poDetail && receiptDraft ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-5" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="receipt-editor-title" className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 id="receipt-editor-title" className="text-lg font-bold text-slate-950">Post goods receipt · {poDetail.po_number}</h2><p className="mt-1 text-xs text-slate-500">Only an approved purchase order can receive stock</p></div><button type="button" className={secondaryButton} disabled={busy} onClick={() => setReceiptEditorOpen(false)}>Close</button></div>
            <form onSubmit={postGoodsReceipt} className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Supplier delivery reference"><input maxLength={150} value={receiptDraft.supplier_delivery_reference} onChange={(event) => setReceiptDraft((current) => current ? { ...current, supplier_delivery_reference: event.target.value } : current)} className={inputClass} /></Field>
                <Field label="Receiving location UUID (optional)" hint="Leave blank to use the active factory default inventory location."><input value={receiptDraft.location_id} onChange={(event) => setReceiptDraft((current) => current ? { ...current, location_id: event.target.value } : current)} className={inputClass} /></Field>
                <Field label="Received at"><input type="datetime-local" value={receiptDraft.received_at} onChange={(event) => setReceiptDraft((current) => current ? { ...current, received_at: event.target.value } : current)} className={inputClass} /></Field>
                <Field label="Receipt notes"><input value={receiptDraft.notes} onChange={(event) => setReceiptDraft((current) => current ? { ...current, notes: event.target.value } : current)} className={inputClass} /></Field>
              </div>
              <div className="space-y-3">
                {receiptDraft.lines.map((line, index) => (
                  <div key={line.purchase_order_line_id} className="rounded-xl border border-slate-200 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-slate-900">{line.line_number}. {line.description}</p><p className="text-[10px] text-slate-500">Ordered {numeric(line.ordered_quantity, 4)} {line.unit}</p></div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Physical received quantity"><input inputMode="decimal" placeholder="0.0000" value={line.received_quantity} onChange={(event) => updateReceiptLine(index, "received_quantity", event.target.value)} className={inputClass} /></Field>
                      <Field label="Rejected quantity"><input inputMode="decimal" value={line.rejected_quantity} onChange={(event) => updateReceiptLine(index, "rejected_quantity", event.target.value)} className={inputClass} /></Field>
                      <Field label="Rejection reason"><input maxLength={2000} value={line.rejection_reason} onChange={(event) => updateReceiptLine(index, "rejection_reason", event.target.value)} className={inputClass} /></Field>
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-xl bg-amber-50 p-3 text-[10px] leading-5 text-amber-900">The API verifies remaining ordered quantity, active inventory item, exact UOM, receiving location and idempotency. A rejection reason is mandatory when rejected quantity is greater than zero. Accepted quantities update stock only inside the server transaction.</div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" className={secondaryButton} disabled={busy} onClick={() => setReceiptEditorOpen(false)}>Cancel</button><button type="submit" className={primaryButton} disabled={busy || !canWriteReceipts}>{busy ? "Posting…" : "Post goods receipt"}</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
