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
  implements OnModuleInit, OnModuleDestroy
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
        await this.publisher.publish({
          id: row.id,
          tenantId: row.tenant_id,
          factoryId: row.factory_id,
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
        });

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

    this.timer = setTimeout(
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

  private async claimBatch(): Promise<
    OutboxRow[]
  > {
    const now = new Date();

    const leaseUntil =
      new Date(
        now.getTime() +
          this.leaseMs,
      );

    return this.database.transaction(
      async (client) => {
        /*
         * Recover stale PROCESSING events.
         *
         * A worker may have crashed after claiming
         * an event but before publishing it.
         */
        await client.query(
          `
          UPDATE outbox_events
          SET
            status = 'PENDING',
            locked_at = NULL,
            locked_by = NULL
          WHERE status = 'PROCESSING'
            AND next_attempt_at <= now()
          `,
        );

        /*
         * Claim pending/retryable events.
         *
         * FOR UPDATE SKIP LOCKED allows multiple
         * workers/instances to operate safely.
         */
        const result =
          await client.query<OutboxRow>(
            `
            SELECT
              id::text AS id,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,

              aggregate_type,
              aggregate_id::text AS aggregate_id,

              event_type,
              event_version,

              payload,

              status,
              attempts,

              next_attempt_at::text
                AS next_attempt_at,

              created_at::text
                AS created_at

            FROM outbox_events

            WHERE
              (
                status IN ('PENDING', 'FAILED')
                AND next_attempt_at <= now()
              )

              OR

              (
                status = 'PROCESSING'
                AND next_attempt_at <= now()
              )

            ORDER BY
              created_at ASC

            FOR UPDATE SKIP LOCKED

            LIMIT $1
            `,
            [this.batchSize],
          );

        if (result.rows.length === 0) {
          return [];
        }

        const ids =
          result.rows.map(
            (row) => row.id,
          );

        await client.query(
          `
          UPDATE outbox_events

          SET
            status = 'PROCESSING',

            attempts = attempts + 1,

            locked_at = $1,

            locked_by = $2,

            last_attempt_at = now(),

            next_attempt_at = $3
          
          WHERE id = ANY($4::uuid[])
          `,
          [
            now,
            this.workerId,
            leaseUntil,
            ids,
          ],
        );

        return result.rows;
      },
    );
  }

  private async markPublished(
    eventId: string,
  ): Promise<void> {
    await this.database.query(
      `
      UPDATE outbox_events

      SET
        status = 'PUBLISHED',

        published_at = now(),

        locked_at = NULL,

        locked_by = NULL,

        last_error = NULL

      WHERE id = $1
        AND status = 'PROCESSING'
        AND locked_by = $2
      `,
      [
        eventId,
        this.workerId,
      ],
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

    /*
     * Reload attempts so retry delay is based
     * on the current delivery count.
     */
    const result =
      await this.database.query<{
        attempts: number;
      }>(
        `
        SELECT attempts
        FROM outbox_events
        WHERE id = $1
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
      result.rows[0]?.attempts ?? 1;

    /*
     * Exponential backoff:
     *
     * 1st failure  = 5s
     * 2nd           = 10s
     * 3rd           = 20s
     * ...
     *
     * capped at 1 hour.
     */
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

    /*
     * After maxAttempts the event remains FAILED
     * with the next retry pushed 24h away.
     */
    const permanentlyFailed =
      attempts >= this.maxAttempts;

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
        status = 'FAILED',

        next_attempt_at = $1,

        locked_at = NULL,

        locked_by = NULL,

        last_error = $2

      WHERE id = $3
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
  
  constructor(
    private readonly database: DatabaseService,
    private readonly publisher: OutboxPublisher,
  ) {}
}