# Outbox, Inbox, Retry and DLQ Replay Reliability

## Scope and SRS traceability

This implementation covers the event-delivery controls in the repository SRS, FR-3 (orders and event processing), and the v2.1 HLD/LLD event rules in section 12.3: transactional outbox, consumer idempotency, versioned envelope validation, bounded retry, stale-lease recovery, quarantine/DLQ and authorized replay. The engineering blueprint integration checklist also calls for failure/retry/DLQ behavior and contract/replay tests.

## Delivery semantics and event contract

Domain changes and their outbox event are committed in the same database transaction. The dispatcher claims eligible rows with \`FOR UPDATE SKIP LOCKED\`, assigns a worker lease, and only marks an event \`PUBLISHED\` after the publisher and registered in-process consumers return successfully. A worker restart can reclaim stale \`PROCESSING\` rows. A publisher success followed by a crash before the publish-state update can cause a redelivery; delivery therefore remains **at least once**, and each side-effecting consumer must use \`InboxService.executeOnce\` or an equivalent durable idempotency boundary.

The canonical event contract validates tenant/factory envelope values, correlation/causation metadata, supported event schema versions and known order-event payloads before publishing/dispatch. Schema-breaking events require a new schema version; old payloads are not silently reinterpreted.

## Retry and quarantine policy

The dispatcher uses an initial five-second retry delay, exponential backoff (5, 10, 20 seconds and so on), capped at one hour. After ten claimed attempts without successful publication, the event is moved to \`QUARANTINED\`. Failures retain \`last_error\`; quarantine captures timestamp, reason and worker identity and emits an audit event when the audit service is available. Claim leases prevent two workers from claiming the same unexpired event; stale leases are recoverable after the configured 60-second interval.

## Inbox idempotency

\`inbox_events\` has a unique consumer/event key and tenant-consistent foreign key to the source outbox event. \`InboxService.executeOnce\` inserts the inbox marker and runs the consumer's database side effect in one transaction. On a duplicate delivery, the handler is not run. If the handler fails, the transaction rolls back both the marker and transactional database effects so a retry can safely execute again. External non-transactional side effects must still use their own idempotency keys.

## DLQ read and replay

- \`GET /api/outbox/quarantined\` requires \`outbox.dlq.read\` and enforces the active tenant/factory scope.
- \`POST /api/outbox/:eventId/replay\` requires \`outbox.dlq.replay\` and a visible-ASCII \`Idempotency-Key\` (1–200 characters).
- A first valid replay changes only dispatch state: \`QUARANTINED\` to \`PENDING\`, clears the active lease/quarantine markers, sets the next attempt time to now, preserves the immutable event payload and historical attempt count, and increments \`replay_count\`.
- The event-state transition and row in \`outbox_dlq_replay_requests\` commit atomically. Repeating the same tenant/key/event returns the stored replay result and does not queue a second replay. Reusing the key for a different event returns \`409 Conflict\`; trying to replay a non-quarantined event with a new key returns not found.
- The replay receipt contains actor, source event/version, replay count, historical attempt count and correlation/request/trace IDs. The ledger has forced tenant RLS, a unique tenant/key constraint and a unique event/replay-count constraint. Database constraints bind the receipt to the same tenant and factory as the source event, and an append-only trigger prevents receipt edits/deletions and binds the actor to the authenticated database context. The regular audit log is also attempted; a transient audit-service failure cannot erase the committed replay receipt.

## Automated verification

The PostgreSQL CI migration list includes migrations 001–117 and fails closed when a migration file is omitted. The SQL contract test verifies the replay ledger, forced RLS, tenant policy, uniqueness constraint and migration registration. Integration coverage verifies concurrent outbox claims, stale lease recovery, restart after consumer success but before publish-state commit, inbox duplicate suppression and rollback-on-handler-failure, maximum-attempt quarantine, factory/tenant-scoped DLQ access, and replay receipt idempotency/conflict behavior.

## Transport boundary

The current \`OutboxPublisher\` is the local transport boundary and emits a validated event log; it is not yet a Kafka, RabbitMQ, NATS or cloud event-bus adapter. The queue, inbox, retry, lease and DLQ controls are implemented and testable. Production transport delivery guarantees must be revalidated with the selected broker adapter, including broker acknowledgements, publisher confirms and consumer acknowledgement behavior.
