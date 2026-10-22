import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { OutboxEvent } from './outbox-event.contract';
import { KafkaEventBusAdapter } from './kafka-event-bus.adapter';

type Row = QueryResultRow;

export interface BusDeadLetterListOptions {
  factoryId?: string | null;
  requestFactoryId?: string | null;
  limit: number;
  offset: number;
}

export interface RedriveBusDeadLetterInput {
  tenantId: string;
  actorUserId: string;
  deadLetterId: string;
  idempotencyKey: string | null;
  requestId?: string | null;
  traceId?: string | null;
  requestFactoryId?: string | null;
}

@Injectable()
export class OutboxBusDlqService {
  private readonly logger = new Logger(OutboxBusDlqService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly kafkaAdapter: KafkaEventBusAdapter,
  ) {}

  async listDeadLetters(tenantId: string, options: BusDeadLetterListOptions) {
    this.assertUuid(tenantId, 'tenantId');
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
      throw new BadRequestException('limit must be between 1 and 200');
    }
    if (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > 1000000) {
      throw new BadRequestException('offset must be between 0 and 1000000');
    }
    if (options.factoryId) this.assertUuid(options.factoryId, 'factoryId');
    if (options.requestFactoryId) this.assertUuid(options.requestFactoryId, 'requestFactoryId');
    if (options.requestFactoryId && options.factoryId && options.requestFactoryId !== options.factoryId) {
      throw new NotFoundException('Broker dead-letter not found');
    }
    const factoryId = options.requestFactoryId ?? options.factoryId ?? null;
    const result = await this.database.query<Row>(
      `SELECT d.id::text AS id,d.tenant_id::text AS tenant_id,d.factory_id::text AS factory_id,
        d.event_id::text AS event_id,d.event_type,d.event_version,d.consumer_name,d.source_topic,
        d.source_partition,d.source_offset::text AS source_offset,d.payload,d.occurred_at::text AS occurred_at,
        d.correlation_id::text AS correlation_id,d.failed_attempts,d.failure_count,d.failure_reason,
        d.failed_at::text AS failed_at,d.status,d.redrive_count,d.last_redriven_at::text AS last_redriven_at,
        d.last_redriven_by::text AS last_redriven_by,d.row_version::int AS row_version,
        (SELECT count(*)::int FROM outbox_bus_dlq_redrive_requests r
          WHERE r.dead_letter_id=d.id AND r.tenant_id=d.tenant_id) AS redrive_request_count,
        COUNT(*) OVER()::int AS total_count
       FROM outbox_bus_dead_letters d
       WHERE d.tenant_id=$1::uuid AND ($2::uuid IS NULL OR d.factory_id=$2::uuid)
       ORDER BY CASE d.status WHEN 'QUARANTINED' THEN 0 WHEN 'REDRIVE_PENDING' THEN 1 ELSE 2 END,
         d.failed_at DESC,d.id DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, factoryId, options.limit, options.offset],
      { tenantId },
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      items: result.rows.map((row) => {
        const { total_count: _totalCount, ...item } = row;
        return item;
      }),
      pagination: {
        limit: options.limit,
        offset: options.offset,
        total,
        has_more: options.offset + result.rows.length < total,
      },
    };
  }

  async redrive(input: RedriveBusDeadLetterInput) {
    this.assertUuid(input.tenantId, 'tenantId');
    this.assertUuid(input.actorUserId, 'actorUserId');
    this.assertUuid(input.deadLetterId, 'deadLetterId');
    if (input.requestId) this.assertUuid(input.requestId, 'requestId');
    if (input.traceId) this.assertUuid(input.traceId, 'traceId');
    if (input.requestFactoryId) this.assertUuid(input.requestFactoryId, 'requestFactoryId');
    if (!this.kafkaAdapter.isEnabled()) {
      throw new ServiceUnavailableException('Broker DLQ redrive requires OUTBOX_TRANSPORT=kafka');
    }
    const idempotencyKey = this.requireIdempotencyKey(input.idempotencyKey);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ operation: 'KAFKA_CONSUMER_DLQ_REDRIVE', version: 1, dead_letter_id: input.deadLetterId }))
      .digest('hex');

    const claim = await this.database.transaction(async (client) => {
      const priorQuery = await client.query<Row>(
        `SELECT r.id::text AS id,r.dead_letter_id::text AS dead_letter_id,r.request_hash,r.status,
          r.lease_until::text AS lease_until,r.attempts,r.row_version::int AS row_version,
          r.published_at::text AS published_at
         FROM outbox_bus_dlq_redrive_requests r
         WHERE r.tenant_id=$1::uuid AND r.idempotency_key=$2
         FOR UPDATE`,
        [input.tenantId, idempotencyKey],
      );
      const prior = priorQuery.rows[0];
      if (prior) {
        if (String(prior.dead_letter_id) !== input.deadLetterId || String(prior.request_hash).trim() !== requestHash) {
          throw new ConflictException('Idempotency-Key was already used for a different broker DLQ redrive');
        }
        if (prior.status === 'PUBLISHED') {
          return {
            alreadyPublished: true,
            requestId: String(prior.id),
            attempt: Number(prior.attempts),
            event: null as OutboxEvent | null,
          };
        }
        const leaseUntil = prior.lease_until ? Date.parse(String(prior.lease_until)) : 0;
        if (prior.status === 'PROCESSING' && leaseUntil > Date.now()) {
          throw new ConflictException('This broker DLQ redrive is already in progress');
        }

        const deadLetter = await this.lockDeadLetter(client, input);
        if (!deadLetter) throw new NotFoundException('Quarantined broker dead-letter not found');
        if (!['QUARANTINED', 'REDRIVE_PENDING'].includes(String(deadLetter.status))) {
          throw new ConflictException('Only a quarantined broker dead-letter can be redriven');
        }
        if (deadLetter.status === 'QUARANTINED') await this.markRedrivePending(client, input, deadLetter);
        const updated = await client.query<Row>(
          `UPDATE outbox_bus_dlq_redrive_requests
           SET status='PROCESSING',attempts=attempts+1,lease_until=clock_timestamp()+INTERVAL '60 seconds',
             last_error=NULL,row_version=row_version+1,updated_at=clock_timestamp()
           WHERE id=$1::uuid AND tenant_id=$2::uuid AND row_version=$3
           RETURNING id::text AS id,attempts`,
          [prior.id, input.tenantId, Number(prior.row_version)],
        );
        if (!updated.rows[0]) throw new ConflictException('Broker DLQ redrive receipt changed concurrently');
        return {
          alreadyPublished: false,
          requestId: String(updated.rows[0].id),
          attempt: Number(updated.rows[0].attempts),
          event: this.eventFromRow(deadLetter.payload),
        };
      }

      const deadLetter = await this.lockDeadLetter(client, input);
      if (!deadLetter || deadLetter.status !== 'QUARANTINED') {
        throw new NotFoundException('Quarantined broker dead-letter not found');
      }
      const inserted = await client.query<Row>(
        `INSERT INTO outbox_bus_dlq_redrive_requests(
          tenant_id,factory_id,dead_letter_id,idempotency_key,request_hash,actor_user_id,status,
          attempts,lease_until,correlation_id,row_version
        ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,'PENDING',0,NULL,$7::uuid,1)
        RETURNING id::text AS id`,
        [input.tenantId, deadLetter.factory_id, input.deadLetterId, idempotencyKey, requestHash,
          input.actorUserId, this.correlation(input)],
      );
      await this.markRedrivePending(client, input, deadLetter);
      const processing = await client.query<Row>(
        `UPDATE outbox_bus_dlq_redrive_requests
         SET status='PROCESSING',attempts=1,lease_until=clock_timestamp()+INTERVAL '60 seconds',
           row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='PENDING'
         RETURNING id::text AS id,attempts`,
        [inserted.rows[0].id, input.tenantId],
      );
      if (!processing.rows[0]) throw new ConflictException('Broker DLQ redrive could not be claimed');
      return {
        alreadyPublished: false,
        requestId: String(processing.rows[0].id),
        attempt: Number(processing.rows[0].attempts),
        event: this.eventFromRow(deadLetter.payload),
      };
    }, {
      tenantId: input.tenantId,
      userId: input.actorUserId,
      requestId: input.requestId,
      traceId: input.traceId,
      advisoryLockKey: `bus-dlq-redrive:${input.tenantId}:${idempotencyKey}`,
    });

    if (claim.alreadyPublished) {
      return { request_id: claim.requestId, status: 'PUBLISHED', replayed_request: true };
    }
    if (!claim.event) throw new ConflictException('Broker DLQ event payload is unavailable');

    try {
      await this.kafkaAdapter.publishRedrive(claim.event, idempotencyKey, claim.requestId);
    } catch (error) {
      const reason = this.errorText(error).slice(0, 3500);
      try {
        await this.database.transaction(async (client) => {
          await client.query(
            `UPDATE outbox_bus_dlq_redrive_requests
             SET status='FAILED',lease_until=NULL,last_error=$4,row_version=row_version+1,
               updated_at=clock_timestamp()
             WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='PROCESSING' AND actor_user_id=$3::uuid`,
            [claim.requestId, input.tenantId, input.actorUserId, reason],
          );
          await client.query(
            `UPDATE outbox_bus_dead_letters
             SET status='QUARANTINED',row_version=row_version+1,updated_by_user_id=$4::uuid,
               updated_at=clock_timestamp()
             WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='REDRIVE_PENDING'`,
            [input.deadLetterId, input.tenantId, null, input.actorUserId],
          );
        }, {
          tenantId: input.tenantId,
          userId: input.actorUserId,
          requestId: input.requestId,
          traceId: input.traceId,
        });
      } catch (receiptError) {
        this.logger.error('Failed to persist broker redrive failure receipt: ' + this.errorText(receiptError));
      }
      throw new ServiceUnavailableException('Broker publish was not confirmed; the DLQ event remains eligible for a retry');
    }

    await this.database.transaction(async (client) => {
      const receipt = await client.query<Row>(
        `UPDATE outbox_bus_dlq_redrive_requests
         SET status='PUBLISHED',published_at=clock_timestamp(),lease_until=NULL,last_error=NULL,
           row_version=row_version+1,updated_at=clock_timestamp()
         WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='PROCESSING'
         RETURNING id::text AS id`,
        [claim.requestId, input.tenantId],
      );
      if (!receipt.rows[0]) throw new ConflictException('Broker DLQ redrive receipt changed before finalization');
      await client.query(
        `UPDATE outbox_bus_dead_letters
         SET status='REDRIVEN',redrive_count=redrive_count+1,last_redriven_at=clock_timestamp(),
           last_redriven_by=$3::uuid,row_version=row_version+1,updated_by_user_id=$3::uuid,
           updated_at=clock_timestamp()
         WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='REDRIVE_PENDING'`,
        [input.deadLetterId, input.tenantId, input.actorUserId],
      );
    }, {
      tenantId: input.tenantId,
      userId: input.actorUserId,
      requestId: input.requestId,
      traceId: input.traceId,
    });

    return { request_id: claim.requestId, status: 'PUBLISHED', replayed_request: false, attempt: claim.attempt };
  }

  private async lockDeadLetter(client: PoolClient, input: RedriveBusDeadLetterInput): Promise<Row | null> {
    const result = await client.query<Row>(
      `SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,
        status,row_version::int AS row_version,payload,event_id::text AS event_id
       FROM outbox_bus_dead_letters
       WHERE id=$1::uuid AND tenant_id=$2::uuid AND ($3::uuid IS NULL OR factory_id=$3::uuid)
       FOR UPDATE`,
      [input.deadLetterId, input.tenantId, input.requestFactoryId ?? null],
    );
    return result.rows[0] ?? null;
  }

  private async markRedrivePending(client: PoolClient, input: RedriveBusDeadLetterInput, deadLetter: Row) {
    const result = await client.query(
      `UPDATE outbox_bus_dead_letters
       SET status='REDRIVE_PENDING',row_version=row_version+1,updated_by_user_id=$4::uuid,updated_at=clock_timestamp()
       WHERE id=$1::uuid AND tenant_id=$2::uuid AND status='QUARANTINED' AND row_version=$3`,
      [input.deadLetterId, input.tenantId, Number(deadLetter.row_version), input.actorUserId],
    );
    if ((result.rowCount ?? 0) !== 1) throw new ConflictException('Broker dead-letter changed concurrently');
  }

  private eventFromRow(value: unknown): OutboxEvent {
    const payload = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Broker dead-letter payload is not a valid event envelope');
    }
    return payload as OutboxEvent;
  }

  private correlation(input: RedriveBusDeadLetterInput): string | null {
    if (input.traceId) return input.traceId;
    if (input.requestId) return input.requestId;
    return null;
  }

  private requireIdempotencyKey(value: string | null): string {
    const key = value?.trim() ?? '';
    if (!key || key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must contain 1–200 visible ASCII characters');
    }
    return key;
  }

  private assertUuid(value: string, name: string): void {
    if (!isUUID(value)) throw new BadRequestException(name + ' must be a UUID');
  }

  private errorText(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }
}
