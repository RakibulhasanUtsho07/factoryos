import {
  canonicalOtJson,
  classifyOtSequence,
  hashOtValue,
  normalizeOtObject,
  getAllowedOpcUaNodeIds,
  validateOpcUaNodeId,
} from './ot-device.contract';
import { decodeModbusRegisters, getModbusTcpProfile, getMqttProfile, normalizeMqttTelemetryMessage } from './ot-protocol.contract';

describe('OT telemetry contract', () => {
  it('validates exact MQTT topics and normalized QoS 1 messages', () => {
    const metadata = { mqtt: { allowed_topics: ['factory/line-1/telemetry'], qos: 1 } };
    expect(getMqttProfile(metadata)).toEqual({ allowed_topics: ['factory/line-1/telemetry'], qos: 1 });
    const event = normalizeMqttTelemetryMessage('factory/line-1/telemetry', Buffer.from(JSON.stringify({
      source_event_id: 'mqtt:event-1', event_type: 'TEMPERATURE', stream_key: 'LINE-1',
      source_sequence: 1, observed_at: '2026-10-20T10:00:00Z', payload: { temperature: 24.5 },
    })), metadata, new Date('2026-10-20T10:00:01Z'));
    expect(event).toMatchObject({ source_event_id: 'mqtt:event-1', event_type: 'TEMPERATURE', payload: { temperature: 24.5 } });
    expect(() => getMqttProfile({ mqtt: { allowed_topics: ['factory/#'], qos: 1 } })).toThrow(/exact/);
    expect(() => getMqttProfile({ mqtt: { allowed_topics: ['factory/t'], qos: 0 } })).toThrow(/QoS 1/);
    expect(() => normalizeMqttTelemetryMessage('factory/foreign', Buffer.from('{}'), metadata)).toThrow(/outside/);
  });

  it('validates bounded Modbus register maps and decodes signed and floating values', () => {
    const profile = getModbusTcpProfile({ modbus_tcp: {
      unit_id: 7,
      register_map: [
        { stream_key: 'LINE_TEMPERATURE', function_code: 4, address: 10, quantity: 2, data_type: 'FLOAT32', word_order: 'ABCD' },
        { stream_key: 'MOTOR_SPEED', function_code: 3, address: 20, quantity: 1, data_type: 'INT16' },
      ],
    }});
    expect(profile.unit_id).toBe(7);
    expect(decodeModbusRegisters([0x4120, 0], 'FLOAT32')).toBe(10);
    expect(decodeModbusRegisters([0xffff], 'INT16')).toBe(-1);
    expect(decodeModbusRegisters([0x1234, 0x5678], 'UINT32', 'CDAB')).toBe(0x56781234);
    expect(() => getModbusTcpProfile({ modbus_tcp: { unit_id: 0, register_map: [{ stream_key: 'A', function_code: 3, address: 1, quantity: 1, data_type: 'UINT16' }] } })).toThrow(/unit_id/);
    expect(() => getModbusTcpProfile({ modbus_tcp: { unit_id: 1, register_map: [{ stream_key: 'A', function_code: 6, address: 1, quantity: 1, data_type: 'UINT16' }] } })).toThrow(/Only Modbus/);
  });
  it('requires a small unique OPC UA NodeId allowlist on registrations', () => {
    expect(getAllowedOpcUaNodeIds({
      opcua: { allowed_node_ids: ['ns=2;s=Machine.Temperature', 'ns=2;i=101'] },
    })).toEqual(['ns=2;s=Machine.Temperature', 'ns=2;i=101']);
    expect(() => getAllowedOpcUaNodeIds({})).toThrow(/allowed_node_ids/);
    expect(() => getAllowedOpcUaNodeIds({ opcua: { allowed_node_ids: [] } })).toThrow(/between 1 and 20/);
    expect(() => getAllowedOpcUaNodeIds({ opcua: { allowed_node_ids: ['ns=2;s=ok', 'ns=2;s=ok'] } })).toThrow(/duplicate/);
  });

  it.each(['opc.tcp://host:4840', 'ns=1;s=bad;write', 'ns=50000;i=2', 'ns=1;i=-1'])(
    'rejects an unsupported OPC UA NodeId form: %s',
    (value) => expect(() => validateOpcUaNodeId(value)).toThrow(/NodeId/),
  );
  it('creates stable fingerprints regardless of object key order', () => {
    expect(canonicalOtJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashOtValue({ b: 2, a: 1 })).toBe(hashOtValue({ a: 1, b: 2 }));
    expect(hashOtValue([1, 2])).not.toBe(hashOtValue([2, 1]));
  });

  it('allows normalized industrial readings and bounded metadata', () => {
    expect(normalizeOtObject({ temperature: 24.5, state: 'RUNNING' })).toEqual({
      temperature: 24.5,
      state: 'RUNNING',
    });
  });

  it.each([
    { password: 'do-not-store' },
    { nested: { api_key: 'do-not-store' } },
    { authorization: { bearer: 'do-not-store' } },
  ])('rejects credential-like payload fields', (payload) => {
    expect(() => normalizeOtObject(payload)).toThrow(/credential-like/);
  });

  it('rejects excessive nesting and non-finite numeric values', () => {
    let tooDeep: unknown = { leaf: 1 };
    for (let depth = 0; depth < 9; depth += 1) {
      tooDeep = { nested: tooDeep };
    }
    expect(() => normalizeOtObject(tooDeep)).toThrow(/nesting depth/);
    expect(() => normalizeOtObject({ temperature: Number.POSITIVE_INFINITY })).toThrow(/finite number/);
  });

  it.each([
    [null, 10, 'ON_TIME'],
    [10, 11, 'ON_TIME'],
    [10, 12, 'SEQUENCE_GAP'],
    [10, 9, 'LATE'],
    [10, null, 'ON_TIME'],
  ] as const)('classifies reconnect/replay sequence (%s -> %s)', (last, incoming, expected) => {
    expect(classifyOtSequence(last, incoming)).toBe(expected);
  });
});
