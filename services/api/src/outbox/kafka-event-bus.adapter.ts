import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Kafka,
  logLevel,
} from 'kafkajs';
import type {
  Consumer,
  EachMessagePayload,
  KafkaConfig,
  Producer,
  SASLOptions,
} from 'kafkajs';
import { DatabaseService } from '../database/database.service';
import { assertValidOutboxEvent } from './outbox-event.contract';
import type { OutboxEvent } from './outbox-event.contract';
import { OutboxConsumerRegistry } from './outbox.consumer.registry';

const DEFAULT_TOPIC = 'factoryos.domain-events';
const DEFAULT_DLQ_TOPIC = 'factoryos.domain-events.dlq';
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 200;
const MAX_FAILURE_REASON = 3500;

@Injectable()
export class KafkaEventBusAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaEventBusAdapter.name);
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private readonly clientInstance = randomUUID();

  constructor(
    private readonly database: DatabaseService,
    private readonly consumers: OutboxConsumerRegistry,
  ) {}

  isEnabled(): boolean {
    return (process.env.OUTBOX_TRANSPORT ?? 'local').trim().toLowerCase() === 'kafka';
  }

  async onModuleInit(): Promise<void> {
    const transport = (process.env.OUTBOX_TRANSPORT ?? 'local').trim().toLowerCase();
    if (transport !== 'local' && transport !== 'kafka') {
      throw new Error('OUTBOX_TRANSPORT must be one of: local, kafka');
    }
    if (process.env.NODE_ENV === 'production' && transport !== 'kafka') {
      throw new Error('Production startup requires OUTBOX_TRANSPORT=kafka; local log publication is not durable transport');
    }
    if (transport !== 'kafka') return;

    const config = this.kafkaConfig();
    this.kafka = new Kafka(config);
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 1,
      retry: { retries: 8, initialRetryTime: 250, maxRetryTime: 5000 },
    });
    await this.producer.connect();

    this.consumer = this.kafka.consumer({
      groupId: this.requiredEnv('KAFKA_CONSUMER_GROUP_ID', 'factoryos-api-consumers-v1'),
      allowAutoTopicCreation: false,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      retry: { retries: 8, initialRetryTime: 250, maxRetryTime: 5000 },
    });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic(), fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachMessage: async (record) => this.handleMessage(record),
    });
    this.logger.log(JSON.stringify({
      event: 'KAFKA_EVENT_BUS_READY',
      brokers: this.brokers(),
      topic: this.topic(),
      dlqTopic: this.dlqTopic(),
      consumerGroup: this.requiredEnv('KAFKA_CONSUMER_GROUP_ID', 'factoryos-api-consumers-v1'),
      publisherAcknowledgements: 'all-in-sync-replicas',
      consumerOffsetCommit: 'after-handler-or-durable-dead-letter',
    }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.consumer) {
      try {
        await this.consumer.stop();
      } catch (error) {
        this.logger.warn('Kafka consumer stop reported an error: ' + this.errorText(error));
      }
      try {
        await this.consumer.disconnect();
      } catch (error) {
        this.logger.warn('Kafka consumer disconnect reported an error: ' + this.errorText(error));
      }
      this.consumer = null;
    }
    if (this.producer) {
      try {
        await this.producer.disconnect();
      } catch (error) {
        this.logger.warn('Kafka producer disconnect reported an error: ' + this.errorText(error));
      }
      this.producer = null;
    }
    this.kafka = null;
  }

  async publish(event: OutboxEvent): Promise<void> {
    if (!this.isEnabled()) throw new Error('KafkaEventBusAdapter cannot publish when OUTBOX_TRANSPORT is not kafka');
    const producer = this.producer;
    if (!producer) throw new Error('Kafka producer is not connected; outbox publish must be retried');
    const valid = assertValidOutboxEvent(event);
    await producer.send({
      topic: this.topic(),
      acks: -1,
      timeout: this.requestTimeoutMs(),
      messages: [{
        key: this.aggregateKey(valid),
        value: JSON.stringify(valid),
        headers: this.eventHeaders(valid),
      }],
    });
    this.logger.debug(JSON.stringify({
      event: 'KAFKA_PUBLISH_CONFIRMED',
      eventId: valid.id,
      eventType: valid.eventType,
      eventVersion: valid.eventVersion,
      aggregateType: valid.aggregateType,
      aggregateId: valid.aggregateId,
      topic: this.topic(),
      guarantee: 'acks=-1',
    }));
  }

  async publishRedrive(event: OutboxEvent, idempotencyKey: string, requestId: string): Promise<void> {
    if (!this.isEnabled()) throw new Error('Broker DLQ redrive requires OUTBOX_TRANSPORT=kafka');
    const producer = this.producer;
    if (!producer) throw new Error('Kafka producer is not connected; redrive must be retried');
    const valid = assertValidOutboxEvent(event);
    await producer.send({
      topic: this.topic(),
      acks: -1,
      timeout: this.requestTimeoutMs(),
      messages: [{
        key: this.aggregateKey(valid),
        value: JSON.stringify(valid),
        headers: {
          ...this.eventHeaders(valid),
          'x-factoryos-redrive-idempotency-key': idempotencyKey,
          'x-factoryos-redrive-request-id': requestId,
          'x-factoryos-redriven-at': new Date().toISOString(),
        },
      }],
    });
    this.logger.log(JSON.stringify({
      event: 'KAFKA_DLQ_REDRIVE_CONFIRMED',
      eventId: valid.id,
      requestId,
      eventType: valid.eventType,
      topic: this.topic(),
      guarantee: 'acks=-1',
    }));
  }

  private kafkaConfig(): KafkaConfig {
    const brokers = this.brokers();
    const sslEnabled = process.env.KAFKA_SSL === 'true';
    const mechanism = process.env.KAFKA_SASL_MECHANISM?.trim().toLowerCase();
    const username = process.env.KAFKA_SASL_USERNAME;
    const password = process.env.KAFKA_SASL_PASSWORD;
    let sasl: SASLOptions | undefined;

    if (mechanism || username || password) {
      if (!mechanism || !username || !password) {
        throw new Error('Kafka SASL requires KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD together');
      }
      if (!['plain', 'scram-sha-256', 'scram-sha-512'].includes(mechanism)) {
        throw new Error('KAFKA_SASL_MECHANISM must be plain, scram-sha-256 or scram-sha-512');
      }
      sasl = {
        mechanism: mechanism as SASLOptions['mechanism'],
        username,
        password,
      } as SASLOptions;
    }

    if (process.env.NODE_ENV === 'production' && (!sslEnabled || !sasl)) {
      throw new Error('Production Kafka transport requires KAFKA_SSL=true and SASL credentials from a secret manager');
    }

    return {
      clientId: this.requiredEnv('KAFKA_CLIENT_ID', 'factoryos-api') + '-' + this.clientInstance.slice(0, 8),
      brokers,
      ssl: sslEnabled,
      sasl,
      logLevel: process.env.KAFKA_CLIENT_LOG_LEVEL === 'debug' ? logLevel.DEBUG : logLevel.ERROR,
      connectionTimeout: this.requestTimeoutMs(),
      requestTimeout: this.requestTimeoutMs(),
      retry: { retries: 8, initialRetryTime: 250, maxRetryTime: 5000 },
    };
  }

  private async handleMessage(record: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = record;
    const raw = message.value?.toString('utf8') ?? '';
    let event: OutboxEvent;

    try {
      event = assertValidOutboxEvent(JSON.parse(raw) as OutboxEvent);
      const headerEventId = this.headerText(message.headers?.['event-id']);
      const headerType = this.headerText(message.headers?.['event-type']);
      const headerVersion = this.headerText(message.headers?.['event-version']);
      if (headerEventId && headerEventId !== event.id) throw new Error('Kafka event-id header does not match the event envelope');
      if (headerType && headerType !== event.eventType) throw new Error('Kafka event-type header does not match the event envelope');
      if (headerVersion && Number(headerVersion) !== event.eventVersion) throw new Error('Kafka schema version header does not match the event envelope');
    } catch (error) {
      // Invalid JSON/schema cannot be tenant-scoped safely; retain it on the broker DLQ.
      await this.publishMalformedToDlq(record, error);
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    const maxAttempts = this.positiveEnvInt('KAFKA_CONSUMER_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 20);
    const retryBaseMs = this.positiveEnvInt('KAFKA_CONSUMER_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS, 30000);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const outcome = await this.consumers.dispatch(event);
        if (!outcome.handled) {
          this.logger.debug(JSON.stringify({
            event: 'KAFKA_EVENT_NO_LOCAL_HANDLER',
            eventId: event.id,
            eventType: event.eventType,
          }));
        }
        // Manual commit follows the completed, idempotent handler. A commit failure
        // may redeliver the event; InboxService/consumer idempotency remains required.
        await this.commitOffset(topic, partition, message.offset);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          const delay = Math.min(retryBaseMs * (2 ** (attempt - 1)), 30000);
          this.logger.warn(JSON.stringify({
            event: 'KAFKA_CONSUMER_RETRY',
            eventId: event.id,
            eventType: event.eventType,
            attempt,
            maxAttempts,
            retryDelayMs: delay,
            error: this.errorText(error),
          }));
          await this.delay(delay);
        }
      }
    }

    // Persist the tenant-scoped consumer DLQ before acknowledging the broker offset.
    // If this transaction fails, leave the offset uncommitted for delivery retry.
    await this.persistConsumerDeadLetter(event, topic, partition, message.offset, maxAttempts, lastError);
    await this.commitOffset(topic, partition, message.offset);
    this.logger.error(JSON.stringify({
      event: 'KAFKA_CONSUMER_QUARANTINED',
      eventId: event.id,
      eventType: event.eventType,
      topic,
      partition,
      offset: message.offset,
      consumerAttempts: maxAttempts,
    }));
  }

  private async persistConsumerDeadLetter(
    event: OutboxEvent,
    topic: string,
    partition: number,
    offset: string,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const consumerName = 'registry:' + event.eventType;
    const reason = this.errorText(error).slice(0, MAX_FAILURE_REASON);
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO outbox_bus_dead_letters(
           tenant_id,factory_id,event_id,event_type,event_version,consumer_name,source_topic,source_partition,
           source_offset,payload,occurred_at,correlation_id,failed_attempts,failure_count,failure_reason,
           failed_at,status,row_version,updated_by_user_id,updated_at
         ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9::bigint,$10::jsonb,$11::timestamptz,
           $12::uuid,$13,1,$14,clock_timestamp(),'QUARANTINED',1,NULL,clock_timestamp())
         ON CONFLICT(tenant_id,event_id,consumer_name) DO UPDATE SET
           failed_attempts=EXCLUDED.failed_attempts,
           failure_count=outbox_bus_dead_letters.failure_count+1,
           failure_reason=EXCLUDED.failure_reason,
           failed_at=clock_timestamp(),
           status='QUARANTINED',
           row_version=outbox_bus_dead_letters.row_version+1,
           updated_by_user_id=NULL,
           updated_at=clock_timestamp()`,
        [
          event.tenantId,
          event.factoryId,
          event.id,
          event.eventType,
          event.eventVersion,
          consumerName,
          topic,
          partition,
          offset,
          JSON.stringify(event),
          event.occurredAt ?? null,
          event.correlationId ?? null,
          attempts,
          reason || 'Consumer retry budget exhausted',
        ],
      );
    }, {
      tenantId: event.tenantId,
      userId: null,
      requestId: event.id,
      traceId: event.correlationId ?? null,
    });
  }

  private async publishMalformedToDlq(record: EachMessagePayload, error: unknown): Promise<void> {
    const producer = this.producer;
    if (!producer) throw new Error('Kafka producer is unavailable; malformed source offset remains uncommitted');
    const { topic, partition, message } = record;
    const raw = message.value?.toString('utf8') ?? '';
    const failure = this.errorText(error).slice(0, MAX_FAILURE_REASON);
    await producer.send({
      topic: this.dlqTopic(),
      acks: -1,
      timeout: this.requestTimeoutMs(),
      messages: [{
        key: message.key?.toString() ?? `malformed:${topic}:${partition}:${message.offset}`,
        value: JSON.stringify({
          deadLetterVersion: 1,
          original: {
            topic, partition, offset: message.offset,
            key: message.key?.toString() ?? null,
            headers: this.headersObject(message.headers),
          },
          rawValueBase64: Buffer.from(raw, 'utf8').toString('base64'),
          failedAt: new Date().toISOString(),
          reason: failure,
        }),
        headers: {
          'x-factoryos-dead-letter-kind': 'MALFORMED_ENVELOPE',
          'x-factoryos-source-topic': topic,
          'x-factoryos-source-partition': String(partition),
          'x-factoryos-source-offset': message.offset,
        },
      }],
    });
  }

  private async commitOffset(topic: string, partition: number, offset: string): Promise<void> {
    if (!this.consumer) throw new Error('Kafka consumer is unavailable; source offset remains uncommitted');
    await this.consumer.commitOffsets([{
      topic,
      partition,
      offset: (BigInt(offset) + 1n).toString(),
    }]);
  }

  private eventHeaders(event: OutboxEvent): Record<string, string> {
    return {
      'content-type': 'application/json',
      'factoryos-contract': 'outbox-envelope',
      'event-id': event.id,
      'event-type': event.eventType,
      'event-version': String(event.eventVersion),
      'tenant-id': event.tenantId,
      'factory-id': event.factoryId ?? '',
      'correlation-id': event.correlationId ?? '',
      'causation-id': event.causationId ?? '',
    };
  }

  private aggregateKey(event: OutboxEvent): string {
    return `${event.tenantId}:${event.aggregateType}:${event.aggregateId}`;
  }

  private brokers(): string[] {
    const brokers = (process.env.KAFKA_BROKERS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    if (!brokers.length) throw new Error('KAFKA_BROKERS is required when OUTBOX_TRANSPORT=kafka');
    return brokers;
  }

  private topic(): string {
    return this.requiredEnv('KAFKA_TOPIC', DEFAULT_TOPIC);
  }

  private dlqTopic(): string {
    return this.requiredEnv('KAFKA_DLQ_TOPIC', DEFAULT_DLQ_TOPIC);
  }

  private requiredEnv(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value || fallback;
  }

  private requestTimeoutMs(): number {
    return this.positiveEnvInt('KAFKA_REQUEST_TIMEOUT_MS', 10000, 120000);
  }

  private positiveEnvInt(name: string, fallback: number, max: number): number {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}`);
    }
    return parsed;
  }

  private headerText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) value = value[0];
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return typeof value === 'string' ? value : null;
  }

  private headersObject(value: EachMessagePayload['message']['headers']): Record<string, string | string[]> {
    const output: Record<string, string | string[]> = {};
    if (!value) return output;
    for (const [key, raw] of Object.entries(value)) {
      if (Array.isArray(raw)) output[key] = raw.map((item) => item?.toString('utf8') ?? '');
      else if (Buffer.isBuffer(raw)) output[key] = raw.toString('utf8');
      else if (typeof raw === 'string') output[key] = raw;
    }
    return output;
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
