import { jest } from '@jest/globals';

import {
  UnauthorizedException,
} from '@nestjs/common';

import {
  AiAgentStudioPolicySimulationController,
} from './ai.agent.studio.policy.simulation.controller';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';

const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

const traceId =
  '6f1a2222-2222-4222-8222-222222222222';

const sandboxId =
  '7f1a2222-2222-4222-8222-222222222222';

const service = {
  simulateHistoricalPolicies:
    jest.fn<() => Promise<unknown>>(),
};

describe(
  'AiAgentStudioPolicySimulationController',
  () => {
    beforeEach(() => {
      jest.clearAllMocks();

      service.simulateHistoricalPolicies.mockResolvedValue(
        {
          status: 'COMPLETED',
          sandboxId,
          simulationRunId:
            '8f1a2222-2222-4222-8222-222222222222',
        },
      );
    });

    it(
      'maps authenticated context and historical events',
      async () => {
        const controller =
          new AiAgentStudioPolicySimulationController(
            service as never,
          );

        const result =
          await controller.simulateHistoricalPolicies(
            {
              factoryos: {
                traceId,
                userId,
                tenantId,
                factoryId,
              },
            } as never,
            sandboxId,
            {
              historical_events: [
                {
                  event_key: 'event-1',
                  action: 'TEST.ACTION',
                  resource_type:
                    'TEST_RESOURCE',
                  attributes: {
                    region: 'BD',
                  },
                  effective_at:
                    '2026-01-01T00:00:00.000Z',
                  expected_outcome:
                    'ALLOWED',
                },
              ],
            },
          );

        expect(result).toEqual(
          expect.objectContaining({
            status: 'COMPLETED',
          }),
        );

        expect(
          service.simulateHistoricalPolicies,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          userId,
          sandboxId,
          traceId,
          [
            {
              eventKey: 'event-1',
              action: 'TEST.ACTION',
              resourceType:
                'TEST_RESOURCE',
              attributes: {
                region: 'BD',
              },
              effectiveAt:
                '2026-01-01T00:00:00.000Z',
              expectedOutcome:
                'ALLOWED',
            },
          ],
        );
      },
    );

    it(
      'fails closed when authenticated context is missing',
      async () => {
        const controller =
          new AiAgentStudioPolicySimulationController(
            service as never,
          );

        await expect(
          controller.simulateHistoricalPolicies(
            {
              factoryos: {
                traceId,
              },
            } as never,
            sandboxId,
            {
              historical_events: [
                {
                  event_key: 'event-1',
                  action: 'TEST.ACTION',
                  effective_at:
                    '2026-01-01T00:00:00.000Z',
                },
              ],
            },
          ),
        ).rejects.toBeInstanceOf(
          UnauthorizedException,
        );

        expect(
          service.simulateHistoricalPolicies,
        ).not.toHaveBeenCalled();
      },
    );
  },
);
