import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canonicalOtJson,
  hashOtValue,
  normalizeOtObject,
} from './ot-device.contract';

export interface OtEdgeScope {
  tenant_id: string;
  factory_id: string;
  device_id: string;
}

export interface OtEdgeTelemetryEvent {
  source_event_id: string;
  event_type: string;
  stream_key: string;
  source_sequence: number | null;
  observed_at: string;
  payload: Record<string, unknown>;
}

export interface OtSpoolBatchItem {
  event: OtEdgeTelemetryEvent;
  fingerprint: string;
  attempts: number;
}

interface SpoolEntry {
  scope: OtEdgeScope;
  event: OtEdgeTelemetryEvent;
  fingerprint: string;
  enqueued_at: string;
  attempts: number;
  next_attempt_at_ms: number;
  blocked_at_ms?: number | null;
  last_failure_code?: SpoolFailureCode | null;
}

interface SpoolState {
  schema_version: 1;
  entries: SpoolEntry[];
}

const MAGIC = 'FACTORYOS-OT-SPOOL-V1:';
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_SIZE = 20;
const DEFAULT_MAX_ATTEMPTS = 12;
type SpoolFailureCode = 'TRANSPORT_OR_ACK_FAILURE' | 'INVALID_RECEIVER_RESPONSE' | 'DELIVERY_FAILED';

function scopeKey(scope: OtEdgeScope): string {
  return scope.tenant_id + ':' + scope.factory_id + ':' + scope.device_id;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Encrypted, atomic snapshot spool for edge use. The spool key is injected from an
 * OS/deployment secret store; it is never stored alongside the ciphertext. Use one
 * writer process per file. A crash during replacement leaves either the previous
 * complete snapshot or the new complete snapshot (never a truncated queue).
 */
export class OtOfflineSpoolStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryptionKey: Buffer,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxPlaintextBytes = DEFAULT_MAX_PLAINTEXT_BYTES,
    private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS,
  ) {
    if (encryptionKey.byteLength !== 32) {
      throw new Error('OT spool encryption key must be exactly 32 bytes');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxPlaintextBytes) || maxPlaintextBytes < 4096
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error('OT spool capacity limits are invalid');
    }
  }

  async enqueue(scope: OtEdgeScope, event: OtEdgeTelemetryEvent): Promise<{ fingerprint: string; duplicate: boolean }> {
    return this.exclusive(async () => {
      const normalizedScope = this.normalizeScope(scope);
      const normalizedEvent = this.normalizeEvent(event);
      const fingerprint = hashOtValue(normalizedEvent);
      const state = await this.load();
      const existing = state.entries.find((entry) =>
        scopeKey(entry.scope) === scopeKey(normalizedScope)
        && entry.event.source_event_id === normalizedEvent.source_event_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error('OT spool source_event_id was reused with a different event fingerprint');
        }
        return { fingerprint, duplicate: true };
      }
      if (state.entries.length >= this.maxEntries) {
        throw new Error('OT spool is full; stop acknowledging QoS 1 messages until capacity is available');
      }
      state.entries.push({
        scope: normalizedScope,
        event: normalizedEvent,
        fingerprint,
        enqueued_at: new Date(this.now()).toISOString(),
        attempts: 0,
        next_attempt_at_ms: this.now(),
        blocked_at_ms: null,
        last_failure_code: null,
      });
      await this.save(state);
      return { fingerprint, duplicate: false };
    });
  }

  async readBatch(limit = MAX_BATCH_SIZE, at = this.now()): Promise<{ scope: OtEdgeScope; items: OtSpoolBatchItem[] } | null> {
    return this.exclusive(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
        throw new Error('OT spool batch limit must be between 1 and 20');
      }
      const state = await this.load();
      if (state.entries.length === 0) return null;

      // Keep delivery order per device, but allow an offline/unhealthy device to
      // defer without blocking other tenant/factory/device queues in a shared spool.
      const groups: Array<{ key: string; entries: SpoolEntry[] }> = [];
      for (const entry of state.entries) {
        const key = scopeKey(entry.scope);
        let group = groups.find((candidate) => candidate.key === key);
        if (!group) {
          group = { key, entries: [] };
          groups.push(group);
        }
        group.entries.push(entry);
      }
      const readyGroup = groups.find((group) => group.entries[0]!.blocked_at_ms == null
        && group.entries[0]!.next_attempt_at_ms <= at);
      if (!readyGroup) return null;
      const first = readyGroup.entries[0]!;
      const items: OtSpoolBatchItem[] = [];
      for (const entry of readyGroup.entries) {
        if (entry.next_attempt_at_ms > at || items.length >= limit) break;
        items.push({ event: entry.event, fingerprint: entry.fingerprint, attempts: entry.attempts });
      }
      return { scope: first.scope, items };
    });
  }

  async acknowledge(scope: OtEdgeScope, items: Array<Pick<OtSpoolBatchItem, 'event' | 'fingerprint'>>): Promise<number> {
    return this.exclusive(async () => {
      if (items.length < 1 || items.length > MAX_BATCH_SIZE) throw new Error('OT spool acknowledgement batch is invalid');
      const normalizedScope = this.normalizeScope(scope);
      const ids = new Set<string>();
      for (const item of items) {
        if (ids.has(item.event.source_event_id)) throw new Error('OT spool acknowledgement contains duplicate IDs');
        if (hashOtValue(item.event) !== item.fingerprint) {
          throw new Error('OT spool acknowledgement event content does not match its fingerprint');
        }
        ids.add(item.event.source_event_id);
      }
      const state = await this.load();
      const candidates = state.entries.filter((entry) => scopeKey(entry.scope) === scopeKey(normalizedScope)
        && ids.has(entry.event.source_event_id));
      if (candidates.length !== items.length) throw new Error('OT spool acknowledgement references unknown queued events');
      for (const item of items) {
        const queued = candidates.find((entry) => entry.event.source_event_id === item.event.source_event_id);
        if (!queued || queued.fingerprint !== item.fingerprint) {
          throw new Error('OT spool acknowledgement fingerprint does not match the durable record');
        }
      }
      state.entries = state.entries.filter((entry) => !(scopeKey(entry.scope) === scopeKey(normalizedScope)
        && ids.has(entry.event.source_event_id)));
      await this.save(state);
      return candidates.length;
    });
  }

  async defer(
    scope: OtEdgeScope,
    items: Array<Pick<OtSpoolBatchItem, 'event' | 'fingerprint'>>,
    at = this.now(),
    failureCode: SpoolFailureCode = 'DELIVERY_FAILED',
  ): Promise<{ count: number; blocked: number; next_attempt_at_ms: number | null }> {
    return this.exclusive(async () => {
      if (items.length < 1 || items.length > MAX_BATCH_SIZE) throw new Error('OT spool retry batch is invalid');
      const normalizedScope = this.normalizeScope(scope);
      const state = await this.load();
      let blocked = 0;
      let nextAttemptAt: number | null = null;
      for (const item of items) {
        if (hashOtValue(item.event) !== item.fingerprint) {
          throw new Error('OT spool retry event content does not match its fingerprint');
        }
        const queued = state.entries.find((entry) =>
          scopeKey(entry.scope) === scopeKey(normalizedScope)
          && entry.event.source_event_id === item.event.source_event_id);
        if (!queued || queued.fingerprint !== item.fingerprint) {
          throw new Error('OT spool retry references an unknown or changed event');
        }
        queued.attempts += 1;
        queued.last_failure_code = failureCode;
        if (queued.attempts >= this.maxAttempts) {
          queued.blocked_at_ms = at;
          blocked += 1;
          queued.next_attempt_at_ms = at;
        } else {
          queued.next_attempt_at_ms = at + Math.min(60_000, 1000 * (2 ** Math.min(queued.attempts - 1, 6)));
          nextAttemptAt = nextAttemptAt === null
            ? queued.next_attempt_at_ms
            : Math.max(nextAttemptAt, queued.next_attempt_at_ms);
        }
      }
      await this.save(state);
      return { count: items.length, blocked, next_attempt_at_ms: blocked > 0 ? null : nextAttemptAt };
    });
  }

  async listBlocked(): Promise<Array<{
    scope: OtEdgeScope;
    source_event_id: string;
    fingerprint: string;
    attempts: number;
    blocked_at_ms: number;
    failure_code: SpoolFailureCode | null;
  }>> {
    return this.exclusive(async () => {
      const state = await this.load();
      return state.entries.flatMap((entry) => entry.blocked_at_ms == null ? [] : [{
        scope: entry.scope,
        source_event_id: entry.event.source_event_id,
        fingerprint: entry.fingerprint,
        attempts: entry.attempts,
        blocked_at_ms: entry.blocked_at_ms,
        failure_code: entry.last_failure_code ?? null,
      }]);
    });
  }

  async requeueBlocked(
    scope: OtEdgeScope,
    sourceEventId: string,
    expectedFingerprint: string,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const normalizedScope = this.normalizeScope(scope);
      const state = await this.load();
      const entry = state.entries.find((candidate) =>
        scopeKey(candidate.scope) === scopeKey(normalizedScope)
        && candidate.event.source_event_id === sourceEventId);
      if (!entry || entry.blocked_at_ms == null) return false;
      if (entry.fingerprint !== expectedFingerprint || hashOtValue(entry.event) !== expectedFingerprint) {
        throw new Error('OT spool manual requeue requires the exact blocked event fingerprint');
      }
      entry.attempts = 0;
      entry.blocked_at_ms = null;
      entry.last_failure_code = null;
      entry.next_attempt_at_ms = this.now();
      await this.save(state);
      return true;
    });
  }

  async pendingCount(): Promise<number> {
    return this.exclusive(async () => (await this.load()).entries.length);
  }

  private normalizeScope(scope: OtEdgeScope): OtEdgeScope {
    for (const [field, value] of Object.entries(scope)) {
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('OT spool scope ' + field + ' must be a UUID');
      }
    }
    return { tenant_id: scope.tenant_id, factory_id: scope.factory_id, device_id: scope.device_id };
  }

  private normalizeEvent(event: OtEdgeTelemetryEvent): OtEdgeTelemetryEvent {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(event.source_event_id)) throw new Error('OT spool source_event_id is invalid');
    if (!/^[A-Z][A-Z0-9_.-]{0,99}$/.test(event.event_type)) throw new Error('OT spool event_type is invalid');
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(event.stream_key)) throw new Error('OT spool stream_key is invalid');
    if (event.source_sequence !== null && (!Number.isSafeInteger(event.source_sequence) || event.source_sequence < 1)) {
      throw new Error('OT spool source_sequence must be a safe positive integer or null');
    }
    const observed = new Date(event.observed_at);
    if (!Number.isFinite(observed.getTime())) throw new Error('OT spool observed_at is invalid');
    const payload = normalizeOtObject(event.payload, 'OT spool payload');
    if (Buffer.byteLength(canonicalOtJson(payload), 'utf8') > 4096) throw new Error('OT spool payload exceeds 4096 bytes');
    return {
      source_event_id: event.source_event_id,
      event_type: event.event_type,
      stream_key: event.stream_key,
      source_sequence: event.source_sequence,
      observed_at: observed.toISOString(),
      payload,
    };
  }

  private async load(): Promise<SpoolState> {
    let fileInfo;
    try {
      fileInfo = await lstat(this.filePath);
    } catch (error) {
      if (isNotFound(error)) return { schema_version: 1, entries: [] };
      throw error;
    }
    if (!fileInfo.isFile()) throw new Error('OT spool path must be a regular non-symlink file');
    const maxEncodedBytes = MAGIC.length + (4 * Math.ceil((this.maxPlaintextBytes + 28) / 3));
    if (fileInfo.size > maxEncodedBytes) throw new Error('OT spool file exceeds the configured encrypted capacity');
    const content = await readFile(this.filePath, 'utf8');
    if (!content.startsWith(MAGIC)) throw new Error('OT spool file header is invalid; refusing unsafe recovery');
    const packed = Buffer.from(content.slice(MAGIC.length), 'base64');
    if (packed.length < 12 + 16) throw new Error('OT spool ciphertext is truncated; refusing unsafe recovery');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('OT spool authentication failed; key may be wrong or file may be tampered with');
    }
    if (Buffer.byteLength(plaintext, 'utf8') > this.maxPlaintextBytes) throw new Error('OT spool exceeds the configured capacity');
    const decoded = JSON.parse(plaintext) as unknown;
    if (decoded === null || typeof decoded !== 'object' || !('schema_version' in decoded)
      || (decoded as { schema_version: unknown }).schema_version !== 1
      || !Array.isArray((decoded as { entries?: unknown }).entries)) {
      throw new Error('OT spool payload schema is unsupported; refusing unsafe recovery');
    }
    const state = decoded as SpoolState;
    if (state.entries.length > this.maxEntries) throw new Error('OT spool entry count exceeds the configured capacity');
    for (const entry of state.entries) {
      if (!entry || !entry.scope || !entry.event || typeof entry.fingerprint !== 'string'
        || entry.fingerprint !== hashOtValue(entry.event)
        || !Number.isInteger(entry.attempts) || entry.attempts < 0
        || !Number.isFinite(entry.next_attempt_at_ms)
        || (entry.blocked_at_ms != null && !Number.isFinite(entry.blocked_at_ms))
        || (entry.last_failure_code != null && !['TRANSPORT_OR_ACK_FAILURE', 'INVALID_RECEIVER_RESPONSE', 'DELIVERY_FAILED'].includes(entry.last_failure_code))) {
        throw new Error('OT spool entry failed recovery integrity checks');
      }
      this.normalizeScope(entry.scope);
      const normalizedEvent = this.normalizeEvent(entry.event);
      if (hashOtValue(normalizedEvent) !== entry.fingerprint) {
        throw new Error('OT spool event failed normalized recovery checks');
      }
    }
    return state;
  }

  private async save(state: SpoolState): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
    if (plaintext.byteLength > this.maxPlaintextBytes) {
      throw new Error('OT spool byte capacity is full; refusing to discard queued telemetry');
    }
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory()) throw new Error('OT spool parent path must be a directory');
    await chmod(directory, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    const path = this.filePath + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp';
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(MAGIC + packed.toString('base64'), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(path, this.filePath);
      const directory = await open(dirname(this.filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      try { await unlink(path); } catch { /* preserve the original filesystem error */ }
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.tail.then(operation, operation);
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }
}

export interface OtTelemetryReplayTransport {
  deliver(
    scope: OtEdgeScope,
    events: OtEdgeTelemetryEvent[],
  ): Promise<Array<{ source_event_id: string; status: string }>>;
}

export class OtSpoolReplayer {
  constructor(private readonly spool: OtOfflineSpoolStore, private readonly transport: OtTelemetryReplayTransport) {}

  async flushOnce(at = Date.now()): Promise<{
    status: 'IDLE' | 'ACKNOWLEDGED' | 'RETRY_SCHEDULED' | 'BLOCKED';
    count: number;
    next_attempt_at_ms?: number;
  }> {
    const batch = await this.spool.readBatch(MAX_BATCH_SIZE, at);
    if (!batch) return { status: 'IDLE', count: 0 };
    let failureCode: SpoolFailureCode = 'TRANSPORT_OR_ACK_FAILURE';
    try {
      const response = await this.transport.deliver(batch.scope, batch.items.map((item) => item.event));
      const accepted = new Set(['ON_TIME', 'LATE', 'SEQUENCE_GAP', 'DUPLICATE_REPLAY']);
      if (response.length !== batch.items.length
        || new Set(response.map((item) => item.source_event_id)).size !== batch.items.length
        || response.some((item) => !accepted.has(item.status)
          || !batch.items.some((queued) => queued.event.source_event_id === item.source_event_id))) {
        failureCode = 'INVALID_RECEIVER_RESPONSE';
        throw new Error('Telemetry receiver response did not confirm every source event');
      }
      const acked = await this.spool.acknowledge(batch.scope, batch.items);
      return { status: 'ACKNOWLEDGED', count: acked };
    } catch {
      const deferred = await this.spool.defer(batch.scope, batch.items, at, failureCode);
      if (deferred.blocked > 0) return { status: 'BLOCKED', count: deferred.count };
      return {
        status: 'RETRY_SCHEDULED',
        count: batch.items.length,
        next_attempt_at_ms: deferred.next_attempt_at_ms ?? at + 1000,
      };
    }
  }
}
