import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signPayload } from 'node:crypto';
import test from 'node:test';

import { EdgePackageExecutionSupervisor } from '../package-control-supervisor.mjs';
import { edgePackageRuntimeSigningPayload } from '../verified-package-runtime.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
const factoryId = '33333333-3333-4333-8333-333333333333';
const packageId = 'quality-defect';
const version = '1.2.0';
const useCaseId = 'inspection';
const signingKeyId = 'release-key-v1';
const modelBytes = Buffer.from('test-model-artifact-v1');
const policyBytes = Buffer.from('test-policy-artifact-v1');
const modelHash = createHash('sha256').update(modelBytes).digest('hex');
const policyHash = createHash('sha256').update(policyBytes).digest('hex');
const pair = generateKeyPairSync('ed25519');
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprintSha256 = createHash('sha256')
  .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const allowedToolIds = new Set(['AI.RUNTIME.NOOP']);

function makeManifest(now = new Date()) {
  return {
    schemaVersion: 1,
    packageId,
    version,
    tenantId,
    factoryId,
    issuedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    signingKeyId,
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

function signedInput(manifest = makeManifest(), options = {}) {
  const signature = signPayload(null, edgePackageRuntimeSigningPayload(manifest), pair.privateKey).toString('base64');
  return {
    manifest,
    signature: options.signature ?? signature,
    artifacts: options.artifacts ?? {
      'models/quality-defect.bin': Buffer.from(modelBytes),
      'policy/edge-policy.json': Buffer.from(policyBytes),
    },
  };
}

function harness() {
  const snapshot = {
    healthy: true,
    lastErrorCode: null,
    tenantId,
    factoryId,
    syncedAt: new Date().toISOString(),
    freshnessAgeMs: 0,
    signingKeys: [{
      keyId: signingKeyId,
      publicKeyPem,
      fingerprintSha256,
      status: 'ACTIVE',
    }],
    controls: [{
      packageId,
      packageVersion: version,
      useCaseId,
      status: 'ACTIVE',
      checkedAt: new Date().toISOString(),
      reason: null,
    }],
  };
  const client = {
    pollCount: 0,
    getSnapshot: () => structuredClone(snapshot),
    pollOnce: async () => {
      client.pollCount += 1;
      snapshot.syncedAt = new Date().toISOString();
      snapshot.freshnessAgeMs = 0;
      snapshot.healthy = true;
      snapshot.lastErrorCode = null;
      return structuredClone(snapshot);
    },
  };
  const supervisor = new EdgePackageExecutionSupervisor(client, {
    pollIntervalMs: 10_000,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  return { client, snapshot, supervisor };
}

test('verifies the synchronized Ed25519 signer and every artifact before invoking the host runtime', async () => {
  const h = harness();
  await h.supervisor.start();
  let calls = 0;
  const result = await h.supervisor.runVerifiedPackage(
    signedInput(),
    { useCaseId, allowedToolIds },
    (release, authorization) => {
      calls += 1;
      assert.equal(authorization.control.status, 'ACTIVE');
      assert.equal(release.manifest.packageId, packageId);
      assert.equal(release.manifest.version, version);
      assert.equal(release.artifactBytes, modelBytes.length + policyBytes.length);
      assert.deepEqual(release.artifacts['models/quality-defect.bin'], modelBytes);
      assert.deepEqual(release.artifacts['policy/edge-policy.json'], policyBytes);
      assert.match(release.manifestSha256, /^[a-f0-9]{64}$/);
      return 'loaded-and-executed';
    },
  );
  assert.equal(result, 'loaded-and-executed');
  assert.equal(calls, 1);
  h.supervisor.stop();
});

test('stop aborts an in-flight host runtime and rejects a late success as ambiguous', async () => {
  const h = harness();
  await h.supervisor.start();
  let signal;
  let finishExecution;
  const outcome = h.supervisor.runVerifiedPackage(
    signedInput(),
    { useCaseId, allowedToolIds },
    (_release, _authorization, activeSignal) => {
      signal = activeSignal;
      return new Promise((resolve) => { finishExecution = resolve; });
    },
  );

  assert.equal(signal.aborted, false);
  h.supervisor.stop();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'SUPERVISOR_STOPPED');

  finishExecution('late-success');
  await assert.rejects(outcome, { code: 'EXECUTION_ABORTED_AFTER_START' });
});

test('returns ambiguous cancellation promptly while keeping a non-cooperative executor tracked', async () => {
  const h = harness();
  await h.supervisor.start();
  let signal;
  let finishExecution;
  const outcome = h.supervisor.runVerifiedPackage(
    signedInput(),
    { useCaseId, allowedToolIds },
    (_release, _authorization, activeSignal) => {
      signal = activeSignal;
      return new Promise((resolve) => { finishExecution = resolve; });
    },
  );

  assert.equal(signal.aborted, false);
  assert.equal(h.supervisor.activeExecutions.size, 1);
  h.supervisor.stop();
  assert.equal(signal.aborted, true);

  const settled = await Promise.race([
    outcome.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setImmediate(() => resolve('still-pending'))),
  ]);
  assert.equal(settled, 'EXECUTION_ABORTED_AFTER_START');
  // An ambiguous API result is not proof that the underlying executor stopped.
  assert.equal(h.supervisor.activeExecutions.size, 1);

  finishExecution('late-success');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.supervisor.activeExecutions.size, 0);
});

test('a refreshed PAUSED control aborts active package work and does not report a late success', async () => {
  const h = harness();
  await h.supervisor.start();
  let signal;
  let finishExecution;
  const outcome = h.supervisor.runVerifiedPackage(
    signedInput(),
    { useCaseId, allowedToolIds },
    (_release, _authorization, activeSignal) => {
      signal = activeSignal;
      return new Promise((resolve) => { finishExecution = resolve; });
    },
  );

  h.snapshot.controls[0].status = 'PAUSED';
  await h.supervisor.refresh();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'PACKAGE_CONTROL_PAUSED');

  finishExecution('late-success');
  await assert.rejects(outcome, { code: 'EXECUTION_ABORTED_AFTER_START' });
  h.supervisor.stop();
});

test('a failed package-control poll aborts active work and requires reconciliation before retry', async () => {
  const h = harness();
  await h.supervisor.start();
  let signal;
  let finishExecution;
  const outcome = h.supervisor.runVerifiedPackage(
    signedInput(),
    { useCaseId, allowedToolIds },
    (_release, _authorization, activeSignal) => {
      signal = activeSignal;
      return new Promise((resolve) => { finishExecution = resolve; });
    },
  );

  h.client.pollOnce = async () => { throw new Error('offline'); };
  const status = await h.supervisor.refresh();
  assert.equal(status.healthy, false);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'EDGE_SYNC_FAILED');

  finishExecution('late-success');
  await assert.rejects(outcome, { code: 'EXECUTION_ABORTED_AFTER_START' });
  h.supervisor.stop();
});

test('blocks a forged signature and never calls the executor', async () => {
  const h = harness();
  await h.supervisor.start();
  let calls = 0;
  const input = signedInput(makeManifest(), { signature: Buffer.alloc(64).toString('base64') });
  assert.throws(() => h.supervisor.runVerifiedPackage(
    input,
    { useCaseId, allowedToolIds },
    () => { calls += 1; },
  ), { code: 'INVALID_SIGNATURE' });
  assert.equal(calls, 0);
  h.supervisor.stop();
});

test('blocks changed, missing and extra artifacts before host execution', async () => {
  const h = harness();
  await h.supervisor.start();
  let calls = 0;
  const changed = signedInput(makeManifest(), {
    artifacts: {
      'models/quality-defect.bin': Buffer.from('tampered-model'),
      'policy/edge-policy.json': Buffer.from(policyBytes),
    },
  });
  assert.throws(() => h.supervisor.runVerifiedPackage(
    changed, { useCaseId, allowedToolIds }, () => { calls += 1; },
  ), { code: 'ARTIFACT_MISMATCH' });

  const missing = signedInput(makeManifest(), {
    artifacts: { 'models/quality-defect.bin': Buffer.from(modelBytes) },
  });
  assert.throws(() => h.supervisor.runVerifiedPackage(
    missing, { useCaseId, allowedToolIds }, () => { calls += 1; },
  ), { code: 'ARTIFACT_MISMATCH' });

  const extra = signedInput(makeManifest(), {
    artifacts: {
      'models/quality-defect.bin': Buffer.from(modelBytes),
      'policy/edge-policy.json': Buffer.from(policyBytes),
      'models/untrusted.bin': Buffer.from('unexpected'),
    },
  });
  assert.throws(() => h.supervisor.runVerifiedPackage(
    extra, { useCaseId, allowedToolIds }, () => { calls += 1; },
  ), { code: 'ARTIFACT_MISMATCH' });
  assert.equal(calls, 0);
  h.supervisor.stop();
});

test('enforces the host tool allow-list and signed manifest tenant/factory scope', async () => {
  const h = harness();
  await h.supervisor.start();
  let calls = 0;
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(), { useCaseId, allowedToolIds: new Set() }, () => { calls += 1; },
  ), { code: 'TOOL_NOT_ALLOWED' });

  const wrongTenant = { ...makeManifest(), tenantId: '22222222-2222-4222-8222-222222222222' };
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(wrongTenant), { useCaseId, allowedToolIds }, () => { calls += 1; },
  ), { code: 'PACKAGE_SCOPE_MISMATCH' });

  const expired = makeManifest(new Date(Date.now() - 3 * 60 * 60 * 1000));
  expired.issuedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  expired.expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(expired), { useCaseId, allowedToolIds }, () => { calls += 1; },
  ), { code: 'PACKAGE_EXPIRED' });

  assert.equal(calls, 0);
  h.supervisor.stop();
});

test('rechecks live package control after signature/hash verification and blocks a pause race', async () => {
  const h = harness();
  await h.supervisor.start();
  let calls = 0;
  class PausingToolAllowList extends Set {
    has(value) {
      h.snapshot.controls[0].status = 'PAUSED';
      return super.has(value);
    }
  }
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(),
    { useCaseId, allowedToolIds: new PausingToolAllowList(['AI.RUNTIME.NOOP']) },
    () => { calls += 1; },
  ), { code: 'PACKAGE_CONTROL_PAUSED' });
  assert.equal(calls, 0);
  h.supervisor.stop();
});

test('requires a live, healthy supervisor and a real host executor', async () => {
  const h = harness();
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(), { useCaseId, allowedToolIds }, () => {},
  ), { code: 'SUPERVISOR_STOPPED' });
  await h.supervisor.start();
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(), { useCaseId, allowedToolIds }, null,
  ), /executor callback/);
  h.snapshot.signingKeys[0].status = 'REVOKED';
  assert.throws(() => h.supervisor.runVerifiedPackage(
    signedInput(), { useCaseId, allowedToolIds }, () => {},
  ), { code: 'SIGNING_KEY_REVOKED' });
  h.supervisor.stop();
});
