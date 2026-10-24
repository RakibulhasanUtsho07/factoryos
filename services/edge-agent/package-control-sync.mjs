import { createHash, createPublicKey } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USE_CASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['ACTIVE', 'PAUSED', 'REVOKED']);
const MAX_SCOPES = 64;
const MAX_KEYS = 512;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_STATE_BYTES = 2_097_152;
const MAX_ALLOWED_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export class EdgePackageSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EdgePackageSyncError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EdgePackageSyncError(code, message);
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function safeTime(value, label, now, maxAgeMs) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('INVALID_CONTROL_SNAPSHOT', label + ' must be an ISO-compatible timestamp');
  }
  const ms = Date.parse(value);
  if (ms - now > CLOCK_SKEW_MS || now - ms > maxAgeMs) {
    fail('STALE_CONTROL_SNAPSHOT', label + ' is outside the permitted freshness window');
  }
  return new Date(ms).toISOString();
}
function scopeKey(scope) {
  return JSON.stringify([scope.packageId, scope.version, scope.useCaseId ?? null]);
}
function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_SCOPES) {
    throw new TypeError('managedScopes must contain 1-64 explicit package scopes');
  }
  const result = [];
  const seen = new Set();
  for (const scope of scopes) {
    if (!isRecord(scope) || typeof scope.packageId !== 'string' || !PACKAGE_ID.test(scope.packageId)
      || typeof scope.version !== 'string' || !SEMVER.test(scope.version)
      || (scope.useCaseId !== undefined && (typeof scope.useCaseId !== 'string' || !USE_CASE.test(scope.useCaseId)))) {
      throw new TypeError('Each managed scope requires a safe packageId, semantic version and optional useCaseId');
    }
    const normalized = { packageId: scope.packageId, version: scope.version, useCaseId: scope.useCaseId ?? null };
    const key = scopeKey(normalized);
    if (seen.has(key)) throw new TypeError('managedScopes must not contain duplicate package/version/use-case scopes');
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
function validatePublicKey(entry) {
  if (!isRecord(entry) || typeof entry.keyId !== 'string' || !KEY_ID.test(entry.keyId)
    || typeof entry.publicKeyPem !== 'string' || entry.publicKeyPem.length > 16_384
    || !entry.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')
    || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(entry.publicKeyPem)
    || typeof entry.fingerprintSha256 !== 'string' || !SHA256.test(entry.fingerprintSha256)
    || !['ACTIVE', 'REVOKED'].includes(entry.status)) {
    fail('INVALID_SIGNING_KEY_SNAPSHOT', 'A signing-key snapshot entry is malformed');
  }
  let key;
  try { key = createPublicKey(entry.publicKeyPem); }
  catch { fail('INVALID_SIGNING_KEY_SNAPSHOT', 'A signing-key snapshot contains an invalid public key'); }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('INVALID_SIGNING_KEY_SNAPSHOT', 'Only Ed25519 signing public keys are accepted');
  }
  const fingerprint = createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (fingerprint !== entry.fingerprintSha256) {
    fail('INVALID_SIGNING_KEY_SNAPSHOT', 'A signing-key fingerprint does not match its public key');
  }
  return {
    keyId: entry.keyId,
    publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprintSha256: fingerprint,
    status: entry.status,
  };
}
function validateSignerSnapshot(raw, expected, now, maxAgeMs) {
  if (!isRecord(raw) || raw.schemaVersion !== 1
    || typeof raw.tenantId !== 'string' || raw.tenantId.toLowerCase() !== expected.tenantId
    || typeof raw.factoryId !== 'string' || raw.factoryId.toLowerCase() !== expected.factoryId
    || !Array.isArray(raw.signingKeys) || raw.signingKeys.length > MAX_KEYS) {
    fail('INVALID_SIGNING_KEY_SNAPSHOT', 'Signing-key snapshot schema or tenant/factory scope is invalid');
  }
  const checkedAt = safeTime(raw.checkedAt, 'signing-key checkedAt', now, maxAgeMs);
  const ids = new Set();
  const fingerprints = new Map();
  const signingKeys = raw.signingKeys.map(validatePublicKey);
  for (const key of signingKeys) {
    if (ids.has(key.keyId)) fail('INVALID_SIGNING_KEY_SNAPSHOT', 'Signing-key snapshot contains duplicate key IDs');
    ids.add(key.keyId);
    const priorKeyId = fingerprints.get(key.fingerprintSha256);
    if (priorKeyId && priorKeyId !== key.keyId) {
      fail('INVALID_SIGNING_KEY_SNAPSHOT', 'Two signing-key IDs bind the same public-key fingerprint');
    }
    fingerprints.set(key.fingerprintSha256, key.keyId);
  }
  return { schemaVersion: 1, tenantId: expected.tenantId, factoryId: expected.factoryId, checkedAt, signingKeys };
}
function validateControl(raw, scope, now, maxAgeMs) {
  if (!isRecord(raw) || raw.packageId !== scope.packageId || raw.packageVersion !== scope.version
    || !STATUSES.has(raw.status) || !Array.isArray(raw.matchedControls) || raw.matchedControls.length > 2048
    || (raw.reason !== null && raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 300))) {
    fail('INVALID_CONTROL_SNAPSHOT', 'Effective package-control response did not match its requested scope');
  }
  const checkedAt = safeTime(raw.checkedAt, 'package-control checkedAt', now, maxAgeMs);
  return {
    packageId: scope.packageId,
    packageVersion: scope.version,
    useCaseId: scope.useCaseId,
    status: raw.status,
    reason: raw.reason ?? null,
    checkedAt,
    lastErrorCode: null,
    matchedControls: raw.matchedControls,
  };
}
function mergeSignerHistory(prior, incoming) {
  const next = new Map(incoming.map((entry) => [entry.keyId, { ...entry }]));
  for (const old of prior) {
    const current = next.get(old.keyId);
    if (current && current.fingerprintSha256 !== old.fingerprintSha256) {
      fail('TRUST_STORE_CONFLICT', 'A signing-key ID cannot be rebound to different key material');
    }
    if (old.status === 'REVOKED' || !current) {
      next.set(old.keyId, { ...old, status: 'REVOKED' });
    }
  }
  return [...next.values()];
}
function mergeControlHistory(prior, incoming) {
  const old = new Map(prior.map((entry) => [scopeKey({
    packageId: entry.packageId,
    version: entry.packageVersion,
    useCaseId: entry.useCaseId,
  }), entry]));
  return incoming.map((entry) => {
    const previous = old.get(scopeKey({
      packageId: entry.packageId,
      version: entry.packageVersion,
      useCaseId: entry.useCaseId,
    }));
    if (previous?.status === 'REVOKED' && entry.status !== 'REVOKED') {
      return { ...previous, status: 'REVOKED', lastErrorCode: null };
    }
    return entry;
  });
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function errorCode(error) {
  return error instanceof EdgePackageSyncError && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'EDGE_SYNC_FAILED';
}
async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) {
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Authenticated edge-agent poller for the existing device package-governance endpoints.
 * Call pollOnce from the supervisor's health-controlled schedule. Any partial, invalid,
 * stale, failed or unpersisted poll marks the snapshot unhealthy and never opens execution.
 */
export class EdgePackageControlSyncClient {
  constructor(options = {}) {
    if (typeof options.baseUrl !== 'string' || !options.baseUrl.trim()) throw new TypeError('baseUrl is required');
    if (typeof options.deviceId !== 'string' || !UUID.test(options.deviceId)) throw new TypeError('deviceId must be a UUID');
    if (typeof options.tenantId !== 'string' || !UUID.test(options.tenantId)
      || typeof options.factoryId !== 'string' || !UUID.test(options.factoryId)) {
      throw new TypeError('Expected tenantId and factoryId UUIDs from device provisioning are required');
    }
    if (typeof options.token !== 'string' || !options.token.trim() || options.token.length > 4096) {
      throw new TypeError('A bounded device credential token is required');
    }
    if (typeof options.stateFile !== 'string' || !options.stateFile.trim()) throw new TypeError('A durable stateFile path is required');
    this.scopes = validateScopes(options.managedScopes);
    this.base = new URL(options.baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname);
    const localHttp = options.allowInsecureLocalhost === true && process.env.NODE_ENV !== 'production'
      && local && this.base.protocol === 'http:';
    if (this.base.username || this.base.password || this.base.search || this.base.hash
      || (this.base.protocol !== 'https:' && !localHttp)
      || (this.base.pathname !== '/' && this.base.pathname !== '')) {
      throw new TypeError('baseUrl must be an origin-only HTTPS URL (or explicit loopback HTTP in development)');
    }
    this.baseUrl = this.base.origin;
    this.deviceId = options.deviceId.toLowerCase();
    this.tenantId = options.tenantId.toLowerCase();
    this.factoryId = options.factoryId.toLowerCase();
    this.token = options.token;
    this.statePath = resolve(options.stateFile);
    this.stateDirectory = dirname(this.statePath);
    this.timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
    this.maxSnapshotAgeMs = options.maxSnapshotAgeMs === undefined ? 5 * 60 * 1000 : options.maxSnapshotAgeMs;
    this.maxStateBytes = options.maxStateBytes === undefined ? MAX_STATE_BYTES : options.maxStateBytes;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) throw new TypeError('timeoutMs must be between 100 and 30000');
    if (!Number.isSafeInteger(this.maxSnapshotAgeMs) || this.maxSnapshotAgeMs < 1000 || this.maxSnapshotAgeMs > MAX_ALLOWED_AGE_MS) {
      throw new TypeError('maxSnapshotAgeMs must be between 1000 and 86400000');
    }
    if (!Number.isSafeInteger(this.maxStateBytes) || this.maxStateBytes < 4096 || this.maxStateBytes > MAX_STATE_BYTES) {
      throw new TypeError('maxStateBytes must be between 4096 and the hard 2 MiB state bound');
    }
    if (typeof this.fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.initialized = false;
    this.state = null;
    this.pollPromise = null;
    this.runtimeErrorCode = 'INITIAL_SYNC_REQUIRED';
  }

  async initialize() {
    if (this.initialized) return this.getSnapshot();
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.stateDirectory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) {
      fail('LOCAL_STATE_CORRUPT', 'State directory must be a private real directory, not a symlink');
    }
    let raw;
    try {
      const file = await lstat(this.statePath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > this.maxStateBytes || (file.mode & 0o077) !== 0) {
        fail('LOCAL_STATE_CORRUPT', 'Persisted package-sync state must be a bounded owner-only regular file');
      }
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.runtimeErrorCode = errorCode(error);
        throw error;
      }
    }
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed) || parsed.schemaVersion !== 1
          || parsed.deviceId !== this.deviceId || parsed.tenantId !== this.tenantId || parsed.factoryId !== this.factoryId
          || !Array.isArray(parsed.signingKeys) || parsed.signingKeys.length > MAX_KEYS
          || !Array.isArray(parsed.controls) || parsed.controls.length > MAX_SCOPES
          || (parsed.syncedAt !== null && (typeof parsed.syncedAt !== 'string' || !Number.isFinite(Date.parse(parsed.syncedAt))))
          || (parsed.lastErrorCode !== null && (typeof parsed.lastErrorCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(parsed.lastErrorCode)))) {
          fail('LOCAL_STATE_CORRUPT', 'Persisted package-sync state failed schema validation');
        }
        const keys = parsed.signingKeys.map(validatePublicKey);
        if (new Set(keys.map((key) => key.keyId)).size !== keys.length) fail('LOCAL_STATE_CORRUPT', 'Persisted signer state contains duplicate key IDs');
        const persistedScopes = parsed.controls.map((entry) => {
          if (!isRecord(entry) || typeof entry.packageId !== 'string' || typeof entry.packageVersion !== 'string'
            || !STATUSES.has(entry.status) || !Number.isFinite(Date.parse(entry.checkedAt ?? ''))) {
            fail('LOCAL_STATE_CORRUPT', 'Persisted package-control state is malformed');
          }
          return scopeKey({ packageId: entry.packageId, version: entry.packageVersion, useCaseId: entry.useCaseId });
        });
        const expected = this.scopes.map(scopeKey).sort();
        if (persistedScopes.length !== expected.length || persistedScopes.sort().some((key, index) => key !== expected[index])) {
          fail('LOCAL_STATE_CORRUPT', 'Persisted managed scopes do not match the configured agent scopes');
        }
        this.state = {
          schemaVersion: 1,
          deviceId: this.deviceId,
          tenantId: this.tenantId,
          factoryId: this.factoryId,
          syncedAt: parsed.syncedAt,
          lastErrorCode: parsed.lastErrorCode,
          signingKeys: keys,
          controls: parsed.controls.map(entry => ({ ...entry })),
        };
      } catch (error) {
        this.runtimeErrorCode = errorCode(error);
        throw error;
      }
    }
    this.initialized = true;
    this.runtimeErrorCode = this.state?.lastErrorCode ?? 'INITIAL_SYNC_REQUIRED';
    return this.getSnapshot();
  }

  getSnapshot() {
    const state = this.state;
    if (!this.initialized || !state) {
      return {
        healthy: false,
        lastErrorCode: this.runtimeErrorCode,
        syncedAt: null,
        tenantId: this.tenantId,
        factoryId: this.factoryId,
        deviceId: this.deviceId,
        signingKeys: [],
        controls: this.scopes.map(scope => ({
          packageId: scope.packageId, packageVersion: scope.version, useCaseId: scope.useCaseId,
          status: 'PAUSED', checkedAt: null, lastErrorCode: this.runtimeErrorCode,
        })),
      };
    }
    const syncedMs = state.syncedAt === null ? NaN : Date.parse(state.syncedAt);
    const age = Date.now() - syncedMs;
    const fresh = Number.isFinite(age) && age >= 0 && age <= this.maxSnapshotAgeMs;
    const healthy = state.lastErrorCode === null && fresh && this.runtimeErrorCode === null
      && state.controls.length === this.scopes.length;
    return {
      ...clone(state),
      healthy,
      freshnessAgeMs: Number.isFinite(age) ? age : null,
      maxSnapshotAgeMs: this.maxSnapshotAgeMs,
      lastErrorCode: healthy ? null : (state.lastErrorCode ?? this.runtimeErrorCode ?? 'STALE_PACKAGE_SYNC'),
    };
  }

  pollOnce() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollOnceInternal().finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  async pollOnceInternal() {
    if (!this.initialized) await this.initialize();
    try {
      // Validate every response first; do not persist partial snapshots.
      const now = Date.now();
      const keyUrl = this.endpoint('/api/v2/edge/device-package-signing-keys/' + encodeURIComponent(this.deviceId));
      const rawSignerSnapshot = await this.requestJson(keyUrl);
      const signerSnapshot = validateSignerSnapshot(rawSignerSnapshot, {
        tenantId: this.tenantId, factoryId: this.factoryId,
      }, now, this.maxSnapshotAgeMs);
      const rawControls = await Promise.all(this.scopes.map(async (scope) => {
        const url = new URL('/api/v2/edge/device-package-controls/' + encodeURIComponent(this.deviceId) + '/effective', this.baseUrl);
        url.searchParams.set('package_id', scope.packageId);
        url.searchParams.set('package_version', scope.version);
        if (scope.useCaseId !== null) url.searchParams.set('use_case_id', scope.useCaseId);
        return { scope, raw: await this.requestJson(url) };
      }));
      const controls = rawControls.map(({ scope, raw }) => validateControl(raw, scope, Date.now(), this.maxSnapshotAgeMs));
      const signerHistory = mergeSignerHistory(this.state?.signingKeys ?? [], signerSnapshot.signingKeys);
      const controlHistory = mergeControlHistory(this.state?.controls ?? [], controls);
      const nextState = {
        schemaVersion: 1,
        deviceId: this.deviceId,
        tenantId: this.tenantId,
        factoryId: this.factoryId,
        syncedAt: new Date().toISOString(),
        lastErrorCode: null,
        signingKeys: signerHistory,
        controls: controlHistory,
      };
      await this.writeStateAtomically(nextState);
      this.state = nextState;
      this.runtimeErrorCode = null;
      return this.getSnapshot();
    } catch (error) {
      const code = errorCode(error);
      this.runtimeErrorCode = code;
      if (this.state) {
        const failedState = { ...this.state, lastErrorCode: code };
        try {
          await this.writeStateAtomically(failedState);
          this.state = failedState;
        } catch {
          // In-memory fail-closed state still blocks this process if disk persistence also fails.
        }
      }
      throw new EdgePackageSyncError(code, 'Edge package-control synchronization failed; runtime must remain blocked');
    }
  }

  endpoint(path) {
    return new URL(path, this.baseUrl);
  }

  async requestJson(url) {
    let response;
    try {
      response = await this.fetchImpl(url.href, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + this.token, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      fail('EDGE_SYNC_UNAVAILABLE', 'Package-governance endpoint could not be reached securely');
    }
    if (!response || typeof response.ok !== 'boolean') fail('EDGE_SYNC_UNAVAILABLE', 'Package-governance endpoint returned an invalid response');
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : 0;
      fail('HTTP_' + (status >= 100 && status <= 599 ? status : 0), 'Package-governance endpoint rejected synchronization');
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('RESPONSE_TOO_LARGE', 'Package-governance response exceeds the bounded size limit');
    let body;
    try { body = await response.text(); } catch { fail('INVALID_CONTROL_SNAPSHOT', 'Package-governance response body could not be read'); }
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) fail('RESPONSE_TOO_LARGE', 'Package-governance response exceeds the bounded size limit');
    try { return JSON.parse(body); } catch { fail('INVALID_CONTROL_SNAPSHOT', 'Package-governance endpoint returned invalid JSON'); }
  }

  async writeStateAtomically(state) {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxStateBytes) fail('LOCAL_STATE_TOO_LARGE', 'Package-sync state exceeds its configured bound');
    const temp = join(this.stateDirectory, '.package-sync-' + randomUUID() + '.tmp');
    let handle;
    try {
      try {
        const existing = await lstat(this.statePath);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size > this.maxStateBytes || (existing.mode & 0o077) !== 0) {
          fail('LOCAL_STATE_CORRUPT', 'Package-sync state destination is not a bounded owner-only regular file');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, this.statePath);
      await syncDirectory(this.stateDirectory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}
