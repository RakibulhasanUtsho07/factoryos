import {
  jest,
} from '@jest/globals';

import {
  createHash,
} from 'node:crypto';

import {
  AiToolGatewayService,
} from './ai.tool.gateway.service';

import type {
  AiToolActionContext,
  AiToolDefinition,
} from './ai.tool.types';

describe(
  'AiToolGatewayService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const factoryId =
      '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';

    const actorUserId =
      '7fa03a36-6e3e-45ff-8f48-9ce3e2af0002';

    const actionIntentId =
      '8fa03a36-6e3e-45ff-8f48-9ce3e2af0003';

    const decisionId =
      '9fa03a36-4e3e-45ff-8f48-9ce3e2af0004';

    const actionToken =
      '11111111-2222-4333-8444-555555555555';

    /**
     * Keep the test hash calculation aligned with the
     * runtime token-binding contract.
     *
     * Raw action tokens are never persisted.
     */
    const actionTokenHash =
      createHash('sha256')
        .update(
          JSON.stringify(
            actionToken,
          ),
          'utf8',
        )
        .digest('hex');

    const registry = {
      getTool:
        jest.fn<
          (
            ...args: unknown[]
          ) => Promise<AiToolDefinition>
        >(),
    };

    const iamService = {
      authorize:
        jest.fn<
          (
            ...args: unknown[]
          ) => Promise<void>
        >(),
    };

    let gateway:
      AiToolGatewayService;

    beforeEach(
      () => {
        jest.resetAllMocks();

        iamService.authorize
          .mockResolvedValue(
            undefined,
          );

        gateway =
          new AiToolGatewayService(
            registry as never,
            iamService as never,
          );
      },
    );

    function buildTool(
      overrides:
        Partial<AiToolDefinition> =
        {},
    ): AiToolDefinition {
      return {
        id:
          'tool-id',

        tenantId:
          null,

        factoryId:
          null,

        toolId:
          'AI.RUNTIME.NOOP',

        version:
          '1.0.0',

        inputSchema: {
          type:
            'object',

          additionalProperties:
            true,
        },

        outputSchema: {
          type:
            'object',

          required: [
            'execution',
            'executorType',
            'actionType',
            'committed',
          ],

          properties: {
            execution: {
              type:
                'string',
            },

            executorType: {
              type:
                'string',
            },

            actionType: {
              type:
                'string',
            },

            committed: {
              type:
                'boolean',
            },
          },

          additionalProperties:
            true,
        },

        riskClass:
          'L0',

        requiredScopes: [
          'ai.actions.execute',
        ],

        approvalMode:
          'none',

        writeCapable:
          false,

        idempotencyRequired:
          false,

        timeoutMs:
          1000,

        auditMode:
          'REDACTED',

        rollback: {
          type:
            'NONE',
        },

        status:
          'ACTIVE',

        metadata: {},

        createdBy:
          null,

        createdAt:
          '2026-10-07T00:00:00.000Z',

        updatedAt:
          '2026-10-07T00:00:00.000Z',

        ...overrides,
      };
    }

    type TestAiToolActionContext =
      AiToolActionContext & {
        executionKey:
          string;
      };

    function buildAction(
      overrides:
        Partial<TestAiToolActionContext> =
        {},
    ): TestAiToolActionContext {
      /**
       * Keep toolId and actionType aligned by default.
       *
       * The gateway validates that the action tool id
       * exactly matches the registered tool id.
       *
       * This also allows tests that override only actionType
       * to remain internally consistent without duplicating
       * toolId in every test case.
       */
      const resolvedActionType =
        overrides.actionType ??
        'AI.RUNTIME.NOOP';

      const resolvedToolId =
        overrides.toolId ??
        resolvedActionType;

      return {
        tenantId,

        factoryId,

        actorUserId,

        actionIntentId,

        decisionId,

        toolId:
          resolvedToolId,

        actionType:
          resolvedActionType,

        target:
          {},

        resourceType:
          null,

        resourceId:
          null,

        payload:
          {
            sample:
              'value',
          },

        payloadHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',

        riskClass:
          'L0',

        authorizationStatus:
          'AUTHORIZED',

        approvalId:
          null,

        actionToken,

        actionTokenHash,

        tokenExpiresAt:
          '2099-01-01T00:00:00.000Z',

        idempotencyKey:
          null,

        executionKey:
          'execution-001',

        toolVersion:
          '1.0.0',

        executorType:
          'AI.RUNTIME.NOOP',

        ...overrides,
      };
    }

    it(
      'executes the registered no-side-effect tool and re-checks required IAM scope',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool(),
        );

        const result =
          await gateway.execute(
            buildAction(),
          );

        expect(
          result.status,
        ).toBe(
          'SUCCEEDED',
        );

        expect(
          result.result.execution,
        ).toBe(
          'NO_SIDE_EFFECT',
        );

        expect(
          result.result.committed,
        ).toBe(
          false,
        );

        expect(
          iamService.authorize,
        ).toHaveBeenCalledWith(
          actorUserId,
          tenantId,
          'ai.actions.execute',
          factoryId,
        );
      },
    );

    it(
      'fails closed when the action risk class does not match the registered tool',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool({
            riskClass:
              'L1',
          }),
        );

        await expect(
          gateway.execute(
            buildAction({
              riskClass:
                'L0',
            }),
          ),
        ).rejects.toThrow(
          'AI action risk class does not match the registered tool risk class',
        );
      },
    );

    it(
      'fails closed when the token binding does not match',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool(),
        );

        await expect(
          gateway.execute(
            buildAction({
              actionTokenHash:
                'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            }),
          ),
        ).rejects.toThrow(
          'AI action token binding is invalid',
        );
      },
    );

    it(
      'fails closed when a write-capable registered tool has no idempotency key',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool({
            toolId:
              'WRITE.TEST',

            writeCapable:
              true,

            idempotencyRequired:
              true,

            rollback: {
              type:
                'COMPENSATION',

              metadata: {
                contract:
                  'test',
              },
            },

            riskClass:
              'L2',
          }),
        );

        await expect(
          gateway.execute(
            buildAction({
              actionType:
                'WRITE.TEST',

              riskClass:
                'L2',
            }),
          ),
        ).rejects.toThrow(
          'Registered AI tool requires an idempotency key',
        );
      },
    );

    it(
      'requires approval binding when the registry approval mode requires it',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool({
            approvalMode:
              'role',
          }),
        );

        await expect(
          gateway.execute(
            buildAction(),
          ),
        ).rejects.toThrow(
          'Registered AI tool requires an approval binding',
        );
      },
    );

    it(
      'rejects expired action tokens',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool(),
        );

        await expect(
          gateway.execute(
            buildAction({
              tokenExpiresAt:
                '2020-01-01T00:00:00.000Z',
            }),
          ),
        ).rejects.toThrow(
          'AI action token has expired',
        );
      },
    );

    it(
      'returns fail-closed executor error for an active but unimplemented tool',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool({
            toolId:
              'FUTURE.DOMAIN.TOOL',
          }),
        );

        const result =
          await gateway.execute(
            buildAction({
              actionType:
                'FUTURE.DOMAIN.TOOL',
            }),
          );

        expect(
          result.status,
        ).toBe(
          'FAILED',
        );

        expect(
          result.error.code,
        ).toBe(
          'EXECUTOR_NOT_CONFIGURED',
        );
      },
    );

    it(
      'rejects payloads that violate the registered input schema',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool({
            inputSchema: {
              type:
                'object',

              properties: {
                count: {
                  type:
                    'integer',

                  minimum:
                    1,
                },
              },

              required: [
                'count',
              ],

              additionalProperties:
                false,
            },
          }),
        );

        await expect(
          gateway.execute(
            buildAction({
              payload: {
                unexpected:
                  true,
              },
            }),
          ),
        ).rejects.toThrow(
          '$.payload.count is required by the registered tool schema',
        );
      },
    );

    it(
      'rejects an unauthorized action before tool execution',
      async () => {
        registry.getTool.mockResolvedValue(
          buildTool(),
        );

        await expect(
          gateway.execute(
            buildAction({
              authorizationStatus:
                'APPROVAL_REQUIRED',
            }),
          ),
        ).rejects.toThrow(
          'AI action is not authorized for Tool Gateway execution',
        );

        expect(
          iamService.authorize,
        ).not.toHaveBeenCalled();
      },
    );
  },
);