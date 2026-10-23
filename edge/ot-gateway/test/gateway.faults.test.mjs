import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OtEdgeDurableSpool } from '../src/spool.mjs';
import { handleMqttDelivery } from '../src/protocol-drivers.mjs';
import { replayOnce } from '../src/index.mjs';
import { secretFingerprint, validateGatewayConfig } from '../src/config.mjs';
import { ModbusTcpReadDriver } from '../src/protocol-drivers.mjs';
import { startModbusTcpSimulator } from './modbus-tcp-simulator.mjs';

const scope = {
  tenant_id: 'faaab63d-c447-46ce-950d-deebdd7f5f30',
  factory_id: '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001',
  device_id: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
};

const mqttDevice = {
  ...scope,
  device_key: 'LINE-1-MQTT',
  connection_reference: 'MQTT-LINE-1',
  topics: [{ topic: 'factory/line-1/telemetry', stream_key: 'TEMPERATURE', qos: 1 }],
};

function message(id, sequence) {
  return {
    topic: 'factory/line-1/telemetry',
    payload: Buffer.from(JSON.stringify({
      source_event_id: id,
      source_sequence: sequence,
      event_type: 'TELEMETRY',
      stream_key: 'TEMPERATURE',
      observed_at: '2026-10-23T04:00:00.000Z',
      payload: { value: 27.5 },
    })),
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'factoryos-ot-gateway-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'spool.enc');
  const key = Buffer.alloc(32, 0x35);
  const spool = new OtEdgeDurableSpool(file, key, { now: () => 1000, maxEntries: 100 });
  return { dir, file, key, spool };
}

test('QoS 1 acknowledgement callback runs only after durable spool commit', async (t) => {
  const { spool } = await fixture(t);
  let ackCount = 0;
  let visibleAtAck = false;
  await handleMqttDelivery(spool, [mqttDevice], message('mqtt-event-1', 40), async (error) => {
    assert.equal(error, undefined);
    ackCount += 1;
    visibleAtAck = (await spool.pendingCount()) === 1;
  });
  assert.equal(ackCount, 1);
  assert.equal(visibleAtAck, true);
});

test('broker acknowledgement loss and redelivery produce one durable event with the same source ID', async (t) => {
  const { spool } = await fixture(t);
  const packet = message('mqtt-redelivery-1', 40);
  const first = await new Promise((resolve, reject) => {
    handleMqttDelivery(spool, [mqttDevice], packet, (error) => error ? reject(error) : resolve('PUBACK_SENT'))
      .catch(reject);
  });
  assert.equal(first, 'PUBACK_SENT');
  // Simulate the PUBACK being lost on the network: the broker delivers the same QoS 1 PUBLISH again.
  const redelivery = await new Promise((resolve, reject) => {
    handleMqttDelivery(spool, [mqttDevice], packet, (error) => error ? reject(error) : resolve('PUBACK_SENT_AGAIN'))
      .catch(reject);
  });
  assert.equal(redelivery, 'PUBACK_SENT_AGAIN');
  assert.equal(await spool.pendingCount(), 1);
  const batch = await spool.readBatch();
  assert.equal(batch.items[0].event.source_event_id, 'mqtt-redelivery-1');
  assert.equal(batch.items[0].event.source_sequence, 40);
});

test('sequence gaps from a source are preserved instead of renumbered during offline replay', async (t) => {
  const { spool } = await fixture(t);
  await spool.enqueue(scope, {
    source_event_id: 'meter-seq-40', source_sequence: 40, event_type: 'TELEMETRY',
    stream_key: 'ACTIVE_POWER', observed_at: '2026-10-23T04:00:00.000Z', payload: { value: 1 },
  });
  await spool.enqueue(scope, {
    source_event_id: 'meter-seq-42', source_sequence: 42, event_type: 'TELEMETRY',
    stream_key: 'ACTIVE_POWER', observed_at: '2026-10-23T04:00:02.000Z', payload: { value: 3 },
  });
  const batch = await spool.readBatch();
  assert.deepEqual(batch.items.map((item) => item.event.source_sequence), [40, 42]);
  assert.deepEqual(batch.items.map((item) => item.event.source_event_id), ['meter-seq-40', 'meter-seq-42']);
});

test('crash/restart recovers encrypted events and never resets the generated source sequence', async (t) => {
  const { file, key, spool } = await fixture(t);
  const first = await spool.enqueueSample(scope, {
    event_type: 'TELEMETRY', stream_key: 'TEMP', observed_at: '2026-10-23T04:00:00.000Z', payload: { value: 20 },
  });
  assert.equal(first.sequence, 1);
  const before = await readFile(file);
  assert.equal(before.includes(Buffer.from('20')), false, 'plaintext telemetry must not appear in the spool file');

  const recovered = new OtEdgeDurableSpool(file, key, { now: () => 2000 });
  assert.equal(await recovered.pendingCount(), 1);
  const second = await recovered.enqueueSample(scope, {
    event_type: 'TELEMETRY', stream_key: 'TEMP', observed_at: '2026-10-23T04:00:01.000Z', payload: { value: 21 },
  });
  assert.equal(second.sequence, 2);
  assert.deepEqual((await recovered.readBatch()).items.map((item) => item.event.source_sequence), [1, 2]);
});

test('wrong spool key fails closed and leaves the encrypted queue untouched', async (t) => {
  const { file, key, spool } = await fixture(t);
  await spool.enqueue(scope, {
    source_event_id: 'wrong-key-guard', source_sequence: 2, event_type: 'TELEMETRY',
    stream_key: 'TEMP', observed_at: '2026-10-23T04:00:00.000Z', payload: { value: 31 },
  });
  const original = await readFile(file);
  const wrongKey = Buffer.alloc(32, 0x42);
  const broken = new OtEdgeDurableSpool(file, wrongKey);
  await assert.rejects(() => broken.pendingCount(), /authentication failed/);
  assert.deepEqual(await readFile(file), original);
  assert.notDeepEqual(key, wrongKey);
});

test('lost API acknowledgement retains the event; duplicate replay acknowledgement removes it once', async (t) => {
  const { dir, spool } = await fixture(t);
  const tokenFile = join(dir, 'api-token');
  await writeFile(tokenFile, 'rotatable-test-workload-token-value-1234567890', { mode: 0o600 });
  await spool.enqueue(scope, {
    source_event_id: 'api-ack-loss-1', source_sequence: 71, event_type: 'TELEMETRY',
    stream_key: 'TEMP', observed_at: '2026-10-23T04:00:00.000Z', payload: { value: 28 },
  });
  const config = { api: { baseUrl: 'https://factoryos-api.example.test', tokenFile } };
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls += 1;
    if (calls === 1) throw new Error('fault injected: commit completed but response was lost');
    const body = JSON.parse(request.body);
    return new Response(JSON.stringify({
      tenant_id: scope.tenant_id,
      data: {
        device_id: scope.device_id,
        received: body.events.length,
        items: body.events.map((event) => ({
          source_event_id: event.source_event_id,
          status: 'DUPLICATE_REPLAY',
        })),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const first = await replayOnce(spool, config, { now: 1000, fetchImpl });
  assert.equal(first.deferred, 1);
  assert.equal(await spool.pendingCount(), 1);

  const second = await replayOnce(spool, config, { now: 2000, fetchImpl });
  assert.deepEqual(second, { delivered: 1 });
  assert.equal(calls, 2);
  assert.equal(await spool.pendingCount(), 0);
});

test('manual blocked-entry requeue requires the exact fingerprint', async (t) => {
  const { spool } = await fixture(t);
  const queued = await spool.enqueue(scope, {
    source_event_id: 'blocked-review-1', source_sequence: 1, event_type: 'TELEMETRY',
    stream_key: 'TEMP', observed_at: '2026-10-23T04:00:00.000Z', payload: { value: 18 },
  });
  const item = (await spool.readBatch()).items[0];
  for (let i = 0; i < 12; i += 1) {
    await spool.defer(scope, [{ source_event_id: item.event.source_event_id, fingerprint: item.fingerprint }]);
  }
  assert.equal((await spool.stats()).blocked, 1);
  await assert.rejects(
    () => spool.requeueBlocked(scope, 'blocked-review-1', '0'.repeat(64)),
    /exact blocked event fingerprint/,
  );
  assert.equal(await spool.requeueBlocked(scope, 'blocked-review-1', queued.fingerprint), true);
  assert.equal((await spool.stats()).blocked, 0);
});

test('approved target allow-list and Modbus function codes fail closed for write functions', () => {
  const config = {
    gatewayId: 'gateway-test-01',
    listen: { host: '127.0.0.1', port: 8443 },
    security: {
      serverCertFile: '/tmp/server.pem', serverKeyFile: '/tmp/server-key.pem',
      bearerTokenFile: '/tmp/gateway-token', spoolKeyFile: '/tmp/spool-key',
      approvedTargets: ['https://factoryos-api.example.test:443', 'modbus.tcp://10.42.1.10:502'],
    },
    api: { baseUrl: 'https://factoryos-api.example.test' },
    mqtt: null,
    opcua: [],
    modbus: [{
      ...scope, device_key: 'METER-01', connection_reference: 'METER-CONFIG-01',
      host: '10.42.1.10', port: 502, unit_id: 7, pollIntervalMs: 2000, timeoutMs: 1000,
      register_map: [{ stream_key: 'ACTIVE_POWER', function_code: 3, address: 10, quantity: 2 }],
    }],
  };
  assert.doesNotThrow(() => validateGatewayConfig(structuredClone(config), { NODE_ENV: 'test' }));
  const unsafe = structuredClone(config);
  unsafe.modbus[0].register_map[0].function_code = 6;
  assert.throws(() => validateGatewayConfig(unsafe, { NODE_ENV: 'test' }), /only allows Modbus read function 3 or 4/);
});

test('secret rotation fingerprint changes on certificate/token rotation without printing credential bytes', async (t) => {
  const { dir } = await fixture(t);
  const cert = join(dir, 'gateway-cert.pem');
  const key = join(dir, 'gateway-key.pem');
  await writeFile(cert, 'CERTIFICATE-V1');
  await writeFile(key, 'PRIVATE-KEY-V1');
  const before = await secretFingerprint([cert, key]);
  await writeFile(cert, 'CERTIFICATE-V2');
  const after = await secretFingerprint([cert, key]);
  assert.notEqual(before, after);
  assert.match(after, /^[a-f0-9]{64}$/);
});

test('Modbus TCP driver reads registered holding/input registers from a real simulator socket', async (t) => {
  const simulator = await startModbusTcpSimulator({
    unitId: 7,
    registers: new Map([
      ['4:10', [0x4228, 0x0000]],
      ['3:30', [0x0000, 0x0064]],
    ]),
  });
  t.after(() => simulator.close());
  const device = {
    ...scope,
    device_key: 'ENERGY-METER-01',
    connection_reference: 'ENERGY-METER-01-TRUSTED',
    host: simulator.host,
    port: simulator.port,
    unit_id: 7,
    pollIntervalMs: 5000,
    timeoutMs: 500,
    register_map: [
      { stream_key: 'ACTIVE_POWER', function_code: 4, address: 10, quantity: 2 },
      { stream_key: 'ENERGY_TOTAL', function_code: 3, address: 30, quantity: 2 },
    ],
  };
  const driver = new ModbusTcpReadDriver(device, null);
  const results = await driver.read([
    { stream_key: 'ACTIVE_POWER', function_code: 4, address: 10, quantity: 2 },
    { stream_key: 'ENERGY_TOTAL', function_code: 3, address: 30, quantity: 2 },
  ]);
  assert.deepEqual(results.map((row) => row.registers), [[0x4228, 0x0000], [0x0000, 0x0064]]);
  assert.equal(simulator.metrics.reads, 2);
  assert.equal(simulator.metrics.writeAttempts, 0);
});

test('Modbus response loss and wrong unit ID fail closed without attempting a write', async (t) => {
  const simulator = await startModbusTcpSimulator({ unitId: 7 });
  t.after(() => simulator.close());
  const device = {
    ...scope,
    device_key: 'ENERGY-METER-01',
    connection_reference: 'ENERGY-METER-01-TRUSTED',
    host: simulator.host,
    port: simulator.port,
    unit_id: 7,
    pollIntervalMs: 5000,
    timeoutMs: 300,
    register_map: [{ stream_key: 'ACTIVE_POWER', function_code: 4, address: 10, quantity: 2 }],
  };
  const driver = new ModbusTcpReadDriver(device, null);
  simulator.faults.dropNextResponse = true;
  await assert.rejects(
    () => driver.read([{ stream_key: 'ACTIVE_POWER', function_code: 4, address: 10, quantity: 2 }]),
    /Modbus TCP read failed/,
  );
  simulator.faults.wrongUnitId = true;
  await assert.rejects(
    () => driver.read([{ stream_key: 'ACTIVE_POWER', function_code: 4, address: 10, quantity: 2 }]),
    /Modbus TCP read failed/,
  );
  await assert.rejects(
    () => driver.read([{ stream_key: 'ACTIVE_POWER', function_code: 6, address: 10, quantity: 2 }]),
    /Only Modbus holding\/input register reads/,
  );
  assert.equal(simulator.metrics.writeAttempts, 0);
});
