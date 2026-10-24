import assert from 'node:assert/strict';
import test from 'node:test';

import { EdgePackageExecutionSupervisor } from '../package-control-supervisor.mjs';

const execution = {
  packageId: 'quality-defect',
  version: '1.2.0',
  useCaseId: 'inspection',
  signingKeyId: 'release-key-v1',
};

function baseSnapshot(overrides = {}) {
  return {
    healthy: true,
    lastErrorCode: null,
    syncedAt: new Date().toISOString(),
    freshnessAgeMs: 0,
    signingKeys: [{
      keyId: 'release-key-v1',
      publicKeyPem: 'validated-ed25519-public-key-pem',
      fingerprintSha256: 'a'.repeat(64),
      status: 'ACTIVE',
    }],
    controls: [
      {
        packageId: 'quality-defect',
        packageVersion: '1.2.0',
        useCaseId: 'inspection',
        status: 'ACTIVE',
        checkedAt: new Date().toISOString(),
        reason: null,
      },
      {
        packageId: 'quality-alert',
        packageVersion: '2.0.0',
        useCaseId: null,
        status: 'ACTIVE',
        checkedAt: new Date().toISOString(),
        reason: null,
      },
    ],
    ...overrides,
  };
}

class FakeSyncClient {
  constructor() {
    this.snapshot = baseSnapshot();
    this.pollCount = 0;
    this.pollError = null;
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async pollOnce() {
    this.pollCount += 1;
    if (this.pollError) {
      this.snapshot = { ...this.snapshot, healthy: false, lastErrorCode: 'EDGE_SYNC_UNAVAILABLE' };
      throw this.pollError;
    }
    this.snapshot = {
      ...this.snapshot,
      healthy: true,
      lastErrorCode: null,
      syncedAt: new Date().toISOString(),
      freshnessAgeMs: 0,
    };
    return this.getSnapshot();
  }
}

function harness(client = new FakeSyncClient(), options = {}) {
  let scheduled;
  let cleared = false;
  const supervisor = new EdgePackageExecutionSupervisor(client, {
    pollIntervalMs: 10_000,
    setIntervalImpl: (callback, interval) => {
      assert.equal(interval, 10_000);
      scheduled = callback;
      return { timer: true };
    },
    clearIntervalImpl: (timer) => {
      assert.deepEqual(timer, { timer: true });
      cleared = true;
    },
    ...options,
  });
  return {
    client,
    supervisor,
    fireScheduled: () => scheduled?.(),
    wasCleared: () => cleared,
  };
}

test('starts periodic polling immediately and invokes only the authorized callback for an active scope and signer', async () => {
  const h = harness();
  const status = await h.supervisor.start();
  assert.equal(status.running, true);
  assert.equal(status.healthy, true);
  assert.equal(h.client.pollCount, 1);

  let calls = 0;
  const result = await h.supervisor.runAuthorized(execution, async (authorization) => {
    calls += 1;
    assert.equal(authorization.packageId, execution.packageId);
    assert.equal(authorization.packageVersion, execution.version);
    assert.equal(authorization.signingKey.keyId, execution.signingKeyId);
    assert.equal(authorization.signingKey.fingerprintSha256, 'a'.repeat(64));
    assert.equal(authorization.control.status, 'ACTIVE');
    return 'executed';
  });
  assert.equal(result, 'executed');
  assert.equal(calls, 1);
  h.supervisor.stop();
});

test('fails closed before start and after stop without invoking the side-effect callback', async () => {
  const h = harness();
  let calls = 0;
  assert.throws(() => h.supervisor.runAuthorized(execution, () => { calls += 1; }), { code: 'SUPERVISOR_STOPPED' });
  await h.supervisor.start();
  h.supervisor.stop();
  assert.equal(h.supervisor.getStatus().healthy, false);
  assert.equal(h.supervisor.getStatus().lastErrorCode, 'SUPERVISOR_STOPPED');
  assert.throws(() => h.supervisor.runAuthorized(execution, () => { calls += 1; }), { code: 'SUPERVISOR_STOPPED' });
  assert.equal(calls, 0);
  assert.equal(h.wasCleared(), true);
});

test('denies an unhealthy snapshot and continues scheduled recovery attempts', async () => {
  const client = new FakeSyncClient();
  const h = harness(client);
  await h.supervisor.start();
  client.pollError = new Error('offline');
  const failed = await h.fireScheduled();
  assert.equal(failed.healthy, false);
  assert.equal(failed.lastErrorCode, 'EDGE_SYNC_UNAVAILABLE');
  assert.throws(() => h.supervisor.runAuthorized(execution, () => assert.fail('must not execute')), { code: 'CONTROL_SYNC_UNHEALTHY' });

  client.pollError = null;
  const recovered = await h.fireScheduled();
  assert.equal(recovered.healthy, true);
  assert.equal(h.client.pollCount, 3);
  assert.equal(h.supervisor.runAuthorized(execution, () => 'recovered'), 'recovered');
  h.supervisor.stop();
});

test('denies paused, revoked, and unconfigured package scopes', async () => {
  const client = new FakeSyncClient();
  const h = harness(client);
  await h.supervisor.start();

  client.snapshot.controls[0].status = 'PAUSED';
  assert.throws(() => h.supervisor.runAuthorized(execution, () => assert.fail('must not execute')), { code: 'PACKAGE_CONTROL_PAUSED' });
  client.snapshot.controls[0].status = 'REVOKED';
  assert.throws(() => h.supervisor.runAuthorized(execution, () => assert.fail('must not execute')), { code: 'PACKAGE_CONTROL_REVOKED' });
  assert.throws(() => h.supervisor.runAuthorized({
    ...execution, packageId: 'not-managed',
  }, () => assert.fail('must not execute')), { code: 'PACKAGE_SCOPE_NOT_CONFIGURED' });
  h.supervisor.stop();
});

test('denies missing, revoked, or non-active package signing keys', async () => {
  const client = new FakeSyncClient();
  const h = harness(client);
  await h.supervisor.start();

  assert.throws(() => h.supervisor.runAuthorized({
    ...execution, signingKeyId: 'unknown-release-key',
  }, () => assert.fail('must not execute')), { code: 'SIGNING_KEY_NOT_TRUSTED' });
  client.snapshot.signingKeys[0].status = 'REVOKED';
  assert.throws(() => h.supervisor.runAuthorized(execution, () => assert.fail('must not execute')), { code: 'SIGNING_KEY_REVOKED' });
  client.snapshot.signingKeys[0].status = 'PENDING';
  assert.throws(() => h.supervisor.runAuthorized(execution, () => assert.fail('must not execute')), { code: 'SIGNING_KEY_NOT_ACTIVE' });
  h.supervisor.stop();
});

test('coalesces overlapping refreshes so timer ticks cannot overlap network polls', async () => {
  const client = new FakeSyncClient();
  const h = harness(client);
  let release;
  let initial = true;
  const originalPoll = client.pollOnce.bind(client);
  client.pollOnce = async () => {
    if (initial) {
      initial = false;
      return originalPoll();
    }
    await new Promise((resolve) => { release = resolve; });
    return originalPoll();
  };

  await h.supervisor.start();
  const first = h.supervisor.refresh();
  const second = h.supervisor.refresh();
  assert.equal(first, second);
  assert.equal(client.pollCount, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.healthy, true);
  assert.equal(b.healthy, true);
  assert.equal(client.pollCount, 2);
  h.supervisor.stop();
});

test('rejects invalid construction and malformed execution contexts', async () => {
  assert.throws(() => new EdgePackageExecutionSupervisor({}, {}), /sync client/);
  const client = new FakeSyncClient();
  assert.throws(() => new EdgePackageExecutionSupervisor(client, { pollIntervalMs: 20 }), /pollIntervalMs/);
  const h = harness(client);
  await h.supervisor.start();
  assert.throws(() => h.supervisor.runAuthorized({ ...execution, version: 'latest' }, () => {}), /semantic version/);
  assert.throws(() => h.supervisor.runAuthorized(execution, null), /operation callback/);
  h.supervisor.stop();
});
