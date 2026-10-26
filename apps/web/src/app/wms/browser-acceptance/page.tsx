"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IndexedDbWmsQueueStore, WmsOfflineQueue } from "@/lib/wms-offline-queue.mjs";

type QueueEntry = {
  transactionId: string;
  status: string;
  payload: { client_transaction_id: string; item_id: string; movement_type: "RECEIPT" | "ISSUE"; quantity: number; expected_balance_version: string };
  attemptCount: number;
  nextRetryAt: number;
  lastError: string | null;
  receiptId: string | null;
};
type Batch = { device_id: string; transactions: Array<{ client_transaction_id: string; operation: "STOCK_MOVEMENT" }> };
type SendResult = { client_transaction_id: string; receipt_id: string; operation: "STOCK_MOVEMENT"; status: "APPLIED"; replayed: boolean };

const TENANT_ID = "a1000000-0000-4000-8000-000000000001";
const FACTORY_ID = "a2000000-0000-4000-8000-000000000002";
const USER_ID = "a3000000-0000-4000-8000-000000000003";
const ITEM_ID = "a4000000-0000-4000-8000-000000000004";
const RECEIPT_ID = "a5000000-0000-4000-8000-000000000005";
const RUN_PATTERN = /^[A-Za-z0-9_-]{8,48}$/;

function uuid() {
  return globalThis.crypto.randomUUID();
}
function safeRunId(value: string | null) {
  return value && RUN_PATTERN.test(value) ? value : uuid().replace(/-/g, "").slice(0, 20);
}

export default function WmsBrowserAcceptancePage() {
  const [runId, setRunId] = useState("");
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [primaryState, setPrimaryState] = useState("Not started");
  const [competingState, setCompetingState] = useState("Not run");
  const [refreshing, setRefreshing] = useState(false);
  const primaryResolver = useRef<((response: { results: SendResult[] }) => void) | null>(null);
  const primaryBatch = useRef<Batch | null>(null);
  const primaryPromise = useRef<Promise<unknown> | null>(null);

  const databaseName = useMemo(() => "factoryos-wms-hil-" + runId, [runId]);
  const markerKey = useMemo(() => "factoryos-wms-hil-" + runId + "-primary-claim", [runId]);
  const channelName = useMemo(() => "factoryos-wms-hil-" + runId, [runId]);
  const scope = useMemo(() => ({
    tenantId: TENANT_ID,
    factoryId: FACTORY_ID,
    userId: USER_ID,
    deviceId: "WMS-HIL-" + runId,
  }), [runId]);

  const queue = useCallback(() => {
    if (!runId || typeof window === "undefined" || !window.indexedDB) {
      throw new Error("A modern browser with IndexedDB is required.");
    }
    return new WmsOfflineQueue({ store: new IndexedDbWmsQueueStore(window.indexedDB, databaseName) });
  }, [databaseName, runId]);

  const record = useCallback((message: string) => {
    setEvents((previous) => [
      new Date().toISOString() + " — " + message,
      ...previous,
    ].slice(0, 30));
  }, []);

  const refreshEntries = useCallback(async () => {
    if (!runId) return;
    setRefreshing(true);
    try {
      const current = await queue().list(scope) as unknown as QueueEntry[];
      setEntries(current);
    } catch (error) {
      record("Queue inspection failed: " + (error instanceof Error ? error.message : "unknown error"));
    } finally {
      setRefreshing(false);
    }
  }, [queue, record, runId, scope]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = safeRunId(params.get("run"));
    setRunId(id);
    if (params.get("run") !== id) {
      window.history.replaceState(null, "", window.location.pathname + "?run=" + encodeURIComponent(id));
    }
  }, []);

  useEffect(() => {
    if (!runId) return;
    void refreshEntries();
    const onFocus = () => { void refreshEntries(); };
    window.addEventListener("focus", onFocus);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
    if (channel) channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "QUEUE_CHANGED") void refreshEntries();
    };
    return () => {
      window.removeEventListener("focus", onFocus);
      channel?.close();
    };
  }, [channelName, refreshEntries, runId]);

  const notifyOtherTabs = useCallback((type: string) => {
    if (typeof BroadcastChannel === "undefined" || !runId) return;
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type, at: new Date().toISOString() });
    channel.close();
  }, [channelName, runId]);

  const seedMovement = useCallback(async () => {
    try {
      const activeQueue = queue();
      const current = await activeQueue.list(scope) as unknown as QueueEntry[];
      const pending = current.find((entry) => entry.status === "PENDING");
      if (pending) {
        record("Reusing pending transaction " + pending.transactionId + "; queue is shared across tabs and reloads.");
        await refreshEntries();
        return;
      }
      const transactionId = uuid();
      await activeQueue.enqueue(scope, {
        client_transaction_id: transactionId,
        operation: "STOCK_MOVEMENT",
        item_id: ITEM_ID,
        movement_type: "ISSUE",
        quantity: 1,
        expected_balance_version: "1",
        notes: "Local-only browser acceptance fixture; never sent to FactoryOS API.",
      });
      record("Seeded local-only transaction " + transactionId + ". No API call or stock mutation occurred.");
      notifyOtherTabs("QUEUE_CHANGED");
      await refreshEntries();
    } catch (error) {
      record("Could not seed local transaction: " + (error instanceof Error ? error.message : "unknown error"));
    }
  }, [notifyOtherTabs, queue, record, refreshEntries, scope]);

  const openSecondTab = useCallback(() => {
    if (!runId) return;
    const url = window.location.origin + window.location.pathname + "?run=" + encodeURIComponent(runId);
    window.open(url, "_blank", "noopener,noreferrer");
    record("Opened a second same-origin tab for the same IndexedDB acceptance run.");
  }, [record, runId]);

  const startPrimaryClaim = useCallback(() => {
    if (primaryPromise.current) {
      record("A primary claim attempt is already active in this tab.");
      return;
    }
    localStorage.removeItem(markerKey);
    setPrimaryState("Claiming from IndexedDB…");
    setCompetingState("Not run");

    const operation = queue().flush(scope, async (batch: Batch) => {
      primaryBatch.current = batch;
      localStorage.setItem(markerKey, JSON.stringify({
        status: "ACTIVE",
        claimedAt: new Date().toISOString(),
        transactionIds: batch.transactions.map((transaction) => transaction.client_transaction_id),
      }));
      notifyOtherTabs("QUEUE_CHANGED");
      setPrimaryState("CLAIMED " + batch.transactions.length + " transaction(s); waiting for operator release");
      record("Primary tab holds its real IndexedDB claim lease. Switch to the second tab and try the competing claim.");
      return new Promise<{ results: SendResult[] }>((resolve) => {
        primaryResolver.current = resolve;
      });
    }, { claimLeaseMs: 60_000 });

    primaryPromise.current = operation;
    void operation.then((result) => {
      const outcome = result as { sentCount?: number; syncedCount?: number; pendingCount?: number };
      localStorage.setItem(markerKey, JSON.stringify({ status: "COMPLETE", completedAt: new Date().toISOString() }));
      setPrimaryState("Complete — sent " + (outcome.sentCount ?? 0) + ", locally receipted " + (outcome.syncedCount ?? 0) + ", pending " + (outcome.pendingCount ?? 0));
      record("Primary claim completed: sent=" + (outcome.sentCount ?? 0) + ", synced=" + (outcome.syncedCount ?? 0) + ". Synthetic response stayed in this browser.");
      notifyOtherTabs("QUEUE_CHANGED");
      void refreshEntries();
    }).catch((error: unknown) => {
      setPrimaryState("Failed: " + (error instanceof Error ? error.message : "unknown error"));
      record("Primary claim failed: " + (error instanceof Error ? error.message : "unknown error"));
    }).finally(() => {
      primaryPromise.current = null;
      primaryResolver.current = null;
      primaryBatch.current = null;
    });
  }, [markerKey, notifyOtherTabs, queue, record, refreshEntries, scope]);

  const tryCompetingClaim = useCallback(async () => {
    let marker: { status?: string } | null = null;
    try {
      const raw = localStorage.getItem(markerKey);
      marker = raw ? JSON.parse(raw) as { status?: string } : null;
    } catch { marker = null; }
    if (marker?.status !== "ACTIVE") {
      setCompetingState("BLOCKED — start the primary claim in tab A first");
      record("Competing attempt refused because no active primary claim marker exists.");
      return;
    }

    let competingTransportCalled = false;
    try {
      const result = await queue().flush(scope, async (batch: Batch) => {
        competingTransportCalled = true;
        return {
          results: batch.transactions.map((transaction) => ({
            client_transaction_id: transaction.client_transaction_id,
            receipt_id: RECEIPT_ID,
            operation: "STOCK_MOVEMENT" as const,
            status: "APPLIED" as const,
            replayed: true,
          })),
        };
      }, { claimLeaseMs: 60_000 });

      const passed = result.sentCount === 0 && !competingTransportCalled;
      setCompetingState(passed
        ? "PASS — second tab could not claim the active transaction"
        : "FAIL — competing tab reached transport while first claim was active");
      record("Competing claim " + (passed ? "PASS" : "FAIL") + ": sent=" + result.sentCount + ", transport called=" + competingTransportCalled + ".");
      await refreshEntries();
    } catch (error) {
      setCompetingState("ERROR — " + (error instanceof Error ? error.message : "unknown error"));
      record("Competing attempt errored: " + (error instanceof Error ? error.message : "unknown error"));
    }
  }, [markerKey, queue, record, refreshEntries, scope]);

  const releasePrimaryAsApplied = useCallback(() => {
    const resolver = primaryResolver.current;
    const batch = primaryBatch.current;
    if (!resolver || !batch || batch.transactions.length === 0) {
      record("No held primary request is ready to release.");
      return;
    }
    resolver({
      results: batch.transactions.map((transaction) => ({
        client_transaction_id: transaction.client_transaction_id,
        receipt_id: RECEIPT_ID,
        operation: "STOCK_MOVEMENT",
        status: "APPLIED",
        replayed: false,
      })),
    });
    setPrimaryState("Synthetic APPLIED response released; waiting for local queue reconciliation");
    record("Released a synthetic APPLIED receipt. The FactoryOS API and stock ledger were not contacted.");
  }, [record]);

  const pendingCount = entries.filter((entry) => entry.status === "PENDING").length;
  const held = primaryResolver.current !== null && primaryBatch.current !== null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-600">FactoryOS · WMS</p>
        <h1 className="text-3xl font-semibold">Browser IndexedDB acceptance</h1>
        <p className="max-w-3xl text-slate-700">
          Browser-backed lab for durable queue state and cross-tab claim leases. It uses real IndexedDB in this browser, but synthetic receipts only; it never calls the FactoryOS API or changes stock.
        </p>
      </header>

      <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        Use a dedicated test browser profile. Open this page in two tabs with the same run ID. This lab is not physical handheld, live API, or warehouse acceptance.
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="text-xl font-semibold">Run identity</h2>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-sm text-slate-600">Shared run ID</dt><dd className="break-all font-mono">{runId || "Initializing…"}</dd></div>
          <div><dt className="text-sm text-slate-600">IndexedDB database</dt><dd className="break-all font-mono">{databaseName}</dd></div>
          <div><dt className="text-sm text-slate-600">Scope</dt><dd className="break-all font-mono">{TENANT_ID + " / " + FACTORY_ID + " / " + USER_ID}</dd></div>
          <div><dt className="text-sm text-slate-600">Pending local items</dt><dd className="text-lg font-semibold">{pendingCount}</dd></div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50" onClick={openSecondTab} disabled={!runId}>Open second tab</button>
          <button className="rounded-lg border px-4 py-2 font-medium disabled:opacity-50" onClick={() => void seedMovement()} disabled={!runId}>Seed local test movement</button>
          <button className="rounded-lg border px-4 py-2 font-medium disabled:opacity-50" onClick={() => void refreshEntries()} disabled={!runId || refreshing}>{refreshing ? "Refreshing…" : "Refresh IndexedDB"}</button>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="text-xl font-semibold">Cross-tab claim race</h2>
        <ol className="list-decimal space-y-2 pl-5 text-slate-700">
          <li>Seed one local transaction in either tab. Reload the other tab and confirm the same pending transaction is visible.</li>
          <li>In tab A, start the primary claim. Its simulated transport is held open while the real IndexedDB claim lease stays active.</li>
          <li>While tab A is waiting, in tab B click the competing claim button. It must not call its transport or claim the same transaction.</li>
          <li>Return to tab A and release the synthetic APPLIED response. Refresh both tabs to verify receipt-gated local removal.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50" onClick={startPrimaryClaim} disabled={!runId || held || pendingCount === 0}>Start primary claim (tab A)</button>
          <button className="rounded-lg bg-indigo-700 px-4 py-2 font-medium text-white disabled:opacity-50" onClick={() => void tryCompetingClaim()} disabled={!runId}>Try competing claim (tab B)</button>
          <button className="rounded-lg bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-50" onClick={releasePrimaryAsApplied} disabled={!held}>Release primary as APPLIED</button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-sm text-slate-600">Tab A</p><p className="font-semibold">{primaryState}</p></div>
          <div className="rounded-lg bg-slate-50 p-3"><p className="text-sm text-slate-600">Tab B</p><p className="font-semibold">{competingState}</p></div>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="text-xl font-semibold">Shared queue rows</h2>
        {entries.length === 0 ? <p className="text-slate-600">No local test rows. Seed a test movement to begin.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead><tr className="border-b"><th className="p-2">Transaction ID</th><th className="p-2">Status</th><th className="p-2">Attempts</th><th className="p-2">Retry at</th><th className="p-2">Last error</th></tr></thead>
              <tbody>{entries.map((entry) => <tr key={entry.transactionId} className="border-b last:border-0">
                <td className="break-all p-2 font-mono">{entry.transactionId}</td>
                <td className="p-2">{entry.status}</td>
                <td className="p-2">{entry.attemptCount}</td>
                <td className="p-2">{entry.nextRetryAt ? new Date(entry.nextRetryAt).toISOString() : "—"}</td>
                <td className="p-2">{entry.lastError ?? "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="text-xl font-semibold">Run log</h2>
        {events.length === 0 ? <p className="text-slate-600">No actions yet.</p> : (
          <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
            {events.map((event, index) => <li key={String(index) + event} className="border-b pb-2 font-mono last:border-0">{event}</li>)}
          </ul>
        )}
        <p className="text-sm text-slate-600">The log is tab-local. Record its contents, screen captures, browser version, device model/firmware and exact release SHA in the restricted site acceptance pack.</p>
      </section>
    </main>
  );
}
