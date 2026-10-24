import { jest } from '@jest/globals';

import type { EdgeSpoolBatch } from '../spool/durable-edge-spool.js';
import type { EdgeModbusReadSample, ModbusSignalMapping } from './edge-protocol-adapter.types.js';
import { ModbusEdgeProtocolAdapter } from './modbus-edge-protocol.adapter.js';

const sampledAt = new Date(Date.now() - 2_000).toISOString();
const mapping: ModbusSignalMapping = {
  sourceIdentifier: 'plc-line-1',
  unitId: 7,
  functionCode: 3,
  address: 100,
  dataType: 'UINT16',
  signalKey: 'line-1.pressure',
  unit: 'kPa',
  samplingIntervalMs: 1000,
  scale: 0.1,
  offset: -20,
};

function sample(overrides: Partial<EdgeModbusReadSample> = {}): EdgeModbusReadSample {
  return {
    unitId: mapping.unitId,
    functionCode: mapping.functionCode,
    address: mapping.address,
    values: [1000],
    sampledAt,
    quality: 'GOOD',
    sourceSequence: 33,
    ...overrides,
  };
}

function createSink() {
  const seen = new Set<string>();
  const batches: EdgeSpoolBatch[] = [];
  const enqueue = jest.fn(async (input: unknown) => {
    const batch = input as EdgeSpoolBatch;
    const idempotent = seen.has(batch.batch_key);
    seen.add(batch.batch_key);
    batches.push(batch);
    return { idempotent, batchKey: batch.batch_key };
  });
  return { sink: { enqueue }, enqueue, batches };
}

describe('ModbusEdgeProtocolAdapter', () => {
  it('decodes, scales and enqueues allow-listed register samples with stable identity', async () => {
    const { sink, batches } = createSink();
    const adapter = new ModbusEdgeProtocolAdapter([mapping], sink);
    const first = await adapter.ingestReadSample(sample(), 'CLOUD_CONNECTED');
    const replay = await adapter.ingestReadSample(sample(), 'CLOUD_CONNECTED');
    expect(first).toMatchObject({ accepted: true, idempotent: false, protocol: 'MODBUS', signalKey: mapping.signalKey });
    expect(first.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.batchKey).toBe(first.batchKey);
    expect(replay.idempotent).toBe(true);
    expect(batches[0]?.observations[0]).toMatchObject({
      event_id: first.eventId, signal_key: mapping.signalKey, observed_at: new Date(sampledAt).toISOString(),
      source_mode: 'CLOUD_CONNECTED', quality: 'GOOD', unit: 'kPa', sampling_interval_ms: 1000,
      payload: { value: 80, source_id: 'plc-line-1/unit-7/fc-3/address-100', source_protocol: 'MODBUS', source_sequence: '33' },
    });
  });

  it('decodes BOOL/INT16 and 32-bit values with explicit word order', async () => {
    const { sink, batches } = createSink();
    const adapter = new ModbusEdgeProtocolAdapter([
      { ...mapping, functionCode: 1, address: 8, dataType: 'BOOL', scale: undefined, offset: undefined, unit: 'bool', samplingIntervalMs: 500 },
      { ...mapping, address: 101, dataType: 'INT16', scale: undefined, offset: undefined, unit: 'count' },
      { ...mapping, address: 102, dataType: 'UINT32', scale: undefined, offset: undefined, unit: 'count', wordOrder: 'BIG_ENDIAN' },
      { ...mapping, address: 104, dataType: 'FLOAT32', scale: undefined, offset: undefined, unit: 'ratio', wordOrder: 'LITTLE_ENDIAN' },
    ], sink);
    await adapter.ingestReadSample(sample({ functionCode: 1, address: 8, values: [true], sourceSequence: 1 }), 'EDGE_OFFLINE');
    await adapter.ingestReadSample(sample({ address: 101, values: [0xffff], sourceSequence: 2 }), 'EDGE_OFFLINE');
    await adapter.ingestReadSample(sample({ address: 102, values: [0x1234, 0x5678], sourceSequence: 3 }), 'EDGE_OFFLINE');
    await adapter.ingestReadSample(sample({ address: 104, values: [0x0000, 0x3fc0], sourceSequence: 4 }), 'EDGE_OFFLINE');
    expect(batches.map(batch => batch.observations[0]?.payload.value)).toEqual([true, -1, 0x12345678, 1.5]);
    expect(batches.every(batch => batch.observations[0]?.source_mode === 'EDGE_OFFLINE')).toBe(true);
  });

  it('rejects non-allow-listed reads and malformed timestamps/quality/register values', async () => {
    const { sink, enqueue } = createSink();
    const adapter = new ModbusEdgeProtocolAdapter([mapping], sink);
    await expect(adapter.ingestReadSample(sample({ address: 101 }), 'EDGE_OFFLINE')).rejects.toThrow('not allow-listed');
    await expect(adapter.ingestReadSample(sample({ values: [65_536] }), 'EDGE_OFFLINE')).rejects.toThrow('integers from 0 through 65535');
    await expect(adapter.ingestReadSample(sample({ values: [1000, 1] }), 'EDGE_OFFLINE')).rejects.toThrow('exactly 1 value');
    await expect(adapter.ingestReadSample(sample({ sampledAt: '2026-02-30T08:00:00Z' }), 'EDGE_OFFLINE'))
      .rejects.toThrow('timestamp is missing or invalid');
    await expect(adapter.ingestReadSample(sample({ quality: 'UNSPECIFIED' as never }), 'EDGE_OFFLINE'))
      .rejects.toThrow('Source quality');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('validates polling interval, function/data-type pairing and address range', () => {
    const { sink } = createSink();
    expect(() => new ModbusEdgeProtocolAdapter([{ ...mapping, samplingIntervalMs: 249 }], sink)).toThrow('at least 250ms');
    expect(() => new ModbusEdgeProtocolAdapter([{ ...mapping, functionCode: 1, dataType: 'UINT16' }], sink))
      .toThrow('function codes 1/2 require BOOL');
    expect(() => new ModbusEdgeProtocolAdapter([{ ...mapping, address: 65535, dataType: 'UINT32' }], sink))
      .toThrow('register range exceeds address 65535');
    expect(() => new ModbusEdgeProtocolAdapter([{ ...mapping, sourceIdentifier: 'bad host / id' }], sink))
      .toThrow('safe identifier');
    expect(() => new ModbusEdgeProtocolAdapter([{ ...mapping, address: -1 }], sink)).toThrow('address must be between');
    expect(() => new ModbusEdgeProtocolAdapter([mapping, mapping], sink)).toThrow('Duplicate Modbus unit/function/address');
  });

  it('drains accepted Modbus writes before adapter shutdown resolves', async () => {
    const { sink } = createSink();
    const adapter = new ModbusEdgeProtocolAdapter([mapping], sink);
    let callback: ((value: EdgeModbusReadSample) => void) | undefined;
    const unsubscribe = jest.fn<() => void>();
    const transport = {
      watch: jest.fn(async (_mapping: Readonly<ModbusSignalMapping>, handler: (value: EdgeModbusReadSample) => void) => {
        callback = handler;
        return unsubscribe;
      }),
    };
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    sink.enqueue.mockImplementation(async (input: unknown) => {
      const batch = input as EdgeSpoolBatch;
      entered();
      await gate;
      return { idempotent: false, batchKey: batch.batch_key };
    });
    await adapter.start(transport, () => 'EDGE_OFFLINE', () => undefined);
    callback?.(sample());
    await enteredPromise;
    let stopped = false;
    const stopping = adapter.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
