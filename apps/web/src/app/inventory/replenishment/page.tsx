"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  allocationPolicyLabel,
  asInventoryRows,
  buildAllocationPolicyPayload,
  buildReorderPolicyPayload,
  filterReplenishmentRows,
  getReorderEditorDefaults,
  replenishmentMetrics,
  resolveAllocationPolicy,
  summarizeReplenishment,
} from "@/lib/inventory-replenishment.mjs";
import type {
  AllocationPolicy,
  InventoryMaterial,
  ReplenishmentSignal,
  ReplenishmentSupplier,
} from "@/lib/inventory-replenishment.mjs";

type Tab = "shortages" | "recommendations" | "allocation";
type AllocationScope = "MATERIAL" | "SECTOR";
type ReorderDraft = {
  item_id: string;
  minimum_quantity: string | number;
  maximum_quantity: string | number;
  lead_time_days: string;
  preferred_supplier_id: string;
  enabled: boolean;
};
type AllocationEditor = {
  scope: AllocationScope;
  itemId: string;
  sectorCode: string;
  expectedVersion: number;
  allocationPolicy: string;
  requireTraceability: boolean;
  title: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function statusOf(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string; value: number | string; detail: string; tone?: "slate" | "blue" | "amber" | "emerald";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
  };
  return (
    <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </article>
  );
}

function Tag({ value, tone = "slate" }: { value: string; tone?: "slate" | "blue" | "amber" | "emerald" | "violet" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    blue: "bg-blue-50 text-blue-800",
    amber: "bg-amber-50 text-amber-800",
    emerald: "bg-emerald-50 text-emerald-800",
    violet: "bg-violet-50 text-violet-800",
  };
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + tones[tone]}>{value.replaceAll("_", " ")}</span>;
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

function Quantity({ value, unit }: { value: unknown; unit?: string }) {
  const parsed = Number(value);
  return <span className="tabular-nums">{Number.isFinite(parsed) ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}{unit ? " " + unit : ""}</span>;
}

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

export default function InventoryReplenishmentAllocationPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const [items, setItems] = useState<InventoryMaterial[]>([]);
  const [suppliers, setSuppliers] = useState<ReplenishmentSupplier[]>([]);
  const [shortages, setShortages] = useState<ReplenishmentSignal[]>([]);
  const [recommendations, setRecommendations] = useState<ReplenishmentSignal[]>([]);
  const [allocationPolicies, setAllocationPolicies] = useState<AllocationPolicy[]>([]);
  const [tab, setTab] = useState<Tab>("shortages");
  const [search, setSearch] = useState("");
  const [recommendationStatus, setRecommendationStatus] = useState("ALL");
  const [allocationSearch, setAllocationSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reorderOpen, setReorderOpen] = useState(false);
  const [reorderLoading, setReorderLoading] = useState(false);
  const [reorderItem, setReorderItem] = useState<InventoryMaterial | null>(null);
  const [reorderDraft, setReorderDraft] = useState<ReorderDraft>({
    item_id: "", minimum_quantity: "", maximum_quantity: "", lead_time_days: "7",
    preferred_supplier_id: "", enabled: true,
  });
  const [policyExists, setPolicyExists] = useState(false);
  const [preferredSupplierLabel, setPreferredSupplierLabel] = useState("");
  const [allocationEditor, setAllocationEditor] = useState<AllocationEditor | null>(null);
  const [allocationFilter, setAllocationFilter] = useState<"ALL" | "CONFIGURED" | "INHERITED">("ALL");

  const canInventoryRead = hasPermission("inventory.read");
  const canInventoryWrite = hasPermission("inventory.write");
  const canReorderRead = hasPermission("inventory.reorder.read");
  const canReorderWrite = hasPermission("inventory.reorder.write");
  const canSupplierRead = hasPermission("suppliers.read");
  const viewerFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const activeItems = useMemo(
    () => items.filter((item) => item.status.toUpperCase() === "ACTIVE"),
    [items],
  );
  const sectorCodes = useMemo(() => Array.from(new Set(
    activeItems.map((item) => String(item.sector_code ?? "").trim().toUpperCase()).filter(Boolean),
  )).sort(), [activeItems]);
  const summary = useMemo(
    () => summarizeReplenishment(shortages, recommendations, allocationPolicies),
    [shortages, recommendations, allocationPolicies],
  );
  const visibleShortages = useMemo(
    () => filterReplenishmentRows(shortages, search, "ALL"),
    [shortages, search],
  );
  const visibleRecommendations = useMemo(
    () => filterReplenishmentRows(recommendations, search, recommendationStatus),
    [recommendations, search, recommendationStatus],
  );
  const allocationRows = useMemo(() => {
    const query = allocationSearch.trim().toLowerCase();
    const rows = activeItems.map((item) => {
      const effective = resolveAllocationPolicy(item, allocationPolicies);
      const material = allocationPolicies.find((policy) =>
        policy.policy_scope === "MATERIAL" && policy.inventory_item_id === item.id,
      ) ?? null;
      return { item, effective, material };
    });
    const filtered = rows.filter(({ item, effective }) => {
      if (allocationFilter === "CONFIGURED" && !allocationPolicies.some((policy) => policy.policy_scope === "MATERIAL" && policy.inventory_item_id === item.id)) return false;
      if (allocationFilter === "INHERITED" && allocationPolicies.some((policy) => policy.policy_scope === "MATERIAL" && policy.inventory_item_id === item.id)) return false;
      if (!query) return true;
      return [item.sku, item.name, item.sector_code, effective.allocation_policy, effective.source]
        .some((value) => String(value ?? "").toLowerCase().includes(query));
    });
    return filtered;
  }, [activeItems, allocationPolicies, allocationFilter, allocationSearch]);

  const load = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canInventoryRead) {
      setItems([]);
      setSuppliers([]);
      setShortages([]);
      setRecommendations([]);
      setAllocationPolicies([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const results = await Promise.allSettled([
        request("/inventory/items?limit=100"),
        request("/inventory/allocation-policies"),
        canReorderRead ? request("/inventory/replenishment/shortages?limit=100") : Promise.resolve([]),
        canReorderRead ? request("/inventory/replenishment/recommendations?limit=100") : Promise.resolve([]),
        canSupplierRead ? request("/suppliers?status=ACTIVE&limit=100&page=1") : Promise.resolve({ items: [] }),
      ]);
      const resultAt = (index: number) => results[index].status === "fulfilled" ? results[index].value : null;
      setItems(asInventoryRows(resultAt(0), "items") as InventoryMaterial[]);
      setAllocationPolicies(asInventoryRows(resultAt(1), "policies") as AllocationPolicy[]);
      setShortages(asInventoryRows(resultAt(2), "shortages") as ReplenishmentSignal[]);
      setRecommendations(asInventoryRows(resultAt(3), "recommendations") as ReplenishmentSignal[]);
      const supplierResult = resultAt(4);
      setSuppliers(asInventoryRows(supplierResult, "items") as ReplenishmentSupplier[]);
      const requiredIndices = [0, 1, ...(canReorderRead ? [2, 3] : [])];
      const failed = requiredIndices.filter((index) => results[index].status === "rejected");
      if (failed.length) {
        setError("Some registers could not be loaded. Verify the matching inventory and replenishment permissions, then refresh.");
      }
      if (canSupplierRead && results[4].status === "rejected") {
        setError("Supplier directory could not be loaded. You can still save a reorder policy without a preferred supplier.");
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canInventoryRead, canReorderRead, canSupplierRead, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openReorderEditor(item: InventoryMaterial, signal?: ReplenishmentSignal | null) {
    if (!canReorderRead) return;
    setReorderItem(item);
    setReorderDraft(getReorderEditorDefaults(item, signal) as ReorderDraft);
    setPolicyExists(false);
    setPreferredSupplierLabel(signal?.preferred_supplier_name ?? "");
    setReorderOpen(true);
    setReorderLoading(true);
    setError("");
    try {
      const result = await request("/inventory/items/" + item.id + "/reorder-policy") as ReplenishmentSignal;
      setReorderDraft(getReorderEditorDefaults(item, result) as ReorderDraft);
      setPreferredSupplierLabel(result.preferred_supplier_name ?? "");
      setPolicyExists(true);
    } catch (cause) {
      if (statusOf(cause) !== 404) {
        setError(messageOf(cause));
      }
    } finally {
      setReorderLoading(false);
    }
  }

  async function saveReorderPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reorderItem) return;
    await runAction(async () => {
      const payload = buildReorderPolicyPayload(reorderDraft);
      await request("/inventory/items/" + reorderItem.id + "/reorder-policy", {
        method: "PUT",
        body: payload,
      });
      setReorderOpen(false);
      setReorderItem(null);
    }, "Reorder policy saved. Shortage and recommendation registers have been refreshed.");
  }

  function openMaterialAllocationEditor(item: InventoryMaterial) {
    const existing = allocationPolicies.find((policy) =>
      policy.policy_scope === "MATERIAL" && policy.inventory_item_id === item.id,
    ) ?? null;
    const effective = resolveAllocationPolicy(item, allocationPolicies);
    setAllocationEditor({
      scope: "MATERIAL",
      itemId: item.id,
      sectorCode: "",
      expectedVersion: existing?.version ?? 0,
      allocationPolicy: existing?.allocation_policy ?? effective.allocation_policy ?? "FIFO",
      requireTraceability: existing?.require_traceability ?? effective.require_traceability ?? true,
      title: item.sku + " · " + item.name,
    });
    setError("");
  }

  function openSectorAllocationEditor(sectorCode: string) {
    const existing = allocationPolicies.find((policy) =>
      policy.policy_scope === "SECTOR" && String(policy.sector_code ?? "").toUpperCase() === sectorCode.toUpperCase(),
    ) ?? null;
    const effective = allocationPolicies.find((policy) => policy.policy_scope === "FACTORY") ?? null;
    setAllocationEditor({
      scope: "SECTOR",
      itemId: "",
      sectorCode,
      expectedVersion: existing?.version ?? 0,
      allocationPolicy: existing?.allocation_policy ?? effective?.allocation_policy ?? "FIFO",
      requireTraceability: existing?.require_traceability ?? effective?.require_traceability ?? true,
      title: "Sector · " + sectorCode,
    });
    setError("");
  }

  async function saveAllocationPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allocationEditor) return;
    await runAction(async () => {
      const payload = buildAllocationPolicyPayload({
        allocation_policy: allocationEditor.allocationPolicy,
        require_traceability: allocationEditor.requireTraceability,
        expected_version: allocationEditor.expectedVersion,
      });
      const path = allocationEditor.scope === "MATERIAL"
        ? "/inventory/allocation-policies/materials/" + allocationEditor.itemId
        : "/inventory/allocation-policies/sectors/" + encodeURIComponent(allocationEditor.sectorCode);
      await request(path, { method: "PUT", body: payload });
      setAllocationEditor(null);
    }, "Allocation policy saved. Material reservations now resolve policy precedence using the latest version.");
  }

  const hasReorderAccess = canReorderRead;
  const reorderEditAllowed = canReorderRead && canReorderWrite;

  if (status !== "connected" || !snapshot) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory planning · replenishment</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Replenishment and allocation rules are scoped to your authenticated tenant and selected factory.</p>
          <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800">Connect session</Link>
        </section>
      </main>
    );
  }
  if (!activeFactoryId) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Select an active factory from the workspace header before opening replenishment.</div></main>;
  }
  if (!canInventoryRead) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold text-amber-950">Inventory access required</h1><p className="mt-2 text-sm text-amber-900">Your permission snapshot does not include <code>inventory.read</code>.</p></div></main>;
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Materials planning · supply continuity</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Replenishment & Allocation</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Monitor shortages, configure reorder thresholds and govern FIFO, FEFO, LOT and SERIAL reservation rules.</p>
          <p className="mt-2 text-xs font-medium text-slate-500">{snapshot.tenant.name} · {viewerFactory?.name ?? "Active factory"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory" className={secondaryButton}>Inventory control tower</Link>
          <Link href="/inventory/cycle-counts" className={secondaryButton}>Cycle counts</Link>
          <button type="button" onClick={() => void load()} disabled={loading} className={secondaryButton}>{loading ? "Refreshing…" : "Refresh registers"}</button>
        </div>
      </header>

      {error ? <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Items below minimum" value={summary.shortageItems} detail="Configured policies with physical shortage" tone="amber" />
        <Metric label="Uncovered shortage" value={summary.uncoveredItems} detail="Not covered by approved incoming purchase orders" tone="amber" />
        <Metric label="Order recommendations" value={summary.recommendations} detail="Triggered reorder rules with positive order quantity" tone="blue" />
        <Metric label="Supplier / review gaps" value={summary.supplierRequired + summary.reviewRequired} detail={summary.supplierRequired + " supplier required · " + summary.reviewRequired + " review required"} tone={summary.supplierRequired ? "amber" : "emerald"} />
      </section>

      <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h2 className="font-bold text-slate-950">Inventory planning workspace</h2>
            <p className="mt-1 text-xs text-slate-500">{activeItems.length} active item(s) · {suppliers.length} active supplier(s) available for policy configuration</p>
          </div>
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Inventory planning workspaces">
            {([
              ["shortages", "Shortages"],
              ["recommendations", "Recommendations"],
              ["allocation", "Allocation rules"],
            ] as [Tab, string][]).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={"min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold " + (tab === value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")}>{label}</button>
            ))}
          </div>
        </div>

        {tab === "shortages" || tab === "recommendations" ? (
          <div className="min-w-0">
            {!hasReorderAccess ? (
              <div className="m-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Shortage and recommendation data require <code>inventory.reorder.read</code>. Allocation rules remain available under the Allocation Rules tab.</div>
            ) : (
              <>
                <div className="grid gap-2 border-b border-slate-100 p-4 sm:grid-cols-[minmax(0,1fr)_220px]">
                  <Field label="Search material or supplier"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SKU, material or supplier…" className={inputClass} /></Field>
                  {tab === "recommendations" ? <Field label="Recommendation state"><select value={recommendationStatus} onChange={(event) => setRecommendationStatus(event.target.value)} className={inputClass}><option value="ALL">All states</option><option value="SUPPLIER_REQUIRED">Supplier required</option><option value="REVIEW_REQUIRED">Review required</option><option value="COVERED_BY_INCOMING">Covered by incoming</option><option value="NOT_REQUIRED">Not required</option></select></Field> : <div className="flex items-end text-xs text-slate-500">{visibleShortages.length} shortage signal(s)</div>}
                </div>
                {loading ? <p className="p-10 text-center text-sm text-slate-500">Loading replenishment signals…</p> : null}
                {!loading && tab === "shortages" && visibleShortages.length === 0 ? <p className="p-10 text-center text-sm text-slate-500">No configured reorder policy is currently below its minimum threshold.</p> : null}
                {!loading && tab === "recommendations" && visibleRecommendations.length === 0 ? <p className="p-10 text-center text-sm text-slate-500">No triggered order recommendations match this filter.</p> : null}
                {!loading && tab === "shortages" && visibleShortages.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[900px] text-left text-sm">
                      <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Material</th><th className="px-4 py-3">Available / minimum</th><th className="px-4 py-3">Incoming</th><th className="px-4 py-3">Uncovered</th><th className="px-4 py-3">Lead time</th><th className="px-4 py-3">Action</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {visibleShortages.map((row) => {
                          const metric = replenishmentMetrics(row);
                          const item = activeItems.find((entry) => entry.id === row.item_id);
                          return <tr key={row.item_id} className="hover:bg-slate-50">
                            <td className="px-4 py-3"><p className="font-semibold text-slate-900">{row.item_name}</p><p className="mt-0.5 font-mono text-xs text-slate-500">{row.sku}</p><p className="mt-1 text-[11px] text-slate-500">{row.preferred_supplier_name || "No preferred supplier"}</p></td>
                            <td className="px-4 py-3"><p className="font-semibold tabular-nums"><Quantity value={metric.available} unit={row.unit} /></p><p className="mt-1 text-xs text-slate-500">Minimum <Quantity value={metric.minimum} unit={row.unit} /></p></td>
                            <td className="px-4 py-3"><p className="font-semibold tabular-nums"><Quantity value={metric.incoming} unit={row.unit} /></p><p className="mt-1 text-xs text-slate-500">{row.next_incoming_date ? "ETA " + new Date(row.next_incoming_date).toLocaleDateString() : "No approved incoming ETA"}</p></td>
                            <td className="px-4 py-3"><Tag value={metric.uncoveredShortage > 0 ? "UN-COVERED" : "COVERED"} tone={metric.uncoveredShortage > 0 ? "amber" : "emerald"} /><p className="mt-1 text-xs font-semibold tabular-nums"><Quantity value={metric.uncoveredShortage} unit={row.unit} /></p></td>
                            <td className="px-4 py-3 text-xs text-slate-600">{row.lead_time_days} day(s)<p className="mt-1 text-[11px] text-slate-500">{new Date(row.estimated_replenishment_date).toLocaleDateString()}</p></td>
                            <td className="px-4 py-3">{item && reorderEditAllowed ? <button type="button" onClick={() => void openReorderEditor(item, row)} className={secondaryButton}>Edit policy</button> : <span className="text-xs text-slate-400">Read only</span>}</td>
                          </tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {!loading && tab === "recommendations" && visibleRecommendations.length > 0 ? (
                  <div className="grid gap-3 p-4 lg:grid-cols-2">
                    {visibleRecommendations.map((row) => {
                      const metric = replenishmentMetrics(row);
                      const item = activeItems.find((entry) => entry.id === row.item_id);
                      const stateTone = row.recommendation_status === "SUPPLIER_REQUIRED" ? "amber" : row.recommendation_status === "REVIEW_REQUIRED" ? "blue" : "emerald";
                      return <article key={row.item_id} className="rounded-xl border border-slate-200 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold text-slate-950">{row.item_name}</h3><p className="mt-1 font-mono text-xs text-slate-500">{row.sku}</p></div><Tag value={row.recommendation_status} tone={stateTone} /></div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          <div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Recommended order</p><p className="mt-1 text-lg font-bold tabular-nums"><Quantity value={metric.recommendedOrder} unit={row.unit} /></p></div>
                          <div className="rounded-lg bg-blue-50 p-3"><p className="text-[11px] text-blue-700">Inventory position</p><p className="mt-1 text-lg font-bold tabular-nums text-blue-950"><Quantity value={metric.inventoryPosition} unit={row.unit} /></p></div>
                        </div>
                        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                          <div><dt className="text-slate-500">Available now</dt><dd className="mt-1 font-semibold"><Quantity value={metric.available} unit={row.unit} /></dd></div>
                          <div><dt className="text-slate-500">Approved incoming</dt><dd className="mt-1 font-semibold"><Quantity value={metric.incoming} unit={row.unit} /></dd></div>
                          <div><dt className="text-slate-500">Preferred supplier</dt><dd className="mt-1 font-semibold">{row.preferred_supplier_name || "Not configured"}</dd></div>
                          <div><dt className="text-slate-500">Lead time</dt><dd className="mt-1 font-semibold">{row.lead_time_days} days</dd></div>
                        </dl>
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                          <p className="text-[11px] text-slate-500">{row.next_incoming_date ? "Next incoming " + new Date(row.next_incoming_date).toLocaleDateString() : "No approved PO incoming quantity included"}</p>
                          {item && reorderEditAllowed ? <button type="button" onClick={() => void openReorderEditor(item, row)} className={primaryButton}>Review reorder policy</button> : null}
                        </div>
                      </article>;
                    })}
                  </div>
                ) : null}
                <p className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-[11px] leading-5 text-slate-500">Recommendations are calculated from available stock, outstanding quantities on approved purchase orders and posted goods receipts. They are decision support only; this screen does not create or approve a purchase order.</p>
              </>
            )}
          </div>
        ) : null}

        {tab === "allocation" ? (
          <div className="min-w-0">
            <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[minmax(0,1fr)_180px]">
              <Field label="Search material or sector"><input value={allocationSearch} onChange={(event) => setAllocationSearch(event.target.value)} placeholder="Search SKU, name, sector or policy…" className={inputClass} /></Field>
              <Field label="Material rules"><select value={allocationFilter} onChange={(event) => setAllocationFilter(event.target.value as typeof allocationFilter)} className={inputClass}><option value="ALL">All materials</option><option value="CONFIGURED">Material override</option><option value="INHERITED">Inherited policy</option></select></Field>
            </div>
            <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
              <section className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold text-slate-950">Allocation precedence</h3><p className="mt-1 text-xs text-slate-500">Material override → sector rule → factory policy → system traceability settings / FIFO fallback.</p></div><span className="text-xs text-slate-500">{summary.allocationRules} scoped rules</span></div>
                <div className="mt-4 space-y-2">
                  {allocationPolicies.filter((policy) => policy.policy_scope === "FACTORY").map((policy) => <article key="factory-policy" className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Factory default</p><p className="mt-1 text-sm font-bold text-slate-950">{policy.allocation_policy} · {allocationPolicyLabel(policy.allocation_policy)}</p></div><Tag value="READ ONLY" /></div>
                    <p className="mt-2 text-xs text-slate-600">Traceability {policy.require_traceability ? "required" : "not required"} · version {policy.version}</p>
                    <p className="mt-1 text-[11px] text-slate-500">The API exposes factory policy for inheritance but only material and sector write routes are available here.</p>
                  </article>)}
                  <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-3"><p className="text-xs font-bold uppercase tracking-wide text-blue-800">Sector policies</p>
                    <div className="mt-3 space-y-2">
                      {sectorCodes.map((sectorCode) => {
                        const policy = allocationPolicies.find((row) => row.policy_scope === "SECTOR" && String(row.sector_code ?? "").toUpperCase() === sectorCode) ?? null;
                        return <div key={sectorCode} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3">
                          <div><p className="text-sm font-semibold text-slate-900">{sectorCode}</p><p className="mt-1 text-xs text-slate-500">{policy ? policy.allocation_policy + " · traceability " + (policy.require_traceability ? "required" : "off") + " · v" + policy.version : "No sector override · inherits factory/system"}</p></div>
                          {canInventoryWrite ? <button type="button" onClick={() => openSectorAllocationEditor(sectorCode)} className={secondaryButton}>{policy ? "Edit sector" : "Add rule"}</button> : <Tag value={policy ? "CONFIGURED" : "INHERITED"} tone={policy ? "blue" : "slate"} />}
                        </div>;
                      })}
                      {sectorCodes.length === 0 ? <p className="rounded-lg bg-white p-4 text-xs text-slate-500">No active inventory sectors have been assigned yet.</p> : null}
                    </div>
                  </div>
                </div>
              </section>
              <section className="min-w-0">
                <div><h3 className="font-bold text-slate-950">Material-level policy resolution</h3><p className="mt-1 text-xs text-slate-500">Each material resolves the most specific available rule.</p></div>
                <div className="mt-4 space-y-2">
                  {allocationRows.map(({ item, effective, material }) => <article key={item.id} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{item.name}</p><p className="mt-1 font-mono text-[11px] text-slate-500">{item.sku} · {item.sector_code || "No sector"}</p></div><Tag value={effective.source} tone={material ? "violet" : "slate"} /></div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-bold text-slate-950">{effective.allocation_policy || "System inherited"}</p><p className="mt-1 text-xs text-slate-500">{effective.allocation_policy ? allocationPolicyLabel(effective.allocation_policy) : "Backend traceability settings / FIFO fallback"}</p></div><div className="text-right text-xs"><p className="font-semibold text-slate-700">{effective.require_traceability === null ? "Traceability inherited" : effective.require_traceability ? "Traceability required" : "Traceability optional"}</p><p className="mt-1 text-slate-500">{material ? "Material version " + material.version : effective.version ? "Inherited version " + effective.version : "No scoped policy"}</p></div></div>
                    {canInventoryWrite ? <button type="button" onClick={() => openMaterialAllocationEditor(item)} className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">{material ? "Edit material override" : "Create material override"}</button> : null}
                  </article>)}
                  {allocationRows.length === 0 ? <p className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">No materials match the selected filter.</p> : null}
                </div>
              </section>
            </div>
            <p className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-[11px] leading-5 text-slate-500">LOT and SERIAL policies require registered traceability identities. The API enforces this at reservation time; this UI never silently changes a material reservation or allocates stock.</p>
          </div>
        ) : null}
      </section>

      {reorderOpen && reorderItem ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-2 sm:items-center sm:p-6" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="reorder-policy-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Replenishment policy</p><h2 id="reorder-policy-title" className="mt-1 text-xl font-bold text-slate-950">{reorderItem.sku} · {reorderItem.name}</h2><p className="mt-1 text-xs text-slate-500">{policyExists ? "Updating current policy" : "No current policy · create new thresholds"}</p></div><button type="button" onClick={() => setReorderOpen(false)} className={secondaryButton}>Close</button></div>
            {reorderLoading ? <p className="py-10 text-center text-sm text-slate-500">Loading current policy…</p> : (
              <form onSubmit={(event) => void saveReorderPolicy(event)} className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={"Minimum quantity (" + reorderItem.unit + ")"} hint="The reorder trigger is evaluated against available stock plus approved incoming quantity."><input required type="number" min="0" step="0.0001" value={reorderDraft.minimum_quantity} onChange={(event) => setReorderDraft((current) => ({ ...current, minimum_quantity: event.target.value }))} className={inputClass} /></Field>
                  <Field label={"Maximum quantity (" + reorderItem.unit + ")"} hint="Recommendations replenish inventory position toward this level."><input required type="number" min="0.0001" step="0.0001" value={reorderDraft.maximum_quantity} onChange={(event) => setReorderDraft((current) => ({ ...current, maximum_quantity: event.target.value }))} className={inputClass} /></Field>
                  <Field label="Supplier lead time (days)"><input required type="number" min="0" max="3650" step="1" value={reorderDraft.lead_time_days} onChange={(event) => setReorderDraft((current) => ({ ...current, lead_time_days: event.target.value }))} className={inputClass} /></Field>
                  <Field label="Preferred supplier" hint="Only active tenant suppliers are listed. You may leave this blank and resolve supplier selection later."><select value={reorderDraft.preferred_supplier_id} disabled={!canSupplierRead} onChange={(event) => setReorderDraft((current) => ({ ...current, preferred_supplier_id: event.target.value }))} className={inputClass}><option value="">No preferred supplier</option>{!canSupplierRead && reorderDraft.preferred_supplier_id ? <option value={reorderDraft.preferred_supplier_id}>{preferredSupplierLabel || "Existing supplier binding"}</option> : null}{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} · {supplier.name}</option>)}</select></Field>
                </div>
                <label className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700"><input type="checkbox" checked={reorderDraft.enabled} onChange={(event) => setReorderDraft((current) => ({ ...current, enabled: event.target.checked }))} className="mt-0.5" /><span><strong>Enable reorder policy</strong><span className="mt-0.5 block text-xs text-slate-500">Disabled policies remain available for inspection but do not trigger recommendations.</span></span></label>
                {!canSupplierRead ? <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Supplier selection is hidden because <code>suppliers.read</code> is not granted. Existing supplier binding is retained only when the form is prefilled and unchanged; save with a visible selection or clear it explicitly.</p> : null}
                <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setReorderOpen(false)} className={secondaryButton}>Cancel</button><button type="submit" disabled={busy || reorderLoading || !canReorderWrite} className={primaryButton}>{policyExists ? "Update reorder policy" : "Create reorder policy"}</button></div>
              </form>
            )}
          </section>
        </div>
      ) : null}

      {allocationEditor ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-2 sm:items-center sm:p-6" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="allocation-policy-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-violet-700">{allocationEditor.scope.toLowerCase()} allocation rule</p><h2 id="allocation-policy-title" className="mt-1 text-xl font-bold text-slate-950">{allocationEditor.title}</h2><p className="mt-1 text-xs text-slate-500">{allocationEditor.expectedVersion === 0 ? "New override · expected version 0" : "Current version " + allocationEditor.expectedVersion}</p></div><button type="button" onClick={() => setAllocationEditor(null)} className={secondaryButton}>Close</button></div>
            <form onSubmit={(event) => void saveAllocationPolicy(event)} className="mt-5 space-y-4">
              <Field label="Allocation policy" hint="FIFO and FEFO order eligible traceability units by received / expiry chronology; LOT and SERIAL enforce identity-specific allocation."><select value={allocationEditor.allocationPolicy} onChange={(event) => setAllocationEditor((current) => current ? { ...current, allocationPolicy: event.target.value } : current)} className={inputClass}><option value="FIFO">FIFO · First in, first out</option><option value="FEFO">FEFO · First expired, first out</option><option value="LOT">LOT · Lot-controlled</option><option value="SERIAL">SERIAL · Serial-controlled</option></select></Field>
              <label className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700"><input type="checkbox" checked={allocationEditor.requireTraceability} onChange={(event) => setAllocationEditor((current) => current ? { ...current, requireTraceability: event.target.checked } : current)} className="mt-0.5" /><span><strong>Require traceability identities</strong><span className="mt-0.5 block text-xs text-slate-500">Reservations will require eligible LOT/SERIAL identities even when FIFO or FEFO is selected.</span></span></label>
              {(allocationEditor.allocationPolicy === "LOT" || allocationEditor.allocationPolicy === "SERIAL" || allocationEditor.requireTraceability) ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">The API will reject reservations until compatible active traceability identities and eligible BIN balances are registered.</p> : null}
              <div className="flex justify-end gap-2"><button type="button" onClick={() => setAllocationEditor(null)} className={secondaryButton}>Cancel</button><button type="submit" disabled={busy || !canInventoryWrite} className={primaryButton}>Save allocation rule</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
