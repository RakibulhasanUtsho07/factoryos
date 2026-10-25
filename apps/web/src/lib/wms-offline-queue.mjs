const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_STATUSES = new Set(["APPLIED", "CONFLICT", "REJECTED"]);

export class WmsOfflineQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WmsOfflineQueueError";
    this.code = code;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeScope(scope) {
  const tenantId = String(scope?.tenantId ?? "").trim().toLowerCase();
  const factoryId = String(scope?.factoryId ?? "").trim().toLowerCase();
  const userId = String(scope?.userId ?? "").trim().toLowerCase();
  const deviceId = String(scope?.deviceId ?? "").trim();
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(factoryId) || !UUID_PATTERN.test(userId)) {
    throw new WmsOfflineQueueError("INVALID_SCOPE", "Tenant, factory, and user UUIDs are required to partition offline data.");
  }
  if (!DEVICE_PATTERN.test(deviceId)) {
    throw new WmsOfflineQueueError("INVALID_DEVICE_ID", "Device ID must match the WMS mobile API contract.");
  }
  return { tenantId, factoryId, userId, deviceId, key: JSON.stringify([tenantId, factoryId, userId, deviceId]) };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WmsOfflineQueueError("INVALID_TRANSACTION", "An offline transaction object is required.");
  }
  const id = String(payload.client_transaction_id ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw new WmsOfflineQueueError("INVALID_TRANSACTION_ID", "client_transaction_id must be a UUID.");
  }
  if (payload.operation !== "STOCK_MOVEMENT") {
    throw new WmsOfflineQueueError("UNSUPPORTED_OPERATION", "Only STOCK_MOVEMENT is supported by the current offline-sync API.");
  }
  if (!UUID_PATTERN.test(String(payload.item_id ?? "").trim().toLowerCase())) {
    throw new WmsOfflineQueueError("INVALID_ITEM_ID", "item_id must be a UUID.");
  }
  if (!["RECEIPT", "ISSUE"].includes(payload.movement_type)) {
    throw new WmsOfflineQueueError("INVALID_MOVEMENT_TYPE", "movement_type must be RECEIPT or ISSUE.");
  }
  if (!Number.isFinite(payload.quantity) || payload.quantity <= 0 || Math.abs(payload.quantity * 10000 - Math.round(payload.quantity * 10000)) > 0.000001) {
    throw new WmsOfflineQueueError("INVALID_QUANTITY", "quantity must be positive and have at most four decimal places.");
  }
  const version = String(payload.expected_balance_version ?? "").trim();
  if (!/^\d{1,19}$/.test(version) || BigInt(version) <= 0n) {
    throw new WmsOfflineQueueError("INVALID_BALANCE_VERSION", "expected_balance_version must be a positive integer string.");
  }
  if (payload.location_id !== undefined && !UUID_PATTERN.test(String(payload.location_id).trim().toLowerCase())) {
    throw new WmsOfflineQueueError("INVALID_LOCATION_ID", "location_id must be a UUID when supplied.");
  }
  return { ...cloneJson(payload), client_transaction_id: id, item_id: String(payload.item_id).trim().toLowerCase(), expected_balance_version: version };
}

function makeKey(scopeKey, transactionId) {
  return scopeKey + ":" + transactionId;
}

function retryDelay(attemptCount, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attemptCount - 1)));
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * IndexedDB-backed queue store. Each record is partitioned by authenticated
 * tenant, factory, user, and device; no stock operation is applied locally.
 */
export class IndexedDbWmsQueueStore {
  constructor(indexedDb = globalThis.indexedDB, databaseName = "factoryos-wms-mobile-v1") {
    if (!indexedDb) {
      throw new WmsOfflineQueueError("INDEXEDDB_UNAVAILABLE", "IndexedDB is unavailable in this browser.");
    }
    this.indexedDb = indexedDb;
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("transactions")) {
          const store = db.createObjectStore("transactions", { keyPath: "key" });
          store.createIndex("by_scope", "scopeKey", { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open WMS offline queue."));
      request.onblocked = () => reject(new Error("WMS offline queue upgrade is blocked by another open tab."));
    });
    return this.databasePromise;
  }

  async runTransaction(mode, schedule) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("transactions", mode);
      let value;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
      try {
        schedule(transaction.objectStore("transactions"), (next) => { value = next; });
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  get(scopeKey, transactionId) {
    return this.runTransaction("readonly", (store, set) => {
      const request = store.get(makeKey(scopeKey, transactionId));
      request.onsuccess = () => set(request.result ?? null);
    });
  }

  list(scopeKey) {
    return this.runTransaction("readonly", (store, set) => {
      const request = store.index("by_scope").getAll(scopeKey);
      request.onsuccess = () => set(request.result ?? []);
    });
  }

  put(entry) {
    return this.runTransaction("readwrite", (store, set) => {
      const request = store.put(entry);
      request.onsuccess = () => set(entry);
    });
  }

  insertOrGet(entry) {
    return this.runTransaction("readwrite", (store, set) => {
      const request = store.get(entry.key);
      request.onsuccess = () => {
        if (request.result) {
          set({ inserted: false, entry: request.result });
          return;
        }
        const insert = store.add(entry);
        insert.onsuccess = () => set({ inserted: true, entry });
      };
    });
  }

  remove(scopeKey, transactionId) {
    return this.runTransaction("readwrite", (store, set) => {
      const request = store.delete(makeKey(scopeKey, transactionId));
      request.onsuccess = () => set(true);
    });
  }
}

export class WmsOfflineQueue {
  constructor(options = {}) {
    this.store = options.store ?? new IndexedDbWmsQueueStore();
    this.now = options.now ?? (() => Date.now());
    this.flushes = new Map();
  }

  async enqueue(rawScope, rawPayload) {
    const scope = normalizeScope(rawScope);
    const payload = validatePayload(rawPayload);
    const createdAt = new Date(this.now()).toISOString();
    const entry = {
      key: makeKey(scope.key, payload.client_transaction_id),
      scopeKey: scope.key,
      deviceId: scope.deviceId,
      transactionId: payload.client_transaction_id,
      payload,
      status: "PENDING",
      attemptCount: 0,
      nextRetryAt: 0,
      queuedAt: createdAt,
      updatedAt: createdAt,
      lastAttemptAt: null,
      lastError: null,
      receiptId: null,
      resolvedByTransactionId: null,
    };
    const existing = await this.store.insertOrGet(entry);
    if (canonicalJson(existing.entry.payload) !== canonicalJson(payload)) {
      throw new WmsOfflineQueueError("TRANSACTION_ID_REUSED", "This client transaction ID already exists locally with a different payload.");
    }
    return existing.entry;
  }

  async list(rawScope) {
    const scope = normalizeScope(rawScope);
    const entries = await this.store.list(scope.key);
    return entries.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.transactionId.localeCompare(b.transactionId));
  }

  async flush(rawScope, sendBatch, options = {}) {
    const scope = normalizeScope(rawScope);
    if (typeof sendBatch !== "function") {
      throw new WmsOfflineQueueError("INVALID_TRANSPORT", "A batch transport function is required.");
    }
    const prior = this.flushes.get(scope.key);
    if (prior) return prior;
    const promise = this.flushOneBatch(scope, sendBatch, options).finally(() => this.flushes.delete(scope.key));
    this.flushes.set(scope.key, promise);
    return promise;
  }

  async flushOneBatch(scope, sendBatch, options) {
    const now = this.now();
    const batchSize = Math.max(1, Math.min(100, Math.floor(options.batchSize ?? 100)));
    const baseRetryMs = Math.max(100, options.baseRetryMs ?? 1000);
    const maxRetryMs = Math.max(baseRetryMs, options.maxRetryMs ?? 60000);
    const current = await this.store.list(scope.key);
    const pending = current
      .filter((entry) => entry.status === "PENDING" && Number(entry.nextRetryAt ?? 0) <= now)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .slice(0, batchSize);
    if (pending.length === 0) {
      return { sentCount: 0, syncedCount: 0, conflictCount: 0, rejectedCount: 0, pendingCount: current.filter((x) => x.status === "PENDING").length, parkedCount: current.filter((x) => x.status === "CONFLICT" || x.status === "REJECTED").length, retryAt: null };
    }

    const attemptedAt = new Date(now).toISOString();
    const attempted = [];
    for (const entry of pending) {
      const updated = { ...entry, attemptCount: entry.attemptCount + 1, lastAttemptAt: attemptedAt, updatedAt: attemptedAt };
      await this.store.put(updated);
      attempted.push(updated);
    }

    let response;
    try {
      response = await sendBatch({
        device_id: scope.deviceId,
        transactions: attempted.map((entry) => cloneJson(entry.payload)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network or API request failed.";
      const retryAt = this.now() + retryDelay(attempted[0].attemptCount, baseRetryMs, maxRetryMs);
      for (const entry of attempted) {
        await this.store.put({ ...entry, nextRetryAt: retryAt, lastError: message, updatedAt: new Date(this.now()).toISOString() });
      }
      const afterError = await this.store.list(scope.key);
      return {
        sentCount: attempted.length, syncedCount: 0, conflictCount: 0, rejectedCount: 0,
        pendingCount: afterError.filter((x) => x.status === "PENDING").length,
        parkedCount: afterError.filter((x) => x.status === "CONFLICT" || x.status === "REJECTED").length,
        retryAt, transportError: message,
      };
    }

    if (!response || !Array.isArray(response.results)) {
      const retryAt = this.now() + retryDelay(attempted[0].attemptCount, baseRetryMs, maxRetryMs);
      for (const entry of attempted) {
        await this.store.put({ ...entry, nextRetryAt: retryAt, lastError: "INVALID_SYNC_RESPONSE", updatedAt: new Date(this.now()).toISOString() });
      }
      const afterInvalid = await this.store.list(scope.key);
      return {
        sentCount: attempted.length, syncedCount: 0, conflictCount: 0, rejectedCount: 0,
        pendingCount: afterInvalid.filter((x) => x.status === "PENDING").length,
        parkedCount: afterInvalid.filter((x) => x.status === "CONFLICT" || x.status === "REJECTED").length,
        retryAt, transportError: "INVALID_SYNC_RESPONSE",
      };
    }

    const grouped = new Map();
    for (const result of response.results) {
      const id = String(result?.client_transaction_id ?? "").trim().toLowerCase();
      if (!isUuid(id)) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(result);
    }

    let syncedCount = 0;
    let conflictCount = 0;
    let rejectedCount = 0;
    for (const entry of attempted) {
      const matches = grouped.get(entry.transactionId) ?? [];
      const result = matches.length === 1 ? matches[0] : null;
      if (result && result.status === "APPLIED" && isUuid(result.receipt_id) && result.operation === entry.payload.operation) {
        await this.store.remove(scope.key, entry.transactionId);
        syncedCount += 1;
        continue;
      }
      if (result && result.operation === entry.payload.operation && (result.status === "CONFLICT" || result.status === "REJECTED") && isUuid(result.receipt_id)) {
        const status = result.status;
        await this.store.put({
          ...entry,
          status,
          receiptId: result.receipt_id,
          nextRetryAt: 0,
          lastError: String(result.error?.message ?? result.result?.message ?? result.error?.code ?? status),
          serverReceiptOperation: String(result.operation ?? ""),
          serverReceiptMatchesOperation: result.operation === entry.payload.operation,
          updatedAt: new Date(this.now()).toISOString(),
        });
        if (status === "CONFLICT") conflictCount += 1;
        else rejectedCount += 1;
        continue;
      }
      const retryAt = this.now() + retryDelay(entry.attemptCount, baseRetryMs, maxRetryMs);
      const reason = matches.length > 1 ? "AMBIGUOUS_TRANSACTION_RECEIPT" : "MISSING_OR_MISMATCHED_TRANSACTION_RECEIPT";
      await this.store.put({ ...entry, nextRetryAt: retryAt, lastError: reason, updatedAt: new Date(this.now()).toISOString() });
    }

    const afterSync = await this.store.list(scope.key);
    return {
      sentCount: attempted.length,
      syncedCount,
      conflictCount,
      rejectedCount,
      pendingCount: afterSync.filter((x) => x.status === "PENDING").length,
      parkedCount: afterSync.filter((x) => x.status === "CONFLICT" || x.status === "REJECTED").length,
      retryAt: afterSync.filter((x) => x.status === "PENDING" && Number(x.nextRetryAt ?? 0) > this.now()).reduce((min, x) => min === null || x.nextRetryAt < min ? x.nextRetryAt : min, null),
    };
  }

  async resolveConflict(rawScope, originalTransactionId, replacementPayload) {
    const scope = normalizeScope(rawScope);
    const originalId = String(originalTransactionId ?? "").trim().toLowerCase();
    const original = await this.store.get(scope.key, originalId);
    if (!original) throw new WmsOfflineQueueError("QUEUE_ENTRY_NOT_FOUND", "The original queued transaction was not found.");
    if (!["CONFLICT", "REJECTED"].includes(original.status)) {
      throw new WmsOfflineQueueError("NOT_RESOLVABLE", "Only a server-confirmed conflict or rejection can be resolved this way.");
    }
    const replacement = validatePayload(replacementPayload);
    if (replacement.client_transaction_id === originalId) {
      throw new WmsOfflineQueueError("NEW_TRANSACTION_ID_REQUIRED", "Conflict resolution must use a new client transaction ID.");
    }
    const queuedReplacement = await this.enqueue(rawScope, replacement);
    await this.store.put({
      ...original,
      status: "RESOLVED",
      resolvedByTransactionId: queuedReplacement.transactionId,
      updatedAt: new Date(this.now()).toISOString(),
    });
    return { originalTransaction: originalId, replacement: queuedReplacement };
  }

  async discardParked(rawScope, transactionId) {
    const scope = normalizeScope(rawScope);
    const id = String(transactionId ?? "").trim().toLowerCase();
    const entry = await this.store.get(scope.key, id);
    if (!entry) return false;
    if (!["CONFLICT", "REJECTED", "RESOLVED"].includes(entry.status)) {
      throw new WmsOfflineQueueError("ACTIVE_ENTRY_CANNOT_BE_DISCARDED", "Pending operations cannot be discarded; resolve or synchronize them first.");
    }
    await this.store.remove(scope.key, id);
    return true;
  }
}

/**
 * Create a browser transport for POST /api/v1/wms/mobile/offline-sync/batches.
 * The caller supplies the fully configured endpoint so deployments can retain
 * their existing auth/base-path configuration; cookies and optional Bearer auth
 * are sent, never tenant/factory authority supplied in the request body.
 */
export function createWmsOfflineSyncTransport(options) {
  const endpoint = String(options?.endpoint ?? "").trim();
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (!endpoint || typeof fetchImpl !== "function") {
    throw new WmsOfflineQueueError("INVALID_TRANSPORT_CONFIG", "A configured offline-sync endpoint and fetch implementation are required.");
  }
  return async function sendBatch(body) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const token = await options?.getAccessToken?.();
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new WmsOfflineQueueError("WMS_SYNC_HTTP_ERROR", "Offline sync failed with HTTP " + response.status + ".");
    }
    return response.json();
  };
}
