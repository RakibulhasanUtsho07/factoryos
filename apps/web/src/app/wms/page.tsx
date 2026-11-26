
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import {
  WmsOfflineQueue,
  createWmsOfflineSyncTransport,
} from "@/lib/wms-offline-queue.mjs";

import {
  WmsLabelRenderError,
  createWmsLabelScanResolver,
  renderWmsLabel,
} from "@/lib/wms-label-renderer.mjs";

function subscribeToOnlineStatus(callback: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);

  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineStatus() {
  return typeof navigator === "undefined"
    ? true
    : navigator.onLine;
}

type RenderedLabel = {
  symbology: string;
  encoded_value: string;
  copies: number;
  status: string;
  width_mm: number;
  height_mm: number;
  svg: string;
  print_html: string;
  svg_data_uri: string;
};

type LabelScanResult = {
  identity_type: "TRACEABILITY_UNIT" | "MATERIAL";
  identity: Record<string, unknown>;
};

type QueuedEntry = {
  transactionId: string;
  status: string;
  payload: {
    client_transaction_id: string;
    item_id: string;
    movement_type: "RECEIPT" | "ISSUE";
    quantity: number;
    expected_balance_version: string;
    operation: "STOCK_MOVEMENT";
  };
  attemptCount: number;
  queuedAt: string;
  nextRetryAt: number;
  lastError: string | null;
  receiptId: string | null;
  resolvedByTransactionId: string | null;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const initialLabelIssue = JSON.stringify(
  {
    symbology: "QR",
    barcode_value: "DEMO-LOT-0001",
    copy_count: 1,
    label_layout: {
      page: {
        width_mm: 50,
        height_mm: 30,
      },
      fields: [
        "unit_code",
        "barcode_value",
        "product_role",
        "status",
      ],
    },
    encoded_payload: {
      schema: "factoryos.traceability-label/v1",
      identity_type: "TRACEABILITY_UNIT",
      unit_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      unit_code: "DEMO-LOT-0001",
      barcode_value: "DEMO-LOT-0001",
      product_role: "FINISHED_GOOD",
      status: "ACTIVE",
    },
  },
  null,
  2,
);

export default function WmsMobileAcceptancePage() {
  const [tenantId, setTenantId] = useState("");
  const [factoryId, setFactoryId] = useState("");
  const [userId, setUserId] = useState("");
  const [deviceId, setDeviceId] = useState("WMS-HH-01");

  const [apiOrigin, setApiOrigin] = useState(
    process.env.NEXT_PUBLIC_FACTORYOS_API_URL ?? "",
  );

  const [accessToken, setAccessToken] = useState("");

  const [itemId, setItemId] = useState("");
  const [movementType, setMovementType] =
    useState<"RECEIPT" | "ISSUE">("ISSUE");

  const [quantity, setQuantity] = useState("1");
  const [expectedVersion, setExpectedVersion] = useState("1");

  const [entries, setEntries] = useState<QueuedEntry[]>([]);

  const [queueMessage, setQueueMessage] = useState(
    "Enter your authenticated scope and API origin to load the durable queue.",
  );

  const [queueError, setQueueError] = useState("");
  const [lastSync, setLastSync] = useState("");

  const [resolvingVersion, setResolvingVersion] =
    useState<Record<string, string>>({});

  const [labelIssueJson, setLabelIssueJson] =
    useState(initialLabelIssue);

  const [currentIdentityJson, setCurrentIdentityJson] =
    useState("");

  const [renderedLabel, setRenderedLabel] =
    useState<RenderedLabel | null>(null);

  const [labelError, setLabelError] = useState("");

  const [scanCode, setScanCode] = useState("");

  const [scanResult, setScanResult] =
    useState<LabelScanResult | null>(null);

  const [scanError, setScanError] = useState("");

  const [busy, setBusy] = useState(false);

  const online = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineStatus,
    () => true,
  );

  const queueRef =
    useRef<InstanceType<typeof WmsOfflineQueue> | null>(null);

  const labelFrameRef = useRef<HTMLIFrameElement | null>(null);

  const scope = useMemo(
    () => ({
      tenantId,
      factoryId,
      userId,
      deviceId,
    }),
    [tenantId, factoryId, userId, deviceId],
  );

  const scopeReady =
    uuidPattern.test(tenantId.trim()) &&
    uuidPattern.test(factoryId.trim()) &&
    uuidPattern.test(userId.trim()) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      deviceId.trim(),
    );

  const getQueue = useCallback(() => {
    if (!queueRef.current) {
      queueRef.current = new WmsOfflineQueue();
    }

    return queueRef.current;
  }, []);

  const apiUrl = useCallback(
    (path: string) => {
      const origin = apiOrigin.trim();

      if (!origin) {
        throw new Error(
          "Set the API origin first, for example http://localhost:3001.",
        );
      }

      return new URL(
        path,
        origin.endsWith("/") ? origin : origin + "/",
      ).toString();
    },
    [apiOrigin],
  );

  /*
   * Attach requested tenant and factory context to API calls.
   * The backend remains responsible for validating access and permissions.
   */
  const scopedFetch = useCallback(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      const requestedTenantId = tenantId.trim();
      const requestedFactoryId = factoryId.trim();

      if (requestedTenantId) {
        headers.set("X-Tenant-Id", requestedTenantId);
      }

      if (requestedFactoryId) {
        headers.set("X-Factory-Id", requestedFactoryId);
      }

      return fetch(input, {
        ...init,
        headers,
      });
    },
    [tenantId, factoryId],
  );

  /*
   * Correct backend route:
   * Global prefix: /api
   * Controller: wms/mobile
   * Route: offline-sync/batches
   */
  const transport = useCallback(
    () =>
      createWmsOfflineSyncTransport({
        endpoint: apiUrl(
          "/api/wms/mobile/offline-sync/batches",
        ),

        getAccessToken: () =>
          accessToken.trim() || undefined,

        fetchImpl: scopedFetch,
      }),
    [apiUrl, accessToken, scopedFetch],
  );

  /*
   * Restore only the local IndexedDB queue.
   * This function never sends stock transactions to the API.
   */
  const refreshQueue = useCallback(async () => {
    if (!scopeReady) {
      setEntries([]);

      setQueueMessage(
        "Queue not restored: enter valid tenant, factory, user UUIDs and device ID.",
      );

      setQueueError(
        "Local queue scope is incomplete or invalid.",
      );

      return;
    }

    setQueueMessage(
      "Checking this browser's IndexedDB queue...",
    );

    setQueueError("");

    try {
      const list = await getQueue().list(scope);

      setEntries(list as QueuedEntry[]);

      setQueueMessage(
        list.length > 0
          ? "Queue restored from this browser's durable IndexedDB store."
          : "No queued operations for this scope. Local queue is ready.",
      );

      setQueueError("");
    } catch (error) {
      setQueueMessage(
        "Could not restore the local queue.",
      );

      setQueueError(
        error instanceof Error
          ? error.message
          : "Could not load offline queue.",
      );
    }
  }, [scope, scopeReady, getQueue]);

  /*
   * Manual sync only.
   *
   * This function runs only when the user presses
   * the Sync queue now button.
   */
  const flushQueue = useCallback(async () => {
    if (!scopeReady) {
      setQueueError(
        "Enter valid tenant, factory, user UUIDs and device ID before syncing.",
      );

      return;
    }

    if (!apiOrigin.trim()) {
      setQueueError("Enter the API origin before syncing.");
      return;
    }

    if (!navigator.onLine) {
      setQueueMessage(
        "Device is offline. Queued transactions are kept locally.",
      );

      return;
    }

    try {
      setBusy(true);
      setQueueError("");

      const result = await getQueue().flush(
        scope,
        transport(),
      );

      setLastSync(
        JSON.stringify(result, null, 2),
      );

      setQueueMessage(
        "Sent " +
          result.sentCount +
          "; APPLIED receipt-confirmed and removed " +
          result.syncedCount +
          "; conflict " +
          result.conflictCount +
          "; rejected " +
          result.rejectedCount +
          "; pending " +
          result.pendingCount +
          ".",
      );

      await refreshQueue();

      /*
       * Deliberately no automatic timer retry.
       * Pending transactions remain in IndexedDB until
       * the user explicitly starts another sync.
       */
      if (result.transportError) {
        setQueueError(
          "Sync failed safely; local queue was retained: " +
            result.transportError,
        );
      }
    } catch (error) {
      setQueueError(
        error instanceof Error
          ? error.message
          : "Offline sync failed.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    scope,
    scopeReady,
    apiOrigin,
    transport,
    refreshQueue,
    getQueue,
  ]);

  /*
   * Refresh the local queue when the page loads or
   * when network connectivity changes.
   *
   * Connectivity restoration does not trigger a sync.
   */
  useEffect(() => {
    queueMicrotask(() => {
      void refreshQueue();
    });

    const onOnline = () => {
      setQueueMessage(
        "Connection restored. Review the local queue before syncing.",
      );

      void refreshQueue();
    };

    const onOffline = () => {
      setQueueMessage(
        "Device is offline. New operations remain in IndexedDB until the API is reachable.",
      );
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refreshQueue]);

  /*
   * Save a stock movement to IndexedDB.
   * This does not apply a stock movement on the server.
   */
  async function enqueueMovement(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    try {
      setQueueError("");

      const transaction = {
        client_transaction_id: crypto.randomUUID(),
        operation: "STOCK_MOVEMENT",
        item_id: itemId.trim().toLowerCase(),
        movement_type: movementType,
        quantity: Number(quantity),
        expected_balance_version: expectedVersion.trim(),
        notes: "WMS mobile offline stock movement",
      };

      await getQueue().enqueue(scope, transaction);

      setQueueMessage(
        "Saved to durable local queue. No stock is considered committed until a server receipt confirms it.",
      );

      await refreshQueue();
    } catch (error) {
      setQueueError(
        error instanceof Error
          ? error.message
          : "Could not enqueue stock movement.",
      );
    }
  }

  /*
   * Resolve a server-confirmed CONFLICT or REJECTED entry.
   * The replacement receives a new transaction ID.
   */
  async function resolveEntry(entry: QueuedEntry) {
    const version = (
      resolvingVersion[entry.transactionId] ?? ""
    ).trim();

    if (!version) {
      setQueueError(
        "Enter the current balance version before resolving a conflict.",
      );

      return;
    }

    try {
      const replacement = {
        ...entry.payload,
        client_transaction_id: crypto.randomUUID(),
        expected_balance_version: version,
      };

      const result = await getQueue().resolveConflict(
        scope,
        entry.transactionId,
        replacement,
      );

      setQueueMessage(
        "Resolution queued with new transaction ID " +
          result.replacement.transactionId +
          "; original receipt/history is retained.",
      );

      setQueueError("");

      await refreshQueue();
    } catch (error) {
      setQueueError(
        error instanceof Error
          ? error.message
          : "Conflict resolution failed.",
      );
    }
  }

  /*
   * Render a label from the persisted label issue JSON.
   */
  function renderLabel() {
    try {
      const issue = JSON.parse(labelIssueJson);

      const current = currentIdentityJson.trim()
        ? JSON.parse(currentIdentityJson)
        : undefined;

      setRenderedLabel(
        renderWmsLabel(issue, {
          currentIdentity: current,
        }),
      );

      setLabelError("");
    } catch (error) {
      setRenderedLabel(null);

      setLabelError(
        error instanceof WmsLabelRenderError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Label JSON could not be rendered.",
      );
    }
  }

  /*
   * Print only after a valid label preview exists.
   */
  function printLabel() {
    const frame = labelFrameRef.current;

    if (!frame?.contentWindow) {
      setLabelError(
        "Render a valid label before printing.",
      );

      return;
    }

    frame.contentWindow.focus();
    frame.contentWindow.print();
  }

  /*
   * Resolve a scanned barcode or QR code.
   */
  async function resolveScan(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    try {
      setScanError("");
      setScanResult(null);

      if (!scopeReady) {
        throw new Error(
          "Enter valid tenant, factory, user UUIDs and device ID before scanning.",
        );
      }

      const resolver = createWmsLabelScanResolver({
        endpoint: apiUrl(
          "/api/traceability/labels/resolve",
        ),

        getAccessToken: () =>
          accessToken.trim() || undefined,

        fetchImpl: scopedFetch,
      });

      const result = await resolver(scanCode);

      setScanResult(result);
    } catch (error) {
      setScanError(
        error instanceof WmsLabelRenderError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Label lookup failed.",
      );
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 text-zinc-900 md:px-8">
      {/* PAGE HEADER */}
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
            FactoryOS · WP02
          </p>

          <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">
            Mobile warehouse & label workbench
          </h1>

          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
            Offline-first queue, receipt-controlled cleanup,
            barcode/QR rendering, and factory-scoped scan lookup.
          </p>
        </div>

        <span
          className={
            "rounded-full px-3 py-1 text-sm font-semibold " +
            (online
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-900")
          }
        >
          {online ? "Online" : "Offline"}
        </span>
      </header>

      {/* CONNECTION AND SCOPE */}
      <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">
          Connection & local scope
        </h2>

        <p className="mt-1 text-sm text-zinc-600">
          Scope values partition local browser data only;
          server authorization still comes from the
          authenticated session. API origin must be the
          origin only, e.g. http://localhost:3001.
          The optional bearer token remains in memory
          and is never stored in IndexedDB.
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm font-medium">
            API origin

            <input
              value={apiOrigin}
              onChange={(e) => setApiOrigin(e.target.value)}
              placeholder="http://localhost:3001"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
            />
          </label>

          <label className="text-sm font-medium">
            Bearer token (optional when cookie auth is used)

            <input
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
            />
          </label>

          <label className="text-sm font-medium">
            Tenant UUID

            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="tenant UUID"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
            />
          </label>

          <label className="text-sm font-medium">
            Factory UUID

            <input
              value={factoryId}
              onChange={(e) => setFactoryId(e.target.value)}
              placeholder="factory UUID"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
            />
          </label>

          <label className="text-sm font-medium">
            Authenticated user UUID (local partition)

            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="user UUID"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
            />
          </label>

          <label className="text-sm font-medium">
            Warehouse device ID

            <input
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              placeholder="WMS-HH-01"
              className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void refreshQueue()}
            disabled={!scopeReady}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Restore local queue
          </button>

          <button
            type="button"
            onClick={() => void flushQueue()}
            disabled={
              busy ||
              !scopeReady ||
              !apiOrigin.trim() ||
              !online
            }
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Syncing…" : "Sync queue now"}
          </button>
        </div>

        <p
          role="status"
          aria-live="polite"
          className="mt-3 text-sm text-zinc-700"
        >
          {queueMessage}
        </p>

        {queueError && (
          <p
            role="alert"
            className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {queueError}
          </p>
        )}

        {lastSync && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold">
              Last sync receipt summary
            </summary>

            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
              {lastSync}
            </pre>
          </details>
        )}
      </section>

      {/* MAIN WORKBENCH */}
      <div className="grid items-start gap-8 lg:grid-cols-2">
        {/* STOCK MOVEMENT QUEUE */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">
            1. Queue a stock movement
          </h2>

          <p className="mt-1 text-sm text-zinc-600">
            The queue persists before network access.
            Only a matching APPLIED response with a
            valid transaction receipt allows automatic
            cleanup.
          </p>

          <form
            onSubmit={enqueueMovement}
            className="mt-4 space-y-3"
          >
            <label className="block text-sm font-medium">
              Inventory item UUID

              <input
                required
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                placeholder="inventory item UUID"
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm font-medium">
                Movement

                <select
                  value={movementType}
                  onChange={(e) =>
                    setMovementType(
                      e.target.value as "RECEIPT" | "ISSUE",
                    )
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
                >
                  <option value="ISSUE">ISSUE / pick</option>
                  <option value="RECEIPT">RECEIPT</option>
                </select>
              </label>

              <label className="text-sm font-medium">
                Quantity

                <input
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  required
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
                />
              </label>
            </div>

            <label className="block text-sm font-medium">
              Expected balance version

              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{1,19}"
                required
                value={expectedVersion}
                onChange={(e) =>
                  setExpectedVersion(e.target.value)
                }
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal"
              />
            </label>

            <button
              disabled={!scopeReady || busy}
              className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save transaction locally
            </button>
          </form>

          {/* DURABLE QUEUE */}
          <div className="mt-5 border-t border-zinc-200 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">
                Durable queue
              </h3>

              <span className="text-xs text-zinc-500">
                {entries.length} record(s)
              </span>
            </div>

            <div className="mt-3 space-y-3">
              {entries.length === 0 && (
                <p className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-600">
                  No records loaded for this scope.
                </p>
              )}

              {entries.map((entry) => (
                <article
                  key={entry.transactionId}
                  className="rounded-xl border border-zinc-200 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs">
                      {entry.transactionId}
                    </span>

                    <span
                      className={
                        "rounded-full px-2 py-1 text-xs font-semibold " +
                        (
                          entry.status === "PENDING"
                            ? "bg-blue-100 text-blue-800"
                            : entry.status === "CONFLICT" ||
                                entry.status === "REJECTED"
                              ? "bg-amber-100 text-amber-900"
                              : "bg-zinc-100 text-zinc-700"
                        )
                      }
                    >
                      {entry.status}
                    </span>
                  </div>

                  <p className="mt-2 text-sm">
                    {entry.payload.movement_type}{" "}
                    {entry.payload.quantity} · balance version{" "}
                    {entry.payload.expected_balance_version} ·
                    attempts {entry.attemptCount}
                  </p>

                  {entry.receiptId && (
                    <p className="mt-1 break-all text-xs text-zinc-500">
                      Server receipt: {entry.receiptId}
                    </p>
                  )}

                  {entry.lastError && (
                    <p className="mt-1 text-xs text-amber-800">
                      {entry.lastError}
                    </p>
                  )}

                  {(entry.status === "CONFLICT" ||
                    entry.status === "REJECTED") && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <input
                        aria-label={
                          "New balance version for " +
                          entry.transactionId
                        }
                        value={
                          resolvingVersion[entry.transactionId] ?? ""
                        }
                        onChange={(e) =>
                          setResolvingVersion((current) => ({
                            ...current,
                            [entry.transactionId]: e.target.value,
                          }))
                        }
                        placeholder="current balance version"
                        className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                      />

                      <button
                        type="button"
                        onClick={() => void resolveEntry(entry)}
                        disabled={busy}
                        className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Resolve as new transaction
                      </button>
                    </div>
                  )}

                  {entry.status === "RESOLVED" &&
                    entry.resolvedByTransactionId && (
                      <p className="mt-1 break-all text-xs text-zinc-500">
                        Replaced by:{" "}
                        {entry.resolvedByTransactionId}
                      </p>
                    )}
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* LABEL RENDERING */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">
            2. Render and print a label
          </h2>

          <p className="mt-1 text-sm text-zinc-600">
            Paste the persisted response from POST
            /traceability/labels/issue. The renderer validates
            the issued value and lifecycle snapshot. Demo
            content is only for checking preview.
          </p>

          <label className="mt-4 block text-sm font-medium">
            Label issue JSON

            <textarea
              value={labelIssueJson}
              onChange={(e) => setLabelIssueJson(e.target.value)}
              rows={12}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-zinc-300 p-3 font-mono text-xs"
            />
          </label>

          <label className="mt-3 block text-sm font-medium">
            Optional latest identity JSON to detect a stale
            label snapshot

            <textarea
              value={currentIdentityJson}
              onChange={(e) =>
                setCurrentIdentityJson(e.target.value)
              }
              rows={4}
              spellCheck={false}
              placeholder='{"id":"...","unit_code":"...","status":"RECALLED"}'
              className="mt-1 w-full rounded-lg border border-zinc-300 p-3 font-mono text-xs"
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={renderLabel}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white"
            >
              Render SVG
            </button>

            <button
              type="button"
              onClick={printLabel}
              disabled={!renderedLabel}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              Print labels
            </button>
          </div>

          {labelError && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              {labelError}
            </p>
          )}

          {renderedLabel && (
            <div className="mt-4 rounded-xl border border-zinc-200 p-3">
              <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-zinc-600">
                <span>
                  {renderedLabel.symbology} ·{" "}
                  {renderedLabel.width_mm} ×{" "}
                  {renderedLabel.height_mm} mm
                </span>

                <span>
                  {renderedLabel.copies} copy/copies ·{" "}
                  {renderedLabel.status}
                </span>
              </div>

              <iframe
                ref={labelFrameRef}
                title="Rendered WMS label print preview"
                srcDoc={renderedLabel.print_html}
                sandbox="allow-same-origin allow-modals"
                className="h-72 w-full rounded-lg border border-zinc-200 bg-white"
              />
            </div>
          )}

          <p className="mt-3 text-xs leading-5 text-zinc-500">
            This workbench emits browser SVG/HTML print
            payloads. Actual printer, scanner, label stock,
            and device compatibility must be validated on
            the target warehouse hardware.
          </p>
        </section>
      </div>

      {/* BARCODE / QR SCAN */}
      <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">
          3. Scan or resolve a barcode/QR value
        </h2>

        <p className="mt-1 text-sm text-zinc-600">
          Focus the field and scan with a keyboard-wedge
          scanner, or paste text produced by a camera
          scanner adapter. The lookup uses authenticated
          factory scope and rejects blank, unknown, or
          ambiguous codes.
        </p>

        <form
          onSubmit={resolveScan}
          className="mt-4 flex flex-col gap-3 sm:flex-row"
        >
          <input
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            autoComplete="off"
            placeholder="Scan code here…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2"
          />

          <button
            disabled={!apiOrigin.trim() || !scopeReady}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Resolve code
          </button>
        </form>

        {scanError && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {scanError}
          </p>
        )}

        {scanResult && (
          <pre className="mt-3 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
            {JSON.stringify(scanResult, null, 2)}
          </pre>
        )}
      </section>

      {/* FOOTER */}
      <footer className="mt-8 rounded-xl bg-zinc-100 p-4 text-sm leading-6 text-zinc-700">
        Queue guarantees here are client-side: IndexedDB
        survives browser reloads on the same origin, not
        browser-data deletion or device loss. APPLIED cleanup
        requires a valid server receipt and matching
        operation. CONFLICT and REJECTED entries remain
        available for review. Physical printer, scanner/camera,
        label stock, damaged-label, and device reconnect
        acceptance must be executed on the target warehouse
        hardware before production sign-off.
      </footer>
    </main>
  );
}
