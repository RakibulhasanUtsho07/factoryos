import { createHash } from 'node:crypto';

export type OtDeliveryStatus = 'ON_TIME' | 'LATE' | 'SEQUENCE_GAP';

// This deliberately accepts only a small, auditable OPC UA NodeId grammar.
// It is not intended to model every escaped-string form supported by the OPC UA spec.
export const OPC_UA_NODE_ID_PATTERN =
  /^(?:ns=(?:0|[1-9]\d{0,3});)?(?:i=(?:0|[1-9]\d{0,9})|s=[A-Za-z0-9_.:\/-]{1,256}|g=[0-9a-fA-F-]{36}|b=[A-Za-z0-9+/]{1,256}={0,2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateOpcUaNodeId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300 || !OPC_UA_NODE_ID_PATTERN.test(value)) {
    throw new Error('OPC UA NodeId is not in the approved bounded format');
  }
  return value;
}

export function getAllowedOpcUaNodeIds(metadata: Record<string, unknown>): string[] {
  const profile = metadata['opcua'];
  if (!isRecord(profile)) {
    throw new Error('OPC UA devices must define metadata.opcua.allowed_node_ids');
  }
  const nodes = profile['allowed_node_ids'];
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 20) {
    throw new Error('metadata.opcua.allowed_node_ids must contain between 1 and 20 NodeIds');
  }
  const normalized = nodes.map(validateOpcUaNodeId);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('metadata.opcua.allowed_node_ids must not contain duplicate NodeIds');
  }
  return normalized;
}

/** Canonical JSON is used for replay fingerprints; object key order is not significant. */
export function canonicalOtJson(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalOtJson).join(',') + ']';
  }
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalOtJson(value[key]),
    ).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('OT payload must contain only JSON values');
  }
  return encoded;
}

export function hashOtValue(value: unknown): string {
  return createHash('sha256').update(canonicalOtJson(value), 'utf8').digest('hex');
}

/**
 * Normalize bounded, JSON-compatible data and reject fields that could leak credentials
 * into telemetry, device metadata, audit history or support exports.
 */
export function normalizeOtObject(value: unknown, label = 'payload'): Record<string, unknown> {
  function visit(current: unknown, path: string, depth: number): unknown {
    if (depth > 8) throw new Error(label + ' exceeds maximum nesting depth');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      if (typeof current === 'string' && current.length > 2048) {
        throw new Error(path + ' contains a string longer than 2048 characters');
      }
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(path + ' must be a finite number');
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > 100) throw new Error(path + ' exceeds 100 array items');
      return current.map((entry, index) => visit(entry, path + '[' + index + ']', depth + 1));
    }
    if (!isRecord(current)) throw new Error(path + ' must contain JSON-compatible values');
    const keys = Object.keys(current);
    if (keys.length > 100) throw new Error(path + ' exceeds 100 object properties');
    const normalized: Record<string, unknown> = Object.create(null);
    for (const key of keys.sort()) {
      if (!key.trim() || key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error(path + ' contains an invalid property name');
      }
      if (/(password|passwd|token|secret|credential|authorization|api[_-]?key|private[_-]?key|client[_-]?secret)/i.test(key)) {
        throw new Error(path + ' cannot contain credential-like property names');
      }
      normalized[key] = visit(current[key], path + '.' + key, depth + 1);
    }
    return normalized;
  }

  const normalized = visit(value, label, 0);
  if (!isRecord(normalized)) throw new Error(label + ' must be a JSON object');
  return normalized;
}

export function classifyOtSequence(
  lastSequence: number | null,
  incomingSequence: number | null,
): OtDeliveryStatus {
  if (lastSequence === null || incomingSequence === null) return 'ON_TIME';
  if (incomingSequence <= lastSequence) return 'LATE';
  if (incomingSequence > lastSequence + 1) return 'SEQUENCE_GAP';
  return 'ON_TIME';
}
