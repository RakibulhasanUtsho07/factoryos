import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import type { EdgePackageTrustedSigningKey, EdgePackageVerificationPolicy } from './packages/edge-package-manifest-verifier.js';
import {
  mkdir, lstat, open, readFile, rename, unlink, type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_KEYS = 512;
const MAX_FILE_BYTES = 512 * 1024;
const KEY_STATUSES = ['ACTIVE', 'REVOKED'] as const;

export type EdgePackageSigningKeyStatus = typeof KEY_STATUSES[number];

export interface EdgePackageSigningKeySnapshotEntry {
  keyId: string;
  publicKeyPem: string;
  fingerprintSha256: string;
  status: EdgePackageSigningKeyStatus;
}

export interface EdgePackageSigningKeySnapshot {
  schemaVersion: 1;
  tenantId: string;
  factoryId: string;
  checkedAt: string;
  signingKeys: EdgePackageSigningKeySnapshotEntry[];
}

export interface EdgePackageSigningKeySyncStatus {
  tenantId: string;
  factoryId: string | null;
  keyCount: number;
  activeKeyCount: number;
  revokedKeyCount: number;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
}

export type EdgePackageSigningKeyStoreErrorCode =
  | 'TRUST_STORE_CORRUPT'
  | 'TRUST_STORE_NOT_INITIALIZED'
  | 'TRUST_STORE_SCOPE_MISMATCH'
  | 'TRUST_STORE_CONFLICT';

export class EdgePackageSigningKeyStoreError extends Error {
  constructor(readonly code: EdgePackageSigningKeyStoreErrorCode, message: string) {
    super(message);
    this.name = 'EdgePackageSigningKeyStoreError';
  }
}

interface PersistedTrustState {
  schema_version: 1;
  tenant_id: string;
  factory_id: string;
  synced_at: string;
  last_error_code: string | null;
  signing_keys: EdgePackageSigningKeySnapshotEntry[];
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function publicKeyDetails(value: unknown): { pem: string; fingerprintSha256: string } {
  if (typeof value !== 'string' || value.length > 4096 ||
      !value.trim().startsWith('-----BEGIN PUBLIC KEY-----') ||
      value.includes('PRIVATE KEY-----')) {
    throw new EdgePackageSigningKeyStoreError(
      'TRUST_STORE_CORRUPT',
      'Only a bounded public-key PEM can be trusted',
    );
  }
  const pem = value.trim();
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'The public signing key is malformed');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Only Ed25519 signing keys are supported');
  }
  return {
    pem,
    fingerprintSha256: createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex'),
  };
}

function validateEntry(value: unknown): value is EdgePackageSigningKeySnapshotEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['keyId', 'publicKeyPem', 'fingerprintSha256', 'status'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))) {
    return false;
  }
  if (typeof row.keyId !== 'string' || !KEY_ID_PATTERN.test(row.keyId) ||
      typeof row.fingerprintSha256 !== 'string' || !FINGERPRINT_PATTERN.test(row.fingerprintSha256) ||
      !KEY_STATUSES.includes(row.status as EdgePackageSigningKeyStatus)) return false;
  try {
    const detail = publicKeyDetails(row.publicKeyPem);
    return detail.fingerprintSha256 === row.fingerprintSha256;
  } catch {
    return false;
  }
}

function controlSafeObjectKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function makeRecord(raw: unknown): EdgePackageSigningKeySnapshotEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Signer snapshot entry is not an object');
  }
  const row = raw as Record<string, unknown>;
  if (!controlSafeObjectKeys(row, ['keyId', 'publicKeyPem', 'fingerprintSha256', 'status']) ||
      typeof row.keyId !== 'string' || !KEY_ID_PATTERN.test(row.keyId) ||
      typeof row.fingerprintSha256 !== 'string' || !FINGERPRINT_PATTERN.test(row.fingerprintSha256) ||
      !KEY_STATUSES.includes(row.status as EdgePackageSigningKeyStatus)) {
    throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Signer snapshot entry has invalid fields');
  }
  const details = publicKeyDetails(row.publicKeyPem);
  if (details.fingerprintSha256 !== row.fingerprintSha256) {
    throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Signer fingerprint does not match its public key');
  }
  return {
    keyId: row.keyId,
    publicKeyPem: details.pem,
    fingerprintSha256: details.fingerprintSha256,
    status: row.status as EdgePackageSigningKeyStatus,
  };
}

export class EdgePackageSigningKeyStore {
  private readonly statePath: string;
  private readonly expectedTenantId: string;
  private signingKeys = new Map<string, EdgePackageSigningKeySnapshotEntry>();
  private factoryId: string | null = null;
  private syncedAt: string | null = null;
  private lastErrorCode: string | null = null;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly rootDirectory: string, tenantId: string) {
    if (typeof rootDirectory !== 'string' || rootDirectory.trim().length === 0 ||
        typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
      throw new EdgePackageSigningKeyStoreError(
        'TRUST_STORE_CORRUPT',
        'A local state directory and valid tenant scope are required',
      );
    }
    this.expectedTenantId = tenantId.toLowerCase();
    this.statePath = join(rootDirectory, 'signing-keys.json');
  }

  async initialize(): Promise<EdgePackageSigningKeySyncStatus> {
    if (this.initialized) return this.getSyncStatus();
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.rootDirectory);
    let raw: string;
    try {
      const details = await lstat(this.statePath);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_FILE_BYTES) {
        throw new EdgePackageSigningKeyStoreError(
          'TRUST_STORE_CORRUPT',
          'Local signer state must be a bounded regular file',
        );
      }
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      this.initialized = true;
      return this.getSyncStatus();
    }

    try {
      const value = JSON.parse(raw) as Partial<PersistedTrustState>;
      if (value.schema_version !== 1 || value.tenant_id !== this.expectedTenantId ||
          typeof value.factory_id !== 'string' || !UUID_PATTERN.test(value.factory_id) ||
          typeof value.synced_at !== 'string' || !Number.isFinite(Date.parse(value.synced_at)) ||
          !(value.last_error_code === null ||
            (typeof value.last_error_code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.last_error_code))) ||
          !Array.isArray(value.signing_keys) || value.signing_keys.length > MAX_KEYS ||
          !value.signing_keys.every(validateEntry)) {
        throw new Error('Invalid signer trust state');
      }
      const keys = new Map<string, EdgePackageSigningKeySnapshotEntry>();
      for (const rawEntry of value.signing_keys) {
        const entry = makeRecord(rawEntry);
        if (keys.has(entry.keyId)) throw new Error('Duplicate signer key ID');
        keys.set(entry.keyId, entry);
      }
      this.signingKeys = keys;
      this.factoryId = value.factory_id.toLowerCase();
      this.syncedAt = value.synced_at;
      this.lastErrorCode = value.last_error_code ?? null;
    } catch {
      this.signingKeys.clear();
      throw new EdgePackageSigningKeyStoreError(
        'TRUST_STORE_CORRUPT',
        'Local signer state failed validation; no package signer is trusted',
      );
    }
    this.initialized = true;
    return this.getSyncStatus();
  }

  async applySnapshot(raw: unknown): Promise<EdgePackageSigningKeySyncStatus> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Signer snapshot must be an object');
      }
      const snapshot = raw as Record<string, unknown>;
      if (Object.keys(snapshot).length !== 5 ||
          !controlSafeObjectKeys(snapshot, ['schemaVersion', 'tenantId', 'factoryId', 'checkedAt', 'signingKeys']) ||
          snapshot.schemaVersion !== 1 ||
          typeof snapshot.tenantId !== 'string' || !UUID_PATTERN.test(snapshot.tenantId) ||
          snapshot.tenantId.toLowerCase() !== this.expectedTenantId ||
          typeof snapshot.factoryId !== 'string' || !UUID_PATTERN.test(snapshot.factoryId) ||
          typeof snapshot.checkedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.checkedAt)) ||
          !Array.isArray(snapshot.signingKeys) || snapshot.signingKeys.length > MAX_KEYS) {
        throw new EdgePackageSigningKeyStoreError(
          'TRUST_STORE_SCOPE_MISMATCH',
          'Cloud signer snapshot is malformed or outside this device tenant scope',
        );
      }
      const nextFactoryId = snapshot.factoryId.toLowerCase();
      if (this.factoryId && this.factoryId !== nextFactoryId) {
        throw new EdgePackageSigningKeyStoreError(
          'TRUST_STORE_SCOPE_MISMATCH',
          'Cloud signer snapshot changed the bound factory scope',
        );
      }
      const incoming = new Map<string, EdgePackageSigningKeySnapshotEntry>();
      for (const rawEntry of snapshot.signingKeys) {
        const entry = makeRecord(rawEntry);
        if (incoming.has(entry.keyId)) {
          throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Cloud signer snapshot contains duplicate key IDs');
        }
        const previous = this.signingKeys.get(entry.keyId);
        if (previous && previous.fingerprintSha256 !== entry.fingerprintSha256) {
          throw new EdgePackageSigningKeyStoreError(
            'TRUST_STORE_CONFLICT',
            'A signing key ID cannot be rebound to different public key material',
          );
        }
        if (previous?.status === 'REVOKED') entry.status = 'REVOKED';
        incoming.set(entry.keyId, entry);
      }
      // The endpoint is a complete snapshot: a previously known key omitted
      // from it is terminally distrusted rather than retained as active.
      for (const previous of this.signingKeys.values()) {
        if (!incoming.has(previous.keyId)) {
          incoming.set(previous.keyId, { ...previous, status: 'REVOKED' });
        }
      }
      if (incoming.size > MAX_KEYS) {
        throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Merged signer state exceeds the safety limit');
      }

      const previousState = {
        signingKeys: this.signingKeys,
        factoryId: this.factoryId,
        syncedAt: this.syncedAt,
        lastErrorCode: this.lastErrorCode,
      };
      this.signingKeys = incoming;
      this.factoryId = nextFactoryId;
      this.syncedAt = new Date().toISOString();
      this.lastErrorCode = null;
      try {
        await this.writeAtomic();
      } catch {
        this.signingKeys = previousState.signingKeys;
        this.factoryId = previousState.factoryId;
        this.syncedAt = previousState.syncedAt;
        this.lastErrorCode = 'STATE_PERSIST_FAILED';
        throw new EdgePackageSigningKeyStoreError(
          'TRUST_STORE_CORRUPT',
          'Cloud signer state could not be durably saved; verification is disabled',
        );
      }
      return this.getSyncStatus();
    });
  }

  async recordSyncFailure(code: string): Promise<void> {
    await this.withMutationLock(async () => {
      this.ensureInitialized();
      this.lastErrorCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'SYNC_FAILED';
      try {
        if (this.factoryId) await this.writeAtomic();
      } catch {
        // The in-memory error still blocks trust; a subsequent restart will
        // apply the timestamp freshness check before exposing any active key.
      }
    });
  }

  getSyncStatus(): EdgePackageSigningKeySyncStatus {
    this.ensureInitialized();
    const keys = [...this.signingKeys.values()];
    return {
      tenantId: this.expectedTenantId,
      factoryId: this.factoryId,
      keyCount: keys.length,
      activeKeyCount: keys.filter((key) => key.status === 'ACTIVE').length,
      revokedKeyCount: keys.filter((key) => key.status === 'REVOKED').length,
      lastSuccessfulSyncAt: this.syncedAt,
      lastErrorCode: this.lastErrorCode,
    };
  }

  getTrustedSigningKeys(maxAgeMs: number, now = new Date()): Record<string, EdgePackageTrustedSigningKey> {
    this.ensureInitialized();
    const ageMs = this.syncedAt === null || !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
      ? Number.POSITIVE_INFINITY
      : now.getTime() - Date.parse(this.syncedAt);
    const fresh = Number.isInteger(maxAgeMs) && maxAgeMs >= 0 &&
      this.lastErrorCode === null && this.syncedAt !== null &&
      Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
    const keys: Record<string, EdgePackageTrustedSigningKey> = {};
    for (const entry of this.signingKeys.values()) {
      Object.defineProperty(keys, entry.keyId, {
        value: {
          publicKeyPem: entry.publicKeyPem,
          status: fresh ? entry.status : 'REVOKED',
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return keys;
  }

  createVerificationPolicy(
    policy: Omit<EdgePackageVerificationPolicy, 'trustedSigningKeys'>,
    maxAgeMs: number,
  ): EdgePackageVerificationPolicy {
    this.ensureInitialized();
    if (this.factoryId &&
        (policy.tenantId.toLowerCase() !== this.expectedTenantId ||
          policy.factoryId.toLowerCase() !== this.factoryId)) {
      throw new EdgePackageSigningKeyStoreError(
        'TRUST_STORE_SCOPE_MISMATCH',
        'Verifier policy scope does not match the synchronized signing-key registry',
      );
    }
    return {
      ...policy,
      trustedSigningKeys: this.getTrustedSigningKeys(maxAgeMs),
    };
  }

  private async writeAtomic(): Promise<void> {
    const temporaryPath = join(this.rootDirectory, `.signing-keys-${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      const contents = JSON.stringify({
        schema_version: 1,
        tenant_id: this.expectedTenantId,
        factory_id: this.factoryId,
        synced_at: this.syncedAt,
        last_error_code: this.lastErrorCode,
        signing_keys: [...this.signingKeys.values()],
      });
      if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) {
        throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Signer trust state exceeds its storage bound');
      }
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.statePath);
      await this.syncDirectory();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async assertDirectory(directory: string): Promise<void> {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new EdgePackageSigningKeyStoreError('TRUST_STORE_CORRUPT', 'Signer trust root must not be a symlink');
    }
  }

  private async syncDirectory(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.rootDirectory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(errorCode(error) ?? '')) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new EdgePackageSigningKeyStoreError(
        'TRUST_STORE_NOT_INITIALIZED',
        'Initialize the local signer trust store before use',
      );
    }
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}
