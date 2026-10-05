import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../database/database.service';

import {
  OutboxPublisher,
} from './outbox.publisher';

import type {
  OutboxEvent,
  OutboxActor,
  OutboxSource,
} from './outbox-event.contract';

import {
  OutboxConsumerRegistry,
} from './outbox.consumer.registry';

interface OutboxRow {
  id: string;

  tenant_id: string;

  factory_id:
    | string
    | null;

  aggregate_type: string;

  aggregate_id: string;

  event_type: string;

  event_version: number;

  payload: Record<
    string,
    unknown
  >;

  status: string;

  attempts: number;

  next_attempt_at: Date;

  occurred_at: Date;

  published_at:
    | Date
    | null;

  last_error:
    | string
    | null;

  created_at: Date;

  locked_at:
    | Date
    | null;

  locked_by:
    | string
    | null;

  last_attempt_at:
    | Date
    | null;

  correlation_id:
    | string
    | null;

  causation_id:
    | string
    | null;

  /*
   * PostgreSQL JSONB returns these values dynamically.
   *
   * We type them according to the canonical event contract because
   * OutboxPublisher performs the authoritative runtime validation.
   */
  actor:
    | OutboxActor
    | null;

  source:
    | OutboxSource
    | null;
}

@Injectable()
export class OutboxDispatcherService
  implements
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger =
    new Logger(
      OutboxDispatcherService.name,
    );

  private readonly workerId =
    `api-outbox-${randomUUID()}`;

  private timer:
    | ReturnType<typeof setTimeout>
    | null = null;

  private running =
    false;

  private readonly batchSize =
    20;

  private readonly intervalMs =
    5000;

  private readonly leaseMs =
    60000;

  private readonly maxAttempts =
    10;

  constructor(
    private readonly database: DatabaseService,

    private readonly publisher:
      OutboxPublisher,

    private readonly consumerRegistry:
      OutboxConsumerRegistry,
  ) {}

  // ============================================================
  // MODULE LIFECYCLE
  // ============================================================

  async onModuleInit(): Promise<void> {
    const enabled =
      process.env
        .OUTBOX_DISPATCHER_ENABLED !==
      'false';

    if (!enabled) {
      this.logger.warn(
        'Outbox dispatcher disabled by OUTBOX_DISPATCHER_ENABLED',
      );

      return;
    }

    this.logger.log(
      `Outbox dispatcher started: ${this.workerId}`,
    );

    await this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.running =
      false;

    if (
      this.timer !== null
    ) {
      clearTimeout(
        this.timer,
      );

      this.timer =
        null;
    }

    this.logger.log(
      'Outbox dispatcher stopped',
    );
  }

  // ============================================================
  // PUBLIC DISPATCH ENTRYPOINT
  // ============================================================

  async dispatchOnce(): Promise<{
    claimed: number;
    published: number;
    failed: number;
  }> {
    const rows =
      await this.claimBatch();

    let published =
      0;

    let failed =
      0;

    for (
      const row of rows
    ) {
      try {
        // ------------------------------------------------------
        // Hydrate canonical event envelope from PostgreSQL.
        // ------------------------------------------------------

        const event: OutboxEvent =
          {
            id:
              row.id,

            tenantId:
              row.tenant_id,

            factoryId:
              row.factory_id,

            aggregateType:
              row.aggregate_type,

            aggregateId:
              row.aggregate_id,

            eventType:
              row.event_type,

            eventVersion:
              row.event_version,

            occurredAt:
              row.occurred_at instanceof Date
                ? row.occurred_at.toISOString()
                : String(
                    row.occurred_at,
                  ),

            correlationId:
              row.correlation_id,

            causationId:
              row.causation_id,

            actor:
              row.actor,

            source:
              row.source,

            payload:
              row.payload,
          };

        /*
         * Publisher validates the complete canonical event contract
         * and deep-freezes the event snapshot.
         */
        await this.publisher.publish(
          event,
        );

        /*
         * Local consumers receive the exact same event snapshot.
         */
        const consumerResult =
          await this.consumerRegistry.dispatch(
            event,
          );

        if (
          consumerResult.handled
        ) {
          this.logger.log(
            `Outbox event consumed: event_id=${row.id}, consumer=${consumerResult.consumerName}`,
          );
        }

        /*
         * IMPORTANT:
         *
         * Event becomes PUBLISHED only after publisher and local
         * consumers succeed.
         *
         * This preserves the existing restart/idempotency contract.
         */
        await this.markPublished(
          row.id,
        );

        published +=
          1;
      } catch (
        error
      ) {
        failed +=
          1;

        await this.markFailed(
          row.id,
          error,
        );
      }
    }

    return {
      claimed:
        rows.length,

      published,

      failed,
    };
  }

  // ============================================================
  // SCHEDULER
  // ============================================================

  private async scheduleNext(): Promise<void> {
    if (
      !this.running
    ) {
      this.running =
        true;
    }

    await this.runCycle();

    if (
      !this.running
    ) {
      return;
    }

    this.timer =
      setTimeout(
        () =>
          void this.scheduleNext(),
        this.intervalMs,
      );
  }

  private async runCycle(): Promise<void> {
    try {
      const result =
        await this.dispatchOnce();

      if (
        result.claimed > 0 ||
        result.failed > 0
      ) {
        this.logger.log(
          `Outbox dispatch cycle: claimed=${result.claimed}, published=${result.published}, failed=${result.failed}`,
        );
      }
    } catch (
      error
    ) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      this.logger.error(
        `Outbox dispatch cycle failed: ${message}`,
      );
    }
  }

  // ============================================================
  // CLAIM BATCH
  // ============================================================

  private async claimBatch(): Promise<
    OutboxRow[]
  > {
    const now =
      new Date();

    const leaseUntil =
      new Date(
        now.getTime() +
          this.leaseMs,
      );

    return this.database.transaction(
      async (
        client,
      ) => {
        const result =
          await client.query<OutboxRow>(
            `
            WITH candidates AS (
              SELECT
                id

              FROM outbox_events

              WHERE
                (
                  status IN (
                    'PENDING',
                    'FAILED'
                  )

                  AND next_attempt_at <= now()
                )

                OR

                (
                  status =
                    'PROCESSING'

                  AND locked_at IS NOT NULL

                  AND locked_at < now()
                )

              ORDER BY
                created_at ASC

              FOR UPDATE SKIP LOCKED

              LIMIT $1
            )

            UPDATE outbox_events AS oe

            SET
              status =
                'PROCESSING',

              attempts =
                oe.attempts + 1,

              locked_at =
                $2,

              locked_by =
                $3,

              last_attempt_at =
                $4,

              next_attempt_at =
                $5

            FROM candidates

            WHERE
              oe.id =
                candidates.id

            RETURNING
              oe.id::text
                AS id,

              oe.tenant_id::text
                AS tenant_id,

              oe.factory_id::text
                AS factory_id,

              oe.aggregate_type,

              oe.aggregate_id::text
                AS aggregate_id,

              oe.event_type,

              oe.event_version,

              oe.payload,

              oe.status,

              oe.attempts,

              oe.next_attempt_at,

              oe.occurred_at,

              oe.published_at,

              oe.last_error,

              oe.created_at,

              oe.locked_at,

              oe.locked_by,

              oe.last_attempt_at,

              oe.correlation_id::text
                AS correlation_id,

              oe.causation_id::text
                AS causation_id,

              oe.actor,

              oe.source
            `,
            [
              this.batchSize,

              now,

              this.workerId,

              now,

              leaseUntil,
            ],
          );

        return result.rows;
      },
    );
  }

  // ============================================================
  // MARK FAILED
  // ============================================================

  private async markFailed(
    eventId: string,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    const result =
      await this.database.transaction(
        async (
          client,
        ) => {
          const currentResult =
            await client.query<{
              attempts: number;
            }>(
              `
              SELECT
                attempts

              FROM outbox_events

              WHERE
                id = $1

                AND status =
                  'PROCESSING'

                AND locked_by =
                  $2

              LIMIT 1
              `,
              [
                eventId,

                this.workerId,
              ],
            );

          const current =
            currentResult
              .rows[0];

          if (
            !current
          ) {
            return null;
          }

          const attempts =
            Number(
              current.attempts,
            );

          /*
           * Retry schedule:
           *
           * attempt 1  -> 5 sec
           * attempt 2  -> 10 sec
           * attempt 3  -> 20 sec
           * ...
           * maximum    -> 1 hour
           *
           * After maxAttempts the event is scheduled for a long
           * quarantine period while retaining the error.
           */
          const retryDelaySeconds =
            attempts >=
              this.maxAttempts
              ? 24 * 60 * 60
              : Math.min(
                  5 *
                    2 **
                      Math.max(
                        attempts -
                          1,
                        0,
                      ),
                  60 * 60,
                );

          const retryAt =
            new Date(
              Date.now() +
                retryDelaySeconds *
                  1000,
            );

          const updateResult =
            await client.query<{
              id: string;
            }>(
              `
              UPDATE outbox_events

              SET
                status =
                  'FAILED',

                next_attempt_at =
                  $1,

                locked_at =
                  NULL,

                locked_by =
                  NULL,

                last_error =
                  $2

              WHERE
                id = $3

                AND status =
                  'PROCESSING'

                AND locked_by =
                  $4

              RETURNING
                id::text AS id
              `,
              [
                retryAt,

                message,

                eventId,

                this.workerId,
              ],
            );

          if (
            updateResult.rowCount !==
            1
          ) {
            return null;
          }

          return {
            attempts,

            retryAt,
          };
        },
      );

    if (
      !result
    ) {
      return;
    }

    this.logger.error(
      `Outbox event failed: ${eventId}; attempts=${result.attempts}; retryAt=${result.retryAt.toISOString()}`,
    );
  }

  // ============================================================
  // MARK PUBLISHED
  // ============================================================

  private async markPublished(
    eventId: string,
  ): Promise<void> {
    const result =
      await this.database.query(
        `
        UPDATE outbox_events

        SET
          status =
            'PUBLISHED',

          published_at =
            clock_timestamp(),

          locked_at =
            NULL,

          locked_by =
            NULL,

          last_error =
            NULL

        WHERE
          id = $1

          AND status =
            'PROCESSING'

          AND locked_by =
            $2

        RETURNING
          id::text AS id
        `,
        [
          eventId,

          this.workerId,
        ],
      );

    if (
      result.rowCount !==
      1
    ) {
      throw new Error(
        `OUTBOX_MARK_PUBLISHED_FAILED:${eventId}`,
      );
    }
  }
}