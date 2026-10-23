import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAGIC = 'FACTORYOS-OT-EDGE-SPOOL-V1:';
const MAX_BATCH = 20;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function isNotFound(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scopeKey(scope) {
  return scope.tenant_id + ':' + scope.factory_id + ':' + scope.device_id;
}

function validateScope(scope) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const key of ['tenant_id', 'factory_id', 'device_id']) {
    if (typeof scope?.[key] !== 'string' || !uuid.test(scope[key])) {
      throw new Error('OT edge scope ' + key + ' must be a UUID');
    }
  }
  return { tenant_id: scope.tenant_id, factory_id: scope.factory_id, device_id: scope.device_id };
}

function normalizeEvent(event) {
  const sourceEventId = event?.source_event_id;
  if (typeof sourceEventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sourceEventId)) {
    throw new Error('source_event_id is invalid');
  }
  if (typeof event.event_type !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,99}$/.test(event.event_type)) {
    throw new Error('event_type is invalid');
  }
  if (typeof event.stream_key !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(event.stream_key)) {
    throw new Error('stream_key is invalid');
  }
  if (event.source_sequence !== null && event.source_sequence !== undefined
      && (!Number.isSafeInteger(event.source_sequence) || event.source_sequence < 1)) {
    throw new Error('source_sequence must be a safe positive integer or null');
  }
  const timestamp = new Date(event.observed_at);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('observed_at is invalid');
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new Error('payload must be a JSON object');
  }
  const normalized = {
    source_event_id: sourceEventId,
    event_type: event.event_type,
    stream_key: event.stream_key,
    source_sequence: event.source_sequence ?? null,
    observed_at: timestamp.toISOString(),
    payload: JSON.parse(JSON.stringify(event.payload)),
  };
  const bytes = Buffer.byteLength(JSON.stringify(normalized));
  if (bytes < 1 || bytes > 4096) throw new Error('normalized telemetry payload exceeds the 4 KiB edge limit');
  return normalized;
}

export class OtEdgeDurableSpool {
  #tail = Promise.resolve();

  constructor(filePath, key, options = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('OT spool file path is required');
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('OT spool key must be exactly 32 bytes');
    this.filePath = resolve(filePath);
    this.key = Buffer.from(key);
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxPlaintextBytes = options.maxPlaintextBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1
        || !Number.isInteger(this.maxPlaintextBytes) || this.maxPlaintextBytes < 4096) {
      throw new Error('OT spool capacity configuration is invalid');
    }
  }

  async enqueue(scopeInput, eventInput) {
    return this.#exclusive(async () => {
      const scope = validateScope(scopeInput);
      const event = normalizeEvent(eventInput);
      const fingerprint = sha256(canonical(event));
      const state = await this.#load();
      const existing = state.entries.find((row) => scopeKey(row.scope) === scopeKey(scope)
        && row.event.source_event_id === event.source_event_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error('source_event_id was reused with different content');
        }
        return { duplicate: true, fingerprint, event: existing.event };
      }
      if (state.entries.length >= this.maxEntries) {
        throw new Error('OT edge spool is full; MQTT QoS 1 delivery must not be acknowledged');
      }
      const row = {
        scope,
        event,
        fingerprint,
        enqueued_at: new Date(this.now()).toISOString(),
        attempts: 0,
        next_attempt_at_ms: this.now(),
        blocked_at_ms: null,
      };
      state.entries.push(row);
      await this.#save(state);
      return { duplicate: false, fingerprint, event };
    });
  }

  async enqueueSample(scopeInput, sample) {
    return this.#exclusive(async () => {
      const scope = validateScope(scopeInput);
      const state = await this.#load();
      const key = scope.device_id;
      const sequence = (state.sequences[key] ?? 0) + 1;
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('OT source sequence exhausted');
      const event = normalizeEvent({
        ...sample,
        source_sequence: sequence,
        source_event_id: 'gw-' + scope.device_id + '-' + sequence,
      });
      const fingerprint = sha256(canonical(event));
      const existing = state.entries.find((row) => scopeKey(row.scope) === scopeKey(scope)
        && row.event.source_event_id === event.source_event_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('generated source event ID fingerprint conflict');
        return { duplicate: true, sequence, fingerprint, event: existing.event };
      }
      if (state.entries.length >= this.maxEntries) throw new Error('OT edge spool is full');
      state.sequences[key] = sequence;
      state.entries.push({
        scope, event, fingerprint, enqueued_at: new Date(this.now()).toISOString(),
        attempts: 0, next_attempt_at_ms: this.now(), blocked_at_ms: null,
      });
      await this.#save(state);
      return { duplicate: false, sequence, fingerprint, event };
    });
  }

  async readBatch(limit = MAX_BATCH, at = this.now()) {
    return this.#exclusive(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) {
        throw new Error('OT replay batches are bounded to 1–20 events');
      }
      const state = await this.#load();
      const grouped = new Map();
      for (const entry of state.entries) {
        const key = scopeKey(entry.scope);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(entry);
      }
      for (const entries of grouped.values()) {
        const first = entries[0];
        if (!first || first.blocked_at_ms !== null || first.next_attempt_at_ms > at) continue;
        const ready = [];
        for (const entry of entries) {
          if (ready.length >= limit || entry.blocked_at_ms !== null || entry.next_attempt_at_ms > at) break;
          ready.push({ event: entry.event, fingerprint: entry.fingerprint, attempts: entry.attempts });
        }
        if (ready.length) return { scope: first.scope, items: ready };
      }
      return null;
    });
  }

  async acknowledge(scopeInput, items) {
    return this.#exclusive(async () => {
      const scope = validateScope(scopeInput);
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) {
        throw new Error('OT replay acknowledgement is outside the accepted batch size');
      }
      const ids = new Set();
      for (const item of items) {
        if (!item || typeof item.source_event_id !== 'string' || typeof item.fingerprint !== 'string'
            || ids.has(item.source_event_id)) throw new Error('OT replay acknowledgement contains invalid or duplicate IDs');
        ids.add(item.source_event_id);
      }
      const state = await this.#load();
      const found = state.entries.filter((row) => scopeKey(row.scope) === scopeKey(scope) && ids.has(row.event.source_event_id));
      if (found.length !== items.length) throw new Error('OT replay acknowledgement references unknown durable entries');
      for (const item of items) {
        const row = found.find((candidate) => candidate.event.source_event_id === item.source_event_id);
        if (!row || row.fingerprint !== item.fingerprint || sha256(canonical(row.event)) !== item.fingerprint) {
          throw new Error('OT replay acknowledgement fingerprint mismatch');
        }
      }
      state.entries = state.entries.filter((row) => !(scopeKey(row.scope) === scopeKey(scope) && ids.has(row.event.source_event_id)));
      await this.#save(state);
      return found.length;
    });
  }

  async defer(scopeInput, items, failureCode = 'DELIVERY_FAILED') {
    return this.#exclusive(async () => {
      const scope = validateScope(scopeInput);
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) throw new Error('OT retry batch is invalid');
      const state = await this.#load();
      let blocked = 0;
      for (const item of items) {
        const row = state.entries.find((candidate) => scopeKey(candidate.scope) === scopeKey(scope)
          && candidate.event.source_event_id === item.source_event_id);
        if (!row || row.fingerprint !== item.fingerprint) throw new Error('OT retry references a changed or unknown entry');
        row.attempts += 1;
        row.last_failure_code = failureCode;
        if (row.attempts >= 12) {
          row.blocked_at_ms = this.now();
        } else {
          row.next_attempt_at_ms = this.now() + Math.min(60_000, 1000 * (2 ** Math.min(row.attempts - 1, 6)));
        }
        if (row.blocked_at_ms !== null) blocked += 1;
      }
      await this.#save(state);
      return { count: items.length, blocked };
    });
  }

  async requeueBlocked(scopeInput, sourceEventId, expectedFingerprint) {
    return this.#exclusive(async () => {
      const scope = validateScope(scopeInput);
      const state = await this.#load();
      const row = state.entries.find((entry) => scopeKey(entry.scope) === scopeKey(scope)
        && entry.event.source_event_id === sourceEventId);
      if (!row || row.blocked_at_ms === null) return false;
      if (row.fingerprint !== expectedFingerprint || sha256(canonical(row.event)) !== expectedFingerprint) {
        throw new Error('manual requeue requires the exact blocked event fingerprint');
      }
      row.attempts = 0;
      row.blocked_at_ms = null;
      row.last_failure_code = null;
      row.next_attempt_at_ms = this.now();
      await this.#save(state);
      return true;
    });
  }

  async pendingCount() {
    return this.#exclusive(async () => (await this.#load()).entries.length);
  }

  async stats() {
    return this.#exclusive(async () => {
      const state = await this.#load();
      return {
        queued: state.entries.length,
        blocked: state.entries.filter((entry) => entry.blocked_at_ms !== null).length,
        oldestEnqueuedAt: state.entries[0]?.enqueued_at ?? null,
      };
    });
  }

  async #exclusive(work) {
    const operation = this.#tail.then(work, work);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #load() {
    let buffer;
    try {
      const stat = await lstat(this.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('OT spool path must be a regular file, not a symlink');
      buffer = await readFile(this.filePath);
    } catch (error) {
      if (isNotFound(error)) return { schema_version: 1, sequences: {}, entries: [] };
      throw error;
    }
    if (buffer.length < MAGIC.length || !buffer.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) {
      throw new Error('OT spool header is invalid; refusing to reset durable telemetry');
    }
    let decoded;
    try {
      const envelope = JSON.parse(buffer.subarray(MAGIC.length).toString('utf8'));
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) throw new Error('invalid encrypted snapshot');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.length > this.maxPlaintextBytes) throw new Error('OT spool plaintext exceeds configured limit');
      decoded = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new Error('OT spool authentication failed (wrong key or corrupted file); refusing to reset queue');
    }
    if (!decoded || decoded.schema_version !== 1 || !Array.isArray(decoded.entries)
        || !decoded.sequences || typeof decoded.sequences !== 'object' || Array.isArray(decoded.sequences)) {
      throw new Error('OT spool state schema is invalid');
    }
    for (const row of decoded.entries) {
      validateScope(row.scope);
      const event = normalizeEvent(row.event);
      if (sha256(canonical(event)) !== row.fingerprint) throw new Error('OT spool event fingerprint failed recovery validation');
      if (!Number.isInteger(row.attempts) || row.attempts < 0 || !Number.isFinite(row.next_attempt_at_ms)
          || (row.blocked_at_ms !== null && !Number.isFinite(row.blocked_at_ms))) {
        throw new Error('OT spool retry state is invalid');
      }
    }
    return decoded;
  }

  async #save(state) {
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
    if (plaintext.length > this.maxPlaintextBytes) throw new Error('OT spool capacity limit exceeded; no queued events were dropped');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = MAGIC + JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    const parent = dirname(this.filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const tempPath = this.filePath + '.tmp-' + process.pid + '-' + randomBytes(6).toString('hex');
    let handle;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(envelope, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, this.filePath);
      await chmod(this.filePath, 0o600);
      const directory = await open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  }
}
