import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { AiAgentEvaluationController } from './ai.agent.evaluation.controller';

describe('AiAgentEvaluationController', () => {
  const createCaseMock = jest.fn();
  const listCasesMock = jest.fn();
  const evaluateCaseMock = jest.fn();
  const getReportMock = jest.fn();
  const controller = new AiAgentEvaluationController({
    createCase: createCaseMock, listCases: listCasesMock,
    evaluateCase: evaluateCaseMock, getReport: getReportMock,
  } as never);
  const request = { factoryos: {
    userId: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    factoryId: '22222222-2222-4222-8222-222222222222',
  } };
  beforeEach(() => jest.clearAllMocks());

  it('maps expected-tool-call cases from the API DTO', async () => {
    createCaseMock.mockResolvedValue({ id: 'case-id' });
    await controller.createCase(request as never, '44444444-4444-4444-8444-444444444444', {
      case_key: 'calls-noop', version: 1, name: 'Calls noop',
      kind: 'EXPECTED_TOOL_CALL', expected_tool_id: 'AI.RUNTIME.NOOP',
      expected_tool_version: '1.0.0', expected_action_type: 'AI.RUNTIME.NOOP',
      expected_input_subset: { orderId: 'ORD-1' },
    });
    expect(createCaseMock).toHaveBeenCalledWith(
      request.factoryos.tenantId, request.factoryos.factoryId, request.factoryos.userId,
      '44444444-4444-4444-8444-444444444444',
      expect.objectContaining({
        caseKey: 'calls-noop', kind: 'EXPECTED_TOOL_CALL',
        expectedToolId: 'AI.RUNTIME.NOOP', expectedInputSubset: { orderId: 'ORD-1' },
      }),
    );
  });

  it('requires trusted factory context for reports', async () => {
    await expect(controller.report({
      factoryos: { userId: null, tenantId: null, factoryId: null },
    } as never, '44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it('maps a sandbox simulation id into the evaluation service', async () => {
    evaluateCaseMock.mockResolvedValue({ status: 'PASS' });
    await controller.evaluateCase(
      request as never, '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      { simulation_run_id: '66666666-6666-4666-8666-666666666666' },
    );
    expect(evaluateCaseMock).toHaveBeenCalledWith(
      request.factoryos.tenantId, request.factoryos.factoryId, request.factoryos.userId,
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    );
  });
});
