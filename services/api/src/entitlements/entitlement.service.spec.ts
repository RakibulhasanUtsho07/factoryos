import { jest } from '@jest/globals';

import {
  EntitlementService,
} from './entitlement.service';

type MockQueryResult = {
  rowCount: number;

  rows: Array<
    Record<
      string,
      unknown
    >
  >;
};

type MockQuery = (
  ...args: unknown[]
) => Promise<
  MockQueryResult
>;

function createMockClient() {
  const query =
    jest.fn<MockQuery>();

  return {
    query,
  };
}

function createMockDatabase(
  client: ReturnType<
    typeof createMockClient
  >,
) {
  const transaction =
    jest.fn(
      async (
        contextOrCallback:
          | unknown
          | ((
              client: ReturnType<
                typeof createMockClient
              >,
            ) => Promise<unknown>),

        maybeCallback?:
          | ((
              client: ReturnType<
                typeof createMockClient
              >,
            ) => Promise<unknown>)
          | unknown,
      ) => {
        const callback =
          typeof contextOrCallback ===
          'function'
            ? contextOrCallback
            : maybeCallback;

        if (
          typeof callback !==
          'function'
        ) {
          throw new TypeError(
            'Mock transaction callback missing',
          );
        }

        return callback(
          client,
        );
      },
    );

  const query =
    jest.fn<MockQuery>();

  return {
    transaction,

    query,
  };
}

describe(
  'EntitlementService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const userId =
      '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

    const auditService = {
      record:
        jest.fn(
          async () =>
            'audit-001',
        ),
    };

    beforeEach(
      () => {
        jest.clearAllMocks();
      },
    );

    // ============================================================
    // CREATE
    // ============================================================

    it(
      'creates version 1 for a new entitlement',
      async () => {
        const client =
          createMockClient();

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              next_version:
                '1',
            },
          ],
        });

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              id:
                'entitlement-001',

              tenant_id:
                tenantId,

              package:
                'PRO',

              feature_key:
                'ai.copilot',

              limit_value:
                '100',

              period:
                'MONTH',

              version:
                '1',

              status:
                'ACTIVE',

              effective_from:
                '2026-10-06T00:00:00.000Z',

              effective_to:
                null,

              config: {
                model:
                  'default',
              },

              created_by:
                userId,

              created_at:
                '2026-10-06T00:00:00.000Z',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createEntitlement(
            tenantId,

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',

              limitValue:
                100,

              period:
                'MONTH',

              config: {
                model:
                  'default',
              },
            },
          );

        expect(
          result,
        ).toEqual({
          id:
            'entitlement-001',

          tenantId:
            tenantId,

          package:
            'PRO',

          featureKey:
            'ai.copilot',

          limitValue:
            100,

          period:
            'MONTH',

          version:
            1,

          status:
            'ACTIVE',

          effectiveFrom:
            '2026-10-06T00:00:00.000Z',

          effectiveTo:
            null,

          config: {
            model:
              'default',
          },

          createdBy:
            userId,

          createdAt:
            '2026-10-06T00:00:00.000Z',
        });

        expect(
          database.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditService.record,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    // ============================================================
    // NEXT VERSION
    // ============================================================

    it(
      'creates the next immutable version',
      async () => {
        const client =
          createMockClient();

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              next_version:
                '2',
            },
          ],
        });

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              id:
                'entitlement-002',

              tenant_id:
                tenantId,

              package:
                'PRO',

              feature_key:
                'ai.copilot',

              limit_value:
                '250',

              period:
                'MONTH',

              version:
                '2',

              status:
                'ACTIVE',

              effective_from:
                '2026-11-01T00:00:00.000Z',

              effective_to:
                null,

              config: {},

              created_by:
                userId,

              created_at:
                '2026-10-06T00:00:00.000Z',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createEntitlement(
            tenantId,

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',

              limitValue:
                250,

              period:
                'MONTH',

              effectiveFrom:
                '2026-11-01T00:00:00.000Z',
            },
          );

        expect(
          result.version,
        ).toBe(2);

        expect(
          result.limitValue,
        ).toBe(250);

        expect(
          database.transaction,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          client.query,
        ).toHaveBeenCalledTimes(
          2,
        );
      },
    );

    // ============================================================
    // CONCURRENCY RETRY
    // ============================================================

    it(
      'retries after a PostgreSQL unique violation',
      async () => {
        const client =
          createMockClient();

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              next_version:
                '2',
            },
          ],
        });

        const uniqueViolation =
          Object.assign(
            new Error(
              'duplicate key',
            ),
            {
              code:
                '23505',
            },
          );

        client.query.mockRejectedValueOnce(
          uniqueViolation,
        );

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              next_version:
                '3',
            },
          ],
        });

        client.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              id:
                'entitlement-003',

              tenant_id:
                tenantId,

              package:
                'PRO',

              feature_key:
                'ai.copilot',

              limit_value:
                '300',

              period:
                'MONTH',

              version:
                '3',

              status:
                'ACTIVE',

              effective_from:
                '2026-12-01T00:00:00.000Z',

              effective_to:
                null,

              config: {},

              created_by:
                userId,

              created_at:
                '2026-10-06T00:00:00.000Z',
            },
          ],
        });

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createEntitlement(
            tenantId,

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',

              limitValue:
                300,

              period:
                'MONTH',

              effectiveFrom:
                '2026-12-01T00:00:00.000Z',
            },
          );

        expect(
          result.version,
        ).toBe(3);

        expect(
          result.limitValue,
        ).toBe(300);

        expect(
          database.transaction,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          client.query,
        ).toHaveBeenCalledTimes(
          4,
        );
      },
    );

    // ============================================================
    // VALIDATION
    // ============================================================

    it(
      'rejects an invalid tenant UUID',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createEntitlement(
            'not-a-uuid',

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',
            },
          ),
        ).rejects.toThrow(
          'tenantId must be a valid UUID',
        );

        expect(
          database.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects a negative limit',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createEntitlement(
            tenantId,

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',

              limitValue:
                -1,
            },
          ),
        ).rejects.toThrow(
          'limitValue must be greater than or equal to zero',
        );

        expect(
          database.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects an invalid effective window',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createEntitlement(
            tenantId,

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',

              effectiveFrom:
                '2026-12-01T00:00:00.000Z',

              effectiveTo:
                '2026-11-01T00:00:00.000Z',
            },
          ),
        ).rejects.toThrow(
          'effectiveTo must be later than effectiveFrom',
        );

        expect(
          database.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects an invalid status',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createEntitlement(
            tenantId,

            userId,

            {
              package:
                'PRO',

              featureKey:
                'ai.copilot',

              status:
                'INVALID' as never,
            },
          ),
        ).rejects.toThrow(
          'status must be ACTIVE, DISABLED, or EXPIRED',
        );
      },
    );

    // ============================================================
    // RESOLUTION
    // ============================================================

    it(
      'treats a missing effective entitlement as not entitled',
      async () => {
        const client =
          createMockClient();

        const database =
          createMockDatabase(
            client,
          );

        /*
         * IMPORTANT:
         *
         * resolveEntitlement() calls database.query()
         * directly.
         *
         * Therefore this mock MUST be attached to
         * database.query(), not client.query().
         */
        database.query.mockResolvedValueOnce({
          rowCount:
            0,

          rows: [],
        });

        const service =
          new EntitlementService(
            database as never,

            auditService as never,
          );

        const result =
          await service.resolveEntitlement(
            tenantId,

            'PRO',

            'ai.copilot',
          );

        expect(
          result,
        ).toBeNull();

        expect(
          database.query,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          database.transaction,
        ).not.toHaveBeenCalled();
      },
    );
  },
);