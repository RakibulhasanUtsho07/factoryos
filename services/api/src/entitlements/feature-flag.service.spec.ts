import { jest } from '@jest/globals';

import {
  FeatureFlagService,
} from './feature-flag.service';

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
  'FeatureFlagService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const userId =
      '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

    const auditService = {
      record:
        jest.fn(
          async () =>
            undefined,
        ),
    };

    beforeEach(
      () => {
        jest.clearAllMocks();
      },
    );

    // ==========================================================
    // CREATE
    // ==========================================================

    it(
      'creates version 1 for a normal feature flag',
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
                'flag-001',

              tenant_id:
                tenantId,

              key:
                'enable_growth_engine',

              version:
                '1',

              enabled:
                true,

              config: {
                rollout:
                  100,
              },

              owner:
                'product',

              security_critical:
                false,

              change_reason:
                null,

              effective_from:
                '2026-10-06T00:00:00.000Z',

              expires_at:
                null,

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
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'enable_growth_engine',

              enabled:
                true,

              owner:
                'product',

              config: {
                rollout:
                  100,
              },
            },
          );

        expect(
          result,
        ).toEqual({
          id:
            'flag-001',

          tenantId:
            tenantId,

          key:
            'enable_growth_engine',

          version:
            1,

          enabled:
            true,

          config: {
            rollout:
              100,
          },

          owner:
            'product',

          securityCritical:
            false,

          changeReason:
            null,

          effectiveFrom:
            '2026-10-06T00:00:00.000Z',

          expiresAt:
            null,

          createdBy:
            userId,

          createdAt:
            '2026-10-06T00:00:00.000Z',
        });

        expect(
          auditService.record,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    // ==========================================================
    // SECURITY-CRITICAL FLAG
    // ==========================================================

    it(
      'rejects a security-critical flag without privileged authorization',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'disable_tool_finance_write',

              enabled:
                true,

              owner:
                'security',

              securityCritical:
                true,

              changeReason:
                'Emergency security control test',
            },
          ),
        ).rejects.toThrow(
          'Privileged authorization is required for security-critical feature flag changes',
        );

        expect(
          database.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects a security-critical flag without a reason',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'disable_tool_finance_write',

              enabled:
                true,

              owner:
                'security',

              securityCritical:
                true,
            },

            {
              securityCriticalChangeAuthorized:
                true,
            },
          ),
        ).rejects.toThrow(
          'changeReason is required for security-critical feature flags',
        );

        expect(
          database.transaction,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'allows a security-critical flag with privileged authorization and reason',
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
                'flag-security-001',

              tenant_id:
                tenantId,

              key:
                'disable_tool_finance_write',

              version:
                '1',

              enabled:
                true,

              config: {},

              owner:
                'security',

              security_critical:
                true,

              change_reason:
                'Emergency security control test',

              effective_from:
                '2026-10-06T00:00:00.000Z',

              expires_at:
                null,

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
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'disable_tool_finance_write',

              enabled:
                true,

              owner:
                'security',

              securityCritical:
                true,

              changeReason:
                'Emergency security control test',
            },

            {
              securityCriticalChangeAuthorized:
                true,
            },
          );

        expect(
          result.securityCritical,
        ).toBe(true);

        expect(
          result.changeReason,
        ).toBe(
          'Emergency security control test',
        );
      },
    );

    // ==========================================================
    // VERSIONING
    // ==========================================================

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
                'flag-002',

              tenant_id:
                tenantId,

              key:
                'enable_growth_engine',

              version:
                '2',

              enabled:
                false,

              config: {},

              owner:
                'product',

              security_critical:
                false,

              change_reason:
                null,

              effective_from:
                '2026-11-01T00:00:00.000Z',

              expires_at:
                null,

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
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'enable_growth_engine',

              enabled:
                false,

              owner:
                'product',

              effectiveFrom:
                '2026-11-01T00:00:00.000Z',
            },
          );

        expect(
          result.version,
        ).toBe(2);

        expect(
          result.enabled,
        ).toBe(false);
      },
    );

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
                'flag-003',

              tenant_id:
                tenantId,

              key:
                'tenant_abc_ai_copilot_v2',

              version:
                '3',

              enabled:
                true,

              config: {},

              owner:
                'product',

              security_critical:
                false,

              change_reason:
                null,

              effective_from:
                '2026-12-01T00:00:00.000Z',

              expires_at:
                null,

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
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'tenant_abc_ai_copilot_v2',

              enabled:
                true,

              owner:
                'product',

              effectiveFrom:
                '2026-12-01T00:00:00.000Z',
            },
          );

        expect(
          result.version,
        ).toBe(3);

        expect(
          database.transaction,
        ).toHaveBeenCalledTimes(
          2,
        );
      },
    );

    // ==========================================================
    // RESOLUTION
    // ==========================================================

    it(
      'returns the enabled state of an active flag',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        database.query.mockResolvedValueOnce({
          rowCount:
            1,

          rows: [
            {
              id:
                'flag-resolve-001',

              tenant_id:
                tenantId,

              key:
                'enable_growth_engine',

              version:
                '2',

              enabled:
                true,

              config: {
                rollout:
                  100,
              },

              owner:
                'product',

              security_critical:
                false,

              change_reason:
                null,

              effective_from:
                '2026-10-01T00:00:00.000Z',

              expires_at:
                null,

              created_by:
                userId,

              created_at:
                '2026-10-01T00:00:00.000Z',
            },
          ],
        });

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.resolveFeatureFlag(
            tenantId,

            'enable_growth_engine',
          );

        expect(
          result,
        ).toEqual({
          enabled:
            true,

          safeDefault:
            false,

          flag: {
            id:
              'flag-resolve-001',

            tenantId:
              tenantId,

            key:
              'enable_growth_engine',

            version:
              2,

            enabled:
              true,

            config: {
              rollout:
                100,
            },

            owner:
              'product',

            securityCritical:
              false,

            changeReason:
              null,

            effectiveFrom:
              '2026-10-01T00:00:00.000Z',

            expiresAt:
              null,

            createdBy:
              userId,

            createdAt:
              '2026-10-01T00:00:00.000Z',
          },
        });
      },
    );

    it(
      'returns disabled safe default when the flag does not exist',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        database.query.mockResolvedValueOnce({
          rowCount:
            0,

          rows: [],
        });

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.resolveFeatureFlag(
            tenantId,

            'missing.flag',
          );

        expect(
          result.enabled,
        ).toBe(false);

        expect(
          result.flag,
        ).toBeNull();

        expect(
          result.safeDefault,
        ).toBe(true);
      },
    );

    it(
      'returns disabled safe default when evaluation fails',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        database.query.mockRejectedValueOnce(
          new Error(
            'DATABASE_UNAVAILABLE',
          ),
        );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.resolveFeatureFlag(
            tenantId,

            'enable_growth_engine',
          );

        expect(
          result,
        ).toEqual({
          enabled:
            false,

          flag:
            null,

          safeDefault:
            true,
        });
      },
    );

    // ==========================================================
    // EXPIRY
    // ==========================================================

    it(
      'excludes expired flags from effective resolution',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        database.query.mockResolvedValueOnce({
          rowCount:
            0,

          rows: [],
        });

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.resolveFeatureFlag(
            tenantId,

            'expired.flag',

            '2026-10-06T00:00:00.000Z',
          );

        expect(
          result.enabled,
        ).toBe(false);

        expect(
          result.flag,
        ).toBeNull();

        expect(
          result.safeDefault,
        ).toBe(true);
      },
    );

    // ==========================================================
    // TENANT VALIDATION
    // ==========================================================

    it(
      'rejects invalid tenant UUID',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.resolveFeatureFlag(
            'invalid-tenant',

            'enable_growth_engine',
          ),
        ).rejects.toThrow(
          'tenantId must be a valid UUID',
        );

        expect(
          database.query,
        ).not.toHaveBeenCalled();
      },
    );

    // ==========================================================
    // INPUT VALIDATION
    // ==========================================================

    it(
      'rejects an empty key',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                '   ',

              owner:
                'product',
            },
          ),
        ).rejects.toThrow(
          'key is required',
        );
      },
    );

    it(
      'rejects an empty owner',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'enable_growth_engine',

              owner:
                '   ',
            },
          ),
        ).rejects.toThrow(
          'owner is required',
        );
      },
    );

    it(
      'rejects an invalid expiry window',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'enable_growth_engine',

              owner:
                'product',

              effectiveFrom:
                '2026-12-01T00:00:00.000Z',

              expiresAt:
                '2026-11-01T00:00:00.000Z',
            },
          ),
        ).rejects.toThrow(
          'expiresAt must be later than effectiveFrom',
        );
      },
    );

    it(
      'rejects a non-object config',
      async () => {
        const database =
          createMockDatabase(
            createMockClient(),
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        await expect(
          service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'enable_growth_engine',

              owner:
                'product',

              config:
                [] as never,
            },
          ),
        ).rejects.toThrow(
          'config must be a JSON object',
        );
      },
    );

    // ==========================================================
    // AUDIT
    // ==========================================================

    it(
      'does not fail a committed flag change when audit fails',
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
                'flag-audit-001',

              tenant_id:
                tenantId,

              key:
                'enable_growth_engine',

              version:
                '1',

              enabled:
                true,

              config: {},

              owner:
                'product',

              security_critical:
                false,

              change_reason:
                null,

              effective_from:
                '2026-10-06T00:00:00.000Z',

              expires_at:
                null,

              created_by:
                userId,

              created_at:
                '2026-10-06T00:00:00.000Z',
            },
          ],
        });

        auditService.record.mockRejectedValueOnce(
          new Error(
            'AUDIT_UNAVAILABLE',
          ),
        );

        const database =
          createMockDatabase(
            client,
          );

        const service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );

        const result =
          await service.createFeatureFlag(
            tenantId,

            userId,

            {
              key:
                'enable_growth_engine',

              enabled:
                true,

              owner:
                'product',
            },
          );

        expect(
          result.id,
        ).toBe(
          'flag-audit-001',
        );

        expect(
          auditService.record,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );
  },
);