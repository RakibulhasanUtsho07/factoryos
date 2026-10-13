import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
} from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EdgePackageActivationStore } from './edge-package-activation.store.js';
import {
  edgePackageSigningPayload,
  type EdgePackageManifestV1,
  type EdgePackageVerificationPolicy,
  type SignedEdgePackageInput,
} from './edge-package-manifest-verifier.js';
import {
  EdgePackageActivationCoordinatorError,
  EdgePackageReleaseCoordinator,
  type EdgePackageActivationRuntime,
  type EdgePackageActivationScope,
} from './edge-package-release-coordinator.js';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const currentTime = new Date('2026-10-12T12:00:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const modelBytes = Buffer.from('model-release-bytes');
const policyBytes = Buffer.from('policy-release-bytes');
const modelHash = createHash('sha256').update(modelBytes).digest('hex');
const policyHash = createHash('sha256').update(policyBytes).digest('hex');

function makeManifest(overrides: Record<string, unknown> = {}): EdgePackageManifestV1 {
  return {
    schemaVersion: 1,
    packageId: 'quality-defect',
    version: '1.2.0',
    tenantId,
    factoryId,
    issuedAt: '2026-10-12T11:00:00.000Z',
    expiresAt: '2026-11-12T11:00:00.000Z',
    signingKeyId: 'edge-release-key-v1',
    model: {
      modelId: 'quality-defect',
      version: '1.2.0',
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
    rollback: { enabled: false, targetVersion: null },
    ...overrides,
  } as EdgePackageManifestV1;
}

function signedPackage(manifest = makeManifest()): SignedEdgePackageInput {
  return {
    manifest,
    signature: signPayload(null, edgePackageSigningPayload(manifest), keyPair.privateKey).toString('base64'),
    artifacts: {
      'models/quality-defect.bin': modelBytes,
      'policy/edge-policy.json': policyBytes,
    },
  };
}

function verificationPolicy(
  overrides: Partial<EdgePackageVerificationPolicy> = {},
): EdgePackageVerificationPolicy {
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

const scope: EdgePackageActivationScope = {
  tenantId,
  factoryId,
  packageId: 'quality-defect',
  version: '1.2.0',
  useCaseId: 'inspection',
  allowedToolIds: new Set(['AI.RUNTIME.NOOP']),
  now: currentTime,
};

describe('EdgePackageReleaseCoordinator', () => {
  let temporaryDirectory: string;
  let store: EdgePackageActivationStore;
  let runtime: EdgePackageActivationRuntime & {
    isPackageExecutionAllowed: jest.Mock;
    createPackageVerificationPolicy: jest.Mock;
  };
  let coordinator: EdgePackageReleaseCoordinator;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'factoryos-edge-coordinator-'));
    store = new EdgePackageActivationStore(join(temporaryDirectory, 'releases'), () => currentTime);
    runtime = {
      isPackageExecutionAllowed: jest.fn().mockReturnValue(true),
      createPackageVerificationPolicy: jest.fn().mockImplementation(() => verificationPolicy()),
    };
    coordinator = new EdgePackageReleaseCoordinator(store, runtime);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('activates only after checking the exact control scope and creates the synchronized signing policy', async () => {
    const result = await coordinator.activate(signedPackage(), scope);

    expect(result.activated).toBe(true);
    expect(runtime.isPackageExecutionAllowed).toHaveBeenCalledWith(
      'quality-defect',
      '1.2.0',
      'inspection',
    );
    expect(runtime.createPackageVerificationPolicy).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      factoryId,
      allowedToolIds: scope.allowedToolIds,
      now: currentTime,
    }));
    await expect(store.getState('quality-defect')).resolves.toMatchObject({
      active: { version: '1.2.0' },
    });
  });

  it('denies activation when controls are unknown, stale, paused or revoked', async () => {
    runtime.isPackageExecutionAllowed.mockReturnValue(false);

    await expect(coordinator.activate(signedPackage(), scope)).rejects.toMatchObject({
      code: 'PACKAGE_CONTROL_DENIED',
    });
    expect(runtime.createPackageVerificationPolicy).not.toHaveBeenCalled();
    await expect(store.getState('quality-defect')).resolves.toBeNull();
  });

  it('rejects a manifest targeting a different package version before consulting the gate', async () => {
    const input = signedPackage(makeManifest({ version: '1.3.0' }));

    await expect(coordinator.activate(input, scope)).rejects.toMatchObject({
      code: 'PACKAGE_SCOPE_MISMATCH',
    });
    expect(runtime.isPackageExecutionAllowed).not.toHaveBeenCalled();
    expect(runtime.createPackageVerificationPolicy).not.toHaveBeenCalled();
    await expect(store.getState('quality-defect')).resolves.toBeNull();
  });

  it('fails closed when synchronized signer policy says the signing key is revoked', async () => {
    runtime.createPackageVerificationPolicy.mockImplementation(() => verificationPolicy({
      trustedSigningKeys: {
        'edge-release-key-v1': { publicKeyPem, status: 'REVOKED' },
      },
    }));

    await expect(coordinator.activate(signedPackage(), scope)).rejects.toMatchObject({
      code: 'REVOKED_SIGNING_KEY',
    });
    await expect(store.getState('quality-defect')).resolves.toBeNull();
  });

  it('refuses incomplete scopes before invoking the runtime or activation store', async () => {
    await expect(coordinator.activate(signedPackage(), {
      ...scope,
      allowedToolIds: undefined as never,
    })).rejects.toBeInstanceOf(EdgePackageActivationCoordinatorError);
    expect(runtime.isPackageExecutionAllowed).not.toHaveBeenCalled();
    expect(runtime.createPackageVerificationPolicy).not.toHaveBeenCalled();
  });
});
