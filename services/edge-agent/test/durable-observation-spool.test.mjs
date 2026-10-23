import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableObservationSpool, createEdgeGatewaySender } from '../durable-observation-spool.mjs';

const deviceId = 'aaaaab63-c447-46ce-950d-deebdd7f5f33';
const eventId = 'bbbbbb63-c447-46ce-950d-deebdd7f5f34';
function batch(key = 'batch-1', value = 21.5) {
  return {
    batch_key: key,
    observations: [{
      event_id: eventId,
      signal_key: 'line.temperature',
      observed_at: '2026-10-23T10:00:00.000Z',
      source_mode: 'EDGE_OFFLINE',
      quality: 'GOOD',
      unit: 'degC',
      sampling_interval_ms: 1000,
      payload: { value },
    }],
  };
}
function receipt(input, extra = {}) {
  return {
    idempotent: false,
    summary: {
      id: 'receipt-id',
      batchKey: input.batch_key,
      observationsReceived: input.observations.length,
      observationsInserted: input.observations.length,
      observationsDeduplicated: 0,
      receivedAt: '2026-10-23T10:00:01.000Z',
    },
    ...extra,
  };
}
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factoryos-edge-spool-'));
  const spool = new DurableObservationSpool(root, options);
  await spool.pending();
  return { root, spool, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('persists offline batch across restart and deletes only after an exact durable receipt', async () => {
  const f = await fixture();
  try {
    await f.spool.enqueue(batch());
    const reopened = new DurableObservationSpool(f.root);
    assert.equal((await reopened.pending()).length, 1);
    const sent = [];
    const result = await reopened.flush(async (value) => { sent.push(value); return receipt(value); });
    assert.deepEqual(result, { acknowledged: 1, retained: 0, next_batch_key: null });
    assert.equal(sent[0].batch_key, 'batch-1');
    assert.equal((await reopened.pending()).length, 0);
  } finally { await f.cleanup(); }
});

test('same-key enqueue is idempotent but changed content is rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.spool.enqueue(batch())).queued, true);
    assert.equal((await f.spool.enqueue(batch())).idempotent, true);
    await assert.rejects(f.spool.enqueue(batch('batch-1', 22)), { code: 'BATCH_KEY_REUSE' });
    assert.equal((await f.spool.pending()).length, 1);
  } finally { await f.cleanup(); }
});

test('retries transient delivery errors with bounded exponential delay then acknowledges', async () => {
  const f = await fixture();
  try {
    await f.spool.enqueue(batch());
    let calls = 0;
    const delays = [];
    const result = await f.spool.flush(async (value) => {
      calls += 1;
      if (calls < 3) {
        const e = new Error('temporary network failure');
        e.retryable = true;
        throw e;
      }
      return receipt(value);
    }, { maxAttempts: 3, baseDelayMs: 100, sleep: async (ms) => delays.push(ms) });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);
    assert.equal(result.acknowledged, 1);
    assert.equal((await f.spool.pending()).length, 0);
  } finally { await f.cleanup(); }
});

test('retry exhaustion retains the head batch and later flush replays its same key before later work', async () => {
  const f = await fixture();
  try {
    await f.spool.enqueue(batch('first'));
    await f.spool.enqueue(batch('second'));
    const firstTry = await f.spool.flush(async () => {
      const e = new Error('offline');
      e.retryable = true;
      throw e;
    }, { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} });
    assert.equal(firstTry.retained, 2);
    const laterKeys = [];
    const secondTry = await f.spool.flush(async (value) => {
      laterKeys.push(value.batch_key);
      return receipt(value);
    });
    assert.deepEqual(laterKeys, ['first', 'second']);
    assert.equal(secondTry.acknowledged, 2);
  } finally { await f.cleanup(); }
});

test('mismatched receipt is fail-closed and retained without another send attempt', async () => {
  const f = await fixture();
  try {
    await f.spool.enqueue(batch());
    let calls = 0;
    const result = await f.spool.flush(async (value) => {
      calls += 1;
      return receipt(value, { summary: { ...receipt(value).summary, batchKey: 'wrong-key' } });
    }, { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} });
    assert.equal(calls, 1);
    assert.equal(result.retained, 1);
    assert.equal((await f.spool.pending())[0].batch_key, 'batch-1');
  } finally { await f.cleanup(); }
});

test('capacity limit rejects new work instead of evicting already queued batches', async () => {
  const f = await fixture({ maxBatches: 1 });
  try {
    await f.spool.enqueue(batch('kept'));
    await assert.rejects(f.spool.enqueue(batch('rejected')), { code: 'SPOOL_CAPACITY' });
    assert.deepEqual((await f.spool.pending()).map((item) => item.batch_key), ['kept']);
  } finally { await f.cleanup(); }
});

test('credential-like payload fields are rejected before any disk write', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.spool.enqueue({
      ...batch(),
      observations: [{ ...batch().observations[0], payload: { value: 2, access_token: 'never-store-me' } }],
    }), { code: 'SENSITIVE_FIELD_REJECTED' });
    assert.equal((await f.spool.pending()).length, 0);
  } finally { await f.cleanup(); }
});

test('tampered queue data fails integrity validation and is not silently discarded', async () => {
  const f = await fixture();
  try {
    await f.spool.enqueue(batch());
    const pendingDir = join(f.root, 'pending');
    const [name] = await readdir(pendingDir);
    const path = join(pendingDir, name);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.batch.observations[0].payload.value = 999;
    await writeFile(path, JSON.stringify(raw));
    await assert.rejects(f.spool.pending(), { code: 'SPOOL_INTEGRITY_FAILURE' });
  } finally { await f.cleanup(); }
});

test('sender uses the fixed device-ingest route, bearer auth and supplied JSON batch', async () => {
  let called;
  const sender = createEdgeGatewaySender({
    baseUrl: 'https://edge.example.test',
    deviceId,
    token: 'opaque-device-secret',
    fetchImpl: async (url, options) => {
      called = { url, options };
      return { ok: true, status: 200, headers: { get: () => '128' }, text: async () => JSON.stringify(receipt(batch())) };
    },
  });
  const result = await sender(batch());
  assert.match(called.url, /\/api\/v2\/edge\/device-ingest\/aaaaab63-c447-46ce-950d-deebdd7f5f33$/);
  assert.equal(called.options.method, 'POST');
  assert.equal(called.options.redirect, 'error');
  assert.equal(called.options.headers.authorization, 'Bearer opaque-device-secret');
  assert.deepEqual(JSON.parse(called.options.body), JSON.parse(JSON.stringify(batch())));
  assert.equal(result.summary.batchKey, 'batch-1');
});

test('sender refuses remote plaintext HTTP and marks 503 as retryable', async () => {
  assert.throws(() => createEdgeGatewaySender({
    baseUrl: 'http://edge.example.test', deviceId, token: 'token',
  }), /HTTPS is required/);
  const sender = createEdgeGatewaySender({
    baseUrl: 'https://edge.example.test', deviceId, token: 'token',
    fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => '0' }, text: async () => '' }),
  });
  await assert.rejects(sender(batch()), { code: 'HTTP_503', retryable: true });
});
