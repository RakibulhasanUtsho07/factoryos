"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
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
  Field,
  Input,
  Label,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
} from "@/components/ui";
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
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}
function getOnlineStatus() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
type RenderedLabel = {
  symbology: string; encoded_value: string; copies: number; status: string;
  width_mm: number; height_mm: number; svg: string; print_html: string; svg_data_uri: string;
};
type LabelScanResult = { identity_type: "TRACEABILITY_UNIT" | "MATERIAL"; identity: Record<string, unknown> };
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const initialLabelIssue = JSON.stringify({
  symbology: "QR",
  barcode_value: "DEMO-LOT-0001",
  copy_count: 1,
  label_layout: { page: { width_mm: 50, height_mm: 30 }, fields: ["unit_code", "barcode_value", "product_role", "status"] },
  encoded_payload: { schema: "factoryos.traceability-label/v1", identity_type: "TRACEABILITY_UNIT", unit_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", unit_code: "DEMO-LOT-0001", barcode_value: "DEMO-LOT-0001", product_role: "FINISHED_GOOD", status: "ACTIVE" },
}, null, 2);

export default function WmsMobileAcceptancePage() {
  const [tenantId, setTenantId] = useState("");
  const [factoryId, setFactoryId] = useState("");
  const [userId, setUserId] = useState("");
  const [deviceId, setDeviceId] = useState("WMS-HH-01");
  const [apiOrigin, setApiOrigin] = useState(process.env.NEXT_PUBLIC_FACTORYOS_API_URL ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [itemId, setItemId] = useState("");
  const [movementType, setMovementType] = useState<"RECEIPT" | "ISSUE">("ISSUE");
  const [quantity, setQuantity] = useState("1");
  const [expectedVersion, setExpectedVersion] = useState("1");
  const [entries, setEntries] = useState<QueuedEntry[]>([]);
  const [queueMessage, setQueueMessage] = useState("Enter your authenticated scope and API origin to load the durable queue.");
  const [queueError, setQueueError] = useState("");
  const [lastSync, setLastSync] = useState("");
  const [resolvingVersion, setResolvingVersion] = useState<Record<string, string>>({});
  const [labelIssueJson, setLabelIssueJson] = useState(initialLabelIssue);
  const [currentIdentityJson, setCurrentIdentityJson] = useState("");
  const [renderedLabel, setRenderedLabel] = useState<RenderedLabel | null>(null);
  const [labelError, setLabelError] = useState("");
  const [scanCode, setScanCode] = useState("");
  const [scanResult, setScanResult] = useState<LabelScanResult | null>(null);
  const [scanError, setScanError] = useState("");
  const [busy, setBusy] = useState(false);
  const online = useSyncExternalStore(subscribeToOnlineStatus, getOnlineStatus, () => true);
  const queueRef = useRef<InstanceType<typeof WmsOfflineQueue> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labelFrameRef = useRef<HTMLIFrameElement | null>(null);
  const flushQueueRef = useRef<(() => Promise<void>) | null>(null);

  const scope = useMemo(() => ({ tenantId, factoryId, userId, deviceId }), [tenantId, factoryId, userId, deviceId]);
  const scopeReady = uuidPattern.test(tenantId.trim()) && uuidPattern.test(factoryId.trim()) &&
    uuidPattern.test(userId.trim()) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId.trim());
  const getQueue = useCallback(() => {
    if (!queueRef.current) queueRef.current = new WmsOfflineQueue();
    return queueRef.current;
  }, []);
  const apiUrl = useCallback((path: string) => {
    const origin = apiOrigin.trim();
    if (!origin) throw new Error("Set the API origin first, for example https://factory-api.example.com.");
    return new URL(path, origin.endsWith("/") ? origin : origin + "/").toString();
  }, [apiOrigin]);
  const transport = useCallback(() => createWmsOfflineSyncTransport({
    endpoint: apiUrl("/api/v1/wms/mobile/offline-sync/batches"),
    getAccessToken: () => accessToken.trim() || undefined,
  }), [apiUrl, accessToken]);

  const refreshQueue = useCallback(async () => {
    if (!scopeReady) {
      setEntries([]);
      return;
    }
    try {
      const list = await getQueue().list(scope);
      setEntries(list as QueuedEntry[]);
      setQueueMessage(list.length ? "Queue restored from this browser's durable IndexedDB store." : "No queued operations for this scope.");
      setQueueError("");
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : "Could not load offline queue.");
    }
  }, [scope, scopeReady, getQueue]);

  const flushQueue = useCallback(async () => {
    if (!scopeReady) {
      setQueueError("Enter valid tenant, factory, user UUIDs and device ID before syncing.");
      return;
    }
    if (!navigator.onLine) {
      setQueueMessage("Device is offline. Queued transactions are kept locally.");
      return;
    }
    try {
      setBusy(true);
      setQueueError("");
      const result = await getQueue().flush(scope, transport());
      setLastSync(JSON.stringify(result, null, 2));
      setQueueMessage(
        "Sent " + result.sentCount + "; APPLIED receipt-confirmed and removed " + result.syncedCount +
        "; conflict " + result.conflictCount + "; rejected " + result.rejectedCount +
        "; pending " + result.pendingCount + ".",
      );
      await refreshQueue();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (result.pendingCount > 0) {
        const waitMs = typeof result.retryAt === "number" ? Math.max(0, result.retryAt - Date.now()) : 0;
        retryTimerRef.current = setTimeout(() => { void flushQueueRef.current?.(); }, waitMs);
      }
      if (result.transportError) setQueueError("Sync failed safely; local queue was retained: " + result.transportError);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : "Offline sync failed.");
    } finally {
      setBusy(false);
    }
  }, [scope, scopeReady, transport, refreshQueue, getQueue]);

  useEffect(() => {
    flushQueueRef.current = flushQueue;
  }, [flushQueue]);

  useEffect(() => {
    queueMicrotask(() => { void refreshQueue(); });
    const onOnline = () => {
      setQueueMessage("Connection restored. Attempting receipt-safe queue synchronization.");
      void flushQueue();
    };
    const onOffline = () => {
      setQueueMessage("Device is offline. New operations remain in IndexedDB until the API is reachable.");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [refreshQueue, flushQueue]);

  async function enqueueMovement(event: FormEvent<HTMLFormElement>) {
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
      setQueueMessage("Saved to durable local queue. No stock is considered committed until a server receipt confirms it.");
      await refreshQueue();
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : "Could not enqueue stock movement.");
    }
  }

  async function resolveEntry(entry: QueuedEntry) {
    const version = (resolvingVersion[entry.transactionId] ?? "").trim();
    if (!version) {
      setQueueError("Enter the current balance version before resolving a conflict.");
      return;
    }
    try {
      const replacement = {
        ...entry.payload,
        client_transaction_id: crypto.randomUUID(),
        expected_balance_version: version,
      };
      const result = await getQueue().resolveConflict(scope, entry.transactionId, replacement);
      setQueueMessage("Resolution queued with new transaction ID " + result.replacement.transactionId + "; original receipt/history is retained.");
      setQueueError("");
      await refreshQueue();
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : "Conflict resolution failed.");
    }
  }

  function renderLabel() {
    try {
      const issue = JSON.parse(labelIssueJson);
      const current = currentIdentityJson.trim() ? JSON.parse(currentIdentityJson) : undefined;
      setRenderedLabel(renderWmsLabel(issue, { currentIdentity: current }));
      setLabelError("");
    } catch (error) {
      setRenderedLabel(null);
      setLabelError(error instanceof WmsLabelRenderError ? error.message : error instanceof Error ? error.message : "Label JSON could not be rendered.");
    }
  }

  function printLabel() {
    const frame = labelFrameRef.current;
    if (!frame?.contentWindow) {
      setLabelError("Render a valid label before printing.");
      return;
    }
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }

  async function resolveScan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setScanError("");
      setScanResult(null);
      const resolver = createWmsLabelScanResolver({
        endpoint: apiUrl("/api/v1/traceability/labels/resolve"),
        getAccessToken: () => accessToken.trim() || undefined,
      });
      setScanResult(await resolver(scanCode));
    } catch (error) {
      setScanError(error instanceof WmsLabelRenderError ? error.message : error instanceof Error ? error.message : "Label lookup failed.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 text-zinc-900 md:px-8">
      <PageHeader
        eyebrow="FactoryOS · WP02"
        title="Mobile warehouse & label workbench"
        description="Offline-first queue, receipt-controlled cleanup, barcode/QR rendering, and factory-scoped scan lookup."
        actions={<Badge tone={online ? "success" : "warning"}>{online ? "Online" : "Offline"}</Badge>}
      />

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Connection & local scope</CardTitle>
          <CardDescription>
            Scope values partition local browser data only; server authorization still comes from the authenticated session. API origin must be the origin only, e.g. https://factory-api.example.com. The optional bearer token remains in memory and is never stored in IndexedDB.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <Label htmlFor="wms-api-origin">API origin</Label>
              <Input id="wms-api-origin" value={apiOrigin} onChange={(e) => setApiOrigin(e.target.value)} placeholder="https://factory-api.example.com" />
            </Field>
            <Field>
              <Label htmlFor="wms-access-token">Bearer token (optional when cookie auth is used)</Label>
              <Input id="wms-access-token" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} autoComplete="off" />
            </Field>
            <Field>
              <Label htmlFor="wms-tenant-id">Tenant UUID</Label>
              <Input id="wms-tenant-id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenant UUID" />
            </Field>
            <Field>
              <Label htmlFor="wms-factory-id">Factory UUID</Label>
              <Input id="wms-factory-id" value={factoryId} onChange={(e) => setFactoryId(e.target.value)} placeholder="factory UUID" />
            </Field>
            <Field>
              <Label htmlFor="wms-user-id">Authenticated user UUID (local partition)</Label>
              <Input id="wms-user-id" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user UUID" />
            </Field>
            <Field>
              <Label htmlFor="wms-device-id">Warehouse device ID</Label>
              <Input id="wms-device-id" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="WMS-HH-01" />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => void refreshQueue()}>Restore local queue</Button>
            <Button onClick={() => void flushQueue()} disabled={busy || !scopeReady || !apiOrigin.trim()}>{busy ? "Syncing…" : "Sync queue now"}</Button>
          </div>
          <Alert tone="info" className="mt-3">{queueMessage}</Alert>
          {queueError && <Alert tone="danger" className="mt-2">{queueError}</Alert>}
          {lastSync && <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold">Last sync receipt summary</summary><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">{lastSync}</pre></details>}
        </CardContent>
      </Card>

      <div className="grid items-start gap-8 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>1. Queue a stock movement</CardTitle>
            <CardDescription>The queue persists before network access. Only a matching APPLIED response with a valid transaction receipt allows automatic cleanup.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={enqueueMovement} className="mt-1 space-y-3">
              <Field>
                <Label htmlFor="wms-item-id">Inventory item UUID</Label>
                <Input id="wms-item-id" required value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="inventory item UUID" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <Label htmlFor="wms-movement-type">Movement</Label>
                  <Select id="wms-movement-type" value={movementType} onChange={(e) => setMovementType(e.target.value as "RECEIPT" | "ISSUE")}>
                    <option value="ISSUE">ISSUE / pick</option><option value="RECEIPT">RECEIPT</option>
                  </Select>
                </Field>
                <Field>
                  <Label htmlFor="wms-quantity">Quantity</Label>
                  <Input id="wms-quantity" type="number" min="0.0001" step="0.0001" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                </Field>
              </div>
              <Field>
                <Label htmlFor="wms-expected-version">Expected balance version</Label>
                <Input id="wms-expected-version" type="text" inputMode="numeric" pattern="[0-9]{1,19}" required value={expectedVersion} onChange={(e) => setExpectedVersion(e.target.value)} />
              </Field>
              <Button type="submit" className="w-full" disabled={!scopeReady || busy}>Save transaction locally</Button>
            </form>
          <div className="mt-5 border-t border-zinc-200 pt-4">
            <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Durable queue</h3><Badge tone="neutral">{entries.length} record(s)</Badge></div>
            <div className="mt-3 space-y-3">
              {entries.length === 0 && <EmptyState title="No queued transactions" description="No records are loaded for this local scope yet." className="min-h-0 py-6" />}
              {entries.map((entry) => (
                <article key={entry.transactionId} className="rounded-xl border border-zinc-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs">{entry.transactionId}</span>
                    <StatusBadge status={entry.status} />
                  </div>
                  <p className="mt-2 text-sm">{entry.payload.movement_type} {entry.payload.quantity} · balance version {entry.payload.expected_balance_version} · attempts {entry.attemptCount}</p>
                  {entry.receiptId && <p className="mt-1 break-all text-xs text-zinc-500">Server receipt: {entry.receiptId}</p>}
                  {entry.lastError && <p className="mt-1 text-xs text-amber-800">{entry.lastError}</p>}
                  {(entry.status === "CONFLICT" || entry.status === "REJECTED") && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Input aria-label={"New balance version for " + entry.transactionId} value={resolvingVersion[entry.transactionId] ?? ""} onChange={(e) => setResolvingVersion((current) => ({ ...current, [entry.transactionId]: e.target.value }))} placeholder="current balance version" className="min-w-0 flex-1" />
                      <Button variant="outline" size="sm" onClick={() => void resolveEntry(entry)} disabled={busy}>Resolve as new transaction</Button>
                    </div>
                  )}
                  {entry.status === "RESOLVED" && entry.resolvedByTransactionId && <p className="mt-1 break-all text-xs text-zinc-500">Replaced by: {entry.resolvedByTransactionId}</p>}
                </article>
              ))}
            </div>
          </div>
        </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Render and print a label</CardTitle>
            <CardDescription>Paste the persisted response from POST /traceability/labels/issue. The renderer validates the issued value and lifecycle snapshot; demo content is only for checking preview.</CardDescription>
          </CardHeader>
          <CardContent>
            <Field>
              <Label htmlFor="wms-label-issue-json">Label issue JSON</Label>
              <Textarea id="wms-label-issue-json" value={labelIssueJson} onChange={(e) => setLabelIssueJson(e.target.value)} rows={12} spellCheck={false} className="font-mono text-xs" />
            </Field>
            <Field className="mt-3">
              <Label htmlFor="wms-current-identity-json">Optional latest identity JSON to detect a stale label snapshot</Label>
              <Textarea id="wms-current-identity-json" value={currentIdentityJson} onChange={(e) => setCurrentIdentityJson(e.target.value)} rows={4} spellCheck={false} placeholder='{"id":"...","unit_code":"...","status":"RECALLED"}' className="font-mono text-xs" />
            </Field>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button onClick={renderLabel}>Render SVG</Button>
              <Button variant="outline" onClick={printLabel} disabled={!renderedLabel}>Print labels</Button>
            </div>
            {labelError && <Alert tone="danger" className="mt-3">{labelError}</Alert>}
          {renderedLabel && (
            <div className="mt-4 rounded-xl border border-zinc-200 p-3">
              <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-zinc-600"><span>{renderedLabel.symbology} · {renderedLabel.width_mm} × {renderedLabel.height_mm} mm</span><span>{renderedLabel.copies} copy/copies · {renderedLabel.status}</span></div>
              <iframe ref={labelFrameRef} title="Rendered WMS label print preview" srcDoc={renderedLabel.print_html} sandbox="allow-same-origin allow-modals" className="h-72 w-full rounded-lg border border-zinc-200 bg-white" />
            </div>
          )}
            <p className="mt-3 text-xs leading-5 text-zinc-500">This workbench emits browser SVG/HTML print payloads for QR and Code 128. Data Matrix and GS1-128 fail closed until their encoders are implemented. Native printer languages and real scanner/printer compatibility require site validation.</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>3. Scan or resolve a barcode/QR value</CardTitle>
          <CardDescription>Focus the field and scan with a keyboard-wedge scanner, or paste text produced by a camera scanner adapter. The lookup uses the API&apos;s authenticated factory scope and rejects blank, unknown, or ambiguous codes.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={resolveScan} className="mt-1 flex flex-col gap-3 sm:flex-row">
            <Input aria-label="Barcode or QR value" value={scanCode} onChange={(e) => setScanCode(e.target.value)} autoComplete="off" placeholder="Scan code here…" className="min-w-0 flex-1" />
            <Button type="submit" disabled={!apiOrigin.trim()}>Resolve code</Button>
          </form>
          {scanError && <Alert tone="danger" className="mt-3">{scanError}</Alert>}
          {scanResult && <pre className="mt-3 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">{JSON.stringify(scanResult, null, 2)}</pre>}
        </CardContent>
      </Card>

      <Alert tone="warning" className="mt-8">
        Queue guarantees here are client-side: IndexedDB survives browser reloads on the same origin, not browser-data deletion or device loss. APPLIED cleanup requires a valid server receipt and matching operation; CONFLICT/REJECTED remain for review. Physical printer, scanner/camera, label stock, damaged-label and device reconnect acceptance must be executed on the target warehouse hardware before production sign-off.
      </Alert>
    </main>
  );
}
