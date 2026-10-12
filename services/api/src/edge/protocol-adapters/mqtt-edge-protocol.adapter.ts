import { EdgeSpoolError } from '../spool/durable-edge-spool.js';
import type {
  EdgeAdapterLifecycle,
  EdgeMqttMessage,
  EdgeMqttTransport,
  EdgeProtocolBatchSink,
  EdgeProtocolIngestResult,
  EdgeProtocolSourceMode,
  MqttSignalMapping,
} from './edge-protocol-adapter.types.js';
import {
  drainProtocolOperations,
  normalizeObservedAt,
  normalizeQuality,
  normalizeScalar,
  queueNormalizedSample,
  readJsonPath,
  validateSourceMode,
  trackProtocolOperation,
  validateStreamMapping,
} from './edge-protocol-adapter.utils.js';

const DEFAULT_MAX_MQTT_PAYLOAD_BYTES = 64 * 1024;
const MQTT_TOPIC_PATTERN = /^[^\s+#]+$/;

export class MqttEdgeProtocolAdapter implements EdgeAdapterLifecycle {
  private readonly mappingsByTopic = new Map<string, MqttSignalMapping>();
  private readonly unsubscribers: Array<() => void | Promise<void>> = [];
  private started = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    mappings: readonly MqttSignalMapping[],
    private readonly sink: EdgeProtocolBatchSink,
    private readonly maxPayloadBytes = DEFAULT_MAX_MQTT_PAYLOAD_BYTES,
  ) {
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 256 || maxPayloadBytes > DEFAULT_MAX_MQTT_PAYLOAD_BYTES) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT payload limit must be between 256 bytes and 64 KiB');
    }
    if (!Array.isArray(mappings) || mappings.length < 1 || mappings.length > 256) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT adapter requires between 1 and 256 explicit topic mappings');
    }
    for (const mapping of mappings) {
      this.validateMapping(mapping);
      if (this.mappingsByTopic.has(mapping.topic)) {
        throw new EdgeSpoolError('INVALID_BATCH', 'Duplicate MQTT topic mappings are not allowed');
      }
      this.mappingsByTopic.set(mapping.topic, { ...mapping });
    }
  }

  async ingestMessage(
    message: EdgeMqttMessage,
    sourceMode: EdgeProtocolSourceMode,
  ): Promise<EdgeProtocolIngestResult> {
    if (!message || typeof message.topic !== 'string') {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT message topic is required');
    }
    const mapping = this.mappingsByTopic.get(message.topic);
    if (!mapping) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT topic is not allow-listed');
    }
    validateSourceMode(sourceMode);
    if (!(message.payload instanceof Uint8Array)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT message payload must be bytes');
    }
    if (message.payload.byteLength < 1 || message.payload.byteLength > this.maxPayloadBytes) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT message payload is empty or exceeds the configured limit');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.payload)) as unknown;
    } catch {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT payload must be valid UTF-8 JSON');
    }
    if (!this.isRecord(parsed)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT payload must be a JSON object');
    }

    const value = normalizeScalar(readJsonPath(parsed, mapping.valueField, 'MQTT value'));
    const observedAt = normalizeObservedAt(readJsonPath(parsed, mapping.timestampField, 'MQTT timestamp'));
    let sourceIdentifier = message.topic;
    if (mapping.sourceIdentifierField) {
      const rawIdentifier = readJsonPath(parsed, mapping.sourceIdentifierField, 'MQTT source identifier');
      if (typeof rawIdentifier !== 'string' || !rawIdentifier.trim() || rawIdentifier.length > 128) {
        throw new EdgeSpoolError('INVALID_BATCH', 'MQTT source identifier must be a non-empty string of at most 128 characters');
      }
      sourceIdentifier = rawIdentifier.trim();
    }

    let sourceSequence: string | number | undefined;
    if (mapping.sourceSequenceField) {
      const rawSequence = readJsonPath(parsed, mapping.sourceSequenceField, 'MQTT source sequence');
      if (typeof rawSequence === 'string' && rawSequence.length > 0 && rawSequence.length <= 128) {
        sourceSequence = rawSequence;
      } else if (typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) && rawSequence >= 0) {
        sourceSequence = rawSequence;
      } else {
        throw new EdgeSpoolError('INVALID_BATCH', 'MQTT source sequence must be a bounded string or non-negative safe integer');
      }
    }

    const quality = mapping.qualityField
      ? normalizeQuality(readJsonPath(parsed, mapping.qualityField, 'MQTT quality'))
      : normalizeQuality(undefined);
    return queueNormalizedSample(this.sink, {
      protocol: 'MQTT',
      sourceIdentifier,
      ...(sourceSequence !== undefined ? { sourceSequence } : {}),
      signalKey: mapping.signalKey,
      observedAt,
      sourceMode,
      quality,
      unit: mapping.unit,
      samplingIntervalMs: mapping.samplingIntervalMs,
      value,
    });
  }

  async start(
    transport: EdgeMqttTransport,
    sourceModeProvider: () => EdgeProtocolSourceMode,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (this.started) throw new EdgeSpoolError('SPOOL_LOCKED', 'MQTT adapter is already started');
    this.started = true;
    try {
      for (const mapping of this.mappingsByTopic.values()) {
        const unsubscribe = await transport.subscribe(mapping.topic, (message) => {
          trackProtocolOperation(
            this.inFlight,
            () => this.ingestMessage(message, sourceModeProvider()),
            onError,
            'MQTT adapter failed',
          );
        });
        this.unsubscribers.push(unsubscribe);
      }
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: Error[] = [];
    for (const unsubscribe of this.unsubscribers.splice(0).reverse()) {
      try {
        await unsubscribe();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error('MQTT unsubscribe failed'));
      }
    }
    await drainProtocolOperations(this.inFlight);
    this.started = false;
    if (errors.length) throw new AggregateError(errors, 'One or more MQTT subscriptions could not be stopped');
  }

  private validateMapping(mapping: MqttSignalMapping): void {
    if (!mapping || typeof mapping.topic !== 'string' || mapping.topic.length > 256 ||
        mapping.topic.includes('\0') || !MQTT_TOPIC_PATTERN.test(mapping.topic)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT topic must be an explicit topic without wildcards or whitespace');
    }
    validateStreamMapping(mapping, 'MQTT mapping');
    for (const [field, path] of [
      ['valueField', mapping.valueField],
      ['timestampField', mapping.timestampField],
      ['sourceIdentifierField', mapping.sourceIdentifierField],
      ['sourceSequenceField', mapping.sourceSequenceField],
      ['qualityField', mapping.qualityField],
    ] as const) {
      if (path !== undefined &&
          (typeof path !== 'string' || path.length < 1 || path.length > 160 ||
           path.split('.').some((segment) => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment)))) {
        throw new EdgeSpoolError('INVALID_BATCH', `MQTT mapping ${field} path is invalid`);
      }
    }
    if (!mapping.valueField || !mapping.timestampField) {
      throw new EdgeSpoolError('INVALID_BATCH', 'MQTT valueField and timestampField are required');
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype;
  }
}
