# Kafka event-bus deployment and operations (WP03 / Task 17)

## Decision and exact scope

The selected protocol is Kafka, using KafkaJS and a Kafka-compatible Redpanda broker for local and CI integration. The repository now has a real adapter in `services/api/src/outbox/kafka-event-bus.adapter.ts`; the existing log-only `OutboxPublisher` remains a development-only fallback, and production startup fails closed unless `OUTBOX_TRANSPORT=kafka`.

The added Compose profile starts one disposable local Redpanda node. PostgreSQL CI also provisions an ephemeral Redpanda broker and executes the adapter integration suite against the Kafka protocol. Neither setup is evidence that a production cluster or external staging environment has been deployed.

## Delivery contract

- **Transactional source:** domain writes and the existing outbox row still commit together. In Kafka mode, the dispatcher marks the outbox row `PUBLISHED` only after KafkaJS returns publisher confirmation.
- **Publisher confirmation:** the adapter uses an idempotent producer, a stable aggregate key, one in-flight request and `acks=-1` (all in-sync replicas acknowledge). A publish error means the outbox retry loop retains responsibility for retry; it is not treated as broker acceptance.
- **Consumer completion:** `autoCommit=false`; the adapter commits the source offset only after the local handler finishes, or after a malformed record is accepted by the broker DLQ, or after a valid event's consumer-side failure is durably recorded in PostgreSQL. Commit failure can cause redelivery; database side effects must remain idempotent through the existing inbox/consumer contract.
- **Partition ordering:** records are keyed by tenant + aggregate type + aggregate ID. This preserves per-key partition order; applications must still use aggregate/version checks and must not assume a total order across keys or partitions.
- **Retries and DLQ:** handler failures use bounded exponential delay. After the configured retry budget, valid events are saved to `outbox_bus_dead_letters` before the Kafka offset is committed. Invalid JSON or an invalid/mismatched event envelope goes to the broker-side `KAFKA_DLQ_TOPIC` with original topic/partition/offset, headers, failure reason and base64 raw bytes; if DLQ publication fails, the original offset is not committed.
- **Redrive:** `GET /api/outbox/bus-dead-letters` uses `outbox.dlq.read`. `POST /api/outbox/bus-dead-letters/:deadLetterId/redrive` uses `outbox.dlq.replay` and a visible-ASCII `Idempotency-Key`. A unique tenant/key receipt, row-version guard, tenant/factory scope, state machine and append-only audit log record redrive. The same key returns the existing confirmed receipt; reusing it for another event returns conflict. The producer confirmation and database transaction cannot be atomic with one another; if the broker accepts a record but the process crashes before recording the receipt, the operation may be published again on retry. Event ID, headers, consumer inbox idempotency and audit history are therefore preserved.
- **Schema compatibility:** current order event versions are explicitly enumerated in `outbox-event.contract.ts`. Unsupported versions of known event types fail validation and go to broker DLQ. Envelope event ID/type/version headers are checked against the body. Unknown event types remain eligible for generic-envelope routing, but an owning consumer must implement and test the schema for its event type before release. Breaking changes require a new event version; never silently reinterpret an existing version.
- **Broker security:** in production, `NODE_ENV=production` requires `KAFKA_SSL=true` and a complete SASL mechanism/username/password configuration. Inject credentials through the deployment secret manager/workload identity. Apply broker-side topic ACLs for the API producer and consumer group; do not grant broad cluster-admin rights to the application identity.

## Configure local development

1. Start the Kafka-compatible service from the repository root: `docker compose -f deploy/event-bus/compose.yaml up -d`.
2. Keep the local default `OUTBOX_TRANSPORT=local` when Kafka should not be used. For broker-backed local testing, set `OUTBOX_TRANSPORT=kafka`, `KAFKA_BROKERS=127.0.0.1:19092`, and explicit topic/group names in the local untracked environment file.
3. Create topics with the reviewed operations script: `KAFKA_BROKERS=127.0.0.1:19092 node scripts/event-bus/provision-kafka-topics.mjs`. Production topic partition count, replication factor and retention must be agreed with the platform owner; do not use the single-node local settings as production defaults.
4. Verify the broker connection and topic leaders, then run `npm --workspace services/api run build`, `npm --workspace services/api run lint`, and the focused Jest test. The broker/PostgreSQL integration test requires `DATABASE_URL`, `TEST_ADMIN_DATABASE_URL`, and a reachable isolated Kafka endpoint.

## Staging acceptance and fault injection

Run only in an approved disposable staging cluster with a written maintenance window. The fault-injection script refuses to pause any container unless `KAFKA_FAULT_INJECTION_ALLOW_PAUSE=true` and the container name matches `factoryos-redpanda-staging-*`.

Example (replace the endpoint, topic and container with the approved staging values; keep TLS and secret-manager credentials enabled for the target cluster):

```sh
KAFKA_BROKERS="$KAFKA_BROKERS" \
KAFKA_TOPIC="$KAFKA_TOPIC" \
KAFKA_SSL=true \
KAFKA_SASL_MECHANISM=scram-sha-256 \
KAFKA_SASL_USERNAME="$KAFKA_SASL_USERNAME" \
KAFKA_SASL_PASSWORD="$KAFKA_SASL_PASSWORD" \
KAFKA_FAULT_INJECTION_ALLOW_PAUSE=true \
KAFKA_FAULT_INJECTION_CONTAINER=factoryos-redpanda-staging-canary \
node scripts/event-bus/staging-fault-injection.mjs
```

The script writes a mode-0600 JSON receipt showing baseline publisher confirmation, failed confirmation during a broker pause, recovery confirmation and cleanup status. It is **transport-only evidence**: it does not claim consumer side-effect recovery, high availability, multi-node quorum behavior, cross-region DR, or production SLA. Attach the redacted receipt, broker/dashboard logs, deployed image/config versions, run owner, approved window, rollback evidence and incident sign-off to the release record.

Required staging cases before release:
1. Stop/restart one broker or use the provider's isolated fault-injection facility; prove publication is not reported as confirmed during outage, outbox remains retryable, and confirmation resumes after recovery.
2. Inject consumer exception and process termination before offset commit; prove redelivery is safe and no duplicate business mutation occurs.
3. Force retry exhaustion; prove durable tenant-scoped DLQ/audit appears before offset commit. Redrive with one key twice, then reuse that key for a different event, and verify one logical redrive plus a conflict.
4. Send invalid JSON, unsupported known-event schema version, header/body ID/type/version mismatch and out-of-order aggregate versions. Verify poison-message retention, no unsafe handler side effect, and owner-approved compatibility policy.
5. Verify duplicate delivery, consumer restart/rebalance, broker leader transition, topic ACL denial, TLS/SASL credential rotation, topic retention, and schema/version rollout compatibility.
6. Capture production-grade metrics/alerts for outbox publish age/failure/quarantine, consumer lag/retry/DLQ count, broker unavailability, and redrive outcomes; verify alert delivery to the accountable on-call group.

## Current evidence boundary

- **Implemented in repository:** KafkaJS adapter, idempotent producer configured with `acks=-1`, manual consumer offset commit, bounded retries, valid-event persistent DB DLQ/redrive, malformed-event Kafka DLQ, tenant RLS and audit schema, local Redpanda deployment definition, topic provisioner, gated staging fault-injection harness, and CI integration test.
- **Automated integration:** API CI compiles/tests the adapter; API PostgreSQL CI starts a disposable Kafka-compatible broker and applies/replays migration 169 plus the DLQ schema contract.
- **Not claimed until evidence is attached:** real deployment onto a production/staging broker, multi-broker replication/leader-loss proof, staging fault-injection receipt, external alert/on-call delivery, load/capacity/retention certification, and platform-owner approval. A green CI run proves only the cases run by that job.

## References

- [HLD / Blueprint work-package evidence matrix](hld-blueprint-work-package-evidence-matrix.md)
- [Transactional outbox, inbox and DLQ contract](outbox-delivery-reliability.md)
- [Signed webhook connector contract](signed-webhook-connector-contract.md)
