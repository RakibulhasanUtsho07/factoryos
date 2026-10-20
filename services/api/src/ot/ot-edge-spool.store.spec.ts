import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { OtOfflineSpoolStore, OtSpoolReplayer, type OtEdgeScope, type OtEdgeTelemetryEvent } from './ot-edge-spool.store';

const scope: OtEdgeScope = {
  tenant_id: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  factory_id: '8aaab63d-c447-46ce-950d-deebdd7f5f31',
  device_id: '9aaab63d-c447-46ce-950d-deebdd7f5f32',
};
const event = (overrides: Partial<OtEdgeTelemetryEvent> = {}): OtEdgeTelemetryEvent => ({
  source_event_id: 'mqtt:event-1',
  event_type: 'TEMPERATURE',
  stream_key: 'LINE_TEMPERATURE',
  source_sequence: 1,
  observed_at: '2026-10-20T10:00:00Z',
  payload: { value: 24.5 },
  ...overrides,
});

describe('OtOfflineSpoolStore', () => {
  let directory: string;
  let path: string;
  const key = Buffer.alloc(32, 0x23);
  let now: number;
  let spool: OtOfflineSpoolStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'factoryos-ot-spool-'));
    path = join(directory, 'telemetry.spool');
    now = Date.parse('2026-10-20T10:00:00Z');
    spool = new OtOfflineSpoolStore(path, key, () => now, 10, 1024 * 1024);
  });

  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('stores telemetry encrypted and recovers pending records after a new instance starts', async () => {
    await spool.enqueue(scope, event());
    const encryptedFile = await readFile(path, 'utf8');
    expect(encryptedFile).toMatch(/^FACTORYOS-OT-SPOOL-V1:/);
    expect(encryptedFile).not.toContain('24.5');
    const recovered = new OtOfflineSpoolStore(path, key, () => now, 10, 1024 * 1024);
    expect(await recovered.pendingCount()).toBe(1);
    expect((await recovered.readBatch())?.items[0]?.event).toEqual(event({ observed_at: '2026-10-20T10:00:00.000Z' }));
  });

  it('deduplicates exact source replay and rejects changed contents for an existing source ID', async () => {
    expect(await spool.enqueue(scope, event())).toMatchObject({ duplicate: false });
    expect(await spool.enqueue(scope, event())).toMatchObject({ duplicate: true });
    await expect(spool.enqueue(scope, event({ payload: { value: 100 } }))).rejects.toThrow(/different event fingerprint/);
    expect(await spool.pendingCount()).toBe(1);
  });

  it('refuses credentials and preserves the queued event when acknowledgement is lost', async () => {
    await expect(spool.enqueue(scope, event({ payload: { access_token: 'do-not-persist' } }))).rejects.toThrow(/credential-like/);
    await spool.enqueue(scope, event());
    const batch = (await spool.readBatch())!;
    await spool.defer(scope, batch.items, now);
    expect(await spool.pendingCount()).toBe(1);
    expect(await spool.readBatch(20, now + 999)).toBeNull();
    expect((await spool.readBatch(20, now + 1000))?.items[0]?.attempts).toBe(1);
  });

  it('does not let one delayed device prevent another device from draining', async () => {
    await spool.enqueue(scope, event());
    await spool.defer(scope, (await spool.readBatch())!.items, now);
    const otherScope = { ...scope, device_id: 'aaaaab63-c447-46ce-950d-deebdd7f5f33' };
    await spool.enqueue(otherScope, event({ source_event_id: 'modbus:event-1' }));
    expect((await spool.readBatch(20, now))?.scope.device_id).toBe(otherScope.device_id);
  });

  it('requires receiver confirmation of each item before removing records', async () => {
    await spool.enqueue(scope, event());
    const transport = { deliver: jest.fn(async () => [{ source_event_id: 'mqtt:event-1', status: 'DUPLICATE_REPLAY' }]) };
    const replayer = new OtSpoolReplayer(spool, transport);
    expect(await replayer.flushOnce(now)).toMatchObject({ status: 'ACKNOWLEDGED', count: 1 });
    expect(await spool.pendingCount()).toBe(0);
  });

  it('retains records and schedules exponential retry after a network error or invalid response', async () => {
    await spool.enqueue(scope, event());
    const transport = { deliver: jest.fn(async () => { throw new Error('network down'); }) };
    const replayer = new OtSpoolReplayer(spool, transport);
    expect(await replayer.flushOnce(now)).toMatchObject({ status: 'RETRY_SCHEDULED', count: 1, next_attempt_at_ms: now + 1000 });
    expect(await spool.pendingCount()).toBe(1);
    expect(await replayer.flushOnce(now + 999)).toMatchObject({ status: 'IDLE', count: 0 });
    expect(await replayer.flushOnce(now + 1000)).toMatchObject({ status: 'RETRY_SCHEDULED', count: 1, next_attempt_at_ms: now + 3000 });
  });

  it('fails closed on a wrong key or damaged ciphertext', async () => {
    await spool.enqueue(scope, event());
    await expect(new OtOfflineSpoolStore(path, Buffer.alloc(32, 0x24)).pendingCount()).rejects.toThrow(/authentication failed/);
    const file = await readFile(path, 'utf8');
    await import('node:fs/promises').then(async ({ writeFile }) => writeFile(path, file.slice(0, 40)));
    await expect(spool.pendingCount()).rejects.toThrow(/ciphertext is truncated|authentication failed/);
  });
});
