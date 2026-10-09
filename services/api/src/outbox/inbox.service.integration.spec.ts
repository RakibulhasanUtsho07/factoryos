import { Pool } from 'pg';

import { randomUUID } from 'node:crypto';

import {
  createIntegrationDatabase,
} from '../database/integration-database.adapter';

import { InboxService } from './inbox.service';

type EventRow = {
  id: string;
  tenant_id: string;
};

describe(
  'InboxService PostgreSQL integration',
  () => {
    const runId =
      randomUUID();

    let pool!: Pool;

    let appPool!: Pool;

    let service: InboxService;

    let event: EventRow;

    let secondTenantId: string;

    const businessTable =
      'inbox_integration_business_effects';

    beforeAll(async () => {
      const databaseUrl =
        process.env.DATABASE_URL;

      const testAdminDatabaseUrl =
        process.env.TEST_ADMIN_DATABASE_URL;

      if (!databaseUrl) {
        throw new Error(
          'DATABASE_URL is required to run InboxService PostgreSQL integration tests.',
        );
      }

      if (!testAdminDatabaseUrl) {
        throw new Error(
          'TEST_ADMIN_DATABASE_URL is required to run InboxService PostgreSQL integration tests.',
        );
      }

      /*
       * Admin pool:
       * fixture creation, assertions and cleanup.
       */
      pool =
        new Pool({
          connectionString:
            testAdminDatabaseUrl,
        });

      /*
       * Runtime/application pool:
       * actual InboxService transaction path.
       */
      appPool =
        new Pool({
          connectionString:
            databaseUrl,
        });

      /*
       * The business table is a test fixture and therefore must
       * be created by the privileged/admin role.
       */
      await pool.query(
        `
        CREATE TABLE IF NOT EXISTS ${businessTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          run_id UUID NOT NULL,
          marker VARCHAR(100) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        `,
      );

      /*
       * The application role must be able to execute the business
       * side-effect inside the real application transaction.
       *
       * Do not grant CREATE on schema public to the app role.
       */
      await pool.query(
        `
        GRANT
          SELECT,
          INSERT,
          UPDATE,
          DELETE
        ON TABLE ${businessTable}
        TO factoryos_app
        `,
      );

      await pool.query(
        `
        DELETE FROM ${businessTable}
        WHERE run_id = $1
        `,
        [
          runId,
        ],
      );

      const eventResult =
        await pool.query<EventRow>(
          `
          SELECT
            id,
            tenant_id
          FROM outbox_events
          WHERE status = 'PUBLISHED'
          ORDER BY created_at DESC
          LIMIT 1
          `,
        );

      if (
        eventResult.rowCount !== 1
      ) {
        throw new Error(
          'No PUBLISHED outbox event exists for integration testing.',
        );
      }

      const selectedEvent =
        eventResult.rows[0];

      if (!selectedEvent) {
        throw new Error(
          'Selected PUBLISHED outbox event row is missing.',
        );
      }

      event =
        selectedEvent;

      /*
       * Create a temporary second tenant used only for the
       * cross-tenant binding assertion.
       */
      secondTenantId =
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
        VALUES (
          $1,
          $2,
          $3,
          'ACTIVE',
          'Asia/Dhaka',
          'en-BD'
        )
        `,
        [
          secondTenantId,
          `inbox-test-${runId}`,
          'Inbox Integration Test Tenant',
        ],
      );

      /*
       * Real application DB adapter.
       *
       * InboxService receives this adapter, so its transaction
       * executes using the restricted factoryos_app role.
       */
      const database =
        createIntegrationDatabase(
          appPool,
        );

      service =
        new InboxService(
          database as never,
        );
    });

    afterAll(async () => {
      if (pool) {
        await pool.query(
          `
          DELETE FROM ${businessTable}
          WHERE run_id = $1
          `,
          [
            runId,
          ],
        );

        if (secondTenantId) {
          await pool.query(
            `
            DELETE FROM tenants
            WHERE id = $1
            `,
            [
              secondTenantId,
            ],
          );
        }

        await pool.end();
      }

      if (appPool) {
        await appPool.end();
      }
    });

    it(
      'should persist inbox event and business side effect on first delivery',
      async () => {
        const consumerName =
          `integration-first-${runId}`;

        const result =
          await service.executeOnce(
            event.tenant_id,
            consumerName,
            event.id,
            async (client) => {
              await client.query(
                `
                INSERT INTO ${businessTable} (
                  run_id,
                  marker
                )
                VALUES ($1, $2)
                `,
                [
                  runId,
                  'first-delivery',
                ],
              );

              return {
                processed:
                  true,
              };
            },
          );

        expect(
          result,
        ).toEqual({
          duplicate:
            false,

          result: {
            processed:
              true,
          },
        });

        const inboxResult =
          await pool.query(
            `
            SELECT
              consumer_name,
              event_id,
              processed_at
            FROM inbox_events
            WHERE consumer_name = $1
              AND event_id = $2
            `,
            [
              consumerName,
              event.id,
            ],
          );

        expect(
          inboxResult.rowCount,
        ).toBe(1);

        expect(
          inboxResult.rows[0]
            .processed_at,
        ).toBeTruthy();

        const businessResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM ${businessTable}

            WHERE
              run_id = $1
              AND marker = $2
            `,
            [
              runId,
              'first-delivery',
            ],
          );

        expect(
          businessResult.rows[0]
            .count,
        ).toBe(1);
      },
    );

    it(
      'should skip duplicate delivery and execute the handler zero times',
      async () => {
        const consumerName =
          `integration-first-${runId}`;

        let handlerCalls = 0;

        const result =
          await service.executeOnce(
            event.tenant_id,
            consumerName,
            event.id,
            async () => {
              handlerCalls +=
                1;

              return {
                processed:
                  true,
              };
            },
          );

        expect(
          result,
        ).toEqual({
          duplicate:
            true,

          result:
            null,
        });

        expect(
          handlerCalls,
        ).toBe(0);

        const inboxResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM inbox_events

            WHERE
              consumer_name = $1
              AND event_id = $2
            `,
            [
              consumerName,
              event.id,
            ],
          );

        expect(
          inboxResult.rows[0]
            .count,
        ).toBe(1);

        const businessResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM ${businessTable}

            WHERE
              run_id = $1
              AND marker = $2
            `,
            [
              runId,
              'first-delivery',
            ],
          );

        expect(
          businessResult.rows[0]
            .count,
        ).toBe(1);
      },
    );

    it(
      'should rollback inbox and business side effect when the handler fails',
      async () => {
        const consumerName =
          `integration-failure-${runId}`;

        await expect(
          service.executeOnce(
            event.tenant_id,
            consumerName,
            event.id,
            async (client) => {
              await client.query(
                `
                INSERT INTO ${businessTable} (
                  run_id,
                  marker
                )
                VALUES ($1, $2)
                `,
                [
                  runId,
                  'failed-delivery',
                ],
              );

              throw new Error(
                'INTEGRATION_HANDLER_FAILED',
              );
            },
          ),
        ).rejects.toThrow(
          'INTEGRATION_HANDLER_FAILED',
        );

        const inboxResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM inbox_events

            WHERE
              consumer_name = $1
              AND event_id = $2
            `,
            [
              consumerName,
              event.id,
            ],
          );

        expect(
          inboxResult.rows[0]
            .count,
        ).toBe(0);

        const businessResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM ${businessTable}

            WHERE
              run_id = $1
              AND marker = $2
            `,
            [
              runId,
              'failed-delivery',
            ],
          );

        expect(
          businessResult.rows[0]
            .count,
        ).toBe(0);
      },
    );

    it(
      'should reject cross-tenant event binding and execute no handler',
      async () => {
        const consumerName =
          `integration-cross-tenant-${runId}`;

        let handlerCalls = 0;

        await expect(
          service.executeOnce(
            secondTenantId,
            consumerName,
            event.id,
            async () => {
              handlerCalls +=
                1;

              return {
                processed:
                  true,
              };
            },
          ),
        ).rejects.toThrow();

        expect(
          handlerCalls,
        ).toBe(0);

        const inboxResult =
          await pool.query(
            `
            SELECT
              COUNT(*)::int AS count

            FROM inbox_events

            WHERE
              consumer_name = $1
              AND event_id = $2
            `,
            [
              consumerName,
              event.id,
            ],
          );

        expect(
          inboxResult.rows[0]
            .count,
        ).toBe(0);
      },
    );
  },
);