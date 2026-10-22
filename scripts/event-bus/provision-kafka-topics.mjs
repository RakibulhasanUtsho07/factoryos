import { Kafka, logLevel } from 'kafkajs';

function requiredBrokers() {
  const brokers = (process.env.KAFKA_BROKERS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!brokers.length) throw new Error('KAFKA_BROKERS must be set to provision event-bus topics');
  return brokers;
}

function positiveInteger(value, name, fallback, max) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function kafkaClient() {
  const ssl = process.env.KAFKA_SSL === 'true';
  const mechanism = process.env.KAFKA_SASL_MECHANISM?.trim().toLowerCase();
  const username = process.env.KAFKA_SASL_USERNAME;
  const password = process.env.KAFKA_SASL_PASSWORD;
  let sasl;
  if (mechanism || username || password) {
    if (!mechanism || !username || !password) throw new Error('Kafka SASL mechanism/user/password must be configured together');
    if (!['plain', 'scram-sha-256', 'scram-sha-512'].includes(mechanism)) {
      throw new Error('Unsupported Kafka SASL mechanism');
    }
    sasl = { mechanism, username, password };
  }
  return new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID ?? 'factoryos-topic-provisioner',
    brokers: requiredBrokers(),
    ssl,
    sasl,
    logLevel: logLevel.ERROR,
    connectionTimeout: positiveInteger(process.env.KAFKA_REQUEST_TIMEOUT_MS, 'KAFKA_REQUEST_TIMEOUT_MS', 10000, 120000),
  });
}

const mainTopic = process.env.KAFKA_TOPIC ?? 'factoryos.domain-events';
const dlqTopic = process.env.KAFKA_DLQ_TOPIC ?? 'factoryos.domain-events.dlq';
if (mainTopic === dlqTopic) throw new Error('KAFKA_TOPIC and KAFKA_DLQ_TOPIC must be different topics');
if (!/^[a-zA-Z0-9._-]{1,249}$/.test(mainTopic) || !/^[a-zA-Z0-9._-]{1,249}$/.test(dlqTopic)) {
  throw new Error('Kafka topic names may contain only letters, digits, dot, underscore and hyphen');
}

const partitions = positiveInteger(process.env.KAFKA_TOPIC_PARTITIONS, 'KAFKA_TOPIC_PARTITIONS', 3, 256);
const replicationFactor = positiveInteger(process.env.KAFKA_TOPIC_REPLICATION_FACTOR, 'KAFKA_TOPIC_REPLICATION_FACTOR', 1, 9);
const mainRetentionMs = positiveInteger(process.env.KAFKA_TOPIC_RETENTION_MS, 'KAFKA_TOPIC_RETENTION_MS', 604800000, 31536000000);
const dlqRetentionMs = positiveInteger(process.env.KAFKA_DLQ_RETENTION_MS, 'KAFKA_DLQ_RETENTION_MS', 2592000000, 31536000000);

const kafka = kafkaClient();
const admin = kafka.admin();
try {
  await admin.connect();
  const created = await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic: mainTopic, numPartitions: partitions, replicationFactor, configEntries: [
        { name: 'cleanup.policy', value: 'delete' },
        { name: 'retention.ms', value: String(mainRetentionMs) },
      ] },
      { topic: dlqTopic, numPartitions: partitions, replicationFactor, configEntries: [
        { name: 'cleanup.policy', value: 'delete' },
        { name: 'retention.ms', value: String(dlqRetentionMs) },
      ] },
    ],
  });
  const metadata = await admin.fetchTopicMetadata({ topics: [mainTopic, dlqTopic] });
  for (const topic of metadata.topics) {
    if (topic.partitions.length !== partitions) {
      throw new Error(`Topic ${topic.name} has ${topic.partitions.length} partitions; expected ${partitions}`);
    }
    if (topic.partitions.some((partition) => partition.leader < 0)) {
      throw new Error(`Topic ${topic.name} has a partition without an elected leader`);
    }
  }
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    created,
    topics: metadata.topics.map((topic) => ({ name: topic.name, partitions: topic.partitions.length })),
    replicationFactor,
    mainRetentionMs,
    dlqRetentionMs,
  }) + '\n');
} finally {
  await admin.disconnect().catch(() => undefined);
  await kafka.disconnect().catch(() => undefined);
}
