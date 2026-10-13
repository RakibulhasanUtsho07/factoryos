import { EdgeSpoolError } from '../spool/durable-edge-spool.js';
import type {
  EdgeAdapterLifecycle,
  EdgeModbusReadSample,
  EdgeModbusTransport,
  EdgeProtocolBatchSink,
  EdgeProtocolIngestResult,
  EdgeProtocolSourceMode,
  ModbusDataType,
  ModbusSignalMapping,
} from './edge-protocol-adapter.types.js';
import {
  drainProtocolOperations,
  normalizeObservedAt,
  normalizeQuality,
  queueNormalizedSample,
  trackProtocolOperation,
  validateSourceMode,
  validateStreamMapping,
} from './edge-protocol-adapter.utils.js';

const MAX_MAPPINGS = 256;
const MIN_POLL_INTERVAL_MS = 250;
const SOURCE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FUNCTION_CODES = new Set<number>([1, 2, 3, 4]);
const REGISTER_TYPES = new Set<ModbusDataType>(['UINT16', 'INT16', 'UINT32', 'INT32', 'FLOAT32']);
const DOUBLE_REGISTER_TYPES = new Set<ModbusDataType>(['UINT32', 'INT32', 'FLOAT32']);

function key(unitId: number, functionCode: number, address: number): string {
  return String(unitId) + ':' + String(functionCode) + ':' + String(address);
}

function isBitFunction(functionCode: number): boolean {
  return functionCode === 1 || functionCode === 2;
}

function registerCount(dataType: ModbusDataType): number {
  return DOUBLE_REGISTER_TYPES.has(dataType) ? 2 : 1;
}

function register(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Modbus register values must be integers from 0 through 65535');
  }
  return value;
}

export class ModbusEdgeProtocolAdapter implements EdgeAdapterLifecycle {
  private readonly mappings = new Map<string, ModbusSignalMapping>();
  private readonly unsubscribers: Array<() => void | Promise<void>> = [];
  private readonly inFlight = new Set<Promise<void>>();
  private started = false;

  constructor(
    mappings: readonly ModbusSignalMapping[],
    private readonly sink: EdgeProtocolBatchSink,
  ) {
    if (!Array.isArray(mappings) || mappings.length < 1 || mappings.length > MAX_MAPPINGS) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus adapter requires between 1 and 256 explicit read mappings');
    }
    for (const mapping of mappings) {
      this.validateMapping(mapping);
      const mapKey = key(mapping.unitId, mapping.functionCode, mapping.address);
      if (this.mappings.has(mapKey)) {
        throw new EdgeSpoolError('INVALID_BATCH', 'Duplicate Modbus unit/function/address mappings are not allowed');
      }
      this.mappings.set(mapKey, { ...mapping });
    }
  }

  async ingestReadSample(
    sample: EdgeModbusReadSample,
    sourceMode: EdgeProtocolSourceMode,
  ): Promise<EdgeProtocolIngestResult> {
    if (!sample || !Array.isArray(sample.values)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus read sample and value array are required');
    }
    const mapping = this.mappings.get(key(sample.unitId, sample.functionCode, sample.address));
    if (!mapping) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus unit/function/address is not allow-listed');
    }
    validateSourceMode(sourceMode);
    const observedAt = normalizeObservedAt(sample.sampledAt);
    const value = this.decodeValue(mapping, sample.values);
    const quality = normalizeQuality(sample.quality, 'UNCERTAIN');

    let sourceSequence: string | number | undefined;
    if (sample.sourceSequence !== undefined) {
      if (typeof sample.sourceSequence === 'string' &&
          sample.sourceSequence.length > 0 && sample.sourceSequence.length <= 128) {
        sourceSequence = sample.sourceSequence;
      } else if (typeof sample.sourceSequence === 'number' &&
          Number.isSafeInteger(sample.sourceSequence) && sample.sourceSequence >= 0) {
        sourceSequence = sample.sourceSequence;
      } else {
        throw new EdgeSpoolError('INVALID_BATCH', 'Modbus source sequence must be a bounded string or non-negative safe integer');
      }
    }

    const sourceIdentifier = mapping.sourceIdentifier +
      '/unit-' + String(mapping.unitId) +
      '/fc-' + String(mapping.functionCode) +
      '/address-' + String(mapping.address);
    return queueNormalizedSample(this.sink, {
      protocol: 'MODBUS',
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
    transport: EdgeModbusTransport,
    sourceModeProvider: () => EdgeProtocolSourceMode,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (this.started) throw new EdgeSpoolError('SPOOL_LOCKED', 'Modbus adapter is already started');
    this.started = true;
    try {
      for (const mapping of this.mappings.values()) {
        const unsubscribe = await transport.watch(mapping, (sample) => {
          trackProtocolOperation(
            this.inFlight,
            () => this.ingestReadSample(sample, sourceModeProvider()),
            onError,
            'Modbus adapter failed',
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
        errors.push(error instanceof Error ? error : new Error('Modbus watch could not be released'));
      }
    }
    await drainProtocolOperations(this.inFlight);
    this.started = false;
    if (errors.length) {
      throw new AggregateError(errors, 'One or more Modbus watches could not be stopped');
    }
  }

  private decodeValue(mapping: ModbusSignalMapping, values: readonly (number | boolean)[]): string | number | boolean {
    const expectedCount = mapping.dataType === 'BOOL' ? 1 : registerCount(mapping.dataType);
    if (values.length !== expectedCount) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus sample must contain exactly ' + String(expectedCount) + ' value(s) for its configured data type');
    }
    if (mapping.dataType === 'BOOL') {
      if (typeof values[0] !== 'boolean') {
        throw new EdgeSpoolError('INVALID_BATCH', 'Modbus coil/discrete input must be a boolean');
      }
      return values[0];
    }
    if (!REGISTER_TYPES.has(mapping.dataType)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus data type is unsupported');
    }
    const first = register(values[0]);
    let decoded: number;
    if (mapping.dataType === 'UINT16') decoded = first;
    else if (mapping.dataType === 'INT16') decoded = first >= 0x8000 ? first - 0x10000 : first;
    else {
      const second = register(values[1]);
      const little = mapping.wordOrder === 'LITTLE_ENDIAN';
      const bytes = Buffer.alloc(4);
      bytes.writeUInt16BE(little ? second : first, 0);
      bytes.writeUInt16BE(little ? first : second, 2);
      if (mapping.dataType === 'UINT32') decoded = bytes.readUInt32BE(0);
      else if (mapping.dataType === 'INT32') decoded = bytes.readInt32BE(0);
      else decoded = bytes.readFloatBE(0);
    }
    const scaled = decoded * (mapping.scale ?? 1) + (mapping.offset ?? 0);
    if (!Number.isFinite(decoded) || !Number.isFinite(scaled)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Decoded Modbus value and scaled value must be finite numbers');
    }
    return scaled;
  }

  private validateMapping(mapping: ModbusSignalMapping): void {
    if (!mapping || typeof mapping.sourceIdentifier !== 'string' ||
        !SOURCE_IDENTIFIER_PATTERN.test(mapping.sourceIdentifier)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus sourceIdentifier must be a non-empty safe identifier of at most 128 characters');
    }
    if (!Number.isInteger(mapping.unitId) || mapping.unitId < 1 || mapping.unitId > 247) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus unitId must be between 1 and 247 for read operations');
    }
    if (!Number.isInteger(mapping.functionCode) || !FUNCTION_CODES.has(mapping.functionCode)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus functionCode must be 1, 2, 3, or 4');
    }
    if (!Number.isInteger(mapping.address) || mapping.address < 0 || mapping.address > 0xffff) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus address must be between 0 and 65535');
    }
    validateStreamMapping(mapping, 'Modbus mapping');
    if (mapping.samplingIntervalMs < MIN_POLL_INTERVAL_MS) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus samplingIntervalMs must be at least 250ms');
    }
    if (typeof mapping.dataType !== 'string' ||
        (mapping.dataType !== 'BOOL' && !REGISTER_TYPES.has(mapping.dataType))) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus dataType is unsupported');
    }
    const bitFunction = isBitFunction(mapping.functionCode);
    if (bitFunction !== (mapping.dataType === 'BOOL')) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus function codes 1/2 require BOOL; function codes 3/4 require a numeric register type');
    }
    const count = mapping.dataType === 'BOOL' ? 1 : registerCount(mapping.dataType);
    if (mapping.address + count - 1 > 0xffff) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus mapping register range exceeds address 65535');
    }
    if (mapping.wordOrder !== undefined &&
        mapping.wordOrder !== 'BIG_ENDIAN' && mapping.wordOrder !== 'LITTLE_ENDIAN') {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus wordOrder must be BIG_ENDIAN or LITTLE_ENDIAN');
    }
    if (mapping.wordOrder !== undefined && !DOUBLE_REGISTER_TYPES.has(mapping.dataType)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus wordOrder applies only to 32-bit data types');
    }
    if (mapping.scale !== undefined && (typeof mapping.scale !== 'number' || !Number.isFinite(mapping.scale))) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus scale must be a finite number');
    }
    if (mapping.offset !== undefined && (typeof mapping.offset !== 'number' || !Number.isFinite(mapping.offset))) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus offset must be a finite number');
    }
    if (mapping.dataType === 'BOOL' && (mapping.scale !== undefined || mapping.offset !== undefined)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Modbus BOOL mappings cannot use scale or offset');
    }
  }
}
