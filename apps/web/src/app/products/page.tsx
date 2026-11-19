"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  filterEngineeringProducts,
  formatEngineeringQuantity,
  summarizeEngineeringRevision,
  summarizeProductPortfolio,
} from "@/lib/product-engineering.mjs";

type Row = Record<string, unknown>;
type Product = Row & {
  id: string; inventory_item_id: string; product_code: string; product_name: string;
  style_code: string | null; size_code: string | null; product_type: string;
  base_unit: string; status: string; version: string;
};
type InventoryItem = Row & { id: string; sku: string; name: string; unit: string; status: string };
type WorkCentre = Row & { id: string; code: string; name: string; status: string; capacity_units_per_hour: string | null };
type Version = Row & {
  id: string; version_number: number; state: string; effective_from: string;
  effective_to: string | null; expected_yield_percent: string; change_summary: string; row_version: string;
  created_by_user_id: string; approved_by_user_id: string | null;
};
type BomLine = Row & {
  id: string; line_number: number; component_item_id: string; component_sku: string; component_name: string;
  quantity_per: string; unit: string; wastage_percent: string; alternate_group_code: string | null; notes: string | null;
  inventory_base_unit: string; base_quantity_per: string;
};
type Alternate = Row & {
  id: string; bom_line_id: string; alternate_item_id: string; alternate_sku: string; alternate_name: string;
  conversion_factor: string; unit: string; rationale: string; status: string;
};
type RoutingStep = Row & {
  id: string; step_number: number; operation_code: string; operation_name: string;
  work_centre_id: string; work_centre_code: string; work_centre_name: string;
  setup_minutes: string; run_minutes_per_unit: string; queue_minutes: string; transfer_minutes: string;
  required_skill: string | null; instructions: string | null; is_quality_gate: boolean;
};
type VersionDetail = { version: Version; bom_lines: BomLine[]; alternates: Alternate[]; routing_steps: RoutingStep[] };
type ChangeOrder = Row & {
  id: string; title: string; rationale: string; effective_date: string; status: string; row_version: string;
  proposed_product_version_id: string; proposed_version_number?: number;
  affected_order_count: number; review_comment: string | null;
};
type BomEdit = { line_number: string; component_item_id: string; quantity_per: string; unit: string; wastage_percent: string; alternate_group_code: string; notes: string };
type RoutingEdit = { step_number: string; operation_code: string; operation_name: string; work_centre_id: string; setup_minutes: string; run_minutes_per_unit: string; queue_minutes: string; transfer_minutes: string; required_skill: string; instructions: string; is_quality_gate: boolean };
type Tab = "overview" | "bom" | "routing" | "eco" | "work-centres";

function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function list<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : []; }
function label(value: unknown, fallback = "—"): string { return typeof value === "string" && value.trim() ? value : fallback; }
function dateLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed."; }
function Metric({ title, value, detail, tone = "slate" }: { title: string; value: string; detail: string; tone?: "slate" | "blue" | "amber" | "emerald" }) {
  const tones = { slate: "border-slate-200 bg-white", blue: "border-blue-100 bg-blue-50/60", amber: "border-amber-100 bg-amber-50/60", emerald: "border-emerald-100 bg-emerald-50/60" };
  return <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{title}</p>
    <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
    <p className="mt-1 text-xs text-slate-500">{detail}</p>
  </article>;
}
function Status({ value }: { value: unknown }) {
  const state = label(value, "UNKNOWN").toUpperCase();
  const tone = state === "APPROVED" || state === "ACTIVE" ? "bg-emerald-50 text-emerald-700"
    : state === "DRAFT" || state === "SUBMITTED" ? "bg-amber-50 text-amber-800"
    : state === "RETIRED" || state === "REJECTED" || state === "DISABLED" ? "bg-slate-100 text-slate-600"
    : "bg-slate-100 text-slate-600";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold " + tone}>{state.replaceAll("_", " ")}</span>;
}
function newBomLine(line: number): BomEdit { return { line_number: String(line), component_item_id: "", quantity_per: "1", unit: "", wastage_percent: "0", alternate_group_code: "", notes: "" }; }
function newRoutingStep(step: number): RoutingEdit { return { step_number: String(step), operation_code: "", operation_name: "", work_centre_id: "", setup_minutes: "0", run_minutes_per_unit: "1", queue_minutes: "0", transfer_minutes: "0", required_skill: "", instructions: "", is_quality_gate: false }; }

export default function ProductEngineeringWorkbenchPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const canRead = hasPermission("products.master.read");
  const canWrite = hasPermission("products.master.write");
  const canVersionApprove = hasPermission("products.version.approve");
  const canAlternateApprove = hasPermission("products.alternate.approve");
  const canEcoRead = hasPermission("products.eco.read");
  const canEcoWrite = hasPermission("products.eco.write");
  const canEcoApprove = hasPermission("products.eco.approve");

  const [products, setProducts] = useState<Product[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [workCentres, setWorkCentres] = useState<WorkCentre[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([]);
  const [selectedChangeOrderId, setSelectedChangeOrderId] = useState("");
  const [changeOrderDetail, setChangeOrderDetail] = useState<Row | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [productCode, setProductCode] = useState("");
  const [productName, setProductName] = useState("");
  const [finishedItemId, setFinishedItemId] = useState("");
  const [styleCode, setStyleCode] = useState("");
  const [sizeCode, setSizeCode] = useState("");
  const [productType, setProductType] = useState("STANDARD");
  const [versionFrom, setVersionFrom] = useState("");
  const [versionTo, setVersionTo] = useState("");
  const [yieldPercent, setYieldPercent] = useState("95");
  const [changeSummary, setChangeSummary] = useState("");

  const [bomEdits, setBomEdits] = useState<BomEdit[]>([]);
  const [routingEdits, setRoutingEdits] = useState<RoutingEdit[]>([]);
  const [alternateLineId, setAlternateLineId] = useState("");
  const [alternateItemId, setAlternateItemId] = useState("");
  const [alternateFactor, setAlternateFactor] = useState("1");
  const [alternateUnit, setAlternateUnit] = useState("");
  const [alternateRationale, setAlternateRationale] = useState("");

  const [ecoVersionId, setEcoVersionId] = useState("");
  const [ecoTitle, setEcoTitle] = useState("");
  const [ecoRationale, setEcoRationale] = useState("");
  const [ecoComment, setEcoComment] = useState("");
  const [wcCode, setWcCode] = useState("");
  const [wcName, setWcName] = useState("");
  const [wcCapacity, setWcCapacity] = useState("");

  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null;
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? detail?.version ?? null;
  const selectedFinishedItem = inventoryItems.find((item) => item.id === finishedItemId) ?? null;
  const filteredProducts = useMemo(() => filterEngineeringProducts(products, search), [products, search]);
  const portfolio = useMemo(() => summarizeProductPortfolio(products, versions), [products, versions]);
  const revisionSummary = useMemo(() => summarizeEngineeringRevision(detail ?? {}), [detail]);

  const loadWorkspace = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) return;
    setLoading(true);
    setError("");
    try {
      const results = await Promise.all([
        request("/products?limit=100"),
        request("/inventory/items?limit=100"),
        request("/products/work-centres?limit=100"),
      ]);
      const nextProducts = list<Product>(results[0]);
      setProducts(nextProducts);
      setInventoryItems(list<InventoryItem>(results[1]).filter((item) => item.status.toUpperCase() === "ACTIVE"));
      setWorkCentres(list<WorkCentre>(results[2]));
      setSelectedProductId((current) => nextProducts.some((item) => item.id === current) ? current : nextProducts[0]?.id ?? "");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  useEffect(() => {
    let active = true;
    async function initialLoad() {
      await Promise.resolve();
      if (!active) return;
      if (status !== "connected" || !activeFactoryId || !canRead) {
        setProducts([]); setInventoryItems([]); setWorkCentres([]); setLoading(false);
        return;
      }
      void loadWorkspace();
    }
    void initialLoad();
    return () => { active = false; };
  }, [status, activeFactoryId, canRead, request, loadWorkspace]);

  useEffect(() => {
    let active = true;
    async function loadProductVersions() {
      await Promise.resolve();
      if (!active) return;
      if (!selectedProductId || !canRead) {
        setVersions([]); setSelectedVersionId(""); setDetail(null); setChangeOrders([]); setSelectedChangeOrderId("");
        return;
      }
      setDetailLoading(true);
      setError("");
      try {
        const tasks: Promise<unknown>[] = [request("/products/" + encodeURIComponent(selectedProductId) + "/versions")];
        if (canEcoRead) tasks.push(request("/products/" + encodeURIComponent(selectedProductId) + "/change-orders?limit=50"));
        const result = await Promise.all(tasks);
        if (!active) return;
        const nextVersions = list<Version>(result[0]);
        setVersions(nextVersions);
        setSelectedVersionId((current) => nextVersions.some((version) => version.id === current) ? current : nextVersions[0]?.id ?? "");
        const nextEcos = canEcoRead ? list<ChangeOrder>(result[1]) : [];
        setChangeOrders(nextEcos);
        setSelectedChangeOrderId((current) => nextEcos.some((eco) => eco.id === current) ? current : nextEcos[0]?.id ?? "");
      } catch (cause) {
        if (active) setError(errorText(cause));
      } finally {
        if (active) setDetailLoading(false);
      }
    }
    void loadProductVersions();
    return () => { active = false; };
  }, [selectedProductId, canRead, canEcoRead, request]);

  useEffect(() => {
    let active = true;
    async function loadVersion() {
      await Promise.resolve();
      if (!active) return;
      if (!selectedProductId || !selectedVersionId) {
        setDetail(null); setBomEdits([]); setRoutingEdits([]);
        return;
      }
      try {
        const result = record(await request("/products/" + encodeURIComponent(selectedProductId) + "/versions/" + encodeURIComponent(selectedVersionId)));
        if (!active) return;
        const loaded = result as VersionDetail;
        setDetail(loaded);
        setBomEdits(list<BomLine>(loaded.bom_lines).map((line) => ({
          line_number: String(line.line_number), component_item_id: line.component_item_id,
          quantity_per: String(line.quantity_per), unit: line.unit,
          wastage_percent: String(line.wastage_percent ?? "0"),
          alternate_group_code: String(line.alternate_group_code ?? ""), notes: String(line.notes ?? ""),
        })));
        setRoutingEdits(list<RoutingStep>(loaded.routing_steps).map((step) => ({
          step_number: String(step.step_number), operation_code: step.operation_code,
          operation_name: step.operation_name, work_centre_id: step.work_centre_id,
          setup_minutes: String(step.setup_minutes ?? "0"), run_minutes_per_unit: String(step.run_minutes_per_unit ?? "0"),
          queue_minutes: String(step.queue_minutes ?? "0"), transfer_minutes: String(step.transfer_minutes ?? "0"),
          required_skill: String(step.required_skill ?? ""), instructions: String(step.instructions ?? ""),
          is_quality_gate: step.is_quality_gate === true,
        })));
      } catch (cause) {
        if (active) { setDetail(null); setError(errorText(cause)); }
      }
    }
    void loadVersion();
    return () => { active = false; };
  }, [selectedProductId, selectedVersionId, request]);

  useEffect(() => {
    let active = true;
    async function loadEcoDetail() {
      await Promise.resolve();
      if (!active) return;
      if (!selectedProductId || !selectedChangeOrderId || !canEcoRead) { setChangeOrderDetail(null); return; }
      try {
        const result = await request("/products/" + encodeURIComponent(selectedProductId) + "/change-orders/" + encodeURIComponent(selectedChangeOrderId));
        if (active) setChangeOrderDetail(record(result));
      } catch (cause) {
        if (active) { setChangeOrderDetail(null); setError(errorText(cause)); }
      }
    }
    void loadEcoDetail();
    return () => { active = false; };
  }, [selectedProductId, selectedChangeOrderId, canEcoRead, request]);

  async function refreshProductData(productId = selectedProductId) {
    if (!productId) return;
    const versionsResult = await request("/products/" + encodeURIComponent(productId) + "/versions");
    const nextVersions = list<Version>(versionsResult);
    setVersions(nextVersions);
    const nextVersionId = nextVersions.some((version) => version.id === selectedVersionId)
      ? selectedVersionId
      : nextVersions[0]?.id ?? "";
    setSelectedVersionId(nextVersionId);
    if (nextVersionId) {
      const versionDetail = record(await request("/products/" + encodeURIComponent(productId) + "/versions/" + encodeURIComponent(nextVersionId))) as VersionDetail;
      setDetail(versionDetail);
      setBomEdits(list<BomLine>(versionDetail.bom_lines).map((line) => ({
        line_number: String(line.line_number), component_item_id: line.component_item_id,
        quantity_per: String(line.quantity_per), unit: line.unit,
        wastage_percent: String(line.wastage_percent ?? "0"),
        alternate_group_code: String(line.alternate_group_code ?? ""), notes: String(line.notes ?? ""),
      })));
      setRoutingEdits(list<RoutingStep>(versionDetail.routing_steps).map((step) => ({
        step_number: String(step.step_number), operation_code: step.operation_code,
        operation_name: step.operation_name, work_centre_id: step.work_centre_id,
        setup_minutes: String(step.setup_minutes ?? "0"), run_minutes_per_unit: String(step.run_minutes_per_unit ?? "0"),
        queue_minutes: String(step.queue_minutes ?? "0"), transfer_minutes: String(step.transfer_minutes ?? "0"),
        required_skill: String(step.required_skill ?? ""), instructions: String(step.instructions ?? ""),
        is_quality_gate: step.is_quality_gate === true,
      })));
    }
    if (canEcoRead) {
      const ecoResult = await request("/products/" + encodeURIComponent(productId) + "/change-orders?limit=50");
      const nextEcos = list<ChangeOrder>(ecoResult);
      setChangeOrders(nextEcos);
      if (!nextEcos.some((eco) => eco.id === selectedChangeOrderId)) setSelectedChangeOrderId(nextEcos[0]?.id ?? "");
    }
    await loadWorkspace();
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFinishedItem) { setError("Choose an active finished-good inventory item."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = record(await request("/products", {
        method: "POST",
        idempotencyKey: "product-engineering-" + crypto.randomUUID(),
        body: {
          inventory_item_id: selectedFinishedItem.id,
          product_code: productCode.trim(),
          product_name: productName.trim(),
          base_unit: selectedFinishedItem.unit,
          product_type: productType,
          ...(styleCode.trim() ? { style_code: styleCode.trim() } : {}),
          ...(sizeCode.trim() ? { size_code: sizeCode.trim() } : {}),
        },
      }));
      const product = record(result.product ?? result) as Product;
      await loadWorkspace();
      if (product.id) setSelectedProductId(product.id);
      setProductCode(""); setProductName(""); setStyleCode(""); setSizeCode("");
      setNotice("Product definition created and bound to its finished-good inventory item.");
      setTab("overview");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct) return;
    if (!versionFrom) { setError("Choose an effective-from date."); return; }
    if (versionTo && versionTo < versionFrom) { setError("Effective-to date must be on or after effective-from."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = record(await request("/products/" + encodeURIComponent(selectedProduct.id) + "/versions", {
        method: "POST",
        idempotencyKey: "product-version-" + crypto.randomUUID(),
        body: {
          effective_from: versionFrom,
          ...(versionTo ? { effective_to: versionTo } : {}),
          expected_yield_percent: Number(yieldPercent),
          change_summary: changeSummary.trim(),
        },
      }));
      const version = record(result.version ?? result) as Version;
      await refreshProductData(selectedProduct.id);
      if (version.id) setSelectedVersionId(version.id);
      setVersionFrom(""); setVersionTo(""); setChangeSummary("");
      setNotice("Draft product revision created. Configure BOM and routing, then submit an engineering change order.");
      setTab("bom");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  function updateBomLine(index: number, patch: Partial<BomEdit>) {
    setBomEdits((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  }
  function updateRoutingStep(index: number, patch: Partial<RoutingEdit>) {
    setRoutingEdits((current) => current.map((step, i) => i === index ? { ...step, ...patch } : step));
  }

  async function saveBom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct || !selectedVersion || selectedVersion.state !== "DRAFT") return;
    const lines = bomEdits.map((line) => ({
      line_number: Number(line.line_number),
      component_item_id: line.component_item_id,
      quantity_per: Number(line.quantity_per),
      unit: line.unit.trim(),
      wastage_percent: Number(line.wastage_percent || 0),
      ...(line.alternate_group_code.trim() ? { alternate_group_code: line.alternate_group_code.trim() } : {}),
      ...(line.notes.trim() ? { notes: line.notes.trim() } : {}),
    }));
    if (!lines.length || lines.some((line) => !Number.isInteger(line.line_number) || line.line_number < 1 || !line.component_item_id || !Number.isFinite(line.quantity_per) || line.quantity_per <= 0 || !line.unit)) {
      setError("Each BOM row requires a unique positive line number, active component, positive quantity and unit.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/products/" + encodeURIComponent(selectedProduct.id) + "/versions/" + encodeURIComponent(selectedVersion.id) + "/bom", {
        method: "PUT",
        body: { expected_version: Number(selectedVersion.row_version), lines },
      });
      setNotice("BOM saved. Component units are checked and versioned by the API.");
      await refreshProductData(selectedProduct.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function saveRouting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct || !selectedVersion || selectedVersion.state !== "DRAFT") return;
    const steps = routingEdits.map((step) => ({
      step_number: Number(step.step_number),
      operation_code: step.operation_code.trim(),
      operation_name: step.operation_name.trim(),
      work_centre_id: step.work_centre_id,
      setup_minutes: Number(step.setup_minutes || 0),
      run_minutes_per_unit: Number(step.run_minutes_per_unit || 0),
      queue_minutes: Number(step.queue_minutes || 0),
      transfer_minutes: Number(step.transfer_minutes || 0),
      ...(step.required_skill.trim() ? { required_skill: step.required_skill.trim() } : {}),
      ...(step.instructions.trim() ? { instructions: step.instructions.trim() } : {}),
      is_quality_gate: step.is_quality_gate,
    }));
    if (!steps.length || steps.some((step) => !Number.isInteger(step.step_number) || step.step_number < 1 || !step.operation_code || !step.operation_name || !step.work_centre_id || step.setup_minutes + step.run_minutes_per_unit + step.queue_minutes + step.transfer_minutes <= 0)) {
      setError("Each routing step requires a unique positive step number, operation, active work centre and positive total duration.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/products/" + encodeURIComponent(selectedProduct.id) + "/versions/" + encodeURIComponent(selectedVersion.id) + "/routing", {
        method: "PUT",
        body: { expected_version: Number(selectedVersion.row_version), steps },
      });
      setNotice("Routing saved. Work-centre references and operation durations were validated by the API.");
      await refreshProductData(selectedProduct.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function createAlternate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct || !selectedVersion || selectedVersion.state !== "DRAFT" || !alternateLineId || !alternateItemId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/products/" + encodeURIComponent(selectedProduct.id) + "/versions/" + encodeURIComponent(selectedVersion.id) + "/bom-lines/" + encodeURIComponent(alternateLineId) + "/alternates", {
        method: "POST",
        idempotencyKey: "product-alternate-" + crypto.randomUUID(),
        body: {
          expected_version: Number(selectedVersion.row_version), alternate_item_id: alternateItemId,
          conversion_factor: Number(alternateFactor), unit: alternateUnit.trim(), rationale: alternateRationale.trim(),
        },
      });
      setAlternateItemId(""); setAlternateRationale("");
      setNotice("Alternate material contract created in DRAFT. It cannot be used until a different authorized user approves it.");
      await refreshProductData(selectedProduct.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function resolveAlternate(alternate: Alternate, action: "approve" | "retire") {
    if (!selectedProduct || !selectedVersion) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/products/" + encodeURIComponent(selectedProduct.id) + "/versions/" + encodeURIComponent(selectedVersion.id) + "/alternates/" + encodeURIComponent(alternate.id) + "/" + action, {
        method: "POST",
        idempotencyKey: "product-alternate-" + action + "-" + crypto.randomUUID(),
        body: { expected_version: Number(selectedVersion.row_version) },
      });
      setNotice(action === "approve" ? "Alternate material approved." : "Alternate material retired.");
      await refreshProductData(selectedProduct.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function createEco(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct || !ecoVersionId) return;
    const version = versions.find((item) => item.id === ecoVersionId);
    if (!version || version.state !== "DRAFT") { setError("Choose a draft revision."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = record(await request("/products/" + encodeURIComponent(selectedProduct.id) + "/change-orders", {
        method: "POST",
        idempotencyKey: "product-eco-" + crypto.randomUUID(),
        body: {
          proposed_version_id: version.id, title: ecoTitle.trim(), rationale: ecoRationale.trim(),
          effective_date: version.effective_from,
        },
      }));
      const eco = record(result.change_order ?? result) as ChangeOrder;
      await refreshProductData(selectedProduct.id);
      if (eco.id) setSelectedChangeOrderId(eco.id);
      setEcoTitle(""); setEcoRationale("");
      setNotice("Engineering change order created. Submit it after reviewing the saved revision diff.");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function actOnEco(action: "submit" | "approve" | "reject") {
    if (!selectedProduct || !changeOrderDetail) return;
    const current = changeOrderDetail as ChangeOrder;
    if (action === "reject" && !ecoComment.trim()) { setError("A rejection comment is required."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/products/" + encodeURIComponent(selectedProduct.id) + "/change-orders/" + encodeURIComponent(current.id) + "/" + action, {
        method: "POST",
        idempotencyKey: "product-eco-" + action + "-" + crypto.randomUUID(),
        body: { expected_version: Number(current.row_version), ...(ecoComment.trim() ? { comment: ecoComment.trim() } : {}) },
      });
      setNotice(action === "submit" ? "ECO submitted with an immutable revision diff and affected-order snapshot." : action === "approve" ? "ECO approved. The API released the proposed revision." : "ECO rejected with the recorded reviewer comment.");
      setEcoComment("");
      await refreshProductData(selectedProduct.id);
      setSelectedChangeOrderId(current.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function createWorkCentre(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/products/work-centres", {
        method: "POST",
        idempotencyKey: "work-centre-" + crypto.randomUUID(),
        body: { code: wcCode.trim(), name: wcName.trim(), ...(wcCapacity.trim() ? { capacity_units_per_hour: Number(wcCapacity) } : {}) },
      });
      setWcCode(""); setWcName(""); setWcCapacity("");
      const result = await request("/products/work-centres?limit=100");
      setWorkCentres(list<WorkCentre>(result));
      setNotice("Manufacturing work centre created.");
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  if (status !== "connected" || !snapshot) {
    return <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6"><section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Product engineering</p><h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Product masters, BOM revisions and routing are factory-scoped. Connect a FactoryOS session and choose an active factory to continue.</p>
      <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white">Connect session</Link>
    </section></main>;
  }
  if (!activeFactoryId) return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Select an active factory in the workspace header before opening product engineering.</div></main>;
  if (!canRead) return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold">Product master access required</h1><p className="mt-2 text-sm">Your IAM snapshot does not include <code>products.master.read</code>.</p></div></main>;

  const draftVersions = versions.filter((version) => version.state === "DRAFT");
  const editable = selectedVersion?.state === "DRAFT";
  const alternates = detail?.alternates ?? [];
  const activeFactory = snapshot.factories.find((factory) => factory.id === activeFactoryId);
  const diffSnapshot = record(changeOrderDetail?.diff_snapshot);
  const affectedOrders = list<Row>(changeOrderDetail?.affected_orders);
  const ecoEvents = list<Row>(changeOrderDetail?.events);

  return <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Manufacturing engineering · master data</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Product Engineering Workbench</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Manage finished-good product definitions, effective-dated revisions, bill of materials, routing and governed engineering changes. Released versions are immutable contracts for planning and production.</p>
        <p className="mt-2 text-xs font-medium text-slate-500">{snapshot.tenant.name} · {activeFactory?.name ?? "Active factory"}</p>
      </div>
      <button type="button" onClick={() => void loadWorkspace()} disabled={loading} className="min-h-10 self-start rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 lg:self-auto">{loading ? "Refreshing…" : "Refresh workspace"}</button>
    </header>

    {error ? <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
    {notice ? <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

    <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric title="Product masters" value={String(portfolio.products)} detail="Records in the selected factory" tone="blue" />
      <Metric title="Active products" value={String(portfolio.active)} detail="Eligible product definitions" tone="emerald" />
      <Metric title="Draft revisions" value={String(portfolio.draftVersions)} detail="Across the selected product" />
      <Metric title="Approved revisions" value={String(portfolio.approvedVersions)} detail="Released effective-dated contracts" tone="blue" />
    </section>

    <section className="mt-7 grid gap-5 lg:grid-cols-[290px_minmax(0,1fr)]">
      <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4"><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Product register</p><h2 className="mt-1 text-lg font-bold text-slate-950">Finished goods</h2><p className="mt-1 text-xs text-slate-500">{products.length} product(s) · latest 100</p>
          <input aria-label="Search products" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code, name, style…" className="mt-3 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" />
        </div>
        <div className="max-h-[550px] space-y-2 overflow-y-auto p-3">
          {loading && products.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">Loading products…</p> : null}
          {!loading && filteredProducts.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">No product definitions match this search.</p> : null}
          {filteredProducts.map((product) => <button type="button" key={product.id} onClick={() => setSelectedProductId(product.id)} className={"w-full rounded-xl border p-3 text-left " + (selectedProductId === product.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50")}>
            <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs font-bold text-slate-900">{product.product_code}</span><Status value={product.status} /></div>
            <p className="mt-1 text-sm font-semibold text-slate-800">{product.product_name}</p>
            <p className="mt-1 text-[10px] text-slate-500">{product.style_code || "No style"} · {product.size_code || "No size"} · {product.product_type}</p>
          </button>)}
        </div>
        {canWrite ? <form onSubmit={createProduct} className="border-t border-slate-200 p-4">
          <h3 className="text-sm font-bold text-slate-950">Create product master</h3>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Finished-good inventory item<select required value={finishedItemId} onChange={(event) => setFinishedItemId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Select active item…</option>{inventoryItems.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name} ({item.unit})</option>)}</select></label>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Product code<input required maxLength={120} value={productCode} onChange={(event) => setProductCode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Product name<input required maxLength={255} value={productName} onChange={(event) => setProductName(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label>
          <div className="mt-3 grid grid-cols-2 gap-2"><label className="block text-xs font-semibold text-slate-600">Style<input maxLength={120} value={styleCode} onChange={(event) => setStyleCode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Size<input maxLength={80} value={sizeCode} onChange={(event) => setSizeCode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label></div>
          <label className="mt-3 block text-xs font-semibold text-slate-600">Product type<select value={productType} onChange={(event) => setProductType(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option>STANDARD</option><option>CONFIGURABLE</option><option>PHANTOM</option><option>KIT</option></select></label>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">Base unit is bound to the selected inventory item. Create the inventory master first when no finished-good item exists.</p>
          <button disabled={busy || !finishedItemId || !productCode.trim() || !productName.trim()} className="mt-3 min-h-10 w-full rounded-lg bg-slate-950 px-3 text-sm font-bold text-white disabled:opacity-50">{busy ? "Creating…" : "Create product"}</button>
        </form> : <p className="border-t border-slate-200 p-4 text-xs text-slate-500">Read-only master access.</p>}
      </aside>

      <section className="min-w-0 space-y-4">
        {!selectedProduct ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><h2 className="font-bold text-slate-900">No product selected</h2><p className="mt-2 text-sm text-slate-500">Create a product master or select one from the register.</p></div> : <>
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Selected product</p><h2 className="mt-1 text-xl font-bold text-slate-950">{selectedProduct.product_name}</h2><p className="mt-1 font-mono text-xs text-slate-500">{selectedProduct.product_code} · {selectedProduct.style_code || "No style"} · {selectedProduct.size_code || "No size"}</p><p className="mt-1 text-xs text-slate-500">Bound inventory item: {inventoryItems.find((item) => item.id === selectedProduct.inventory_item_id)?.sku ?? selectedProduct.inventory_item_id} · Base unit {selectedProduct.base_unit}</p></div><div className="flex flex-wrap items-center gap-2"><Status value={selectedProduct.status} /><span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-bold text-slate-600">{selectedProduct.product_type}</span></div></div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] text-slate-500">BOM lines</p><p className="mt-1 text-lg font-bold">{revisionSummary.bomLines}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Routing steps</p><p className="mt-1 text-lg font-bold">{revisionSummary.routingSteps}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Alternate contracts</p><p className="mt-1 text-lg font-bold">{revisionSummary.alternates}</p></div></div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Product engineering sections">
              {([{ id: "overview", label: "Revisions" }, { id: "bom", label: "BOM & alternates" }, { id: "routing", label: "Routing" }, { id: "eco", label: "Engineering changes" }, { id: "work-centres", label: "Work centres" }] as const).map((item) => <button type="button" role="tab" aria-selected={tab === item.id} key={item.id} onClick={() => setTab(item.id)} className={"min-h-9 rounded-lg px-3 text-xs font-bold " + (tab === item.id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
            </div>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">Revision<select aria-label="Selected product revision" value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)} className="min-h-9 max-w-48 rounded-lg border border-slate-300 bg-white px-2 text-xs">{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {version.state}</option>)}</select></label>
          </div>

          {tab === "overview" ? <div className="space-y-4">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-950">Effective-dated revision history</h3><p className="mt-1 text-xs text-slate-500">Approved revisions become the production and MRP source contract. Drafts remain editable until released.</p></div><span className="text-xs font-semibold text-slate-500">{versions.length} revision(s)</span></div>
              {versions.length ? <div className="mt-4 space-y-2">{versions.map((version) => <button type="button" key={version.id} onClick={() => setSelectedVersionId(version.id)} className={"w-full rounded-xl border p-3 text-left " + (selectedVersionId === version.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50")}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-slate-900">Revision v{version.version_number}</p><Status value={version.state} /></div><div className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-3"><p>Effective: {dateLabel(version.effective_from)}{version.effective_to ? " → " + dateLabel(version.effective_to) : " → Open ended"}</p><p>Expected yield: {version.expected_yield_percent}%</p><p>Row version: {version.row_version}</p></div><p className="mt-2 text-xs text-slate-500">{version.change_summary}</p></button>)}</div> : <p className="mt-4 rounded-xl bg-slate-50 p-5 text-center text-sm text-slate-500">No revisions exist. Create a draft revision to begin BOM and routing setup.</p>}
            </section>
            {canWrite ? <form onSubmit={createVersion} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><h3 className="font-bold text-slate-950">Create new draft revision</h3><p className="mt-1 text-xs text-slate-500">Revision numbers are assigned by the API. Use a new revision rather than editing an approved contract.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="block text-xs font-semibold text-slate-600">Effective from<input required type="date" value={versionFrom} onChange={(event) => setVersionFrom(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Effective to (optional)<input type="date" min={versionFrom || undefined} value={versionTo} onChange={(event) => setVersionTo(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Expected yield (%)<input required type="number" min="0.0001" max="100" step="0.0001" value={yieldPercent} onChange={(event) => setYieldPercent(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600 sm:col-span-2">Change summary<textarea required minLength={1} maxLength={2000} rows={2} value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm" /></label></div><button disabled={busy || !versionFrom || !changeSummary.trim()} className="mt-4 min-h-10 rounded-lg bg-blue-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Creating…" : "Create draft revision"}</button></form> : null}
          </div> : null}

          {tab === "bom" ? <div className="space-y-4">
            {!selectedVersion ? <div className="rounded-xl bg-white p-8 text-center text-sm text-slate-500">Select a revision first.</div> : <>
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-slate-950">Bill of materials · v{selectedVersion.version_number}</h3><p className="mt-1 text-xs leading-5 text-slate-500">Component quantities are expressed in their declared unit and converted to inventory base-unit snapshots by the API.</p></div><Status value={selectedVersion.state} /></div>
                {editable && canWrite ? <form onSubmit={saveBom} className="mt-4 space-y-3">
                  {bomEdits.map((line, index) => <div key={index} className="rounded-xl border border-slate-200 p-3"><div className="grid gap-2 sm:grid-cols-[70px_minmax(0,1fr)_110px_110px]"><label className="text-[10px] font-bold text-slate-500">Line #<input required type="number" min="1" value={line.line_number} onChange={(event) => updateBomLine(index, { line_number: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500 sm:col-span-3">Component inventory item<select required value={line.component_item_id} onChange={(event) => { const item = inventoryItems.find((x) => x.id === event.target.value); updateBomLine(index, { component_item_id: event.target.value, unit: item?.unit ?? line.unit }); }} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Select active component…</option>{inventoryItems.filter((item) => item.id !== selectedProduct.inventory_item_id).map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name} ({item.unit})</option>)}</select></label><label className="text-[10px] font-bold text-slate-500">Quantity per<input required type="number" min="0.0001" step="0.0001" value={line.quantity_per} onChange={(event) => updateBomLine(index, { quantity_per: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500">Unit<input required maxLength={50} value={line.unit} onChange={(event) => updateBomLine(index, { unit: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500">Wastage %<input type="number" min="0" max="100" step="0.0001" value={line.wastage_percent} onChange={(event) => updateBomLine(index, { wastage_percent: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500">Alternate group<input maxLength={100} value={line.alternate_group_code} onChange={(event) => updateBomLine(index, { alternate_group_code: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label></div><div className="mt-2 flex items-center gap-2"><input aria-label="BOM line notes" maxLength={2000} value={line.notes} onChange={(event) => updateBomLine(index, { notes: event.target.value })} placeholder="Line notes (optional)" className="min-h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-xs" /><button type="button" onClick={() => setBomEdits((current) => current.filter((_, i) => i !== index))} className="min-h-9 rounded-lg border border-rose-200 px-3 text-xs font-semibold text-rose-700">Remove</button></div></div>)}
                  <div className="flex flex-wrap justify-between gap-2"><button type="button" onClick={() => setBomEdits((current) => [...current, newBomLine(current.length + 1)])} className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold">+ Add BOM line</button><button disabled={busy || bomEdits.length === 0} className="min-h-9 rounded-lg bg-blue-700 px-4 text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving…" : "Save BOM revision"}</button></div>
                </form> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-xs"><thead className="bg-slate-50 uppercase text-slate-500"><tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Component</th><th className="px-3 py-2">Qty per</th><th className="px-3 py-2">Wastage</th><th className="px-3 py-2">Unit snapshot</th></tr></thead><tbody className="divide-y divide-slate-100">{(detail?.bom_lines ?? []).map((line) => <tr key={line.id}><td className="px-3 py-3">{line.line_number}</td><td className="px-3 py-3"><p className="font-mono font-bold">{line.component_sku}</p><p className="mt-1 text-slate-500">{line.component_name}</p></td><td className="px-3 py-3 tabular-nums">{formatEngineeringQuantity(line.quantity_per, line.unit)}</td><td className="px-3 py-3">{line.wastage_percent}%</td><td className="px-3 py-3">{line.inventory_base_unit} · {line.base_quantity_per}</td></tr>)}</tbody></table>{!detail?.bom_lines.length ? <p className="p-5 text-center text-sm text-slate-500">No BOM lines in this revision.</p> : null}</div>}
              </section>
              <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold text-slate-950">Alternate material contracts</h3><p className="mt-1 text-xs text-slate-500">Draft alternates are not authorized for MRP allocation until checked and approved by a different user.</p></div><span className="text-xs font-semibold text-slate-500">{alternates.length} contract(s)</span></div>
                {alternates.length ? <div className="mt-3 space-y-2">{alternates.map((alternate) => <article key={alternate.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"><div className="min-w-0"><p className="text-xs font-bold text-slate-900">{alternate.alternate_sku} · {alternate.alternate_name}</p><p className="mt-1 text-[10px] text-slate-500">Factor {alternate.conversion_factor} {alternate.unit} · {alternate.rationale}</p></div><div className="flex items-center gap-2"><Status value={alternate.status} />{alternate.status === "DRAFT" && canAlternateApprove ? <button type="button" disabled={busy || !editable} onClick={() => void resolveAlternate(alternate, "approve")} className="min-h-8 rounded-lg bg-emerald-700 px-3 text-[10px] font-bold text-white disabled:opacity-50">Approve</button> : null}{["DRAFT", "APPROVED"].includes(alternate.status) && canAlternateApprove ? <button type="button" disabled={busy || !editable} onClick={() => void resolveAlternate(alternate, "retire")} className="min-h-8 rounded-lg border border-slate-300 px-3 text-[10px] font-bold text-slate-700 disabled:opacity-50">Retire</button> : null}</div></article>)}</div> : <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No alternate-material contracts saved for this revision.</p>}
                {editable && canWrite && detail?.bom_lines.length ? <form onSubmit={createAlternate} className="mt-4 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2"><label className="block text-xs font-semibold text-slate-600">Primary BOM line<select required value={alternateLineId} onChange={(event) => setAlternateLineId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Select BOM line…</option>{detail.bom_lines.map((line) => <option key={line.id} value={line.id}>#{line.line_number} · {line.component_sku}</option>)}</select></label><label className="block text-xs font-semibold text-slate-600">Alternate inventory item<select required value={alternateItemId} onChange={(event) => { const item = inventoryItems.find((x) => x.id === event.target.value); setAlternateItemId(event.target.value); setAlternateUnit(item?.unit ?? ""); }} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Select active item…</option>{inventoryItems.filter((item) => item.id !== selectedProduct.inventory_item_id).map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name} ({item.unit})</option>)}</select></label><label className="block text-xs font-semibold text-slate-600">Conversion factor<input required type="number" min="0.000001" step="0.000001" value={alternateFactor} onChange={(event) => setAlternateFactor(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Alternate unit<input required maxLength={50} value={alternateUnit} onChange={(event) => setAlternateUnit(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600 sm:col-span-2">Rationale<input required minLength={1} maxLength={2000} value={alternateRationale} onChange={(event) => setAlternateRationale(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><button disabled={busy || !alternateLineId || !alternateItemId || !alternateUnit.trim() || !alternateRationale.trim()} className="min-h-10 rounded-lg bg-slate-900 px-4 text-xs font-bold text-white sm:col-span-2 disabled:opacity-50">{busy ? "Saving…" : "Create draft alternate"}</button></form> : null}
              </section>
            </>}
          </div> : null}

          {tab === "routing" ? <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold text-slate-950">Manufacturing routing · v{selectedVersion?.version_number ?? "—"}</h3><p className="mt-1 text-xs text-slate-500">Ordered operations, work-centre assignments, setup/run/queue/transfer duration and quality gates.</p></div>{selectedVersion ? <Status value={selectedVersion.state} /> : null}</div>
            {editable && canWrite ? <form onSubmit={saveRouting} className="mt-4 space-y-3">
              {routingEdits.map((step, index) => <div key={index} className="rounded-xl border border-slate-200 p-3"><div className="grid gap-2 sm:grid-cols-4"><label className="text-[10px] font-bold text-slate-500">Step #<input required type="number" min="1" value={step.step_number} onChange={(event) => updateRoutingStep(index, { step_number: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500">Operation code<input required maxLength={100} value={step.operation_code} onChange={(event) => updateRoutingStep(index, { operation_code: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500 sm:col-span-2">Operation name<input required maxLength={255} value={step.operation_name} onChange={(event) => updateRoutingStep(index, { operation_name: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="text-[10px] font-bold text-slate-500 sm:col-span-2">Work centre<select required value={step.work_centre_id} onChange={(event) => updateRoutingStep(index, { work_centre_id: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Select active work centre…</option>{workCentres.filter((wc) => wc.status === "ACTIVE").map((wc) => <option key={wc.id} value={wc.id}>{wc.code} · {wc.name}</option>)}</select></label>{(["setup_minutes", "run_minutes_per_unit", "queue_minutes", "transfer_minutes"] as const).map((field) => <label key={field} className="text-[10px] font-bold text-slate-500">{field.replaceAll("_", " ")}<input type="number" min="0" step="0.0001" value={step[field]} onChange={(event) => updateRoutingStep(index, { [field]: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>)}</div><div className="mt-2 grid gap-2 sm:grid-cols-[1fr_100px_auto]"><label className="text-[10px] font-bold text-slate-500">Required skill (optional)<input maxLength={120} value={step.required_skill} onChange={(event) => updateRoutingStep(index, { required_skill: event.target.value })} className="mt-1 min-h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label><label className="flex items-center gap-2 pt-4 text-xs font-semibold text-slate-600"><input type="checkbox" checked={step.is_quality_gate} onChange={(event) => updateRoutingStep(index, { is_quality_gate: event.target.checked })} /> Quality gate</label><button type="button" onClick={() => setRoutingEdits((current) => current.filter((_, i) => i !== index))} className="mt-3 min-h-9 rounded-lg border border-rose-200 px-3 text-xs font-semibold text-rose-700">Remove step</button></div><textarea aria-label="Operation instructions" maxLength={4000} rows={2} value={step.instructions} onChange={(event) => updateRoutingStep(index, { instructions: event.target.value })} placeholder="Operator instructions (optional)" className="mt-2 w-full rounded-lg border border-slate-300 p-2 text-xs" /></div>)}
              <div className="flex flex-wrap justify-between gap-2"><button type="button" onClick={() => setRoutingEdits((current) => [...current, newRoutingStep(current.length + 1)])} className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold">+ Add routing step</button><button disabled={busy || routingEdits.length === 0} className="min-h-9 rounded-lg bg-blue-700 px-4 text-xs font-bold text-white disabled:opacity-50">{busy ? "Saving…" : "Save routing revision"}</button></div>
            </form> : <div className="mt-4 space-y-2">{(detail?.routing_steps ?? []).map((step) => <article key={step.id} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold text-slate-900">{step.step_number}. {step.operation_code} · {step.operation_name}</p>{step.is_quality_gate ? <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700">Quality gate</span> : null}</div><p className="mt-1 text-xs text-slate-500">{step.work_centre_code} · {step.work_centre_name} · Skill: {step.required_skill || "Not specified"}</p><div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4"><p>Setup {step.setup_minutes}m</p><p>Run {step.run_minutes_per_unit}m/unit</p><p>Queue {step.queue_minutes}m</p><p>Transfer {step.transfer_minutes}m</p></div>{step.instructions ? <p className="mt-2 text-xs leading-5 text-slate-500">{step.instructions}</p> : null}</article>)}{!detail?.routing_steps.length ? <p className="rounded-xl bg-slate-50 p-5 text-center text-sm text-slate-500">No routing steps in this revision.</p> : null}</div>}
          </section> : null}

          {tab === "eco" ? <div className="space-y-4">
            {!canEcoRead ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Your role does not include <code>products.eco.read</code>.</div> : <>
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold text-slate-950">Engineering change orders (ECO)</h3><p className="mt-1 text-xs leading-5 text-slate-500">Govern revision submission, immutable BOM/routing diff, affected production-order snapshot and checker approval.</p></div><span className="text-xs font-semibold text-slate-500">{changeOrders.length} ECO(s)</span></div>
                {changeOrders.length ? <div className="mt-3 flex flex-wrap gap-2">{changeOrders.map((eco) => <button type="button" key={eco.id} onClick={() => setSelectedChangeOrderId(eco.id)} className={"rounded-xl border px-3 py-2 text-left " + (selectedChangeOrderId === eco.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50")}><p className="text-xs font-bold text-slate-900">{eco.title}</p><p className="mt-1 text-[10px] text-slate-500">{dateLabel(eco.effective_date)} · {eco.affected_order_count} affected order(s)</p><div className="mt-1"><Status value={eco.status} /></div></button>)}</div> : <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No engineering change orders exist for this product.</p>}
              </section>
              {canEcoWrite && draftVersions.length ? <form onSubmit={createEco} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"><h3 className="font-bold text-slate-950">Create ECO from a draft revision</h3><label className="mt-3 block text-xs font-semibold text-slate-600">Proposed revision<select required value={ecoVersionId} onChange={(event) => setEcoVersionId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="">Select draft revision…</option>{draftVersions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {dateLabel(version.effective_from)}</option>)}</select></label><label className="mt-3 block text-xs font-semibold text-slate-600">Change title<input required minLength={3} maxLength={160} value={ecoTitle} onChange={(event) => setEcoTitle(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="mt-3 block text-xs font-semibold text-slate-600">Rationale<textarea required minLength={10} maxLength={4000} rows={3} value={ecoRationale} onChange={(event) => setEcoRationale(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm" /></label><p className="mt-2 text-[10px] leading-5 text-slate-500">The ECO effective date is taken from the proposed revision. The API checks that the date is not backdated and that baseline approval has not changed.</p><button disabled={busy || !ecoVersionId || ecoTitle.trim().length < 3 || ecoRationale.trim().length < 10} className="mt-3 min-h-10 rounded-lg bg-blue-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Creating…" : "Create engineering change order"}</button></form> : null}
              {changeOrderDetail ? <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold text-slate-950">{label(changeOrderDetail.title)}</h3><p className="mt-1 text-xs text-slate-500">Effective {dateLabel(changeOrderDetail.effective_date)} · Row version {String(changeOrderDetail.row_version)}</p></div><Status value={changeOrderDetail.status} /></div><p className="mt-3 text-sm leading-6 text-slate-700">{label(changeOrderDetail.rationale)}</p>
                <div className="mt-4 grid gap-2 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Affected orders</p><p className="mt-1 text-lg font-bold">{String(changeOrderDetail.affected_order_count ?? affectedOrders.length)}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] text-slate-500">BOM changes</p><p className="mt-1 text-lg font-bold">{String(record(diffSnapshot.summary).bom_changes ?? 0)}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] text-slate-500">Routing changes</p><p className="mt-1 text-lg font-bold">{String(record(diffSnapshot.summary).routing_changes ?? 0)}</p></div></div>
                <div className="mt-4"><h4 className="text-sm font-bold">Immutable revision diff</h4><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-3 text-[10px] leading-5 text-slate-100">{JSON.stringify(diffSnapshot, null, 2)}</pre></div>
                <div className="mt-4"><h4 className="text-sm font-bold">Affected work orders</h4>{affectedOrders.length ? <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">Work order</th><th className="px-3 py-2">Status snapshot</th><th className="px-3 py-2">Planned start</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Impact</th></tr></thead><tbody className="divide-y divide-slate-100">{affectedOrders.map((item) => <tr key={String(item.id)}><td className="px-3 py-3 font-bold">{label(item.work_order_number)}</td><td className="px-3 py-3">{label(item.status)}</td><td className="px-3 py-3">{dateLabel(item.planned_start_date)}</td><td className="px-3 py-3">{dateLabel(item.due_date)}</td><td className="px-3 py-3">{label(item.impact_type)}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-xs text-slate-500">No impacted work orders were captured for this ECO.</p>}</div>
                {changeOrderDetail.review_comment ? <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">Reviewer comment: {String(changeOrderDetail.review_comment)}</p> : null}
                <div className="mt-4"><h4 className="text-sm font-bold">ECO event history</h4><div className="mt-2 space-y-2">{ecoEvents.map((event, index) => <article key={String(event.id ?? index)} className="rounded-lg border border-slate-200 p-3"><p className="text-xs font-bold">{label(event.event_type)} · {dateLabel(event.created_at)}</p><p className="mt-1 text-[10px] text-slate-500">{label(event.from_status, "—")} → {label(event.to_status, "—")} · Actor {label(event.actor_user_id)}</p></article>)}</div></div>
                <div className="mt-5 border-t border-slate-200 pt-4"><label className="block text-xs font-semibold text-slate-600">Reviewer comment (required for rejection)<textarea rows={2} maxLength={2000} value={ecoComment} onChange={(event) => setEcoComment(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm" /></label><div className="mt-3 flex flex-wrap gap-2">{changeOrderDetail.status === "DRAFT" && canEcoWrite ? <button type="button" disabled={busy} onClick={() => void actOnEco("submit")} className="min-h-10 rounded-lg bg-blue-700 px-4 text-xs font-bold text-white disabled:opacity-50">Submit ECO</button> : null}{changeOrderDetail.status === "SUBMITTED" && canEcoApprove ? <><button type="button" disabled={busy} onClick={() => void actOnEco("approve")} className="min-h-10 rounded-lg bg-emerald-700 px-4 text-xs font-bold text-white disabled:opacity-50">Approve & release</button><button type="button" disabled={busy || !ecoComment.trim()} onClick={() => void actOnEco("reject")} className="min-h-10 rounded-lg border border-rose-300 px-4 text-xs font-bold text-rose-700 disabled:opacity-50">Reject ECO</button></> : null}</div><p className="mt-3 text-[10px] leading-5 text-slate-500">The API enforces checker separation: approver/rejector must differ from the ECO creator and submitter. A stale row version or changed affected-order snapshot is rejected.</p></div>
              </section> : null}
            </>}
          </div> : null}

          {tab === "work-centres" ? <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold text-slate-950">Manufacturing work centres</h3><p className="mt-1 text-xs text-slate-500">Active centres are selectable in product routing and finite-capacity planning.</p></div><span className="text-xs font-semibold text-slate-500">{workCentres.length} centre(s)</span></div>
            {workCentres.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{workCentres.map((wc) => <article key={wc.id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><p className="font-mono text-sm font-bold">{wc.code}</p><Status value={wc.status} /></div><p className="mt-1 text-sm text-slate-700">{wc.name}</p><p className="mt-2 text-xs text-slate-500">Capacity: {wc.capacity_units_per_hour ?? "Not specified"} units/hour</p></article>)}</div> : <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No work centres have been configured in this factory.</p>}
            {canWrite ? <form onSubmit={createWorkCentre} className="mt-5 grid gap-2 border-t border-slate-200 pt-4 sm:grid-cols-3"><label className="block text-xs font-semibold text-slate-600">Centre code<input required maxLength={100} value={wcCode} onChange={(event) => setWcCode(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Centre name<input required maxLength={255} value={wcName} onChange={(event) => setWcName(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="block text-xs font-semibold text-slate-600">Capacity units/hour (optional)<input type="number" min="0.0001" step="0.0001" value={wcCapacity} onChange={(event) => setWcCapacity(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label><button disabled={busy || !wcCode.trim() || !wcName.trim()} className="min-h-10 rounded-lg bg-slate-950 px-4 text-xs font-bold text-white sm:col-span-3 disabled:opacity-50">{busy ? "Creating…" : "Create work centre"}</button></form> : null}
          </section> : null}
        </>}
      </section>
    </section>
    <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 text-[11px] text-slate-500"><span>Factory-scoped · Effective-dated revisions · Server-enforced change control</span><span>Approved specifications remain immutable; new engineering changes require a new draft version.</span></footer>
  </main>;
}
