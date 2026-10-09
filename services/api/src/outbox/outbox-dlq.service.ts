import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  isUUID,
} from 'class-validator';

import {
  AuditService,
} from '../audit/audit.service';

import {
  DatabaseService,
} from '../database/database.service';

interface QuarantinedOutboxRow {
  id: string;

  tenant_id: string;

  factory_id:
    | string
    | null;

  aggregate_type: string;

  aggregate_id: string;

  event_type: string;

  event_version: number;

  status: string;

  attempts: number;

  last_error:
    | string
    | null;

  occurred_at: Date;

  created_at: Date;

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

  last_replayed_at:
    | Date
    | null;

  last_replayed_by:
    | string
    | null;

  correlation_id:
    | string
    | null;

  causation_id:
    | string
    | null;

  actor:
    | Record<
        string,
        unknown
      >
    | null;

  source:
    | Record<
        string,
        unknown
      >
    | null;

  payload:
    Record<
      string,
      unknown
    >;

  total_count: number;
}

export interface ListQuarantinedOptions {
  factoryId?:
    | string
    | null;

  requestFactoryId?:
    | string
    | null;

  limit: number;

  offset: number;
}

export interface ReplayOutboxInput {
  tenantId: string;

  actorUserId: string;

  eventId: string;

  requestId:
    | string
    | null;

  traceId:
    | string
    | null;

  requestFactoryId:
    | string
    | null;
}

@Injectable()
export class OutboxDlqService {
  constructor(
    private readonly database:
      DatabaseService,

    private readonly auditService:
      AuditService,
  ) {}

  async listQuarantined(
    tenantId: string,
    options:
      ListQuarantinedOptions,
  ) {
    this.assertUuid(
      tenantId,
      'tenantId',
    );

    const requestedFactoryId =
      options.factoryId ??
      null;

    const requestFactoryId =
      options.requestFactoryId ??
      null;

    if (
      requestFactoryId &&
      requestedFactoryId &&
      requestFactoryId !==
        requestedFactoryId
    ) {
      throw new NotFoundException(
        'Quarantined outbox event not found',
      );
    }

    const effectiveFactoryId =
      requestFactoryId ??
      requestedFactoryId;

    if (
      effectiveFactoryId
    ) {
      this.assertUuid(
        effectiveFactoryId,
        'factoryId',
      );
    }

    const limit =
      Math.min(
        Math.max(
          Number(
            options.limit,
          ) || 50,
          1,
        ),
        100,
      );

    const offset =
      Math.max(
        Number(
          options.offset,
        ) || 0,
        0,
      );

    const result =
      await this.database.query<QuarantinedOutboxRow>(
        `
        SELECT
          id::text AS id,

          tenant_id::text
            AS tenant_id,

          factory_id::text
            AS factory_id,

          aggregate_type,

          aggregate_id::text
            AS aggregate_id,

          event_type,

          event_version,

          status,

          attempts,

          last_error,

          occurred_at,

          created_at,

          quarantined_at,

          quarantined_by,

          quarantine_reason,

          replay_count,

          last_replayed_at,

          last_replayed_by::text
            AS last_replayed_by,

          correlation_id::text
            AS correlation_id,

          causation_id::text
            AS causation_id,

          actor,

          source,

          payload,

          COUNT(*) OVER()::int
            AS total_count

        FROM outbox_events

        WHERE
          tenant_id = $1

          AND status =
            'QUARANTINED'

          AND (
            $2::uuid IS NULL
            OR factory_id = $2
          )

        ORDER BY
          quarantined_at
            DESC NULLS LAST,

          created_at
            DESC,

          id DESC

        LIMIT $3

        OFFSET $4
        `,
        [
          tenantId,
          effectiveFactoryId,
          limit,
          offset,
        ],
        {
          tenantId,
        },
      );

    const total =
      result.rows[0]
        ?.total_count ??
      0;

    return {
      items:
        result.rows.map(
          (
            row,
          ) => ({
            id:
              row.id,

            tenant_id:
              row.tenant_id,

            factory_id:
              row.factory_id,

            aggregate_type:
              row.aggregate_type,

            aggregate_id:
              row.aggregate_id,

            event_type:
              row.event_type,

            event_version:
              row.event_version,

            status:
              row.status,

            attempts:
              Number(
                row.attempts,
              ),

            last_error:
              row.last_error,

            occurred_at:
              row.occurred_at,

            created_at:
              row.created_at,

            quarantined_at:
              row.quarantined_at,

            quarantined_by:
              row.quarantined_by,

            quarantine_reason:
              row.quarantine_reason,

            replay_count:
              Number(
                row.replay_count,
              ),

            last_replayed_at:
              row.last_replayed_at,

            last_replayed_by:
              row.last_replayed_by,

            correlation_id:
              row.correlation_id,

            causation_id:
              row.causation_id,

            actor:
              row.actor,

            source:
              row.source,

            payload:
              row.payload,
          }),
        ),

      pagination: {
        limit,

        offset,

        total,

        has_more:
          offset +
            result.rows.length <
          total,
      },
    };
  }

  async replay(
    input: ReplayOutboxInput,
  ) {
    this.assertUuid(
      input.tenantId,
      'tenantId',
    );

    this.assertUuid(
      input.actorUserId,
      'actorUserId',
    );

    this.assertUuid(
      input.eventId,
      'eventId',
    );

    if (
      input.requestId
    ) {
      this.assertUuid(
        input.requestId,
        'requestId',
      );
    }

    if (
      input.traceId
    ) {
      this.assertUuid(
        input.traceId,
        'traceId',
      );
    }

    if (
      input.requestFactoryId
    ) {
      this.assertUuid(
        input.requestFactoryId,
        'requestFactoryId',
      );
    }

    const updated =
      await this.database.transaction(
        async (
          client,
        ) => {
          const currentResult =
            await client.query<{
              id: string;

              factory_id:
                | string
                | null;

              event_type: string;

              event_version: number;

              attempts: number;

              replay_count: number;

              status: string;

              correlation_id:
                | string
                | null;
            }>(
              `
              SELECT
                id::text AS id,

                factory_id::text
                  AS factory_id,

                event_type,

                event_version,

                attempts,

                replay_count,

                status,

                correlation_id::text
                  AS correlation_id

              FROM outbox_events

              WHERE
                tenant_id = $1

                AND id = $2

                AND status =
                  'QUARANTINED'

              FOR UPDATE
              `,
              [
                input.tenantId,
                input.eventId,
              ],
            );

          const current =
            currentResult.rows[0];

          if (
            !current
          ) {
            throw new NotFoundException(
              'Quarantined outbox event not found',
            );
          }

          if (
            current.factory_id &&
            input.requestFactoryId &&
            current.factory_id !==
              input.requestFactoryId
          ) {
            throw new NotFoundException(
              'Quarantined outbox event not found',
            );
          }

          const updateResult =
            await client.query<{
              id: string;

              event_type: string;

              event_version: number;

              replay_count: number;
            }>(
              `
              UPDATE outbox_events

              SET
                status =
                  'PENDING',

                next_attempt_at =
                  clock_timestamp(),

                locked_at =
                  NULL,

                locked_by =
                  NULL,

                last_replayed_at =
                  clock_timestamp(),

                last_replayed_by =
                  $2,

                quarantined_at =
                  NULL,

                quarantined_by =
                  NULL,

                quarantine_reason =
                  NULL,

                replay_count =
                  replay_count + 1

              WHERE
                id = $1

                AND tenant_id = $3

                AND status =
                  'QUARANTINED'

              RETURNING
                id::text AS id,

                event_type,

                event_version,

                replay_count
              `,
              [
                input.eventId,

                input.actorUserId,

                input.tenantId,
              ],
            );

          if (
            updateResult.rowCount !==
            1
          ) {
            throw new NotFoundException(
              'Quarantined outbox event not found',
            );
          }

          const row =
            updateResult.rows[0];

          return {
            ...row,

            previousAttempts:
              Number(
                current.attempts,
              ),

            correlationId:
              current.correlation_id,

            factoryId:
              current.factory_id,
          };
        },
        {
          tenantId:
            input.tenantId,

          userId:
            input.actorUserId,
        },
      );

    try {
      await this.auditService.record({
        tenantId:
          input.tenantId,

        factoryId:
          updated.factoryId,

        actorUserId:
          input.actorUserId,

        eventType:
          'OUTBOX_EVENT',

        action:
          'REPLAY_REQUESTED',

        resourceType:
          'OUTBOX_EVENT',

        resourceId:
          input.eventId,

        correlationId:
          input.traceId ??
          updated.correlationId,

        requestId:
          input.requestId,

        dataClass:
          'INTERNAL',

        payload: {
          event_id:
            input.eventId,

          event_type:
            updated.event_type,

          event_version:
            updated.event_version,

          previous_attempts:
            updated.previousAttempts,

          replay_count:
            Number(
              updated.replay_count,
            ),
        },
      });
    } catch {
      /*
       * Replay already committed.
       */
    }

    return {
      event_id:
        updated.id,

      event_type:
        updated.event_type,

      event_version:
        updated.event_version,

      status:
        'PENDING',

      replay_count:
        Number(
          updated.replay_count,
        ),

      previous_attempts:
        updated.previousAttempts,
    };
  }

  private assertUuid(
    value: string,
    field: string,
  ): void {
    if (
      !isUUID(value)
    ) {
      throw new UnauthorizedException(
        `${field} must be a valid UUID`,
      );
    }
  }
}