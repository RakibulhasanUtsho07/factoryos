import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EdgePackageControlSyncClient } from '../package-control-sync.mjs';

const tenantId = '11111111-1111-4111-8111-111111111111';
const factoryId = '33333333-3333-4333-8333-333333333333';
const deviceId = 'aaaaab63-c447-46ce-950d-deebdd7f5f33';
const scopes = [
  { packageId: 'quality-defect', version: '1.2.0', useCaseId: 'inspection' },
  { packageId: 'quality-alert', version: '2.0.0', useCaseId: null },
];
const pair = generateKeyPairSync('ed25519');
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprintSha256 = createHash('sha256')
  .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');

function signingSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    tenantId,
    factoryId,
    checkedAt: new Date().toISOString(),
    signingKeys: [{
      keyId: 'release-key-v1',
      publicKeyPem,
      fingerprintSha256,
      status: 'ACTIVE',
    }],
    ...overrides,
  };
}
function controlResponse(scope, status = 'ACTIVE', overrides = {}) {
  return {
    packageId: scope.packageId,
    packageVersion: scope.version,
    status,
    checkedAt: new Date().toISOString(),
    reason: status === 'REVOKED' ? 'Revoked by test fixture' : null,
    matchedControls: [],
    ...overrides,
  };
}
function response(value, status = 200) {
  const body = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === 'content-length' ? String(Buffer.byteLength(body)) : null },
    text: async () => body,
  };
}
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factoryos-package-sync-'));
  const client = new EdgePackageControlSyncClient({
    baseUrl: 'https://edge.example.test',
    deviceId,
    tenantId,
    factoryId,
    token: 'opaque-device-secret',
    stateFile: join(root, 'state', 'package-sync.json'),
    managedScopes: scopes,
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.includes('/device-package-signing-keys/')) return response(signingSnapshot());
      const found = scopes.find((scope) => scope.packageId === target.searchParams.get('package_id')
        && scope.version === target.searchParams.get('package_version')
        && (scope.useCaseId ?? null) === target.searchParams.get('use_case_id'));
      if (!found) return response({ error: 'unexpected scope' }, 400);
      return response(controlResponse(found));
    },
    ...options,
  });
  await client.initialize();
  return { root, client, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('polls the full signer snapshot and every configured package scope, then persists an owner-only snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factoryos-package-sync-'));
  const calls = [];
  const client = new EdgePackageControlSyncClient({
    baseUrl: 'https://edge.example.test',
    deviceId,
    tenantId,
    factoryId,
    token: 'opaque-device-secret',
    stateFile: join(root, 'state', 'package-sync.json'),
    managedScopes: scopes,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const target = new URL(url);
      if (target.pathname === '/api/v2/edge/device-package-signing-keys/' + deviceId) return response(signingSnapshot());
      const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id')
        && item.version === target.searchParams.get('package_version')
        && (item.useCaseId ?? null) === (target.searchParams.get('use_case_id') || null));
      assert.ok(scope, 'poller requested only configured scopes');
      return response(controlResponse(scope));
    },
  });
  try {
    await client.initialize();
    assert.equal(client.getSnapshot().healthy, false);
    const snapshot = await client.pollOnce();
    assert.equal(snapshot.healthy, true);
    assert.equal(snapshot.signingKeys.length, 1);
    assert.equal(snapshot.controls.length, scopes.length);
    assert.deepEqual(snapshot.controls.map((entry) => entry.status), ['ACTIVE', 'ACTIVE']);
    assert.equal(calls.length, 1 + scopes.length);
    for (const call of calls) {
      assert.equal(call.options.method, 'GET');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.headers.authorization, 'Bearer opaque-device-secret');
      assert.equal(call.options.headers.accept, 'application/json');
    }
    const metadata = await stat(join(root, 'state', 'package-sync.json'));
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.mode & 0o077, 0);
    const persisted = await readFile(join(root, 'state', 'package-sync.json'), 'utf8');
    assert.equal(persisted.includes('opaque-device-secret'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an HTTP or transport failure marks the last snapshot unhealthy and does not partially replace it', async () => {
  let failControls = false;
  const f = await fixture({
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.includes('/device-package-signing-keys/')) return response(signingSnapshot());
      const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
      if (failControls && scope?.packageId === 'quality-alert') return response({ error: 'offline' }, 503);
      return response(controlResponse(scope));
    },
  });
  try {
    const first = await f.client.pollOnce();
    assert.equal(first.healthy, true);
    failControls = true;
    await assert.rejects(f.client.pollOnce(), { code: 'HTTP_503' });
    const failed = f.client.getSnapshot();
    assert.equal(failed.healthy, false);
    assert.equal(failed.lastErrorCode, 'HTTP_503');
    assert.equal(failed.signingKeys[0].keyId, 'release-key-v1');
    assert.deepEqual(failed.controls.map((item) => item.status), ['ACTIVE', 'ACTIVE']);
    const persisted = JSON.parse(await readFile(join(f.root, 'state', 'package-sync.json'), 'utf8'));
    assert.equal(persisted.lastErrorCode, 'HTTP_503');
  } finally {
    await f.cleanup();
  }
});

test('terminal signer and package revocations survive later snapshots that omit or reactivate them', async () => {
  let signerStatus = 'ACTIVE';
  let omitSigner = false;
  let controlStatus = 'ACTIVE';
  const f = await fixture({
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.includes('/device-package-signing-keys/')) {
        const keys = omitSigner ? [] : [{ keyId: 'release-key-v1', publicKeyPem, fingerprintSha256, status: signerStatus }];
        return response(signingSnapshot({ signingKeys: keys }));
      }
      const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
      return response(controlResponse(scope, controlStatus));
    },
  });
  try {
    await f.client.pollOnce();
    signerStatus = 'REVOKED';
    controlStatus = 'REVOKED';
    await f.client.pollOnce();
    omitSigner = true;
    controlStatus = 'ACTIVE';
    await f.client.pollOnce();
    signerStatus = 'ACTIVE';
    omitSigner = false;
    const final = await f.client.pollOnce();
    assert.equal(final.healthy, true);
    assert.equal(final.signingKeys.find((key) => key.keyId === 'release-key-v1')?.status, 'REVOKED');
    assert.ok(final.controls.every((entry) => entry.status === 'REVOKED'));

    // Reopening the persisted snapshot must not erase terminal revocation history.
    const restarted = new EdgePackageControlSyncClient({
      baseUrl: 'https://edge.example.test',
      deviceId,
      tenantId,
      factoryId,
      token: 'opaque-device-secret',
      stateFile: join(f.root, 'state', 'package-sync.json'),
      managedScopes: scopes,
      fetchImpl: async (url) => {
        const target = new URL(url);
        if (target.pathname.includes('/device-package-signing-keys/')) {
          return response(signingSnapshot({
            signingKeys: [{ keyId: 'release-key-v1', publicKeyPem, fingerprintSha256, status: 'ACTIVE' }],
          }));
        }
        const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
        return response(controlResponse(scope, 'ACTIVE'));
      },
    });
    await restarted.initialize();
    assert.equal(restarted.getSnapshot().healthy, false);
    const afterRestart = await restarted.pollOnce();
    assert.equal(afterRestart.signingKeys.find((key) => key.keyId === 'release-key-v1')?.status, 'REVOKED');
    assert.ok(afterRestart.controls.every((entry) => entry.status === 'REVOKED'));
  } finally {
    await f.cleanup();
  }
});

test('rejects cross-tenant signer snapshots and invalid signing-key fingerprints', async () => {
  const f = await fixture({
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.includes('/device-package-signing-keys/')) {
        return response(signingSnapshot({ tenantId: '22222222-2222-4222-8222-222222222222' }));
      }
      const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
      return response(controlResponse(scope));
    },
  });
  try {
    await assert.rejects(f.client.pollOnce(), { code: 'INVALID_SIGNING_KEY_SNAPSHOT' });
    assert.equal(f.client.getSnapshot().healthy, false);
  } finally {
    await f.cleanup();
  }

  const bad = await fixture({
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.includes('/device-package-signing-keys/')) {
        return response(signingSnapshot({
          signingKeys: [{ keyId: 'release-key-v1', publicKeyPem, fingerprintSha256: '0'.repeat(64), status: 'ACTIVE' }],
        }));
      }
      const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
      return response(controlResponse(scope));
    },
  });
  try {
    await assert.rejects(bad.client.pollOnce(), { code: 'INVALID_SIGNING_KEY_SNAPSHOT' });
    assert.equal(bad.client.getSnapshot().healthy, false);
  } finally {
    await bad.cleanup();
  }
});

test('rejects private-key PEM material even when Node can derive its public key', async () => {
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const f = await fixture({
    fetchImpl: async (url) => {
      const target = new URL(url);
      if (target.pathname.includes('/device-package-signing-keys/')) {
        return response(signingSnapshot({
          signingKeys: [{
            keyId: 'release-key-v1',
            publicKeyPem: privateKeyPem,
            fingerprintSha256,
            status: 'ACTIVE',
          }],
        }));
      }
      const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
      return response(controlResponse(scope));
    },
  });
  try {
    await assert.rejects(f.client.pollOnce(), { code: 'INVALID_SIGNING_KEY_SNAPSHOT' });
    assert.equal(f.client.getSnapshot().healthy, false);
  } finally {
    await f.cleanup();
  }
});

test('restart does not treat a persisted successful snapshot as fresh runtime authorization', async () => {
  const f = await fixture();
  try {
    await f.client.pollOnce();
    assert.equal(f.client.getSnapshot().healthy, true);
    const restarted = new EdgePackageControlSyncClient({
      baseUrl: 'https://edge.example.test',
      deviceId,
      tenantId,
      factoryId,
      token: 'opaque-device-secret',
      stateFile: join(f.root, 'state', 'package-sync.json'),
      managedScopes: scopes,
      fetchImpl: async (url) => {
        const target = new URL(url);
        if (target.pathname.includes('/device-package-signing-keys/')) return response(signingSnapshot());
        const scope = scopes.find((item) => item.packageId === target.searchParams.get('package_id'));
        return response(controlResponse(scope));
      },
    });
    await restarted.initialize();
    assert.equal(restarted.getSnapshot().healthy, false);
    assert.equal(restarted.getSnapshot().lastErrorCode, 'INITIAL_SYNC_REQUIRED');
    assert.equal((await restarted.pollOnce()).healthy, true);
  } finally {
    await f.cleanup();
  }
});

test('requires HTTPS for remote sync and rejects malformed or oversized responses', async () => {
  assert.throws(() => new EdgePackageControlSyncClient({
    baseUrl: 'http://edge.example.test',
    deviceId,
    tenantId,
    factoryId,
    token: 'secret',
    stateFile: '/tmp/package-sync.json',
    managedScopes: scopes,
  }), /origin-only HTTPS/);
  const f = await fixture({
    fetchImpl: async () => response(signingSnapshot({ signingKeys: null })),
  });
  try {
    await assert.rejects(f.client.pollOnce(), { code: 'INVALID_SIGNING_KEY_SNAPSHOT' });
  } finally {
    await f.cleanup();
  }

  const oversized = await fixture({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === 'content-length' ? String(2 * 1024 * 1024) : null },
      text: async () => '',
    }),
  });
  try {
    await assert.rejects(oversized.client.pollOnce(), { code: 'RESPONSE_TOO_LARGE' });
  } finally {
    await oversized.cleanup();
  }

  const chunked = await fixture({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1_048_577));
          controller.close();
        },
      }),
      text: async () => '',
    }),
  });
  try {
    await assert.rejects(chunked.client.pollOnce(), { code: 'RESPONSE_TOO_LARGE' });
  } finally {
    await chunked.cleanup();
  }
});
