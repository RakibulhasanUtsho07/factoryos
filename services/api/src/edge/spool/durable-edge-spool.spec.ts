import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { DurableEdgeSpool, EdgeSpoolError } from './durable-edge-spool.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x37);

const firstBatch = () => ({
  batch_key: 'batch-001',
  observations: [
    {
      event_id: '8b5eac9a-6d7e-4aa1-8d62-d2e8c1d60226',
      signal_key: 'motor.temperature',
      observed_at: '2026-10-12T01:02:03.000Z',
      source_mode: 'EDGE_OFFLINE',
      quality: 'GOOD',
      unit: 'degC',
      sampling_interval_ms: 1000,
      payload: { celsius: 41.7, unit: 'C' },
    },
  ],
});

describe('DurableEdgeSpool', () => {
  let rootDir: string;
  let spool: DurableEdgeSpool;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'factoryos-edge-spool-'));
    spool = new DurableEdgeSpool(rootDir, TEST_ENCRYPTION_KEY, { retryBaseMs: 10, retryMaxMs: 40 });
    await spool.initialize();
  });

  afterEach(async () => {
    await spool.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('persists a queued batch across process restarts', async () => {
    await spool.enqueue(firstBatch(), 1_000);
    await spool.close();

    spool = new DurableEdgeSpool(rootDir, TEST_ENCRYPTION_KEY, { retryBaseMs: 10, retryMaxMs: 40 });
    await spool.initialize();

    const ready = await spool.listReady(10, 1_000);
    expect(ready).toHaveLength(1);
    expect(ready[0].batch).toEqual(firstBatch());
    expect((await spool.status()).pendingBatches).toBe(1);
  });

  it('restores the last successful cloud sync timestamp after a restart', async () => {
    const timestamp = '2026-10-12T04:00:00.000Z';
    await spool.markSuccessfulSync(timestamp);
    expect((await spool.status()).lastSuccessfulSyncAt).toBe(timestamp);

    await spool.close();
    spool = new DurableEdgeSpool(rootDir, TEST_ENCRYPTION_KEY, { retryBaseMs: 10, retryMaxMs: 40 });
    await spool.initialize();
    expect((await spool.status()).lastSuccessfulSyncAt).toBe(timestamp);

    // A delayed clock value must not move the durable sync marker backwards.
    await spool.markSuccessfulSync('2026-10-12T03:00:00.000Z');
    expect((await spool.status()).lastSuccessfulSyncAt).toBe(timestamp);
  });

  it('deduplicates identical batch keys and rejects conflicting reuse', async () => {
    await expect(spool.enqueue(firstBatch(), 1_000)).resolves.toEqual({
      idempotent: false,
      batchKey: 'batch-001',
    });
    await expect(spool.enqueue(firstBatch(), 2_000)).resolves.toEqual({
      idempotent: true,
      batchKey: 'batch-001',
    });

    const conflicting = firstBatch();
    conflicting.observations[0].payload.celsius = 99;
    await expect(spool.enqueue(conflicting, 3_000)).rejects.toMatchObject({
      code: 'BATCH_CONFLICT',
    });
    expect((await spool.status()).pendingBatches).toBe(1);
  });

  it('persists capped exponential retry scheduling across restarts', async () => {
    await spool.enqueue(firstBatch(), 1_000);
    await expect(spool.recordFailure('batch-001', 'HTTP_503', 1_000)).resolves.toEqual({
      attempts: 1,
      nextAttemptAt: 1_010,
    });
    expect(await spool.listReady(10, 1_009)).toHaveLength(0);

    await spool.close();
    spool = new DurableEdgeSpool(rootDir, TEST_ENCRYPTION_KEY, { retryBaseMs: 10, retryMaxMs: 40 });
    await spool.initialize();

    const ready = await spool.listReady(10, 1_010);
    expect(ready).toHaveLength(1);
    expect(ready[0].attempts).toBe(1);
    await expect(spool.recordFailure('batch-001', 'HTTP_503', 1_010)).resolves.toEqual({
      attempts: 2,
      nextAttemptAt: 1_030,
    });
    await expect(spool.recordFailure('batch-001', 'body contains token', 1_030)).resolves.toEqual({
      attempts: 3,
      nextAttemptAt: 1_070,
    });
  });

  it('never discards queued data when the batch capacity is reached', async () => {
    await spool.close();
    spool = new DurableEdgeSpool(rootDir, TEST_ENCRYPTION_KEY, {
      maxPendingBatches: 1,
      retryBaseMs: 10,
      retryMaxMs: 40,
    });
    await spool.initialize();
    await spool.enqueue(firstBatch());

    const second = firstBatch();
    second.batch_key = 'batch-002';
    second.observations[0].event_id = 'd88de39a-74a9-45e6-9427-7f0d4886bca7';
    await expect(spool.enqueue(second)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect((await spool.status()).pendingBatches).toBe(1);
    expect((await spool.listReady()).map((row) => row.batch.batch_key)).toEqual(['batch-001']);
  });

  it('rejects credential material before it is written to disk', async () => {
    const sample = firstBatch();
    const batch = {
      batch_key: 'credential-01',
      observations: [{ ...sample.observations[0], payload: { api_token: 'never-store-this' } }],
    };
    await expect(spool.enqueue(batch)).rejects.toMatchObject({ code: 'INVALID_BATCH' });
    expect((await spool.status()).pendingBatches).toBe(0);
  });

  it('requires a 32-byte AES-256 key', () => {
    expect(() => new DurableEdgeSpool(rootDir, Buffer.alloc(16))).toThrow(/32-byte AES-256 key/);
  });

  it('encrypts queued payloads and agent state at rest', async () => {
    await spool.enqueue(firstBatch());
    const [fileName] = await readdir(join(rootDir, 'pending'));
    const raw = await readFile(join(rootDir, 'pending', fileName), 'utf8');
    const state = await readFile(join(rootDir, 'agent-state.json'), 'utf8');

    expect(raw).toContain('"algorithm":"AES-256-GCM"');
    expect(raw).not.toContain('motor.temperature');
    expect(raw).not.toContain('41.7');
    expect(state).toContain('"algorithm":"AES-256-GCM"');
    expect(state).not.toContain('last_successful_sync_at');
  });

  it('fails closed when the spool is reopened with the wrong key', async () => {
    await spool.enqueue(firstBatch());
    await spool.close();

    spool = new DurableEdgeSpool(rootDir, Buffer.alloc(32, 0x22), { retryBaseMs: 10, retryMaxMs: 40 });
    await expect(spool.initialize()).rejects.toMatchObject({ code: 'SPOOL_CORRUPT' });
  });

  it('fails closed when an encrypted record authentication tag is tampered with', async () => {
    await spool.enqueue(firstBatch());
    const [fileName] = await readdir(join(rootDir, 'pending'));
    const filePath = join(rootDir, 'pending', fileName);
    const envelope = JSON.parse(await readFile(filePath, 'utf8')) as { auth_tag: string };
    envelope.auth_tag = Buffer.alloc(16).toString('base64');
    await writeFile(filePath, JSON.stringify(envelope), 'utf8');

    await expect(spool.listReady()).rejects.toMatchObject({ code: 'SPOOL_CORRUPT' });
    expect((await readdir(join(rootDir, 'pending')))).toContain(fileName);
  });

  it('serializes ownership of a spool directory to one agent process', async () => {
    const competing = new DurableEdgeSpool(rootDir, TEST_ENCRYPTION_KEY);
    await expect(competing.initialize()).rejects.toMatchObject({
      code: 'SPOOL_LOCKED',
    });
    await competing.close();
  });

  it('acknowledges a delivered batch by durably removing it and is idempotent', async () => {
    await spool.enqueue(firstBatch());
    await expect(spool.acknowledge('batch-001')).resolves.toBe(true);
    await expect(spool.acknowledge('batch-001')).resolves.toBe(false);
    expect(await spool.listReady()).toHaveLength(0);
    expect((await spool.status()).pendingBytes).toBe(0);
  });

  it('fails closed when the spool is used before initialization', async () => {
    const uninitialized = new DurableEdgeSpool(join(rootDir, 'not-opened'), TEST_ENCRYPTION_KEY);
    await expect(uninitialized.listReady()).rejects.toBeInstanceOf(EdgeSpoolError);
  });
});
