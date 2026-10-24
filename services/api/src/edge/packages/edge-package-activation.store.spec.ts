import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EdgePackageActivationError,
  EdgePackageActivationStore,
} from './edge-package-activation.store.js';
import {
  EdgePackageVerificationError,
  edgePackageSigningPayload,
  type EdgePackageManifestV1,
  type EdgePackageVerificationPolicy,
  type SignedEdgePackageInput,
} from './edge-package-manifest-verifier.js';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const currentTime = new Date('2026-10-12T12:00:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const modelBytes = Buffer.from('model-v1-bytes');
const policyBytes = Buffer.from('policy-v1-bytes');
const modelHash = createHash('sha256').update(modelBytes).digest('hex');
const policyHash = createHash('sha256').update(policyBytes).digest('hex');

function makeManifest(
  version: string,
  rollback: { enabled: boolean; targetVersion: string | null },
  overrides: Record<string, unknown> = {},
): EdgePackageManifestV1 {
  return {
    schemaVersion: 1,
    packageId: 'quality-defect',
    version,
    tenantId,
    factoryId,
    issuedAt: '2026-10-12T11:00:00.000Z',
    expiresAt: '2026-11-12T11:00:00.000Z',
    signingKeyId: 'edge-release-key-v1',
    model: {
      modelId: 'quality-defect',
      version,
      artifactPath: 'models/quality-defect.bin',
    },
    policyBundle: {
      version: '3.1.0',
      artifactPath: 'policy/edge-policy.json',
    },
    allowedTools: ['AI.RUNTIME.NOOP'],
    artifacts: [
      { path: 'models/quality-defect.bin', sha256: modelHash, sizeBytes: modelBytes.byteLength },
      { path: 'policy/edge-policy.json', sha256: policyHash, sizeBytes: policyBytes.byteLength },
    ],
    rollback,
    ...overrides,
  } as EdgePackageManifestV1;
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

function policy(overrides: Partial<EdgePackageVerificationPolicy> = {}): EdgePackageVerificationPolicy {
  return {
    tenantId,
    factoryId,
    trustedSigningKeys: {
      'edge-release-key-v1': { publicKeyPem, status: 'ACTIVE' },
    },
    allowedToolIds: new Set(['AI.RUNTIME.NOOP']),
    now: currentTime,
    ...overrides,
  };
}

describe('EdgePackageActivationStore', () => {
  let temporaryDirectory: string;
  let storeDirectory: string;
  let store: EdgePackageActivationStore;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'factoryos-edge-release-'));
    storeDirectory = join(temporaryDirectory, 'store');
    store = new EdgePackageActivationStore(storeDirectory, () => currentTime);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('atomically activates a verified release and reloads the persisted active pointer', async () => {
    const input = signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null }));
    const result = await store.activate(input, policy());

    expect(result.activated).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.state.active.version).toBe('1.1.0');
    expect(result.state.previous).toBeNull();
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const modelPath = join(
      storeDirectory,
      'quality-defect',
      'releases',
      result.manifestSha256,
      'models',
      'quality-defect.bin',
    );
    await expect(readFile(modelPath)).resolves.toEqual(modelBytes);

    const restartedStore = new EdgePackageActivationStore(storeDirectory, () => currentTime);
    await expect(restartedStore.getState('quality-defect')).resolves.toEqual(result.state);
    const replay = await restartedStore.activate(input, policy());
    expect(replay.activated).toBe(false);
    expect(replay.idempotent).toBe(true);
  });

  it('switches the active pointer back to the exact signed rollback target', async () => {
    await store.activate(
      signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null })),
      policy(),
    );
    await store.activate(
      signedPackage(makeManifest('1.2.0', { enabled: true, targetVersion: '1.1.0' })),
      policy(),
    );

    const rolledBack = await store.rollback('quality-defect', policy());
    expect(rolledBack.active.version).toBe('1.1.0');
    expect(rolledBack.previous?.version).toBe('1.2.0');

    const persisted = await store.getState('quality-defect');
    expect(persisted).toEqual(rolledBack);
  });

  it('does not change the active pointer when a new package names the wrong rollback target', async () => {
    await store.activate(
      signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null })),
      policy(),
    );
    const before = await store.getState('quality-defect');

    await expect(store.activate(
      signedPackage(makeManifest('1.2.0', { enabled: true, targetVersion: '1.0.0' })),
      policy(),
    )).rejects.toMatchObject({ code: 'ROLLBACK_TARGET_MISMATCH' });

    expect(await store.getState('quality-defect')).toEqual(before);
  });

  it('refuses rollback when the persisted target artifact was modified', async () => {
    await store.activate(
      signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null })),
      policy(),
    );
    const second = await store.activate(
      signedPackage(makeManifest('1.2.0', { enabled: true, targetVersion: '1.1.0' })),
      policy(),
    );
    const previousHash = second.state.previous?.manifestSha256;
    if (!previousHash) throw new Error('Test setup did not persist a previous release');

    const oldArtifactPath = join(
      storeDirectory,
      'quality-defect',
      'releases',
      previousHash,
      'models',
      'quality-defect.bin',
    );
    await writeFile(oldArtifactPath, Buffer.from('tampered'));

    await expect(store.rollback('quality-defect', policy())).rejects.toBeInstanceOf(
      EdgePackageVerificationError,
    );
    const unchanged = await store.getState('quality-defect');
    expect(unchanged?.active.version).toBe('1.2.0');
    expect(unchanged?.active.manifestSha256).toBe(second.manifestSha256);
  });

  it('fails closed when there is no active release or no recorded previous release', async () => {
    await expect(store.rollback('quality-defect', policy())).rejects.toMatchObject({
      code: 'NO_ACTIVE_RELEASE',
    });
    await store.activate(
      signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null })),
      policy(),
    );
    await expect(store.rollback('quality-defect', policy())).rejects.toMatchObject({
      code: 'NO_ROLLBACK_TARGET',
    });
  });

  it('rejects different contents for an already active package version', async () => {
    await store.activate(
      signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null })),
      policy(),
    );
    const conflicting = signedPackage(makeManifest(
      '1.1.0',
      { enabled: false, targetVersion: null },
      { model: {
        modelId: 'quality-defect-alt',
        version: '1.1.0',
        artifactPath: 'models/quality-defect.bin',
      } },
    ));
    await expect(store.activate(conflicting, policy())).rejects.toMatchObject({
      code: 'RELEASE_VERSION_CONFLICT',
    });
    await expect(store.getState('quality-defect')).resolves.toMatchObject({
      active: { version: '1.1.0' },
    });
  });

  it('rejects malformed package IDs before touching the filesystem', async () => {
    await expect(store.rollback('../other-package', policy())).rejects.toBeInstanceOf(
      EdgePackageActivationError,
    );
  });

  it('rejects an invalid signature before creating a release or pointer', async () => {
    const input = signedPackage(makeManifest('1.1.0', { enabled: false, targetVersion: null }));
    input.signature = Buffer.alloc(64, 1).toString('base64');
    await expect(store.activate(input, policy())).rejects.toBeInstanceOf(EdgePackageVerificationError);
    await expect(store.getState('quality-defect')).resolves.toBeNull();
  });
});
