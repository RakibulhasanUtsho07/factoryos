import { createHash } from 'node:crypto';

import {
  EdgeSpoolError,
  type EdgeSpoolBatch,
  type EdgeSpoolObservation,
} from '../spool/durable-edge-spool.js';
import type { EdgeProtocolQuality, EdgeProtocolSourceMode, EdgeProtocolBatchSink, EdgeProtocolIngestResult } from './edge-protocol-adapter.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const UNIT_PATTERN = /^[A-Za-z0-9%._/-]{1,32}$/;
const CREDENTIAL_FIELD_PATTERN = /(?:secret|password|credential|private.?key|api.?key|api.?token|access.?token|refresh.?token|authorization|bearer)/i;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const EVENT_NAMESPACE = Buffer.from('9b90bc2ae53d5f9abd35f7e4a7c1f4a1'.replace(/-/g, ''), 'hex');

export function validateStreamMapping(mapping: {
  signalKey: string;
  unit: string;
  samplingIntervalMs: number;
}, label: string): void {
  if (typeof mapping.signalKey !== 'string' || !SIGNAL_KEY_PATTERN.test(mapping.signalKey)) {
    throw new EdgeSpoolError('INVALID_BATCH', `${label}.signalKey is invalid`);
  }
  if (typeof mapping.unit !== 'string' || !UNIT_PATTERN.test(mapping.unit)) {
    throw new EdgeSpoolError('INVALID_BATCH', `${label}.unit is invalid`);
  }
  if (!Number.isSafeInteger(mapping.samplingIntervalMs) ||
      mapping.samplingIntervalMs < 0 || mapping.samplingIntervalMs > 86400000) {
    throw new EdgeSpoolError('INVALID_BATCH', `${label}.samplingIntervalMs must be between 0 and 86400000`);
  }
}

export function validateSourceMode(sourceMode: EdgeProtocolSourceMode): void {
  if (sourceMode !== 'EDGE_OFFLINE' && sourceMode !== 'CLOUD_CONNECTED') {
    throw new EdgeSpoolError('INVALID_BATCH', 'sourceMode is invalid');
  }
}

export function normalizeQuality(value: unknown, fallback: EdgeProtocolQuality = 'UNCERTAIN'): EdgeProtocolQuality {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'GOOD' || value === 'UNCERTAIN' || value === 'BAD') return value;
  throw new EdgeSpoolError('INVALID_BATCH', 'Source quality must be GOOD, UNCERTAIN, or BAD');
}

export function normalizeObservedAt(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new EdgeSpoolError('INVALID_BATCH', 'Source timestamp must be an ISO date string or Date');
  }
  if (typeof value === 'string' &&
      !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$/i.test(value)) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Source timestamp must be an ISO-8601 timestamp with an explicit timezone');
  }
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Source timestamp is missing or invalid');
  }
  if (timestamp > Date.now() + 5 * 60_000) {
    throw new EdgeSpoolError('INVALID_BATCH', 'Source timestamp is more than five minutes in the future');
  }
  return new Date(timestamp).toISOString();
}

export function normalizeScalar(value: unknown): string | number | boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 2048) return value;
  if (typeof value === 'boolean') return value;
  throw new EdgeSpoolError('INVALID_BATCH', 'Source value must be a finite number, boolean, or bounded string');
}

export function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new EdgeSpoolError('INVALID_BATCH', 'Source value is not JSON serializable');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object).sort().map((key) => {
    if (RESERVED_KEYS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key)) {
      throw new EdgeSpoolError('INVALID_BATCH', 'Source payload contains a reserved or credential-like field');
    }
    return `${JSON.stringify(key)}:${canonicalValue(object[key])}`;
  });
  return `{${entries.join(',')}}`;
}

/** RFC 4122 UUIDv5; identical source sample identity always produces the same event ID. */
export function stableEdgeEventId(identity: Record<string, unknown>): string {
  const name = Buffer.from(canonicalValue(identity), 'utf8');
  const digest = createHash('sha1')
    .update(EVENT_NAMESPACE)
    .update(name)
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readJsonPath(object: Record<string, unknown>, path: string, label: string): unknown {
  if (typeof path !== 'string' || !path || path.length > 160) {
    throw new EdgeSpoolError('INVALID_BATCH', `${label} path is invalid`);
  }
  const segments = path.split('.');
  if (segments.some((part) => !part || RESERVED_KEYS.has(part) || CREDENTIAL_FIELD_PATTERN.test(part))) {
    throw new EdgeSpoolError('INVALID_BATCH', `${label} path contains a forbidden segment`);
  }
  let current: unknown = object;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current) ||
        !Object.hasOwn(current, segment)) {
      throw new EdgeSpoolError('INVALID_BATCH', `${label} path was not present in the source message`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function queueNormalizedSample(
  sink: EdgeProtocolBatchSink,
  args: {
    protocol: 'MQTT' | 'OPC_UA';
    sourceIdentifier: string;
    sourceSequence?: string | number;
    signalKey: string;
    observedAt: string;
    sourceMode: EdgeProtocolSourceMode;
    quality: EdgeProtocolQuality;
    unit: string;
    samplingIntervalMs: number;
    value: string | number | boolean;
  },
): Promise<EdgeProtocolIngestResult> {
  const eventId = stableEdgeEventId({
    protocol: args.protocol,
    sourceIdentifier: args.sourceIdentifier,
    sourceSequence: args.sourceSequence ?? null,
    signalKey: args.signalKey,
    observedAt: args.observedAt,
    value: args.value,
    quality: args.quality,
  });
  const batchKey = `${args.protocol.toLowerCase()}-${eventId}`;
  const observation: EdgeSpoolObservation = {
    event_id: eventId,
    signal_key: args.signalKey,
    observed_at: args.observedAt,
    source_mode: args.sourceMode,
    quality: args.quality,
    unit: args.unit,
    sampling_interval_ms: args.samplingIntervalMs,
    payload: {
      value: args.value,
      source_id: args.sourceIdentifier,
      source_protocol: args.protocol,
      ...(args.sourceSequence !== undefined ? { source_sequence: String(args.sourceSequence).slice(0, 128) } : {}),
    },
  };
  const batch: EdgeSpoolBatch = { batch_key: batchKey, observations: [observation] };
  const enqueued = await sink.enqueue(batch);
  return {
    accepted: true,
    idempotent: enqueued.idempotent,
    batchKey: enqueued.batchKey,
    eventId,
    signalKey: args.signalKey,
    protocol: args.protocol,
  };
}
