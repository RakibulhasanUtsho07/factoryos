import test from "node:test";
import assert from "node:assert/strict";

import { WmsOfflineQueue, WmsOfflineQueueError } from "./wms-offline-queue.mjs";
import {
  WmsLabelRenderError, createWmsLabelScanResolver, normalizeScannedLabel, renderWmsLabel,
} from "./wms-label-renderer.mjs";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FACTORY = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const DEVICE = "WMS-HH-01";
const TX1 = "55555555-5555-4555-8555-555555555555";
const TX2 = "66666666-6666-4666-8666-666666666666";
const RECEIPT1 = "77777777-7777-4777-8777-777777777777";

class MemoryStore {
  constructor(seed = []) {
    this.entries = new Map(seed.map((entry) => [entry.key, structuredClone(entry)]));
  }
  async get(scopeKey, transactionId) {
    const value = this.entries.get(scopeKey + ":" + transactionId);
    return value ? structuredClone(value) : null;
  }
  async list(scopeKey) {
    return [...this.entries.values()].filter((entry) => entry.scopeKey === scopeKey).map((entry) => structuredClone(entry));
  }
  async put(entry) {
    this.entries.set(entry.key, structuredClone(entry));
    return structuredClone(entry);
  }
  async insertOrGet(entry) {
    const existing = this.entries.get(entry.key);
    if (existing) return { inserted: false, entry: structuredClone(existing) };
    this.entries.set(entry.key, structuredClone(entry));
    return { inserted: true, entry: structuredClone(entry) };
  }
  async claimPending(scopeKey, now, leaseUntil, claimToken, batchSize, attemptedAt) {
    const eligible = [...this.entries.values()]
      .filter((entry) => {
        const activeClaim = typeof entry.syncClaimToken === "string"
          && entry.syncClaimToken.length > 0
          && Number(entry.syncClaimUntil ?? 0) > now;
        return entry.scopeKey === scopeKey
          && entry.status === "PENDING"
          && Number(entry.nextRetryAt ?? 0) <= now
          && !activeClaim;
      })
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.transactionId.localeCompare(b.transactionId))
      .slice(0, batchSize)
      .map((entry) => ({
        ...entry,
        attemptCount: Number(entry.attemptCount ?? 0) + 1,
        lastAttemptAt: attemptedAt,
        updatedAt: attemptedAt,
        syncClaimToken: claimToken,
        syncClaimUntil: leaseUntil,
      }));
    for (const entry of eligible) this.entries.set(entry.key, structuredClone(entry));
    return structuredClone(eligible);
  }
  async updateClaimed(scopeKey, transactionId, claimToken, now, updates) {
    const key = scopeKey + ":" + transactionId;
    const entry = this.entries.get(key);
    if (!entry || entry.syncClaimToken !== claimToken || Number(entry.syncClaimUntil ?? 0) <= now) return false;
    this.entries.set(key, structuredClone({ ...entry, ...updates, syncClaimToken: null, syncClaimUntil: 0 }));
    return true;
  }
  async removeClaimed(scopeKey, transactionId, claimToken, now) {
    const key = scopeKey + ":" + transactionId;
    const entry = this.entries.get(key);
    if (!entry || entry.syncClaimToken !== claimToken || Number(entry.syncClaimUntil ?? 0) <= now) return false;
    return this.entries.delete(key);
  }
  async remove(scopeKey, transactionId) {
    return this.entries.delete(scopeKey + ":" + transactionId);
  }
}

function scope(deviceId = DEVICE) {
  return { tenantId: TENANT, factoryId: FACTORY, userId: USER, deviceId };
}

function payload(id = TX1, values = {}) {
  return {
    client_transaction_id: id,
    operation: "STOCK_MOVEMENT",
    item_id: ITEM,
    movement_type: "ISSUE",
    quantity: 2,
    expected_balance_version: "1",
    notes: "offline pick",
    ...values,
  };
}

function applied(id, receipt = RECEIPT1, operation = "STOCK_MOVEMENT") {
  return { client_transaction_id: id, receipt_id: receipt, operation, status: "APPLIED", replayed: false };
}

function errorCode(code) {
  return (error) => error instanceof WmsOfflineQueueError || error instanceof WmsLabelRenderError
    ? error.code === code
    : false;
}

test("offline queue is durable across queue instances and prevents transaction-ID payload reuse", async () => {
  const store = new MemoryStore();
  const queueA = new WmsOfflineQueue({ store, now: () => Date.parse("2026-10-26T00:00:00.000Z") });
  const first = await queueA.enqueue(scope(), payload());
  const duplicate = await queueA.enqueue(scope(), payload());
  assert.equal(duplicate.transactionId, first.transactionId);
  await assert.rejects(queueA.enqueue(scope(), payload(TX1, { quantity: 3 })), errorCode("TRANSACTION_ID_REUSED"));

  const queueAfterReload = new WmsOfflineQueue({ store });
  const restored = await queueAfterReload.list(scope());
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, "PENDING");
  assert.equal(restored[0].payload.quantity, 2);
});

test("only an exact matching APPLIED transaction receipt removes a queued operation", async () => {
  const store = new MemoryStore();
  let clock = Date.parse("2026-10-26T00:00:00.000Z");
  const queue = new WmsOfflineQueue({ store, now: () => clock });
  await queue.enqueue(scope(), payload());
  const invalidAck = await queue.flush(scope(), async () => ({ results: [ applied(TX2) ] }), { baseRetryMs: 100, maxRetryMs: 100 });
  assert.equal(invalidAck.syncedCount, 0);
  assert.equal((await queue.list(scope()))[0].status, "PENDING");
  assert.equal((await queue.list(scope()))[0].lastError, "MISSING_OR_MISMATCHED_TRANSACTION_RECEIPT");

  clock += 101;
  const wrongOperation = await queue.flush(scope(), async () => ({ results: [ { ...applied(TX1), operation: "OTHER" } ] }), { baseRetryMs: 100, maxRetryMs: 100 });
  assert.equal(wrongOperation.syncedCount, 0);
  assert.equal((await queue.list(scope()))[0].status, "PENDING");

  clock += 101;
  const malformedReceipt = await queue.flush(scope(), async () => ({ results: [ { ...applied(TX1), receipt_id: "not-a-uuid" } ] }), { baseRetryMs: 100, maxRetryMs: 100 });
  assert.equal(malformedReceipt.syncedCount, 0);
  assert.equal((await queue.list(scope()))[0].status, "PENDING");

  clock += 101;
  const acknowledged = await queue.flush(scope(), async () => ({ results: [ applied(TX1) ] }), { baseRetryMs: 100, maxRetryMs: 100 });
  assert.equal(acknowledged.syncedCount, 1);
  assert.equal((await queue.list(scope())).length, 0);
});

test("conflict resolution parks server receipt and requires a new client transaction ID", async () => {
  const store = new MemoryStore();
  const queue = new WmsOfflineQueue({ store, now: () => Date.parse("2026-10-26T00:00:00.000Z") });
  await queue.enqueue(scope(), payload());
  const result = await queue.flush(scope(), async () => ({
    results: [{ client_transaction_id: TX1, receipt_id: RECEIPT1, operation: "STOCK_MOVEMENT", status: "CONFLICT", error: { message: "stale balance version" } }],
  }));
  assert.equal(result.conflictCount, 1);
  assert.equal((await queue.list(scope()))[0].status, "CONFLICT");
  await assert.rejects(queue.resolveConflict(scope(), TX1, payload(TX1, { expected_balance_version: "2" })), errorCode("NEW_TRANSACTION_ID_REQUIRED"));
  const resolution = await queue.resolveConflict(scope(), TX1, payload(TX2, { expected_balance_version: "2" }));
  assert.equal(resolution.replacement.transactionId, TX2);
  let entries = await queue.list(scope());
  assert.deepEqual(entries.map((entry) => entry.status).sort(), ["PENDING", "RESOLVED"]);
  const synced = await queue.flush(scope(), async () => ({ results: [applied(TX2, "88888888-8888-4888-8888-888888888888")] }));
  assert.equal(synced.syncedCount, 1);
  entries = await queue.list(scope());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "RESOLVED");
});

test("network retry retains queue and backs off rather than dropping an unconfirmed operation", async () => {
  const store = new MemoryStore();
  let clock = Date.parse("2026-10-26T00:00:00.000Z");
  const queue = new WmsOfflineQueue({ store, now: () => clock });
  await queue.enqueue(scope(), payload());
  const failed = await queue.flush(scope(), async () => { throw new Error("network disconnected"); }, { baseRetryMs: 500, maxRetryMs: 5000 });
  assert.equal(failed.transportError, "network disconnected");
  assert.equal((await queue.list(scope()))[0].attemptCount, 1);
  assert.equal((await queue.list(scope()))[0].status, "PENDING");

  let sendCount = 0;
  const premature = await queue.flush(scope(), async () => { sendCount += 1; return { results: [applied(TX1)] }; }, { baseRetryMs: 500, maxRetryMs: 5000 });
  assert.equal(sendCount, 0);
  assert.equal(premature.sentCount, 0);
  assert.equal(premature.retryAt, clock + 500);

  clock += 501;
  const recovered = await queue.flush(scope(), async () => { sendCount += 1; return { results: [applied(TX1)] }; }, { baseRetryMs: 500, maxRetryMs: 5000 });
  assert.equal(sendCount, 1);
  assert.equal(recovered.syncedCount, 1);
  assert.equal((await queue.list(scope())).length, 0);
});

test("duplicate and mismatched response receipts are never treated as terminal acknowledgements", async () => {
  const store = new MemoryStore();
  const queue = new WmsOfflineQueue({ store, now: () => Date.parse("2026-10-26T00:00:00.000Z") });
  await queue.enqueue(scope(), payload());
  const duplicateResponse = await queue.flush(scope(), async () => ({ results: [applied(TX1), applied(TX1, "99999999-9999-4999-8999-999999999999")] }));
  assert.equal(duplicateResponse.syncedCount, 0);
  assert.equal((await queue.list(scope()))[0].status, "PENDING");
});

test("concurrent queue instances atomically claim a pending sync batch once", async () => {
  const store = new MemoryStore();
  const now = Date.parse("2026-10-26T00:00:00.000Z");
  const queueA = new WmsOfflineQueue({ store, now: () => now });
  const queueB = new WmsOfflineQueue({ store, now: () => now });
  await queueA.enqueue(scope(), payload());

  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  let finishFirst;
  const firstResponse = new Promise((resolve) => { finishFirst = resolve; });
  const firstFlush = queueA.flush(scope(), async (body) => {
    announceFirst(body);
    return firstResponse;
  }, { claimLeaseMs: 10000, createClaimToken: () => "claim-tab-a" });

  const firstBody = await firstStarted;
  assert.equal(firstBody.transactions.length, 1);
  assert.equal(firstBody.transactions[0].client_transaction_id, TX1);

  let secondSendCount = 0;
  const secondResult = await queueB.flush(scope(), async () => {
    secondSendCount += 1;
    return { results: [applied(TX1)] };
  }, { claimLeaseMs: 10000, createClaimToken: () => "claim-tab-b" });

  assert.equal(secondSendCount, 0);
  assert.equal(secondResult.sentCount, 0);
  assert.equal(secondResult.retryAt, now + 10000);
  assert.equal((await queueB.list(scope()))[0].syncClaimToken, "claim-tab-a");

  finishFirst({ results: [applied(TX1)] });
  const firstResult = await firstFlush;
  assert.equal(firstResult.syncedCount, 1);
  assert.equal((await queueA.list(scope())).length, 0);
});

test("expired claim can be reclaimed and a stale sync response cannot overwrite the new owner", async () => {
  const store = new MemoryStore();
  let clock = Date.parse("2026-10-26T00:00:00.000Z");
  const queueA = new WmsOfflineQueue({ store, now: () => clock });
  const queueB = new WmsOfflineQueue({ store, now: () => clock });
  await queueA.enqueue(scope(), payload());

  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  let finishFirst;
  const firstResponse = new Promise((resolve) => { finishFirst = resolve; });
  const firstFlush = queueA.flush(scope(), async () => {
    announceFirst();
    return firstResponse;
  }, { claimLeaseMs: 1000, createClaimToken: () => "expired-owner" });
  await firstStarted;

  clock += 1001;
  let announceSecond;
  const secondStarted = new Promise((resolve) => { announceSecond = resolve; });
  let finishSecond;
  const secondResponse = new Promise((resolve) => { finishSecond = resolve; });
  const secondFlush = queueB.flush(scope(), async () => {
    announceSecond();
    return secondResponse;
  }, { claimLeaseMs: 1000, createClaimToken: () => "replacement-owner" });
  await secondStarted;

  finishFirst({ results: [applied(TX1)] });
  const staleResult = await firstFlush;
  assert.equal(staleResult.syncedCount, 0);
  assert.equal((await queueA.list(scope()))[0].syncClaimToken, "replacement-owner");

  finishSecond({ results: [applied(TX1)] });
  const currentResult = await secondFlush;
  assert.equal(currentResult.syncedCount, 1);
  assert.equal((await queueA.list(scope())).length, 0);
});

function labelIssue(symbology = "QR", overrides = {}) {
  const identity = {
    schema: "factoryos.traceability-label/v1",
    identity_type: "TRACEABILITY_UNIT",
    unit_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    unit_code: "LOT-TEST-01",
    barcode_value: "LOT-TEST-01",
    product_role: "FINISHED_GOOD",
    status: "ACTIVE",
    ...overrides.identity,
  };
  return {
    symbology,
    barcode_value: "LOT-TEST-01",
    copy_count: 2,
    label_layout: { page: { width_mm: 50, height_mm: 30 }, fields: ["unit_code", "barcode_value", "product_role", "status"] },
    encoded_payload: identity,
    ...overrides.issue,
  };
}

test("QR renderer emits a real local SVG and self-contained print document with lifecycle status and copies", () => {
  const rendered = renderWmsLabel(labelIssue("QR"));
  assert.match(rendered.svg, /^<svg\b/);
  assert.match(rendered.svg, /path|rect/);
  assert.match(rendered.svg, /aria-label=/);
  assert.match(rendered.print_html, /@page\{size:50mm 30mm;margin:0\}/);
  assert.match(rendered.print_html, /ACTIVE/);
  assert.equal((rendered.print_html.match(/data-copy=/g) ?? []).length, 2);
  assert.match(rendered.svg_data_uri, /^data:image\/svg\+xml;charset=utf-8,/);
});

test("Code 128 renderer creates bars and rejects non-printable values", () => {
  const rendered = renderWmsLabel(labelIssue("CODE128"));
  assert.match(rendered.svg, /<rect/);
  assert.match(rendered.svg, /role="img"/);
  assert.match(rendered.svg, /LOT-TEST-01/);
  assert.throws(() => renderWmsLabel(labelIssue("CODE128", { identity: { barcode_value: "LOT-TEST-" + String.fromCharCode(10) + "BAD" }, issue: { barcode_value: "LOT-TEST-" + String.fromCharCode(10) + "BAD" } })), errorCode("INVALID_LABEL_VALUE"));
});

test("Data Matrix ECC 200 renders a deterministic SVG and preserves the print contract", () => {
  const rendered = withSvgDocumentStub(() => renderWmsLabel(labelIssue("DATAMATRIX")));
  const replayed = withSvgDocumentStub(() => renderWmsLabel(labelIssue("DATAMATRIX")));
  assert.equal(rendered.symbology, "DATAMATRIX");
  assert.ok(rendered.svg.startsWith("<svg"));
  assert.match(rendered.svg, /shape-rendering="crispEdges"/);
  assert.match(rendered.svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(rendered.svg, /<path/);
  assert.match(rendered.svg, /role="img"/);
  assert.match(rendered.svg, /aria-label="DATAMATRIX label LOT-TEST-01; status ACTIVE"/);
  assert.match(rendered.print_html, /DATAMATRIX label LOT-TEST-01/);
  assert.match(rendered.print_html, /ACTIVE/);
  assert.equal((rendered.print_html.match(/data-copy=/g) ?? []).length, 2);
  assert.equal(rendered.svg, replayed.svg);
  assert.match(rendered.svg_data_uri, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.throws(() => renderWmsLabel(labelIssue("DATAMATRIX", {
    identity: { barcode_value: "OTHER" },
    issue: { barcode_value: "LOT-TEST-01" },
  })), errorCode("LABEL_IDENTITY_MISMATCH"));
});

test("GS1-128 encodes FNC1 start/separators and validates the supported AI profile", () => {
  const value = "(10)LOT-01(01)09506000134352";
  const rendered = renderWmsLabel(labelIssue("GS1_128", {
    identity: { barcode_value: value, unit_code: value },
    issue: { barcode_value: value },
  }));
  assert.match(rendered.svg, /viewBox="0 0 341 82"/);
  assert.match(rendered.svg, /LOT-01\(01\)09506000134352/);
  assert.equal(rendered.symbology, "GS1_128");
  assert.match(rendered.print_html, /GS1_128 label/);

  const withValidDate = "(01)09506000134352(17)270101(10)LOT-01";
  assert.match(renderWmsLabel(labelIssue("GS1_128", {
    identity: { barcode_value: withValidDate, unit_code: withValidDate },
    issue: { barcode_value: withValidDate },
  })).svg, /<rect/);

  const invalid = (badValue) => renderWmsLabel(labelIssue("GS1_128", {
    identity: { barcode_value: badValue, unit_code: badValue },
    issue: { barcode_value: badValue },
  }));
  assert.throws(() => invalid("(99)ABC"), errorCode("UNSUPPORTED_GS1_AI"));
  assert.throws(() => invalid("(01)09506000134353"), errorCode("INVALID_GS1_CHECK_DIGIT"));
  assert.throws(() => invalid("(17)271399"), errorCode("INVALID_GS1_DATE"));
  assert.throws(() => invalid("(10)LOT(21)SERIAL(10)DUPLICATE"), errorCode("DUPLICATE_GS1_AI"));
  assert.throws(() => invalid("(10)LOT(01)09506000134353"), errorCode("INVALID_GS1_CHECK_DIGIT"));
  assert.throws(() => invalid("(10)" + "A".repeat(20) + "(21)" + "B".repeat(20) + "(01)09506000134352"), errorCode("GS1_128_TOO_LONG"));
});

test("GS1-128 supports bounded measurement AI families with six numeric data characters", () => {
  const renderGs1 = (value) => renderWmsLabel(labelIssue("GS1_128", {
    identity: { barcode_value: value, unit_code: value },
    issue: { barcode_value: value },
  }));

  const netWeight = "(01)09506000134352(3102)001250";
  const renderedWeight = renderGs1(netWeight);
  assert.equal(renderedWeight.symbology, "GS1_128");
  assert.match(renderedWeight.svg, /viewBox="0 0 352 82"/);
  assert.match(renderedWeight.print_html, /001250/);

  const variableLotThenGrossWeight = "(10)LOT-01(3300)000125";
  const renderedLot = renderGs1(variableLotThenGrossWeight);
  assert.equal(renderedLot.encoded_value, variableLotThenGrossWeight);
  assert.match(renderedLot.svg, /viewBox="0 0 275 82"/);

  const pounds = "(3205)000125";
  assert.match(renderGs1(pounds).svg, /<rect/);

  assert.throws(() => renderGs1("(3106)001250"), errorCode("UNSUPPORTED_GS1_AI"));
  assert.throws(() => renderGs1("(3102)12AB50"), errorCode("INVALID_GS1_FIELD_FORMAT"));
  assert.throws(() => renderGs1("(3300)00125"), errorCode("INVALID_GS1_FIELD_LENGTH"));
});

test("label rendering fails closed for bad identity, status, geometry, and copy count", () => {
  assert.throws(() => renderWmsLabel(labelIssue("QR", { identity: { barcode_value: "OTHER" } })), errorCode("LABEL_IDENTITY_MISMATCH"));
  assert.throws(() => renderWmsLabel(labelIssue("QR", { identity: { status: "UNKNOWN" } })), errorCode("INVALID_IDENTITY_STATUS"));
  assert.throws(() => renderWmsLabel(labelIssue("QR", { issue: { copy_count: 101 } })), errorCode("INVALID_COPY_COUNT"));
  assert.throws(() => renderWmsLabel(labelIssue("QR", { issue: { label_layout: { page: { width_mm: 5, height_mm: 30 } } } })), errorCode("INVALID_LABEL_WIDTH"));
  const issued = labelIssue("QR");
  assert.throws(() => renderWmsLabel(issued, { currentIdentity: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", unit_code: "LOT-TEST-01", status: "RECALLED" } }), errorCode("STALE_LABEL_STATUS"));
});

test("scan normalization rejects blank/control data and resolver rejects unknown or ambiguous factory codes", async () => {
  assert.equal(normalizeScannedLabel(" lot-test-01" + String.fromCharCode(13, 10)), "LOT-TEST-01");
  assert.throws(() => normalizeScannedLabel(" " + String.fromCharCode(10)), errorCode("INVALID_SCAN"));
  assert.throws(() => normalizeScannedLabel("LOT" + String.fromCharCode(0) + "TEST"), errorCode("INVALID_SCAN"));
  let calledUrl = "";
  const resolve = createWmsLabelScanResolver({
    endpoint: "https://factory.example/api/v1/traceability/labels/resolve",
    getAccessToken: () => "test-token",
    fetchImpl: async (url, init) => {
      calledUrl = url;
      assert.equal(init.headers.Authorization, "Bearer test-token");
      return { ok: true, status: 200, json: async () => ({ identity_type: "MATERIAL", identity: { sku: "LOT-TEST-01" } }) };
    },
  });
  const result = await resolve("lot-test-01" + String.fromCharCode(13));
  assert.equal(result.identity_type, "MATERIAL");
  assert.match(calledUrl, /code=LOT-TEST-01/);
  const unknown = createWmsLabelScanResolver({
    endpoint: "https://factory.example/api/v1/traceability/labels/resolve",
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  await assert.rejects(unknown("UNKNOWN-CODE"), errorCode("UNKNOWN_LABEL"));
  const ambiguous = createWmsLabelScanResolver({
    endpoint: "https://factory.example/api/v1/traceability/labels/resolve",
    fetchImpl: async () => ({ ok: false, status: 409 }),
  });
  await assert.rejects(ambiguous("DUPLICATE-CODE"), errorCode("AMBIGUOUS_LABEL"));
});
