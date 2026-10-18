import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookEnvelope {
  event_type: string;
  schema_version: number;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export class IntegrationContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationContractError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[A-Z][A-Z0-9_.-]{0,149}$/;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function typeOfJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function validateSchemaNode(value: unknown, path: string, depth: number): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID', path + ' must be an object');
  }
  if (depth > 8) {
    throw new IntegrationContractError('WEBHOOK_SCHEMA_TOO_DEEP', path + ' exceeds the maximum schema depth of 8');
  }
  const type = value.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_TYPE', path + '.type must be a supported JSON type');
  }

  const allowedByType: Record<string, ReadonlySet<string>> = {
    object: new Set(['type', 'properties', 'required', 'additionalProperties', 'maxProperties', 'enum']),
    array: new Set(['type', 'items', 'maxItems', 'enum']),
    string: new Set(['type', 'minLength', 'maxLength', 'enum']),
    number: new Set(['type', 'minimum', 'maximum', 'enum']),
    integer: new Set(['type', 'minimum', 'maximum', 'enum']),
    boolean: new Set(['type', 'enum']),
    null: new Set(['type', 'enum']),
  };
  for (const key of Object.keys(value)) {
    if (!allowedByType[type].has(key)) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_UNSUPPORTED_KEYWORD', path + ' contains unsupported schema keyword ' + key);
    }
  }

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length < 1 || value.enum.length > 100) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_ENUM', path + '.enum must contain 1 to 100 values');
    }
    for (const entry of value.enum) {
      if (typeOfJson(entry) !== type && !(type === 'number' && typeof entry === 'number')) {
        throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_ENUM', path + '.enum values must match schema type');
      }
    }
  }

  if (type === 'object') {
    if (!isRecord(value.properties)) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_PROPERTIES_REQUIRED', path + '.properties must be an object');
    }
    if (Object.keys(value.properties).length > 100) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_TOO_MANY_PROPERTIES', path + '.properties cannot exceed 100 keys');
    }
    if (value.additionalProperties !== undefined && value.additionalProperties !== false) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_ADDITIONAL_PROPERTIES_UNSUPPORTED', path + '.additionalProperties must be false');
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== 'string') ||
          new Set(value.required).size !== value.required.length || value.required.length > 100) {
        throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_REQUIRED', path + '.required must be a unique string array');
      }
      for (const key of value.required as string[]) {
        if (!Object.hasOwn(value.properties, key)) {
          throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_REQUIRED', path + '.required references an undefined property');
        }
      }
    }
    const maxProperties = value.maxProperties;
    if (maxProperties !== undefined && (!Number.isInteger(maxProperties) || Number(maxProperties) < 0 || Number(maxProperties) > 100)) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_LIMIT', path + '.maxProperties must be an integer from 0 to 100');
    }
    for (const [key, child] of Object.entries(value.properties)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new IntegrationContractError('WEBHOOK_SCHEMA_UNSAFE_PROPERTY', path + ' contains an unsafe property name');
      }
      validateSchemaNode(child, path + '.properties.' + key, depth + 1);
    }
  } else if (type === 'array') {
    if (!Object.hasOwn(value, 'items')) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_ITEMS_REQUIRED', path + '.items is required for arrays');
    }
    const maxItems = value.maxItems;
    if (maxItems === undefined || !Number.isInteger(maxItems) || Number(maxItems) < 0 || Number(maxItems) > 1000) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_LIMIT', path + '.maxItems is required and must be an integer from 0 to 1000');
    }
    validateSchemaNode(value.items, path + '.items', depth + 1);
  } else if (type === 'string') {
    const minLength = value.minLength ?? 0;
    const maxLength = value.maxLength ?? 10000;
    if (!Number.isInteger(minLength) || Number(minLength) < 0 || Number(minLength) > 10000 ||
        !Number.isInteger(maxLength) || Number(maxLength) < Number(minLength) || Number(maxLength) > 10000) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_LIMIT', path + ' has an invalid string length limit');
    }
  } else if (type === 'number' || type === 'integer') {
    if (value.minimum !== undefined && (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum))) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_LIMIT', path + '.minimum must be finite');
    }
    if (value.maximum !== undefined && (typeof value.maximum !== 'number' || !Number.isFinite(value.maximum))) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_LIMIT', path + '.maximum must be finite');
    }
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) {
      throw new IntegrationContractError('WEBHOOK_SCHEMA_INVALID_LIMIT', path + '.minimum cannot exceed maximum');
    }
  }
}

export function assertPayloadSchema(schema: unknown): asserts schema is Record<string, unknown> {
  const serialized = JSON.stringify(schema);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 32 * 1024) {
    throw new IntegrationContractError('WEBHOOK_SCHEMA_TOO_LARGE', 'payload_schema must be JSON and no larger than 32 KiB');
  }
  validateSchemaNode(schema, '$', 0);
  if ((schema as Record<string, unknown>).type !== 'object') {
    throw new IntegrationContractError('WEBHOOK_SCHEMA_ROOT_TYPE', 'payload_schema root type must be object');
  }
}

function validateNode(value: unknown, schema: Record<string, unknown>, path: string): void {
  const expectedType = String(schema.type);
  const actualType = typeOfJson(value);
  if (expectedType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new IntegrationContractError('WEBHOOK_PAYLOAD_TYPE_MISMATCH', path + ' must be a finite number');
    }
  } else if (expectedType === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new IntegrationContractError('WEBHOOK_PAYLOAD_TYPE_MISMATCH', path + ' must be a safe integer');
    }
  } else if (actualType !== expectedType) {
    throw new IntegrationContractError('WEBHOOK_PAYLOAD_TYPE_MISMATCH', path + ' must be ' + expectedType);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    throw new IntegrationContractError('WEBHOOK_PAYLOAD_ENUM_MISMATCH', path + ' is not an allowed value');
  }

  if (expectedType === 'object') {
    const object = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const keys = Object.keys(object);
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      throw new IntegrationContractError('WEBHOOK_PAYLOAD_TOO_MANY_PROPERTIES', path + ' contains too many properties');
    }
    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(object, required)) {
        throw new IntegrationContractError('WEBHOOK_PAYLOAD_REQUIRED_FIELD_MISSING', path + '.' + required + ' is required');
      }
    }
    for (const key of keys) {
      if (!Object.hasOwn(properties, key)) {
        throw new IntegrationContractError('WEBHOOK_PAYLOAD_UNKNOWN_FIELD', path + '.' + key + ' is not allowed');
      }
      validateNode(object[key], properties[key], path + '.' + key);
    }
  } else if (expectedType === 'array') {
    const array = value as unknown[];
    if (typeof schema.maxItems === 'number' && array.length > schema.maxItems) {
      throw new IntegrationContractError('WEBHOOK_PAYLOAD_TOO_MANY_ITEMS', path + ' contains too many items');
    }
    for (let index = 0; index < array.length; index += 1) {
      validateNode(array[index], schema.items as Record<string, unknown>, path + '[' + index + ']');
    }
  } else if (expectedType === 'string') {
    const stringValue = value as string;
    if (stringValue.length < Number(schema.minLength ?? 0) || stringValue.length > Number(schema.maxLength ?? 10000)) {
      throw new IntegrationContractError('WEBHOOK_PAYLOAD_STRING_LENGTH', path + ' has an invalid string length');
    }
  } else if (expectedType === 'number' || expectedType === 'integer') {
    const numberValue = value as number;
    if ((typeof schema.minimum === 'number' && numberValue < schema.minimum) ||
        (typeof schema.maximum === 'number' && numberValue > schema.maximum)) {
      throw new IntegrationContractError('WEBHOOK_PAYLOAD_NUMBER_RANGE', path + ' is outside the allowed range');
    }
  }
}

export function validateWebhookEnvelope(
  value: unknown,
  expectedSchemaVersion: number,
  payloadSchema: Record<string, unknown>,
): WebhookEnvelope {
  assertPayloadSchema(payloadSchema);
  if (!isRecord(value)) throw new IntegrationContractError('WEBHOOK_ENVELOPE_INVALID', 'Webhook body must be a JSON object');
  const allowedKeys = new Set(['event_type', 'schema_version', 'payload', 'correlation_id']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new IntegrationContractError('WEBHOOK_ENVELOPE_UNKNOWN_FIELD', 'Webhook envelope contains an unsupported field: ' + key);
  }
  if (typeof value.event_type !== 'string' || !EVENT_TYPE.test(value.event_type)) {
    throw new IntegrationContractError('WEBHOOK_EVENT_TYPE_INVALID', 'event_type must be a canonical uppercase event identifier');
  }
  if (!Number.isInteger(value.schema_version) || value.schema_version !== expectedSchemaVersion) {
    throw new IntegrationContractError('WEBHOOK_SCHEMA_VERSION_MISMATCH', 'schema_version does not match the active connector schema');
  }
  if (value.correlation_id !== undefined && (typeof value.correlation_id !== 'string' || !UUID.test(value.correlation_id))) {
    throw new IntegrationContractError('WEBHOOK_CORRELATION_ID_INVALID', 'correlation_id must be a UUID when provided');
  }
  if (!isRecord(value.payload)) {
    throw new IntegrationContractError('WEBHOOK_PAYLOAD_INVALID', 'payload must be a JSON object');
  }
  validateNode(value.payload, payloadSchema, '$.payload');
  return {
    event_type: value.event_type,
    schema_version: value.schema_version as number,
    ...(typeof value.correlation_id === 'string' ? { correlation_id: value.correlation_id } : {}),
    payload: value.payload,
  };
}

export function validateWebhookSecretReference(reference: string): string {
  const match = reference.trim().match(/^env:\/\/(WEBHOOK_SECRET_[A-Z][A-Z0-9_]{0,79})$/);
  if (!match) throw new IntegrationContractError('WEBHOOK_SECRET_REFERENCE_INVALID', 'secret_reference must use env://WEBHOOK_SECRET_<ALIAS>');
  return match[1];
}

export function createWebhookSignature(secret: string, timestamp: string, eventId: string, rawBody: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + eventId + '.')
    .update(rawBody)
    .digest('hex');
}

export function assertValidWebhookSignature(
  secret: string,
  timestampHeader: string,
  eventId: string,
  suppliedSignature: string,
  rawBody: Buffer,
  nowMs = Date.now(),
  toleranceSeconds = 300,
): number {
  if (!/^[0-9]{10}$/.test(timestampHeader)) {
    throw new IntegrationContractError('WEBHOOK_TIMESTAMP_INVALID', 'Webhook timestamp must be Unix seconds');
  }
  const timestampSeconds = Number(timestampHeader);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new IntegrationContractError('WEBHOOK_TIMESTAMP_EXPIRED', 'Webhook signature timestamp is outside the allowed clock-skew window');
  }
  if (!/^sha256=[0-9a-f]{64}$/.test(suppliedSignature)) {
    throw new IntegrationContractError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is malformed');
  }
  const expected = createWebhookSignature(secret, timestampHeader, eventId, rawBody);
  const expectedBytes = Buffer.from(expected, 'ascii');
  const suppliedBytes = Buffer.from(suppliedSignature, 'ascii');
  if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    throw new IntegrationContractError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature verification failed');
  }
  return timestampSeconds;
}

export function stableIntegrationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableIntegrationJson).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map((key) => JSON.stringify(key) + ':' + stableIntegrationJson(object[key])).join(',') + '}';
}

export function integrationRequestHash(value: unknown): string {
  return createHash('sha256').update(stableIntegrationJson(value)).digest('hex');
}
