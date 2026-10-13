import { jest } from '@jest/globals';

import {
  EdgeSpoolError,
  type EdgeSpoolBatch,
} from '../spool/durable-edge-spool.js';
import type { EdgeOpcUaDataValue, OpcUaSignalMapping } from './edge-protocol-adapter.types.js';
import { OpcUaEdgeProtocolAdapter } from './opcua-edge-protocol.adapter.js';

const sourceTimestamp = new Date(Date.now() - 2_000).toISOString();
const mapping: OpcUaSignalMapping = {
  nodeId: 'ns=2;s=Factory.Line1.MotorTemperature',
  signalKey: 'line-1.motor-temperature',
  unit: 'degC',
  samplingIntervalMs: 500,
};

function sample(overrides: Partial<EdgeOpcUaDataValue> = {}): EdgeOpcUaDataValue {
  return {
    nodeId: mapping.nodeId,
    value: 68.4,
    sourceTimestamp,
    quality: 'GOOD',
    sourceSequence: 1201,
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

describe('OpcUaEdgeProtocolAdapter', () => {
  it('preserves the configured node ID, source timestamp, quality, unit and sampling interval', async () => {
    const { sink, batches } = createSink();
    const adapter = new OpcUaEdgeProtocolAdapter([mapping], sink);
    const first = await adapter.ingestDataValue(sample(), 'CLOUD_CONNECTED');
    const replay = await adapter.ingestDataValue(sample(), 'CLOUD_CONNECTED');

    expect(first).toMatchObject({
      accepted: true,
      idempotent: false,
      protocol: 'OPC_UA',
      signalKey: mapping.signalKey,
    });
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.idempotent).toBe(true);
    expect(batches[0]?.observations[0]).toMatchObject({
      event_id: first.eventId,
      signal_key: mapping.signalKey,
      observed_at: new Date(sourceTimestamp).toISOString(),
      source_mode: 'CLOUD_CONNECTED',
      quality: 'GOOD',
      unit: 'degC',
      sampling_interval_ms: 500,
      payload: {
        value: 68.4,
        source_id: mapping.nodeId,
        source_protocol: 'OPC_UA',
        source_sequence: '1201',
      },
    });
  });

  it('retains BAD/UNCERTAIN quality without fabricating GOOD and supports event-driven sampling', async () => {
    const { sink, batches } = createSink();
    const eventMapping = { ...mapping, unit: '%', samplingIntervalMs: 0 };
    const adapter = new OpcUaEdgeProtocolAdapter([eventMapping], sink);
    await adapter.ingestDataValue(sample({ quality: 'UNCERTAIN', value: true }), 'EDGE_OFFLINE');
    await adapter.ingestDataValue(sample({ quality: 'BAD', sourceSequence: 1202 }), 'EDGE_OFFLINE');

    expect(batches[0]?.observations[0]).toMatchObject({
      quality: 'UNCERTAIN',
      unit: '%',
      sampling_interval_ms: 0,
      payload: { value: true },
    });
    expect(batches[1]?.observations[0]).toMatchObject({ quality: 'BAD' });
  });

  it('rejects unknown nodes, missing timestamps, invalid quality and structured values', async () => {
    const { sink, enqueue } = createSink();
    const adapter = new OpcUaEdgeProtocolAdapter([mapping], sink);
    await expect(adapter.ingestDataValue(
      sample({ nodeId: 'ns=2;s=Unconfigured.Node' }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('not allow-listed');
    await expect(adapter.ingestDataValue(
      sample({ sourceTimestamp: '' }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('timestamp is missing or invalid');
    await expect(adapter.ingestDataValue(
      sample({ sourceTimestamp: '2026-10-12T08:00:00' }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('explicit timezone');
    await expect(adapter.ingestDataValue(
      sample({ sourceTimestamp: '2026-02-30T08:00:00Z' }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('timestamp is missing or invalid');
    await expect(adapter.ingestDataValue(
      sample({ quality: 'MAYBE' as never }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('Source quality');
    await expect(adapter.ingestDataValue(
      sample({ value: { temperature: 12 } }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('finite number, boolean, or bounded string');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('waits for an in-flight durable enqueue before stop resolves', async () => {
    const { sink } = createSink();
    const adapter = new OpcUaEdgeProtocolAdapter([mapping], sink);
    const callbacks = new Map<string, (value: EdgeOpcUaDataValue) => void>();
    const unsubscribe = jest.fn<() => void>();
    const transport = {
      subscribe: jest.fn(async (nodeId: string, handler: (value: EdgeOpcUaDataValue) => void) => {
        callbacks.set(nodeId, handler);
        return unsubscribe;
      }),
    };
    let enteredEnqueue!: () => void;
    const enqueueEntered = new Promise<void>((resolve) => {
      enteredEnqueue = resolve;
    });
    let releaseEnqueue!: () => void;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    sink.enqueue.mockImplementation(async (input: unknown) => {
      const batch = input as EdgeSpoolBatch;
      enteredEnqueue();
      await enqueueGate;
      return { idempotent: false, batchKey: batch.batch_key };
    });

    await adapter.start(transport, () => 'EDGE_OFFLINE', () => undefined);
    callbacks.get(mapping.nodeId)?.(sample());
    await enqueueEntered;

    let stopped = false;
    const stopping = adapter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseEnqueue();
    await stopping;
    expect(stopped).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('requires explicit valid unique node mappings', async () => {
    const { sink } = createSink();
    expect(() => new OpcUaEdgeProtocolAdapter([mapping, mapping], sink)).toThrow('Duplicate OPC UA node');
    expect(() => new OpcUaEdgeProtocolAdapter([
      { ...mapping, nodeId: 'opc.tcp://unauthorized-host' },
    ], sink)).toThrow(EdgeSpoolError);
    expect(() => new OpcUaEdgeProtocolAdapter([
      { ...mapping, samplingIntervalMs: 86400001 },
    ], sink)).toThrow('samplingIntervalMs');
    expect(() => new OpcUaEdgeProtocolAdapter([
      { ...mapping, nodeId: 'nsu=urn:factoryos:plant-a;s=Line1.Temperature' },
    ], sink)).not.toThrow();
  });

  it('binds only allow-listed nodes and unsubscribes cleanly', async () => {
    const { sink } = createSink();
    const adapter = new OpcUaEdgeProtocolAdapter([mapping], sink);
    const callbacks = new Map<string, (value: EdgeOpcUaDataValue) => void>();
    const unsubscribe = jest.fn<() => void>();
    const transport = {
      subscribe: jest.fn(async (nodeId: string, handler: (value: EdgeOpcUaDataValue) => void) => {
        callbacks.set(nodeId, handler);
        return unsubscribe;
      }),
    };
    const errors: Error[] = [];
    await adapter.start(transport, () => 'EDGE_OFFLINE', (error) => errors.push(error));
    expect(transport.subscribe).toHaveBeenCalledWith(mapping.nodeId, expect.any(Function));

    const queued = new Promise<EdgeSpoolBatch>((resolve) => {
      sink.enqueue.mockImplementation(async (input: unknown) => {
        const batch = input as EdgeSpoolBatch;
        resolve(batch);
        return { idempotent: false, batchKey: batch.batch_key };
      });
    });
    callbacks.get(mapping.nodeId)?.(sample());
    await expect(queued).resolves.toMatchObject({
      observations: [{ signal_key: mapping.signalKey, source_mode: 'EDGE_OFFLINE' }],
    });
    expect(errors).toEqual([]);
    await adapter.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
