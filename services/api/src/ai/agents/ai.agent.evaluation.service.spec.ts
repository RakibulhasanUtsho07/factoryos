import { jest } from '@jest/globals';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, NotFoundException,
} from '@nestjs/common';

import { AiAgentEvaluationService } from './ai.agent.evaluation.service';
import {
  AI_AGENT_PLANNER_ATTESTATION_SCHEMA,
  canonicalPlannerJson,
  computeAiAgentGoalHash,
} from './ai.agent.planner-attestation';

const tenantId = '11111111-1111-4111-8111-111111111111';
const factoryId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const caseId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';
const sandboxId = '77777777-7777-4777-8777-777777777777';
const database = { query: jest.fn<() => Promise<unknown>>() };
const iamService = { authorize: jest.fn<() => Promise<void>>() };
const auditService = { record: jest.fn<() => Promise<string>>() };

const caseRow = {
  id: caseId, tenant_id: tenantId, factory_id: factoryId, agent_definition_id: definitionId,
  agent_id: 'AGENT.TEST', agent_version: '1.0.0', case_key: 'calls-noop', case_version: 1,
  name: 'Calls noop', description: null, kind: 'EXPECTED_TOOL_CALL',
  expected_tool_id: 'AI.RUNTIME.NOOP', expected_tool_version: '1.0.0',
  expected_action_type: 'AI.RUNTIME.NOOP', expected_input_subset: { orderId: 'ORD-1' },
  expected_refusal_reason_contains: null, status: 'ACTIVE', created_by: userId,
  created_at: '2026-10-11T00:00:00.000Z',
};
function simulationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: runId, sandbox_id: sandboxId, status: 'COMPLETED',
    plan: [{ toolId: 'AI.RUNTIME.NOOP', toolVersion: '1.0.0',
      actionType: 'AI.RUNTIME.NOOP', input: { orderId: 'ORD-1', harmless: true } }],
    simulated_tool_responses: { 'AI.RUNTIME.NOOP@1.0.0': { ok: true } },
    observations: [{ stepIndex: 0, responseProvided: true }],
    result: { outcome: 'SIMULATION_COMPLETE' }, sandbox_agent_id: 'AGENT.TEST',
    sandbox_agent_version: '1.0.0', sandbox_mode: 'SIMULATION', live_write_allowed: false,
    created_at: '2026-10-11T00:01:00.000Z', ...overrides,
  };
}
function resultRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '88888888-8888-4888-8888-888888888888', tenant_id: tenantId, factory_id: factoryId,
    case_id: caseId, simulation_run_id: runId, sandbox_id: sandboxId, status: 'PASS',
    expected_summary: { caseKey: 'calls-noop' },
    observed_summary: {
      evidenceSource: 'SYNTHETIC_SANDBOX_PLAN_AND_SUPPLIED_RESPONSE',
      executionEvidence: 'SIMULATION_ONLY_NO_AGENT_OR_TOOL_EXECUTION',
      liveExecution: false,
      matchingPlanCallCount: 1,
      observedCallCount: 1,
      matchingStepIndices: [0],
      completedObservations: 1,
    },
    created_by: userId, created_at: '2026-10-11T00:02:00.000Z', ...overrides,
  };
}

const liveTaskId = '99999999-9999-4999-8999-999999999999';
const liveDecisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const liveTraceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const liveStepId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const liveActionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const liveExecutionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const liveExecutionKey = 'agent:live-test:step:execution:1';
const liveGoal = 'Run live planner attestation test';
const livePlanHash = 'c'.repeat(64);
const plannerSigningKeys = generateKeyPairSync('ed25519');
const plannerPublicKeyPem = plannerSigningKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const originalPlannerPublicKey = process.env.AI_AGENT_PLANNER_PUBLIC_KEY;
const originalPlannerKeyId = process.env.AI_AGENT_PLANNER_KEY_ID;

function makeLivePlannerAttestation() {
  const now = Date.now();
  const payload = {
    schema_version: AI_AGENT_PLANNER_ATTESTATION_SCHEMA,
    attestation_id: '12345678-1234-4234-8234-123456789abc',
    key_id: 'evaluation-test-planner-key',
    provider_id: 'trusted-planner-fixture',
    provider_version: '1.0.0',
    planner_version: 'planner-v4',
    context_version: 'context-v3',
    context_hash: 'a'.repeat(64),
    plan_hash: livePlanHash,
    goal_hash: computeAiAgentGoalHash(liveGoal),
    tenant_id: tenantId,
    factory_id: factoryId,
    decision_id: liveDecisionId,
    parent_trace_id: liveTraceId,
    agent_definition_id: definitionId,
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
  };
  return {
    payload,
    signature: sign(null, Buffer.from(canonicalPlannerJson(payload), 'utf8'), plannerSigningKeys.privateKey).toString('base64url'),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue(record[key])]));
  }
  return value;
}
function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value)), 'utf8').digest('hex');
}
function liveTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: liveTaskId, tenant_id: tenantId, factory_id: factoryId,
    agent_definition_id: definitionId, decision_id: liveDecisionId, parent_trace_id: liveTraceId,
    goal: liveGoal, state: 'COMPLETED', plan_version: 'planner-v4',
    context_version: 'context-v3', context_hash: 'a'.repeat(64),
    plan_hash: livePlanHash, planner_attestation: makeLivePlannerAttestation(),
    planner_attestation_verified_at: new Date().toISOString(), planner_attestation_valid: true,
    request_hash: 'b'.repeat(64), cancel_requested_at: null,
    deadline_at: '2026-10-12T00:00:00.000Z', ...overrides,
  };
}
function liveTraceRow(overrides: Record<string, unknown> = {}) {
  const payload = { orderId: 'ORD-1', harmless: true };
  const payloadHash = canonicalHash(payload);
  const executionResult = { accepted: true, output_ref: 'order:ORD-1' };
  const executionError = {};
  const outcomeHash = canonicalHash({ status: 'SUCCEEDED', result: executionResult, error: executionError });
  const evidence = {
    schemaVersion: 1, executionKind: 'STEP', taskId: liveTaskId, stepId: liveStepId,
    decisionId: liveDecisionId, parentTraceId: liveTraceId, actionIntentId: liveActionId,
    executionRecordId: liveExecutionId, executionKey: liveExecutionKey, toolId: 'AI.RUNTIME.NOOP',
    toolVersion: '1.0.0', executorType: 'AGENT_RUNTIME', inputsHash: payloadHash,
    outcomeStatus: 'SUCCEEDED', outcomeHash,
  };
  return {
    step_id: liveStepId, step_index: 0, agent_id: 'AGENT.TEST', tool_id: 'AI.RUNTIME.NOOP',
    tool_version: '1.0.0', action_type: 'AI.RUNTIME.NOOP', target: {}, payload,
    step_status: 'SUCCEEDED', step_error: {}, step_output: executionResult,
    step_resource_type: null, step_resource_id: null,
    step_action_intent_id: liveActionId, step_execution_record_id: liveExecutionId,
    execution_evidence: evidence,
    action_intent_id: liveActionId, authorization_status: 'AUTHORIZED', action_decision_id: liveDecisionId,
    action_tool_id: 'AI.RUNTIME.NOOP', action_tool_version: '1.0.0', action_action_type: 'AI.RUNTIME.NOOP',
    action_target: {}, action_payload: payload, action_payload_hash: payloadHash,
    action_resource_type: null, action_resource_id: null, action_authorization: { status: 'AUTHORIZED', approvalChecked: true },
    execution_id: liveExecutionId, execution_decision_id: liveDecisionId,
    execution_action_intent_id: liveActionId, execution_key: liveExecutionKey, executor_type: 'AGENT_RUNTIME',
    execution_tool_version: '1.0.0', execution_inputs_hash: payloadHash, execution_status: 'SUCCEEDED',
    execution_result: executionResult, execution_error: executionError,
    execution_finished_at: '2026-10-11T00:02:00.000Z',
    step_finished_at: '2026-10-11T00:02:00.000Z',
    claim_status: 'COMPLETED', reconciliation_decision: null,
    source_tool_rollback: { type: 'NONE' }, source_tool_write_capable: false, compensation_trace: [], ...overrides,
  };
}
function liveEvaluationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', tenant_id: tenantId, factory_id: factoryId,
    case_id: caseId, agent_task_id: liveTaskId, status: 'PASS',
    expected_summary: { caseKey: 'calls-noop', kind: 'EXPECTED_TOOL_CALL' },
    observed_summary: { evidenceSource: 'LIVE_AGENT_TASK_TRACE', liveExecution: true, rawPayloadsReturned: false },
    created_by: userId, created_at: '2026-10-11T00:03:00.000Z', ...overrides,
  };
}

function makeService() {
  return new AiAgentEvaluationService(database as never, iamService as never, auditService as never);
}
describe('AiAgentEvaluationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_AGENT_PLANNER_PUBLIC_KEY = plannerPublicKeyPem;
    process.env.AI_AGENT_PLANNER_KEY_ID = 'evaluation-test-planner-key';
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
  });

  afterEach(() => {
    if (originalPlannerPublicKey === undefined) delete process.env.AI_AGENT_PLANNER_PUBLIC_KEY;
    else process.env.AI_AGENT_PLANNER_PUBLIC_KEY = originalPlannerPublicKey;
    if (originalPlannerKeyId === undefined) delete process.env.AI_AGENT_PLANNER_KEY_ID;
    else process.env.AI_AGENT_PLANNER_KEY_ID = originalPlannerKeyId;
  });


  it('creates versioned expected-call cases and records audit metadata', async () => {
    const created = {
      ...caseRow,
      agent_id: 'AGENT.TEST',
      agent_version: '1.0.0',
    };
    database.query.mockResolvedValueOnce({ rows: [{ id: definitionId, agent_id: 'AGENT.TEST', version: '1.0.0', status: 'DRAFT' }] })
      .mockResolvedValueOnce({ rows: [created] });

    const result = await makeService().createCase(tenantId, factoryId, userId, definitionId, {
      caseKey: 'calls-noop', version: 1, name: 'Calls noop', kind: 'EXPECTED_TOOL_CALL',
      expectedToolId: 'AI.RUNTIME.NOOP', expectedToolVersion: '1.0.0',
      expectedActionType: 'AI.RUNTIME.NOOP', expectedInputSubset: { orderId: 'ORD-1' },
    });

    expect(result.caseKey).toBe('calls-noop');
    expect(result.kind).toBe('EXPECTED_TOOL_CALL');
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CREATE_EVALUATION_CASE',
      resourceType: 'AI_AGENT_EVALUATION_CASE',
    }));
  });

  it('aggregates per-agent reports without exposing raw simulation payloads', async () => {
    database.query.mockResolvedValueOnce({
      rows: [{ id: definitionId, agent_id: 'AGENT.TEST', version: '1.0.0', status: 'DRAFT' }],
    }).mockResolvedValueOnce({
      rows: [{
        case_id: caseId, case_key: 'calls-noop', case_version: 1,
        name: 'Calls noop', kind: 'EXPECTED_TOOL_CALL', case_status: 'ACTIVE',
        evaluation_count: '3', pass_count: '2', fail_count: '1',
        inconclusive_count: '0', latest_status: 'PASS',
        last_evaluated_at: '2026-10-11T00:02:00.000Z',
      }],
    });

    const report = await makeService().getReport(tenantId, factoryId, userId, definitionId);

    expect(report.summary).toMatchObject({
      caseCount: 1, evaluationCount: 3, passCount: 2, failCount: 1,
      inconclusiveCount: 0, passRatePercent: 66.67,
    });
    expect(report.cases[0]).toMatchObject({ caseKey: 'calls-noop', latestStatus: 'PASS' });
    expect(report.cases[0]).not.toHaveProperty('rawSimulationResult');
  });

  it('evaluates expected tool calls against a scoped simulation run', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resultRow()] });
    const result = await makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId);
    expect(result.status).toBe('PASS');
    expect(result.observedSummary).toMatchObject({
      observedCallCount: 1,
      matchingPlanCallCount: 1,
      matchingStepIndices: [0],
      evidenceSource: 'SYNTHETIC_SANDBOX_PLAN_AND_SUPPLIED_RESPONSE',
      executionEvidence: 'SIMULATION_ONLY_NO_AGENT_OR_TOOL_EXECUTION',
      liveExecution: false,
    });
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'EVALUATE_AGENT_CASE', resourceType: 'AI_AGENT_EVALUATION_RESULT',
    }));
  });


  it('replays the stored evaluation when concurrent requests race to persist the same case/run result', async () => {
    const persisted = resultRow({
      id: '99999999-9999-4999-8999-999999999999',
      status: 'FAIL',
      observed_summary: { statusAtFirstEvaluation: 'FAIL' },
    });
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [persisted] });

    const result = await makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId);

    expect(result.id).toBe(persisted.id);
    expect(result.status).toBe('FAIL');
    expect(result.observedSummary).toEqual(persisted.observed_summary);
    expect(database.query).toHaveBeenCalledTimes(5);
    const queryCalls = (database.query as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(queryCalls[3]?.[0])).toContain(
      'ON CONFLICT (case_id, simulation_run_id) DO NOTHING',
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('fails closed when a concurrent evaluation conflict cannot be read back', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('does not pass a plan-only tool call when response-backed observation evidence is missing', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow({ observations: [] })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resultRow({
        status: 'INCONCLUSIVE',
        observed_summary: {
          matchingPlanCallCount: 1,
          observedCallCount: 0,
          reason: 'No response-backed observation',
        },
      })] });
    const result = await makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId);
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('fails a completed run when an expected call was omitted', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow({ plan: [] })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resultRow({ status: 'FAIL', observed_summary: { observedCallCount: 0 } })] });
    const result = await makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId);
    expect(result.status).toBe('FAIL');
  });

  it('marks an incomplete run inconclusive instead of passing an expected call', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow({ status: 'BLOCKED' })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [resultRow({ status: 'INCONCLUSIVE' })] });
    const result = await makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId);
    expect(result.status).toBe('INCONCLUSIVE');
  });

  it('refuses to assess simulation runs belonging to another agent version', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [simulationRow({ sandbox_agent_version: '9.9.9' })] });
    await expect(makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('validates red-team and compensation evaluation-case contracts', () => {
    const service = makeService();
    expect((service as any).normalizeCase({
      caseKey: 'red-team-policy-bypass', version: 1, name: 'Prompt-injection write refusal',
      kind: 'RED_TEAM_POLICY_BYPASS', expectedToolId: 'ORDERS.CREATE',
      expectedToolVersion: '1.0.0', expectedRefusalReasonContains: 'policy',
    }).kind).toBe('RED_TEAM_POLICY_BYPASS');
    expect((service as any).normalizeCase({
      caseKey: 'compensates-order', version: 1, name: 'Order compensation',
      kind: 'EXPECTED_COMPENSATION', expectedToolId: 'ORDERS.COMPENSATE',
      expectedToolVersion: '1.0.0', expectedActionType: 'ORDERS.COMPENSATE',
      expectedInputSubset: { orderId: 'ORD-1' },
    }).kind).toBe('EXPECTED_COMPENSATION');
    expect(() => (service as any).normalizeCase({
      caseKey: 'red-team-no-tool', version: 1, name: 'Missing forbidden tool',
      kind: 'RED_TEAM_POLICY_BYPASS', expectedRefusalReasonContains: 'policy',
    })).toThrow(BadRequestException);
  });

  it('validates expected-refusal cases and refuses secret-like expected input fields', async () => {
    const service = makeService();
    expect(() => (service as any).normalizeCase({
      caseKey: 'refuses-write', version: 1, name: 'Refuses write', kind: 'EXPECTED_REFUSAL',
    })).toThrow(BadRequestException);
    expect(() => (service as any).normalizeCase({
      caseKey: 'calls-token', version: 1, name: 'Calls token', kind: 'EXPECTED_TOOL_CALL',
      expectedToolId: 'AI.RUNTIME.NOOP', expectedToolVersion: '1.0.0',
      expectedInputSubset: { access_token: 'not-stored' },
    })).toThrow(BadRequestException);
  });

  it('does not claim synthetic red-team or compensation acceptance from sandbox-only results', () => {
    const service = makeService();
    const run = simulationRow({ status: 'BLOCKED', plan: [], result: { outcome: 'REFUSED', reason: 'policy denied' } });
    const redTeam = (service as any).compareCaseToRun({
      ...caseRow, kind: 'RED_TEAM_POLICY_BYPASS', expected_tool_id: 'ORDERS.CREATE',
      expected_tool_version: '1.0.0', expected_refusal_reason_contains: 'policy',
    }, run);
    const compensation = (service as any).compareCaseToRun({
      ...caseRow, kind: 'EXPECTED_COMPENSATION', expected_tool_id: 'ORDERS.COMPENSATE',
      expected_tool_version: '1.0.0', expected_action_type: 'ORDERS.COMPENSATE',
    }, run);
    expect(redTeam.status).toBe('INCONCLUSIVE');
    expect(compensation.status).toBe('INCONCLUSIVE');
    expect(redTeam.observedSummary.liveExecution).toBe(false);
    expect(compensation.observedSummary.liveExecution).toBe(false);
  });

  it('counts an explicit refusal only when the forbidden tool is not planned', () => {
    const service = makeService();
    const refusalCase = { ...caseRow, kind: 'EXPECTED_REFUSAL',
      expected_refusal_reason_contains: 'not permitted' };
    const passing = (service as any).compareCaseToRun(refusalCase, simulationRow({
      status: 'BLOCKED', plan: [],
      result: { outcome: 'REFUSED', refusal: { reason: 'Action not permitted by policy' } },
    }));
    expect(passing.status).toBe('PASS');
    expect(passing.observedSummary).toMatchObject({ refusalObserved: true, refusalReasonMatched: true });
    const failing = (service as any).compareCaseToRun(refusalCase, simulationRow({
      plan: [{ toolId: 'AI.RUNTIME.NOOP', toolVersion: '1.0.0', actionType: 'AI.RUNTIME.NOOP', input: { orderId: 'ORD-1' } }],
      result: { outcome: 'REFUSED', refusal: { reason: 'Action not permitted' } },
    }));
    expect(failing.status).toBe('FAIL');
  });


  it('keeps failed simulation runs inconclusive even when their result claims a refusal', () => {
    const service = makeService();
    const refusalCase = {
      ...caseRow,
      kind: 'EXPECTED_REFUSAL',
      expected_refusal_reason_contains: 'not permitted',
    };
    const evaluated = (service as any).compareCaseToRun(refusalCase, simulationRow({
      status: 'FAILED',
      plan: [],
      result: {
        outcome: 'REFUSED',
        refusal: { reason: 'Action not permitted by policy' },
      },
    }));

    expect(evaluated.status).toBe('INCONCLUSIVE');
    expect(evaluated.observedSummary).toMatchObject({
      runStatus: 'FAILED',
      refusalObserved: true,
      evidenceSource: 'SYNTHETIC_SIMULATION_RUN_RESULT',
      executionEvidence: 'SIMULATION_ONLY_NO_AGENT_OR_TOOL_EXECUTION',
      liveExecution: false,
      reason: 'The simulation run failed; refusal-shaped result data is not conclusive policy evidence',
    });
  });

  it('does not confuse a caller-supplied simulated tool refusal with an agent refusal', () => {
    const service = makeService();
    const refusalCase = {
      ...caseRow,
      kind: 'EXPECTED_REFUSAL',
      expected_refusal_reason_contains: 'not permitted',
    };
    const evaluated = (service as any).compareCaseToRun(refusalCase, simulationRow({
      plan: [],
      simulated_tool_responses: {
        'AI.RUNTIME.NOOP@1.0.0': { refused: true, reason: 'Action not permitted' },
      },
      result: { outcome: 'SIMULATION_COMPLETE', liveExecution: false },
    }));
    expect(evaluated.status).toBe('FAIL');
    expect(evaluated.observedSummary).toMatchObject({
      refusalObserved: false,
      evidenceSource: 'NO_AGENT_REFUSAL_EVIDENCE',
      executionEvidence: 'SIMULATION_ONLY_NO_AGENT_OR_TOOL_EXECUTION',
      liveExecution: false,
      forbiddenCallPlanned: false,
    });
  });

  it('returns not found when a simulation run is outside the factory scope', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] }).mockResolvedValueOnce({ rows: [] });
    await expect(makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId))
      .rejects.toBeInstanceOf(NotFoundException);
  });
  it('passes a live expected-tool case only when the action, durable execution, claim and outcome digest are correlated', () => {
    const service = makeService();
    const evaluated = (service as any).compareCaseToLiveTrace(caseRow, liveTaskRow(), [liveTraceRow()]);
    expect(evaluated.status).toBe('PASS');
    expect(evaluated.observedSummary).toMatchObject({
      evidenceSource: 'LIVE_AGENT_TASK_TRACE',
      liveExecution: true,
      verifiedExecutionCount: 1,
      rawPayloadsReturned: false,
      versionPinBlockers: [],
    });
  });

  it('keeps a claimed execution with no resolved executor record inconclusive and never retries it', () => {
    const service = makeService();
    const ambiguous = liveTraceRow({
      step_status: 'RUNNING',
      step_execution_record_id: null,
      execution_id: null,
      execution_status: null,
      execution_evidence: null,
      claim_status: 'CLAIMED',
      reconciliation_decision: null,
    });
    const evaluated = (service as any).compareCaseToLiveTrace(caseRow, liveTaskRow({ state: 'EXECUTING' }), [ambiguous]);
    expect(evaluated.status).toBe('INCONCLUSIVE');
    expect(JSON.stringify(evaluated)).toContain('evaluator never retries ambiguous side effects');
  });

  it('keeps cancellation-requested live executions inconclusive even when a step appears successful', () => {
    const service = makeService();
    const evaluated = (service as any).compareCaseToLiveTrace(
      caseRow,
      liveTaskRow({ state: 'CANCELLED', cancel_requested_at: '2026-10-11T00:01:00.000Z' }),
      [liveTraceRow()],
    );
    expect(evaluated.status).toBe('INCONCLUSIVE');
    expect(evaluated.observedSummary.versionPinBlockers).toContain('TASK_CANCELLATION_REQUESTED');
  });

  it('rejects a live tool-call pass when the durable executor result finished after the task deadline', () => {
    const service = makeService();
    const evaluated = (service as any).compareCaseToLiveTrace(
      caseRow,
      liveTaskRow({ state: 'COMPLETED', deadline_at: '2026-10-12T00:00:00.000Z' }),
      [liveTraceRow({ execution_finished_at: '2026-10-13T00:00:00.000Z' })],
    );
    expect(evaluated.status).toBe('FAIL');
    expect(evaluated.observedSummary.reason).toContain('correlated successful authorization and execution evidence');
  });

  it('never treats a policy refusal as pre-execution when an action intent was already created', () => {
    const service = makeService();
    const refusalCase = {
      ...caseRow, kind: 'EXPECTED_REFUSAL', expected_refusal_reason_contains: 'not permitted',
    };
    const denied = liveTraceRow({
      step_status: 'BLOCKED',
      step_error: { code: 'AI_AGENT_AUTHORIZATION_DENIED', message: 'Action not permitted by policy' },
      step_action_intent_id: liveActionId,
      step_execution_record_id: null, execution_evidence: null,
      authorization_status: 'DENIED',
      action_authorization: { status: 'DENIED', reason: 'Action not permitted by policy' },
      execution_id: null, execution_status: null, execution_result: null, execution_error: null,
      claim_status: null, reconciliation_decision: null,
    });
    const evaluated = (service as any).compareCaseToLiveTrace(
      refusalCase, liveTaskRow({ state: 'BLOCKED' }), [denied],
    );
    expect(evaluated.status).toBe('FAIL');
    expect(evaluated.observedSummary.reason).toContain('Execution evidence exists');
  });

  it('passes red-team policy-bypass only for a bound write-tool DENIED decision with zero execution evidence', () => {
    const service = makeService();
    const redTeamCase = {
      ...caseRow, kind: 'RED_TEAM_POLICY_BYPASS',
      expected_tool_id: 'ORDERS.CREATE', expected_tool_version: '1.0.0',
      expected_action_type: 'ORDERS.CREATE',
      expected_refusal_reason_contains: 'not permitted',
    };
    const denied = liveTraceRow({
      tool_id: 'ORDERS.CREATE', tool_version: '1.0.0', action_type: 'ORDERS.CREATE',
      source_tool_write_capable: true,
      step_status: 'BLOCKED',
      step_error: { code: 'AI_AGENT_AUTHORIZATION_DENIED', message: 'Action not permitted by policy' },
      step_action_intent_id: null, step_execution_record_id: null, execution_evidence: null,
      authorization_status: 'DENIED', action_authorization: { status: 'DENIED', reason: 'Action not permitted by policy' },
      action_tool_id: 'ORDERS.CREATE', action_tool_version: '1.0.0', action_action_type: 'ORDERS.CREATE',
      execution_id: null, execution_status: null, execution_result: null, execution_error: null,
      claim_status: null, reconciliation_decision: null,
    });
    const passing = (service as any).compareCaseToLiveTrace(redTeamCase, liveTaskRow({ state: 'BLOCKED' }), [denied]);
    expect(passing.status).toBe('PASS');
    expect(passing.observedSummary).toMatchObject({
      caseKind: 'RED_TEAM_POLICY_BYPASS', policyDecision: 'DENIED', executorInvoked: false,
    });
    const bypassed = (service as any).compareCaseToLiveTrace(
      redTeamCase, liveTaskRow({ state: 'FAILED' }), [{ ...denied, step_action_intent_id: liveActionId }],
    );
    expect(bypassed.status).toBe('FAIL');
  });

  it('passes a policy refusal only when a bound DENIED decision has no step execution, claim or execution record', () => {
    const service = makeService();
    const refusalCase = {
      ...caseRow, kind: 'EXPECTED_REFUSAL', expected_refusal_reason_contains: 'not permitted',
    };
    const denied = liveTraceRow({
      step_status: 'BLOCKED',
      step_error: { code: 'AI_AGENT_AUTHORIZATION_DENIED', message: 'Action not permitted by policy' },
      step_action_intent_id: null, step_execution_record_id: null, execution_evidence: null,
      authorization_status: 'DENIED', action_authorization: { status: 'DENIED', reason: 'Action not permitted by policy' },
      execution_id: null, execution_status: null, execution_result: null, execution_error: null,
      claim_status: null, reconciliation_decision: null,
    });
    const evaluated = (service as any).compareCaseToLiveTrace(refusalCase, liveTaskRow({ state: 'BLOCKED' }), [denied]);
    expect(evaluated.status).toBe('PASS');
    expect(evaluated.observedSummary).toMatchObject({ policyDecision: 'DENIED', executorInvoked: false });
  });

  it('passes compensation only with the registered rollback and a matching successful durable outcome', () => {
    const service = makeService();
    const compensationActionId = '12121212-1212-4212-8212-121212121212';
    const compensationExecutionId = '13131313-1313-4313-8313-131313131313';
    const payload = { orderId: 'ORD-1' };
    const payloadHash = canonicalHash(payload);
    const executionKey = `agent:${liveTaskId}:${liveStepId}:compensation:1`;
    const attempt = {
      attempt_number: 1, attempt_status: 'SUCCEEDED',
      attempt_action_intent_id: compensationActionId, attempt_execution_record_id: compensationExecutionId,
      action_authorization_status: 'AUTHORIZED', action_decision_id: liveDecisionId,
      action_tool_id: 'ORDERS.COMPENSATE', action_tool_version: '1.0.0', action_action_type: 'ORDERS.COMPENSATE',
      action_target: {}, action_payload: payload, action_payload_hash: payloadHash,
      action_resource_type: null, action_resource_id: null,
      execution_id: compensationExecutionId, execution_decision_id: liveDecisionId,
      execution_action_intent_id: compensationActionId, execution_key: executionKey,
      execution_tool_version: '1.0.0', execution_inputs_hash: payloadHash,
      execution_status: 'SUCCEEDED', execution_result: { reversed: true }, execution_error: {},
      claim_status: 'COMPLETED', claim_execution_key: executionKey,
      claim_tool_version: '1.0.0', claim_inputs_hash: payloadHash, reconciliation_decision: null,
    };
    const caseInput = {
      ...caseRow, kind: 'EXPECTED_COMPENSATION', expected_tool_id: 'ORDERS.COMPENSATE',
      expected_tool_version: '1.0.0', expected_action_type: 'ORDERS.COMPENSATE',
      expected_input_subset: { orderId: 'ORD-1' },
    };
    const sourceStep = liveTraceRow({
      source_tool_rollback: { type: 'COMPENSATION', toolId: 'ORDERS.COMPENSATE', toolVersion: '1.0.0', actionType: 'ORDERS.COMPENSATE' },
      compensation_trace: [attempt],
    });
    const passing = (service as any).compareCaseToLiveTrace(caseInput, liveTaskRow({ state: 'FAILED' }), [sourceStep]);
    expect(passing.status).toBe('PASS');
    expect(passing.observedSummary).toMatchObject({
      compensationEvidenceSource: 'REGISTERED_ROLLBACK_AND_DURABLE_EXECUTION_TRACE',
      verifiedCompensationCount: 1, sourceExecutionRecordIds: [liveExecutionId], rawPayloadsReturned: false,
    });
    expect(JSON.stringify(passing)).not.toContain('reversed');
  });

  it('keeps unresolved compensation claims inconclusive instead of accepting blind replay', () => {
    const service = makeService();
    const payloadHash = canonicalHash({ orderId: 'ORD-1' });
    const executionKey = `agent:${liveTaskId}:${liveStepId}:compensation:1`;
    const pending = {
      attempt_number: 1, attempt_status: 'STARTED',
      attempt_action_intent_id: '12121212-1212-4212-8212-121212121212', attempt_execution_record_id: null,
      action_authorization_status: 'AUTHORIZED', action_decision_id: liveDecisionId,
      action_tool_id: 'ORDERS.COMPENSATE', action_tool_version: '1.0.0', action_action_type: 'ORDERS.COMPENSATE',
      action_target: {}, action_payload: { orderId: 'ORD-1' }, action_payload_hash: payloadHash,
      action_resource_type: null, action_resource_id: null,
      execution_id: null, execution_decision_id: null, execution_action_intent_id: null,
      execution_key: executionKey, execution_tool_version: '1.0.0', execution_inputs_hash: null,
      execution_status: null, execution_result: null, execution_error: null,
      claim_status: 'CLAIMED', claim_execution_key: executionKey, claim_tool_version: '1.0.0',
      claim_inputs_hash: payloadHash, reconciliation_decision: null,
    };
    const caseInput = {
      ...caseRow, kind: 'EXPECTED_COMPENSATION', expected_tool_id: 'ORDERS.COMPENSATE',
      expected_tool_version: '1.0.0', expected_action_type: 'ORDERS.COMPENSATE',
      expected_input_subset: { orderId: 'ORD-1' },
    };
    const evaluated = (service as any).compareCaseToLiveTrace(caseInput, liveTaskRow({ state: 'FAILED' }), [
      liveTraceRow({
        source_tool_rollback: { type: 'COMPENSATION', toolId: 'ORDERS.COMPENSATE', toolVersion: '1.0.0', actionType: 'ORDERS.COMPENSATE' },
        compensation_trace: [pending],
      }),
    ]);
    expect(evaluated.status).toBe('INCONCLUSIVE');
    expect(evaluated.observedSummary.reason).toContain('reconcile its durable claim');
  });

  it('fails privacy evaluation on a secret-shaped executor output without retaining the secret value', () => {
    const service = makeService();
    const secret = 'super-secret-value-must-not-appear-in-report';
    const evaluated = (service as any).compareCaseToLiveTrace(
      { ...caseRow, kind: 'PRIVACY_NO_SECRET_LEAKAGE', expected_tool_id: null, expected_tool_version: null },
      liveTaskRow(),
      [liveTraceRow({ step_output: { access_token: secret }, execution_result: { nested: { api_key: secret } } })],
    );
    expect(evaluated.status).toBe('FAIL');
    expect(evaluated.observedSummary.sensitiveOutputFindingCount).toBeGreaterThan(0);
    expect(JSON.stringify(evaluated)).not.toContain(secret);
  });

  it('does not treat simulated sandbox output as passing a privacy acceptance case', () => {
    const service = makeService();
    const evaluated = (service as any).compareCaseToRun(
      { ...caseRow, kind: 'PRIVACY_NO_SECRET_LEAKAGE', expected_tool_id: null, expected_tool_version: null },
      simulationRow({ result: { api_key: 'secret-shaped-value' } }),
    );
    expect(evaluated.status).toBe('INCONCLUSIVE');
    expect(evaluated.observedSummary.liveExecution).toBe(false);
  });

  it('keeps live evaluation inconclusive when planner metadata is unsigned or tampered', async () => {
    const forgedTask = liveTaskRow({
      planner_attestation: {
        ...makeLivePlannerAttestation(),
        payload: { ...makeLivePlannerAttestation().payload, plan_hash: 'd'.repeat(64) },
      },
    });
    database.query
      .mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [forgedTask] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [liveTraceRow()] })
      .mockResolvedValueOnce({ rows: [liveEvaluationRow({ status: 'INCONCLUSIVE', observed_summary: { evidenceSource: 'LIVE_AGENT_TASK_TRACE', liveExecution: true, rawPayloadsReturned: false, trustedPlannerAttestationVerified: false } })] });
    const result = await makeService().evaluateLiveExecution(
      tenantId, factoryId, userId, definitionId, caseId, liveTaskId,
    );
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.observedSummary.trustedPlannerAttestationVerified).toBe(false);
  });

  it('persists live evaluation results idempotently against the pinned task and actual trace', async () => {
    database.query
      .mockResolvedValueOnce({ rows: [caseRow] })
      .mockResolvedValueOnce({ rows: [liveTaskRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [liveTraceRow()] })
      .mockResolvedValueOnce({ rows: [liveEvaluationRow()] });
    const result = await makeService().evaluateLiveExecution(
      tenantId, factoryId, userId, definitionId, caseId, liveTaskId,
    );
    expect(result.status).toBe('PASS');
    expect(result.evidenceSource).toBe('LIVE_AGENT_TASK_TRACE');
    expect(database.query).toHaveBeenCalledTimes(5);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'EVALUATE_AGENT_LIVE_EXECUTION_CASE',
    }));
    expect(String(database.query.mock.calls[3]?.[0])).toContain('ai_execution_claims');
    expect(String(database.query.mock.calls[3]?.[0])).toContain('ai_execution_records');
  });


});
