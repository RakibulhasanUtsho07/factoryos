import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';

import {
  OutboxDlqService,
} from './outbox-dlq.service';

describe(
  'Outbox DLQ and replay',
  () => {
    let pool: Pool;

    let eventId: string;

    let orderId: string;

    let tenantId: string;

    let factoryId: string;

    let orderNumber: string;

    let actorUserId: string;

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

      // ----------------------------------------------------------
      // Resolve a real order + tenant + factory fixture.
      // ----------------------------------------------------------

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

            tenant_id::text
              AS tenant_id,

            factory_id::text
              AS factory_id,

            order_number

          FROM orders

          WHERE
            factory_id IS NOT NULL

          ORDER BY
            created_at DESC

          LIMIT 1
          `,
        );

      if (
        orderResult.rowCount !== 1
      ) {
        throw new Error(
          'No order available for DLQ test.',
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

      orderNumber =
        orderResult.rows[0]
          .order_number;

      // ----------------------------------------------------------
      // Users are tenant-neutral.
      //
      // Tenant membership is represented by tenant_memberships.
      // ----------------------------------------------------------

      const actorResult =
        await pool.query<{
          id: string;
        }>(
          `
          SELECT
            u.id::text AS id

          FROM users u

          INNER JOIN tenant_memberships tm
            ON tm.user_id = u.id

          WHERE
            tm.tenant_id = $1

            AND tm.status = 'ACTIVE'

            AND u.status = 'ACTIVE'

          ORDER BY
            u.created_at ASC

          LIMIT 1
          `,
          [tenantId],
        );

      if (
        actorResult.rowCount !== 1
      ) {
        throw new Error(
          'No active tenant member available for DLQ replay audit test.',
        );
      }

      actorUserId =
        actorResult.rows[0].id;

      // ----------------------------------------------------------
      // Create a quarantined event fixture.
      // ----------------------------------------------------------

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
          next_attempt_at,
          last_error,
          quarantined_at,
          quarantined_by,
          quarantine_reason,
          replay_count
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
          'QUARANTINED',
          10,
          clock_timestamp(),
          'DLQ_REPLAY_TEST_FAILURE',
          clock_timestamp(),
          'api-outbox-dlq-test',
          'DLQ_REPLAY_TEST_FAILURE',
          0
        )
        `,
        [
          eventId,

          tenantId,

          factoryId,

          orderId,

          randomUUID(),

          JSON.stringify({
            type: 'user',

            id: actorUserId,
          }),

          JSON.stringify({
            system:
              'FactoryOS',

            connector:
              'dlq-test',

            version:
              'test',
          }),

          JSON.stringify({
            actor: {
              user_id:
                actorUserId,
            },

            lines: [],

            order: {
              id:
                orderId,

              tenant_id:
                tenantId,

              factory_id:
                factoryId,

              order_number:
                orderNumber,

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

      // Remove audit records created by this test fixture.

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

      // Remove the outbox fixture.

      await pool.query(
        `
        DELETE FROM outbox_events

        WHERE id = $1
        `,
        [eventId],
      );

      await pool.end();
    });

    // ==========================================================
    // LIST
    // ==========================================================

    it(
      'should list quarantined events inside the tenant/factory scope',
      async () => {
        const database = {
          transaction,

          query:
            pool.query.bind(pool),
        };

        const auditService =
          new AuditService(
            database as never,
          );

        const service =
          new OutboxDlqService(
            database as never,

            auditService,
          );

        const result =
          await service.listQuarantined(
            tenantId,
            {
              factoryId:
                null,

              requestFactoryId:
                factoryId,

              limit:
                50,

              offset:
                0,
            },
          );

        const item =
          result.items.find(
            (candidate) =>
              candidate.id ===
              eventId,
          );

        expect(
          item,
        ).toBeTruthy();

        expect(
          item?.status,
        ).toBe(
          'QUARANTINED',
        );

        expect(
          item?.attempts,
        ).toBe(10);

        expect(
          item?.replay_count,
        ).toBe(0);

        expect(
          item?.last_error,
        ).toBe(
          'DLQ_REPLAY_TEST_FAILURE',
        );

        expect(
          item?.factory_id,
        ).toBe(
          factoryId,
        );

        expect(
          result.pagination.total,
        ).toBeGreaterThanOrEqual(
          1,
        );
      },
    );

    // ==========================================================
    // TENANT ISOLATION
    // ==========================================================

    it(
      'should reject replay from the wrong tenant',
      async () => {
        const database = {
          transaction,

          query:
            pool.query.bind(pool),
        };

        const auditService =
          new AuditService(
            database as never,
          );

        const service =
          new OutboxDlqService(
            database as never,

            auditService,
          );

        const wrongTenantId =
          randomUUID();

        await expect(
          service.replay({
            tenantId:
              wrongTenantId,

            actorUserId:
              actorUserId,

            eventId:
              eventId,

            requestId:
              randomUUID(),

            traceId:
              randomUUID(),

            requestFactoryId:
              factoryId,
          }),
        ).rejects.toThrow(
          'Quarantined outbox event not found',
        );

        const stateResult =
          await pool.query<{
            status: string;
          }>(
            `
            SELECT
              status

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          stateResult.rowCount,
        ).toBe(1);

        expect(
          stateResult.rows[0]
            .status,
        ).toBe(
          'QUARANTINED',
        );
      },
    );

    // ==========================================================
    // FACTORY ISOLATION
    // ==========================================================

    it(
      'should reject replay outside the authenticated factory scope',
      async () => {
        const database = {
          transaction,

          query:
            pool.query.bind(pool),
        };

        const auditService =
          new AuditService(
            database as never,
          );

        const service =
          new OutboxDlqService(
            database as never,

            auditService,
          );

        const wrongFactoryId =
          randomUUID();

        await expect(
          service.replay({
            tenantId:
              tenantId,

            actorUserId:
              actorUserId,

            eventId:
              eventId,

            requestId:
              randomUUID(),

            traceId:
              randomUUID(),

            requestFactoryId:
              wrongFactoryId,
          }),
        ).rejects.toThrow(
          'Quarantined outbox event not found',
        );

        const stateResult =
          await pool.query<{
            status: string;
          }>(
            `
            SELECT
              status

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          stateResult.rowCount,
        ).toBe(1);

        expect(
          stateResult.rows[0]
            .status,
        ).toBe(
          'QUARANTINED',
        );
      },
    );

    // ==========================================================
    // REPLAY
    // ==========================================================

    it(
      'should replay a quarantined event and create an audit record',
      async () => {
        const database = {
          transaction,

          query:
            pool.query.bind(pool),
        };

        const auditService =
          new AuditService(
            database as never,

            // No additional dependencies.
          );

        const service =
          new OutboxDlqService(
            database as never,

            auditService,
          );

        const originalResult =
          await pool.query<{
            payload: Record<
              string,
              unknown
            >;

            correlation_id:
              | string
              | null;
          }>(
            `
            SELECT
              payload,

              correlation_id::text
                AS correlation_id

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          originalResult.rowCount,
        ).toBe(1);

        const originalPayload =
          originalResult
            .rows[0]
            .payload;

        const replayTraceId =
          randomUUID();

        const replayRequestId =
          randomUUID();

        const result =
          await service.replay({
            tenantId:
              tenantId,

            actorUserId:
              actorUserId,

            eventId:
              eventId,

            requestId:
              replayRequestId,

            traceId:
              replayTraceId,

            requestFactoryId:
              factoryId,
          });

        expect(
          result.event_id,
        ).toBe(
          eventId,
        );

        expect(
          result.event_type,
        ).toBe(
          'ORDER.CREATED',
        );

        expect(
          result.event_version,
        ).toBe(1);

        expect(
          result.status,
        ).toBe(
          'PENDING',
        );

        expect(
          result.replay_count,
        ).toBe(1);

        expect(
          result.previous_attempts,
        ).toBe(10);

        const stateResult =
          await pool.query<{
            status: string;

            attempts: number;

            replay_count: number;

            locked_at:
              | Date
              | null;

            locked_by:
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

            last_replayed_by:
              | string
              | null;

            last_replayed_at:
              | Date
              | null;

            payload: Record<
              string,
              unknown
            >;
          }>(
            `
            SELECT
              status,

              attempts,

              replay_count,

              locked_at,

              locked_by,

              quarantined_at,

              quarantined_by,

              quarantine_reason,

              last_replayed_by::text
                AS last_replayed_by,

              last_replayed_at,

              payload

            FROM outbox_events

            WHERE id = $1
            `,
            [eventId],
          );

        expect(
          stateResult.rowCount,
        ).toBe(1);

        const state =
          stateResult.rows[0];

        expect(
          state.status,
        ).toBe(
          'PENDING',
        );

        /*
         * Preserve the historical attempt count.
         *
         * replay_count is the separate replay counter.
         */
        expect(
          Number(
            state.attempts,
          ),
        ).toBe(10);

        expect(
          Number(
            state.replay_count,
          ),
        ).toBe(1);

        expect(
          state.locked_at,
        ).toBeNull();

        expect(
          state.locked_by,
        ).toBeNull();

        expect(
          state.quarantined_at,
        ).toBeNull();

        expect(
          state.quarantined_by,
        ).toBeNull();

        expect(
          state.quarantine_reason,
        ).toBeNull();

        expect(
          state.last_replayed_by,
        ).toBe(
          actorUserId,
        );

        expect(
          state.last_replayed_at,
        ).toBeTruthy();

        /*
         * Replay must not mutate the immutable event payload.
         */
        expect(
          state.payload,
        ).toEqual(
          originalPayload,
        );

        // --------------------------------------------------------
        // Replay audit proof.
        // --------------------------------------------------------

        const auditResult =
          await pool.query<{
            action: string;

            resource_type: string;

            resource_id: string;

            correlation_id:
              | string
              | null;

            request_id:
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

              request_id::text
                AS request_id,

              payload

            FROM audit_events

            WHERE
              resource_type =
                'OUTBOX_EVENT'

              AND resource_id =
                $1

              AND action =
                'REPLAY_REQUESTED'

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
          'REPLAY_REQUESTED',
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
          replayTraceId,
        );

        expect(
          auditResult.rows[0]
            .request_id,
        ).toBe(
          replayRequestId,
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
            .replay_count,
        ).toBe(1);
      },
    );
  },
);