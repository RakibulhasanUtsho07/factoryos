import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';

import {
  OutboxDispatcherService,
} from './outbox.dispatcher.service';

import type {
  OutboxEvent,
} from './outbox.publisher';

describe(
  'Outbox dispatcher quarantine',
  () => {
    let pool: Pool;

    let eventId: string;

    let orderId: string;

    let tenantId: string;

    let factoryId: string;

    const correlationId =
      randomUUID();

    async function transaction<T>(
      callback: (
        client: import('pg').PoolClient,
      ) => Promise<T>,
    ): Promise<T> {
      const client =
        await pool.connect();

      try {
        await client.query(
          'BEGIN',
        );

        const result =
          await callback(client);

        await client.query(
          'COMMIT',
        );

        return result;
      } catch (error) {
        await client.query(
          'ROLLBACK',
        );

        throw error;
      } finally {
        client.release();
      }
    }

    beforeAll(async () => {
      const databaseUrl =
        process.env.DATABASE_URL;

      if (!databaseUrl) {
        throw new Error(
          'DATABASE_URL is required.',
        );
      }

      pool =
        new Pool({
          connectionString:
            databaseUrl,
        });

      const orderResult =
        await pool.query<{
          id: string;
          tenant_id: string;
          factory_id: string;
          order_number: string;
        }>(
          `
          SELECT
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id,
            order_number

          FROM orders

          ORDER BY
            created_at DESC

          LIMIT 1
          `,
        );

      if (
        orderResult.rowCount !== 1
      ) {
        throw new Error(
          'No order available for quarantine test.',
        );
      }

      orderId =
        orderResult.rows[0].id;

      tenantId =
        orderResult.rows[0]
          .tenant_id;

      factoryId =
        orderResult.rows[0]
          .factory_id;

      eventId =
        randomUUID();

      await pool.query(
        `
        INSERT INTO outbox_events (
          id,
          tenant_id,
          factory_id,
          aggregate_type,
          aggregate_id,
          event_type,
          event_version,
          occurred_at,
          correlation_id,
          actor,
          source,
          payload,
          status,
          attempts,
          next_attempt_at
        )

        VALUES (
          $1,
          $2,
          $3,
          'ORDER',
          $4,
          'ORDER.CREATED',
          1,
          clock_timestamp(),
          $5,
          $6::jsonb,
          $7::jsonb,
          $8::jsonb,
          'PENDING',
          9,
          clock_timestamp()
        )
        `,
        [
          eventId,

          tenantId,

          factoryId,

          orderId,

          correlationId,

          JSON.stringify({
            type: 'user',
            id: '921382b8-e83f-43ab-a576-e3db6a06b70c',
          }),

          JSON.stringify({
            system: 'FactoryOS',
            connector: 'quarantine-test',
            version: 'test',
          }),

          JSON.stringify({
            actor: {
              user_id:
                '921382b8-e83f-43ab-a576-e3db6a06b70c',
            },

            order: {
              id:
                orderId,

              tenant_id:
                tenantId,

              factory_id:
                factoryId,

              order_number:
                orderResult.rows[0]
                  .order_number,

              status:
                'DRAFT',
            },
          }),
        ],
      );
    });

    afterAll(async () => {
      if (!pool) {
        return;
      }

      await pool.query(
        `
        DELETE FROM audit_events

        WHERE
          resource_type =
            'OUTBOX_EVENT'

          AND resource_id =
            $1
        `,
        [eventId],
      );

      await pool.query(
        `
        DELETE FROM outbox_events

        WHERE id = $1
        `,
        [eventId],
      );

      await pool.end();
    });

    it(
      'should quarantine an event after the maximum retry attempt',
      async () => {
        const database = {
          transaction,

          query:
            pool.query.bind(pool),
        };

        const publisher = {
          publish: async (
            event: OutboxEvent,
          ): Promise<void> => {
            if (
              event.id ===
              eventId
            ) {
              throw new Error(
                'QUARANTINE_TEST_FAILURE',
              );
            }
          },
        };

        const registry = {
          dispatch: async (
            _event: OutboxEvent,
          ) => ({
            handled: false,

            consumerName:
              null,
          }),
        };

        const auditService =
          new AuditService(
            database as never,
          );

        const dispatcher =
          new OutboxDispatcherService(
            database as never,

            publisher as never,

            registry as never,

            auditService,
          );

        const result =
          await dispatcher.dispatchOnce();

        expect(
          result.claimed,
        ).toBeGreaterThanOrEqual(1);

        const outboxResult =
          await pool.query<{
            status: string;

            attempts: number;

            locked_at:
              | Date
              | null;

            locked_by:
              | string
              | null;

            last_error:
              | string
              | null;

            quarantined_at:
              | Date
              | null;

            quarantined_by:
              | string
              | null;

            quarantine_reason:
              | string
              | null;

            replay_count: number;
          }>(
            `
            SELECT
              status,

              attempts,

              locked_at,

              locked_by,

              last_error,

              quarantined_at,

              quarantined_by,

              quarantine_reason,

              replay_count

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          outboxResult.rowCount,
        ).toBe(1);

        const row =
          outboxResult.rows[0];

        expect(
          row.status,
        ).toBe(
          'QUARANTINED',
        );

        expect(
          Number(
            row.attempts,
          ),
        ).toBe(10);

        expect(
          row.locked_at,
        ).toBeNull();

        expect(
          row.locked_by,
        ).toBeNull();

        expect(
          row.last_error,
        ).toBe(
          'QUARANTINE_TEST_FAILURE',
        );

        expect(
          row.quarantined_at,
        ).toBeTruthy();

        expect(
          row.quarantined_by,
        ).toBeTruthy();

        expect(
          row.quarantine_reason,
        ).toBe(
          'QUARANTINE_TEST_FAILURE',
        );

        expect(
          Number(
            row.replay_count,
          ),
        ).toBe(0);

        const auditResult =
          await pool.query<{
            action: string;

            resource_type: string;

            resource_id: string;

            correlation_id:
              | string
              | null;

            payload: Record<
              string,
              unknown
            >;
          }>(
            `
            SELECT
              action,

              resource_type,

              resource_id,

              correlation_id::text
                AS correlation_id,

              payload

            FROM audit_events

            WHERE
              resource_type =
                'OUTBOX_EVENT'

              AND resource_id =
                $1

              AND action =
                'QUARANTINED'

            ORDER BY
              created_at DESC

            LIMIT 1
            `,
            [eventId],
          );

        expect(
          auditResult.rowCount,
        ).toBe(1);

        expect(
          auditResult.rows[0]
            .action,
        ).toBe(
          'QUARANTINED',
        );

        expect(
          auditResult.rows[0]
            .resource_type,
        ).toBe(
          'OUTBOX_EVENT',
        );

        expect(
          auditResult.rows[0]
            .resource_id,
        ).toBe(
          eventId,
        );

        expect(
          auditResult.rows[0]
            .correlation_id,
        ).toBe(
          correlationId,
        );

        expect(
          auditResult.rows[0]
            .payload
            .event_id,
        ).toBe(
          eventId,
        );

        expect(
          auditResult.rows[0]
            .payload
            .attempts,
        ).toBe(10);
      },
    );
  },
);