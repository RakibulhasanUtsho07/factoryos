"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  asWarehouseRows,
  buildLocationTransferPayload,
  filterWarehouseTransfers,
  summarizeWarehouseOperations,
  warehousePurposeLabel,
} from "@/lib/warehouse-operations.mjs";
import type {
  WarehouseItem,
  WarehouseLocation,
  WarehousePickSource,
  WarehousePutawayTarget,
  WarehouseTraceabilityUnit,
  WarehouseTransfer,
} from "@/lib/warehouse-operations.mjs";

type Purpose = "PUT_AWAY" | "PICK" | "TRANSFER" | "HISTORY";

type TransferDraft = {
  source_location_id: string;
  destination_location_id: string;
  quantity: string;
  traceability_unit_id: string;
  notes: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function statusOf(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    const value = Number((error as { status?: unknown }).status);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function rowsOf<T>(value: unknown, key: string): T[] {
  return asWarehouseRows(value, key) as T[];
}

function amount(value: unknown, unit = "") {
  const parsed = Number(value);
  const display = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : "—";
  return display + (unit ? " " + unit : "");
}

function shortId(value: string) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
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
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-950 tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
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

function PurposeTag({ value }: { value: string }) {
  const tone = value === "PUT_AWAY"
    ? "bg-emerald-50 text-emerald-800"
    : value === "PICK"
      ? "bg-blue-50 text-blue-800"
      : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + tone}>{warehousePurposeLabel(value)}</span>;
}

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";

export default function WarehousePutawayPickingWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const [items, setItems] = useState<WarehouseItem[]>([]);
  const [locations, setLocations] = useState<WarehouseLocation[]>([]);
  const [putawayTargets, setPutawayTargets] = useState<WarehousePutawayTarget[]>([]);
  const [pickSources, setPickSources] = useState<WarehousePickSource[]>([]);
  const [binBalances, setBinBalances] = useState<Record<string, unknown>[]>([]);
  const [traceabilityUnits, setTraceabilityUnits] = useState<WarehouseTraceabilityUnit[]>([]);
  const [transfers, setTransfers] = useState<WarehouseTransfer[]>([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("PUT_AWAY");
  const [historySearch, setHistorySearch] = useState("");
  const [historyPurpose, setHistoryPurpose] = useState("ALL");
  const [draft, setDraft] = useState<TransferDraft>({
    source_location_id: "",
    destination_location_id: "",
    quantity: "",
    traceability_unit_id: "",
    notes: "",
  });
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingOperations, setLoadingOperations] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canRead = hasPermission("inventory.read");
  const canWrite = hasPermission("inventory.write");
  const canTraceRead = hasPermission("traceability.read");
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;
  const itemIsActive = selectedItem?.status.toUpperCase() === "ACTIVE";

  const stagingSources = useMemo(
    () => locations.filter((location) =>
      location.status.toUpperCase() === "ACTIVE"
      && location.picking_enabled
      && (location.location_type.toUpperCase() === "STAGING"
        || (location.location_type.toUpperCase() === "VIRTUAL" && location.is_default))),
    [locations],
  );
  const stagingDestinations = useMemo(
    () => locations.filter((location) =>
      location.status.toUpperCase() === "ACTIVE"
      && location.location_type.toUpperCase() === "STAGING"
      && location.putaway_enabled),
    [locations],
  );

  const sourceOptions = useMemo(() => {
    if (purpose === "PUT_AWAY") {
      return stagingSources.map((location) => ({
        id: location.id, code: location.location_code, name: location.name,
        available: null as string | null, priority: location.picking_priority,
      }));
    }
    return pickSources.map((location) => ({
      id: location.location_id, code: location.location_code, name: location.location_name,
      available: location.quantity_available, priority: location.picking_priority,
    }));
  }, [purpose, stagingSources, pickSources]);

  const destinationOptions = useMemo(() => {
    if (purpose === "PICK") {
      return stagingDestinations.map((location) => ({
        id: location.id, code: location.location_code, name: location.name,
        onHand: null as string | null, priority: location.putaway_priority,
      }));
    }
    return putawayTargets.map((location) => ({
      id: location.location_id, code: location.location_code, name: location.location_name,
      onHand: location.quantity_on_hand, priority: location.putaway_priority,
    }));
  }, [purpose, stagingDestinations, putawayTargets]);

  const filteredDestinations = useMemo(
    () => destinationOptions.filter((location) => location.id !== draft.source_location_id),
    [destinationOptions, draft.source_location_id],
  );

  const effectiveUnits = useMemo(
    () => traceabilityUnits.filter((unit) =>
      unit.inventory_item_id === selectedItemId
      && unit.status.toUpperCase() === "ACTIVE"
      && (unit.product_role === "MATERIAL" || (unit.product_role === "FINISHED_GOOD" && unit.unit_type === "LOT"))),
    [traceabilityUnits, selectedItemId],
  );

  const visibleTransfers = useMemo(
    () => filterWarehouseTransfers(transfers, historySearch, historyPurpose),
    [transfers, historySearch, historyPurpose],
  );

  const summary = useMemo(
    () => summarizeWarehouseOperations(items, putawayTargets, pickSources, transfers),
    [items, putawayTargets, pickSources, transfers],
  );

  const locationLabel = useCallback((id: string | null | undefined) => {
    if (!id) return "—";
    const location = locations.find((entry) => entry.id === id);
    return location ? location.location_code + " · " + location.name : shortId(id);
  }, [locations]);

  const loadItems = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setItems([]);
      setLocations([]);
      setSelectedItemId("");
      return;
    }
    setLoadingItems(true);
    setError("");
    try {
      const [itemResult, locationResult] = await Promise.all([
        request("/inventory/items?limit=100"),
        request("/inventory/locations?limit=100"),
      ]);
      const nextItems = rowsOf<WarehouseItem>(itemResult, "items");
      setItems(nextItems);
      setLocations(rowsOf<WarehouseLocation>(locationResult, "locations"));
      setSelectedItemId((current) =>
        nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? "");
    } catch (cause) {
      setError(messageOf(cause));
      setItems([]);
      setLocations([]);
      setSelectedItemId("");
    } finally {
      setLoadingItems(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  const loadOperations = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead || !selectedItemId) {
      setPutawayTargets([]);
      setPickSources([]);
      setBinBalances([]);
      setTraceabilityUnits([]);
      setTransfers([]);
      return;
    }
    setLoadingOperations(true);
    setError("");
    const tasks: Promise<unknown>[] = [
      request("/inventory/items/" + selectedItemId + "/put-away-targets?limit=100"),
      request("/inventory/items/" + selectedItemId + "/pick-sources?limit=100"),
      request("/inventory/items/" + selectedItemId + "/locations?limit=100"),
      request("/inventory/items/" + selectedItemId + "/location-transfers?limit=100"),
    ];
    if (canTraceRead) {
      tasks.push(request("/traceability/units?product_role=MATERIAL&status=ACTIVE&limit=100"));
      tasks.push(request("/traceability/units?product_role=FINISHED_GOOD&status=ACTIVE&limit=100"));
    }
    try {
      const results = await Promise.allSettled(tasks);
      const requiredCount = 4;
      const requiredFailure = results.slice(0, requiredCount).some((entry) => entry.status === "rejected");
      const valueAt = (index: number) => results[index]?.status === "fulfilled"
        ? (results[index] as PromiseFulfilledResult<unknown>).value
        : null;
      setPutawayTargets(rowsOf<WarehousePutawayTarget>(valueAt(0), "targets"));
      setPickSources(rowsOf<WarehousePickSource>(valueAt(1), "sources"));
      setBinBalances(rowsOf<Record<string, unknown>>(valueAt(2), "balances"));
      setTransfers(rowsOf<WarehouseTransfer>(valueAt(3), "transfers"));
      if (canTraceRead) {
        const material = rowsOf<WarehouseTraceabilityUnit>(valueAt(4), "units");
        const finished = rowsOf<WarehouseTraceabilityUnit>(valueAt(5), "units");
        setTraceabilityUnits([...material, ...finished]);
      } else {
        setTraceabilityUnits([]);
      }
      if (requiredFailure) {
        setError("Some warehouse registers could not be loaded. Verify inventory.read access and refresh before posting a movement.");
      }
    } finally {
      setLoadingOperations(false);
    }
  }, [status, activeFactoryId, canRead, canTraceRead, selectedItemId, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadItems(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadOperations(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadOperations]);

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      source_location_id: sourceOptions.some((option) => option.id === current.source_location_id)
        ? current.source_location_id : sourceOptions[0]?.id ?? "",
      destination_location_id: filteredDestinations.some((option) => option.id === current.destination_location_id)
        ? current.destination_location_id : filteredDestinations[0]?.id ?? "",
      traceability_unit_id: effectiveUnits.some((unit) => unit.id === current.traceability_unit_id)
        ? current.traceability_unit_id : "",
    }));
  }, [sourceOptions, filteredDestinations, effectiveUnits]);

  async function refresh() {
    await loadItems();
    await loadOperations();
  }

  async function submitTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || !itemIsActive) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildLocationTransferPayload({
        movement_purpose: purpose as "PUT_AWAY" | "PICK" | "TRANSFER",
        source_location_id: draft.source_location_id,
        destination_location_id: draft.destination_location_id,
        quantity: draft.quantity,
        traceability_unit_id: draft.traceability_unit_id,
        notes: draft.notes,
      });
      const path = purpose === "PUT_AWAY"
        ? "/inventory/items/" + selectedItem.id + "/put-away"
        : purpose === "PICK"
          ? "/inventory/items/" + selectedItem.id + "/picks"
          : "/inventory/items/" + selectedItem.id + "/location-transfers";
      await request(path, {
        method: "POST",
        idempotencyKey: "warehouse-" + purpose.toLowerCase() + "-" + crypto.randomUUID(),
        body,
      });
      const completion = purpose === "PUT_AWAY"
        ? "Put-away movement posted. Stock was moved from staging/unassigned into the selected BIN."
        : purpose === "PICK"
          ? "Picking movement posted. Unreserved stock was moved from the selected BIN to staging."
          : "Internal BIN transfer posted. Stock moved between the selected locations.";
      setNotice(completion);
      setDraft((current) => ({ ...current, quantity: "", notes: "", traceability_unit_id: "" }));
      await loadOperations();
      await loadItems();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  if (status !== "connected" || !snapshot) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Warehouse operations</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Put-away, picking and location transfers use your authenticated FactoryOS session and active factory scope.</p>
          <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800">Connect session</Link>
        </section>
      </main>
    );
  }

  if (!activeFactoryId) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><section className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold text-amber-950">Select an active factory</h1><p className="mt-2 text-sm text-amber-900">Choose the operational factory in the workspace header before managing warehouse movements.</p></section></main>;
  }

  if (!canRead) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><section className="rounded-2xl border border-slate-200 bg-white p-6"><h1 className="text-xl font-bold text-slate-950">Inventory read access required</h1><p className="mt-2 text-sm text-slate-600">Your current permission snapshot does not include inventory.read.</p></section></main>;
  }

  const operationLabel = purpose === "PUT_AWAY" ? "Put-away"
    : purpose === "PICK" ? "Picking"
      : purpose === "TRANSFER" ? "Internal transfer" : "Movement history";

  const sourceLabel = purpose === "PUT_AWAY" ? "Staging / unassigned source"
    : "Picking-enabled source BIN";
  const destinationLabel = purpose === "PICK" ? "Staging destination"
    : "Putaway-enabled destination BIN";

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-5">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory · warehouse flow</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Put-away &amp; Picking Operations</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Direct inbound stock from staging to storage, pick unreserved stock to production staging, and re-slot stock between eligible BINs with an auditable transfer history.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loadingItems || loadingOperations || busy} className={secondaryButton}>Refresh warehouse data</button>
        </header>

        {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
        {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div> : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Active materials" value={summary.activeItems} detail="Factory inventory catalogue" />
          <Metric label="Put-away targets" value={summary.putawayTargets} detail="Eligible BIN locations" tone="emerald" />
          <Metric label="Picking sources" value={summary.pickSources} detail="BINs with unreserved stock" tone="blue" />
          <Metric label="Available at pick BINs" value={amount(summary.availableAtBins, selectedItem?.unit)} detail={amount(summary.reservedAtBins, selectedItem?.unit) + " reserved at these BINs"} tone="amber" />
          <Metric label="Recent movements" value={summary.recentTransfers} detail={summary.putawayMoves + " put-away · " + summary.pickMoves + " pick" } />
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_auto] lg:items-end">
            <Field label="Inventory material">
              <select className={inputClass} value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)} disabled={loadingItems || !items.length}>
                <option value="">Choose inventory item</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}{item.status.toUpperCase() !== "ACTIVE" ? " · " + item.status : ""}</option>)}
              </select>
            </Field>
            {selectedItem ? (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                <span className="font-semibold text-slate-900">{selectedItem.sku} · {selectedItem.name}</span>
                <span className="text-slate-500">On hand <strong className="text-slate-800">{amount(selectedItem.quantity_on_hand, selectedItem.unit)}</strong></span>
                <span className="text-slate-500">Reserved <strong className="text-slate-800">{amount(selectedItem.quantity_reserved, selectedItem.unit)}</strong></span>
                <span className="text-slate-500">Available <strong className="text-emerald-800">{amount(selectedItem.quantity_available, selectedItem.unit)}</strong></span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex flex-wrap gap-2" aria-label="Warehouse operation">
          {([
            ["PUT_AWAY", "Put-away"],
            ["PICK", "Picking"],
            ["TRANSFER", "Internal transfer"],
            ["HISTORY", "Movement history"],
          ] as const).map(([value, label]) => (
            <button
              type="button"
              key={value}
              onClick={() => setPurpose(value)}
              aria-pressed={purpose === value}
              className={[
                "inline-flex min-h-10 items-center rounded-lg px-4 text-xs font-semibold transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700",
                purpose === value ? "bg-slate-950 text-white" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </section>

        {purpose !== "HISTORY" ? (
          <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.8fr)]">
            <form onSubmit={submitTransfer} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-blue-700">Movement command</p>
                  <h2 className="mt-1 text-xl font-bold text-slate-950">{operationLabel}</h2>
                  <p className="mt-1 text-sm text-slate-500">{purpose === "PUT_AWAY" ? "Move newly received stock from a staging/unassigned location into an eligible storage BIN." : purpose === "PICK" ? "Move unreserved stock from a picking BIN to production or dispatch staging." : "Re-slot stock between eligible BIN locations without changing the factory's aggregate on-hand quantity."}</p>
                </div>
                {selectedItem ? <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold">{selectedItem.sku}</span> : null}
              </div>

              {!itemIsActive ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Select an active inventory item before posting warehouse movements.</div> : null}

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label={sourceLabel} hint={purpose === "PUT_AWAY" ? "Only active STAGING or default UNASSIGNED locations that allow picking are shown." : "Only active picking-enabled BINs that have unreserved stock are shown."}>
                  <select className={inputClass} value={draft.source_location_id} onChange={(event) => setDraft((current) => ({ ...current, source_location_id: event.target.value }))} disabled={loadingOperations || !sourceOptions.length}>
                    <option value="">Choose source location</option>
                    {sourceOptions.map((option) => <option key={option.id} value={option.id}>{option.code} · {option.name}{option.available !== null ? " · available " + option.available : ""}</option>)}
                  </select>
                </Field>
                <Field label={destinationLabel} hint={purpose === "PICK" ? "Only active STAGING locations that allow put-away are shown." : "Backend-provided put-away targets are ordered by configured priority."}>
                  <select className={inputClass} value={draft.destination_location_id} onChange={(event) => setDraft((current) => ({ ...current, destination_location_id: event.target.value }))} disabled={loadingOperations || !filteredDestinations.length}>
                    <option value="">Choose destination location</option>
                    {filteredDestinations.map((option) => <option key={option.id} value={option.id}>{option.code} · {option.name}{option.onHand !== null ? " · on hand " + option.onHand : ""}</option>)}
                  </select>
                </Field>
                <Field label={"Movement quantity (" + (selectedItem?.unit ?? "unit") + ")"} hint={purpose === "PICK" ? "Cannot exceed unreserved quantity at the selected BIN." : "Positive quantity, maximum four decimal places."}>
                  <input className={inputClass} type="number" inputMode="decimal" min="0.0001" step="0.0001" required value={draft.quantity} onChange={(event) => setDraft((current) => ({ ...current, quantity: event.target.value }))} placeholder="0.0000" />
                </Field>
                <Field label="LOT / SERIAL identity" hint={canTraceRead ? "Required by the backend when the effective traceability policy or stock identity requires it." : "traceability.read is needed to browse compatible identities. The backend remains authoritative."}>
                  <select className={inputClass} value={draft.traceability_unit_id} onChange={(event) => setDraft((current) => ({ ...current, traceability_unit_id: event.target.value }))} disabled={!canTraceRead || !effectiveUnits.length}>
                    <option value="">{canTraceRead ? "No identity selected" : "Traceability read access unavailable"}</option>
                    {effectiveUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.unit_code} · {unit.unit_type} · {unit.product_role}{unit.expires_at ? " · exp " + unit.expires_at.slice(0, 10) : ""}</option>)}
                  </select>
                </Field>
              </div>

              <div className="mt-4">
                <Field label="Movement notes">
                  <textarea className={inputClass + " min-h-24 py-2"} maxLength={1000} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Receipt reference, production line, pick wave or relocation reason…" />
                </Field>
              </div>

              <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-xs leading-5 text-blue-950">
                <strong>Server-enforced movement rules.</strong> Source/destination policy, BIN eligibility, available stock, LOT/SERIAL condition and quality holds are checked inside the API transaction. A valid Idempotency-Key is added to each submission. Transfers do not change aggregate on-hand stock.
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <p className="text-[11px] text-slate-500">{sourceOptions.length} source options · {filteredDestinations.length} destination options</p>
                <button type="submit" disabled={!canWrite || !itemIsActive || busy || loadingOperations || !draft.source_location_id || !draft.destination_location_id || !draft.quantity} className={primaryButton}>{busy ? "Posting movement…" : "Post " + operationLabel.toLowerCase()}</button>
              </div>
            </form>

            <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="font-semibold text-slate-950">Warehouse readiness</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">Live candidate registers for the selected inventory material.</p>
              <div className="mt-4 space-y-3">
                <div className="rounded-xl bg-emerald-50 p-3">
                  <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold text-emerald-900">Put-away target BINs</p><span className="text-lg font-bold text-emerald-950 tabular-nums">{putawayTargets.length}</span></div>
                  <div className="mt-2 space-y-1">{putawayTargets.slice(0, 4).map((target) => <div key={target.location_id} className="flex justify-between gap-2 text-[11px] text-emerald-900"><span>{target.location_code} · {target.location_name}</span><span>Priority {target.putaway_priority}</span></div>)}{!putawayTargets.length ? <p className="text-[11px] text-emerald-800">No eligible storage targets returned.</p> : null}</div>
                </div>
                <div className="rounded-xl bg-blue-50 p-3">
                  <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold text-blue-900">Picking source BINs</p><span className="text-lg font-bold text-blue-950 tabular-nums">{pickSources.length}</span></div>
                  <div className="mt-2 space-y-1">{pickSources.slice(0, 4).map((source) => <div key={source.location_id} className="flex justify-between gap-2 text-[11px] text-blue-900"><span>{source.location_code} · {source.location_name}</span><span>{amount(source.quantity_available, selectedItem?.unit)} free</span></div>)}{!pickSources.length ? <p className="text-[11px] text-blue-800">No active BIN has unreserved stock for this item.</p> : null}</div>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="text-xs font-semibold text-slate-800">Traceability identities</p>
                  <p className="mt-1 text-xl font-bold tabular-nums text-slate-950">{effectiveUnits.length}</p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500">{canTraceRead ? "Active LOT/SERIAL identities returned for this item. The API verifies source-location quantity and quality status." : "The role does not include traceability.read; identity browsing is unavailable."}</p>
                </div>
                <div className="rounded-xl border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-800">Bin balance snapshot</p>
                  {binBalances.length ? (
                    <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                      {binBalances.filter((balance) => String(balance.location_type).toUpperCase() === "BIN").slice(0, 12).map((balance) => (
                        <div key={String(balance.location_id)} className="flex items-center justify-between gap-3 text-[11px]">
                          <span className="min-w-0 truncate font-medium text-slate-700">{String(balance.location_code ?? shortId(String(balance.location_id)))}</span>
                          <span className="shrink-0 tabular-nums text-slate-600">{amount(balance.location_quantity_available, selectedItem?.unit)} free</span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="mt-2 text-[11px] text-slate-500">No location balances returned.</p>}
                </div>
              </div>
            </aside>
          </section>
        ) : (
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 p-4 sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><h2 className="font-semibold text-slate-950">Location movement history</h2><p className="mt-1 text-xs text-slate-500">Last 100 transfers for the selected material, in reverse chronological order.</p></div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{visibleTransfers.length} records</span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(220px,1fr)_200px]">
                <Field label="Search movement history"><input className={inputClass} value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Source, destination, notes, identity…" /></Field>
                <Field label="Movement purpose"><select className={inputClass} value={historyPurpose} onChange={(event) => setHistoryPurpose(event.target.value)}><option value="ALL">All purposes</option><option value="PUT_AWAY">Put-away</option><option value="PICK">Picking</option><option value="TRANSFER">Internal transfer</option></select></Field>
              </div>
            </div>
            {loadingOperations ? <div className="p-10 text-center text-sm text-slate-500">Loading movement history…</div> : visibleTransfers.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[850px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3 font-semibold">Purpose / date</th><th className="px-4 py-3 font-semibold">Source</th><th className="px-4 py-3 font-semibold">Destination</th><th className="px-4 py-3 font-semibold">Quantity</th><th className="px-4 py-3 font-semibold">Identity</th><th className="px-4 py-3 font-semibold">Evidence</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {visibleTransfers.map((transfer) => (
                      <tr key={transfer.id} className="align-top hover:bg-slate-50/70">
                        <td className="px-4 py-3"><PurposeTag value={transfer.movement_purpose} /><p className="mt-1 text-[11px] text-slate-500">{dateTime(transfer.created_at)}</p></td>
                        <td className="px-4 py-3 text-xs font-medium text-slate-800">{locationLabel(transfer.source_location_id)}</td>
                        <td className="px-4 py-3 text-xs font-medium text-slate-800">{locationLabel(transfer.destination_location_id)}</td>
                        <td className="px-4 py-3 font-semibold tabular-nums">{amount(transfer.quantity, selectedItem?.unit)}</td>
                        <td className="px-4 py-3 font-mono text-[11px] text-slate-600">{transfer.traceability_unit_id ? shortId(transfer.traceability_unit_id) : "Untracked"}</td>
                        <td className="px-4 py-3"><p className="max-w-44 truncate text-xs text-slate-700">{transfer.notes || "No notes"}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{shortId(transfer.correlation_id)}</p></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="p-10 text-center"><p className="font-semibold text-slate-800">No location transfers found</p><p className="mt-2 text-sm text-slate-500">{transfers.length ? "Adjust the search or purpose filter." : "Transfers will appear after a put-away, pick or internal move is posted."}</p></div>}
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-700 sm:p-5">
          <h2 className="font-semibold text-slate-900">Operational boundaries</h2>
          <p className="mt-1">Put-away requires STAGING or the default UNASSIGNED virtual source and a putaway-enabled BIN. Picking requires an active picking-enabled BIN and an enabled STAGING destination, and only unreserved stock can move. Internal transfers require a picking-enabled source and putaway-enabled destination. LOT/SERIAL traceability and quality holds are enforced by the API.</p>
          <p className="mt-2">These location movements redistribute stock between warehouse locations. They do not receive a supplier delivery, consume a production reservation, change aggregate on-hand quantity or release reserved stock.</p>
        </section>
      </div>
    </main>
  );
}
