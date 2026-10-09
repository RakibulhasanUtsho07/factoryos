import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service';
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

  actor:
    | OutboxActor
    | null;

  source:
    | OutboxSource
    | null;
}

interface FailedOutboxContext {
  attempts: number;

  tenantId: string;

  factoryId:
    | string
    | null;

  eventType: string;

  eventVersion: number;

  correlationId:
    | string
    | null;
}

interface FailureResult {
  quarantined: boolean;

  attempts: number;

  retryAt:
    | Date
    | null;

  context:
    | FailedOutboxContext
    | null;
}

interface TenantRow {
  id: string;
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
    | null =
      null;

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
    private readonly database:
      DatabaseService,

    private readonly publisher:
      OutboxPublisher,

    private readonly consumerRegistry:
      OutboxConsumerRegistry,

    @Optional()
    private readonly auditService?:
      AuditService,
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
      this.timer !==
      null
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
    /*
     * ----------------------------------------------------------
     * RLS REQUIREMENT
     * ----------------------------------------------------------
     *
     * The outbox is tenant scoped.
     *
     * We first discover tenant IDs from the global
     * control-plane table and then execute each tenant's
     * outbox work under transaction-local RLS context.
     */
    const tenants =
      await this.database.query<TenantRow>(
        `
        SELECT
          id::text AS id

        FROM tenants

        ORDER BY
          id
        `,
      );

    let claimed =
      0;

    let published =
      0;

    let failed =
      0;

    /*
     * Process tenants independently.
     *
     * Failure of one tenant must not stop the remaining tenants.
     */
    for (
      const tenant of
        tenants.rows
    ) {
      let rows:
        | OutboxRow[]
        = [];

      try {
        rows =
          await this.claimBatch(
            tenant.id,
          );
      } catch (
        error
      ) {
        const message =
          error instanceof Error
            ? error.message
            : String(
                error,
              );

        this.logger.error(
          `Outbox tenant claim failed: tenant_id=${tenant.id}; error=${message}`,
        );

        continue;
      }

      claimed +=
        rows.length;

      for (
        const row of
          rows
      ) {
        try {
          const event:
            OutboxEvent =
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
           * Publisher is the canonical contract boundary.
           *
           * It validates/deep-freezes the event snapshot.
           */
          await this.publisher.publish(
            event,
          );

          /*
           * Local consumers receive the exact same
           * immutable event snapshot.
           */
          const consumerResult =
            await this.consumerRegistry.dispatch(
              event,
            );

          if (
            consumerResult.handled
          ) {
            this.logger.log(
              `Outbox event consumed: event_id=${row.id}, tenant_id=${row.tenant_id}, consumer=${consumerResult.consumerName}`,
            );
          }

          /*
           * Event becomes PUBLISHED only after publisher
           * and all local consumers succeed.
           */
          await this.markPublished(
            row.id,
            row.tenant_id,
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
            row.tenant_id,
            error,
          );
        }
      }
    }

    return {
      claimed,

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
        result.claimed >
          0 ||
        result.failed >
          0
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
          : String(
              error,
            );

      this.logger.error(
        `Outbox dispatch cycle failed: ${message}`,
      );
    }
  }

  // ============================================================
  // CLAIM BATCH
  // ============================================================

  private async claimBatch(
    tenantId: string,
  ): Promise<
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
                tenant_id = $1

                AND (
                  (
                    status IN (
                      'PENDING',
                      'FAILED'
                    )

                    AND next_attempt_at <=
                      now()
                  )

                  OR

                  (
                    status =
                      'PROCESSING'

                    AND (
                      locked_at IS NULL

                      OR locked_at <=
                        now() -
                        interval '60 seconds'
                    )
                  )
                )

              ORDER BY
                created_at ASC,
                id ASC

              FOR UPDATE SKIP LOCKED

              LIMIT $2
            )

            UPDATE outbox_events AS oe

            SET
              status =
                'PROCESSING',

              attempts =
                oe.attempts + 1,

              locked_at =
                $3,

              locked_by =
                $4,

              last_attempt_at =
                $5,

              next_attempt_at =
                $6

            FROM candidates

            WHERE
              oe.id =
                candidates.id

              AND oe.tenant_id =
                $1

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
              tenantId,

              this.batchSize,

              now,

              this.workerId,

              now,

              leaseUntil,
            ],
          );

        return result.rows;
      },
      {
        tenantId,
      },
    );
  }

  // ============================================================
  // MARK FAILED / QUARANTINED
  // ============================================================

  private async markFailed(
    eventId: string,
    tenantId: string,
    error: unknown,
  ): Promise<void> {
    const message =
      error instanceof Error
        ? error.message
        : String(
            error,
          );

    const result =
      await this.database.transaction(
        async (
          client,
        ): Promise<
          FailureResult |
          null
        > => {
          const currentResult =
            await client.query<{
              attempts: number;

              tenant_id: string;

              factory_id:
                | string
                | null;

              event_type: string;

              event_version: number;

              correlation_id:
                | string
                | null;
            }>(
              `
              SELECT
                attempts,

                tenant_id::text
                  AS tenant_id,

                factory_id::text
                  AS factory_id,

                event_type,

                event_version,

                correlation_id::text
                  AS correlation_id

              FROM outbox_events

              WHERE
                id = $1

                AND tenant_id = $3

                AND status =
                  'PROCESSING'

                AND locked_by =
                  $2

              LIMIT 1

              FOR UPDATE
              `,
              [
                eventId,

                this.workerId,

                tenantId,
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

          const context:
            FailedOutboxContext =
            {
              attempts,

              tenantId:
                current.tenant_id,

              factoryId:
                current.factory_id,

              eventType:
                current.event_type,

              eventVersion:
                Number(
                  current.event_version,
                ),

              correlationId:
                current.correlation_id,
            };

          /*
           * ----------------------------------------------------
           * TERMINAL FAILURE / QUARANTINE
           * ----------------------------------------------------
           */
          if (
            attempts >=
            this.maxAttempts
          ) {
            const quarantineResult =
              await client.query<{
                id: string;
              }>(
                `
                UPDATE outbox_events

                SET
                  status =
                    'QUARANTINED',

                  quarantined_at =
                    clock_timestamp(),

                  quarantined_by =
                    $1,

                  quarantine_reason =
                    $2,

                  locked_at =
                    NULL,

                  locked_by =
                    NULL,

                  last_error =
                    $2

                WHERE
                  id = $3

                  AND tenant_id =
                    $4

                  AND status =
                    'PROCESSING'

                  AND locked_by =
                    $1

                RETURNING
                  id::text AS id
                `,
                [
                  this.workerId,

                  message,

                  eventId,

                  tenantId,
                ],
              );

            if (
              quarantineResult.rowCount !==
              1
            ) {
              return null;
            }

            return {
              quarantined:
                true,

              attempts,

              retryAt:
                null,

              context,
            };
          }

          /*
           * ----------------------------------------------------
           * NORMAL RETRY
           * ----------------------------------------------------
           *
           * attempt 1 -> 5 sec
           * attempt 2 -> 10 sec
           * attempt 3 -> 20 sec
           * ...
           * capped at 1 hour.
           */
          const retryDelaySeconds =
            Math.min(
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

                AND tenant_id =
                  $4

                AND status =
                  'PROCESSING'

                AND locked_by =
                  $5

              RETURNING
                id::text AS id
              `,
              [
                retryAt,

                message,

                eventId,

                tenantId,

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
            quarantined:
              false,

            attempts,

            retryAt,

            context,
          };
        },
        {
          tenantId,
        },
      );

    if (
      !result
    ) {
      return;
    }

    // ----------------------------------------------------------
    // QUARANTINED
    // ----------------------------------------------------------

    if (
      result.quarantined
    ) {
      this.logger.error(
        `Outbox event quarantined: event_id=${eventId}; tenant_id=${tenantId}; attempts=${result.attempts}; reason=${message}`,
      );

      await this.recordQuarantineAudit(
        eventId,
        result.attempts,
        message,
        result.context,
      );

      return;
    }

    // ----------------------------------------------------------
    // NORMAL FAILURE / RETRY
    // ----------------------------------------------------------

    if (
      result.retryAt
    ) {
      this.logger.error(
        `Outbox event failed: event_id=${eventId}; tenant_id=${tenantId}; attempts=${result.attempts}; retryAt=${result.retryAt.toISOString()}`,
      );
    }
  }

  // ============================================================
  // QUARANTINE AUDIT
  // ============================================================

  private async recordQuarantineAudit(
    eventId: string,
    attempts: number,
    reason: string,
    context:
      | FailedOutboxContext
      | null,
  ): Promise<void> {
    if (
      !this.auditService
    ) {
      this.logger.warn(
        `Outbox quarantine audit skipped because AuditService is unavailable: event_id=${eventId}`,
      );

      return;
    }

    if (
      !context
    ) {
      this.logger.error(
        `Outbox quarantine audit context unavailable: event_id=${eventId}`,
      );

      return;
    }

    try {
      await this.auditService.record({
        tenantId:
          context.tenantId,

        factoryId:
          context.factoryId,

        actorUserId:
          null,

        eventType:
          'OUTBOX_EVENT',

        action:
          'QUARANTINED',

        resourceType:
          'OUTBOX_EVENT',

        resourceId:
          eventId,

        correlationId:
          context.correlationId,

        dataClass:
          'INTERNAL',

        payload: {
          event_id:
            eventId,

          event_type:
            context.eventType,

          event_version:
            context.eventVersion,

          attempts,

          reason,

          worker_id:
            this.workerId,
        },
      });
    } catch (
      auditError
    ) {
      const auditMessage =
        auditError instanceof Error
          ? auditError.message
          : String(
              auditError,
            );

      /*
       * Quarantine state has already been committed.
       */
      this.logger.error(
        `Outbox quarantine audit failed: event_id=${eventId}; tenant_id=${context.tenantId}; error=${auditMessage}`,
      );
    }
  }

  // ============================================================
  // MARK PUBLISHED
  // ============================================================

  private async markPublished(
    eventId: string,
    tenantId: string,
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

          AND tenant_id =
            $2

          AND status =
            'PROCESSING'

          AND locked_by =
            $3

        RETURNING
          id::text AS id
        `,
        [
          eventId,

          tenantId,

          this.workerId,
        ],
        {
          tenantId,
        },
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