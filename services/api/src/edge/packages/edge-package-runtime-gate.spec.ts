import { createHash, generateKeyPairSync, sign as signPayload } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  EdgePackageControlStateStore,
  type DurableEdgePackageControlState,
} from '../edge-package-control-state.store.js';
import { EdgePackageSigningKeyStore } from '../edge-package-signing-key.store.js';
import {
  EdgePackageActivationStore,
  type VerifiedEdgePackageRelease,
} from './edge-package-activation.store.js';
import {
  edgePackageSigningPayload,
  type EdgePackageManifestV1,
  type EdgePackageVerificationPolicy,
  type SignedEdgePackageInput,
} from './edge-package-manifest-verifier.js';
import {
  EdgePackageRuntimeGate,
  type EdgePackageManagedScope,
} from './edge-package-runtime-gate.js';
import type { EdgePackageActivationScope } from './edge-package-release-coordinator.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const factoryId = '33333333-3333-4333-8333-333333333333';
const packageId = 'quality-defect';
const version = '1.2.0';
const useCaseId = 'inspection';
const allowedToolIds = new Set(['AI.RUNTIME.NOOP']);
const modelBytes = Buffer.from('signed-model-bytes-v1');
const policyBytes = Buffer.from('signed-policy-bytes-v1');
const modelHash = createHash('sha256').update(modelBytes).digest('hex');
const policyHash = createHash('sha256').update(policyBytes).digest('hex');
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprintSha256 = createHash('sha256')
  .update(keyPair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

const managedScope: EdgePackageManagedScope = { packageId, version, useCaseId };
const activationScope: EdgePackageActivationScope = {
  tenantId,
  factoryId,
  packageId,
  version,
  useCaseId,
  allowedToolIds,
  maxPackageLifetimeMs: 10 * 24 * 60 * 60 * 1000,
};

function makeManifest(now = new Date()): EdgePackageManifestV1 {
  return {
    schemaVersion: 1,
    packageId,
    version,
    tenantId,
    factoryId,
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    signingKeyId: 'edge-release-key-v1',
    model: { modelId: packageId, version, artifactPath: 'models/quality-defect.bin' },
    policyBundle: { version: '3.1.0', artifactPath: 'policy/edge-policy.json' },
    allowedTools: ['AI.RUNTIME.NOOP'],
    artifacts: [
      { path: 'models/quality-defect.bin', sha256: modelHash, sizeBytes: modelBytes.byteLength },
      { path: 'policy/edge-policy.json', sha256: policyHash, sizeBytes: policyBytes.byteLength },
    ],
    rollback: { enabled: false, targetVersion: null },
  };
}

function signedPackage(manifest: EdgePackageManifestV1): SignedEdgePackageInput {
  return {
    manifest,
    signature: signPayload(null, edgePackageSigningPayload(manifest), keyPair.privateKey).toString('base64'),
    artifacts: {
      'models/quality-defect.bin': modelBytes,
      'policy/edge-policy.json': policyBytes,
    },
  };
}

function snapshot(status: 'ACTIVE' | 'REVOKED' = 'ACTIVE') {
  return {
    schemaVersion: 1,
    tenantId,
    factoryId,
    checkedAt: new Date().toISOString(),
    signingKeys: [{
      keyId: 'edge-release-key-v1',
      publicKeyPem,
      fingerprintSha256,
      status,
    }],
  };
}

function control(status: DurableEdgePackageControlState['status'] = 'ACTIVE'): DurableEdgePackageControlState {
  return {
    packageId,
    packageVersion: version,
    useCaseId,
    status,
    reason: status === 'REVOKED' ? 'Package revoked by operator' : null,
    checkedAt: new Date().toISOString(),
    lastErrorCode: null,
  };
}

describe('EdgePackageRuntimeGate', () => {
  let rootDir: string;
  let controlStore: EdgePackageControlStateStore;
  let signingKeyStore: EdgePackageSigningKeyStore;
  let activationStore: EdgePackageActivationStore;
  let gate: EdgePackageRuntimeGate;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'factoryos-edge-runtime-gate-'));
    controlStore = new EdgePackageControlStateStore(join(rootDir, 'controls'));
    await controlStore.initialize();
    await controlStore.save(control());

    signingKeyStore = new EdgePackageSigningKeyStore(join(rootDir, 'signers'), tenantId);
    await signingKeyStore.initialize();
    await signingKeyStore.applySnapshot(snapshot());

    activationStore = new EdgePackageActivationStore(join(rootDir, 'releases'));
    const now = new Date();
    const initialPolicy: EdgePackageVerificationPolicy = signingKeyStore.createVerificationPolicy({
      tenantId,
      factoryId,
      allowedToolIds,
      now,
      maxPackageLifetimeMs: activationScope.maxPackageLifetimeMs,
    }, 120_000);
    await activationStore.activate(signedPackage(makeManifest(now)), initialPolicy);

    gate = new EdgePackageRuntimeGate(
      activationStore,
      controlStore,
      signingKeyStore,
      tenantId,
      factoryId,
      { maxControlAgeMs: 120_000, maxSigningKeyAgeMs: 120_000 },
    );
    gate.confirmControlSync([managedScope]);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('re-verifies the active signed release and calls the executor only after an exact ACTIVE decision', async () => {
    const executor = jest.fn((release: Readonly<VerifiedEdgePackageRelease>) => release.manifest.version);

    await expect(gate.execute(activationScope, executor)).resolves.toBe(version);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[0].artifacts['models/quality-defect.bin']).toEqual(modelBytes);
    expect(executor.mock.calls[0]?.[0].artifacts['policy/edge-policy.json']).toEqual(policyBytes);
  });

  it('blocks execution after any control-poll failure until a complete sync is confirmed', async () => {
    gate.recordControlSyncFailure();
    const executor = jest.fn();

    await expect(gate.execute(activationScope, executor)).rejects.toMatchObject({
      code: 'PACKAGE_CONTROL_DENIED',
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('blocks stale and paused decisions at the execution boundary', async () => {
    await controlStore.save({ ...control(), checkedAt: '2020-01-01T00:00:00.000Z' });
    const staleExecutor = jest.fn();
    await expect(gate.execute(activationScope, staleExecutor)).rejects.toMatchObject({
      code: 'PACKAGE_CONTROL_DENIED',
    });
    expect(staleExecutor).not.toHaveBeenCalled();

    await controlStore.save(control('PAUSED'));
    const pausedExecutor = jest.fn();
    await expect(gate.execute(activationScope, pausedExecutor)).rejects.toMatchObject({
      code: 'PACKAGE_CONTROL_DENIED',
    });
    expect(pausedExecutor).not.toHaveBeenCalled();
  });

  it('blocks a signer revoked after package activation', async () => {
    await signingKeyStore.applySnapshot(snapshot('REVOKED'));
    const executor = jest.fn();

    await expect(gate.execute(activationScope, executor)).rejects.toBeDefined();
    expect(executor).not.toHaveBeenCalled();
  });

  it('rechecks package control after signature verification to close a pause-during-admission race', async () => {
    const verify = activationStore.verifyActiveRelease.bind(activationStore);
    jest.spyOn(activationStore, 'verifyActiveRelease').mockImplementation(async (id, expectedVersion, policy) => {
      const release = await verify(id, expectedVersion, policy);
      await controlStore.save(control('PAUSED'));
      return release;
    });
    const executor = jest.fn();

    await expect(gate.execute(activationScope, executor)).rejects.toMatchObject({
      code: 'PACKAGE_CONTROL_DENIED',
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects execution scope mismatches before reading a release or invoking the executor', async () => {
    const executor = jest.fn();
    await expect(gate.execute({
      ...activationScope,
      tenantId: '22222222-2222-4222-8222-222222222222',
    }, executor)).rejects.toMatchObject({ code: 'INVALID_RUNTIME_SCOPE' });
    expect(executor).not.toHaveBeenCalled();
  });
});
