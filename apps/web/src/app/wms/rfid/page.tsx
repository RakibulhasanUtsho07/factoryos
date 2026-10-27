"use client";

import { useMemo, useRef, useState } from "react";
import {
  aggregateEpcReads,
  RfidReaderError,
  WebSerialRfidReader,
} from "@/lib/rfid-serial-reader.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_READS_PER_BATCH = 1000;

type ReaderState = "DISCONNECTED" | "CONNECTING" | "READING" | "STOPPING" | "LIMIT_REACHED";
type HILStatus = "NOT_RUN" | "PASS" | "FAIL";
type HILCaseId = "KNOWN_TAG" | "REPEATED_EPC" | "UNKNOWN_TAG" | "WRONG_ITEM" | "NOT_PRESENT" | "QUANTITY_RECONCILIATION" | "DISCONNECT_RECONNECT" | "AUTH_SCOPE";
const HIL_CASES: Array<{ id: HILCaseId; label: string; evidence: string }> = [
  { id: "KNOWN_TAG", label: "Known tag resolves to the correct traceability unit", evidence: "EPC, unit ID and disposition MATCHED" },
  { id: "REPEATED_EPC", label: "Repeated EPC reads are deduplicated", evidence: "Raw read count, unique EPC count and duplicate_read_count" },
  { id: "UNKNOWN_TAG", label: "Unknown EPC is excluded", evidence: "Observation disposition UNKNOWN_TAG" },
  { id: "WRONG_ITEM", label: "Tag belonging to another item is rejected", evidence: "Observation disposition WRONG_ITEM" },
  { id: "NOT_PRESENT", label: "Known tag absent from the selected bin contributes zero", evidence: "Observation disposition NOT_PRESENT" },
  { id: "QUANTITY_RECONCILIATION", label: "Expected / observed / variance quantities reconcile", evidence: "Server batch ID and final quantities" },
  { id: "DISCONNECT_RECONNECT", label: "Reader disconnect/reconnect and partial line are handled", evidence: "Timestamped operator note and raw sample" },
  { id: "AUTH_SCOPE", label: "Unauthorized scope or credentials are rejected", evidence: "HTTP result and no cross-factory identity disclosure" },
];
type ReaderStatusEvent = { connected: boolean; baudRate: number };
type RfidObservation = {
  epc: string;
  traceability_unit_id: string | null;
  observed_quantity: string;
  duplicate_read_count: number;
  disposition: "MATCHED" | "UNKNOWN_TAG" | "WRONG_ITEM" | "NOT_PRESENT" | "INELIGIBLE";
};
type ReconciliationResult = {
  id: string;
  expected_quantity: string;
  observed_quantity: string;
  variance_quantity: string;
  duplicate_reads_suppressed: number;
  matched_tag_count: number;
  excluded_tag_count: number;
  reconciliation_status: "MATCHED" | "VARIANCE";
  replayed: boolean;
  observations: RfidObservation[];
};

export default function RfidHardwareAcceptancePage() {
  const [apiOrigin, setApiOrigin] = useState(process.env.NEXT_PUBLIC_FACTORYOS_API_URL ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [readerId, setReaderId] = useState("");
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [siteCode, setSiteCode] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [firmwareVersion, setFirmwareVersion] = useState("");
  const [hilStatuses, setHilStatuses] = useState<Record<HILCaseId, HILStatus>>({
    KNOWN_TAG: "NOT_RUN", REPEATED_EPC: "NOT_RUN", UNKNOWN_TAG: "NOT_RUN", WRONG_ITEM: "NOT_RUN",
    NOT_PRESENT: "NOT_RUN", QUANTITY_RECONCILIATION: "NOT_RUN", DISCONNECT_RECONNECT: "NOT_RUN", AUTH_SCOPE: "NOT_RUN",
  });
  const [hilNotes, setHilNotes] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [sessionId, setSessionId] = useState("");
  const [captureStartedAt, setCaptureStartedAt] = useState<string | null>(null);
  const [captureStoppedAt, setCaptureStoppedAt] = useState<string | null>(null);
  const [state, setState] = useState<ReaderState>("DISCONNECTED");
  const [readCount, setReadCount] = useState(0);
  const [uniqueCount, setUniqueCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [reads, setReads] = useState<string[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [ignoredExamples, setIgnoredExamples] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("Connect a USB-serial RFID reader that streams hexadecimal EPC records, one per line.");
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const readerRef = useRef<InstanceType<typeof WebSerialRfidReader> | null>(null);
  const readerPortOpenedRef = useRef(false);
  const readsRef = useRef<string[]>([]);
  const seenEpcsRef = useRef<Map<string, number>>(new Map());
  const idempotencyKeyRef = useRef<string | null>(null);

  const summary = useMemo(() => aggregateEpcReads(reads), [reads]);
  const scopeReady = uuidPattern.test(readerId.trim()) && uuidPattern.test(itemId.trim()) && uuidPattern.test(locationId.trim());
  const connected = state === "READING" || state === "LIMIT_REACHED";

  function clearCapture() {
    readsRef.current = [];
    seenEpcsRef.current.clear();
    idempotencyKeyRef.current = null;
    readerPortOpenedRef.current = false;
    setReads([]);
    setReadCount(0);
    setUniqueCount(0);
    setDuplicateCount(0);
    setIgnoredCount(0);
    setIgnoredExamples([]);
    setSessionId(crypto.randomUUID());
    setCaptureStartedAt(null);
    setCaptureStoppedAt(null);
    setResult(null);
    setError("");
  }

  async function connectReader() {
    setError("");
    setResult(null);
    if (!uuidPattern.test(readerId.trim()) || !uuidPattern.test(itemId.trim()) || !uuidPattern.test(locationId.trim())) {
      setError("Reader ID, inventory item ID, and inventory location ID must be valid UUIDs.");
      return;
    }
    if (typeof window === "undefined" || !("serial" in navigator)) {
      setError("Web Serial is unavailable in this browser. Use a supported Chromium browser over HTTPS or implement the approved vendor SDK/gateway adapter.");
      return;
    }
    clearCapture();
    setState("CONNECTING");
    const adapter = new WebSerialRfidReader();
    readerRef.current = adapter;
    try {
      await adapter.connect({
        baudRate: Number(baudRate),
        onEpc: (epc: string) => {
          const current = readsRef.current;
          if (current.length >= MAX_READS_PER_BATCH) {
            setState("LIMIT_REACHED");
            setMessage("Read limit reached. Stop/submit this batch before starting another reader session.");
            void adapter.disconnect();
            return;
          }
          current.push(epc);
          const priorReadCount = seenEpcsRef.current.get(epc) ?? 0;
          seenEpcsRef.current.set(epc, priorReadCount + 1);
          setUniqueCount(seenEpcsRef.current.size);
          if (priorReadCount > 0) setDuplicateCount((count) => count + 1);
          const count = current.length;
          setReadCount(count);
          if (count % 5 === 0 || count === 1 || count === MAX_READS_PER_BATCH) {
            setReads([...current]);
          }
          if (count >= MAX_READS_PER_BATCH) {
            setState("LIMIT_REACHED");
            setMessage("The 1,000-read API batch limit is reached; stop the reader and reconcile this batch.");
            void adapter.disconnect();
          }
        },
        onInvalidLine: ({ line }: { line: string }) => {
          setIgnoredCount((count) => count + 1);
          setIgnoredExamples((items) => items.length < 5 ? [...items, line] : items);
        },
        onStatus: ({ connected: isConnected }: ReaderStatusEvent) => {
          setState(isConnected ? "READING" : "DISCONNECTED");
          if (isConnected) {
            readerPortOpenedRef.current = true;
            setCaptureStartedAt((value) => value ?? new Date().toISOString());
            setMessage("RFID reader connected. Raw EPC reads are being captured locally; stock is not changed by capture.");
          }
          else {
            setCaptureStoppedAt(new Date().toISOString());
            setReads([...readsRef.current]);
            setMessage("Reader disconnected. Captured EPCs remain available for reconciliation.");
          }
        },
        onError: (cause: Error) => {
          setError("Reader stream failed: " + cause.message);
          setState("DISCONNECTED");
        },
      });
      setMessage("Reader stream opened. Present known, unknown, and repeated tags for acceptance testing.");
    } catch (cause) {
      setState("DISCONNECTED");
      setError(cause instanceof RfidReaderError ? cause.message : cause instanceof Error ? cause.message : "RFID reader connection failed.");
    }
  }

  async function disconnectReader() {
    setState("STOPPING");
    try {
      await readerRef.current?.disconnect();
      setReads([...readsRef.current]);
      setState("DISCONNECTED");
      setMessage("Reader stopped. The captured EPC set has not yet been reconciled by the API.");
    } catch (cause) {
      setState("DISCONNECTED");
      setError(cause instanceof Error ? cause.message : "Could not stop RFID reader.");
    }
  }

  function exportHardwareEvidence() {
    const generatedAt = new Date().toISOString();
    const artifact = {
      schema: "factoryos.wms.rfid-hil-evidence/v1",
      evidence_type: "OPERATOR_REPORTED_HARDWARE_IN_LOOP",
      generated_at: generatedAt,
      reader_port_opened_by_browser: readerPortOpenedRef.current,
      physical_hardware_identity_independently_attested: false,
      site: { site_code: siteCode.trim(), operator_name: operatorName.trim() },
      capture_started_at: captureStartedAt,
      capture_stopped_at: captureStoppedAt,
      capture_duration_ms: captureStartedAt && captureStoppedAt ? Math.max(0, Date.parse(captureStoppedAt) - Date.parse(captureStartedAt)) : null,
      raw_read_rate_per_second: captureStartedAt && captureStoppedAt && Date.parse(captureStoppedAt) > Date.parse(captureStartedAt) ? Number((readCount * 1000 / (Date.parse(captureStoppedAt) - Date.parse(captureStartedAt))).toFixed(3)) : null,
      device: {
        reader_id: readerId.trim(),
        manufacturer: manufacturer.trim(),
        model: model.trim(),
        serial_number: serialNumber.trim(),
        firmware_version: firmwareVersion.trim(),
        interface: "USB_SERIAL_WEB_SERIAL",
        protocol_profile: "HEX_EPC_LINE_OR_EPC_PREFIX_OR_JSON_EPC",
        baud_rate: Number(baudRate),
        browser_user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
      },
      context: { api_origin: apiOrigin.trim(), session_id: sessionId, item_id: itemId.trim(), location_id: locationId.trim() },
      capture: {
        raw_read_count: readCount,
        unique_epc_count: uniqueCount,
        duplicate_reads_client_preview: duplicateCount,
        ignored_frame_count: ignoredCount,
        distinct_epcs: summary,
        ignored_frame_examples: ignoredExamples,
      },
      server_reconciliation: result,
      operator_reported_checks: HIL_CASES.map((item) => ({ id: item.id, status: hilStatuses[item.id], expected_evidence: item.evidence })),
      notes: hilNotes.trim(),
      evidence_is_operator_reported_and_not_independently_attested: true,
    };
    const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "factoryos-rfid-hil-" + (sessionId || generatedAt.replace(/[:.]/g, "-")) + ".json";
    link.click();
    URL.revokeObjectURL(objectUrl);
    setMessage("Operator-reported RFID HIL evidence JSON exported. Attach physical photos/logs and review scenario results before sign-off.");
  }

  async function submitReads() {
    const origin = apiOrigin.trim();
    if (!origin) {
      setError("Configure the FactoryOS API origin first.");
      return;
    }
    if (!scopeReady) {
      setError("Reader, item, and location IDs must be valid UUIDs.");
      return;
    }
    const captured = [...readsRef.current];
    if (captured.length < 1 || captured.length > MAX_READS_PER_BATCH) {
      setError("Capture between 1 and 1,000 valid EPC reads before reconciliation.");
      return;
    }
    if (connected) {
      setError("Stop the reader before submitting the batch so the read set stays immutable for idempotent retry.");
      return;
    }
    if (!sessionId) {
      setError("Reader session ID is missing. Start a new capture before submitting.");
      return;
    }
    const endpoint = new URL("/api/v1/wms/mobile/rfid/read-batches", origin.endsWith("/") ? origin : origin + "/");
    const key = idempotencyKeyRef.current ?? ("rfid-" + sessionId + "-" + crypto.randomUUID());
    idempotencyKeyRef.current = key;
    setPosting(true);
    setError("");
    setMessage("Submitting reads to the factory-scoped RFID reconciliation API…");
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": key,
      };
      if (accessToken.trim()) headers.Authorization = "Bearer " + accessToken.trim();
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          reader_id: readerId.trim().toLowerCase(),
          session_id: sessionId,
          item_id: itemId.trim().toLowerCase(),
          location_id: locationId.trim().toLowerCase(),
          reads: captured,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = body && typeof body === "object" ? JSON.stringify(body) : "No structured error body.";
        throw new Error("RFID API returned HTTP " + response.status + ": " + detail);
      }
      if (!body || typeof body !== "object" || !Array.isArray(body.observations)) {
        throw new Error("RFID API response did not include the reconciliation observation ledger.");
      }
      setResult(body as ReconciliationResult);
      setMessage(
        "Reconciliation " + body.reconciliation_status + ": expected " + body.expected_quantity +
        ", observed " + body.observed_quantity + ", variance " + body.variance_quantity +
        ". Server suppressed " + body.duplicate_reads_suppressed + " repeat read(s).",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "RFID reconciliation request failed.");
      setMessage("Request outcome may be unknown. Retry this same captured payload to replay the same idempotency key.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 text-zinc-900 md:px-8">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">FactoryOS · WP02 · Device acceptance</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">RFID reader & quantity reconciliation</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
          Connect a compatible USB-serial EPC reader, capture raw tag reads, and send the immutable read set to the authenticated RFID reconciliation API. Capturing a tag never mutates stock.
        </p>
      </header>

      <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">1. Reader and inventory scope</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-600">
          This generic Web Serial adapter supports readers that output one hexadecimal EPC per line, optionally prefixed with EPC: or TAG=, or JSON containing an epc field. It does not claim support for proprietary reader protocols without a model-specific driver.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm font-medium">API origin
            <input value={apiOrigin} onChange={(event) => setApiOrigin(event.target.value)} placeholder="https://factory-api.example.com" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Bearer token (optional for cookie-authenticated deployments)
            <input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} autoComplete="off" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">RFID reader UUID (must stay stable across retries)
            <input value={readerId} onChange={(event) => setReaderId(event.target.value)} placeholder="reader UUID" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Serial baud rate
            <select value={baudRate} onChange={(event) => setBaudRate(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal">
              <option value="9600">9,600</option><option value="19200">19,200</option><option value="38400">38,400</option><option value="57600">57,600</option><option value="115200">115,200</option><option value="230400">230,400</option>
            </select>
          </label>
          <label className="text-sm font-medium">Target inventory item UUID
            <input value={itemId} onChange={(event) => setItemId(event.target.value)} placeholder="item UUID" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Target inventory location/bin UUID
            <input value={locationId} onChange={(event) => setLocationId(event.target.value)} placeholder="location UUID" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Site / warehouse code
            <input value={siteCode} onChange={(event) => setSiteCode(event.target.value)} placeholder="e.g. DHAKA-WH-01" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Test operator
            <input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} placeholder="operator or technician identifier" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Reader manufacturer
            <input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} placeholder="manufacturer" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Reader model
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="exact model / SKU" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Hardware serial number
            <input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} placeholder="hardware serial number" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
          <label className="text-sm font-medium">Reader firmware version
            <input value={firmwareVersion} onChange={(event) => setFirmwareVersion(event.target.value)} placeholder="firmware version" className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-normal" />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button disabled={connected || state === "CONNECTING" || posting} onClick={() => void connectReader()} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Connect & start inventory</button>
          <button disabled={!connected || posting} onClick={() => void disconnectReader()} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">Stop reader</button>
          <button disabled={connected || state === "CONNECTING" || posting} onClick={clearCapture} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">Clear / new session</button>
          <span className="rounded-full bg-zinc-100 px-3 py-2 text-sm font-semibold">{state.replace(/_/g, " ")}</span>
        </div>
        <p role="status" className="mt-3 text-sm text-zinc-700">{message}</p>
        {error && <p role="alert" className="mt-2 break-words rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {sessionId && <p className="mt-3 break-all text-xs text-zinc-500">Session: {sessionId}</p>}
      </section>

      <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">2. Captured reads and duplicate evidence</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-zinc-50 p-4"><p className="text-sm text-zinc-600">Raw EPC reads</p><p className="mt-1 text-2xl font-bold tabular-nums">{readCount}</p></div>
          <div className="rounded-xl bg-zinc-50 p-4"><p className="text-sm text-zinc-600">Distinct EPCs</p><p className="mt-1 text-2xl font-bold tabular-nums">{uniqueCount}</p></div>
          <div className="rounded-xl bg-zinc-50 p-4"><p className="text-sm text-zinc-600">Repeated reads</p><p className="mt-1 text-2xl font-bold tabular-nums">{duplicateCount}</p></div>
        </div>
        {ignoredCount > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><strong>{ignoredCount}</strong> non-EPC/status frame(s) ignored locally. Examples: {ignoredExamples.join(" · ")}</div>}
        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-600"><tr><th className="px-3 py-2">EPC</th><th className="px-3 py-2">Raw reads</th><th className="px-3 py-2">Duplicates</th></tr></thead>
            <tbody>
              {summary.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-zinc-500">No valid EPC reads captured yet.</td></tr>}
              {summary.map((entry) => <tr key={entry.epc} className="border-t border-zinc-100"><td className="break-all px-3 py-2 font-mono text-xs">{entry.epc}</td><td className="px-3 py-2 tabular-nums">{entry.readCount}</td><td className="px-3 py-2 tabular-nums">{entry.duplicateCount}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button disabled={!scopeReady || readCount < 1 || connected || posting} onClick={() => void submitReads()} className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{posting ? "Reconciling…" : "Submit reads & reconcile quantity"}</button>
          <p className="text-xs text-zinc-500">Sends the original reads, including repeats, so the server persists duplicate counts and unknown/wrong-item tag dispositions. Max 1,000 raw reads per request.</p>
        </div>
      </section>

      {result && (
        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-semibold">3. Server reconciliation result</h2><p className="mt-1 break-all text-xs text-zinc-500">Batch: {result.id}{result.replayed ? " · idempotent replay" : ""}</p></div>
            <span className={"rounded-full px-3 py-1 text-sm font-bold " + (result.reconciliation_status === "MATCHED" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>{result.reconciliation_status}</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-zinc-50 p-4"><p className="text-sm text-zinc-600">Expected at bin</p><p className="mt-1 text-xl font-bold tabular-nums">{result.expected_quantity}</p></div>
            <div className="rounded-xl bg-zinc-50 p-4"><p className="text-sm text-zinc-600">Observed from EPCs</p><p className="mt-1 text-xl font-bold tabular-nums">{result.observed_quantity}</p></div>
            <div className="rounded-xl bg-zinc-50 p-4"><p className="text-sm text-zinc-600">Variance</p><p className="mt-1 text-xl font-bold tabular-nums">{result.variance_quantity}</p></div>
          </div>
          <p className="mt-3 text-sm text-zinc-700">Matched tags: {result.matched_tag_count} · Excluded tags: {result.excluded_tag_count} · Duplicate reads suppressed by API: {result.duplicate_reads_suppressed}</p>
          <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-600"><tr><th className="px-3 py-2">EPC</th><th className="px-3 py-2">Disposition</th><th className="px-3 py-2">Observed qty</th><th className="px-3 py-2">Repeat reads</th></tr></thead>
              <tbody>
                {result.observations.map((observation) => <tr key={observation.epc} className="border-t border-zinc-100"><td className="break-all px-3 py-2 font-mono text-xs">{observation.epc}</td><td className="px-3 py-2"><span className={"rounded px-2 py-1 text-xs font-semibold " + (observation.disposition === "MATCHED" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>{observation.disposition}</span></td><td className="px-3 py-2 tabular-nums">{observation.observed_quantity}</td><td className="px-3 py-2 tabular-nums">{observation.duplicate_read_count}</td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">4. Hardware-in-the-loop acceptance record</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-600">Mark a scenario PASS/FAIL only after carrying it out on the target reader at the target site. These results are operator-reported and are not independently attested by this UI.</p>
        <div className="mt-4 space-y-3">
          {HIL_CASES.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border border-zinc-200 p-3 sm:grid-cols-[1fr_150px] sm:items-center">
            <div><p className="text-sm font-semibold">{item.label}</p><p className="mt-1 text-xs text-zinc-500">Evidence: {item.evidence}</p></div>
            <select aria-label={item.label + " result"} value={hilStatuses[item.id]} onChange={(event) => setHilStatuses((current) => ({ ...current, [item.id]: event.target.value as HILStatus }))} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm">
              <option value="NOT_RUN">NOT RUN</option><option value="PASS">PASS</option><option value="FAIL">FAIL</option>
            </select>
          </div>)}
        </div>
        <label className="mt-4 block text-sm font-medium">Test notes / evidence artifact references
          <textarea value={hilNotes} onChange={(event) => setHilNotes(event.target.value)} rows={4} placeholder="Record distance, tag placement, expected/actual values, photos/log names, defects and operator notes." className="mt-1 w-full rounded-lg border border-zinc-300 p-3 font-normal" />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={exportHardwareEvidence} disabled={connected || state === "CONNECTING" || posting} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Export HIL evidence JSON</button>
          <span className="text-xs text-zinc-500">Export includes hardware metadata, raw/unique EPC summary, server batch/observations and manually reported test results.</span>
        </div>
      </section>

      <footer className="mt-8 rounded-xl bg-zinc-100 p-4 text-sm leading-6 text-zinc-700">
        Device acceptance is not complete until the exact reader model/firmware, interface, serial protocol, site, browser and operator are recorded with known/unknown/wrong-item tag evidence and final quantity reconciliation. The page uses a physical Web Serial port at runtime, but repository CI uses a simulated serial stream; CI cannot certify hardware that was not connected during testing. This page does not persist hardware metadata as an attested API commissioning record; keep the exported artifact and approved physical evidence with the site release pack.
      </footer>
    </main>
  );
}
