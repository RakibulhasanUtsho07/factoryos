import { jest } from '@jest/globals';

import {
  EdgeSpoolError,
  type EdgeSpoolBatch,
} from '../spool/durable-edge-spool.js';
import type { EdgeMqttMessage, MqttSignalMapping } from './edge-protocol-adapter.types.js';
import { MqttEdgeProtocolAdapter } from './mqtt-edge-protocol.adapter.js';

const timestamp = new Date(Date.now() - 2_000).toISOString();

const mapping: MqttSignalMapping = {
  topic: 'site-a/line-1/temperature',
  signalKey: 'line-1.temperature',
  unit: 'degC',
  samplingIntervalMs: 1000,
  valueField: 'reading.value',
  timestampField: 'reading.timestamp',
  sourceIdentifierField: 'device_id',
  sourceSequenceField: 'sequence',
  qualityField: 'reading.quality',
};

function message(overrides: Record<string, unknown> = {}): EdgeMqttMessage {
  return {
    topic: mapping.topic,
    payload: new TextEncoder().encode(JSON.stringify({
      device_id: 'sensor-01',
      sequence: 42,
      reading: { value: 26.75, timestamp, quality: 'GOOD' },
      ...overrides,
    })),
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

describe('MqttEdgeProtocolAdapter', () => {
  it('normalizes allow-listed messages to a stable durable observation', async () => {
    const { sink, batches } = createSink();
    const adapter = new MqttEdgeProtocolAdapter([mapping], sink);
    const first = await adapter.ingestMessage(message(), 'CLOUD_CONNECTED');
    const replay = await adapter.ingestMessage(message(), 'CLOUD_CONNECTED');

    expect(first).toMatchObject({
      accepted: true,
      idempotent: false,
      protocol: 'MQTT',
      signalKey: mapping.signalKey,
    });
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.batchKey).toBe(first.batchKey);
    expect(replay.idempotent).toBe(true);
    expect(batches[0]?.observations[0]).toMatchObject({
      event_id: first.eventId,
      signal_key: mapping.signalKey,
      observed_at: new Date(timestamp).toISOString(),
      source_mode: 'CLOUD_CONNECTED',
      quality: 'GOOD',
      unit: 'degC',
      sampling_interval_ms: 1000,
      payload: {
        value: 26.75,
        source_id: 'sensor-01',
        source_protocol: 'MQTT',
        source_sequence: '42',
      },
    });
  });

  it('rejects non-allow-listed topics and wildcard mapping subscriptions', async () => {
    const { sink, enqueue } = createSink();
    const adapter = new MqttEdgeProtocolAdapter([mapping], sink);
    await expect(adapter.ingestMessage(
      { ...message(), topic: 'site-a/line-2/temperature' },
      'CLOUD_CONNECTED',
    )).rejects.toBeInstanceOf(EdgeSpoolError);
    expect(enqueue).not.toHaveBeenCalled();
    expect(() => new MqttEdgeProtocolAdapter([{ ...mapping, topic: 'site-a/+/temperature' }], sink))
      .toThrow(EdgeSpoolError);
  });

  it('rejects missing timestamps, unknown quality states, nested credential paths and oversized payloads', async () => {
    const { sink, enqueue } = createSink();
    const adapter = new MqttEdgeProtocolAdapter([mapping], sink);

    await expect(adapter.ingestMessage(
      { topic: mapping.topic, payload: new TextEncoder().encode(JSON.stringify({ reading: { value: 1 } })) },
      'EDGE_OFFLINE',
    )).rejects.toThrow('path was not present');

    await expect(adapter.ingestMessage(
      message({ reading: { value: 1, timestamp, quality: 'NOT_A_QUALITY' } }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('Source quality');

    const secretPathAdapter = new MqttEdgeProtocolAdapter([
      { ...mapping, sourceIdentifierField: 'auth.api_token' },
    ], sink);
    await expect(secretPathAdapter.ingestMessage(
      message({ auth: { api_token: 'must-not-be-read' } }),
      'EDGE_OFFLINE',
    )).rejects.toThrow('forbidden segment');

    await expect(adapter.ingestMessage(
      { topic: mapping.topic, payload: new Uint8Array(64 * 1024 + 1) },
      'EDGE_OFFLINE',
    )).rejects.toThrow('exceeds the configured limit');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('subscribes only explicit topics and releases subscriptions on stop', async () => {
    const { sink, batches } = createSink();
    const adapter = new MqttEdgeProtocolAdapter([mapping], sink);
    const callbacks = new Map<string, (next: EdgeMqttMessage) => void>();
    const unsubscribe = jest.fn<() => void>();
    const transport = {
      subscribe: jest.fn(async (topic: string, handler: (message: EdgeMqttMessage) => void) => {
        callbacks.set(topic, handler);
        return unsubscribe;
      }),
    };
    const errors: Error[] = [];
    await adapter.start(transport, () => 'EDGE_OFFLINE', (error) => errors.push(error));

    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(transport.subscribe).toHaveBeenCalledWith(mapping.topic, expect.any(Function));

    const queued = new Promise<EdgeSpoolBatch>((resolve) => {
      sink.enqueue.mockImplementation(async (input: unknown) => {
        const batch = input as EdgeSpoolBatch;
        resolve(batch);
        return { idempotent: false, batchKey: batch.batch_key };
      });
    });
    callbacks.get(mapping.topic)?.(message());
    await expect(queued).resolves.toMatchObject({
      observations: [{ signal_key: mapping.signalKey, source_mode: 'EDGE_OFFLINE' }],
    });
    expect(errors).toEqual([]);
    expect(batches.length).toBe(0);

    await adapter.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate mappings and unsupported sample value types before enqueue', async () => {
    const { sink, enqueue } = createSink();
    expect(() => new MqttEdgeProtocolAdapter([mapping, mapping], sink)).toThrow('Duplicate MQTT topic');
    await expect(new MqttEdgeProtocolAdapter([mapping], sink).ingestMessage(
      {
        topic: mapping.topic,
        payload: new TextEncoder().encode(JSON.stringify({
          device_id: 'sensor-01',
          sequence: 42,
          reading: { value: { nested: true }, timestamp, quality: 'GOOD' },
        })),
      },
      'EDGE_OFFLINE',
    )).rejects.toThrow('finite number, boolean, or bounded string');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
