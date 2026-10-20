import {
  canonicalOtJson,
  classifyOtSequence,
  hashOtValue,
  normalizeOtObject,
  getAllowedOpcUaNodeIds,
  validateOpcUaNodeId,
} from './ot-device.contract';

describe('OT telemetry contract', () => {
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
