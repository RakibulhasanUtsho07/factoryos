import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import type { OutboxEvent } from './outbox-event.contract';
import { KafkaEventBusAdapter } from './kafka-event-bus.adapter';
import { OutboxBusDlqService } from './outbox-bus-dlq.service';
import { createIntegrationDatabase } from '../database/integration-database.adapter';
import type { OutboxConsumerRegistry } from './outbox.consumer.registry';

type HandlerState = { attempts: number; failuresRemaining: number; successes: number };
const runId = randomUUID();
const topic = `factoryos.it.${runId.replaceAll('-', '').slice(0, 20)}`;
const dlqTopic = `${topic}.dlq`;
const tenantId = randomUUID();
const actorUserId = randomUUID();
const handlerStates = new Map<string, HandlerState>();
let pool!: Pool;
let appPool!: Pool;
let testKafka!: Kafka;
let testProducer: ReturnType<Kafka['producer']> | null = null;
let dlqProbe: ReturnType<Kafka['consumer']> | null = null;
let adapter!: KafkaEventBusAdapter;
let database!: ReturnType<typeof createIntegrationDatabase>;
let dlqService!: OutboxBusDlqService;
let totalDispatchCalls = 0;
const originalEnv = new Map<string, string | undefined>();
const envNames = [
  'OUTBOX_TRANSPORT','KAFKA_BROKERS','KAFKA_CLIENT_ID','KAFKA_TOPIC','KAFKA_DLQ_TOPIC',
  'KAFKA_CONSUMER_GROUP_ID','KAFKA_CONSUMER_MAX_ATTEMPTS','KAFKA_CONSUMER_RETRY_BASE_MS',
  'KAFKA_REQUEST_TIMEOUT_MS','KAFKA_SSL','KAFKA_SASL_MECHANISM','KAFKA_SASL_USERNAME',
  'KAFKA_SASL_PASSWORD','KAFKA_CLIENT_LOG_LEVEL',
];

function makeEvent(payload: Record<string, unknown>): OutboxEvent {
  return {
    id: randomUUID(),
    tenantId,
    factoryId: null,
    aggregateType: 'KAFKA_INTEGRATION_TEST',
    aggregateId: randomUUID(),
    eventType: 'TEST.KAFKA.TRANSPORT',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    payload,
  };
}

async function waitFor(assertion: () => boolean | Promise<boolean>, description: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function disconnectQuietly(connection: { disconnect: () => Promise<void> } | null) {
  if (connection) await connection.disconnect().catch(() => undefined);
}

describe('Kafka-compatible event-bus integration (Redpanda)', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    for (const name of envNames) originalEnv.set(name, process.env[name]);
    process.env.OUTBOX_TRANSPORT = 'kafka';
    process.env.KAFKA_BROKERS = process.env.KAFKA_BROKERS || '127.0.0.1:19092';
    process.env.KAFKA_CLIENT_ID = 'factoryos-it-' + runId.slice(0, 8);
    process.env.KAFKA_TOPIC = topic;
    process.env.KAFKA_DLQ_TOPIC = dlqTopic;
    process.env.KAFKA_CONSUMER_GROUP_ID = 'factoryos-it-consumers-' + runId;
    process.env.KAFKA_CONSUMER_MAX_ATTEMPTS = '2';
    process.env.KAFKA_CONSUMER_RETRY_BASE_MS = '10';
    process.env.KAFKA_REQUEST_TIMEOUT_MS = '5000';
    process.env.KAFKA_SSL = 'false';
    process.env.KAFKA_SASL_MECHANISM = '';
    process.env.KAFKA_SASL_USERNAME = '';
    process.env.KAFKA_SASL_PASSWORD = '';
    process.env.KAFKA_CLIENT_LOG_LEVEL = 'error';

    const brokers = (process.env.KAFKA_BROKERS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    testKafka = new Kafka({ clientId: 'factoryos-it-admin-' + runId.slice(0, 8), brokers, logLevel: logLevel.ERROR });
    const admin = testKafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: [
          { topic, numPartitions: 1, replicationFactor: 1 },
          { topic: dlqTopic, numPartitions: 1, replicationFactor: 1 },
        ],
      });
    } finally {
      await admin.disconnect();
    }

    const databaseUrl = process.env.DATABASE_URL;
    const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
    if (!databaseUrl || !adminUrl) throw new Error('DATABASE_URL and TEST_ADMIN_DATABASE_URL are required for broker/PostgreSQL integration');
    pool = new Pool({ connectionString: adminUrl });
    appPool = new Pool({ connectionString: databaseUrl });
    await pool.query('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [
      tenantId, 'kafka-it-' + runId, 'Kafka Event Bus Integration Tenant',
    ]);
    await pool.query('INSERT INTO users(id,display_name,status) VALUES($1,$2,$3)', [
      actorUserId, 'Kafka Event Bus Integration Actor', 'ACTIVE',
    ]);

    database = createIntegrationDatabase(appPool);
    const dispatch = async (event: OutboxEvent) => {
      totalDispatchCalls += 1;
      const state = handlerStates.get(event.id) ?? { attempts: 0, failuresRemaining: 0, successes: 0 };
      handlerStates.set(event.id, state);
      state.attempts += 1;
      if (state.failuresRemaining > 0) {
        state.failuresRemaining -= 1;
        throw new Error('injected consumer failure for ' + event.id);
      }
      state.successes += 1;
      return { handled: true, consumerName: 'kafka-integration-handler' };
    };
    const registry = { dispatch } as unknown as OutboxConsumerRegistry;
    adapter = new KafkaEventBusAdapter(database as never, registry);
    await adapter.onModuleInit();
    dlqService = new OutboxBusDlqService(database as never, adapter);
  }, 45000);

  afterAll(async () => {
    if (adapter) await adapter.onModuleDestroy();
    await disconnectQuietly(testProducer);
    await disconnectQuietly(dlqProbe);
    await pool?.end();
    await appPool?.end();
    for (const name of envNames) {
      const old = originalEnv.get(name);
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
  });

  it('waits for Kafka publisher confirmation and commits offsets after successful handler completion', async () => {
    const event = makeEvent({ case: 'confirmed-publish-and-consumer-commit' });
    handlerStates.set(event.id, { attempts: 0, failuresRemaining: 0, successes: 0 });

    await expect(adapter.publish(event)).resolves.toBeUndefined();
    await waitFor(() => (handlerStates.get(event.id)?.successes ?? 0) === 1, 'consumer handler for confirmed publication');
    expect(handlerStates.get(event.id)).toEqual({ attempts: 1, failuresRemaining: 0, successes: 1 });
  });

  it('persists a consumer DLQ before committing the offset, then redrives with a durable idempotency receipt', async () => {
    const event = makeEvent({ case: 'consumer-dlq-redrive' });
    handlerStates.set(event.id, { attempts: 0, failuresRemaining: 2, successes: 0 });

    await expect(adapter.publish(event)).resolves.toBeUndefined();
    await waitFor(async () => {
      const result = await pool.query(
        'SELECT id FROM outbox_bus_dead_letters WHERE tenant_id=$1::uuid AND event_id=$2::uuid AND consumer_name=$3',
        [tenantId, event.id, 'registry:' + event.eventType],
      );
      return result.rowCount === 1;
    }, 'persistent consumer dead-letter');
    const quarantined = await pool.query(
      'SELECT id::text AS id,status,failed_attempts,failure_count,row_version::int AS row_version FROM outbox_bus_dead_letters WHERE tenant_id=$1::uuid AND event_id=$2::uuid',
      [tenantId, event.id],
    );
    expect(quarantined.rows[0]).toEqual(expect.objectContaining({
      status: 'QUARANTINED', failed_attempts: 2, failure_count: 1, row_version: 1,
    }));
    const deadLetterId = String(quarantined.rows[0].id);

    const first = await dlqService.redrive({
      tenantId, actorUserId, deadLetterId,
      idempotencyKey: 'kafka-redrive-' + runId,
      requestId: event.id, traceId: event.correlationId ?? null, requestFactoryId: null,
    });
    expect(first).toEqual(expect.objectContaining({ status: 'PUBLISHED', replayed_request: false }));
    await waitFor(() => (handlerStates.get(event.id)?.successes ?? 0) === 1, 'redriven consumer event');
    const replay = await dlqService.redrive({
      tenantId, actorUserId, deadLetterId,
      idempotencyKey: 'kafka-redrive-' + runId,
      requestId: event.id, traceId: event.correlationId ?? null, requestFactoryId: null,
    });
    expect(replay).toEqual(expect.objectContaining({ status: 'PUBLISHED', replayed_request: true }));
    expect(handlerStates.get(event.id)).toEqual({ attempts: 3, failuresRemaining: 0, successes: 1 });

    const final = await pool.query(
      'SELECT status,redrive_count FROM outbox_bus_dead_letters WHERE tenant_id=$1::uuid AND id=$2::uuid',
      [tenantId, deadLetterId],
    );
    expect(final.rows[0]).toEqual({ status: 'REDRIVEN', redrive_count: 1 });
    const audit = await pool.query(
      'SELECT action FROM outbox_bus_dlq_audit_events WHERE tenant_id=$1::uuid AND dead_letter_id=$2::uuid',
      [tenantId, deadLetterId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      'QUARANTINED', 'REDRIVE_REQUESTED', 'REDRIVE_STARTED', 'REDRIVE_PUBLISHED',
    ]));
  });

  it('routes an envelope/schema-header mismatch to the broker DLQ and preserves the raw source identity', async () => {
    const event = makeEvent({ case: 'schema-header-mismatch' });
    testProducer = testKafka.producer({ allowAutoTopicCreation: false });
    await testProducer.connect();

    let resolveDlq!: (value: Record<string, unknown>) => void;
    const dlqMessage = new Promise<Record<string, unknown>>((resolve) => { resolveDlq = resolve; });
    dlqProbe = testKafka.consumer({ groupId: 'factoryos-it-dlq-probe-' + runId, allowAutoTopicCreation: false });
    await dlqProbe.connect();
    await dlqProbe.subscribe({ topic: dlqTopic, fromBeginning: true });
    await dlqProbe.run({
      eachMessage: async ({ message }) => {
        const raw = message.value?.toString('utf8');
        if (!raw) return;
        const value = JSON.parse(raw) as Record<string, unknown>;
        const original = value.original as Record<string, unknown> | undefined;
        if (original?.key === event.aggregateId) resolveDlq(value);
      },
    });

    await testProducer.send({
      topic,
      acks: -1,
      messages: [{
        key: event.aggregateId,
        value: JSON.stringify(event),
        headers: {
          'content-type': 'application/json',
          'event-id': event.id,
          'event-type': event.eventType,
          'event-version': '99',
        },
      }],
    });
    const deadLetter = await Promise.race([
      dlqMessage,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for broker poison-message DLQ')), 15000)),
    ]);
    expect(deadLetter).toEqual(expect.objectContaining({
      deadLetterVersion: 1,
      rawValueBase64: Buffer.from(JSON.stringify(event), 'utf8').toString('base64'),
    }));
    expect((deadLetter.original as Record<string, unknown>).topic).toBe(topic);
    expect(String(deadLetter.reason)).toContain('schema version header does not match');
  });

  it('fails startup closed if Kafka transport is selected without broker endpoints', async () => {
    const previousBrokers = process.env.KAFKA_BROKERS;
    process.env.KAFKA_BROKERS = '';
    const unavailable = new KafkaEventBusAdapter(database as never, { dispatch: async () => ({ handled: false, consumerName: null }) } as never);
    await expect(unavailable.onModuleInit()).rejects.toThrow('KAFKA_BROKERS is required');
    await unavailable.onModuleDestroy();
    if (previousBrokers === undefined) delete process.env.KAFKA_BROKERS;
    else process.env.KAFKA_BROKERS = previousBrokers;
  });

  it('does not redeliver already-committed offsets after restarting the same consumer group', async () => {
    const callsAtShutdown = totalDispatchCalls;
    await adapter.onModuleDestroy();
    const registry = {
      dispatch: async (event: OutboxEvent) => {
        totalDispatchCalls += 1;
        const state = handlerStates.get(event.id) ?? { attempts: 0, failuresRemaining: 0, successes: 0 };
        handlerStates.set(event.id, state);
        state.attempts += 1;
        state.successes += 1;
        return { handled: true, consumerName: 'kafka-integration-handler' };
      },
    } as unknown as OutboxConsumerRegistry;
    adapter = new KafkaEventBusAdapter(database as never, registry);
    await adapter.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(totalDispatchCalls).toBe(callsAtShutdown);
  });
});
