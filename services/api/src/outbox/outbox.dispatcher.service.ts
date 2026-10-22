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
import { HttpMetricsService } from '../observability/http-metrics.service';

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

interface OutboxMetricsRow {
  status: string | null;
  event_count: string | number;
  oldest_age_seconds: string | number;
  seconds_since_last_publish: string | number;
}

const OUTBOX_METRICS_INTERVAL_MS = 60_000;
const OUTBOX_METRIC_STATUSES = ['PENDING', 'FAILED', 'PROCESSING', 'QUARANTINED'] as const;

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

  private queueMetricsCollectionRunning = false;

  private queueMetricsRefreshRunning = false;

  private queueMetricsRefreshTimer: ReturnType<typeof setInterval> | null = null;

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

    @Optional()
    private readonly metrics?: HttpMetricsService,
  ) {}

  // ============================================================
  // MODULE LIFECYCLE
  // ============================================================

  async onModuleInit(): Promise<void> {
    if (this.metrics) {
      void this.refreshQueueMetrics();
      this.queueMetricsRefreshTimer = setInterval(
        () => void this.refreshQueueMetrics(),
        OUTBOX_METRICS_INTERVAL_MS,
      );
      this.queueMetricsRefreshTimer.unref?.();
    }

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
    if (this.queueMetricsRefreshTimer) {
      clearInterval(this.queueMetricsRefreshTimer);
      this.queueMetricsRefreshTimer = null;
    }

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
           * In local mode, preserve the original in-process pipeline.
           * In Kafka mode, the independent consumer group performs
           * handler work and commits its offset after the handler or
           * durable broker-consumer DLQ transaction succeeds.
           */
          if (typeof this.publisher.usesBrokerTransport !== 'function'
            || !this.publisher.usesBrokerTransport()) {
            const consumerResult =
              await this.consumerRegistry.dispatch(event);

            if (consumerResult.handled) {
              this.logger.log(
                `Outbox event consumed: event_id=${row.id}, tenant_id=${row.tenant_id}, consumer=${consumerResult.consumerName}`,
              );
            }
          }

          /*
           * Kafka mode marks PUBLISHED only after Kafka returns its
           * acks=-1 confirmation. Consumer progress has its own manual
           * offset and DLQ contract; broker acceptance is not consumer completion.
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

  private async refreshQueueMetrics(): Promise<void> {
    if (!this.metrics || this.queueMetricsRefreshRunning) return;
    this.queueMetricsRefreshRunning = true;
    try {
      const tenants = await this.database.query<TenantRow>(
        `SELECT id::text AS id FROM tenants ORDER BY id`,
      );
      await this.collectQueueMetrics(tenants.rows);
    } catch {
      this.metrics.recordOutboxQueueSnapshotFailure();
      this.logger.warn('Outbox queue metrics tenant discovery failed; previous aggregate snapshot retained');
    } finally {
      this.queueMetricsRefreshRunning = false;
    }
  }

  private async collectQueueMetrics(tenants: TenantRow[]): Promise<void> {
    if (!this.metrics || this.queueMetricsCollectionRunning) {
      return;
    }

    this.queueMetricsCollectionRunning = true;
    const counts = new Map<string, number>();
    const oldestAges = new Map<string, number>();
    for (const status of OUTBOX_METRIC_STATUSES) {
      counts.set(status, 0);
      oldestAges.set(status, 0);
    }
    let secondsSinceLastPublish: number | null = null;

    try {
      // outbox_events FORCE ROW LEVEL SECURITY is intentionally preserved.
      // Each aggregate is computed in a transaction scoped to one tenant; only
      // bounded state/count/age values are combined, never IDs or event payloads.
      for (const tenant of tenants) {
        const result = await this.database.query<OutboxMetricsRow>(
          `
          WITH queue_state AS (
            SELECT
              status,
              COUNT(*)::bigint AS event_count,
              GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at))), 0)::double precision
                AS oldest_age_seconds
            FROM outbox_events
            WHERE status IN ('PENDING', 'FAILED', 'PROCESSING', 'QUARANTINED')
            GROUP BY status
          ),
          publication AS (
            SELECT COALESCE(
              EXTRACT(EPOCH FROM (clock_timestamp() - MAX(published_at))),
              -1
            )::double precision AS seconds_since_last_publish
            FROM outbox_events
          )
          SELECT
            queue_state.status,
            COALESCE(queue_state.event_count, 0)::bigint AS event_count,
            COALESCE(queue_state.oldest_age_seconds, 0)::double precision AS oldest_age_seconds,
            publication.seconds_since_last_publish
          FROM publication
          LEFT JOIN queue_state ON TRUE
          `,
          [],
          { tenantId: tenant.id },
        );

        for (const row of result.rows) {
          if (row.status && (OUTBOX_METRIC_STATUSES as readonly string[]).includes(row.status)) {
            const count = Math.max(0, Number(row.event_count) || 0);
            const age = Math.max(0, Number(row.oldest_age_seconds) || 0);
            counts.set(row.status, (counts.get(row.status) ?? 0) + count);
            oldestAges.set(row.status, Math.max(oldestAges.get(row.status) ?? 0, age));
          }
          const publicationAge = Number(row.seconds_since_last_publish);
          if (Number.isFinite(publicationAge) && publicationAge >= 0) {
            secondsSinceLastPublish = secondsSinceLastPublish === null
              ? publicationAge : Math.min(secondsSinceLastPublish, publicationAge);
          }
        }
      }

      this.metrics.recordOutboxQueueSnapshot(
        OUTBOX_METRIC_STATUSES.map((status) => ({
          status,
          count: counts.get(status) ?? 0,
          oldestAgeSeconds: oldestAges.get(status) ?? 0,
        })),
        secondsSinceLastPublish ?? -1,
      );
    } catch {
      // Do not expose tenant identifiers/DB errors and do not replace a valid
      // snapshot with partial values. The snapshot age and health gauges alert
      // operators if a subsequent collection cannot complete.
      this.metrics.recordOutboxQueueSnapshotFailure();
      this.logger.warn('Outbox queue metrics collection failed; previous aggregate snapshot retained');
    } finally {
      this.queueMetricsCollectionRunning = false;
    }
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