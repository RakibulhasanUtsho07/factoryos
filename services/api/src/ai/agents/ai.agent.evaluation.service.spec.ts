import { jest } from '@jest/globals';
import {
  BadRequestException, ForbiddenException, NotFoundException,
} from '@nestjs/common';

import { AiAgentEvaluationService } from './ai.agent.evaluation.service';

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
    expected_summary: { caseKey: 'calls-noop' }, observed_summary: { observedCallCount: 1, matchingStepIndices: [0] },
    created_by: userId, created_at: '2026-10-11T00:02:00.000Z', ...overrides,
  };
}
function makeService() {
  return new AiAgentEvaluationService(database as never, iamService as never, auditService as never);
}
describe('AiAgentEvaluationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    iamService.authorize.mockResolvedValue(undefined);
    auditService.record.mockResolvedValue('audit-id');
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
    expect(result.observedSummary).toMatchObject({ observedCallCount: 1, matchingStepIndices: [0] });
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'EVALUATE_AGENT_CASE', resourceType: 'AI_AGENT_EVALUATION_RESULT',
    }));
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

  it('counts an explicit refusal only when the forbidden tool was not invoked', () => {
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

  it('returns not found when a simulation run is outside the factory scope', async () => {
    database.query.mockResolvedValueOnce({ rows: [caseRow] }).mockResolvedValueOnce({ rows: [] });
    await expect(makeService().evaluateCase(tenantId, factoryId, userId, definitionId, caseId, runId))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
