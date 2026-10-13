import type { EdgeSpoolBatch, EdgeSpoolObservation } from '../spool/durable-edge-spool.js';

export type EdgeProtocolSourceMode = 'EDGE_OFFLINE' | 'CLOUD_CONNECTED';
export type EdgeProtocolQuality = 'GOOD' | 'UNCERTAIN' | 'BAD';

export interface EdgeProtocolBatchSink {
  enqueue(input: unknown): Promise<{ idempotent: boolean; batchKey: string }>;
}

export interface EdgeProtocolIngestResult {
  accepted: boolean;
  idempotent: boolean;
  batchKey: string;
  eventId: string;
  signalKey: string;
  protocol: 'MQTT' | 'OPC_UA' | 'MODBUS';
}

export interface EdgeStreamMapping {
  signalKey: string;
  unit: string;
  samplingIntervalMs: number;
}

export interface MqttSignalMapping extends EdgeStreamMapping {
  topic: string;
  valueField: string;
  timestampField: string;
  sourceIdentifierField?: string;
  sourceSequenceField?: string;
  qualityField?: string;
}

export interface OpcUaSignalMapping extends EdgeStreamMapping {
  nodeId: string;
}

export type ModbusFunctionCode = 1 | 2 | 3 | 4;
export type ModbusDataType = 'BOOL' | 'UINT16' | 'INT16' | 'UINT32' | 'INT32' | 'FLOAT32';
export type ModbusWordOrder = 'BIG_ENDIAN' | 'LITTLE_ENDIAN';

export interface ModbusSignalMapping extends EdgeStreamMapping {
  /** Safe logical name for the physical source; never an endpoint or secret. */
  sourceIdentifier: string;
  unitId: number;
  functionCode: ModbusFunctionCode;
  /** Zero-based Modbus read address. */
  address: number;
  dataType: ModbusDataType;
  wordOrder?: ModbusWordOrder;
  scale?: number;
  offset?: number;
}

export interface EdgeModbusReadSample {
  unitId: number;
  functionCode: ModbusFunctionCode;
  address: number;
  values: readonly (number | boolean)[];
  sampledAt: string | Date;
  quality?: EdgeProtocolQuality;
  sourceSequence?: string | number;
}

export interface EdgeMqttMessage {
  topic: string;
  payload: Uint8Array;
  receivedAt?: string;
}

export interface EdgeOpcUaDataValue {
  nodeId: string;
  value: unknown;
  sourceTimestamp: string | Date;
  quality: EdgeProtocolQuality;
  sourceSequence?: string | number;
}

export interface EdgeMqttTransport {
  /**
   * Bridge a pre-authorized MQTT client into this contract. The adapter itself
   * never creates a broker connection or owns a username/password/token.
   */
  subscribe(
    topic: string,
    handler: (message: EdgeMqttMessage) => void,
  ): Promise<() => void | Promise<void>>;
}

export interface EdgeOpcUaTransport {
  /**
   * Bridge a pre-authorized OPC UA session/subscription into this contract.
   * The adapter does not resolve endpoint URLs or provision certificates.
   */
  subscribe(
    nodeId: string,
    handler: (value: EdgeOpcUaDataValue) => void,
  ): Promise<() => void | Promise<void>>;
}

export interface EdgeModbusTransport {
  /** Poll this exact read at the configured interval and emit read snapshots. */
  watch(
    mapping: Readonly<ModbusSignalMapping>,
    handler: (sample: EdgeModbusReadSample) => void,
  ): Promise<() => void | Promise<void>>;
}

export interface EdgeAdapterLifecycle {
  stop(): Promise<void>;
}


export type NormalizedEdgeProtocolObservation = EdgeSpoolObservation;
export type NormalizedEdgeProtocolBatch = EdgeSpoolBatch;
