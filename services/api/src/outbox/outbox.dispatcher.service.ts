import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../database/database.service';

import {
  OutboxEvent,
  OutboxPublisher,
} from './outbox.publisher';

import {
  OutboxConsumerRegistry,
} from './outbox.consumer.registry';

interface OutboxRow {
  id: string;
  tenant_id: string;
  factory_id: string | null;

  aggregate_type: string;
  aggregate_id: string;

  event_type: string;
  event_version: number;

  payload: Record<string, unknown>;

  status: string;
  attempts: number;

  next_attempt_at: string;

  created_at: string;
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
    ReturnType<typeof setTimeout> | null =
    null;

  private running = false;

  private readonly batchSize = 20;

  private readonly intervalMs = 5000;

  private readonly leaseMs = 60_000;

  private readonly maxAttempts = 10;

  constructor(
    private readonly database: DatabaseService,
    private readonly publisher: OutboxPublisher,
    private readonly consumerRegistry: OutboxConsumerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled =
      process.env.OUTBOX_DISPATCHER_ENABLED !==
      'false';

    if (!enabled) {
      this.logger.warn(
        'Outbox dispatcher is disabled',
      );

      return;
    }

    this.logger.log(
      `Outbox dispatcher started: ${this.workerId}`,
    );

    await this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.logger.log(
      'Outbox dispatcher stopped',
    );
  }

  async dispatchOnce(): Promise<{
    claimed: number;
    published: number;
    failed: number;
  }> {
    const rows =
      await this.claimBatch();

    let published = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const event: OutboxEvent = {
          id: row.id,

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

          payload:
            row.payload,
        };

        // --------------------------------------------------
        // External/local publisher
        // --------------------------------------------------

        await this.publisher.publish(
          event,
        );

        // --------------------------------------------------
        // Local idempotent consumers
        // --------------------------------------------------

        const consumerResult =
          await this.consumerRegistry.dispatch(
            event,
          );

        if (
          consumerResult.handled
        ) {
          this.logger.log(
            `Outbox event consumed: event_id=${event.id}, consumer=${consumerResult.consumerName}`,
          );
        }

        // --------------------------------------------------
        // Mark event complete only after publisher
        // and local consumer processing succeed.
        // --------------------------------------------------

        await this.markPublished(
          row.id,
        );

        published += 1;
      } catch (error) {
        failed += 1;

        await this.markFailed(
          row.id,
          error,
        );
      }
    }

    return {
      claimed: rows.length,
      published,
      failed,
    };
  }

  private async scheduleNext(): Promise<void> {
    if (!this.running) {
      this.running = true;
    }

    await this.runCycle();

    if (!this.running) {
      return;
    }

    this.timer =
      setTimeout(
        () => {
          void this.scheduleNext();
        },
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
          `Outbox cycle: claimed=${result.claimed}, published=${result.published}, failed=${result.failed}`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Outbox dispatch cycle failed',
        error instanceof Error
          ? error.stack
          : String(error),
      );
    }
  }

  /**
   * Claims a batch of outbox events atomically.
   *
   * Claim rules:
   *
   * 1. PENDING / FAILED events are eligible when
   *    next_attempt_at <= now().
   *
   * 2. PROCESSING events are eligible only when
   *    their lease has expired based on locked_at.
   *
   * 3. FOR UPDATE SKIP LOCKED prevents concurrent workers
   *    from claiming the same rows in the same moment.
   *
   * 4. The selected rows are changed to PROCESSING,
   *    attempts are incremented and a fresh lease is assigned
   *    in the same SQL statement/transaction.
   */
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
      async (client) => {
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
                  status = 'PROCESSING'

                  AND (
                    locked_at IS NULL

                    OR locked_at <=
                      now() -
                      (
                        $1::double precision
                        * interval '1 millisecond'
                      )
                  )
                )

              ORDER BY
                created_at ASC

              FOR UPDATE SKIP LOCKED

              LIMIT $2
            ),

            claimed AS (
              UPDATE outbox_events AS event

              SET
                status =
                  'PROCESSING',

                attempts =
                  event.attempts + 1,

                locked_at =
                  $3,

                locked_by =
                  $4,

                last_attempt_at =
                  now(),

                next_attempt_at =
                  $5

              FROM candidates

              WHERE
                event.id =
                  candidates.id

              RETURNING
                event.id::text
                  AS id,

                event.tenant_id::text
                  AS tenant_id,

                event.factory_id::text
                  AS factory_id,

                event.aggregate_type,

                event.aggregate_id::text
                  AS aggregate_id,

                event.event_type,

                event.event_version,

                event.payload,

                event.status,

                event.attempts,

                event.next_attempt_at::text
                  AS next_attempt_at,

                event.created_at::text
                  AS created_at
            )

            SELECT
              id,
              tenant_id,
              factory_id,
              aggregate_type,
              aggregate_id,
              event_type,
              event_version,
              payload,
              status,
              attempts,
              next_attempt_at,
              created_at

            FROM claimed

            ORDER BY
              created_at ASC
            `,
            [
              this.leaseMs,
              this.batchSize,
              now,
              this.workerId,
              leaseUntil,
            ],
          );

        return result.rows;
      },
    );
  }

  private async markFailed(
    eventId: string,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    const result =
      await this.database.query<{
        attempts: number;
      }>(
        `
        SELECT
          attempts

        FROM outbox_events

        WHERE
          id = $1
          AND status = 'PROCESSING'
          AND locked_by = $2

        LIMIT 1
        `,
        [
          eventId,
          this.workerId,
        ],
      );

    const attempts =
      result.rows[0]
        ?.attempts ??
      1;

    const delaySeconds =
      Math.min(
        5 *
          Math.pow(
            2,
            Math.max(
              attempts - 1,
              0,
            ),
          ),
        3600,
      );

    const nextAttemptAt =
      new Date(
        Date.now() +
          delaySeconds *
            1000,
      );

    const permanentlyFailed =
      attempts >=
      this.maxAttempts;

    const finalNextAttempt =
      permanentlyFailed
        ? new Date(
            Date.now() +
              24 *
                60 *
                60 *
                1000,
          )
        : nextAttemptAt;

    await this.database.query(
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
        AND status = 'PROCESSING'
        AND locked_by = $4
      `,
      [
        finalNextAttempt,
        message.substring(
          0,
          5000,
        ),
        eventId,
        this.workerId,
      ],
    );

    this.logger.error(
      `Outbox event failed: ${eventId}; attempts=${attempts}; retryAt=${finalNextAttempt.toISOString()}`,
    );
  }

  private async markPublished(
    eventId: string,
  ): Promise<void> {
    const result =
      await this.database.query<{
        id: string;
      }>(
        `
        UPDATE outbox_events

        SET
          status =
            'PUBLISHED',

          published_at =
            now(),

          locked_at =
            NULL,

          locked_by =
            NULL,

          last_error =
            NULL

        WHERE
          id = $1
          AND status = 'PROCESSING'
          AND locked_by = $2

        RETURNING
          id
        `,
        [
          eventId,
          this.workerId,
        ],
      );

    if (
      result.rowCount !== 1
    ) {
      throw new Error(
        `OUTBOX_MARK_PUBLISHED_FAILED: event=${eventId} was not transitioned to PUBLISHED by worker=${this.workerId}`,
      );
    }
  }
}