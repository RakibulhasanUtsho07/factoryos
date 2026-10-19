
import {
  jest,
} from '@jest/globals';

import {
  createHash,
} from 'node:crypto';

import {
  ConflictException,
} from '@nestjs/common';

import type {
  DatabaseContext,
} from '../database/database.service';

import type {
  PoolClient,
  QueryResultRow,
} from 'pg';

import {
  AiRuntimeService,
} from './ai.runtime.service';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const decisionId =
  '6f1a3333-3333-4333-8333-333333333333';
const actionId =
  '6f1a6666-6666-4666-8666-666666666666';
const executionId =
  '6f1a7777-7777-4777-8777-777777777777';
const outcomeId =
  '6f1a8888-8888-4888-8888-888888888888';
const learningId =
  '6f1a9999-9999-4999-8999-999999999999';
const approvalId =
  '6f1abbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const policyId =
  '6f1acccc-cccc-4ccc-8ccc-cccccccccccc';

const sha256 = (value: string) =>
  createHash('sha256')
    .update(value, 'utf8')
    .digest('hex');

/**
 * AiRuntimeService hashes action tokens through its canonical
 * JSON hashing helper, so the contract fixture mirrors that hash.
 */
const actionTokenHash = (value: string) =>
  sha256(JSON.stringify(value));

type PolicyEvaluationMock = {
  outcome:
    | 'ALLOWED'
    | 'APPROVAL_REQUIRED'
    | 'DENIED';
  risk: {
    class: string | null;
    policyRef: {
      id: string;
      key: string;
      version: string;
    } | null;
    approvalRequired: boolean;
  };
  policy: {
    id: string;
    riskClass: {
      id: string;
    } | null;
  } | null;
  safeDefault: boolean;
  reason: string;
};

const databaseQueryMock = jest.fn<
  (
    text: string,
    values?: unknown[],
  ) => Promise<{
    rows: QueryResultRow[];
  }>
>();

const databaseTransactionMock = jest.fn(
  async function <T>(
    callback: (
      client: {
        query: PoolClient['query'];
      },
    ) => Promise<T>,
    _context?: DatabaseContext,
  ): Promise<T> {
    return callback({
      query:
        databaseQueryMock as unknown as PoolClient['query'],
    });
  },
);

const database = {
  query: databaseQueryMock,
  transaction: databaseTransactionMock,
};

const auditRecordMock =
  jest.fn<(input: unknown) => Promise<void>>();

const auditService = {
  record: auditRecordMock,
};

const authorizeMock =
  jest.fn<(
    userId: string,
    tenantId: string,
    permissionCode: string,
    factoryId?: string | null,
  ) => Promise<void>>();

const iamService = {
  authorize: authorizeMock,
};

const evaluatePolicyMock = jest.fn<
  () => Promise<PolicyEvaluationMock>
>();

const createApprovalMock = jest.fn<
  () => Promise<{
    id: string;
    status: string;
  }>
>();

const policyService = {
  evaluatePolicy: evaluatePolicyMock,
  createApproval: createApprovalMock,
};

const getBusinessModelMock = jest.fn();

const cbbService = {
  getBusinessModel: getBusinessModelMock,
};

const aiToolRegistry = {
  getTool: jest.fn(),
};

const aiToolGateway = {
  execute: jest.fn(),
};

const decisionRow = {
  id: decisionId,
  tenant_id: tenantId,
  factory_id: factoryId,
  request_id:
    '6f1a1111-1111-4111-8111-111111111111',
  trace_id:
    '6f1a2222-2222-4222-8222-222222222222',
  actor_id: userId,
  objective: 'Change plan',
  reasoning_mode: 'PLAN',
  context_version: 'cbb-1',
  risk_class: 'L1',
  output_state: 'ACTION',
  metadata: {},
  created_at:
    '2026-10-07T00:00:00.000Z',
  updated_at:
    '2026-10-07T00:00:00.000Z',
};

const approvalBoundPayload = {
  quantity: 10,
};

const approvalBoundTarget = {
  decision_id: decisionId,
};

const approvalBoundPayloadHash = sha256(
  JSON.stringify(approvalBoundPayload),
);

function buildBoundApprovalRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: approvalId,
    tenant_id: tenantId,
    policy_id: policyId,
    risk_class_id: '6f1adddd-dddd-4ddd-8ddd-dddddddddddd',
    action: 'PLAN.CHANGE',
    resource_type: 'PLAN',
    resource_id: 'plan-1',
    status: 'APPROVED',
    expires_at: '2999-01-01T00:00:00.000Z',
    metadata: {
      decisionId,
      actionPayloadHash: approvalBoundPayloadHash,
      target: approvalBoundTarget,
    },
    ...overrides,
  };
}

const authorizedActionInsertRow = {
  id: actionId,
  tenant_id: tenantId,
  factory_id: factoryId,
  decision_id: decisionId,
  action_type: 'PLAN.CHANGE',
  tool_id: 'PLAN.CHANGE',
  tool_version: '1.0.0',
  target: approvalBoundTarget,
  resource_type: 'PLAN',
  resource_id: 'plan-1',
  payload: approvalBoundPayload,
  payload_hash: approvalBoundPayloadHash,
  risk_class: 'L3',
  authorization_status: 'AUTHORIZED',
  authorization: {
    approvalId,
    approvalStatus: 'APPROVED',
  },
  approval_id: approvalId,
  action_token_hash: 'b'.repeat(64),
  token_expires_at: '2999-01-01T00:00:00.000Z',
  idempotency_key: null,
  created_by: userId,
  created_at: '2026-10-07T00:00:00.000Z',
};

function approvalRequiredEvaluation(): PolicyEvaluationMock {
  return {
    outcome: 'APPROVAL_REQUIRED',
    risk: {
      class: 'L3',
      policyRef: {
        id: policyId,
        key: 'plan-change',
        version: '1',
      },
      approvalRequired: true,
    },
    policy: {
      id: policyId,
      riskClass: {
        id: '6f1adddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    },
    safeDefault: false,
    reason: 'HUMAN_APPROVAL_REQUIRED',
  };
}

describe(
  'AiRuntimeService governed action + learning wave',
  () => {
    let service: AiRuntimeService;

    beforeEach(() => {
      /*
       * resetAllMocks() removes implementations as well as call history.
       * Restore the transaction mock after resetting, otherwise
       * executeAction() can receive undefined instead of its transaction
       * callback result.
       */
      jest.resetAllMocks();

      databaseTransactionMock.mockImplementation(
        async function <T>(
          callback: (
            client: {
              query: PoolClient['query'];
            },
          ) => Promise<T>,
          _context?: DatabaseContext,
        ): Promise<T> {
          return callback({
            query:
              databaseQueryMock as unknown as PoolClient['query'],
          });
        },
      );

      aiToolRegistry.getTool.mockImplementation(
        async (...args: unknown[]) => {
          const toolId = String(args[2]);
          const version = String(args[3]);

          return {
            toolId,
            version,
            riskClass:
              toolId === 'PLAN.CHANGE'
                ? 'L3'
                : 'L1',
          };
        },
      );

      aiToolGateway.execute.mockImplementation(
        async (...args: unknown[]) => {
          const action = args[0] as {
            toolId: string;
            toolVersion: string;
            actionType: string;
            riskClass: string;
            payloadHash: string;
          };

          const isNoop =
            action.toolId === 'AI.RUNTIME.NOOP';

          return {
            status: isNoop ? 'SUCCEEDED' : 'FAILED',
            result: isNoop
              ? {
                  execution: 'NO_SIDE_EFFECT',
                  executorType: 'AI_TOOL_GATEWAY',
                  actionType: action.actionType,
                  committed: false,
                }
              : {},
            error: isNoop
              ? {}
              : {
                  code: 'EXECUTOR_NOT_CONFIGURED',
                  message: 'No domain executor is configured',
                },
            tool: {
              toolId: action.toolId,
              version: action.toolVersion,
              riskClass: action.riskClass,
            },
            executorType: 'AI_TOOL_GATEWAY',
            toolVersion: action.toolVersion,
            inputsHash: action.payloadHash,
          };
        },
      );

      service = new AiRuntimeService(
        database as never,
        auditService as never,
        iamService as never,
        policyService as never,
        cbbService as never,
        aiToolRegistry as never,
        aiToolGateway as never,
      );
    });

    it(
      'pins executor attribution for internal agent execution without trusting DTO metadata',
      async () => {
        const delegate = jest
          .fn<(...args: unknown[]) => Promise<unknown>>()
          .mockResolvedValue({ delegated: true });
        (service as any).executeAuthorizedAction = delegate;

        const input = {
          action_token: 'agent-action-token',
          execution_key: 'agent:task:step:1',
          tool_version: '1.0.0',
          executor_type: 'CALLER_FORGED_EXECUTOR',
        };

        await service.executeAgentAction(
          tenantId,
          factoryId,
          userId,
          input,
        );
        await service.executeAction(
          tenantId,
          factoryId,
          userId,
          input,
        );

        expect(delegate).toHaveBeenNthCalledWith(
          1,
          tenantId,
          factoryId,
          userId,
          input,
          'AGENT_RUNTIME',
        );
        expect(delegate).toHaveBeenNthCalledWith(
          2,
          tenantId,
          factoryId,
          userId,
          input,
          'AI_TOOL_GATEWAY',
        );
      },
    );

    it(
      'authorizes an allowed action and mints a scoped token',
      async () => {
        /*
         * authorizeAction() query order:
         *   1. decision lookup
         *   2. idempotency lookup
         *   3. action intent INSERT
         */
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_type:
                'AI.RUNTIME.NOOP',
              tool_id: 'AI.RUNTIME.NOOP',
              tool_version: '1.0.0',
              target: {
                decision_id:
                  decisionId,
              },
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: {
                quantity: 10,
              },
              payload_hash:
                'a'.repeat(64),
              risk_class: 'L1',
              authorization_status:
                'AUTHORIZED',
              authorization: {
                outcome: 'ALLOWED',
              },
              approval_id: null,
              action_token_hash:
                'b'.repeat(64),
              token_expires_at:
                '2999-01-01T00:00:00.000Z',
              idempotency_key:
                'action-1',
              created_by: userId,
              created_at:
                '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        evaluatePolicyMock.mockResolvedValue({
          outcome: 'ALLOWED',
          risk: {
            class: 'L1',
            policyRef: {
              id: policyId,
              key: 'plan-change',
              version: '1',
            },
            approvalRequired: false,
          },
          policy: {
            id: policyId,
            riskClass: {
              id:
                '6f1adddd-dddd-4ddd-8ddd-dddddddddddd',
            },
          },
          safeDefault: false,
          reason:
            'POLICY_ALLOW',
        });

        const result =
          await service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
              action_type:
                'AI.RUNTIME.NOOP',
              tool_version: '1.0.0',
              target: {
                decision_id:
                  decisionId,
              },
              resource_type:
                'PLAN',
              resource_id:
                'plan-1',
              payload: {
                quantity: 10,
              },
              idempotency_key:
                'action-1',
            },
          );

        expect(
          result.idempotent,
        ).toBe(false);

        expect(
          result.action
            .authorizationStatus,
        ).toBe('AUTHORIZED');

        expect(
          result.actionToken,
        ).toEqual(
          expect.any(String),
        );

        expect(
          evaluatePolicyMock,
        ).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'rejects an authorization idempotency replay when its target changes',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              ...authorizedActionInsertRow,
              target: {
                decision_id: decisionId,
                plan_id: 'original-plan',
              },
              idempotency_key: 'reuse-target-key',
            },
          ],
        });

        await expect(
          service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id: decisionId,
              action_type: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: approvalBoundTarget,
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: approvalBoundPayload,
              idempotency_key: 'reuse-target-key',
            },
          ),
        ).rejects.toThrow(
          'idempotency_key is already bound to a different AI action request',
        );

        expect(aiToolRegistry.getTool).not.toHaveBeenCalled();
        expect(evaluatePolicyMock).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'rejects an authorization idempotency replay from a different actor',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              ...authorizedActionInsertRow,
              idempotency_key: 'reuse-actor-key',
              created_by: userId,
            },
          ],
        });

        await expect(
          service.authorizeAction(
            tenantId,
            factoryId,
            '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf002',
            {
              decision_id: decisionId,
              action_type: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: approvalBoundTarget,
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: approvalBoundPayload,
              idempotency_key: 'reuse-actor-key',
            },
          ),
        ).rejects.toThrow(
          'idempotency_key is already bound to a different AI action request',
        );

        expect(aiToolRegistry.getTool).not.toHaveBeenCalled();
        expect(evaluatePolicyMock).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'creates an approval request when policy requires human approval',
      async () => {
        /*
         * authorizeAction() query order:
         *   1. decision lookup
         *   2. idempotency lookup
         *   3. action intent INSERT
         *
         * createApproval() is mocked and therefore does not add another
         * database query to this service-level unit test.
         */
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_type:
                'PLAN.CHANGE',
              tool_id: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: {
                decision_id:
                  decisionId,
              },
              resource_type:
                'PLAN',
              resource_id:
                'plan-1',
              payload: {
                quantity: 10,
              },
              payload_hash:
                'c'.repeat(64),
              risk_class: 'L3',
              authorization_status:
                'APPROVAL_REQUIRED',
              authorization: {
                approvalId,
              },
              approval_id:
                approvalId,
              action_token_hash:
                null,
              token_expires_at:
                null,
              idempotency_key:
                'action-2',
              created_by: userId,
              created_at:
                '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        evaluatePolicyMock.mockResolvedValue({
          outcome:
            'APPROVAL_REQUIRED',
          risk: {
            class: 'L3',
            policyRef: {
              id: policyId,
              key: 'plan-change',
              version: '1',
            },
            approvalRequired:
              true,
          },
          policy: {
            id: policyId,
            riskClass: {
              id:
                '6f1adddd-dddd-4ddd-8ddd-dddddddddddd',
            },
          },
          safeDefault: false,
          reason:
            'HUMAN_APPROVAL_REQUIRED',
        });

        createApprovalMock.mockResolvedValue({
          id: approvalId,
          status: 'PENDING',
        });

        const result =
          await service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
              action_type:
                'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: {
                decision_id:
                  decisionId,
              },
              resource_type:
                'PLAN',
              resource_id:
                'plan-1',
              payload: {
                quantity: 10,
              },
              idempotency_key:
                'action-2',
            },
          );

        expect(
          result.action
            .authorizationStatus,
        ).toBe(
          'APPROVAL_REQUIRED',
        );

        expect(
          result.action.approvalId,
        ).toBe(approvalId);

        expect(
          result.actionToken,
        ).toBeNull();

        expect(
          createApprovalMock,
        ).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'accepts an approved action only when decision, payload, target, resource, and risk class match',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [buildBoundApprovalRow()],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [authorizedActionInsertRow],
        });
        evaluatePolicyMock.mockResolvedValue(approvalRequiredEvaluation());

        const result = await service.authorizeAction(
          tenantId,
          factoryId,
          userId,
          {
            decision_id: decisionId,
            action_type: 'PLAN.CHANGE',
            tool_version: '1.0.0',
            target: approvalBoundTarget,
            resource_type: 'PLAN',
            resource_id: 'plan-1',
            payload: approvalBoundPayload,
            approval_id: approvalId,
          },
        );

        expect(result.action.authorizationStatus).toBe('AUTHORIZED');
        expect(result.action.approvalId).toBe(approvalId);
        expect(result.actionToken).toEqual(expect.any(String));
        expect(databaseQueryMock).toHaveBeenCalledTimes(3);
      },
    );

    it.each([
      {
        label: 'action',
        overrides: { action: 'PLAN.DELETE' },
        message: 'AI action approval action does not match the requested action',
      },
      {
        label: 'resource id',
        overrides: { resource_id: 'plan-2' },
        message: 'AI action approval resource id does not match the requested action',
      },
      {
        label: 'policy',
        overrides: { policy_id: '6f1adddd-dddd-4ddd-8ddd-ddddddddddde' },
        message: 'AI action approval is bound to a different policy',
      },
      {
        label: 'risk class',
        overrides: { risk_class_id: '6f1adddd-dddd-4ddd-8ddd-ddddddddddde' },
        message: 'AI action approval is bound to a different risk class',
      },
      {
        label: 'expiry',
        overrides: { expires_at: '2020-01-01T00:00:00.000Z' },
        message: 'AI action approval has expired',
      },
    ])(
      'rejects approved actions with a mismatched $label binding',
      async ({ overrides, message }) => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [buildBoundApprovalRow(overrides)],
        });
        evaluatePolicyMock.mockResolvedValue(approvalRequiredEvaluation());

        await expect(
          service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id: decisionId,
              action_type: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: approvalBoundTarget,
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: approvalBoundPayload,
              approval_id: approvalId,
            },
          ),
        ).rejects.toThrow(message);

        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
        expect(aiToolRegistry.getTool).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects an approved action when the payload differs from the approval metadata',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [buildBoundApprovalRow({
            metadata: {
              decisionId,
              actionPayloadHash: sha256(JSON.stringify({ quantity: 999 })),
              target: approvalBoundTarget,
            },
          })],
        });
        evaluatePolicyMock.mockResolvedValue(approvalRequiredEvaluation());

        await expect(
          service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id: decisionId,
              action_type: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: approvalBoundTarget,
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: approvalBoundPayload,
              approval_id: approvalId,
            },
          ),
        ).rejects.toThrow(
          'AI action approval is bound to a different decision or payload',
        );

        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'rejects an approved action when the target differs from the approval metadata',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [buildBoundApprovalRow({
            metadata: {
              decisionId,
              actionPayloadHash: approvalBoundPayloadHash,
              target: { decision_id: decisionId, factory_id: 'another-factory' },
            },
          })],
        });
        evaluatePolicyMock.mockResolvedValue(approvalRequiredEvaluation());

        await expect(
          service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id: decisionId,
              action_type: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: approvalBoundTarget,
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: approvalBoundPayload,
              approval_id: approvalId,
            },
          ),
        ).rejects.toThrow(
          'AI action approval target does not match the requested action',
        );

        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'does not treat a null approval resource as a wildcard',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [buildBoundApprovalRow({ resource_type: null })],
        });
        evaluatePolicyMock.mockResolvedValue(approvalRequiredEvaluation());

        await expect(
          service.authorizeAction(
            tenantId,
            factoryId,
            userId,
            {
              decision_id: decisionId,
              action_type: 'PLAN.CHANGE',
              tool_version: '1.0.0',
              target: approvalBoundTarget,
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: approvalBoundPayload,
              approval_id: approvalId,
            },
          ),
        ).rejects.toThrow(
          'AI action approval resource type does not match the requested action',
        );

        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      {
        scope: 'tenant',
        overrides: { tenant_id: '11111111-1111-4111-8111-111111111111' },
      },
      {
        scope: 'factory',
        overrides: { factory_id: '22222222-2222-4222-8222-222222222222' },
      },
    ])(
      'does not execute an action token returned outside the requested $scope scope',
      async ({ overrides }) => {
        const scopedToken = 'scoped-action-token';
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              ...authorizedActionInsertRow,
              ...overrides,
              tool_version: 'wave2-test',
              action_token_hash: actionTokenHash(scopedToken),
              token_expires_at: '2999-01-01T00:00:00.000Z',
              payload_hash: 'd'.repeat(64),
            },
          ],
        });

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token: scopedToken,
              execution_key: 'scoped-execution',
              tool_version: 'wave2-test',
            },
          ),
        ).rejects.toThrow(
          'AI action token was not found for this factory',
        );

        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'rejects an execution request whose tool version differs from the authorization binding',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_type: 'AI.RUNTIME.NOOP',
              tool_id: 'AI.RUNTIME.NOOP',
              tool_version: 'wave2-test',
              target: {},
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: {},
              payload_hash: 'd'.repeat(64),
              risk_class: 'L1',
              authorization_status: 'AUTHORIZED',
              authorization: { outcome: 'ALLOWED' },
              approval_id: null,
              action_token_hash: actionTokenHash('contract-token'),
              token_expires_at: '2999-01-01T00:00:00.000Z',
              idempotency_key: 'action-version-binding',
              created_by: userId,
              created_at: '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token: 'contract-token',
              execution_key: 'execution-version-mismatch',
              tool_version: '99.0.0',
            },
          ),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'returns an existing execution for an exact replay without calling the gateway again',
      async () => {
        const replayToken = 'stable-replay-token';
        const replayKey = 'stable-replay-execution';
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              ...authorizedActionInsertRow,
              tool_version: 'wave2-test',
              payload_hash: 'd'.repeat(64),
              action_token_hash: actionTokenHash(replayToken),
              token_expires_at: '2999-01-01T00:00:00.000Z',
            },
          ],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: executionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_intent_id: actionId,
              execution_key: replayKey,
              executor_type: 'AI_TOOL_GATEWAY',
              tool_version: 'wave2-test',
              inputs_hash: 'd'.repeat(64),
              result: { committed: false },
              error: {},
              status: 'SUCCEEDED',
              started_at: '2026-10-07T00:00:00.000Z',
              finished_at: '2026-10-07T00:00:01.000Z',
            },
          ],
        });

        const result = await service.executeAction(
          tenantId,
          factoryId,
          userId,
          {
            action_token: replayToken,
            execution_key: replayKey,
            tool_version: 'wave2-test',
          },
        );

        expect(result.idempotent).toBe(true);
        expect(result.execution.id).toBe(executionId);
        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'does not invoke the gateway when a reserved execution claim loses its locked-row race',
      async () => {
        const raceToken = 'execution-race-token';
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              ...authorizedActionInsertRow,
              tool_version: 'wave2-test',
              payload_hash: 'd'.repeat(64),
              action_token_hash: actionTokenHash(raceToken),
              token_expires_at: '2999-01-01T00:00:00.000Z',
              approval_id: null,
            },
          ],
        });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'execution-claim-race' }],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: 'execution-claim-race',
              tenant_id: tenantId,
              factory_id: factoryId,
              action_intent_id: actionId,
              execution_key: 'execution-race-key',
              tool_version: 'wave2-test',
              inputs_hash: 'd'.repeat(64),
              status: 'COMPLETED',
              failure_code: null,
              claimed_at: '2026-10-09T00:00:00.000Z',
              completed_at: '2026-10-09T00:00:01.000Z',
            },
          ],
        });

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token: raceToken,
              execution_key: 'execution-race-key',
              tool_version: 'wave2-test',
            },
          ),
        ).rejects.toThrow(
          'AI execution claim is no longer available for execution',
        );

        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(5);
        expect(String(databaseQueryMock.mock.calls[4]?.[0])).toContain('FOR UPDATE');
        expect(
          databaseQueryMock.mock.calls.some(([sql]) =>
            String(sql).includes('INSERT INTO ai_execution_records'),
          ),
        ).toBe(false);
      },
    );

    it(
      'blocks execution if an approval is revoked after claim reservation',
      async () => {
        const approvalToken = 'approval-revoked-before-execution';
        const executionKey = 'approval-race-execution';
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              ...authorizedActionInsertRow,
              tool_version: 'wave2-test',
              payload_hash: 'd'.repeat(64),
              action_token_hash: actionTokenHash(approvalToken),
              token_expires_at: '2999-01-01T00:00:00.000Z',
              approval_id: approvalId,
            },
          ],
        });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        // The initial preflight sees a valid approval.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: approvalId }],
        });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'approval-race-claim' }],
        });
        // The claim lock succeeds, but the approval is revoked before the
        // final, serialized approval check at the execution boundary.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: 'approval-race-claim',
              tenant_id: tenantId,
              factory_id: factoryId,
              action_intent_id: actionId,
              execution_key: executionKey,
              tool_version: 'wave2-test',
              inputs_hash: 'd'.repeat(64),
              status: 'CLAIMED',
              failure_code: null,
              claimed_at: '2026-10-09T00:00:00.000Z',
              completed_at: null,
            },
          ],
        });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'approval-race-claim' }],
        });

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token: approvalToken,
              execution_key: executionKey,
              tool_version: 'wave2-test',
            },
          ),
        ).rejects.toThrow(
          'AI action approval expired or was no longer approved before gateway execution',
        );

        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(8);
        expect(String(databaseQueryMock.mock.calls[6]?.[0])).toContain('FOR SHARE');
        expect(String(databaseQueryMock.mock.calls[7]?.[0])).toContain('APPROVAL_NO_LONGER_VALID');
      },
    );

    it(
      'executes the deterministic contract executor and is idempotent per action intent',
      async () => {
        /*
         * executeAction() query order:
         *   1. action lookup by token hash
         *   2. execution lookup by action intent
         *   3. execution lookup by execution key
         *   4. claim INSERT
         *   5. claim SELECT FOR UPDATE
         *   6. immutable execution INSERT
         *   7. claim completion UPDATE
         */
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_type:
                'AI.RUNTIME.NOOP',
              tool_id: 'AI.RUNTIME.NOOP',
              tool_version: 'wave2-test',
              target: {
                decision_id:
                  decisionId,
              },
              resource_type:
                'PLAN',
              resource_id:
                'plan-1',
              payload: {},
              payload_hash:
                'd'.repeat(64),
              risk_class: 'L1',
              authorization_status:
                'AUTHORIZED',
              authorization: {
                outcome: 'ALLOWED',
              },
              approval_id: null,
              action_token_hash:
                actionTokenHash(
                  'contract-token',
                ),
              token_expires_at:
                '2999-01-01T00:00:00.000Z',
              idempotency_key:
                'action-3',
              created_by: userId,
              created_at:
                '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        // Claim reservation INSERT.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'execution-claim' }],
        });

        // Lock and validate the existing claim.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: 'execution-claim',
              tenant_id: tenantId,
              factory_id: factoryId,
              action_intent_id: actionId,
              execution_key: 'execution-1',
              tool_version: 'wave2-test',
              inputs_hash: 'd'.repeat(64),
              status: 'CLAIMED',
              failure_code: null,
              claimed_at: '2026-10-07T00:00:00.000Z',
              completed_at: null,
            },
          ],
        });

        // Immutable execution record INSERT.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: executionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_intent_id:
                actionId,
              execution_key:
                'execution-1',
              executor_type:
                'AI.RUNTIME.NOOP',
              tool_version:
                'wave2-test',
              inputs_hash:
                'd'.repeat(64),
              result: {
                committed: false,
              },
              error: {},
              status:
                'SUCCEEDED',
              started_at:
                '2026-10-07T00:00:00.000Z',
              finished_at:
                '2026-10-07T00:00:01.000Z',
            },
          ],
        });

        // Claim completion UPDATE.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'execution-claim' }],
        });

        const result =
          await service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token:
                'contract-token',
              execution_key:
                'execution-1',
              tool_version:
                'wave2-test',
            },
          );

        expect(
          result.execution.status,
        ).toBe('SUCCEEDED');

        expect(
          result.execution
            .actionIntentId,
        ).toBe(actionId);

        expect(
          result.idempotent,
        ).toBe(false);

        expect(
          aiToolGateway.execute,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            toolId: 'AI.RUNTIME.NOOP',
            toolVersion: 'wave2-test',
            actionToken: 'contract-token',
            executorType: 'AI_TOOL_GATEWAY',
          }),
        );

        expect(
          databaseTransactionMock,
        ).toHaveBeenCalled();

        expect(
          databaseQueryMock,
        ).toHaveBeenCalledTimes(7);
      },
    );

    it(
      'rejects an idempotent replay when the execution key differs from the recorded request',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_type: 'AI.RUNTIME.NOOP',
              tool_id: 'AI.RUNTIME.NOOP',
              tool_version: 'wave2-test',
              target: { decision_id: decisionId },
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: {},
              payload_hash: 'd'.repeat(64),
              risk_class: 'L1',
              authorization_status: 'AUTHORIZED',
              authorization: { outcome: 'ALLOWED' },
              approval_id: null,
              action_token_hash: actionTokenHash('contract-token'),
              token_expires_at: '2999-01-01T00:00:00.000Z',
              idempotency_key: 'action-3',
              created_by: userId,
              created_at: '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: executionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_intent_id: actionId,
              execution_key: 'execution-original',
              executor_type: 'AI_TOOL_GATEWAY',
              tool_version: 'wave2-test',
              inputs_hash: 'd'.repeat(64),
              result: { committed: false },
              error: {},
              status: 'SUCCEEDED',
              started_at: '2026-10-07T00:00:00.000Z',
              finished_at: '2026-10-07T00:00:01.000Z',
            },
          ],
        });

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token: 'contract-token',
              execution_key: 'execution-different',
              tool_version: 'wave2-test',
            },
          ),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'fails closed when another request already owns the execution claim',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              decision_id: decisionId,
              action_type: 'AI.RUNTIME.NOOP',
              tool_id: 'AI.RUNTIME.NOOP',
              tool_version: 'wave2-test',
              target: { decision_id: decisionId },
              resource_type: 'PLAN',
              resource_id: 'plan-1',
              payload: {},
              payload_hash: 'd'.repeat(64),
              risk_class: 'L1',
              authorization_status: 'AUTHORIZED',
              authorization: { outcome: 'ALLOWED' },
              approval_id: null,
              action_token_hash: actionTokenHash('contract-token'),
              token_expires_at: '2999-01-01T00:00:00.000Z',
              idempotency_key: 'action-3',
              created_by: userId,
              created_at: '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({ rows: [] });
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: 'execution-claim-existing',
              tenant_id: tenantId,
              factory_id: factoryId,
              action_intent_id: actionId,
              execution_key: 'execution-1',
              tool_version: 'wave2-test',
              inputs_hash: 'd'.repeat(64),
              status: 'CLAIMED',
              failure_code: null,
              claimed_at: '2026-10-09T00:00:00.000Z',
              completed_at: null,
            },
          ],
        });

        await expect(
          service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token: 'contract-token',
              execution_key: 'execution-1',
              tool_version: 'wave2-test',
            },
          ),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(aiToolGateway.execute).not.toHaveBeenCalled();
        expect(databaseQueryMock).toHaveBeenCalledTimes(6);
      },
    );

    it(
      'fails closed for an unregistered business executor without pretending to mutate domain state',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: actionId,
              tenant_id: tenantId,
              factory_id:
                factoryId,
              decision_id:
                decisionId,
              action_type:
                'PLAN.CHANGE',
              tool_id: 'PLAN.CHANGE',
              tool_version: 'wave2-test',
              target: {
                decision_id:
                  decisionId,
              },
              resource_type:
                'PLAN',
              resource_id:
                'plan-1',
              payload: {},
              payload_hash:
                'f'.repeat(64),
              risk_class: 'L2',
              authorization_status:
                'AUTHORIZED',
              authorization: {
                outcome:
                  'ALLOWED',
              },
              approval_id: null,
              action_token_hash:
                actionTokenHash(
                  'unregistered-token',
                ),
              token_expires_at:
                '2999-01-01T00:00:00.000Z',
              idempotency_key:
                'action-4',
              created_by: userId,
              created_at:
                '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        // Claim reservation INSERT.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'execution-claim' }],
        });

        // Locked CLAIMED row selected by FOR UPDATE.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: 'execution-claim',
              tenant_id: tenantId,
              factory_id: factoryId,
              action_intent_id: actionId,
              execution_key: 'execution-2',
              tool_version: 'wave2-test',
              inputs_hash: 'f'.repeat(64),
              status: 'CLAIMED',
              failure_code: null,
              claimed_at: '2026-10-07T00:00:00.000Z',
              completed_at: null,
            },
          ],
        });

        // Immutable execution record INSERT.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: executionId,
              tenant_id: tenantId,
              factory_id:
                factoryId,
              decision_id:
                decisionId,
              action_intent_id:
                actionId,
              execution_key:
                'execution-2',
              executor_type:
                'PLAN.CHANGE',
              tool_version:
                'wave2-test',
              inputs_hash:
                'f'.repeat(64),
              result: {},
              error: {
                code:
                  'EXECUTOR_NOT_CONFIGURED',
              },
              status:
                'FAILED',
              started_at:
                '2026-10-07T00:00:00.000Z',
              finished_at:
                '2026-10-07T00:00:01.000Z',
            },
          ],
        });

        // Claim completion UPDATE.
        databaseQueryMock.mockResolvedValueOnce({
          rows: [{ id: 'execution-claim' }],
        });

        const result =
          await service.executeAction(
            tenantId,
            factoryId,
            userId,
            {
              action_token:
                'unregistered-token',
              execution_key:
                'execution-2',
              tool_version:
                'wave2-test',
            },
          );

        expect(
          result.execution.status,
        ).toBe('FAILED');

        expect(
          result.execution.error
            .code,
        ).toBe(
          'EXECUTOR_NOT_CONFIGURED',
        );

        const claimCompletionCall =
          databaseQueryMock.mock.calls[6];

        const claimCompletionSql =
          String(claimCompletionCall?.[0]);

        expect(claimCompletionSql).toContain(
          'UPDATE ai_execution_claims',
        );

        expect(claimCompletionSql).toContain(
          "WHEN $5 = 'SUCCEEDED' THEN 'COMPLETED'",
        );

        expect(claimCompletionSql).toContain(
          "WHEN $5 = 'FAILED' THEN 'TOOL_EXECUTION_FAILED'",
        );

        expect(
          claimCompletionCall?.[1]?.[4],
        ).toBe('FAILED');

        expect(
          databaseTransactionMock,
        ).toHaveBeenCalled();

        expect(
          databaseQueryMock,
        ).toHaveBeenCalledTimes(7);
      },
    );

    it(
      'rejects a failed release gate even when an approval exists',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: approvalId,
              tenant_id:
                tenantId,
              policy_id:
                policyId,
              risk_class_id:
                '6f1adddd-dddd-4ddd-8ddd-dddddddddddd',
              action:
                'AI.RELEASE',
              resource_type:
                'MODEL_ARTIFACT',
              resource_id:
                'artifact-1',
              status:
                'APPROVED',
              expires_at:
                null,
            },
          ],
        });

        await expect(
          service.createRelease(
            tenantId,
            factoryId,
            userId,
            {
              artifact_type:
                'PROMPT',
              artifact_key:
                'plan-policy',
              version: '2',
              tests: {
                passed: false,
              },
              approval_id:
                approvalId,
            },
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );
      },
    );

    it(
      'records learning signals only against a tenant-scoped decision',
      async () => {
        /*
         * createLearningSignal() query order:
         *   1. source decision lookup
         *   2. learning signal INSERT
         */
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: learningId,
              tenant_id:
                tenantId,
              factory_id:
                factoryId,
              source_decision_id:
                decisionId,
              source_outcome_id:
                null,
              source_execution_id:
                null,
              signal_type:
                'CORRECTION',
              label:
                'Planner correction',
              confidence: 0.9,
              tenant_scope:
                'TENANT',
              payload: {
                corrected: true,
              },
              created_by:
                userId,
              created_at:
                '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        const result =
          await service.createLearningSignal(
            tenantId,
            factoryId,
            userId,
            {
              source_decision_id:
                decisionId,
              signal_type:
                'CORRECTION',
              label:
                'Planner correction',
              confidence: 0.9,
              payload: {
                corrected:
                  true,
              },
            },
          );

        expect(
          result.learningSignal.id,
        ).toBe(learningId);

        expect(
          result.learningSignal
            .tenantScope,
        ).toBe('TENANT');
      },
    );

    it(
      'captures an observed outcome against a decision',
      async () => {
        /*
         * createOutcome() query order:
         *   1. decision lookup
         *   2. outcome INSERT
         */
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: outcomeId,
              tenant_id:
                tenantId,
              factory_id:
                factoryId,
              decision_id:
                decisionId,
              action_intent_id:
                null,
              execution_record_id:
                null,
              expected_metric: {
                margin: 20,
              },
              actual_metric: {
                margin: 18,
              },
              outcome_window: {
                hours: 24,
              },
              causal_notes:
                'Observed result',
              status:
                'OBSERVED',
              created_by:
                userId,
              created_at:
                '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        const result =
          await service.createOutcome(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
              expected_metric: {
                margin: 20,
              },
              actual_metric: {
                margin: 18,
              },
              outcome_window: {
                hours: 24,
              },
              causal_notes:
                'Observed result',
            },
          );

        expect(
          result.outcome.id,
        ).toBe(outcomeId);

        expect(
          result.outcome.status,
        ).toBe('OBSERVED');
      },
    );

    it(
      'replays the material decision lifecycle without exposing action tokens',
      async () => {
        /*
         * replayDecision() performs:
         *   1. decision lookup by trace
         *   2. context query
         *   3. verification query
         *   4. action query
         *   5. execution query
         *   6. outcome query
         *   7. learning query
         *   8. release query
         *   9. lifecycle state
         *  10. ordered lifecycle events
         *  11. normalized context evidence references
         *
         * Only the first result contains the decision. The remaining
         * lifecycle collections are intentionally empty for this replay case.
         */
        databaseQueryMock.mockResolvedValueOnce({
          rows: [decisionRow],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({ rows: [] }); // lifecycle state
        databaseQueryMock.mockResolvedValueOnce({ rows: [] }); // lifecycle events
        databaseQueryMock.mockResolvedValueOnce({ rows: [] }); // evidence refs

        const result =
          await service.replayDecision(
            tenantId,
            factoryId,
            userId,
            decisionRow.trace_id,
          );

        expect(
          result.replay.traceId,
        ).toBe(
          decisionRow.trace_id,
        );

        expect(
          result.replay.decision.id,
        ).toBe(
          decisionId,
        );

        expect(
          result.replay.actions,
        ).toEqual([]);

        expect(
          result.replayHash,
        ).toEqual(
          expect.stringMatching(
            /^[0-9a-f]{64}$/,
          ),
        );
      },
    );
  },
);