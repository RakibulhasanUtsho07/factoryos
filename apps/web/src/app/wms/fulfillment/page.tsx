"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";
import {
  allowedNextDeliveryEvents,
  asFulfillmentRows,
  buildCreateContainerPayload,
  buildDeliveryEventPayload,
  buildDispatchPayload,
  buildPackingContentPayload,
  filterContainerIdentities,
  filterOutboundShipments,
  fulfillmentStatusLabel,
  summarizeFulfillment,
} from "@/lib/wms-fulfillment-workbench.mjs";
import type {
  FulfillmentContainer,
  FulfillmentDeliveryEvent,
  FulfillmentIdentity,
  FulfillmentInventoryItem,
  FulfillmentLocation,
  FulfillmentOrder,
  FulfillmentOrderDetail,
  FulfillmentShipment,
} from "@/lib/wms-fulfillment-workbench.mjs";

type WorkspaceTab = "PACKING" | "SHIPMENTS" | "DELIVERY";
type ContainerType = "CARTON" | "PALLET";
type DeliveryEventType = "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERY_FAILED" | "DELIVERED" | "RETURNED";

type ContainerDraft = {
  container_type: ContainerType;
  container_code: string;
  item_id: string;
  location_id: string;
  capacity_quantity: string;
};

type ContentDraft = {
  source_unit_id: string;
  quantity: string;
};

type DispatchDraft = {
  shipment_code: string;
  customer_name: string;
  customer_order_reference: string;
  carrier_name: string;
  tracking_reference: string;
  order_id: string;
  order_line_id: string;
};

type DeliveryDraft = {
  event_type: DeliveryEventType | "";
  event_at: string;
  recipient_name: string;
  proof_type: string;
  proof_reference: string;
  proof_sha256: string;
  signed_at: string;
  notes: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function rows<T>(value: unknown, key: string): T[] {
  return asFulfillmentRows(value, key) as T[];
}

function amount(value: unknown, unit = "") {
  const parsed = Number(value);
  const rendered = Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : "—";
  return rendered + (unit ? " " + unit : "");
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortId(value: string) {
  return value ? value.slice(0, 8).toUpperCase() : "—";
}

function Metric({ label, value, detail, tone = "slate" }: {
  label: string;
  value: string | number;
  detail: string;
  tone?: "slate" | "blue" | "amber" | "emerald" | "rose";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    blue: "border-blue-100 bg-blue-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    emerald: "border-emerald-100 bg-emerald-50/60",
    rose: "border-rose-100 bg-rose-50/60",
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

function StatusPill({ value }: { value: string }) {
  const normalized = value.toUpperCase();
  const tone = normalized === "SEALED" || normalized === "DELIVERED" || normalized === "SHIPPED"
    ? "bg-emerald-50 text-emerald-800"
    : normalized === "OPEN" || normalized === "IN_TRANSIT" || normalized === "OUT_FOR_DELIVERY"
      ? "bg-blue-50 text-blue-800"
      : normalized === "DELIVERY_FAILED" || normalized === "RETURNED"
        ? "bg-rose-50 text-rose-800"
        : normalized === "DISPATCHED"
          ? "bg-amber-50 text-amber-800"
          : "bg-slate-100 text-slate-700";
  return <span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold " + tone}>{fulfillmentStatusLabel(value)}</span>;
}

const inputClass = "min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = buttonClass + " bg-slate-950 text-white hover:bg-slate-800";
const secondaryButton = buttonClass + " border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";

function localDateTimeNow() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

export default function WmsFulfillmentWorkbenchPage() {
  const { status, snapshot, activeFactoryId, hasPermission, request } = useFactoryOsSession();

  const [items, setItems] = useState<FulfillmentInventoryItem[]>([]);
  const [locations, setLocations] = useState<FulfillmentLocation[]>([]);
  const [cartonIdentities, setCartonIdentities] = useState<FulfillmentIdentity[]>([]);
  const [palletIdentities, setPalletIdentities] = useState<FulfillmentIdentity[]>([]);
  const [finishedLots, setFinishedLots] = useState<FulfillmentIdentity[]>([]);
  const [shipments, setShipments] = useState<FulfillmentShipment[]>([]);
  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<FulfillmentOrderDetail | null>(null);

  const [containersSearch, setContainersSearch] = useState("");
  const [containerTypeFilter, setContainerTypeFilter] = useState("ALL");
  const [shipmentSearch, setShipmentSearch] = useState("");
  const [shipmentEventFilter, setShipmentEventFilter] = useState("ALL");
  const [selectedContainerId, setSelectedContainerId] = useState("");
  const [selectedContainer, setSelectedContainer] = useState<FulfillmentContainer | null>(null);
  const [selectedShipmentId, setSelectedShipmentId] = useState("");
  const [selectedShipment, setSelectedShipment] = useState<FulfillmentShipment | null>(null);
  const [deliveryEvents, setDeliveryEvents] = useState<FulfillmentDeliveryEvent[]>([]);
  const [selectedPalletCarton, setSelectedPalletCarton] = useState<FulfillmentContainer | null>(null);

  const [tab, setTab] = useState<WorkspaceTab>("PACKING");
  const [containerDraft, setContainerDraft] = useState<ContainerDraft>({
    container_type: "CARTON", container_code: "", item_id: "", location_id: "", capacity_quantity: "",
  });
  const [contentDraft, setContentDraft] = useState<ContentDraft>({ source_unit_id: "", quantity: "" });
  const [dispatchDraft, setDispatchDraft] = useState<DispatchDraft>({
    shipment_code: "", customer_name: "", customer_order_reference: "",
    carrier_name: "", tracking_reference: "", order_id: "", order_line_id: "",
  });
  const [deliveryDraft, setDeliveryDraft] = useState<DeliveryDraft>({
    event_type: "", event_at: "", recipient_name: "", proof_type: "",
    proof_reference: "", proof_sha256: "", signed_at: "", notes: "",
  });

  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingDelivery, setLoadingDelivery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canRead = hasPermission("traceability.read");
  const canWrite = hasPermission("traceability.write");
  const canInventoryRead = hasPermission("inventory.read");
  const canOrdersRead = hasPermission("orders.read");
  const selectedItem = items.find((item) => item.id === containerDraft.item_id) ?? null;
  const activePackingLocations = useMemo(
    () => locations.filter((location) =>
      location.status.toUpperCase() === "ACTIVE"
      && location.picking_enabled
      && ["BIN", "STAGING"].includes(location.location_type.toUpperCase())),
    [locations],
  );
  const containerIdentities = useMemo(
    () => [...cartonIdentities, ...palletIdentities],
    [cartonIdentities, palletIdentities],
  );
  const visibleContainers = useMemo(
    () => filterContainerIdentities(containerIdentities, containersSearch, containerTypeFilter),
    [containerIdentities, containersSearch, containerTypeFilter],
  );
  const visibleShipments = useMemo(
    () => filterOutboundShipments(shipments, shipmentSearch, shipmentEventFilter),
    [shipments, shipmentSearch, shipmentEventFilter],
  );
  const summary = useMemo(
    () => summarizeFulfillment(containerIdentities, shipments),
    [containerIdentities, shipments],
  );
  const selectedSourceLot = finishedLots.find((unit) => unit.id === contentDraft.source_unit_id) ?? null;
  const selectedCartonIdentity = cartonIdentities.find((unit) => unit.id === contentDraft.source_unit_id) ?? null;
  const availableOrderLines = (selectedOrder?.lines ?? []).filter((line) =>
    !selectedContainer || (
      (line.inventory_item_id === selectedContainer.item_id || !line.inventory_item_id)
      && line.unit.toUpperCase() === selectedContainer.unit.toUpperCase()
      && line.product_code.toUpperCase() === (items.find((item) => item.id === selectedContainer.item_id)?.sku ?? line.product_code).toUpperCase()
    ));

  const loadWorkspace = useCallback(async () => {
    if (status !== "connected" || !activeFactoryId || !canRead) {
      setItems([]);
      setLocations([]);
      setCartonIdentities([]);
      setPalletIdentities([]);
      setFinishedLots([]);
      setShipments([]);
      setOrders([]);
      setSelectedContainerId("");
      setSelectedShipmentId("");
      setSelectedContainer(null);
      setSelectedShipment(null);
      return;
    }
    setLoading(true);
    setError("");
    const tasks: Promise<unknown>[] = [
      canInventoryRead ? request("/inventory/items?limit=100") : Promise.resolve([]),
      canInventoryRead ? request("/inventory/locations?limit=100") : Promise.resolve([]),
      request("/traceability/units?unit_type=CARTON&product_role=PACKAGING&limit=100"),
      request("/traceability/units?unit_type=PALLET&product_role=PACKAGING&limit=100"),
      request("/traceability/units?unit_type=LOT&product_role=FINISHED_GOOD&status=ACTIVE&limit=100"),
      request("/traceability/shipments?limit=100"),
      canOrdersRead ? request("/orders?limit=100") : Promise.resolve({ items: [] }),
    ];
    try {
      const results = await Promise.allSettled(tasks);
      const valueAt = (index: number) => results[index]?.status === "fulfilled"
        ? (results[index] as PromiseFulfilledResult<unknown>).value : null;
      setItems(rows<FulfillmentInventoryItem>(valueAt(0), "items"));
      setLocations(rows<FulfillmentLocation>(valueAt(1), "locations"));
      const nextCartons = rows<FulfillmentIdentity>(valueAt(2), "units");
      const nextPallets = rows<FulfillmentIdentity>(valueAt(3), "units");
      setCartonIdentities(nextCartons);
      setPalletIdentities(nextPallets);
      setFinishedLots(rows<FulfillmentIdentity>(valueAt(4), "units"));
      const nextShipments = rows<FulfillmentShipment>(valueAt(5), "shipments");
      setShipments(nextShipments);
      setOrders(rows<FulfillmentOrder>(valueAt(6), "items"));
      const nextContainerIds = [...nextCartons, ...nextPallets];
      setSelectedContainerId((current) =>
        nextContainerIds.some((unit) => unit.id === current) ? current : "");
      setSelectedShipmentId((current) =>
        nextShipments.some((shipment) => shipment.shipment_unit_id === current)
          ? current : nextShipments[0]?.shipment_unit_id ?? "");
      const requiredFailures = results.slice(2, 6).some((result) => result.status === "rejected");
      if (requiredFailures) {
        setError("Some packing or shipment registers could not be loaded. Verify traceability.read and refresh before taking an operational action.");
      } else if (results.slice(0, 2).some((result) => result.status === "rejected")) {
        setError("Traceability registers loaded, but inventory references are incomplete. Container creation requires inventory.read.");
      }
      if (results[6]?.status === "rejected" && canOrdersRead) {
        setError("Fulfillment data loaded, but customer order binding is unavailable. Dispatch can still use an external customer-order reference.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [status, activeFactoryId, canRead, canInventoryRead, canOrdersRead, request]);

  const loadContainerDetail = useCallback(async (containerId: string) => {
    if (!containerId || !canRead) {
      setSelectedContainer(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const result = await request("/traceability/containers/" + containerId);
      setSelectedContainer(result as FulfillmentContainer);
    } catch (cause) {
      setSelectedContainer(null);
      setError(errorMessage(cause));
    } finally {
      setLoadingDetail(false);
    }
  }, [canRead, request]);

  const loadShipmentDetail = useCallback(async (shipmentId: string) => {
    const shipment = shipments.find((entry) => entry.shipment_unit_id === shipmentId) ?? null;
    setSelectedShipment(shipment);
    setDeliveryEvents([]);
    setSelectedPalletCarton(null);
    if (!shipmentId || !canRead) return;
    setLoadingDelivery(true);
    try {
      const result = await request("/traceability/shipments/" + shipmentId + "/delivery-events");
      setDeliveryEvents(rows<FulfillmentDeliveryEvent>(result, "events"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingDelivery(false);
    }
  }, [shipments, canRead, request]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  useEffect(() => {
    if (!selectedContainerId) {
      setSelectedContainer(null);
      return;
    }
    const timer = window.setTimeout(() => { void loadContainerDetail(selectedContainerId); }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedContainerId, loadContainerDetail]);

  useEffect(() => {
    if (!selectedShipmentId) {
      setSelectedShipment(null);
      setDeliveryEvents([]);
      return;
    }
    const timer = window.setTimeout(() => { void loadShipmentDetail(selectedShipmentId); }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedShipmentId, loadShipmentDetail]);

  useEffect(() => {
    if (!selectedContainer) return;
    setDispatchDraft((current) => ({
      ...current,
      customer_name: current.customer_name || "",
      customer_order_reference: current.customer_order_reference || "",
    }));
    setContentDraft({ source_unit_id: "", quantity: "" });
    setSelectedPalletCarton(null);
  }, [selectedContainer?.container_unit_id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setContainerDraft((current) => ({
        ...current,
        item_id: items.some((item) => item.id === current.item_id) ? current.item_id : items[0]?.id ?? "",
        location_id: activePackingLocations.some((location) => location.id === current.location_id)
          ? current.location_id : activePackingLocations[0]?.id ?? "",
      }));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [items, activePackingLocations]);

  async function refreshAll() {
    await loadWorkspace();
    if (selectedContainerId) await loadContainerDetail(selectedContainerId);
    if (selectedShipmentId) await loadShipmentDetail(selectedShipmentId);
  }

  async function createContainer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !canInventoryRead || !selectedItem || selectedItem.status.toUpperCase() !== "ACTIVE") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildCreateContainerPayload(containerDraft);
      const result = await request("/traceability/containers", {
        method: "POST",
        idempotencyKey: "wms-container-" + crypto.randomUUID(),
        body: payload,
      }) as { container?: { container_unit_id?: string; unit_code?: string } };
      setContainerDraft((current) => ({ ...current, container_code: "", capacity_quantity: "" }));
      await loadWorkspace();
      const newId = result.container?.container_unit_id;
      if (newId) setSelectedContainerId(newId);
      setNotice("Packing container registered as an OPEN traceability identity. Inventory quantities have not been changed.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadPalletSourceCarton(containerId: string) {
    setContentDraft((current) => ({ ...current, source_unit_id: containerId, quantity: "" }));
    setSelectedPalletCarton(null);
    if (!containerId) return;
    try {
      const result = await request("/traceability/containers/" + containerId);
      const detail = result as FulfillmentContainer;
      setSelectedPalletCarton(detail);
      if (detail.status === "SEALED" && selectedContainer
        && detail.item_id === selectedContainer.item_id
        && detail.location_id === selectedContainer.location_id) {
        setContentDraft((current) => ({ ...current, source_unit_id: containerId, quantity: detail.packed_quantity }));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function addPackingContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !selectedContainer || selectedContainer.status !== "OPEN") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildPackingContentPayload({
        container_unit_id: selectedContainer.container_unit_id,
        source_unit_id: contentDraft.source_unit_id,
        container_type: selectedContainer.container_type,
        item_id: selectedContainer.item_id,
        location_id: selectedContainer.location_id,
        quantity: contentDraft.quantity,
        source_unit: selectedSourceLot,
        source_container: selectedPalletCarton,
      });
      await request("/traceability/containers/" + selectedContainer.container_unit_id + "/contents", {
        method: "POST",
        idempotencyKey: "wms-pack-" + crypto.randomUUID(),
        body: payload,
      });
      setContentDraft({ source_unit_id: "", quantity: "" });
      setSelectedPalletCarton(null);
      await loadContainerDetail(selectedContainer.container_unit_id);
      setNotice("Packing content and genealogy edge recorded. The backend enforced available stock, quality holds and container capacity.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sealContainer() {
    if (!canWrite || !selectedContainer || selectedContainer.status !== "OPEN" || Number(selectedContainer.packed_quantity) <= 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request("/traceability/containers/" + selectedContainer.container_unit_id + "/seal", {
        method: "POST",
        idempotencyKey: "wms-seal-" + crypto.randomUUID(),
        body: {},
      });
      await loadContainerDetail(selectedContainer.container_unit_id);
      await loadWorkspace();
      setNotice("Container sealed. Its packing contents are now closed to additions.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function dispatchContainer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !selectedContainer || selectedContainer.status !== "SEALED") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildDispatchPayload(dispatchDraft);
      const result = await request("/traceability/containers/" + selectedContainer.container_unit_id + "/dispatch", {
        method: "POST",
        idempotencyKey: "wms-dispatch-" + crypto.randomUUID(),
        body: payload,
      }) as { shipment?: { shipment_unit_id?: string; shipment_code?: string } };
      await loadWorkspace();
      await loadContainerDetail(selectedContainer.container_unit_id);
      if (result.shipment?.shipment_unit_id) {
        setSelectedShipmentId(result.shipment.shipment_unit_id);
        setTab("DELIVERY");
      }
      setNotice("Shipment dispatch recorded. The backend posted the stock issue, shipment identity and genealogy evidence in one transaction.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectOrder(orderId: string) {
    setDispatchDraft((current) => ({ ...current, order_id: orderId, order_line_id: "" }));
    setSelectedOrder(null);
    if (!orderId) return;
    try {
      const result = await request("/orders/" + orderId);
      const detail = result as FulfillmentOrderDetail;
      setSelectedOrder(detail);
      setDispatchDraft((current) => ({
        ...current,
        order_id: detail.id,
        order_line_id: "",
        customer_name: detail.customer_name ?? "",
        customer_order_reference: detail.customer_reference?.trim() || detail.order_number,
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function recordDeliveryEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || !selectedShipment) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = buildDeliveryEventPayload({
        ...deliveryDraft,
        previous_event_type: deliveryEvents.at(-1)?.event_type ?? null,
        tenant_id: snapshot?.tenant.id ?? "",
        factory_id: activeFactoryId,
        shipment_unit_id: selectedShipment.shipment_unit_id,
      });
      await request("/traceability/shipments/" + selectedShipment.shipment_unit_id + "/delivery-events", {
        method: "POST",
        idempotencyKey: "wms-delivery-" + crypto.randomUUID(),
        body: payload,
      });
      setDeliveryDraft((current) => ({
        ...current,
        event_type: "",
        event_at: "",
        recipient_name: "",
        proof_type: "",
        proof_reference: "",
        proof_sha256: "",
        signed_at: "",
        notes: "",
      }));
      await loadShipmentDetail(selectedShipment.shipment_unit_id);
      await loadWorkspace();
      setNotice("Delivery event appended to the shipment timeline. POD evidence is verified by the configured backend storage provider.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const sourceLotsForItem = useMemo(
    () => finishedLots.filter((unit) =>
      unit.inventory_item_id === selectedContainer?.item_id
      && unit.status.toUpperCase() === "ACTIVE"),
    [finishedLots, selectedContainer?.item_id],
  );
  const sealedCartonsForPallet = useMemo(
    () => cartonIdentities.filter((unit) =>
      unit.status.toUpperCase() === "ACTIVE" || unit.status.toUpperCase() === "SHIPPED"),
    [cartonIdentities],
  );
  const latestDeliveryEvent = deliveryEvents.at(-1)?.event_type ?? null;
  const nextDeliveryEvents = allowedNextDeliveryEvents(latestDeliveryEvent);
  const deliveryChoices = nextDeliveryEvents.length ? nextDeliveryEvents : [];
  const currentContainerPercent = selectedContainer && Number(selectedContainer.capacity_quantity) > 0
    ? Math.min(100, Math.max(0, Number(selectedContainer.packed_quantity) / Number(selectedContainer.capacity_quantity) * 100))
    : 0;
  const orderReferenceHint = selectedOrder
    ? "Bound to " + selectedOrder.order_number + "; customer, reference, SKU, UOM and outstanding line quantity are checked by the backend."
    : "External order reference is permitted. Select an internal order and line when available to enforce order-line quantity controls.";

  if (status !== "connected" || !activeFactoryId) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">WMS outbound fulfillment</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">Packing, dispatch & delivery</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">Connect an authenticated FactoryOS session and select an active factory to use carton/pallet packing, shipment dispatch and delivery evidence.</p>
          <a href="/session" className="mt-5 inline-flex min-h-10 items-center rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white">Open session setup</a>
        </div>
      </main>
    );
  }

  if (!canRead) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="rounded-3xl border border-amber-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Permission required</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-950">WMS fulfillment access is restricted</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">The authenticated account needs traceability.read for this factory. No tenant, factory or actor identifiers are accepted from this page.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">Warehouse management · outbound</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">Packing, dispatch & delivery</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Build CARTON and PALLET contents, seal packing units, dispatch against customer orders and append delivery/POD evidence to shipment timelines.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">Factory {shortId(activeFactoryId)}</span>
          <button type="button" onClick={() => { void refreshAll(); }} disabled={loading || busy} className={secondaryButton}>{loading ? "Refreshing…" : "Refresh registers"}</button>
        </div>
      </header>

      {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Packing identities" value={summary.containers} detail={summary.cartons + " cartons · " + summary.pallets + " pallets"} />
        <Metric label="Dispatched shipments" value={summary.shipments} detail="Immutable dispatch records" tone="blue" />
        <Metric label="Awaiting delivery update" value={summary.awaitingUpdate} detail="Dispatch exists; no delivery event yet" tone="amber" />
        <Metric label="In delivery network" value={summary.inTransit} detail="In transit or out for delivery" tone="blue" />
        <Metric label="Failed / returned" value={summary.deliveryFailed + summary.returned} detail={summary.deliveryFailed + " failed · " + summary.returned + " returned"} tone="rose" />
      </section>

      <nav aria-label="Fulfillment workbench sections" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {([
          ["PACKING", "Packing & container build"],
          ["SHIPMENTS", "Dispatch register"],
          ["DELIVERY", "Delivery & POD timeline"],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" onClick={() => setTab(value)} aria-pressed={tab === value}
            className={"min-h-10 rounded-xl px-4 text-xs font-semibold transition " + (tab === value ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100")}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "PACKING" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-950">Create packing container</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">Register an empty carton or pallet at an active pick-enabled BIN/STAGING location.</p>
                </div>
                <StatusPill value="OPEN" />
              </div>
              {!canWrite || !canInventoryRead ? (
                <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">traceability.write and inventory.read are required to register containers. Read-only traceability remains available.</p>
              ) : (
                <form onSubmit={createContainer} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Container type">
                    <select className={inputClass} value={containerDraft.container_type} onChange={(event) => setContainerDraft((current) => ({ ...current, container_type: event.target.value as ContainerType }))}>
                      <option value="CARTON">CARTON</option>
                      <option value="PALLET">PALLET</option>
                    </select>
                  </Field>
                  <Field label="Container code" hint="Unique identity code, max 160 characters.">
                    <input required maxLength={160} pattern="[A-Za-z0-9._:-]+" className={inputClass} value={containerDraft.container_code} onChange={(event) => setContainerDraft((current) => ({ ...current, container_code: event.target.value }))} placeholder="CARTON-0001" />
                  </Field>
                  <Field label="Inventory item">
                    <select required className={inputClass} value={containerDraft.item_id} onChange={(event) => setContainerDraft((current) => ({ ...current, item_id: event.target.value }))}>
                      <option value="">Select an active item</option>
                      {items.filter((item) => item.status.toUpperCase() === "ACTIVE").map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Packing location" hint="Backend accepts active, pick-enabled BIN or STAGING locations.">
                    <select required className={inputClass} value={containerDraft.location_id} onChange={(event) => setContainerDraft((current) => ({ ...current, location_id: event.target.value }))}>
                      <option value="">Select location</option>
                      {activePackingLocations.map((location) => <option key={location.id} value={location.id}>{location.location_code} · {location.name} ({location.location_type})</option>)}
                    </select>
                  </Field>
                  <Field label={"Container capacity (" + (selectedItem?.unit ?? "unit") + ")"} hint="Positive quantity; up to four decimal places.">
                    <input required inputMode="decimal" className={inputClass} value={containerDraft.capacity_quantity} onChange={(event) => setContainerDraft((current) => ({ ...current, capacity_quantity: event.target.value }))} placeholder="12.0000" />
                  </Field>
                  <div className="flex items-end">
                    <button type="submit" disabled={busy || !items.length || !activePackingLocations.length} className={primaryButton + " w-full"}>{busy ? "Registering…" : "Register container"}</button>
                  </div>
                </form>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-950">Container register</h2>
                  <p className="mt-1 text-xs text-slate-500">Select a CARTON or PALLET identity to open its packing record.</p>
                </div>
                <span className="text-xs tabular-nums text-slate-500">{visibleContainers.length} shown</span>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_150px]">
                <input className={inputClass} value={containersSearch} onChange={(event) => setContainersSearch(event.target.value)} placeholder="Search code, barcode or lifecycle…" />
                <select className={inputClass} value={containerTypeFilter} onChange={(event) => setContainerTypeFilter(event.target.value)}>
                  <option value="ALL">All types</option><option value="CARTON">Cartons</option><option value="PALLET">Pallets</option>
                </select>
              </div>
              <div className="mt-3 max-h-[560px] space-y-2 overflow-y-auto">
                {visibleContainers.map((identity) => (
                  <button type="button" key={identity.id} onClick={() => setSelectedContainerId(identity.id)}
                    className={"w-full rounded-xl border p-3 text-left transition " + (selectedContainerId === identity.id ? "border-blue-300 bg-blue-50/70 ring-1 ring-blue-100" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-bold text-slate-900">{identity.unit_code}</span>
                      <StatusPill value={identity.status} />
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">{identity.unit_type} · {identity.product_role} · {identity.inventory_sku || "Packing identity"}</p>
                    <p className="mt-1 font-mono text-[10px] text-slate-400">{shortId(identity.id)}</p>
                  </button>
                ))}
                {!visibleContainers.length ? <div className="rounded-xl border border-dashed border-slate-200 p-7 text-center text-xs text-slate-500">{loading ? "Loading container identities…" : "No CARTON or PALLET identities match these filters."}</div> : null}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-950">Packing detail & capacity</h2>
                  <p className="mt-1 text-xs text-slate-500">Content relationships are recorded as genealogy evidence; dispatch is a separate stock-issuing action.</p>
                </div>
                {selectedContainer ? <StatusPill value={selectedContainer.status} /> : null}
              </div>
              {loadingDetail ? <p className="mt-5 text-sm text-slate-500">Loading packing record…</p> : null}
              {!selectedContainer && !loadingDetail ? <div className="mt-5 rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">Select a container from the register.</div> : null}
              {selectedContainer ? (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold uppercase text-slate-500">Container</p><p className="mt-1 truncate text-sm font-bold">{selectedContainer.unit_code}</p><p className="text-[11px] text-slate-500">{selectedContainer.container_type}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold uppercase text-slate-500">Packed</p><p className="mt-1 text-sm font-bold tabular-nums">{amount(selectedContainer.packed_quantity, selectedContainer.unit)}</p><p className="text-[11px] text-slate-500">of {amount(selectedContainer.capacity_quantity, selectedContainer.unit)}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3"><p className="text-[10px] font-semibold uppercase text-slate-500">Remaining</p><p className="mt-1 text-sm font-bold tabular-nums">{amount(Math.max(0, Number(selectedContainer.capacity_quantity) - Number(selectedContainer.packed_quantity)), selectedContainer.unit)}</p><p className="text-[11px] text-slate-500">Unused capacity</p></div>
                  </div>
                  <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-blue-700 transition-all" style={{ width: currentContainerPercent + "%" }} /></div>
                  <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    <span>Item: {items.find((item) => item.id === selectedContainer.item_id)?.sku ?? shortId(selectedContainer.item_id)}</span>
                    <span>·</span><span>Location: {locations.find((location) => location.id === selectedContainer.location_id)?.location_code ?? shortId(selectedContainer.location_id)}</span>
                    <span>·</span><span>Sealed: {dateTime(selectedContainer.sealed_at)}</span>
                  </div>
                  <div className="mt-5">
                    <h3 className="text-xs font-bold text-slate-800">Recorded contents</h3>
                    <div className="mt-2 overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full min-w-[420px] text-left text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Source identity</th><th className="px-3 py-2">Quantity</th><th className="px-3 py-2">Identity</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedContainer.contents?.map((content) => <tr key={content.source_unit_id}><td className="px-3 py-3 font-semibold">{content.source_unit_code}</td><td className="px-3 py-3 tabular-nums">{amount(content.quantity, content.unit)}</td><td className="px-3 py-3 font-mono text-[10px] text-slate-500">{shortId(content.source_unit_id)}</td></tr>)}
                          {!selectedContainer.contents?.length ? <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-500">No contents recorded yet.</td></tr> : null}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {selectedContainer.status === "OPEN" && canWrite ? (
                    <form onSubmit={addPackingContent} className="mt-5 rounded-xl border border-blue-100 bg-blue-50/40 p-4">
                      <h3 className="text-sm font-bold text-slate-900">Add {selectedContainer.container_type === "CARTON" ? "finished-good LOT" : "sealed CARTON"}</h3>
                      <p className="mt-1 text-[11px] leading-5 text-slate-600">{selectedContainer.container_type === "CARTON" ? "Only active same-item finished-good LOTs are selectable. Backend checks quality holds, expiry and unreserved stock at this location." : "Only a whole sealed carton of the same item at the same location can be added to a pallet."}</p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Field label={selectedContainer.container_type === "CARTON" ? "Finished-good LOT" : "Sealed carton"}>
                          <select required className={inputClass} value={contentDraft.source_unit_id} onChange={(event) => {
                            if (selectedContainer.container_type === "PALLET") void loadPalletSourceCarton(event.target.value);
                            else setContentDraft((current) => ({ ...current, source_unit_id: event.target.value }));
                          }}>
                            <option value="">Select source identity</option>
                            {(selectedContainer.container_type === "CARTON" ? sourceLotsForItem : sealedCartonsForPallet).map((unit) => <option key={unit.id} value={unit.id}>{unit.unit_code} · {unit.unit_type} · {unit.status}</option>)}
                          </select>
                        </Field>
                        <Field label={"Quantity (" + selectedContainer.unit + ")"} hint={selectedContainer.container_type === "PALLET" ? "Whole carton quantity is filled from its sealed record." : "Backend checks available, unreserved quantity. Up to four decimals."}>
                          <input required readOnly={selectedContainer.container_type === "PALLET"} inputMode="decimal" className={inputClass} value={contentDraft.quantity} onChange={(event) => setContentDraft((current) => ({ ...current, quantity: event.target.value }))} placeholder="0.0000" />
                        </Field>
                      </div>
                      {selectedContainer.container_type === "PALLET" && selectedPalletCarton ? <p className="mt-2 text-[11px] text-slate-600">Carton {selectedPalletCarton.unit_code}: {selectedPalletCarton.status}, {amount(selectedPalletCarton.packed_quantity, selectedPalletCarton.unit)}. Source must be SEALED and match the pallet item/location.</p> : null}
                      <button type="submit" disabled={busy || !contentDraft.source_unit_id || !contentDraft.quantity} className={primaryButton + " mt-3 w-full"}>{busy ? "Recording…" : "Add packing content"}</button>
                    </form>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedContainer.status === "OPEN" && canWrite ? <button type="button" onClick={() => { void sealContainer(); }} disabled={busy || Number(selectedContainer.packed_quantity) <= 0} className={secondaryButton}>Seal non-empty container</button> : null}
                    {selectedContainer.status === "SEALED" && canWrite ? <button type="button" onClick={() => { setDispatchDraft({ shipment_code: "", customer_name: "", customer_order_reference: "", carrier_name: "", tracking_reference: "", order_id: "", order_line_id: "" }); setSelectedOrder(null); setTab("SHIPMENTS"); }} className={primaryButton}>Prepare dispatch</button> : null}
                    {selectedContainer.status === "DISPATCHED" ? <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">Dispatched {dateTime(selectedContainer.dispatched_at)}</span> : null}
                  </div>
                </>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {tab === "SHIPMENTS" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-base font-bold text-slate-950">Outbound dispatch register</h2><p className="mt-1 text-xs text-slate-500">Search shipment, customer, customer order reference or tracking reference.</p></div>
              <span className="text-xs text-slate-500">{visibleShipments.length} shown</span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_180px]">
              <input className={inputClass} value={shipmentSearch} onChange={(event) => setShipmentSearch(event.target.value)} placeholder="Search shipments…" />
              <select className={inputClass} value={shipmentEventFilter} onChange={(event) => setShipmentEventFilter(event.target.value)}>
                <option value="ALL">All updates</option><option value="DISPATCHED">Awaiting update</option><option value="IN_TRANSIT">In transit</option><option value="OUT_FOR_DELIVERY">Out for delivery</option><option value="DELIVERY_FAILED">Delivery failed</option><option value="DELIVERED">Delivered</option><option value="RETURNED">Returned</option>
              </select>
            </div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-3">Shipment</th><th className="px-3 py-3">Customer / order</th><th className="px-3 py-3">Container</th><th className="px-3 py-3">Quantity</th><th className="px-3 py-3">Latest delivery</th><th className="px-3 py-3">Dispatched</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleShipments.map((shipment) => <tr key={shipment.shipment_unit_id} className={selectedShipmentId === shipment.shipment_unit_id ? "bg-blue-50/60" : ""}>
                    <td className="px-3 py-3"><button type="button" onClick={() => { setSelectedShipmentId(shipment.shipment_unit_id); setTab("DELIVERY"); }} className="text-left font-bold text-blue-800 hover:underline">{shipment.shipment_code}</button><p className="mt-1 text-[10px] text-slate-500">{shipment.carrier_name || "No carrier"} · {shipment.tracking_reference || "No tracking"}</p></td>
                    <td className="px-3 py-3"><p className="font-semibold">{shipment.customer_name}</p><p className="mt-1 text-[10px] text-slate-500">{shipment.customer_order_reference}</p></td>
                    <td className="px-3 py-3">{shipment.container_code}</td>
                    <td className="px-3 py-3 tabular-nums">{amount(shipment.quantity, shipment.unit)}</td>
                    <td className="px-3 py-3"><StatusPill value={shipment.latest_delivery_event_type || "DISPATCHED"} /><p className="mt-1 text-[10px] text-slate-500">{dateTime(shipment.latest_delivery_event_at)}</p></td>
                    <td className="px-3 py-3 whitespace-nowrap">{dateTime(shipment.dispatched_at)}</td>
                  </tr>)}
                  {!visibleShipments.length ? <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-500">{loading ? "Loading shipments…" : "No shipments match the current search or filter."}</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-bold text-slate-950">Dispatch a sealed container</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">Dispatch is a stock-issuing operation. The backend verifies packed genealogy, active finished-good LOTs, quality holds, unreserved stock, and optional order-line quantity.</p>
              {selectedContainer?.status === "SEALED" && canWrite ? (
                <form onSubmit={dispatchContainer} className="mt-4 space-y-3">
                  <div className="rounded-xl bg-slate-50 p-3 text-xs"><p className="font-bold">{selectedContainer.unit_code}</p><p className="mt-1 text-slate-500">{selectedContainer.container_type} · {amount(selectedContainer.packed_quantity, selectedContainer.unit)} · Sealed {dateTime(selectedContainer.sealed_at)}</p></div>
                  {canOrdersRead ? (
                    <Field label="Internal customer order (optional)">
                      <select className={inputClass} value={dispatchDraft.order_id} onChange={(event) => { void selectOrder(event.target.value); }}>
                        <option value="">External order reference only</option>
                        {orders.filter((order) => ["CONFIRMED", "IN_PROGRESS", "COMPLETED"].includes(order.status)).map((order) => <option key={order.id} value={order.id}>{order.order_number} · {order.customer_name || "No customer"}</option>)}
                      </select>
                    </Field>
                  ) : <p className="rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">orders.read is not granted. Use the external customer order reference fields.</p>}
                  {selectedOrder ? (
                    <Field label="Order line">
                      <select required className={inputClass} value={dispatchDraft.order_line_id} onChange={(event) => setDispatchDraft((current) => ({ ...current, order_line_id: event.target.value }))}>
                        <option value="">Select matching order line</option>
                        {availableOrderLines.map((line) => <option key={line.id} value={line.id}>#{line.line_number} · {line.product_code} · {amount(line.quantity, line.unit)}</option>)}
                      </select>
                    </Field>
                  ) : null}
                  <Field label="Shipment code"><input required maxLength={160} pattern="[A-Za-z0-9._:-]+" className={inputClass} value={dispatchDraft.shipment_code} onChange={(event) => setDispatchDraft((current) => ({ ...current, shipment_code: event.target.value }))} placeholder="SHP-0001" /></Field>
                  <Field label="Customer name"><input required maxLength={255} className={inputClass} value={dispatchDraft.customer_name} onChange={(event) => setDispatchDraft((current) => ({ ...current, customer_name: event.target.value }))} placeholder="Customer name" /></Field>
                  <Field label="Customer order reference" hint={orderReferenceHint}><input required maxLength={160} className={inputClass} value={dispatchDraft.customer_order_reference} onChange={(event) => setDispatchDraft((current) => ({ ...current, customer_order_reference: event.target.value }))} placeholder="Customer PO / reference" /></Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Carrier (optional)"><input maxLength={255} className={inputClass} value={dispatchDraft.carrier_name} onChange={(event) => setDispatchDraft((current) => ({ ...current, carrier_name: event.target.value }))} placeholder="Carrier name" /></Field>
                    <Field label="Tracking reference (optional)"><input maxLength={255} className={inputClass} value={dispatchDraft.tracking_reference} onChange={(event) => setDispatchDraft((current) => ({ ...current, tracking_reference: event.target.value }))} placeholder="Tracking code" /></Field>
                  </div>
                  <button type="submit" disabled={busy || !dispatchDraft.shipment_code || !dispatchDraft.customer_name || !dispatchDraft.customer_order_reference || Boolean(selectedOrder && !dispatchDraft.order_line_id)} className={primaryButton + " w-full"}>{busy ? "Dispatching…" : "Confirm stock issue & dispatch"}</button>
                </form>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-slate-200 p-7 text-center text-xs leading-5 text-slate-500">Select an OPEN container, add contents and seal it before preparing a shipment dispatch. The dispatch form appears here when a SEALED container is selected.</div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {tab === "DELIVERY" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="text-base font-bold text-slate-950">Shipment delivery timeline</h2><p className="mt-1 text-xs text-slate-500">Choose a dispatch to inspect appended delivery events.</p></div>
              <span className="text-xs text-slate-500">{shipments.length} shipments</span>
            </div>
            <div className="mt-4 space-y-2">
              {shipments.map((shipment) => <button key={shipment.shipment_unit_id} type="button" onClick={() => setSelectedShipmentId(shipment.shipment_unit_id)}
                className={"w-full rounded-xl border p-3 text-left " + (selectedShipmentId === shipment.shipment_unit_id ? "border-blue-300 bg-blue-50/70" : "border-slate-200 hover:bg-slate-50")}>
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-bold">{shipment.shipment_code}</span><StatusPill value={shipment.latest_delivery_event_type || "DISPATCHED"} /></div>
                <p className="mt-1 text-xs text-slate-600">{shipment.customer_name} · {shipment.customer_order_reference}</p>
                <p className="mt-1 text-[10px] text-slate-500">{shipment.carrier_name || "No carrier"} · {shipment.tracking_reference || "No tracking reference"}</p>
              </button>)}
              {!shipments.length ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">No dispatched shipments yet.</div> : null}
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-base font-bold text-slate-950">Delivery event register</h2><p className="mt-1 text-xs text-slate-500">Append-only timeline; invalid state transitions are unavailable.</p></div>
                {selectedShipment ? <StatusPill value={latestDeliveryEvent || "DISPATCHED"} /> : null}
              </div>
              {selectedShipment ? <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs"><p className="font-bold">{selectedShipment.shipment_code} · {selectedShipment.customer_name}</p><p className="mt-1 text-slate-500">{selectedShipment.customer_order_reference} · {amount(selectedShipment.quantity, selectedShipment.unit)}</p></div> : null}
              {loadingDelivery ? <p className="mt-4 text-xs text-slate-500">Loading delivery events…</p> : null}
              <div className="mt-4 space-y-3">
                {deliveryEvents.map((deliveryEvent, index) => <article key={deliveryEvent.id} className="relative rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill value={deliveryEvent.event_type} /><span className="text-[10px] text-slate-500">{dateTime(deliveryEvent.event_at)}</span></div>
                  {deliveryEvent.recipient_name ? <p className="mt-2 text-xs font-semibold">Recipient: {deliveryEvent.recipient_name}</p> : null}
                  {deliveryEvent.proof_type ? <p className="mt-1 break-all text-[11px] text-slate-600">POD: {deliveryEvent.proof_type} · {deliveryEvent.proof_reference}</p> : null}
                  {deliveryEvent.proof_sha256 ? <p className="mt-1 break-all font-mono text-[10px] text-slate-400">SHA-256 {deliveryEvent.proof_sha256}</p> : null}
                  {deliveryEvent.notes ? <p className="mt-2 text-xs text-slate-600">{deliveryEvent.notes}</p> : null}
                  <p className="mt-2 text-[10px] text-slate-400">Recorded by {shortId(deliveryEvent.recorded_by_user_id)} · event {index + 1}</p>
                </article>)}
                {!deliveryEvents.length && !loadingDelivery ? <div className="rounded-xl border border-dashed border-slate-200 p-7 text-center text-xs text-slate-500">{selectedShipment ? "No delivery event has been recorded for this shipment yet." : "Select a shipment to see its timeline."}</div> : null}
              </div>
            </div>

            {selectedShipment && canWrite && deliveryChoices.length ? (
              <form onSubmit={recordDeliveryEvent} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-base font-bold text-slate-950">Append delivery update</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">Events are manual operator submissions. The backend enforces the shipment event state machine and immutable audit history.</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Next delivery event">
                    <select required className={inputClass} value={deliveryDraft.event_type} onChange={(event) => setDeliveryDraft((current) => ({ ...current, event_type: event.target.value as DeliveryEventType | "" }))}>
                      <option value="">Choose next event</option>
                      {deliveryChoices.map((eventType) => <option key={eventType} value={eventType}>{fulfillmentStatusLabel(eventType)}</option>)}
                    </select>
                  </Field>
                  <Field label="Event time (optional)">
                    <input type="datetime-local" className={inputClass} value={deliveryDraft.event_at} onChange={(event) => setDeliveryDraft((current) => ({ ...current, event_at: event.target.value }))} />
                  </Field>
                </div>
                {deliveryDraft.event_type === "DELIVERED" ? (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                    <h3 className="text-xs font-bold text-amber-950">Proof-of-delivery evidence required</h3>
                    <p className="mt-1 text-[11px] leading-5 text-amber-900">Only an already-uploaded object key for this shipment is accepted. URLs are not accepted. The API verifies the stored object digest; delivery is not recorded if storage verification is unavailable or the digest does not match.</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Recipient name"><input required maxLength={255} className={inputClass} value={deliveryDraft.recipient_name} onChange={(event) => setDeliveryDraft((current) => ({ ...current, recipient_name: event.target.value }))} /></Field>
                      <Field label="Proof type">
                        <select required className={inputClass} value={deliveryDraft.proof_type} onChange={(event) => setDeliveryDraft((current) => ({ ...current, proof_type: event.target.value }))}>
                          <option value="">Choose proof type</option><option value="SIGNATURE">Signature</option><option value="PHOTO">Photo</option><option value="DOCUMENT">Document</option><option value="OTP">OTP</option><option value="CUSTOMER_ACKNOWLEDGEMENT">Customer acknowledgement</option>
                        </select>
                      </Field>
                      <Field label="Uploaded POD object key" hint={"Required prefix: pod/" + (snapshot?.tenant.id ?? "tenant-id") + "/" + activeFactoryId + "/" + selectedShipment.shipment_unit_id + "/"}>
                        <input required maxLength={500} className={inputClass} value={deliveryDraft.proof_reference} onChange={(event) => setDeliveryDraft((current) => ({ ...current, proof_reference: event.target.value }))} placeholder="pod/tenant/factory/shipment/object" />
                      </Field>
                      <Field label="Stored object SHA-256">
                        <input required maxLength={64} minLength={64} pattern="[A-Fa-f0-9]{64}" className={inputClass + " font-mono"} value={deliveryDraft.proof_sha256} onChange={(event) => setDeliveryDraft((current) => ({ ...current, proof_sha256: event.target.value }))} placeholder="64 hexadecimal characters" />
                      </Field>
                      <Field label="Signed at"><input required type="datetime-local" className={inputClass} value={deliveryDraft.signed_at} onChange={(event) => setDeliveryDraft((current) => ({ ...current, signed_at: event.target.value }))} /></Field>
                    </div>
                  </div>
                ) : null}
                <Field label="Notes" hint="Maximum 2,000 characters.">
                  <textarea maxLength={2000} rows={3} className={inputClass + " py-2"} value={deliveryDraft.notes} onChange={(event) => setDeliveryDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Carrier status, exception or receiving context…" />
                </Field>
                <button type="submit" disabled={busy || !deliveryDraft.event_type} className={primaryButton + " mt-3 w-full"}>{busy ? "Recording…" : "Append delivery event"}</button>
              </form>
            ) : null}
            {selectedShipment && !canWrite ? <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">Read-only delivery timeline. traceability.write is required to append events.</p> : null}
            {selectedShipment && !deliveryChoices.length ? <p className="rounded-xl bg-slate-100 p-3 text-xs text-slate-600">This shipment is terminal ({fulfillmentStatusLabel(latestDeliveryEvent)}). No further delivery events can be added.</p> : null}
          </section>
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-700 sm:p-5">
        <h2 className="font-bold text-slate-900">Operational controls & evidence boundaries</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Every API call uses the shared authenticated session and selected active factory. The browser does not accept caller-supplied tenant, factory, actor or bearer-token values.</li>
          <li>Container creation, content addition, sealing, dispatch and delivery events use unique Idempotency-Key values. The API remains authoritative for transaction locking, inventory, quality holds, order-line limits, and lifecycle state.</li>
          <li>Adding packing contents records genealogy; it does not reduce stock. Dispatch creates the stock issue and shipment evidence atomically.</li>
          <li>Proof-of-delivery metadata is not a file upload. The referenced object must already exist in the configured shipment-scoped storage path, and the backend must verify its bytes and digest before accepting DELIVERED.</li>
          <li>Delivery events entered here are manual operator evidence; this page does not claim carrier webhook integration, external recipient authentication or message delivery.</li>
        </ul>
      </section>
    </main>
  );
}
