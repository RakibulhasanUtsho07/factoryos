import { jest } from '@jest/globals';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  AiAgentStudioPolicySimulationService,
} from './ai.agent.studio.policy.simulation.service';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';

const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

const sandboxId =
  '7f1a2222-2222-4222-8222-222222222222';

const traceId =
  '6f1a2222-2222-4222-8222-222222222222';

const simulationId =
  '8f1a2222-2222-4222-8222-222222222222';

const database = {
  query: jest.fn<() => Promise<unknown>>(),
  transaction: jest.fn<() => Promise<unknown>>(),
};

const iamService = {
  authorize: jest.fn<() => Promise<void>>(),
};

const policyService = {
  evaluatePolicy: jest.fn<() => Promise<unknown>>(),
};

const auditService = {
  record: jest.fn<() => Promise<string>>(),
};

function sandboxRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: sandboxId,
    tenant_id: tenantId,
    factory_id: factoryId,
    mode: 'SIMULATION',
    live_write_allowed: false,
    status: 'COMPLETED',
    ...overrides,
  };
}

function simulationRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: simulationId,
    sandbox_id: sandboxId,
    status: 'COMPLETED',
    plan: [],
    simulated_tool_responses: {},
    observations: [],
    result: {},
    started_at:
      '2026-10-08T00:00:00.000Z',
    finished_at:
      '2026-10-08T00:00:00.010Z',
    created_by: userId,
    trace_id: traceId,
    created_at:
      '2026-10-08T00:00:00.010Z',
    ...overrides,
  };
}

function makeService() {
  return new AiAgentStudioPolicySimulationService(
    database as never,
    iamService as never,
    policyService as never,
    auditService as never,
  );
}

function evaluation(
  overrides: Record<string, unknown> = {},
) {
  return {
    outcome: 'ALLOWED',
    risk: {
      class: 'L1',
      policyRef: {
        id:
          '11111111-1111-4111-8111-111111111111',
        key: 'INVENTORY.ADJUST',
        version: '2',
      },
      approvalRequired: false,
    },
    policy: {},
    safeDefault: false,
    reason: 'Matching ALLOW policy',
    ...overrides,
  };
}

describe(
  'AiAgentStudioPolicySimulationService',
  () => {
    beforeEach(() => {
      jest.clearAllMocks();

      iamService.authorize.mockResolvedValue(
        undefined,
      );

      auditService.record.mockResolvedValue(
        'audit-id',
      );

      database.query.mockResolvedValue({
        rows: [sandboxRow()],
      });

      policyService.evaluatePolicy.mockResolvedValue(
        evaluation(),
      );

      database.transaction.mockImplementation(
        async (callback) =>
          callback({
            query: jest
              .fn<() => Promise<unknown>>()
              .mockResolvedValue({
                rows: [simulationRow()],
              }),
          } as never),
      );
    });

    it(
      'simulates historical events without live execution',
      async () => {
        const service = makeService();

        const result =
          await service.simulateHistoricalPolicies(
            tenantId,
            factoryId,
            userId,
            sandboxId,
            traceId,
            [
              {
                eventKey: 'event-1',
                action: 'INVENTORY.ADJUST',
                resourceType: 'INVENTORY_ITEM',
                attributes: {
                  quantity: 5,
                },
                effectiveAt:
                  '2026-01-01T00:00:00.000Z',
                expectedOutcome:
                  'ALLOWED',
              },
            ],
          );

        expect(
          policyService.evaluatePolicy,
        ).toHaveBeenCalledWith(
          tenantId,
          expect.objectContaining({
            action: 'INVENTORY.ADJUST',
            resourceType:
              'INVENTORY_ITEM',
            effectiveAt:
              '2026-01-01T00:00:00.000Z',
          }),
        );

        expect(
          result.status,
        ).toBe('COMPLETED');

        expect(
          result.recommendation,
        ).toBe('READY_FOR_REVIEW');

        expect(
          result.allExpectedOutcomesMatched,
        ).toBe(true);

        expect(
          database.transaction,
        ).toHaveBeenCalled();

        expect(
          auditService.record,
        ).toHaveBeenCalled();

        // No Tool Gateway is injected or called.
      },
    );

    it(
      'detects policy drift from an expected historical outcome',
      async () => {
        const service = makeService();

        policyService.evaluatePolicy.mockResolvedValue(
          evaluation({
            outcome: 'DENIED',
            risk: {
              class: 'L2',
              policyRef: null,
              approvalRequired: false,
            },
            safeDefault: false,
            reason:
              'No matching policy; fail closed',
          }),
        );

        const result =
          await service.simulateHistoricalPolicies(
            tenantId,
            factoryId,
            userId,
            sandboxId,
            traceId,
            [
              {
                eventKey: 'event-drift',
                action: 'PURCHASE.ORDER.CREATE',
                effectiveAt:
                  '2026-02-01T00:00:00.000Z',
                expectedOutcome:
                  'ALLOWED',
              },
            ],
          );

        expect(
          result.status,
        ).toBe('BLOCKED');

        expect(
          result.recommendation,
        ).toBe(
          'POLICY_DRIFT_DETECTED',
        );

        expect(
          result.expectedOutcomeDriftCount,
        ).toBe(1);
      },
    );

    it(
      'blocks a sandbox that is not simulation-only',
      async () => {
        const service = makeService();

        database.query.mockResolvedValue({
          rows: [
            sandboxRow({
              live_write_allowed: true,
            }),
          ],
        });

        await expect(
          service.simulateHistoricalPolicies(
            tenantId,
            factoryId,
            userId,
            sandboxId,
            traceId,
            [
              {
                eventKey: 'event-1',
                action: 'TEST.ACTION',
                effectiveAt:
                  '2026-01-01T00:00:00.000Z',
              },
            ],
          ),
        ).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      },
    );

    it(
      'returns not found for a sandbox outside the tenant/factory scope',
      async () => {
        const service = makeService();

        database.query.mockResolvedValue({
          rows: [],
        });

        await expect(
          service.simulateHistoricalPolicies(
            tenantId,
            factoryId,
            userId,
            sandboxId,
            traceId,
            [
              {
                eventKey: 'event-1',
                action: 'TEST.ACTION',
                effectiveAt:
                  '2026-01-01T00:00:00.000Z',
              },
            ],
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it(
      'rejects an invalid tenant before IAM or DB access',
      async () => {
        const service = makeService();

        await expect(
          service.simulateHistoricalPolicies(
            'not-a-tenant',
            factoryId,
            userId,
            sandboxId,
            traceId,
            [
              {
                eventKey: 'event-1',
                action: 'TEST.ACTION',
                effectiveAt:
                  '2026-01-01T00:00:00.000Z',
              },
            ],
          ),
        ).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(
          iamService.authorize,
        ).not.toHaveBeenCalled();

        expect(
          database.query,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects an invalid historical date',
      async () => {
        const service = makeService();

        await expect(
          service.simulateHistoricalPolicies(
            tenantId,
            factoryId,
            userId,
            sandboxId,
            traceId,
            [
              {
                eventKey: 'event-1',
                action: 'TEST.ACTION',
                effectiveAt: 'invalid',
              },
            ],
          ),
        ).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(
          policyService.evaluatePolicy,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects more than 100 historical events',
      async () => {
        const service = makeService();

        const events = Array.from(
          { length: 101 },
          (_, index) => ({
            eventKey: `event-${index}`,
            action: 'TEST.ACTION',
            effectiveAt:
              '2026-01-01T00:00:00.000Z',
          }),
        );

        await expect(
          service.simulateHistoricalPolicies(
            tenantId,
            factoryId,
            userId,
            sandboxId,
            traceId,
            events,
          ),
        ).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(
          policyService.evaluatePolicy,
        ).not.toHaveBeenCalled();
      },
    );
  },
);
