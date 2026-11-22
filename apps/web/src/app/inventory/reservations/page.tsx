"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  asReservationRows,
  buildCreateReservationPayload,
  buildReservationTransitionPayload,
  filterReservations,
  reservationStatusLabel,
  summarizeReservations,
} from "@/lib/inventory-reservation.mjs";
import type {
  InventoryReservation,
  ReservationInventoryItem,
  ReservationLocation,
} from "@/lib/inventory-reservation.mjs";

type ReservationDraft = {
  quantity: string;
  location_id: string;
  reference_type: string;
  reference_id: string;
  notes: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function rowsOf<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[key])) return record[key] as T[];
    if (Array.isArray(record.items)) return record.items as T[];
  }
  return [];
}

function amount(value: unknown, unit = "") {
  const parsed = Number(value);
  const rendered = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : "—";
  return rendered + (unit ? " " + unit : "");
}

function shortId(value: string) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function Tag({ value }: { value: string }) {
  const tone = value === "RESERVED"
    ? "bg-blue-50 text-blue-800"
    : value === "CONSUMED"
      ? "bg-emerald-50 text-emerald-800"
      : value === "RELEASED"
        ? "bg-slate-100 text-slate-700"
        : "bg-amber-50 text-amber-800";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + tone}>{reservationStatusLabel(value)}</span>;
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "slate" | "blue" | "amber" | "emerald";
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

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
const dangerButton = buttonClass + " border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100";

export default function InventoryReservationIssueWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();
  const [items, setItems] = useState<ReservationInventoryItem[]>([]);
  const [locations, setLocations] = useState<ReservationLocation[]>([]);
  const [reservations, setReservations] = useState<InventoryReservation[]>([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedReservationId, setSelectedReservationId] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingReservations, setLoadingReservations] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<ReservationDraft>({
    quantity: "",
    location_id: "",
    reference_type: "WORK_ORDER",
    reference_id: "",
    notes: "",
  });
  const [issueTarget, setIssueTarget] = useState<InventoryReservation | null>(null);
  const [issueQuantity, setIssueQuantity] = useState("");
  const [releaseTarget, setReleaseTarget] = useState<InventoryReservation | null>(null);

  const canRead = hasPermission("inventory.read");
  const canWrite = hasPermission("inventory.write");
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;
  const selectedReservation = reservations.find((row) => row.id === selectedReservationId) ?? null;
  const activeBins = useMemo(
    () => locations.filter((location) =>
      location.location_type.toUpperCase() === "BIN"
      && location.status.toUpperCase() === "ACTIVE"
      && location.picking_enabled === true),
    [locations],
  );
  const summary = useMemo(() => summarizeReservations(reservations), [reservations]);
  const visibleReservations = useMemo(
    () => filterReservations(reservations, search, statusFilter),
    [reservations, search, statusFilter],
  );
  const itemIsActive = selectedItem?.status.toUpperCase() === "ACTIVE";

  const loadItems = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setItems([]);
      setLocations([]);
      setReservations([]);
      setSelectedItemId("");
      setSelectedReservationId("");
      return;
    }
    setLoadingItems(true);
    setError("");
    try {
      const results = await Promise.allSettled([
        request("/inventory/items?limit=100"),
        request("/inventory/locations?limit=100"),
      ]);
      if (results[0].status === "rejected") throw results[0].reason;
      const nextItems = rowsOf<ReservationInventoryItem>(results[0].value, "items");
      setItems(nextItems);
      setSelectedItemId((current) =>
        nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? "");
      if (results[1].status === "fulfilled") {
        setLocations(rowsOf<ReservationLocation>(results[1].value, "locations"));
      } else {
        setLocations([]);
        setError("Inventory items loaded, but BIN locations could not be read. New reservations can still be created without a location where backend traceability rules permit.");
      }
    } catch (cause) {
      setError(messageOf(cause));
      setItems([]);
      setReservations([]);
      setSelectedItemId("");
      setSelectedReservationId("");
    } finally {
      setLoadingItems(false);
    }
  }, [status, activeFactoryId, canRead, request]);

  const loadReservations = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead || !selectedItemId) {
      setReservations([]);
      setSelectedReservationId("");
      return;
    }
    setLoadingReservations(true);
    try {
      const result = await request("/inventory/items/" + selectedItemId + "/reservations?limit=100");
      const nextRows = asReservationRows(result) as InventoryReservation[];
      setReservations(nextRows);
      setSelectedReservationId((current) =>
        nextRows.some((row) => row.id === current) ? current : nextRows[0]?.id ?? "");
    } catch (cause) {
      setReservations([]);
      setSelectedReservationId("");
      setError(messageOf(cause));
    } finally {
      setLoadingReservations(false);
    }
  }, [status, activeFactoryId, canRead, selectedItemId, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadItems(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadReservations(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadReservations]);

  async function refresh() {
    await loadItems();
    await loadReservations();
  }

  async function createReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedItem || !itemIsActive) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildCreateReservationPayload(createDraft);
      await request("/inventory/items/" + selectedItem.id + "/reservations", {
        method: "POST",
        idempotencyKey: "inventory-reservation-create-" + crypto.randomUUID(),
        body,
      });
      setCreateOpen(false);
      setCreateDraft({ quantity: "", location_id: "", reference_type: "WORK_ORDER", reference_id: "", notes: "" });
      setNotice("Stock reserved. The available balance and reservation register have been refreshed.");
      await loadItems();
      await loadReservations();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function consumeReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issueTarget) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = buildReservationTransitionPayload({
        target_status: "CONSUMED",
        quantity: issueQuantity,
        remaining_quantity: issueTarget.remaining_quantity,
      });
      const result = await request(
        "/inventory/items/" + issueTarget.item_id + "/reservations/" + issueTarget.id + "/transition",
        {
          method: "POST",
          idempotencyKey: "inventory-reservation-consume-" + crypto.randomUUID(),
          body,
        },
      ) as InventoryReservation & { consumption_movement_id?: string | null; consumed_quantity_this_request?: string };
      const stillOpen = Number(result.remaining_quantity) > 0 && result.status === "RESERVED";
      setIssueTarget(null);
      setIssueQuantity("");
      setNotice(stillOpen
        ? "Partial material issue posted. The reservation remains open for its remaining quantity."
        : "Material issued. The reservation is fully consumed and the API recorded the stock movement.");
      await loadItems();
      await loadReservations();
      if (result.consumption_movement_id) {
        setNotice((current) => current + " Movement reference: " + shortId(result.consumption_movement_id ?? "") + ".");
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function releaseReservation() {
    if (!releaseTarget) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(
        "/inventory/items/" + releaseTarget.item_id + "/reservations/" + releaseTarget.id + "/transition",
        {
          method: "POST",
          idempotencyKey: "inventory-reservation-release-" + crypto.randomUUID(),
          body: buildReservationTransitionPayload({
            target_status: "RELEASED",
            remaining_quantity: releaseTarget.remaining_quantity,
          }),
        },
      );
      setReleaseTarget(null);
      setNotice("Unused reserved quantity released back to available stock. On-hand quantity was not changed.");
      await loadItems();
      await loadReservations();
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
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory operations</p>
          <h1 className="mt-2 text-3xl font-bold text-slate-950">Connect your workspace</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Reservations and material issues use your authenticated FactoryOS session and selected factory.</p>
          <Link href="/session" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800">Connect session</Link>
        </section>
      </main>
    );
  }

  if (!activeFactoryId) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><section className="rounded-2xl border border-amber-200 bg-amber-50 p-6"><h1 className="text-xl font-bold text-amber-950">Select an active factory</h1><p className="mt-2 text-sm text-amber-900">Choose the operational factory in the workspace header before managing inventory reservations.</p></section></main>;
  }

  if (!canRead) {
    return <main className="mx-auto max-w-4xl px-4 py-12"><section className="rounded-2xl border border-slate-200 bg-white p-6"><h1 className="text-xl font-bold text-slate-950">Inventory read access required</h1><p className="mt-2 text-sm text-slate-600">Your current permission snapshot does not include inventory.read. Ask a factory administrator to grant access.</p></section></main>;
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-5">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Inventory · execution control</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Reservation &amp; Material Issue</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Reserve available stock against a work reference, issue material in full or partial quantities, and release unused commitments without changing on-hand stock.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={() => void refresh()} disabled={loadingItems || loadingReservations || busy} className={secondaryButton}>Refresh registers</button>
            <button type="button" onClick={() => { setError(""); setCreateOpen(true); }} disabled={!canWrite || !itemIsActive || busy} className={primaryButton}>New reservation</button>
          </div>
        </header>

        {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
        {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div> : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Reservations" value={summary.total} detail="Selected material · last 100 records" />
          <Metric label="Open reservations" value={summary.active} detail="Still holding stock" tone="blue" />
          <Metric label="Quantity reserved" value={amount(summary.remainingQuantity, selectedItem?.unit)} detail={summary.partial + " partially processed"} tone="amber" />
          <Metric label="Quantity consumed" value={amount(summary.consumedQuantity, selectedItem?.unit)} detail="Material already issued" tone="emerald" />
          <Metric label="Quantity released" value={amount(summary.releasedQuantity, selectedItem?.unit)} detail="Returned to available stock" />
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.1fr)_minmax(220px,1fr)_180px_auto] lg:items-end">
            <Field label="Inventory material">
              <select className={inputClass} value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)} disabled={loadingItems || !items.length}>
                <option value="">Choose an inventory item</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}{item.status.toUpperCase() !== "ACTIVE" ? " · " + item.status : ""}</option>)}
              </select>
            </Field>
            <Field label="Search reservations">
              <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ID, work order, note or BIN" />
            </Field>
            <Field label="Lifecycle status">
              <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="ALL">All statuses</option>
                <option value="RESERVED">Reserved</option>
                <option value="CONSUMED">Consumed</option>
                <option value="RELEASED">Released</option>
              </select>
            </Field>
            <div className="flex min-h-10 items-center justify-start gap-2 text-xs text-slate-500 lg:justify-end">
              <span className="size-2 rounded-full bg-emerald-500" />
              {loadingItems || loadingReservations ? "Refreshing…" : "Factory-scoped register"}
            </div>
          </div>
          {selectedItem ? (
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-4 text-xs">
              <span className="font-semibold text-slate-900">{selectedItem.sku} · {selectedItem.name}</span>
              <span className="text-slate-500">On hand <strong className="text-slate-800">{amount(selectedItem.quantity_on_hand, selectedItem.unit)}</strong></span>
              <span className="text-slate-500">Reserved <strong className="text-slate-800">{amount(selectedItem.quantity_reserved, selectedItem.unit)}</strong></span>
              <span className="text-slate-500">Available <strong className="text-emerald-800">{amount(selectedItem.quantity_available, selectedItem.unit)}</strong></span>
            </div>
          ) : null}
        </section>

        <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.8fr)]">
          <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
              <div>
                <h2 className="font-semibold text-slate-950">Reservation register</h2>
                <p className="mt-1 text-xs text-slate-500">Select a row to inspect the stock commitment and its lifecycle.</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{visibleReservations.length} records</span>
            </div>
            {loadingReservations ? (
              <div className="p-10 text-center text-sm text-slate-500">Loading reservation register…</div>
            ) : visibleReservations.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr><th className="px-4 py-3 font-semibold">Reference</th><th className="px-4 py-3 font-semibold">Reserved</th><th className="px-4 py-3 font-semibold">Remaining</th><th className="px-4 py-3 font-semibold">Created</th><th className="px-4 py-3 font-semibold">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visibleReservations.map((row) => (
                      <tr
                        key={row.id}
                        tabIndex={0}
                        aria-selected={selectedReservationId === row.id}
                        onClick={() => setSelectedReservationId(row.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedReservationId(row.id);
                          }
                        }}
                        className={"cursor-pointer outline-none hover:bg-blue-50/60 focus-visible:bg-blue-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 " + (selectedReservationId === row.id ? "bg-blue-50/80" : "")}
                      >
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-900">{row.reference_type || "Unlinked reservation"}</p>
                          <p className="mt-0.5 font-mono text-[11px] text-slate-500">{row.reference_id ? shortId(row.reference_id) : shortId(row.id)}</p>
                        </td>
                        <td className="px-4 py-3 tabular-nums">{amount(row.quantity, selectedItem?.unit)}</td>
                        <td className="px-4 py-3 font-semibold tabular-nums">{amount(row.remaining_quantity, selectedItem?.unit)}</td>
                        <td className="px-4 py-3 text-xs text-slate-500">{dateTime(row.created_at)}</td>
                        <td className="px-4 py-3"><Tag value={row.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-10 text-center">
                <p className="font-semibold text-slate-800">{reservations.length ? "No reservations match these filters" : "No reservations for this material yet"}</p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-5 text-slate-500">{reservations.length ? "Change the search or status filter to see other lifecycle records." : "Create a reservation to earmark available factory stock for a downstream work reference."}</p>
                {!reservations.length && canWrite && itemIsActive ? <button type="button" onClick={() => setCreateOpen(true)} className={"mt-4 " + primaryButton}>Create first reservation</button> : null}
              </div>
            )}
          </div>

          <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            {selectedReservation ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected reservation</p>
                    <h2 className="mt-1 truncate font-mono text-sm font-bold text-slate-950">{shortId(selectedReservation.id)}</h2>
                    <p className="mt-1 text-xs text-slate-500">{selectedReservation.reference_type || "No reference type"} · {selectedReservation.reference_id ? shortId(selectedReservation.reference_id) : "No reference ID"}</p>
                  </div>
                  <Tag value={selectedReservation.status} />
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] text-slate-500">Original</p><p className="mt-1 text-lg font-bold tabular-nums">{amount(selectedReservation.quantity, selectedItem?.unit)}</p></div>
                  <div className="rounded-xl bg-blue-50 p-3"><p className="text-[11px] text-blue-700">Remaining</p><p className="mt-1 text-lg font-bold text-blue-950 tabular-nums">{amount(selectedReservation.remaining_quantity, selectedItem?.unit)}</p></div>
                  <div className="rounded-xl bg-emerald-50 p-3"><p className="text-[11px] text-emerald-700">Consumed</p><p className="mt-1 text-base font-bold text-emerald-950 tabular-nums">{amount(selectedReservation.consumed_quantity, selectedItem?.unit)}</p></div>
                  <div className="rounded-xl bg-slate-100 p-3"><p className="text-[11px] text-slate-600">Released</p><p className="mt-1 text-base font-bold text-slate-900 tabular-nums">{amount(selectedReservation.released_quantity, selectedItem?.unit)}</p></div>
                </div>
                <dl className="mt-5 space-y-3 text-xs">
                  <div className="flex justify-between gap-3"><dt className="text-slate-500">BIN location</dt><dd className="text-right font-semibold text-slate-800">{locations.find((location) => location.id === selectedReservation.location_id)?.location_code ?? (selectedReservation.location_id ? shortId(selectedReservation.location_id) : "Not specified")}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-slate-500">Created</dt><dd className="text-right text-slate-700">{dateTime(selectedReservation.created_at)}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-slate-500">Updated</dt><dd className="text-right text-slate-700">{dateTime(selectedReservation.updated_at)}</dd></div>
                  <div><dt className="text-slate-500">Notes</dt><dd className="mt-1 whitespace-pre-wrap break-words text-slate-800">{selectedReservation.notes || "No notes recorded"}</dd></div>
                  {selectedReservation.consumed_movement_id ? <div><dt className="text-slate-500">Consumption movement</dt><dd className="mt-1 break-all font-mono text-[11px] text-slate-800">{selectedReservation.consumed_movement_id}</dd></div> : null}
                  <div><dt className="text-slate-500">Correlation ID</dt><dd className="mt-1 break-all font-mono text-[10px] text-slate-500">{selectedReservation.correlation_id}</dd></div>
                </dl>
                {canWrite && selectedReservation.status === "RESERVED" && Number(selectedReservation.remaining_quantity) > 0 ? (
                  <div className="mt-5 grid gap-2 border-t border-slate-100 pt-4">
                    <button type="button" onClick={() => { setIssueTarget(selectedReservation); setIssueQuantity(""); }} disabled={busy} className={primaryButton}>Issue material</button>
                    <button type="button" onClick={() => setReleaseTarget(selectedReservation)} disabled={busy} className={dangerButton}>Release unused quantity</button>
                    <p className="text-[11px] leading-4 text-slate-500">Issue creates a stock movement through the reservation API. Release reduces reserved quantity and restores availability; neither action can be undone from this page.</p>
                  </div>
                ) : (
                  <p className="mt-5 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">This reservation has no remaining actionable quantity, or your role is read-only.</p>
                )}
              </>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center text-center">
                <p className="font-semibold text-slate-800">Reservation details</p>
                <p className="mt-2 max-w-xs text-sm text-slate-500">Choose a reservation from the register to inspect its quantity history and available actions.</p>
              </div>
            )}
          </aside>
        </section>

        <section className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4 text-xs leading-5 text-blue-950 sm:p-5">
          <h2 className="font-semibold">Operational controls</h2>
          <p className="mt-1">All quantities are validated to four decimal places. Reservation creation requires available stock and an Idempotency-Key. When LOT/SERIAL traceability is enforced, the API requires an eligible picking BIN and compatible active identities. The server remains authoritative for allocation order, stock balances, permissions and lifecycle conflicts.</p>
          <p className="mt-2 text-blue-900">This page only issues or releases existing reservations. It does not approve procurement, create a work order, or directly edit the inventory ledger.</p>
        </section>
      </div>

      {createOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCreateOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="reservation-create-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Stock commitment</p><h2 id="reservation-create-title" className="mt-1 text-xl font-bold text-slate-950">Create inventory reservation</h2><p className="mt-1 text-sm text-slate-500">{selectedItem?.sku} · {selectedItem?.name}</p></div>
              <button type="button" onClick={() => setCreateOpen(false)} disabled={busy} aria-label="Close reservation form" className={secondaryButton}>Close</button>
            </div>
            <form onSubmit={createReservation} className="mt-5 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={"Quantity (" + (selectedItem?.unit ?? "unit") + ")"} hint={"Available now: " + amount(selectedItem?.quantity_available, selectedItem?.unit)}>
                  <input className={inputClass} type="number" inputMode="decimal" min="0.0001" max={selectedItem?.quantity_available} step="0.0001" required value={createDraft.quantity} onChange={(event) => setCreateDraft((current) => ({ ...current, quantity: event.target.value }))} placeholder="0.0000" />
                </Field>
                <Field label="Picking BIN" hint="Optional for ordinary stock; traceability policy may require a compatible active BIN.">
                  <select className={inputClass} value={createDraft.location_id} onChange={(event) => setCreateDraft((current) => ({ ...current, location_id: event.target.value }))}>
                    <option value="">No BIN selected</option>
                    {activeBins.map((location) => <option key={location.id} value={location.id}>{location.location_code} · {location.name}</option>)}
                  </select>
                </Field>
                <Field label="Reference type" hint="Example: WORK_ORDER, SALES_ORDER or TRANSFER.">
                  <input className={inputClass} maxLength={64} value={createDraft.reference_type} onChange={(event) => setCreateDraft((current) => ({ ...current, reference_type: event.target.value }))} placeholder="WORK_ORDER" />
                </Field>
                <Field label="Reference ID" hint="Optional UUID from the connected operational record.">
                  <input className={inputClass} value={createDraft.reference_id} onChange={(event) => setCreateDraft((current) => ({ ...current, reference_id: event.target.value }))} placeholder="00000000-0000-4000-8000-000000000000" />
                </Field>
              </div>
              <Field label="Reservation notes">
                <textarea className={inputClass + " min-h-24 py-2"} maxLength={1000} value={createDraft.notes} onChange={(event) => setCreateDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Reason, production line or handling instructions…" />
              </Field>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">Creating a reservation decreases available stock by increasing its reserved balance. It does not issue or consume stock. The backend checks the selected BIN, traceability identities and available quantity inside its transaction.</div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
                <button type="button" onClick={() => setCreateOpen(false)} disabled={busy} className={secondaryButton}>Cancel</button>
                <button type="submit" disabled={busy || !canWrite || !itemIsActive || !createDraft.quantity} className={primaryButton}>{busy ? "Saving…" : "Reserve stock"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {issueTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setIssueTarget(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="reservation-issue-title" className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Material issue</p>
            <h2 id="reservation-issue-title" className="mt-1 text-xl font-bold text-slate-950">Consume reserved stock</h2>
            <p className="mt-2 text-sm leading-5 text-slate-600">Reservation {shortId(issueTarget.id)} has {amount(issueTarget.remaining_quantity, selectedItem?.unit)} remaining.</p>
            <form onSubmit={consumeReservation} className="mt-5 space-y-4">
              <Field label={"Issue quantity (" + (selectedItem?.unit ?? "unit") + ")"} hint="Leave blank to consume all remaining quantity. Enter a smaller amount for a partial issue.">
                <input className={inputClass} type="number" inputMode="decimal" min="0.0001" max={issueTarget.remaining_quantity} step="0.0001" value={issueQuantity} onChange={(event) => setIssueQuantity(event.target.value)} placeholder={"All remaining · " + issueTarget.remaining_quantity} />
              </Field>
              <div className="rounded-xl bg-emerald-50 p-3 text-xs leading-5 text-emerald-950">The API records the stock issue movement and updates the reservation atomically. Partial issues keep the reservation open until its remaining quantity reaches zero.</div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
                <button type="button" onClick={() => setIssueTarget(null)} disabled={busy} className={secondaryButton}>Cancel</button>
                <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Posting…" : "Post material issue"}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {releaseTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setReleaseTarget(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="reservation-release-title" className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <p className="text-xs font-bold uppercase tracking-wide text-rose-700">Release confirmation</p>
            <h2 id="reservation-release-title" className="mt-1 text-xl font-bold text-slate-950">Release unused reservation?</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">This releases the full remaining quantity of <strong className="text-slate-950">{amount(releaseTarget.remaining_quantity, selectedItem?.unit)}</strong> from reservation {shortId(releaseTarget.id)}. Available stock will increase by the released amount; on-hand stock will remain unchanged.</p>
            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button type="button" onClick={() => setReleaseTarget(null)} disabled={busy} className={secondaryButton}>Keep reservation</button>
              <button type="button" onClick={() => void releaseReservation()} disabled={busy} className={dangerButton}>{busy ? "Releasing…" : "Release remaining"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
