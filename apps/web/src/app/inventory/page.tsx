"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";

type Item = {
  id: string; sku: string; name: string; unit: string; sector_code?: string | null;
  status: string; quantity_on_hand: string; quantity_reserved: string;
  quantity_available: string; version: string; created_at?: string;
};
type Location = { id: string; code: string; name: string; location_type: string; status: string };
type BinBalance = { location_id: string; location_code?: string; location_name?: string; quantity_on_hand: string; quantity_reserved: string; quantity_available: string };
type Tab = "items" | "movements" | "locations";

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function quantity(value: unknown, unit = "") {
  return number(value).toLocaleString(undefined, { maximumFractionDigits: 4 }) + (unit ? " " + unit : "");
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
function Metric({ label, value, detail, tone = "slate" }: { label: string; value: string; detail: string; tone?: "slate" | "blue" | "amber" | "emerald" }) {
  const tones = { slate: "border-slate-200 bg-white", blue: "border-blue-100 bg-blue-50/60", amber: "border-amber-100 bg-amber-50/60", emerald: "border-emerald-100 bg-emerald-50/60" };
  return <article className={"rounded-2xl border p-4 shadow-sm " + tones[tone]}><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></article>;
}
function Status({ value }: { value: string }) {
  const active = value.toUpperCase() === "ACTIVE";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + (active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>{value.replaceAll("_", " ")}</span>;
}

export default function InventoryControlTowerPage() {
  const { status, activeFactoryId, snapshot, hasPermission, request } = useFactoryOsSession();
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [balances, setBalances] = useState<BinBalance[]>([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("items");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [movementOpen, setMovementOpen] = useState(false);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("EA");
  const [sector, setSector] = useState("");
  const [movementType, setMovementType] = useState<"RECEIPT" | "ISSUE">("RECEIPT");
  const [movementQuantity, setMovementQuantity] = useState("1");
  const [movementNotes, setMovementNotes] = useState("");

  const canRead = hasPermission("inventory.read");
  const canWrite = hasPermission("inventory.write");
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

  const load = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setItems([]); setLocations([]); setBalances([]); return;
    }
    setLoading(true); setError("");
    try {
      const [itemResult, locationResult] = await Promise.all([
        request("/inventory/items?limit=100" + (search ? "&search=" + encodeURIComponent(search) : "")),
        request("/inventory/locations?limit=100").catch(() => []),
      ]);
      const nextItems = Array.isArray(itemResult) ? itemResult as Item[] : [];
      setItems(nextItems);
      setLocations(Array.isArray(locationResult) ? locationResult as Location[] : []);
      setSelectedItemId((current) => nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? "");
    } catch (cause) {
      setError(errorMessage(cause));
      setItems([]); setLocations([]);
    } finally { setLoading(false); }
  }, [status, activeFactoryId, canRead, request, search]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    async function loadBalances() {
      if (!selectedItemId || !canRead || status !== "connected") { setBalances([]); return; }
      try {
        const result = await request("/inventory/items/" + selectedItemId + "/locations?limit=100");
        if (!cancelled) setBalances(Array.isArray(result) ? result as BinBalance[] : []);
      } catch { if (!cancelled) setBalances([]); }
    }
    void loadBalances();
    return () => { cancelled = true; };
  }, [selectedItemId, canRead, status, request]);

  const totals = useMemo(() => items.reduce((acc, item) => {
    acc.onHand += number(item.quantity_on_hand);
    acc.reserved += number(item.quantity_reserved);
    acc.available += number(item.quantity_available);
    if (item.status.toUpperCase() !== "ACTIVE") acc.inactive += 1;
    if (number(item.quantity_available) <= 0 && item.status.toUpperCase() === "ACTIVE") acc.empty += 1;
    return acc;
  }, { onHand: 0, reserved: 0, available: 0, inactive: 0, empty: 0 }), [items]);

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await request("/inventory/items", { method: "POST", body: { sku, name, unit, ...(sector.trim() ? { sector_code: sector.trim() } : {}) } });
      setCreateOpen(false); setSku(""); setName(""); setSector("");
      setNotice("Inventory item created. Its opening balance is zero; record a receipt to add stock.");
      await load();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function createMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem) return;
    const amount = Number(movementQuantity);
    if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a quantity greater than zero."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await request("/inventory/items/" + selectedItem.id + "/movements", {
        method: "POST",
        idempotencyKey: "inventory-ui-" + crypto.randomUUID(),
        body: { movement_type: movementType, quantity: amount, notes: movementNotes.trim() || undefined },
      });
      setMovementOpen(false); setMovementQuantity("1"); setMovementNotes("");
      setNotice(movementType === "RECEIPT" ? "Stock receipt posted successfully." : "Stock issue posted successfully.");
      await load();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  if (status !== "connected" || !snapshot) {
    return <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6"><section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory control tower</p><h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Inventory is factory-scoped and uses your authenticated FactoryOS session. Connect first, then choose an active factory.</p><Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800">Connect session</Link></section></main>;
  }
  if (!activeFactoryId) return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">Select an active factory from the workspace header before opening inventory.</div></main>;
  if (!canRead) return <main className="mx-auto max-w-4xl px-4 py-12"><div className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold">Inventory access required</h1><p className="mt-2 text-sm">Your current IAM permission snapshot does not include <code>inventory.read</code>. Ask an administrator to grant access.</p></div></main>;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Materials · warehouse operations</p><h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Inventory Control Tower</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">A live view of item balances, stock movements and warehouse locations for the selected factory.</p><p className="mt-2 text-xs font-medium text-slate-500">{snapshot.tenant.name} · {snapshot.factories.find((factory) => factory.id === activeFactoryId)?.name ?? "Active factory"}</p></div>
        <div className="flex flex-wrap gap-2"><button onClick={() => void load()} disabled={loading} className="min-h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{loading ? "Refreshing…" : "Refresh data"}</button>{canWrite ? <button onClick={() => setCreateOpen(true)} className="min-h-10 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">+ New item</button> : null}</div>
      </header>

      {error ? <div role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="On-hand quantity" value={quantity(totals.onHand)} detail="Sum of returned item balances" tone="blue" />
        <Metric label="Available quantity" value={quantity(totals.available)} detail="On-hand less reserved" tone="emerald" />
        <Metric label="Reserved quantity" value={quantity(totals.reserved)} detail="Committed to active demand" />
        <Metric label="Zero-available items" value={String(totals.empty)} detail="Active items with no available balance" tone="amber" />
      </section>

      <section className="mt-7 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
          <div><h2 className="font-bold text-slate-950">Inventory workspace</h2><p className="mt-1 text-xs text-slate-500">{items.length} item(s) in this result · maximum 100 per request</p></div>
          <div className="flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Inventory views">
            {(["items", "movements", "locations"] as Tab[]).map((value) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={"rounded-lg px-3 py-2 text-xs font-semibold capitalize " + (tab === value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")}>{value === "items" ? "Item register" : value === "movements" ? "Stock actions" : "Locations"}</button>)}
          </div>
        </div>

        {tab === "items" ? <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
          <div className="min-w-0 border-b border-slate-200 lg:border-b-0 lg:border-r">
            <form onSubmit={(event) => { event.preventDefault(); setSearch(searchDraft.trim()); }} className="flex gap-2 border-b border-slate-100 p-4"><input aria-label="Search inventory items" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search SKU or item name…" className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /><button className="rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white">Search</button></form>
            {loading ? <p className="p-8 text-center text-sm text-slate-500">Loading inventory…</p> : items.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No inventory items found for this factory and search.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Item</th><th className="px-4 py-3">On hand</th><th className="px-4 py-3">Reserved</th><th className="px-4 py-3">Available</th><th className="px-4 py-3">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{items.map((item) => <tr key={item.id} className={"cursor-pointer hover:bg-blue-50/50 " + (selectedItemId === item.id ? "bg-blue-50" : "")} onClick={() => setSelectedItemId(item.id)}><td className="px-4 py-3"><p className="font-semibold text-slate-900">{item.name}</p><p className="mt-0.5 font-mono text-xs text-slate-500">{item.sku}</p></td><td className="px-4 py-3 tabular-nums">{quantity(item.quantity_on_hand, item.unit)}</td><td className="px-4 py-3 tabular-nums">{quantity(item.quantity_reserved, item.unit)}</td><td className="px-4 py-3 font-semibold tabular-nums">{quantity(item.quantity_available, item.unit)}</td><td className="px-4 py-3"><Status value={item.status} /></td></tr>)}</tbody></table></div>}
          </div>
          <aside className="min-w-0 p-4 sm:p-5">
            {selectedItem ? <><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected inventory item</p><h3 className="mt-1 text-lg font-bold text-slate-950">{selectedItem.name}</h3><p className="mt-1 font-mono text-xs text-slate-500">{selectedItem.sku}</p></div><Status value={selectedItem.status} /></div><div className="mt-5 grid grid-cols-2 gap-2"><div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] text-slate-500">On hand</p><p className="mt-1 text-lg font-bold tabular-nums">{quantity(selectedItem.quantity_on_hand, selectedItem.unit)}</p></div><div className="rounded-xl bg-emerald-50 p-3"><p className="text-[11px] text-emerald-700">Available</p><p className="mt-1 text-lg font-bold text-emerald-900 tabular-nums">{quantity(selectedItem.quantity_available, selectedItem.unit)}</p></div></div><dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-slate-500">Unit</dt><dd className="font-medium">{selectedItem.unit}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Sector</dt><dd className="font-medium">{selectedItem.sector_code || "Not assigned"}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-500">Balance version</dt><dd className="font-mono text-xs">{selectedItem.version}</dd></div></dl>{canWrite ? <button onClick={() => setMovementOpen(true)} className="mt-5 min-h-11 w-full rounded-xl bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800">Record stock movement</button> : <p className="mt-5 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">Read-only access. Stock changes require inventory.write.</p>}</> : <p className="py-10 text-center text-sm text-slate-500">Select an item to inspect its balance.</p>}
          </aside>
        </div> : null}

        {tab === "movements" ? <div className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-slate-950">Stock receipt and issue</h3><p className="mt-1 text-sm text-slate-500">Post an idempotent stock movement against the selected item.</p></div>{selectedItem ? <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold">{selectedItem.sku}</span> : null}</div>{selectedItem ? <div className="mt-5 grid gap-3 sm:grid-cols-3"><button onClick={() => { setMovementType("RECEIPT"); setMovementOpen(true); }} disabled={!canWrite} className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-left hover:bg-emerald-100 disabled:opacity-50"><span className="text-sm font-bold text-emerald-900">Stock receipt</span><span className="mt-1 block text-xs text-emerald-800">Increase on-hand stock</span></button><button onClick={() => { setMovementType("ISSUE"); setMovementOpen(true); }} disabled={!canWrite} className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-left hover:bg-amber-100 disabled:opacity-50"><span className="text-sm font-bold text-amber-900">Stock issue</span><span className="mt-1 block text-xs text-amber-800">Decrease available stock</span></button><div className="rounded-xl border border-slate-200 p-4"><p className="text-sm font-bold">Current available</p><p className="mt-2 text-xl font-bold tabular-nums">{quantity(selectedItem.quantity_available, selectedItem.unit)}</p></div></div> : <p className="mt-4 text-sm text-slate-500">Select an item in the Item register first.</p>}<p className="mt-5 rounded-xl bg-blue-50 p-4 text-xs leading-5 text-blue-900">Every movement requires a unique Idempotency-Key. The server validates stock availability, unit precision, factory scope and inventory permissions. The balance displayed here is refreshed from the API after posting.</p></div> : null}

        {tab === "locations" ? <div className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-slate-950">Warehouse location directory</h3><p className="mt-1 text-sm text-slate-500">Active and inactive locations returned for the selected factory.</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{locations.length} locations</span></div>{locations.length ? <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{locations.map((location) => <article key={location.id} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-2"><div><p className="font-mono text-sm font-bold">{location.code}</p><p className="mt-1 text-sm text-slate-700">{location.name}</p></div><Status value={location.status} /></div><p className="mt-3 text-xs uppercase tracking-wide text-slate-500">{location.location_type.replaceAll("_", " ")}</p></article>)}</div> : <p className="mt-5 rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">No location records were returned, or this endpoint is not available to your role.</p>}{selectedItem ? <div className="mt-6 border-t border-slate-200 pt-5"><h4 className="font-semibold">Selected item · bin balances</h4>{balances.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[500px] text-left text-sm"><thead className="text-xs text-slate-500"><tr><th className="py-2">Location</th><th className="py-2">On hand</th><th className="py-2">Reserved</th><th className="py-2">Available</th></tr></thead><tbody className="divide-y divide-slate-100">{balances.map((balance) => <tr key={balance.location_id}><td className="py-3 font-medium">{balance.location_code || balance.location_name || balance.location_id}</td><td className="py-3">{quantity(balance.quantity_on_hand, selectedItem.unit)}</td><td className="py-3">{quantity(balance.quantity_reserved, selectedItem.unit)}</td><td className="py-3 font-semibold">{quantity(balance.quantity_available, selectedItem.unit)}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-sm text-slate-500">No location balance rows are available for this item.</p>}</div> : null}</div> : null}
      </section>

      <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>Factory-scoped · API-authoritative · No client-side stock calculations for writes</span><span>Inactive items in current result: {totals.inactive}</span></footer>

      {createOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreateOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="create-item-title" className="my-8 w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl sm:p-6"><div className="flex items-start justify-between"><div><h2 id="create-item-title" className="text-xl font-bold">Create inventory item</h2><p className="mt-1 text-sm text-slate-500">The server creates an empty opening balance.</p></div><button onClick={() => setCreateOpen(false)} aria-label="Close" className="rounded-lg px-3 py-1 text-xl text-slate-500 hover:bg-slate-100">×</button></div><form onSubmit={createItem} className="mt-5 space-y-4"><label className="block text-sm font-medium">SKU<input required maxLength={100} value={sku} onChange={(event) => setSku(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3" /></label><label className="block text-sm font-medium">Item name<input required maxLength={255} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3" /></label><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-medium">Base unit<input required maxLength={50} value={unit} onChange={(event) => setUnit(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3" /></label><label className="block text-sm font-medium">Sector code<input maxLength={64} value={sector} onChange={(event) => setSector(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3" /></label></div><div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setCreateOpen(false)} className="min-h-10 rounded-lg border px-4 text-sm font-semibold">Cancel</button><button disabled={busy} className="min-h-10 rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Creating…" : "Create item"}</button></div></form></section></div> : null}

      {movementOpen && selectedItem ? <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMovementOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="movement-title" className="my-8 w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl sm:p-6"><div className="flex items-start justify-between"><div><h2 id="movement-title" className="text-xl font-bold">{movementType === "RECEIPT" ? "Receive stock" : "Issue stock"}</h2><p className="mt-1 text-sm text-slate-500">{selectedItem.sku} · {selectedItem.name}</p></div><button onClick={() => setMovementOpen(false)} aria-label="Close" className="rounded-lg px-3 py-1 text-xl text-slate-500 hover:bg-slate-100">×</button></div><form onSubmit={createMovement} className="mt-5 space-y-4"><label className="block text-sm font-medium">Movement type<select value={movementType} onChange={(event) => setMovementType(event.target.value as "RECEIPT" | "ISSUE")} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"><option value="RECEIPT">Receipt · Stock In</option><option value="ISSUE">Issue · Stock Out</option></select></label><label className="block text-sm font-medium">Quantity ({selectedItem.unit})<input required type="number" min="0.00000001" step="0.00000001" value={movementQuantity} onChange={(event) => setMovementQuantity(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3" /></label><label className="block text-sm font-medium">Notes (optional)<textarea maxLength={1000} rows={3} value={movementNotes} onChange={(event) => setMovementNotes(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 p-3" /></label><p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">Stock issues are rejected by the API if they would reduce on-hand stock below reserved quantity.</p><div className="flex justify-end gap-2"><button type="button" onClick={() => setMovementOpen(false)} className="min-h-10 rounded-lg border px-4 text-sm font-semibold">Cancel</button><button disabled={busy} className="min-h-10 rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Posting…" : "Confirm movement"}</button></div></form></section></div> : null}
    </main>
  );
}
