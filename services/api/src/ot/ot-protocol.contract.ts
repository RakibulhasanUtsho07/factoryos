import { normalizeOtObject } from './ot-device.contract';

export type MqttProfile = {
  allowed_topics: string[];
  qos: 1;
};

export type ModbusFunctionCode = 3 | 4;
export type ModbusDataType = 'UINT16' | 'INT16' | 'UINT32' | 'INT32' | 'FLOAT32';
export type ModbusWordOrder = 'ABCD' | 'CDAB';

export interface ModbusRegisterDefinition {
  stream_key: string;
  function_code: ModbusFunctionCode;
  address: number;
  quantity: number;
  data_type: ModbusDataType;
  word_order: ModbusWordOrder;
}

export interface ModbusTcpProfile {
  unit_id: number;
  register_map: ModbusRegisterDefinition[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact topics only: wildcard subscriptions are intentionally out of scope for this slice. */
export function getMqttProfile(metadata: Record<string, unknown>): MqttProfile {
  const raw = metadata['mqtt'];
  if (!record(raw)) throw new Error('metadata.mqtt is required for MQTT devices');
  const topics = raw['allowed_topics'];
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 20) {
    throw new Error('metadata.mqtt.allowed_topics must contain between 1 and 20 topics');
  }
  const allowedTopics = topics.map((topic) => {
    if (typeof topic !== 'string' || topic.length < 1 || topic.length > 256
      || !/^[A-Za-z0-9_./:-]+$/.test(topic) || topic.includes('..') || topic.startsWith('$SYS/')) {
      throw new Error('MQTT topics must be bounded, exact and exclude wildcard/system topics');
    }
    return topic;
  });
  if (new Set(allowedTopics).size !== allowedTopics.length) {
    throw new Error('MQTT allowed_topics must not contain duplicates');
  }
  if (raw['qos'] !== 1) {
    throw new Error('MQTT ingestion requires QoS 1 for durable broker acknowledgement');
  }
  return { allowed_topics: allowedTopics, qos: 1 };
}

/** Decode an authenticated MQTT message whose payload is the normalized OT envelope. */
export function normalizeMqttTelemetryMessage(
  topic: unknown,
  bytes: Uint8Array,
  metadata: Record<string, unknown>,
  receivedAt: Date = new Date(),
) {
  const profile = getMqttProfile(metadata);
  if (typeof topic !== 'string' || !profile.allowed_topics.includes(topic)) {
    throw new Error('MQTT message topic is outside the registered exact-topic allowlist');
  }
  if (bytes.byteLength < 1 || bytes.byteLength > 4096) {
    throw new Error('MQTT payload must contain between 1 and 4096 bytes');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('MQTT payload must be valid UTF-8 JSON');
  }
  if (!record(decoded)) throw new Error('MQTT payload must be a normalized event object');
  const eventType = decoded['event_type'];
  const streamKey = decoded['stream_key'];
  const sourceEventId = decoded['source_event_id'];
  const observedAt = decoded['observed_at'];
  if (typeof eventType !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,99}$/.test(eventType)) {
    throw new Error('MQTT event_type is invalid');
  }
  if (typeof streamKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(streamKey)) {
    throw new Error('MQTT stream_key is invalid');
  }
  if (typeof sourceEventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sourceEventId)) {
    throw new Error('MQTT source_event_id is required for idempotent replay');
  }
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error('MQTT observed_at must be a valid timestamp');
  }
  const sourceSequence = decoded['source_sequence'] ?? null;
  if (sourceSequence !== null && (!Number.isSafeInteger(sourceSequence) || Number(sourceSequence) < 1)) {
    throw new Error('MQTT source_sequence must be a safe positive integer');
  }
  const normalized = normalizeOtObject(decoded['payload'], 'MQTT telemetry payload');
  return {
    source_event_id: sourceEventId,
    event_type: eventType,
    stream_key: streamKey,
    source_sequence: sourceSequence as number | null,
    observed_at: new Date(observedAt).toISOString(),
    payload: normalized,
    received_at: receivedAt.toISOString(),
  };
}

export function getModbusTcpProfile(metadata: Record<string, unknown>): ModbusTcpProfile {
  const raw = metadata['modbus_tcp'];
  if (!record(raw)) throw new Error('metadata.modbus_tcp is required for Modbus TCP devices');
  const unitId = raw['unit_id'];
  if (!Number.isInteger(unitId) || Number(unitId) < 1 || Number(unitId) > 247) {
    throw new Error('Modbus unit_id must be an integer from 1 to 247; broadcast reads are not permitted');
  }
  const rawMap = raw['register_map'];
  if (!Array.isArray(rawMap) || rawMap.length < 1 || rawMap.length > 20) {
    throw new Error('metadata.modbus_tcp.register_map must contain between 1 and 20 definitions');
  }
  const registerMap: ModbusRegisterDefinition[] = rawMap.map((item) => {
    if (!record(item)) throw new Error('Modbus register definitions must be objects');
    const streamKey = item['stream_key'];
    const functionCode = item['function_code'];
    const address = item['address'];
    const quantity = item['quantity'];
    const dataType = item['data_type'];
    const wordOrder = item['word_order'] ?? 'ABCD';
    if (typeof streamKey !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,159}$/.test(streamKey)) {
      throw new Error('Modbus stream_key is invalid');
    }
    if (functionCode !== 3 && functionCode !== 4) {
      throw new Error('Only Modbus holding/input register reads (function 3 or 4) are allowed');
    }
    if (!Number.isInteger(address) || Number(address) < 0 || Number(address) > 65535) {
      throw new Error('Modbus register address must be an integer from 0 to 65535');
    }
    if (!Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 125) {
      throw new Error('Modbus register quantity must be an integer from 1 to 125');
    }
    if (!['UINT16', 'INT16', 'UINT32', 'INT32', 'FLOAT32'].includes(String(dataType))) {
      throw new Error('Unsupported Modbus data_type');
    }
    const expected = dataType === 'UINT16' || dataType === 'INT16' ? 1 : 2;
    if (quantity !== expected || Number(address) + Number(quantity) > 65536) {
      throw new Error('Modbus quantity must exactly match the selected data type and address range');
    }
    if (wordOrder !== 'ABCD' && wordOrder !== 'CDAB') {
      throw new Error('Modbus word_order must be ABCD or CDAB');
    }
    return {
      stream_key: streamKey,
      function_code: functionCode,
      address: Number(address),
      quantity: Number(quantity),
      data_type: dataType as ModbusDataType,
      word_order: wordOrder,
    };
  });
  if (new Set(registerMap.map((item) => item.stream_key)).size !== registerMap.length) {
    throw new Error('Modbus register stream_key values must be unique');
  }
  for (let i = 0; i < registerMap.length; i += 1) {
    const current = registerMap[i]!;
    for (let j = i + 1; j < registerMap.length; j += 1) {
      const next = registerMap[j]!;
      const overlaps = current.function_code === next.function_code
        && current.address < next.address + next.quantity
        && next.address < current.address + current.quantity;
      if (overlaps) throw new Error('Modbus register map ranges must not overlap for the same function code');
    }
  }
  return { unit_id: Number(unitId), register_map: registerMap };
}

export function decodeModbusRegisters(
  words: number[],
  dataType: ModbusDataType,
  wordOrder: ModbusWordOrder = 'ABCD',
): number {
  const is16Bit = dataType === 'UINT16' || dataType === 'INT16';
  const expectedWords = is16Bit ? 1 : 2;
  if (!Array.isArray(words) || words.length !== expectedWords
    || words.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)) {
    throw new Error('Modbus response register words do not match the configured data type');
  }
  if (is16Bit) {
    const word = words[0]!;
    if (dataType === 'UINT16') return word;
    return word >= 0x8000 ? word - 0x10000 : word;
  }
  const ordered = wordOrder === 'ABCD' ? words : [words[1]!, words[0]!];
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16BE(ordered[0]!, 0);
  bytes.writeUInt16BE(ordered[1]!, 2);
  if (dataType === 'UINT32') return bytes.readUInt32BE(0);
  if (dataType === 'INT32') return bytes.readInt32BE(0);
  const result = bytes.readFloatBE(0);
  if (!Number.isFinite(result)) throw new Error('Modbus FLOAT32 value must be finite');
  return result;
}
