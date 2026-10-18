# Operational event reconciliation: external attendance, production and quality

**SRS traceability:** FactoryOS AI SRS v2.1 FR-MDM-02 (review cases for duplicates/conflicts/incomplete data), FR-MDM-04 (canonical inbound event envelope), FR-MDM-05 (event latency/duplicate visibility, partial slice), FR-MDM-06 (event/source lineage evidence); workforce requirements documented in docs/shift-attendance-productivity.md, shop-floor lifecycle in the production module, and quality workflows in docs/quality-management.md.

## Scope and safety boundary

External attendance, production-operation and quality-inspection events are observed through the existing signed integration webhook. Only canonical event types whose prefix identifies ATTENDANCE, WORKFORCE.ATTENDANCE, MES.ATTENDANCE, PRODUCTION, OPERATION, MES.PRODUCTION, MES.OPERATION, QUALITY, INSPECTION, NCR, QC, MES.QUALITY, MES.INSPECTION, QMS.QUALITY or QMS.INSPECTION are routed into operational reconciliation. Attendance also recognizes the explicitly named WORKFORCE.CLOCK_IN/CLOCK_OUT/BREAK_START/BREAK_END/ABSENCE_RECORDED event family. Unrelated signed integration event types continue to use the existing inbox/outbox contract without being misclassified.

Reconciliation is an evidence and review layer. It does not clock an employee in/out, complete a production operation, post inventory quantity, change an inspection result, release a quality hold or merge source records. An authorized operator must resolve the source-system or business record separately. The event evidence is immutable, and a disposition adds actor, time, expected row version and reason.

## Canonical signed webhook event

Endpoint: POST /api/integrations/webhooks/:connectorId.

The connector must be active and its allowlist/schema version must permit the event. The HTTP signature, timestamp, rate limit, external event ID and payload schema are checked before the normal transactional outbox/receipt flow. Tenant and factory identity are resolved from the registered connector plus the trusted server context; senders must not provide tenant/factory IDs in the payload as authority.

Example attendance event:

~~~json
{
  "event_type": "WORKFORCE.ATTENDANCE.CLOCK_IN",
  "schema_version": 1,
  "correlation_id": "fba2e7bc-8065-47b7-acd7-74d8a619f4ee",
  "payload": {
    "occurred_at": "2026-10-18T08:00:00+06:00",
    "stream_key": "reader-7:worker-22",
    "source_sequence": 105,
    "watermark_through_sequence": 107,
    "reconciliation_key": "worker-22:shift-2026-10-18:clock-in",
    "worker_id": "worker-22",
    "shift_assignment_id": "shift-assignment-uuid",
    "clock_type": "CLOCK_IN"
  }
}
~~~

Use ISO-8601 event time with an explicit timezone (Z or ±HH:MM) in occurred_at, event_time or timestamp. Receipt time is retained separately and must not be substituted for a missing source event time. An optional source_sequence or sequence_number must be a safe positive integer and should be paired with a stable stream_key (worker/shift, work-order/operation, or inspection stream). A watermark_through_sequence or expected_through_sequence states the highest sequence the source says it has produced. Use watermarks to let FactoryOS identify a missing tail, not just gaps between two events already received.

For cross-system comparison, send the same stable reconciliation_key for the same logical business event from each source. If absent, the system still records per-source event/time/sequence evidence, but it cannot reliably compare the same logical event across systems. Keys are scoped to a tenant, factory and domain. A source's own external event ID is not used as a cross-system join key unless every system agrees on it.

## Duplicate, late and missing event rules

| Condition | Processing outcome |
|---|---|
| Same connector + external event ID + same payload fingerprint | Idempotent replay; return the original accepted outbox event. A delivery-attempt receipt records the replay for operational-domain events. No second event is created. |
| Same connector + external event ID but different payload/type/schema | Return the existing conflict response (409). In a separate tenant-scoped transaction, persist a CONFLICTING_DUPLICATE case and attempt receipt; the original payload/event receipt is not overwritten. |
| Same connector sends a different external ID for the same business key and same comparable evidence | Open a DUPLICATE_BUSINESS_EVENT review case. Neither record is silently discarded. |
| Same connector reuses a business key with changed comparable evidence | Open a BUSINESS_EVENT_CONFLICT error case. |
| Different connectors report the same business key/type with different comparable evidence | Open a CROSS_SOURCE_CONFLICT error case showing source labels and opaque event references. Comparable evidence is an allow-listed set of low-risk business scalars plus normalized event time; arbitrary payload fields are not copied into the reconciliation ledger. |
| Source event time is absent or malformed / lacks explicit timezone | Record MISSING_EVENT_TIME warning or INVALID_EVENT_TIME error case; retain occurred_at = null when time cannot be trusted. |
| Sequence value is invalid or supplied without a stream key | Open INVALID_SEQUENCE; invalid/unscoped sequence values are excluded from gap math. |
| Stream sequence numbers have a gap | Open MISSING_SEQUENCE_RANGE. Gaps bounded by two observed sequence numbers are warnings; gaps confirmed by a source watermark are errors. A later event can split/close a prior missing range. |
| Same stream assigns one sequence to multiple source event IDs | Open SEQUENCE_COLLISION error case. |
| Two independent systems have the same business key/type and same comparable evidence | Count as a cross-source match in the report; no mismatch is invented. |

A missing sequence can only be inferred where a source provides ordered sequence numbers, and a missing final/tail event can only be confirmed when a watermark states which sequence range should already exist. A quiet stream without a watermark is not proof of missing data. The module does not infer event loss from wall-clock silence.

## Reconciliation API

All routes below are under /api/integrations, require an authenticated actor, trusted tenant/factory scope and existing PermissionGuard. Read calls require integrations.reconciliation.read; decisions require integrations.reconciliation.review.

| Method and route | Purpose |
|---|---|
| GET /reconciliation/report?domain=ATTENDANCE&since=...&until=... | Per-domain accepted/late event counts, separate open missing/invalid event-time cases, watermark activity, duplicate/conflict attempts, cross-source matches and open reconciliation cases. All three domains are returned if domain is omitted. |
| GET /reconciliation/events?domain=PRODUCTION&source_system=MES&delivery_class=LATE&limit=100 | Read scoped source event/checksum/sequence/receipt metadata without modifying an operational ledger. |
| GET /reconciliation/cases?domain=QUALITY&status=OPEN&case_type=CROSS_SOURCE_CONFLICT&limit=100 | Triage open warnings/errors and view their evidence summary. limit is 1–200. |
| GET /reconciliation/cases/:caseId/history | Read append-only case history. |
| POST /reconciliation/cases/:caseId/decision | Review an open case with optimistic locking and a documented resolution/waiver. |

Decision body:

~~~json
{
  "action": "RESOLVE",
  "expected_version": 1,
  "reason": "Verified the missing event in the source system and replayed it"
}
~~~

action is RESOLVE or WAIVE. The reason must be 10–500 characters. Only OPEN cases may be decided; stale expected_version returns a conflict and the caller must reload. System-generated gap reclassification is recorded as AUTO_RECONCILED; a manually waived case remains evidence and is not deleted.

## Storage, tenancy and audit controls

Migration 130_integration_operational_reconciliation.sql creates four tenant/factory-scoped tables:

- integration_reconciliation_events — immutable event envelope summary, source/connector reference, event time, arrival time, source sequence/watermark, SHA-256 hashes and correlation ID. Raw payload is not duplicated into this table.
- integration_reconciliation_attempts — append-only accepted, replayed and conflicting delivery attempts.
- integration_reconciliation_cases — durable duplicate, conflict, missing-time, bad-sequence, missing-range and sequence-collision cases with versioned disposition.
- integration_reconciliation_case_history — append-only opened/resolved/waived/automatically reconciled history.

The existing signed webhook path still stores its raw signed payload in its existing outbox event. Follow the connector's access and retention policy for that payload; the reconciliation case API exposes only the case's safe details, not the raw event. All four reconciliation tables use forced tenant RLS; scoped API queries also constrain factory_id. Accepted reconciliation evidence is transactionally tied to the exact signed webhook receipt and its outbox fingerprint. An invalid or unsigned event cannot bypass the webhook contract by writing into the reconciliation ledger directly.

## SRS traceability and remaining boundary

| SRS requirement | This delivery |
|---|---|
| FR-MDM-02 — duplicate/conflict/incomplete data must create review cases rather than silent merges | Implemented for repeated business keys, conflicting duplicate IDs, cross-source comparison, missing time, invalid/gapped/colliding sequence and optimistic case disposition. Matching source events are counted separately. |
| FR-MDM-04 — canonical event provenance (tenant, source, source event ID, event time, ingestion time, schema version) | Provided across connector-derived trusted tenant/factory scope, source system and ID, source event time, recorded receipt time, schema version, connector receipt and immutable outbox reference. |
| FR-MDM-05 — connector health and sync telemetry | This slice reports the operational event/late/duplicate/case indicators above. Authentication failures, rejected webhook metrics, outbox backlog and last-successful-sync remain broader connector-health work; they are not claimed as implemented here. |
| FR-MDM-06 — cross-source lineage | Connector, source-system, source-event IDs, correlation IDs, payload/comparison fingerprints and immutable receipt/outbox binding are exposed as lineage evidence. |
| Workforce/production/quality records | This layer detects and surfaces discrepancies. Attendance corrections, production postings, quality decisions and physical source retries remain in their governed domain APIs; reconciliation never auto-mutates those records. |

## CI contract

services/api/test/integration-reconciliation.sql checks migration registration, forced RLS/policies, event/attempt immutability, versioned case disposition, open-case idempotency and read/review permissions. The TypeScript reconciliation contract tests cover domain classification, normalized timezone-aware timestamps, missing/malformed event time, sequence validation and watermark normalization. The full API/PostgreSQL CI is configured to apply migration 130 and execute the SQL contract.
