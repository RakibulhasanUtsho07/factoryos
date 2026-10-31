import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAdmissionPolicyStatus } from './validate-kubernetes-admission-policy-status.mjs';

const valid = {
  metadata: { name: 'factoryos-test', generation: 2 },
  status: { observedGeneration: 2, typeChecking: {} },
};

test('accepts a completed current-generation CEL type-check with no warnings', () => {
  assert.deepEqual(validateAdmissionPolicyStatus(valid), {
    name: 'factoryos-test', generation: 2, observedGeneration: 2,
    typeChecking: 'PASS', expressionWarnings: 0,
  });
});

test('rejects policy status that has not observed the current generation', () => {
  assert.throws(() => validateAdmissionPolicyStatus({
    ...valid, status: { observedGeneration: 1, typeChecking: {} },
  }), /has not observed its current generation/);
});

test('rejects absent or null type-check status', () => {
  for (const status of [{ observedGeneration: 2 }, { observedGeneration: 2, typeChecking: null }]) {
    assert.throws(() => validateAdmissionPolicyStatus({ ...valid, status }), /status.typeChecking is absent/);
  }
});

test('rejects every CEL type-check warning and includes its field reference', () => {
  assert.throws(() => validateAdmissionPolicyStatus({
    ...valid,
    status: { observedGeneration: 2, typeChecking: {
      expressionWarnings: [{ fieldRef: 'spec.validations[0].expression', warning: "undefined field 'x'" }],
    } },
  }), /spec\.validations\[0\]\.expression: undefined field 'x'/);
});

test('rejects malformed warning payloads', () => {
  assert.throws(() => validateAdmissionPolicyStatus({
    ...valid, status: { observedGeneration: 2, typeChecking: { expressionWarnings: {} } },
  }), /malformed typeChecking.expressionWarnings/);
});
