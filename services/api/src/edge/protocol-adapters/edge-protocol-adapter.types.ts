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
  protocol: 'MQTT' | 'OPC_UA';
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

export interface EdgeAdapterLifecycle {
  stop(): Promise<void>;
}


export type NormalizedEdgeProtocolObservation = EdgeSpoolObservation;
export type NormalizedEdgeProtocolBatch = EdgeSpoolBatch;
