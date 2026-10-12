import { EdgeSpoolError } from '../spool/durable-edge-spool.js';
import type {
  EdgeAdapterLifecycle,
  EdgeOpcUaDataValue,
  EdgeOpcUaTransport,
  EdgeProtocolBatchSink,
  EdgeProtocolIngestResult,
  EdgeProtocolSourceMode,
  OpcUaSignalMapping,
} from './edge-protocol-adapter.types.js';
import {
  normalizeObservedAt,
  normalizeQuality,
  normalizeScalar,
  queueNormalizedSample,
  validateSourceMode,
  validateStreamMapping,
} from './edge-protocol-adapter.utils.js';

const OPC_NODE_ID_PATTERN = /^(?:(?:ns=\d+|nsu=[^;]{1,160});)?(?:i=\d+|s=.{1,220}|g=[0-9a-f-]{36}|b=[A-Za-z0-9+/=]{1,220})$/i;

export class OpcUaEdgeProtocolAdapter implements EdgeAdapterLifecycle {
  private readonly mappingsByNodeId = new Map<string, OpcUaSignalMapping>();
  private readonly unsubscribers: Array<() => void | Promise<void>> = [];
  private started = false;

  constructor(
    mappings: readonly OpcUaSignalMapping[],
    private readonly sink: EdgeProtocolBatchSink,
  ) {
    if (!Array.isArray(mappings) || mappings.length < 1 || mappings.length > 256) {
      throw new EdgeSpoolError('INVALID_BATCH', 'OPC UA adapter requires between 1 and 256 explicit node mappings');
    }
    for (const mapping of mappings) {
      this.validateMapping(mapping);
      if (this.mappingsByNodeId.has(mapping.nodeId)) {
        throw new EdgeSpoolError('INVALID_BATCH', 'Duplicate OPC UA node mappings are not allowed');
      }
      this.mappingsByNodeId.set(mapping.nodeId, { ...mapping });
    }
  }

  async ingestDataValue(
    sample: EdgeOpcUaDataValue,
    sourceMode: EdgeProtocolSourceMode,
  ): Promise<EdgeProtocolIngestResult> {
    if (!sample || typeof sample.nodeId !== 'string') {
      throw new EdgeSpoolError('INVALID_BATCH', 'OPC UA node ID is required');
    }
    const mapping = this.mappingsByNodeId.get(sample.nodeId);
    if (!mapping) {
      throw new EdgeSpoolError('INVALID_BATCH', 'OPC UA node ID is not allow-listed');
    }
    validateSourceMode(sourceMode);
    const observedAt = normalizeObservedAt(sample.sourceTimestamp);
    const value = normalizeScalar(sample.value);
    const quality = normalizeQuality(sample.quality);

    let sourceSequence: string | number | undefined;
    if (sample.sourceSequence !== undefined) {
      if (typeof sample.sourceSequence === 'string' &&
          sample.sourceSequence.length > 0 && sample.sourceSequence.length <= 128) {
        sourceSequence = sample.sourceSequence;
      } else if (typeof sample.sourceSequence === 'number' &&
          Number.isSafeInteger(sample.sourceSequence) && sample.sourceSequence >= 0) {
        sourceSequence = sample.sourceSequence;
      } else {
        throw new EdgeSpoolError('INVALID_BATCH', 'OPC UA source sequence must be a bounded string or non-negative safe integer');
      }
    }

    return queueNormalizedSample(this.sink, {
      protocol: 'OPC_UA',
      sourceIdentifier: sample.nodeId,
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
    transport: EdgeOpcUaTransport,
    sourceModeProvider: () => EdgeProtocolSourceMode,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (this.started) throw new EdgeSpoolError('SPOOL_LOCKED', 'OPC UA adapter is already started');
    this.started = true;
    try {
      for (const mapping of this.mappingsByNodeId.values()) {
        const unsubscribe = await transport.subscribe(mapping.nodeId, (sample) => {
          void Promise.resolve()
            .then(() => this.ingestDataValue(sample, sourceModeProvider()))
            .catch((error: unknown) => onError(error instanceof Error ? error : new Error('OPC UA adapter failed')));
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
        errors.push(error instanceof Error ? error : new Error('OPC UA unsubscribe failed'));
      }
    }
    this.started = false;
    if (errors.length) throw new AggregateError(errors, 'One or more OPC UA subscriptions could not be stopped');
  }

  private validateMapping(mapping: OpcUaSignalMapping): void {
    if (!mapping || typeof mapping.nodeId !== 'string' || mapping.nodeId.length > 256 ||
        mapping.nodeId.includes('\0') || /[\r\n]/.test(mapping.nodeId) ||
        !OPC_NODE_ID_PATTERN.test(mapping.nodeId)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'OPC UA nodeId is not a supported explicit NodeId');
    }
    validateStreamMapping(mapping, 'OPC UA mapping');
  }
}
