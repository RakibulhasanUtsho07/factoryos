import { Pool } from 'pg';

import {
  randomUUID,
} from 'node:crypto';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

import {
  EntitlementService,
} from './entitlement.service';

describe(
  'EntitlementService PostgreSQL integration',
  () => {
    const runId =
      randomUUID();

    let pool!: Pool;

    let appPool!: Pool;

    let service: EntitlementService;

    let tenantAId: string;

    let tenantBId: string;

    let entitlementAId: string;

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
            'DATABASE_URL is required to run EntitlementService PostgreSQL integration tests.',
          );
        }

        if (
          !testAdminDatabaseUrl
        ) {
          throw new Error(
            'TEST_ADMIN_DATABASE_URL is required to run EntitlementService PostgreSQL integration tests.',
          );
        }

        /*
         * --------------------------------------------------------
         * Admin/test-fixture pool.
         *
         * This pool is used ONLY for:
         *
         * - tenant fixture creation
         * - authoritative assertions
         * - cleanup
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
         * Application/runtime pool.
         *
         * DATABASE_URL must point to factoryos_app.
         *
         * This is critical because the tests must execute the
         * actual service path under PostgreSQL RLS.
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

            `entitlement-a-${runId}`,

            'Entitlement Integration Tenant A',

            tenantBId,

            `entitlement-b-${runId}`,

            'Entitlement Integration Tenant B',
          ],
        );

        /*
         * --------------------------------------------------------
         * Real application database adapter.
         *
         * EntitlementService therefore uses the restricted
         * factoryos_app role for all service operations.
         * --------------------------------------------------------
         */

        const database =
          createIntegrationDatabase(
            appPool,
          );

        /*
         * Audit is mocked for this service-level PostgreSQL test.
         *
         * The audit implementation itself has separate coverage.
         */
        const auditService =
          {
            record:
              async () =>
                undefined,
          };

        service =
          new EntitlementService(
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
       * --------------------------------------------------------
       * Versioned configuration is intentionally immutable.
       *
       * Therefore normal DELETE is blocked by the
       * entitlements_immutable_version trigger.
       *
       * Test fixtures still need deterministic cleanup, so the
       * privileged TEST_ADMIN_DATABASE_URL connection temporarily
       * disables ONLY the test-targeted trigger, performs the
       * scoped cleanup, and then ALWAYS re-enables it.
       *
       * Production application code never receives this pool.
       * --------------------------------------------------------
       */

      try {
        await pool.query(
          `
          ALTER TABLE entitlements
          DISABLE TRIGGER entitlements_immutable_version
          `,
        );

        if (
          tenantAId
        ) {
          await pool.query(
            `
            DELETE FROM entitlements

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
            DELETE FROM entitlements

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
         * Never leave the immutability trigger disabled even if
         * fixture cleanup itself fails.
         */
        await pool.query(
          `
          ALTER TABLE entitlements
          ENABLE TRIGGER entitlements_immutable_version
          `,
        );
      }

      /*
       * Remove the temporary tenants only after their entitlement
       * rows have been removed.
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
    // CREATE + READ
    // ============================================================

    it(
      'should create an entitlement under the current tenant context',
      async () => {
        const created =
          await service.createEntitlement(
            tenantAId,

            null,

            {
              package:
                'PRO',

              featureKey:
                `integration.ai.${runId}`,

              limitValue:
                100,

              period:
                'MONTH',

              config: {
                source:
                  'integration-test',
              },
            },
          );

        expect(
          created.tenantId,
        ).toBe(
          tenantAId,
        );

        expect(
          created.version,
        ).toBe(1);

        expect(
          created.status,
        ).toBe(
          'ACTIVE',
        );

        expect(
          created.limitValue,
        ).toBe(100);

        entitlementAId =
          created.id;

        const authoritative =
          await pool.query<{
            id: string;
            tenant_id: string;
            package: string;
            feature_key: string;
            version: string;
            status: string;
          }>(
            `
            SELECT
              id::text AS id,

              tenant_id::text
                AS tenant_id,

              package,

              feature_key,

              version::text
                AS version,

              status

            FROM entitlements

            WHERE
              id = $1

              AND tenant_id = $2
            `,
            [
              entitlementAId,
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
            'Authoritative entitlement row is missing.',
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
          row.status,
        ).toBe(
          'ACTIVE',
        );
      },
    );

    // ============================================================
    // VERSIONING
    // ============================================================

    it(
      'should create the next immutable entitlement version',
      async () => {
        const featureKey =
          `integration.versioned.${runId}`;

        const first =
          await service.createEntitlement(
            tenantAId,

            null,

            {
              package:
                'ENTERPRISE',

              featureKey,

              limitValue:
                200,

              period:
                'MONTH',
            },
          );

        const second =
          await service.createEntitlement(
            tenantAId,

            null,

            {
              package:
                'ENTERPRISE',

              featureKey,

              limitValue:
                500,

              period:
                'MONTH',
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
            limit_value:
              | string
              | null;
          }>(
            `
            SELECT
              version::text AS version,

              limit_value::text
                AS limit_value

            FROM entitlements

            WHERE
              tenant_id = $1

              AND package = $2

              AND feature_key = $3

            ORDER BY
              version ASC
            `,
            [
              tenantAId,

              'ENTERPRISE',

              featureKey,
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
          Number(
            rows.rows[0]?.limit_value,
          ),
        ).toBe(200);

        expect(
          Number(
            rows.rows[1]?.limit_value,
          ),
        ).toBe(500);
      },
    );

    // ============================================================
    // EFFECTIVE RESOLUTION
    // ============================================================

    it(
      'should resolve the highest active version for the current time',
      async () => {
        const featureKey =
          `integration.resolve.${runId}`;

        const first =
          await service.createEntitlement(
            tenantAId,

            null,

            {
              package:
                'PRO',

              featureKey,

              limitValue:
                100,

              period:
                'MONTH',

              effectiveFrom:
                '2026-10-01T00:00:00.000Z',
            },
          );

        const second =
          await service.createEntitlement(
            tenantAId,

            null,

            {
              package:
                'PRO',

              featureKey,

              limitValue:
                250,

              period:
                'MONTH',

              effectiveFrom:
                '2026-10-02T00:00:00.000Z',
            },
          );

        const resolved =
          await service.resolveEntitlement(
            tenantAId,

            'PRO',

            featureKey,

            '2026-10-06T00:00:00.000Z',
          );

        expect(
          first.version,
        ).toBe(1);

        expect(
          second.version,
        ).toBe(2);

        expect(
          resolved,
        ).not.toBeNull();

        expect(
          resolved?.version,
        ).toBe(2);

        expect(
          resolved?.limitValue,
        ).toBe(250);
      },
    );

    // ============================================================
    // TENANT ISOLATION - READ
    // ============================================================

    it(
      'should not expose tenant A entitlement to tenant B by id',
      async () => {
        const result =
          await service.getEntitlement(
            tenantBId,

            entitlementAId,
          );

        expect(
          result,
        ).toBeNull();
      },
    );

    it(
      'should not resolve tenant A entitlement from tenant B context',
      async () => {
        const result =
          await service.resolveEntitlement(
            tenantBId,

            'PRO',

            `integration.ai.${runId}`,
          );

        expect(
          result,
        ).toBeNull();
      },
    );

    it(
      'should return only current-tenant rows when listing',
      async () => {
        const tenantAList =
          await service.listEntitlements(
            tenantAId,
          );

        const tenantBList =
          await service.listEntitlements(
            tenantBId,
          );

        expect(
          tenantAList.items.length,
        ).toBeGreaterThan(
          0,
        );

        expect(
          tenantBList.items,
        ).toHaveLength(0);

        for (
          const row of
            tenantAList.items
        ) {
          expect(
            row.tenantId,
          ).toBe(
            tenantAId,
          );
        }

        for (
          const row of
            tenantBList.items
        ) {
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
                INSERT INTO entitlements (
                  tenant_id,

                  package,

                  feature_key,

                  version,

                  status,

                  effective_from,

                  config
                )

                VALUES (
                  $1,

                  'PRO',

                  $2,

                  1,

                  'ACTIVE',

                  now(),

                  '{}'::jsonb
                )
                `,
                [
                  tenantBId,

                  `integration.cross-tenant.${runId}`,
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

            FROM entitlements

            WHERE
              tenant_id = $1

              AND feature_key = $2
            `,
            [
              tenantBId,

              `integration.cross-tenant.${runId}`,
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
      'should reject UPDATE of a versioned entitlement',
      async () => {
        await expect(
          pool.query(
            `
            UPDATE entitlements

            SET
              status = 'DISABLED'

            WHERE
              id = $1
            `,
            [
              entitlementAId,
            ],
          ),
        ).rejects.toThrow(
          'Versioned configuration is immutable',
        );
      },
    );

    it(
      'should reject DELETE of a versioned entitlement',
      async () => {
        await expect(
          pool.query(
            `
            DELETE FROM entitlements

            WHERE
              id = $1
            `,
            [
              entitlementAId,
            ],
          ),
        ).rejects.toThrow(
          'Versioned configuration is immutable',
        );
      },
    );
  },
);