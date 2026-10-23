import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';

import type { AiAgentStepDefinition } from './ai.agent.types';

export const AI_AGENT_PLANNER_ATTESTATION_SCHEMA =
  'factoryos.ai-agent-planner-attestation/v1';

const MAX_ATTESTATION_LIFETIME_MS = 15 * 60 * 1000;
const MAX_FUTURE_ISSUED_AT_SKEW_MS = 30 * 1000;

export interface AiAgentPlannerAttestationPayload {
  schema_version: string;
  key_id: string;
  provider_id: string;
  provider_version: string;
  planner_version: string;
  context_version: string;
  context_hash: string;
  plan_hash: string;
  goal_hash: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  parent_trace_id: string;
  agent_definition_id: string;
  issued_at: string;
  expires_at: string;
}

export interface AiAgentPlannerAttestationEnvelope {
  payload: AiAgentPlannerAttestationPayload;
  signature: string;
}

export interface AiAgentPlannerAttestationExpected {
  tenantId: string;
  factoryId: string;
  decisionId: string;
  parentTraceId: string;
  agentDefinitionId: string | null;
  goal: string;
  contextVersion: string | null;
  planVersion: string | null;
  contextHash: string | null;
  planHash: string;
}

export interface VerifiedAiAgentPlannerAttestation {
  envelope: AiAgentPlannerAttestationEnvelope;
  payload: AiAgentPlannerAttestationPayload;
  verifiedAt: string;
}

const PAYLOAD_KEYS = [
  'schema_version',
  'attestation_id',
  'key_id',
  'provider_id',
  'provider_version',
  'planner_version',
  'context_version',
  'context_hash',
  'plan_hash',
  'goal_hash',
  'tenant_id',
  'factory_id',
  'decision_id',
  'parent_trace_id',
  'agent_definition_id',
  'issued_at',
  'expires_at',
] as const;

export function canonicalPlannerJson(value: unknown): string {
  const canonicalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(canonicalize);
    if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
      );
    }
    return current;
  };

  return JSON.stringify(canonicalize(value));
}

export function sha256PlannerValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeAiAgentGoalHash(goal: string): string {
  return sha256PlannerValue(goal);
}

/**
 * Hashes the exact normalized step contract written to agent_task_steps.
 * Planner providers must use this same canonical field set and ordering.
 */
export function computeAiAgentPlanHash(steps: AiAgentStepDefinition[]): string {
  const normalized = steps.map((step, index) => ({
    stepKey: step.stepKey.trim(),
    stepIndex: index,
    agentId: step.agentId ?? null,
    capability: step.capability.trim(),
    inputSchema: step.inputSchema ?? {},
    outputSchema: step.outputSchema ?? {},
    toolId: step.toolId.trim(),
    toolVersion: step.toolVersion.trim(),
    actionType: step.actionType.trim(),
    target: step.target ?? {},
    payload: step.payload ?? {},
    resourceType: step.resourceType ?? null,
    resourceId: step.resourceId ?? null,
    riskClass: step.riskClass ?? null,
    timeoutMs: step.timeoutMs ?? 1000,
    retryLimit: step.retryLimit ?? 0,
    authorityLevel: step.authorityLevel?.trim() ?? 'TASK_SCOPED',
    dependsOn: step.dependsOn ?? [],
  }));

  return sha256PlannerValue(canonicalPlannerJson(normalized));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`PLANNER_ATTESTATION_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

/**
 * Verifies an Ed25519 signature from the explicitly trusted planner provider.
 * The public key and key id are deployment configuration; caller-supplied
 * version/hash strings are never trusted without this detached signature.
 */
export function verifyAiAgentPlannerAttestation(
  rawEnvelope: unknown,
  expected: AiAgentPlannerAttestationExpected,
  nowMs = Date.now(),
): VerifiedAiAgentPlannerAttestation {
  if (!isRecord(rawEnvelope)
    || Object.keys(rawEnvelope).sort().join(',') !== 'payload,signature'
    || !isRecord(rawEnvelope.payload)) {
    throw new Error('PLANNER_ATTESTATION_ENVELOPE_INVALID');
  }

  const rawPayload = rawEnvelope.payload;
  if (Object.keys(rawPayload).sort().join(',') !== [...PAYLOAD_KEYS].sort().join(',')) {
    throw new Error('PLANNER_ATTESTATION_PAYLOAD_FIELDS_INVALID');
  }

  const payload = rawPayload as unknown as AiAgentPlannerAttestationPayload;
  for (const key of PAYLOAD_KEYS) requiredString(payload[key], key);
  if (payload.schema_version !== AI_AGENT_PLANNER_ATTESTATION_SCHEMA) {
    throw new Error('PLANNER_ATTESTATION_SCHEMA_UNSUPPORTED');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.attestation_id)) {
    throw new Error('PLANNER_ATTESTATION_ID_INVALID');
  }

  const signature = requiredString(rawEnvelope.signature, 'signature', 256);
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    throw new Error('PLANNER_ATTESTATION_SIGNATURE_ENCODING_INVALID');
  }
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== 64) {
    throw new Error('PLANNER_ATTESTATION_SIGNATURE_LENGTH_INVALID');
  }

  const publicKeyPem = process.env.AI_AGENT_PLANNER_PUBLIC_KEY?.trim();
  const trustedKeyId = process.env.AI_AGENT_PLANNER_KEY_ID?.trim();
  if (!publicKeyPem || !trustedKeyId) {
    throw new Error('TRUSTED_AI_AGENT_PLANNER_KEY_NOT_CONFIGURED');
  }
  if (payload.key_id !== trustedKeyId) {
    throw new Error('PLANNER_ATTESTATION_KEY_ID_NOT_TRUSTED');
  }

  if (!/^[a-f0-9]{64}$/.test(payload.context_hash)
    || !/^[a-f0-9]{64}$/.test(payload.plan_hash)
    || !/^[a-f0-9]{64}$/.test(payload.goal_hash)) {
    throw new Error('PLANNER_ATTESTATION_HASH_INVALID');
  }

  const issuedAtMs = Date.parse(payload.issued_at);
  const expiresAtMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
    || issuedAtMs > nowMs + MAX_FUTURE_ISSUED_AT_SKEW_MS
    || expiresAtMs <= nowMs
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAX_ATTESTATION_LIFETIME_MS) {
    throw new Error('PLANNER_ATTESTATION_TIME_WINDOW_INVALID');
  }

  if (!expected.agentDefinitionId
    || !expected.contextVersion
    || !expected.planVersion
    || !expected.contextHash) {
    throw new Error('PLANNER_ATTESTATION_TASK_PROVENANCE_INCOMPLETE');
  }

  const exactBindings: Array<[unknown, unknown, string]> = [
    [payload.tenant_id, expected.tenantId, 'TENANT_BINDING'],
    [payload.factory_id, expected.factoryId, 'FACTORY_BINDING'],
    [payload.decision_id, expected.decisionId, 'DECISION_BINDING'],
    [payload.parent_trace_id, expected.parentTraceId, 'TRACE_BINDING'],
    [payload.agent_definition_id, expected.agentDefinitionId, 'AGENT_DEFINITION_BINDING'],
    [payload.context_version, expected.contextVersion, 'CONTEXT_VERSION_BINDING'],
    [payload.planner_version, expected.planVersion, 'PLANNER_VERSION_BINDING'],
    [payload.context_hash, expected.contextHash, 'CONTEXT_HASH_BINDING'],
    [payload.plan_hash, expected.planHash, 'PLAN_HASH_BINDING'],
    [payload.goal_hash, computeAiAgentGoalHash(expected.goal), 'GOAL_HASH_BINDING'],
  ];
  for (const [actual, wanted, code] of exactBindings) {
    if (actual !== wanted) throw new Error(`PLANNER_ATTESTATION_${code}_MISMATCH`);
  }

  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalPlannerJson(payload), 'utf8'),
      createPublicKey(publicKeyPem),
      signatureBytes,
    );
  } catch {
    throw new Error('TRUSTED_AI_AGENT_PLANNER_PUBLIC_KEY_INVALID');
  }
  if (!valid) throw new Error('PLANNER_ATTESTATION_SIGNATURE_INVALID');

  return {
    envelope: { payload, signature },
    payload,
    verifiedAt: new Date(nowMs).toISOString(),
  };
}
