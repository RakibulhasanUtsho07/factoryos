import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export const EDGE_SPOOL_MAX_BATCH_BYTES = 64 * 1024;
const ENCRYPTED_RECORD_MAX_BYTES = EDGE_SPOOL_MAX_BATCH_BYTES * 2;
const ENCRYPTION_AAD_PREFIX = 'factoryos-edge-spool:v1';
const DEFAULT_MAX_PENDING_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_PENDING_BATCHES = 10_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const BATCH_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_FIELD_PATTERN =
  /(?:secret|password|credential|private.?key|api.?key|api.?token|access.?token|refresh.?token|authorization|bearer)/i;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type EdgeObservationSourceMode = 'EDGE_OFFLINE' | 'CLOUD_CONNECTED';
export type EdgeObservationQuality = 'GOOD' | 'UNCERTAIN' | 'BAD';

export interface EdgeSpoolObservation {
  event_id: string;
  signal_key: string;
  observed_at: string;
  source_mode: EdgeObservationSourceMode;
  quality: EdgeObservationQuality;
  /** Optional only for already persisted legacy spool files during upgrade. */
  unit?: string;
  /** 0 means event-driven; positive values are periodic intervals in milliseconds. */
  sampling_interval_ms?: number;
  payload: Record<string, unknown>;
}

export interface EdgeSpoolBatch {
  batch_key: string;
  observations: EdgeSpoolObservation[];
}

export interface EdgeSpoolLimits {
  maxPendingBytes?: number;
  maxPendingBatches?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface StoredEdgeBatch extends EdgeSpoolBatch {
  schema_version: 1;
  content_hash: string;
  created_at: string;
  attempts: number;
  next_attempt_at: number;
  last_error_code: string | null;
}

export interface ReadyEdgeBatch {
  batch: EdgeSpoolBatch;
  attempts: number;
  createdAt: string;
}

export interface EdgeSpoolStatus {
  pendingBatches: number;
  pendingBytes: number;
  oldestPendingAt: string | null;
  lastSuccessfulSyncAt: string | null;
}

export type EdgeSpoolErrorCode =
  | 'INVALID_BATCH'
  | 'BATCH_CONFLICT'
  | 'CAPACITY_EXCEEDED'
  | 'SPOOL_LOCKED'
  | 'SPOOL_CORRUPT'
  | 'SPOOL_NOT_INITIALIZED';

export class EdgeSpoolError extends Error {
  constructor(
    public readonly code: EdgeSpoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EdgeSpoolError';
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 8) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Batch payload nesting exceeds the limit');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new EdgeSpoolError('INVALID_BATCH', 'Value is not valid JSON');
    return encoded;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Batch values must be finite JSON numbers');
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new EdgeSpoolError('INVALID_BATCH', 'Value is not valid JSON');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Batch must contain plain JSON values only');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  for (const key of keys) {
    if (RESERVED_KEYS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Credential-like or reserved payload fields are not allowed');
    }
  }
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizeBatch(input: unknown, allowLegacy = false): { batch: EdgeSpoolBatch; contentHash: string; byteLength: number } {
  if (!isPlainRecord(input)) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Batch must be a JSON object');
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'batch_key' || keys[1] !== 'observations') {
    throw new EdgeSpoolError('INVALID_BATCH', 'Batch must contain only batch_key and observations');
  }

  const batchKey = input.batch_key;
  const observations = input.observations;
  if (typeof batchKey !== 'string' || !BATCH_KEY_PATTERN.test(batchKey)) {
    throw new EdgeSpoolError('INVALID_BATCH', 'batch_key is invalid');
  }
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > 100) {
    throw new EdgeSpoolError('INVALID_BATCH', 'observations must contain between 1 and 100 items');
  }

  const seenEventIds = new Set<string>();
  const normalizedObservations: EdgeSpoolObservation[] = observations.map((item) => {
    if (!isPlainRecord(item)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Each observation must be a JSON object');
    }
    const legacyKeys = [
      'event_id',
      'observed_at',
      'payload',
      'quality',
      'signal_key',
      'source_mode',
    ];
    const currentKeys = [...legacyKeys, 'sampling_interval_ms', 'unit'].sort();
    const actualKeys = Object.keys(item).sort();
    const isLegacy = actualKeys.length === legacyKeys.length &&
      legacyKeys.every((key, index) => actualKeys[index] === key);
    const isCurrent = actualKeys.length === currentKeys.length &&
      currentKeys.every((key, index) => actualKeys[index] === key);
    if ((!isCurrent && !(allowLegacy && isLegacy))) {
      throw new EdgeSpoolError(
        'INVALID_BATCH',
        'New batches must include unit and sampling_interval_ms; only previously persisted batches may use the legacy shape',
      );
    }

    if (typeof item.event_id !== 'string' || !UUID_PATTERN.test(item.event_id)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'event_id must be a UUID');
    }
    const eventId = item.event_id.toLowerCase();
    if (seenEventIds.has(eventId)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'A batch cannot contain duplicate event_id values');
    }
    seenEventIds.add(eventId);

    if (typeof item.signal_key !== 'string' || !SIGNAL_KEY_PATTERN.test(item.signal_key)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'signal_key is invalid');
    }
    if (typeof item.observed_at !== 'string' || !Number.isFinite(Date.parse(item.observed_at))) {
      throw new EdgeSpoolError('INVALID_BATCH', 'observed_at must be a valid date string');
    }
    if (item.source_mode !== 'EDGE_OFFLINE' && item.source_mode !== 'CLOUD_CONNECTED') {
      throw new EdgeSpoolError('INVALID_BATCH', 'source_mode is invalid');
    }
    if (!['GOOD', 'UNCERTAIN', 'BAD'].includes(String(item.quality))) {
      throw new EdgeSpoolError('INVALID_BATCH', 'quality is invalid');
    }
    let unit: string | undefined;
    let samplingIntervalMs: number | undefined;
    if (isCurrent) {
      if (typeof item.unit !== 'string' || !/^[A-Za-z0-9%._/-]{1,32}$/.test(item.unit)) {
        throw new EdgeSpoolError('INVALID_BATCH', 'unit is invalid');
      }
      if (!Number.isSafeInteger(item.sampling_interval_ms) ||
          (item.sampling_interval_ms as number) < 0 ||
          (item.sampling_interval_ms as number) > 86400000) {
        throw new EdgeSpoolError('INVALID_BATCH', 'sampling_interval_ms must be between 0 and 86400000');
      }
      unit = item.unit;
      samplingIntervalMs = item.sampling_interval_ms as number;
    }
    if (!isPlainRecord(item.payload)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'payload must be a JSON object');
    }
    // Canonicalization recursively validates JSON types, nesting, and sensitive keys.
    canonicalJson(item.payload);

    return {
      event_id: eventId,
      signal_key: item.signal_key,
      observed_at: item.observed_at,
      source_mode: item.source_mode,
      quality: item.quality as EdgeObservationQuality,
      ...(unit !== undefined ? { unit, sampling_interval_ms: samplingIntervalMs } : {}),
      payload: JSON.parse(canonicalJson(item.payload)) as Record<string, unknown>,
    };
  });

  const batch: EdgeSpoolBatch = { batch_key: batchKey, observations: normalizedObservations };
  const canonical = canonicalJson(batch);
  const byteLength = Buffer.byteLength(canonical, 'utf8');
  if (byteLength > EDGE_SPOOL_MAX_BATCH_BYTES) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Batch exceeds the 64 KiB contract limit');
  }

  return { batch, contentHash: sha256(canonical), byteLength };
}

export class DurableEdgeSpool {
  private readonly pendingDir: string;
  private readonly tempDir: string;
  private readonly lockPath: string;
  private readonly statePath: string;
  private readonly encryptionKey: Buffer;
  private lastSuccessfulSyncAt: string | null = null;
  private readonly maxPendingBytes: number;
  private readonly maxPendingBatches: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private mutationTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private lockNonce: string | null = null;

  constructor(
    readonly rootDir: string,
    encryptionKey: Uint8Array,
    limits: EdgeSpoolLimits = {},
  ) {
    if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) {
      throw new Error('encryptionKey must be a 32-byte AES-256 key supplied by the host secret manager');
    }
    this.encryptionKey = Buffer.from(encryptionKey);
    this.pendingDir = join(rootDir, 'pending');
    this.tempDir = join(rootDir, '.tmp');
    this.lockPath = join(rootDir, '.edge-agent.lock');
    this.statePath = join(rootDir, 'agent-state.json');
    this.maxPendingBytes = limits.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.maxPendingBatches = limits.maxPendingBatches ?? DEFAULT_MAX_PENDING_BATCHES;
    this.retryBaseMs = limits.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = limits.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;

    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1) {
      throw new Error('maxPendingBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxPendingBatches) || this.maxPendingBatches < 1) {
      throw new Error('maxPendingBatches must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(this.retryBaseMs) ||
      !Number.isSafeInteger(this.retryMaxMs) ||
      this.retryBaseMs < 1 ||
      this.retryMaxMs < this.retryBaseMs
    ) {
      throw new Error('Retry limits are invalid');
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.rootDir);
    await mkdir(this.pendingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.pendingDir);
    await this.assertDirectory(this.tempDir);
    await this.acquireProcessLock();

    try {
      for (const entry of await readdir(this.tempDir)) {
        await rm(join(this.tempDir, entry), { force: true, recursive: false });
      }
      await this.loadAgentState();
      this.initialized = true;
    } catch (error) {
      await this.releaseProcessLock();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.initialized && !this.lockNonce) return;
    this.initialized = false;
    await this.releaseProcessLock();
  }

  async markSuccessfulSync(at = new Date().toISOString()): Promise<void> {
    await this.withMutationLock(async () => {
      this.ensureInitialized();
      const timestamp = Date.parse(at);
      if (!Number.isFinite(timestamp)) {
        throw new EdgeSpoolError('SPOOL_CORRUPT', 'Successful-sync timestamp must be a valid date');
      }
      const normalized = new Date(timestamp).toISOString();
      if (this.lastSuccessfulSyncAt && Date.parse(this.lastSuccessfulSyncAt) > timestamp) {
        return;
      }
      const nextState = JSON.stringify({
        schema_version: 1,
        last_successful_sync_at: normalized,
      });
      await this.writeAtomic(this.statePath, nextState);
      this.lastSuccessfulSyncAt = normalized;
    });
  }

  async enqueue(input: unknown, now = Date.now()): Promise<{ idempotent: boolean; batchKey: string }> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      const normalized = normalizeBatch(input);
      const destination = this.batchPath(normalized.batch.batch_key);
      const existing = await this.readStored(destination);
      if (existing) {
        if (existing.content_hash !== normalized.contentHash) {
          throw new EdgeSpoolError(
            'BATCH_CONFLICT',
            'The batch key was already queued with different observation content',
          );
        }
        return { idempotent: true, batchKey: existing.batch_key };
      }

      const usage = await this.measurePending();
      const preview: StoredEdgeBatch = {
        schema_version: 1,
        ...normalized.batch,
        content_hash: normalized.contentHash,
        created_at: new Date(now).toISOString(),
        attempts: 0,
        next_attempt_at: now,
        last_error_code: null,
      };
      const serialized = JSON.stringify(preview);
      if (serialized === undefined) {
        throw new EdgeSpoolError('INVALID_BATCH', 'Could not serialize the queued batch');
      }
      if (usage.pendingBatches + 1 > this.maxPendingBatches ||
          usage.pendingBytes + Buffer.byteLength(this.encryptPersisted(destination, serialized), 'utf8') > this.maxPendingBytes) {
        throw new EdgeSpoolError('CAPACITY_EXCEEDED', 'Local edge spool is full; no queued data was discarded');
      }

      await this.writeAtomic(destination, serialized);
      return { idempotent: false, batchKey: normalized.batch.batch_key };
    });
  }

  async listReady(limit = 10, now = Date.now()): Promise<ReadyEdgeBatch[]> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('limit must be an integer between 1 and 100');
      }
      const stored: StoredEdgeBatch[] = [];
      for (const name of await readdir(this.pendingDir)) {
        if (!name.endsWith('.json')) continue;
        const row = await this.readStored(join(this.pendingDir, name));
        if (row && row.next_attempt_at <= now) stored.push(row);
      }
      stored.sort((left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.batch_key.localeCompare(right.batch_key),
      );
      return stored.slice(0, limit).map((row) => ({
        batch: { batch_key: row.batch_key, observations: row.observations },
        attempts: row.attempts,
        createdAt: row.created_at,
      }));
    });
  }

  async recordFailure(
    batchKey: string,
    failureCode: string,
    now = Date.now(),
  ): Promise<{ attempts: number; nextAttemptAt: number } | null> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      const filePath = this.batchPath(batchKey);
      const existing = await this.readStored(filePath);
      if (!existing) return null;
      const attempts = existing.attempts + 1;
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempts - 1, 30));
      const nextAttemptAt = now + delay;
      const safeFailureCode = /^[A-Za-z0-9_-]{1,48}$/.test(failureCode)
        ? failureCode
        : 'DELIVERY_FAILED';
      await this.writeAtomic(filePath, JSON.stringify({
        ...existing,
        attempts,
        next_attempt_at: nextAttemptAt,
        last_error_code: safeFailureCode,
      } satisfies StoredEdgeBatch));
      return { attempts, nextAttemptAt };
    });
  }

  async acknowledge(batchKey: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      const filePath = this.batchPath(batchKey);
      try {
        await unlink(filePath);
        await this.syncDirectory(this.pendingDir);
        return true;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
      }
    });
  }

  async status(): Promise<EdgeSpoolStatus> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      const rows: StoredEdgeBatch[] = [];
      for (const name of await readdir(this.pendingDir)) {
        if (!name.endsWith('.json')) continue;
        const row = await this.readStored(join(this.pendingDir, name));
        if (row) rows.push(row);
      }
      rows.sort((left, right) => left.created_at.localeCompare(right.created_at));
      const usage = await this.measurePending();
      return {
        pendingBatches: usage.pendingBatches,
        pendingBytes: usage.pendingBytes,
        oldestPendingAt: rows[0]?.created_at ?? null,
        lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      };
    });
  }

  private async loadAgentState(): Promise<void> {
    let raw: string;
    try {
      const details = await lstat(this.statePath);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new EdgeSpoolError('SPOOL_CORRUPT', 'Agent state must be a regular file');
      }
      raw = this.decryptPersisted(this.statePath, await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      this.lastSuccessfulSyncAt = null;
      await this.writeAtomic(
        this.statePath,
        JSON.stringify({ schema_version: 1, last_successful_sync_at: null }),
      );
      return;
    }

    try {
      const state = JSON.parse(raw) as {
        schema_version?: unknown;
        last_successful_sync_at?: unknown;
      };
      if (state.schema_version !== 1 ||
          !(state.last_successful_sync_at === null ||
            (typeof state.last_successful_sync_at === 'string' &&
             Number.isFinite(Date.parse(state.last_successful_sync_at))))) {
        throw new Error('Invalid agent state envelope');
      }
      this.lastSuccessfulSyncAt = state.last_successful_sync_at as string | null;
    } catch {
      throw new EdgeSpoolError('SPOOL_CORRUPT', 'Agent state failed integrity validation');
    }
  }

  private async measurePending(): Promise<{ pendingBatches: number; pendingBytes: number }> {
    let pendingBatches = 0;
    let pendingBytes = 0;
    for (const name of await readdir(this.pendingDir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = join(this.pendingDir, name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new EdgeSpoolError('SPOOL_CORRUPT', 'Spool contains a non-file entry');
      }
      pendingBatches += 1;
      pendingBytes += fileStat.size;
    }
    return { pendingBatches, pendingBytes };
  }

  private async readStored(filePath: string): Promise<StoredEdgeBatch | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(this.decryptPersisted(filePath, raw)) as Partial<StoredEdgeBatch>;
      if (
        parsed.schema_version !== 1 ||
        typeof parsed.content_hash !== 'string' ||
        typeof parsed.created_at !== 'string' ||
        !Number.isSafeInteger(parsed.attempts) ||
        (parsed.attempts as number) < 0 ||
        typeof parsed.next_attempt_at !== 'number' ||
        !Number.isFinite(parsed.next_attempt_at) ||
        (parsed.last_error_code !== null && typeof parsed.last_error_code !== 'string')
      ) {
        throw new Error('Invalid envelope');
      }
      // Accept the pre-metadata shape only for an existing durable queue item, so
      // replay after an agent upgrade retains the exact old request body and hash.
      const normalized = normalizeBatch({
        batch_key: parsed.batch_key,
        observations: parsed.observations,
      }, true);
      if (normalized.contentHash !== parsed.content_hash) throw new Error('Content hash mismatch');
      return parsed as StoredEdgeBatch;
    } catch {
      throw new EdgeSpoolError('SPOOL_CORRUPT', 'A queued batch failed integrity validation; it was not deleted');
    }
  }

  private batchPath(batchKey: string): string {
    if (!BATCH_KEY_PATTERN.test(batchKey)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'batch_key is invalid');
    }
    return join(this.pendingDir, `${sha256(batchKey)}.json`);
  }

  private encryptionAssociatedData(destination: string): Buffer {
    const recordPath = relative(this.rootDir, destination).split('\\\\').join('/');
    if (!recordPath || recordPath === '..' || recordPath.startsWith('../')) {
      throw new EdgeSpoolError('SPOOL_CORRUPT', 'Encrypted spool record path is outside the spool root');
    }
    return Buffer.from(`${ENCRYPTION_AAD_PREFIX}:${recordPath}`, 'utf8');
  }

  private encryptPersisted(destination: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(this.encryptionAssociatedData(destination));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({
      schema_version: 1,
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64'),
      auth_tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
  }

  private decryptPersisted(destination: string, raw: string): string {
    try {
      if (Buffer.byteLength(raw, 'utf8') > ENCRYPTED_RECORD_MAX_BYTES) {
        throw new Error('Encrypted record is oversized');
      }
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      const expectedKeys = ['schema_version', 'algorithm', 'iv', 'auth_tag', 'ciphertext'];
      if (!isPlainRecord(envelope) ||
          Object.keys(envelope).length !== expectedKeys.length ||
          Object.keys(envelope).some((key) => !expectedKeys.includes(key)) ||
          envelope.schema_version !== 1 || envelope.algorithm !== 'AES-256-GCM' ||
          typeof envelope.iv !== 'string' || typeof envelope.auth_tag !== 'string' ||
          typeof envelope.ciphertext !== 'string') {
        throw new Error('Invalid encrypted record envelope');
      }
      const decodeBase64 = (value: string): Buffer => {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
          throw new Error('Invalid base64 envelope field');
        }
        const decoded = Buffer.from(value, 'base64');
        if (decoded.toString('base64') !== value) throw new Error('Non-canonical base64 envelope field');
        return decoded;
      };
      const iv = decodeBase64(envelope.iv);
      const authTag = decodeBase64(envelope.auth_tag);
      const ciphertext = decodeBase64(envelope.ciphertext);
      if (iv.byteLength !== 12 || authTag.byteLength !== 16 || ciphertext.byteLength < 1) {
        throw new Error('Encrypted record has invalid cryptographic field lengths');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAAD(this.encryptionAssociatedData(destination));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new EdgeSpoolError('SPOOL_CORRUPT', 'A persisted spool record failed encryption or authentication validation; it was not deleted');
    }
  }

  private async writeAtomic(destination: string, contents: string): Promise<void> {
    const encryptedContents = this.encryptPersisted(destination, contents);
    const temporaryPath = join(this.tempDir, `${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(encryptedContents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, destination);
      await this.syncDirectory(dirname(destination));
      await this.syncDirectory(this.tempDir);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async assertDirectory(directory: string): Promise<void> {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new EdgeSpoolError('SPOOL_CORRUPT', 'Spool directories must not be symlinks');
    }
  }

  private async acquireProcessLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = randomUUID();
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }), 'utf8');
        await handle.sync();
        await handle.close();
        this.lockNonce = nonce;
        await this.syncDirectory(this.rootDir);
        return;
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        if (errorCode(error) !== 'EEXIST') throw error;
        const lockStat = await lstat(this.lockPath);
        if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
          throw new EdgeSpoolError('SPOOL_CORRUPT', 'Spool lock must be a regular file');
        }
        let owner: { pid?: unknown } | null = null;
        try {
          owner = JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: unknown };
        } catch {
          throw new EdgeSpoolError('SPOOL_LOCKED', 'Spool lock is unreadable; investigate before removing it');
        }
        if (!Number.isInteger(owner?.pid) || (owner?.pid as number) < 1) {
          throw new EdgeSpoolError('SPOOL_LOCKED', 'Spool lock has invalid owner metadata');
        }
        let ownerAlive = true;
        try {
          process.kill(owner.pid as number, 0);
        } catch (probeError) {
          ownerAlive = errorCode(probeError) !== 'ESRCH';
        }
        if (ownerAlive) {
          throw new EdgeSpoolError('SPOOL_LOCKED', 'Another edge-agent process is using this spool directory');
        }
        await unlink(this.lockPath);
      }
    }
    throw new EdgeSpoolError('SPOOL_LOCKED', 'Could not acquire spool lock');
  }

  private async releaseProcessLock(): Promise<void> {
    const nonce = this.lockNonce;
    this.lockNonce = null;
    if (!nonce) return;
    try {
      const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as { nonce?: unknown };
      if (current.nonce === nonce) {
        await unlink(this.lockPath);
        await this.syncDirectory(this.rootDir);
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(directory, 'r');
      await handle.sync();
    } catch (error) {
      // Windows and a few filesystems do not support fsync on directory handles.
      if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(errorCode(error) ?? '')) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.lockNonce) {
      throw new EdgeSpoolError('SPOOL_NOT_INITIALIZED', 'Initialize the edge spool before using it');
    }
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}
