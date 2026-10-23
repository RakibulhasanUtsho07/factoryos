import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SENSITIVE = /(secret|password|passwd|token|credential|authorization|private.?key|api.?key|access.?key)/i;
const MODES = new Set(['EDGE_OFFLINE', 'CLOUD_CONNECTED']);
const QUALITIES = new Set(['GOOD', 'UNCERTAIN', 'BAD']);
const MAX_RECEIPT_BYTES = 32768;

function error(code, message, retryable = false) {
  const result = new Error(message);
  result.code = code;
  result.retryable = retryable;
  return result;
}
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function normalize(value, label = 'value', depth = 0, ancestors = new Set()) {
  if (depth > 10) throw error('INVALID_BATCH', label + ' exceeds maximum nesting');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 2048) throw error('INVALID_BATCH', label + ' has an oversized string');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw error('INVALID_BATCH', label + ' must contain finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100 || ancestors.has(value)) throw error('INVALID_BATCH', label + ' has invalid array structure');
    ancestors.add(value);
    try { return value.map((entry, i) => normalize(entry, label + '[' + i + ']', depth + 1, ancestors)); }
    finally { ancestors.delete(value); }
  }
  if (!record(value) || ancestors.has(value)) throw error('INVALID_BATCH', label + ' must be plain JSON');
  const keys = Object.keys(value);
  if (keys.length > 100) throw error('INVALID_BATCH', label + ' has too many properties');
  ancestors.add(value);
  try {
    const out = Object.create(null);
    for (const key of keys.sort()) {
      if (!key.trim() || key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw error('INVALID_BATCH', label + ' has an unsafe property name');
      }
      if (SENSITIVE.test(key)) throw error('SENSITIVE_FIELD_REJECTED', label + ' cannot contain credential-like fields');
      out[key] = normalize(value[key], label + '.' + key, depth + 1, ancestors);
    }
    return out;
  } finally { ancestors.delete(value); }
}
function canonical(value) { return JSON.stringify(normalize(value)); }
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function integer(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(name + ' must be a positive integer no greater than ' + max);
  return value;
}
function validateBatch(input, maxBytes) {
  const batch = normalize(input, 'batch');
  if (!record(batch) || typeof batch.batch_key !== 'string' || !KEY.test(batch.batch_key)) {
    throw error('INVALID_BATCH', 'batch_key must contain 1 to 128 safe characters');
  }
  if (!Array.isArray(batch.observations) || batch.observations.length < 1 || batch.observations.length > 100) {
    throw error('INVALID_BATCH', 'observations must contain between 1 and 100 entries');
  }
  for (const [i, item] of batch.observations.entries()) {
    const label = 'observations[' + i + ']';
    if (!record(item) || typeof item.event_id !== 'string' || !UUID.test(item.event_id)) throw error('INVALID_BATCH', label + '.event_id must be a UUID');
    if (typeof item.signal_key !== 'string' || !SIGNAL.test(item.signal_key)) throw error('INVALID_BATCH', label + '.signal_key is invalid');
    if (typeof item.observed_at !== 'string' || !Number.isFinite(Date.parse(item.observed_at))) throw error('INVALID_BATCH', label + '.observed_at is invalid');
    if (!MODES.has(item.source_mode) || !QUALITIES.has(item.quality)) throw error('INVALID_BATCH', label + ' has invalid source_mode or quality');
    if (item.unit !== undefined && (typeof item.unit !== 'string' || item.unit.length > 32 || !/^[A-Za-z0-9%._/-]{1,32}$/.test(item.unit))) throw error('INVALID_BATCH', label + '.unit is invalid');
    if (item.sampling_interval_ms !== undefined && (!Number.isSafeInteger(item.sampling_interval_ms) || item.sampling_interval_ms < 0 || item.sampling_interval_ms > 86400000)) throw error('INVALID_BATCH', label + '.sampling_interval_ms is invalid');
    if (!record(item.payload)) throw error('INVALID_BATCH', label + '.payload must be an object');
  }
  const encoded = canonical(batch);
  if (Buffer.byteLength(encoded) > maxBytes) throw error('INVALID_BATCH', 'batch exceeds configured byte limit');
  return batch;
}
async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (e) { if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(e && e.code)) throw e; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

/** A single-process-owned, atomic file spool. A batch is removed only after a matching durable gateway receipt. */
export class DurableObservationSpool {
  constructor(directory, options = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('A spool directory is required');
    this.root = resolve(directory);
    this.pendingDir = join(this.root, 'pending');
    this.maxBatches = integer(options.maxBatches === undefined ? 1024 : options.maxBatches, 'maxBatches', 1000000);
    this.maxBytes = integer(options.maxBytes === undefined ? 64 * 1024 * 1024 : options.maxBytes, 'maxBytes', Number.MAX_SAFE_INTEGER);
    this.maxBatchBytes = integer(options.maxBatchBytes === undefined ? 1024 * 1024 : options.maxBatchBytes, 'maxBatchBytes', 16 * 1024 * 1024);
    this.mutationTail = Promise.resolve();
    this.flushPromise = null;
  }

  async pending() {
    return this.withMutation(async () => (await this.readQueue()).map((item) => ({
      batch_key: item.envelope.batchKey,
      sequence: item.envelope.sequence,
      queued_at: item.envelope.queuedAt,
      byte_length: item.byteLength,
      payload_sha256: item.envelope.payloadHash,
    })));
  }

  async enqueue(input) {
    const batch = validateBatch(input, this.maxBatchBytes);
    const payload = canonical(batch);
    const payloadHash = sha256(payload);
    return this.withMutation(async () => {
      await this.ensureDirectories();
      const queue = await this.readQueue();
      const prior = queue.find((item) => item.envelope.batchKey === batch.batch_key);
      if (prior) {
        if (prior.envelope.payloadHash !== payloadHash) throw error('BATCH_KEY_REUSE', 'batch_key already exists with different content');
        return { queued: false, idempotent: true, batch_key: batch.batch_key, sequence: prior.envelope.sequence, payload_sha256: payloadHash };
      }
      if (queue.length >= this.maxBatches || queue.reduce((n, item) => n + item.byteLength, 0) > this.maxBytes) {
        throw error('SPOOL_CAPACITY', 'Spool capacity exceeded; queued batches were retained');
      }
      const envelope = {
        version: 1,
        sequence: queue.reduce((n, item) => Math.max(n, item.envelope.sequence), 0) + 1,
        queuedAt: new Date().toISOString(),
        batchKey: batch.batch_key,
        payloadHash,
        batch,
      };
      const serialized = JSON.stringify(envelope);
      const bytes = Buffer.byteLength(serialized);
      if (queue.reduce((n, item) => n + item.byteLength, 0) + bytes > this.maxBytes) {
        throw error('SPOOL_CAPACITY', 'Spool byte limit would be exceeded; queued batches were retained');
      }
      const target = join(this.pendingDir, sha256(batch.batch_key) + '.json');
      const temp = join(this.pendingDir, '.' + randomUUID() + '.tmp');
      let handle;
      try {
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temp, target);
        await syncDirectory(this.pendingDir);
      } catch (e) {
        if (handle) await handle.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
        throw e;
      }
      return { queued: true, idempotent: false, batch_key: batch.batch_key, sequence: envelope.sequence, payload_sha256: payloadHash };
    });
  }

  async flush(send, options = {}) {
    if (typeof send !== 'function') throw new TypeError('flush requires a send(batch) function');
    if (this.flushPromise) return this.flushPromise;
    const attempts = integer(options.maxAttempts === undefined ? 3 : options.maxAttempts, 'maxAttempts', 10);
    const baseDelay = integer(options.baseDelayMs === undefined ? 250 : options.baseDelayMs, 'baseDelayMs', 60000);
    const sleep = options.sleep || ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.flushPromise = this.flushInternal(send, attempts, baseDelay, sleep).finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async flushInternal(send, attempts, baseDelay, sleep) {
    let acknowledged = 0;
    while (true) {
      const entry = await this.withMutation(async () => (await this.readQueue())[0] || null);
      if (!entry) return { acknowledged, retained: 0, next_batch_key: null };
      let lastError;
      let receipt;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          receipt = await send(entry.envelope.batch);
          this.assertReceipt(receipt, entry.envelope);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (e && e.retryable === false) break;
          if (attempt < attempts) await sleep(Math.min(baseDelay * (2 ** (attempt - 1)), 30000));
        }
      }
      if (lastError) return { acknowledged, retained: (await this.pending()).length, next_batch_key: entry.envelope.batchKey, error_code: lastError.code || 'SEND_FAILED' };
      await this.withMutation(async () => {
        const current = await this.readEnvelope(entry.path);
        if (current.envelope.batchKey !== entry.envelope.batchKey || current.envelope.payloadHash !== entry.envelope.payloadHash) {
          throw error('SPOOL_INTEGRITY_FAILURE', 'Queued batch changed while being acknowledged');
        }
        await rm(entry.path);
        await syncDirectory(this.pendingDir);
      });
      acknowledged += 1;
      void receipt;
    }
  }

  assertReceipt(receipt, envelope) {
    const summary = receipt && receipt.summary;
    if (!receipt || typeof receipt.idempotent !== 'boolean' || !summary ||
      summary.batchKey !== envelope.batchKey ||
      summary.observationsReceived !== envelope.batch.observations.length ||
      !Number.isSafeInteger(summary.observationsInserted) || summary.observationsInserted < 0 ||
      !Number.isSafeInteger(summary.observationsDeduplicated) || summary.observationsDeduplicated < 0 ||
      summary.observationsInserted + summary.observationsDeduplicated !== summary.observationsReceived) {
      throw error('INVALID_RECEIPT', 'Gateway receipt did not acknowledge this exact batch', false);
    }
  }

  async ensureDirectories() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw error('SPOOL_DIRECTORY_INVALID', 'Spool root must be a real directory');
    await chmod(this.root, 0o700);
    await mkdir(this.pendingDir, { recursive: true, mode: 0o700 });
    const pendingStat = await lstat(this.pendingDir);
    if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink()) throw error('SPOOL_DIRECTORY_INVALID', 'Pending path must be a real directory');
    await chmod(this.pendingDir, 0o700);
  }

  async readQueue() {
    await this.ensureDirectories();
    const names = await readdir(this.pendingDir);
    const entries = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      entries.push(await this.readEnvelope(join(this.pendingDir, name)));
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw error('SPOOL_INTEGRITY_FAILURE', 'Unexpected queue filename');
      if (name !== sha256(entries[entries.length - 1].envelope.batchKey) + '.json') throw error('SPOOL_INTEGRITY_FAILURE', 'Queue filename does not match batch key');
    }
    entries.sort((a, b) => a.envelope.sequence - b.envelope.sequence);
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i - 1].envelope.sequence === entries[i].envelope.sequence) throw error('SPOOL_INTEGRITY_FAILURE', 'Duplicate queue sequence');
    }
    return entries;
  }

  async readEnvelope(path) {
    let details;
    try { details = await lstat(path); }
    catch (e) { if (e && e.code === 'ENOENT') throw error('SPOOL_INTEGRITY_FAILURE', 'Queue entry disappeared unexpectedly'); throw e; }
    if (!details.isFile() || details.isSymbolicLink()) throw error('SPOOL_INTEGRITY_FAILURE', 'Queue entries must be regular files');
    const raw = await readFile(path, 'utf8');
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw error('SPOOL_INTEGRITY_FAILURE', 'Queue entry is not valid JSON'); }
    if (!record(envelope) || envelope.version !== 1 || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
      typeof envelope.queuedAt !== 'string' || !Number.isFinite(Date.parse(envelope.queuedAt)) ||
      typeof envelope.batchKey !== 'string' || typeof envelope.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.payloadHash)) {
      throw error('SPOOL_INTEGRITY_FAILURE', 'Queue envelope is incomplete or unsupported');
    }
    const batch = validateBatch(envelope.batch, this.maxBatchBytes);
    if (batch.batch_key !== envelope.batchKey || sha256(canonical(batch)) !== envelope.payloadHash) {
      throw error('SPOOL_INTEGRITY_FAILURE', 'Queue entry failed SHA-256 integrity verification');
    }
    return { path, envelope: { ...envelope, batch }, byteLength: Buffer.byteLength(raw) };
  }

  async withMutation(operation) {
    const previous = this.mutationTail;
    let release;
    this.mutationTail = new Promise((resolveRelease) => { release = resolveRelease; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

/** Create a bounded sender for POST /api/v2/edge/device-ingest/:deviceId. */
export function createEdgeGatewaySender(options = {}) {
  const baseUrl = options.baseUrl;
  const deviceId = options.deviceId;
  const token = options.token;
  const timeoutMs = options.timeoutMs === undefined ? 5000 : integer(options.timeoutMs, 'timeoutMs', 30000);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof baseUrl !== 'string' || !baseUrl.trim() || typeof deviceId !== 'string' || !UUID.test(deviceId)) throw new TypeError('baseUrl and a UUID deviceId are required');
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('A device credential token is required');
  if (timeoutMs < 100) throw new TypeError('timeoutMs must be at least 100 milliseconds');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be an absolute URL'); }
  if (base.username || base.password || base.search || base.hash) throw new TypeError('baseUrl cannot contain credentials, query or fragment');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  const localHttp = options.allowInsecureLocalhost === true && process.env.NODE_ENV !== 'production' && local && base.protocol === 'http:';
  if (base.protocol !== 'https:' && !localHttp) throw new TypeError('HTTPS is required outside explicit local development');
  const endpoint = new URL(base.pathname.replace(/\/+$/, '') + '/api/v2/edge/device-ingest/' + deviceId, base.origin);
  return async function sendBatch(input) {
    const batch = validateBatch(input, 1024 * 1024);
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(batch),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw error('GATEWAY_UNAVAILABLE', e instanceof Error ? e.message : 'Gateway request failed', true);
    }
    if (!response.ok) throw error('HTTP_' + response.status, 'Edge gateway returned HTTP ' + response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    const declaredLength = Number(response.headers && response.headers.get && response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RECEIPT_BYTES) throw error('INVALID_RECEIPT', 'Gateway receipt exceeds size limit');
    let body;
    try { body = await response.text(); } catch { throw error('INVALID_RECEIPT', 'Gateway receipt could not be read'); }
    if (Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw error('INVALID_RECEIPT', 'Gateway receipt exceeds size limit');
    try { return JSON.parse(body); } catch { throw error('INVALID_RECEIPT', 'Gateway returned a non-JSON receipt'); }
  };
}
