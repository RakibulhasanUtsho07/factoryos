import { generateKeyPairSync, sign } from 'node:crypto';
import { jest } from '@jest/globals';

import type { AiAgentStepDefinition } from './ai.agent.types';
import {
  AI_AGENT_PLANNER_ATTESTATION_SCHEMA,
  canonicalPlannerJson,
  computeAiAgentGoalHash,
  computeAiAgentPlanHash,
  sha256PlannerValue,
  verifyAiAgentPlannerAttestation,
} from './ai.agent.planner-attestation';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const decisionId = '6f1a3333-3333-4333-8333-333333333333';
const parentTraceId = '6f1a2222-2222-4222-8222-222222222222';
const agentDefinitionId = '7f1a2222-2222-4222-8222-222222222222';
const planVersion = 'planner-provider-v4';
const contextVersion = 'context-snapshot-v2';
const contextHash = 'a'.repeat(64);
const goal = 'Create approved order';
const steps: AiAgentStepDefinition[] = [{
  stepKey: 'create-order',
  capability: 'create approved order',
  agentId: 'AGENT.ORDERS',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  toolId: 'ORDERS.CREATE',
  toolVersion: '2.1.0',
  actionType: 'ORDERS.CREATE',
  target: { kind: 'order' },
  payload: { sku: 'SKU-1', quantity: 2 },
  resourceType: 'ORDER',
  resourceId: 'candidate-order',
  riskClass: 'L3',
  timeoutMs: 1000,
  retryLimit: 0,
  authorityLevel: 'TASK_SCOPED',
  dependsOn: [],
}];

function makeSignedAttestation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = {
    schema_version: AI_AGENT_PLANNER_ATTESTATION_SCHEMA,
    attestation_id: '12345678-1234-4234-8234-123456789abc',
    key_id: 'planner-key-2026-01',
    provider_id: 'factoryos-trusted-planner',
    provider_version: '1.4.2',
    planner_version: planVersion,
    context_version: contextVersion,
    context_hash: contextHash,
    plan_hash: computeAiAgentPlanHash(steps),
    goal_hash: computeAiAgentGoalHash(goal),
    tenant_id: tenantId,
    factory_id: factoryId,
    decision_id: decisionId,
    parent_trace_id: parentTraceId,
    agent_definition_id: agentDefinitionId,
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalPlannerJson(payload), 'utf8'), privateKey).toString('base64url');
  return {
    envelope: { payload, signature },
    publicKeyPem,
    expected: {
      tenantId, factoryId, decisionId, parentTraceId, agentDefinitionId,
      goal, contextVersion, planVersion, contextHash, planHash: computeAiAgentPlanHash(steps),
    },
  };
}

describe('AI agent planner attestation', () => {
  const originalPublicKey = process.env.AI_AGENT_PLANNER_PUBLIC_KEY;
  const originalKeyId = process.env.AI_AGENT_PLANNER_KEY_ID;

  afterEach(() => {
    if (originalPublicKey === undefined) delete process.env.AI_AGENT_PLANNER_PUBLIC_KEY;
    else process.env.AI_AGENT_PLANNER_PUBLIC_KEY = originalPublicKey;
    if (originalKeyId === undefined) delete process.env.AI_AGENT_PLANNER_KEY_ID;
    else process.env.AI_AGENT_PLANNER_KEY_ID = originalKeyId;
    jest.restoreAllMocks();
  });

  it('verifies the trusted provider signature and exact plan/scope/context bindings', () => {
    const fixture = makeSignedAttestation();
    process.env.AI_AGENT_PLANNER_PUBLIC_KEY = fixture.publicKeyPem;
    process.env.AI_AGENT_PLANNER_KEY_ID = 'planner-key-2026-01';

    const verified = verifyAiAgentPlannerAttestation(fixture.envelope, fixture.expected);
    expect(verified.payload.provider_id).toBe('factoryos-trusted-planner');
    expect(verified.payload.plan_hash).toBe(fixture.expected.planHash);
    expect(verified.verifiedAt).toEqual(expect.any(String));
  });

  it('rejects unsigned caller metadata when no trusted public key is configured', () => {
    const fixture = makeSignedAttestation();
    delete process.env.AI_AGENT_PLANNER_PUBLIC_KEY;
    delete process.env.AI_AGENT_PLANNER_KEY_ID;

    expect(() => verifyAiAgentPlannerAttestation(fixture.envelope, fixture.expected))
      .toThrow('TRUSTED_AI_AGENT_PLANNER_KEY_NOT_CONFIGURED');
  });

  it('rejects tampered plan/context/goal bindings even when the original signature is kept', () => {
    const fixture = makeSignedAttestation();
    process.env.AI_AGENT_PLANNER_PUBLIC_KEY = fixture.publicKeyPem;
    process.env.AI_AGENT_PLANNER_KEY_ID = 'planner-key-2026-01';

    const tampered = {
      ...fixture.envelope,
      payload: { ...fixture.envelope.payload, plan_hash: 'f'.repeat(64) },
    };
    expect(() => verifyAiAgentPlannerAttestation(tampered, fixture.expected))
      .toThrow('PLANNER_ATTESTATION_PLAN_HASH_BINDING_MISMATCH');
    expect(() => verifyAiAgentPlannerAttestation(fixture.envelope, {
      ...fixture.expected,
      contextHash: 'b'.repeat(64),
    })).toThrow('PLANNER_ATTESTATION_CONTEXT_HASH_BINDING_MISMATCH');
    expect(() => verifyAiAgentPlannerAttestation(fixture.envelope, {
      ...fixture.expected,
      goal: 'Different goal',
    })).toThrow('PLANNER_ATTESTATION_GOAL_HASH_BINDING_MISMATCH');
  });

  it('rejects malformed attestation UUIDs before accepting a signature', () => {
    const fixture = makeSignedAttestation({ attestation_id: 'not-a-uuid' });
    process.env.AI_AGENT_PLANNER_PUBLIC_KEY = fixture.publicKeyPem;
    process.env.AI_AGENT_PLANNER_KEY_ID = 'planner-key-2026-01';
    expect(() => verifyAiAgentPlannerAttestation(fixture.envelope, fixture.expected))
      .toThrow('PLANNER_ATTESTATION_ID_INVALID');
  });

  it('rejects expired, overlong and untrusted-key attestations', () => {
    const fixture = makeSignedAttestation({
      issued_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 1).toISOString(),
    });
    process.env.AI_AGENT_PLANNER_PUBLIC_KEY = fixture.publicKeyPem;
    process.env.AI_AGENT_PLANNER_KEY_ID = 'different-key-id';

    expect(() => verifyAiAgentPlannerAttestation(fixture.envelope, fixture.expected))
      .toThrow('PLANNER_ATTESTATION_KEY_ID_NOT_TRUSTED');
    process.env.AI_AGENT_PLANNER_KEY_ID = 'planner-key-2026-01';
    expect(() => verifyAiAgentPlannerAttestation(fixture.envelope, fixture.expected))
      .toThrow('PLANNER_ATTESTATION_TIME_WINDOW_INVALID');
  });

  it('canonicalizes object key order before signing and hashing', () => {
    expect(canonicalPlannerJson({ b: 2, a: { z: 1, c: 3 } }))
      .toBe(canonicalPlannerJson({ a: { c: 3, z: 1 }, b: 2 }));
    expect(sha256PlannerValue('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});
