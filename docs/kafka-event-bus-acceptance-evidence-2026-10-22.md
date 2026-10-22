# WP03 / Task 17 — Kafka event-bus acceptance evidence

**Status:** `AUTOMATED_ACCEPTANCE_PASS; STAGING_RELEASE_GATE_OPEN`  
**Branch:** `rakibul-hasan`  
**Application code SHA tested:** `546a50f8cc4cb556ac1da3b533e53e7fabfb82d8`  
**Evidence date:** 2026-10-22

## Exact-SHA automated evidence

| Evidence | Run / result | What it proves |
|---|---|---|
| API CI | [Run 39790283869](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39790283869) — **success**, exact code SHA `546a50f8cc4cb556ac1da3b533e53e7fabfb82d8` | API build/lint and non-PostgreSQL unit suite pass with the Kafka adapter registered; the environment remains local transport unless Kafka mode is configured. |
| API PostgreSQL CI | [Run 39790283862](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39790283862) — **success**, exact code SHA `546a50f8cc4cb556ac1da3b533e53e7fabfb82d8` | Disposable PostgreSQL and Kafka-compatible Redpanda integration completed. Logs report **167 test suites passed / 1,325 tests passed**; the Kafka integration tests exercised publisher confirmation, consumer retry, durable consumer DLQ, idempotent redrive receipt, offset behavior, malformed/header mismatch and unsupported known schema version. |
| Migration/manifest | Included in the PostgreSQL CI run above | Ordered manifest includes migration 169; migration 169 was applied and replayed, and `services/api/test/outbox-bus-dlq-contract.sql` reported “Kafka event-bus DLQ schema and RLS contract passed.” |
| Blueprint traceability | [Run 39790146943](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39790146943) — **success** on the updated WP03 evidence-matrix commit | The HLD/Blueprint evidence matrix validator accepted the updated WP03 evidence mapping and status language. |

## Implemented transport boundary

- KafkaJS publisher uses an idempotent producer and `acks=-1`; the transactional outbox row is marked published only after broker confirmation.
- Kafka consumer uses manual offsets; it commits after the handler succeeds, or after invalid data is durably sent to the Kafka DLQ, or after a valid event's tenant-scoped PostgreSQL DLQ record is committed.
- Known order-event schema versions are enforced by the existing contract. Body/header event ID, type and version mismatches are quarantined.
- Consumer DLQ has tenant RLS, factory ownership, unique event/consumer identity, versioned state transitions, an idempotent redrive receipt and append-only audit records.
- `OUTBOX_TRANSPORT=local` remains a development-only log publisher. `NODE_ENV=production` fails startup unless Kafka mode is selected with TLS and SASL credentials.
- Local Redpanda Compose and the CI broker are test/development deployments. They are **not evidence of a production cluster deployment**.

## Staging and production release gates still open

The staging fault-injection script exists at `scripts/event-bus/staging-fault-injection.mjs`, and is intentionally guarded so it will only pause a specifically named `factoryos-redpanda-staging-*` container after an explicit allow flag. It has **not** been run here because no approved staging broker endpoint/container, credentials or maintenance window were supplied to this execution. There is therefore no staging fault-injection receipt and no claim that the acceptance criterion is fully closed for production.

Before closing Task 17 for release, attach a sanitized receipt and operator sign-off proving: (1) publish confirmation is absent during a staged broker outage and resumes after recovery; (2) outbox retry/replay does not lose source events; (3) consumer termination before offset commit is safe under redelivery; (4) broker leader change/quorum behavior on the actually deployed topology; (5) topic ACL/TLS/SASL rotation and schema-version rollout compatibility; and (6) dead-letter redrive, alert delivery, retention, load and on-call ownership on the selected environment.

The staging procedure and boundaries are documented in [Kafka event-bus transport operations](kafka-event-bus-transport-operations.md). A green disposable-broker integration suite is necessary, but does not substitute for the requested staging evidence.
