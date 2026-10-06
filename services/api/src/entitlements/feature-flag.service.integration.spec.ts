import { Pool } from 'pg';

import {
  randomUUID,
} from 'node:crypto';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

import {
  FeatureFlagService,
} from './feature-flag.service';

describe(
  'FeatureFlagService PostgreSQL integration',
  () => {
    const runId =
      randomUUID();

    let pool!: Pool;

    let appPool!: Pool;

    let service: FeatureFlagService;

    let tenantAId: string;

    let tenantBId: string;

    let flagAId: string;

    let flagBId: string;

    let testActorUserId: string;

    beforeAll(
      async () => {
        const databaseUrl =
          process.env
            .DATABASE_URL;

        const testAdminDatabaseUrl =
          process.env
            .TEST_ADMIN_DATABASE_URL;

        if (
          !databaseUrl
        ) {
          throw new Error(
            'DATABASE_URL is required to run FeatureFlagService PostgreSQL integration tests.',
          );
        }

        if (
          !testAdminDatabaseUrl
        ) {
          throw new Error(
            'TEST_ADMIN_DATABASE_URL is required to run FeatureFlagService PostgreSQL integration tests.',
          );
        }

        /*
         * --------------------------------------------------------
         * Admin/test-fixture connection.
         *
         * Used only for:
         *
         *   - fixture creation
         *   - authoritative assertions
         *   - cleanup
         *
         * Production application code never receives this pool.
         * --------------------------------------------------------
         */
        pool =
          new Pool({
            connectionString:
              testAdminDatabaseUrl,
          });

        /*
         * --------------------------------------------------------
         * Production-like application connection.
         *
         * DATABASE_URL must point to the restricted factoryos_app
         * runtime role so PostgreSQL RLS is enforced.
         * --------------------------------------------------------
         */
        appPool =
          new Pool({
            connectionString:
              databaseUrl,
          });

        /*
         * --------------------------------------------------------
         * Create two isolated temporary tenants.
         * --------------------------------------------------------
         */

        tenantAId =
          randomUUID();

        tenantBId =
          randomUUID();

        await pool.query(
          `
          INSERT INTO tenants (
            id,

            slug,

            name,

            status,

            timezone,

            default_locale
          )

          VALUES
          (
            $1,

            $2,

            $3,

            'ACTIVE',

            'Asia/Dhaka',

            'en-BD'
          ),

          (
            $4,

            $5,

            $6,

            'ACTIVE',

            'Asia/Dhaka',

            'en-BD'
          )
          `,
          [
            tenantAId,

            `feature-flag-a-${runId}`,

            'Feature Flag Integration Tenant A',

            tenantBId,

            `feature-flag-b-${runId}`,

            'Feature Flag Integration Tenant B',
          ],
        );

        /*
         * --------------------------------------------------------
         * Resolve an existing active application user.
         *
         * feature_flags.created_by has a real FK to users(id).
         *
         * Therefore the test must use an actual user instead of
         * a synthetic UUID.
         * --------------------------------------------------------
         */
        const userResult =
          await pool.query<{
            id: string;
          }>(
            `
            SELECT
              id::text AS id

            FROM users

            WHERE
              status = 'ACTIVE'

            ORDER BY
              created_at ASC

            LIMIT 1
            `,
          );

        if (
          userResult.rowCount !==
          1
        ) {
          throw new Error(
            'No active user is available for FeatureFlagService integration testing.',
          );
        }

        const testUser =
          userResult.rows[0];

        if (
          !testUser
        ) {
          throw new Error(
            'Feature flag integration test actor is missing.',
          );
        }

        testActorUserId =
          testUser.id;

        /*
         * --------------------------------------------------------
         * Real application database adapter.
         *
         * Service operations execute through appPool.
         * --------------------------------------------------------
         */
        const database =
          createIntegrationDatabase(
            appPool,
          );

        /*
         * --------------------------------------------------------
         * Audit is mocked because the AuditService itself has
         * separate integration coverage.
         * --------------------------------------------------------
         */
        const auditService =
          {
            record:
              async () =>
                undefined,
          };

        service =
          new FeatureFlagService(
            database as never,

            auditService as never,
          );
      },

      60_000,
    );

    afterAll(
      async () => {
        if (
          pool
        ) {
          /*
           * ----------------------------------------------------
           * Versioned feature flags are intentionally immutable.
           *
           * Therefore normal DELETE is blocked by:
           *
           *   feature_flags_immutable_version
           *
           * Test cleanup uses the privileged admin connection.
           *
           * The trigger is disabled only for the scoped cleanup
           * operation and is ALWAYS re-enabled in finally.
           * ----------------------------------------------------
           */
          try {
            await pool.query(
              `
              ALTER TABLE feature_flags
              DISABLE TRIGGER feature_flags_immutable_version
              `,
            );

            if (
              tenantAId
            ) {
              await pool.query(
                `
                DELETE FROM feature_flags

                WHERE
                  tenant_id = $1
                `,
                [
                  tenantAId,
                ],
              );
            }

            if (
              tenantBId
            ) {
              await pool.query(
                `
                DELETE FROM feature_flags

                WHERE
                  tenant_id = $1
                `,
                [
                  tenantBId,
                ],
              );
            }
          } finally {
            /*
             * Never leave the production immutability trigger
             * disabled after the test.
             */
            await pool.query(
              `
              ALTER TABLE feature_flags
              ENABLE TRIGGER feature_flags_immutable_version
              `,
            );
          }

          /*
           * Remove temporary tenants after their feature flags
           * have been removed.
           */
          await pool.query(
            `
            DELETE FROM tenants

            WHERE id IN (
              $1,

              $2
            )
            `,
            [
              tenantAId,

              tenantBId,
            ],
          );

          await pool.end();
        }

        if (
          appPool
        ) {
          await appPool.end();
        }
      },

      60_000,
    );

    // ============================================================
    // CREATE
    // ============================================================

    it(
      'should create a feature flag under the current tenant context',
      async () => {
        const result =
          await service.createFeatureFlag(
            tenantAId,

            null,

            {
              key:
                `integration.enabled.${runId}`,

              enabled:
                true,

              owner:
                'integration-test',

              config: {
                rollout:
                  100,
              },
            },
          );

        expect(
          result.tenantId,
        ).toBe(
          tenantAId,
        );

        expect(
          result.version,
        ).toBe(1);

        expect(
          result.enabled,
        ).toBe(true);

        expect(
          result.owner,
        ).toBe(
          'integration-test',
        );

        flagAId =
          result.id;

        const authoritative =
          await pool.query<{
            id: string;

            tenant_id: string;

            key: string;

            version: string;

            enabled: boolean;
          }>(
            `
            SELECT
              id::text AS id,

              tenant_id::text
                AS tenant_id,

              key,

              version::text
                AS version,

              enabled

            FROM feature_flags

            WHERE
              id = $1

              AND tenant_id = $2
            `,

            [
              flagAId,

              tenantAId,
            ],
          );

        expect(
          authoritative.rowCount,
        ).toBe(1);

        const row =
          authoritative.rows[0];

        if (
          !row
        ) {
          throw new Error(
            'Authoritative feature flag row is missing.',
          );
        }

        expect(
          row.tenant_id,
        ).toBe(
          tenantAId,
        );

        expect(
          Number(
            row.version,
          ),
        ).toBe(1);

        expect(
          row.enabled,
        ).toBe(true);
      },
    );

    // ============================================================
    // SECURITY-CRITICAL FLAG
    // ============================================================

    it(
      'should create a security-critical flag only with trusted privileged authorization',
      async () => {
        const result =
          await service.createFeatureFlag(
            tenantAId,

            testActorUserId,

            {
              key:
                `integration.security.${runId}`,

              enabled:
                true,

              owner:
                'security',

              securityCritical:
                true,

              changeReason:
                'Integration security-control validation',
            },

            {
              securityCriticalChangeAuthorized:
                true,
            },
          );

        expect(
          result.tenantId,
        ).toBe(
          tenantAId,
        );

        expect(
          result.createdBy,
        ).toBe(
          testActorUserId,
        );

        expect(
          result.securityCritical,
        ).toBe(true);

        expect(
          result.changeReason,
        ).toBe(
          'Integration security-control validation',
        );
      },
    );

    // ============================================================
    // VERSIONING
    // ============================================================

    it(
      'should create the next immutable version',
      async () => {
        const key =
          `integration.versioned.${runId}`;

        const first =
          await service.createFeatureFlag(
            tenantAId,

            null,

            {
              key,

              enabled:
                true,

              owner:
                'product',
            },
          );

        const second =
          await service.createFeatureFlag(
            tenantAId,

            null,

            {
              key,

              enabled:
                false,

              owner:
                'product',
            },
          );

        expect(
          first.version,
        ).toBe(1);

        expect(
          second.version,
        ).toBe(2);

        expect(
          second.id,
        ).not.toBe(
          first.id,
        );

        const rows =
          await pool.query<{
            version: string;

            enabled: boolean;
          }>(
            `
            SELECT
              version::text AS version,

              enabled

            FROM feature_flags

            WHERE
              tenant_id = $1

              AND key = $2

            ORDER BY
              version ASC
            `,

            [
              tenantAId,

              key,
            ],
          );

        expect(
          rows.rowCount,
        ).toBe(2);

        expect(
          rows.rows.map(
            (
              row,
            ) =>
              Number(
                row.version,
              ),
          ),
        ).toEqual([
          1,

          2,
        ]);

        expect(
          rows.rows[0]?.enabled,
        ).toBe(true);

        expect(
          rows.rows[1]?.enabled,
        ).toBe(false);
      },
    );

    // ============================================================
    // RESOLUTION
    // ============================================================

    it(
      'should resolve the highest active version',
      async () => {
        const key =
          `integration.resolve.${runId}`;

        await service.createFeatureFlag(
          tenantAId,

          null,

          {
            key,

            enabled:
              false,

            owner:
              'product',

            effectiveFrom:
              '2026-10-01T00:00:00.000Z',
          },
        );

        await service.createFeatureFlag(
          tenantAId,

          null,

          {
            key,

            enabled:
              true,

            owner:
              'product',

            effectiveFrom:
              '2026-10-02T00:00:00.000Z',
          },
        );

        const result =
          await service.resolveFeatureFlag(
            tenantAId,

            key,

            '2026-10-06T00:00:00.000Z',
          );

        expect(
          result.enabled,
        ).toBe(true);

        expect(
          result.safeDefault,
        ).toBe(false);

        expect(
          result.flag,
        ).not.toBeNull();

        expect(
          result.flag?.version,
        ).toBe(2);

        expect(
          result.flag?.enabled,
        ).toBe(true);
      },
    );

    it(
      'should ignore a future flag version',
      async () => {
        const key =
          `integration.future.${runId}`;

        await service.createFeatureFlag(
          tenantAId,

          null,

          {
            key,

            enabled:
              true,

            owner:
              'product',

            effectiveFrom:
              '2026-11-01T00:00:00.000Z',
          },
        );

        const result =
          await service.resolveFeatureFlag(
            tenantAId,

            key,

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

    it(
      'should exclude an expired flag from effective resolution',
      async () => {
        const key =
          `integration.expired.${runId}`;

        await service.createFeatureFlag(
          tenantAId,

          null,

          {
            key,

            enabled:
              true,

            owner:
              'product',

            effectiveFrom:
              '2026-10-01T00:00:00.000Z',

            expiresAt:
              '2026-10-05T00:00:00.000Z',
          },
        );

        const result =
          await service.resolveFeatureFlag(
            tenantAId,

            key,

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

    // ============================================================
    // TENANT ISOLATION - READ
    // ============================================================

    it(
      'should not expose tenant A flag to tenant B by id',
      async () => {
        const result =
          await service.getFeatureFlag(
            tenantBId,

            flagAId,
          );

        expect(
          result,
        ).toBeNull();
      },
    );

    it(
      'should not resolve tenant A flag from tenant B context',
      async () => {
        const result =
          await service.resolveFeatureFlag(
            tenantBId,

            `integration.enabled.${runId}`,
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
      'should list only current-tenant feature flags',
      async () => {
        const tenantAKey =
          `integration.list.a.${runId}`;

        const tenantBKey =
          `integration.list.b.${runId}`;

        const createdB =
          await service.createFeatureFlag(
            tenantBId,

            null,

            {
              key:
                tenantBKey,

              enabled:
                true,

              owner:
                'product',
            },
          );

        flagBId =
          createdB.id;

        expect(
          flagBId,
        ).toBe(
          createdB.id,
        );

        await service.createFeatureFlag(
          tenantAId,

          null,

          {
            key:
              tenantAKey,

            enabled:
              true,

            owner:
              'product',
          },
        );

        const tenantAList =
          await service.listFeatureFlags(
            tenantAId,
          );

        const tenantBList =
          await service.listFeatureFlags(
            tenantBId,
          );

        expect(
          tenantAList.items.length,
        ).toBeGreaterThan(
          0,
        );

        expect(
          tenantBList.items.length,
        ).toBeGreaterThan(
          0,
        );

        for (
          const row of
            tenantAList.items
        ) {
          expect(
            row.tenantId,
          ).toBe(
            tenantAId,
          );

          expect(
            row.tenantId,
          ).not.toBe(
            tenantBId,
          );
        }

        for (
          const row of
            tenantBList.items
        ) {
          expect(
            row.tenantId,
          ).toBe(
            tenantBId,
          );

          expect(
            row.tenantId,
          ).not.toBe(
            tenantAId,
          );
        }
      },
    );

    // ============================================================
    // TENANT ISOLATION - WRITE
    // ============================================================

    it(
      'should reject a cross-tenant write through PostgreSQL RLS',
      async () => {
        const database =
          createIntegrationDatabase(
            appPool,
          );

        const crossTenantKey =
          `integration.cross-tenant.${runId}`;

        await expect(
          database.transaction(
            {
              tenantId:
                tenantAId,
            },

            async (
              client,
            ) => {
              await client.query(
                `
                INSERT INTO feature_flags (
                  tenant_id,

                  key,

                  version,

                  enabled,

                  config,

                  owner,

                  security_critical,

                  effective_from
                )

                VALUES (
                  $1,

                  $2,

                  1,

                  true,

                  '{}'::jsonb,

                  'integration',

                  false,

                  now()
                )
                `,

                [
                  tenantBId,

                  crossTenantKey,
                ],
              );
            },
          ),
        ).rejects.toMatchObject({
          code:
            '42501',
        });

        const leaked =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM feature_flags

            WHERE
              tenant_id = $1

              AND key = $2
            `,

            [
              tenantBId,

              crossTenantKey,
            ],
          );

        expect(
          leaked.rows[0]?.count,
        ).toBe(0);
      },
    );

    // ============================================================
    // IMMUTABILITY
    // ============================================================

    it(
      'should reject UPDATE of a versioned feature flag',
      async () => {
        await expect(
          pool.query(
            `
            UPDATE feature_flags

            SET
              enabled = false

            WHERE
              id = $1
            `,

            [
              flagAId,
            ],
          ),
        ).rejects.toThrow(
          'Versioned configuration is immutable',
        );
      },
    );

    it(
      'should reject DELETE of a versioned feature flag',
      async () => {
        await expect(
          pool.query(
            `
            DELETE FROM feature_flags

            WHERE
              id = $1
            `,

            [
              flagAId,
            ],
          ),
        ).rejects.toThrow(
          'Versioned configuration is immutable',
        );
      },
    );

    // ============================================================
    // SAFE DEFAULT
    // ============================================================

    it(
      'should return disabled safe default when evaluation database access fails',
      async () => {
        /*
         * Create a dedicated pool that will be closed before the
         * service tries to execute the evaluation query.
         *
         * This tests the actual default-safe failure path.
         */
        const failingPool =
          new Pool({
            connectionString:
              process.env
                .DATABASE_URL,
          });

        const failingDatabase =
          createIntegrationDatabase(
            failingPool,
          );

        await failingPool.end();

        const failingAuditService =
          {
            record:
              async () =>
                undefined,
          };

        const failingService =
          new FeatureFlagService(
            failingDatabase as never,

            failingAuditService as never,
          );

        const result =
          await failingService.resolveFeatureFlag(
            tenantAId,

            `integration.failure.${runId}`,
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
  },
);