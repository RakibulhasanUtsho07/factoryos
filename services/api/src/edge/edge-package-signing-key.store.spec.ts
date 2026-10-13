import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  EdgePackageSigningKeyStore,
  EdgePackageSigningKeyStoreError,
  type EdgePackageSigningKeySnapshot,
  type EdgePackageSigningKeySnapshotEntry,
} from './edge-package-signing-key.store.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const factoryId = '33333333-3333-4333-8333-333333333333';
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprintSha256 = createHash('sha256')
  .update(keyPair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const KEY: EdgePackageSigningKeySnapshotEntry = {
  keyId: 'edge-signing-v1',
  publicKeyPem,
  fingerprintSha256,
  status: 'ACTIVE',
};
function snapshot(keys: EdgePackageSigningKeySnapshotEntry[] = [KEY], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    tenantId,
    factoryId,
    checkedAt: new Date().toISOString(),
    signingKeys: keys,
    ...overrides,
  } as EdgePackageSigningKeySnapshot;
}
function policy() {
  return {
    tenantId,
    factoryId,
    allowedToolIds: new Set(['AI.RUNTIME.NOOP']),
  };
}

describe('EdgePackageSigningKeyStore', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'factoryos-signing-key-store-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('persists an authenticated public-key snapshot and supplies trusted keys to verifier policy', async () => {
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await store.initialize();
    await store.applySnapshot(snapshot());
    const verifyPolicy = store.createVerificationPolicy(policy(), 60_000);
    expect(verifyPolicy.trustedSigningKeys['edge-signing-v1']).toEqual({
      publicKeyPem,
      status: 'ACTIVE',
    });
    expect(store.getSyncStatus()).toMatchObject({
      tenantId, factoryId, keyCount: 1, activeKeyCount: 1, revokedKeyCount: 0,
      lastSuccessfulSyncAt: expect.any(String), lastErrorCode: null,
    });

    const restarted = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await restarted.initialize();
    expect(restarted.createVerificationPolicy(policy(), 60_000).trustedSigningKeys['edge-signing-v1'])
      .toEqual({ publicKeyPem, status: 'ACTIVE' });
  });

  it('fails closed when the last signer snapshot is stale or a later poll fails', async () => {
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await store.initialize();
    await store.applySnapshot(snapshot());
    expect(store.createVerificationPolicy(policy(), 60_000).trustedSigningKeys['edge-signing-v1']?.status)
      .toBe('ACTIVE');

    await store.recordSyncFailure('HTTP_503');
    expect(store.createVerificationPolicy(policy(), 60_000).trustedSigningKeys['edge-signing-v1']?.status)
      .toBe('REVOKED');
    expect(store.getSyncStatus().lastErrorCode).toBe('HTTP_503');
  });

  it('keeps a revoked key terminal even if a later complete snapshot calls it active', async () => {
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await store.initialize();
    await store.applySnapshot(snapshot([KEY]));
    await store.applySnapshot(snapshot([{ ...KEY, status: 'REVOKED' }]));
    await store.applySnapshot(snapshot([KEY]));
    expect(store.getTrustedSigningKeys(60_000)['edge-signing-v1']?.status).toBe('REVOKED');
  });

  it('revokes a previously known key omitted from the complete server snapshot and keeps it revoked after restart', async () => {
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await store.initialize();
    await store.applySnapshot(snapshot([KEY]));
    await store.applySnapshot(snapshot([]));
    expect(store.getTrustedSigningKeys(60_000)['edge-signing-v1']?.status).toBe('REVOKED');

    const restarted = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await restarted.initialize();
    expect(restarted.getTrustedSigningKeys(60_000)['edge-signing-v1']?.status).toBe('REVOKED');
  });

  it('rejects snapshots with a wrong tenant scope or public-key fingerprint mismatch', async () => {
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await store.initialize();
    await expect(store.applySnapshot(snapshot([KEY], {
      tenantId: '22222222-2222-4222-8222-222222222222',
    }))).rejects.toBeInstanceOf(EdgePackageSigningKeyStoreError);
    await expect(store.applySnapshot(snapshot([{
      ...KEY,
      fingerprintSha256: 'a'.repeat(64),
    }]))).rejects.toMatchObject({ code: 'TRUST_STORE_CORRUPT' });
    expect(store.getSyncStatus().keyCount).toBe(0);
  });

  it('refuses to rebind a key ID to different public-key material', async () => {
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await store.initialize();
    await store.applySnapshot(snapshot([KEY]));
    const anotherPair = generateKeyPairSync('ed25519');
    const anotherPem = anotherPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const anotherFingerprint = createHash('sha256')
      .update(anotherPair.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    await expect(store.applySnapshot(snapshot([{
      ...KEY, publicKeyPem: anotherPem, fingerprintSha256: anotherFingerprint,
    }]))).rejects.toMatchObject({ code: 'TRUST_STORE_CONFLICT' });
  });

  it('rejects a symlinked local trust state and mismatched verifier scope', async () => {
    const outside = join(rootDir, 'outside.json');
    await writeFile(outside, JSON.stringify({ schema_version: 1 }));
    await symlink(outside, join(rootDir, 'signing-keys.json'));
    const store = new EdgePackageSigningKeyStore(rootDir, tenantId);
    await expect(store.initialize()).rejects.toBeInstanceOf(EdgePackageSigningKeyStoreError);

    const empty = await mkdtemp(join(tmpdir(), 'factoryos-empty-signing-store-'));
    try {
      const emptyStore = new EdgePackageSigningKeyStore(empty, tenantId);
      await emptyStore.initialize();
      expect(() => emptyStore.createVerificationPolicy({
        ...policy(), factoryId: '44444444-4444-4444-8444-444444444444',
      }, 60_000)).not.toThrow();
      await emptyStore.applySnapshot(snapshot());
      expect(() => emptyStore.createVerificationPolicy({
        ...policy(), factoryId: '44444444-4444-4444-8444-444444444444',
      }, 60_000)).toThrow(EdgePackageSigningKeyStoreError);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
