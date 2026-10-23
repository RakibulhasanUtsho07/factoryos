import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { Kafka, logLevel } from 'kafkajs';

const execFileAsync = promisify(execFile);

const fail = (message) => {
  process.stderr.write(`::error::Kafka staging fault injection blocked: ${message}\n`);
  process.exitCode = 1;
};

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeInteger(name, fallback, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

const allow = process.env.KAFKA_FAULT_INJECTION_ALLOW_PAUSE === 'true';
const container = process.env.KAFKA_FAULT_INJECTION_CONTAINER?.trim() ?? '';
if (!allow) {
  fail('set KAFKA_FAULT_INJECTION_ALLOW_PAUSE=true only for an approved isolated staging window');
  process.exit(1);
}
if (!/^factoryos-redpanda-staging-[a-z0-9-]+$/.test(container)) {
  fail('KAFKA_FAULT_INJECTION_CONTAINER must name an isolated factoryos-redpanda-staging-* container');
  process.exit(1);
}

const brokers = required('KAFKA_BROKERS').split(',').map((value) => value.trim()).filter(Boolean);
const topic = required('KAFKA_TOPIC');
const timeoutMs = safeInteger('KAFKA_FAULT_REQUEST_TIMEOUT_MS', 1500, 10000);
const holdMs = safeInteger('KAFKA_FAULT_PAUSE_MS', 4000, 10000);
const evidencePath = process.env.KAFKA_FAULT_EVIDENCE_PATH?.trim()
  || `./kafka-outage-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const runId = randomUUID();
const kafka = new Kafka({
  clientId: `factoryos-staging-fault-${runId.slice(0, 8)}`,
  brokers,
  ssl: process.env.KAFKA_SSL === 'true',
  sasl: process.env.KAFKA_SASL_MECHANISM ? {
    mechanism: process.env.KAFKA_SASL_MECHANISM.toLowerCase(),
    username: required('KAFKA_SASL_USERNAME'),
    password: required('KAFKA_SASL_PASSWORD'),
  } : undefined,
  logLevel: logLevel.ERROR,
  connectionTimeout: Math.min(timeoutMs, 5000),
  requestTimeout: timeoutMs,
  retry: { retries: 0 },
});
const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1, retry: { retries: 0 } });
const started = new Date();
const result = {
  runId,
  startedAt: started.toISOString(),
  brokerAddresses: brokers.map((value) => value.replace(/:\d+$/, ':<port>')),
  topic,
  faultTarget: container,
  claim: 'operator-authorized isolated staging broker; not production',
  baselinePublisherConfirmation: 'NOT_RUN',
  brokerOutagePublisherConfirmation: 'NOT_RUN',
  brokerRecoveryPublisherConfirmation: 'NOT_RUN',
  consumerReplayOrOffsetRecovery: 'NOT_TESTED_BY_THIS_HARNESS',
  status: 'FAIL',
};

let paused = false;
try {
  await producer.connect();
  const baseline = {
    eventId: randomUUID(),
    faultRunId: runId,
    phase: 'baseline-before-outage',
    occurredAt: new Date().toISOString(),
  };
  await producer.send({
    topic,
    acks: -1,
    timeout: timeoutMs * 2,
    messages: [{ key: `fault:${runId}`, value: JSON.stringify(baseline), headers: { 'x-factoryos-fault-run': runId, 'x-factoryos-fault-phase': baseline.phase } }],
  });
  result.baselinePublisherConfirmation = 'PASS_ACKS_ALL';

  await execFileAsync('docker', ['pause', container], { timeout: 10000 });
  paused = true;
  result.brokerPausedAt = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, Math.min(holdMs, 10000)));

  let outageRejected = false;
  try {
    await producer.send({
      topic,
      acks: -1,
      timeout: timeoutMs,
      messages: [{
        key: `fault:${runId}`,
        value: JSON.stringify({ eventId: randomUUID(), faultRunId: runId, phase: 'broker-outage' }),
        headers: { 'x-factoryos-fault-run': runId, 'x-factoryos-fault-phase': 'broker-outage' },
      }],
    });
  } catch {
    outageRejected = true;
  }
  result.brokerOutagePublisherConfirmation = outageRejected ? 'PASS_PUBLISH_NOT_CONFIRMED' : 'FAIL_UNEXPECTED_ACK';
  if (!outageRejected) throw new Error('Publisher unexpectedly received confirmation while the isolated broker was paused');

  await execFileAsync('docker', ['unpause', container], { timeout: 10000 });
  paused = false;
  result.brokerResumedAt = new Date().toISOString();

  const recoveryDeadline = Date.now() + 45000;
  let recoveryPublished = false;
  let lastError = null;
  while (Date.now() < recoveryDeadline && !recoveryPublished) {
    try {
      await producer.send({
        topic,
        acks: -1,
        timeout: timeoutMs * 2,
        messages: [{
          key: `fault:${runId}`,
          value: JSON.stringify({ eventId: randomUUID(), faultRunId: runId, phase: 'recovery-after-outage' }),
          headers: { 'x-factoryos-fault-run': runId, 'x-factoryos-fault-phase': 'recovery-after-outage' },
        }],
      });
      recoveryPublished = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!recoveryPublished) throw new Error('Broker did not recover publisher confirmation in 45 seconds: ' + (lastError ?? 'no response'));
  result.brokerRecoveryPublisherConfirmation = 'PASS_ACKS_ALL_AFTER_RECOVERY';
  result.completedAt = new Date().toISOString();
  result.status = 'PASS_TRANSPORT_ONLY';
} catch (error) {
  result.completedAt = new Date().toISOString();
  result.failure = error instanceof Error ? error.message : String(error);
  fail(result.failure);
} finally {
  if (paused) {
    try {
      await execFileAsync('docker', ['unpause', container], { timeout: 10000 });
      result.brokerCleanup = 'UNPAUSED';
    } catch (error) {
      result.brokerCleanup = 'FAILED_TO_UNPAUSE';
      result.cleanupFailure = error instanceof Error ? error.message : String(error);
      fail('failed to unpause the isolated staging broker; operator action required immediately');
    }
  }
  await producer.disconnect().catch(() => undefined);
  await kafka.disconnect?.().catch(() => undefined);
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...result, evidencePath }) + '\n');
}
