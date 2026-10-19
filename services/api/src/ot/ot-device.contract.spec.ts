import {
  canonicalOtJson,
  classifyOtSequence,
  hashOtValue,
  normalizeOtObject,
} from './ot-device.contract';

describe('OT telemetry contract', () => {
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
