import { createHash, generateKeyPairSync, sign as signPayload } from 'node:crypto';

import { jest } from '@jest/globals';

import {
  EdgePackageVerificationError,
  edgePackageSigningPayload,
  verifyEdgePackage,
  type EdgePackageManifestV1,
  type EdgePackageVerificationPolicy,
  type SignedEdgePackageInput,
} from './edge-package-manifest-verifier.js';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const now = new Date('2026-10-12T12:00:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const modelBytes = Buffer.from('signed-model-binary');
const policyBytes = Buffer.from('signed-policy-bundle');
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
    signingKeyId: 'edge-release-2026',
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
    rollback: { enabled: true, targetVersion: '1.1.0' },
    ...overrides,
  } as EdgePackageManifestV1;
}

function signedPackage(
  manifestInput: EdgePackageManifestV1 = makeManifest(),
  artifactOverrides: Record<string, Uint8Array> = {},
): SignedEdgePackageInput {
  const signature = signPayload(null, edgePackageSigningPayload(manifestInput), keyPair.privateKey)
    .toString('base64');
  return {
    manifest: manifestInput,
    signature,
    artifacts: {
      'models/quality-defect.bin': modelBytes,
      'policy/edge-policy.json': policyBytes,
      ...artifactOverrides,
    },
  };
}

function policy(overrides: Partial<EdgePackageVerificationPolicy> = {}): EdgePackageVerificationPolicy {
  return {
    tenantId,
    factoryId,
    trustedSigningKeys: {
      'edge-release-2026': { publicKeyPem, status: 'ACTIVE' as const },
    },
    allowedToolIds: new Set(['AI.RUNTIME.NOOP', 'AI.RUNTIME.AUDIT_ONLY']),
    now,
    ...overrides,
  };
}

describe('verifyEdgePackage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies an Ed25519 signature, target scope, tool allow-list, expiry, and every artifact hash', () => {
    const result = verifyEdgePackage(signedPackage(), policy());

    expect(result.manifest.packageId).toBe('quality-defect');
    expect(result.manifest.version).toBe('1.2.0');
    expect(result.manifest.rollback).toEqual({ enabled: true, targetVersion: '1.1.0' });
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifactBytes).toBe(modelBytes.byteLength + policyBytes.byteLength);
  });

  it('uses a deterministic signing payload independent of object key order', () => {
    const first = makeManifest();
    const second = {
      rollback: first.rollback,
      artifacts: first.artifacts,
      allowedTools: first.allowedTools,
      policyBundle: first.policyBundle,
      model: first.model,
      signingKeyId: first.signingKeyId,
      expiresAt: first.expiresAt,
      issuedAt: first.issuedAt,
      factoryId: first.factoryId,
      tenantId: first.tenantId,
      version: first.version,
      packageId: first.packageId,
      schemaVersion: first.schemaVersion,
    };
    expect(edgePackageSigningPayload(first)).toEqual(edgePackageSigningPayload(second));
  });

  it('rejects manifest tampering after signing', () => {
    const input = signedPackage();
    (input.manifest as EdgePackageManifestV1).allowedTools = ['AI.RUNTIME.AUDIT_ONLY'];
    expect(() => verifyEdgePackage(input, policy())).toThrow(EdgePackageVerificationError);
  });

  it('rejects packages targeted at a different tenant or factory', () => {
    const wrongTenant = makeManifest({ tenantId: 'ccaaac7d-3d18-42f4-9407-e2e7273ce05f' });
    expect(() => verifyEdgePackage(signedPackage(wrongTenant), policy())).toThrow(EdgePackageVerificationError);
  });

  it('rejects an expired package and an issue time outside the allowed clock skew', () => {
    const expired = makeManifest({ expiresAt: '2026-10-12T11:59:59.000Z' });
    expect(() => verifyEdgePackage(signedPackage(expired), policy())).toThrow(EdgePackageVerificationError);

    const future = makeManifest({ issuedAt: '2026-10-12T12:06:00.000Z' });
    expect(() => verifyEdgePackage(signedPackage(future), policy())).toThrow(EdgePackageVerificationError);
  });

  it('rejects revoked and unknown signing keys', () => {
    expect(() => verifyEdgePackage(signedPackage(), policy({
      trustedSigningKeys: { 'edge-release-2026': { publicKeyPem, status: 'REVOKED' } },
    }))).toThrow(EdgePackageVerificationError);

    expect(() => verifyEdgePackage(signedPackage(), policy({ trustedSigningKeys: {} }))).toThrow(EdgePackageVerificationError);
  });

  it('rejects an unknown tool even when the manifest signature is valid', () => {
    const input = signedPackage(makeManifest({ allowedTools: ['AI.RUNTIME.UNKNOWN'] }));
    expect(() => verifyEdgePackage(input, policy())).toThrow(EdgePackageVerificationError);
  });

  it('rejects changed, missing, and unexpected package artifacts', () => {
    const wrongBytes = Buffer.from('different-model');
    expect(() => verifyEdgePackage(
      signedPackage(makeManifest(), { 'models/quality-defect.bin': wrongBytes }),
      policy(),
    )).toThrow(EdgePackageVerificationError);

    const input = signedPackage();
    delete (input.artifacts as Record<string, Uint8Array>)['policy/edge-policy.json'];
    expect(() => verifyEdgePackage(input, policy())).toThrow(EdgePackageVerificationError);

    expect(() => verifyEdgePackage(
      signedPackage(makeManifest(), { 'extra/unlisted.bin': Buffer.from('extra') }),
      policy(),
    )).toThrow(EdgePackageVerificationError);
  });

  it('rejects traversal paths, undeclared fields, duplicate tools, and duplicate artifact paths', () => {
    const traversal = makeManifest({
      model: { modelId: 'quality-defect', version: '1.2.0', artifactPath: '../model.bin' },
    });
    expect(() => edgePackageSigningPayload(traversal)).toThrow(EdgePackageVerificationError);

    const credentialLike = { ...makeManifest(), privateKey: 'must-not-be-carried' };
    expect(() => edgePackageSigningPayload(credentialLike)).toThrow(EdgePackageVerificationError);

    const duplicatedTools = makeManifest({ allowedTools: ['AI.RUNTIME.NOOP', 'AI.RUNTIME.NOOP'] });
    expect(() => edgePackageSigningPayload(duplicatedTools)).toThrow(EdgePackageVerificationError);

    const duplicatedArtifacts = makeManifest({
      artifacts: [
        { path: 'models/quality-defect.bin', sha256: modelHash, sizeBytes: modelBytes.byteLength },
        { path: 'models/quality-defect.bin', sha256: policyHash, sizeBytes: policyBytes.byteLength },
      ],
    });
    expect(() => edgePackageSigningPayload(duplicatedArtifacts)).toThrow(EdgePackageVerificationError);
  });

  it('rejects impossible timestamps and overlong validity windows', () => {
    const impossible = makeManifest({ expiresAt: '2026-02-30T11:00:00.000Z' });
    expect(() => verifyEdgePackage(signedPackage(impossible), policy())).toThrow(EdgePackageVerificationError);

    const tooLong = makeManifest({ expiresAt: '2027-10-12T11:00:00.000Z' });
    expect(() => verifyEdgePackage(signedPackage(tooLong), policy())).toThrow(EdgePackageVerificationError);
  });

  it('rejects a non-Ed25519 signing key and an invalid artifact size limit', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPublicKeyPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => verifyEdgePackage(signedPackage(), policy({
      trustedSigningKeys: {
        'edge-release-2026': { publicKeyPem: rsaPublicKeyPem, status: 'ACTIVE' },
      },
    }))).toThrow(EdgePackageVerificationError);

    expect(() => verifyEdgePackage(signedPackage(), policy({ maxTotalArtifactBytes: 0 }))).toThrow(EdgePackageVerificationError);
  });

  it('requires explicit rollback target metadata when rollback is enabled', () => {
    const invalidRollback = makeManifest({ rollback: { enabled: true, targetVersion: null } });
    expect(() => edgePackageSigningPayload(invalidRollback)).toThrow(EdgePackageVerificationError);
    const disabledButTargeted = makeManifest({ rollback: { enabled: false, targetVersion: '1.1.0' } });
    expect(() => edgePackageSigningPayload(disabledButTargeted)).toThrow(EdgePackageVerificationError);
  });
});
