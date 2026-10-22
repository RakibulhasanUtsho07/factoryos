# Energy, Utilities and EHS/Safety — operational foundations and closure slice

This slice implements the factory-scoped operational foundation called for by FactoryOS AI SRS v2.1:
- FR-UFM-21/22: energy and utility quantities, per-production-unit intensity, meter hierarchy and source-to-cost mapping.
- FR-EHS-01: permit-to-work approval, isolation verification, validity window and close-out evidence.
- FR-EHS-03: incident, near-miss, unsafe-observation and audit-finding capture with owners, due dates and closure evidence.
- FR-EHS-04: this branch now includes a drill plan/attendance/response/close-out lifecycle. Live drill execution, mobile attendance capture and site evidence remain staging activities; do not equate the schema/API contract with a completed real-world drill.

## Security and data lifecycle

All rows are tenant/factory scoped; database tables use FORCE ROW LEVEL SECURITY, explicit factory predicates and composite scoped foreign keys. Controller routes use the IAM permission guard and factory scope. Database triggers bind writes to the authenticated actor, constrain state transitions, preserve creation evidence, retain immutable reading/audit records, and prevent deleting business evidence.

Create endpoints require an Idempotency-Key. Re-using a key with the same request replays the existing record; re-using it with a different request payload returns a conflict. Lifecycle endpoints require expected_version, so stale writes fail rather than silently overwrite a newer decision.

## Utility meters and events

| Endpoint | Permission | Purpose |
|---|---|---|
| GET /api/utilities/meters | utilities.meters.read | List factory meters; optional utility_type, status, limit |
| POST /api/utilities/meters | utilities.meters.manage | Create a meter or sub-meter with cost-centre/source mapping |
| GET /api/utilities/meters/:meterId/readings | utilities.readings.read | Read ledger by optional from, to, limit |
| POST /api/utilities/meters/:meterId/readings | utilities.readings.capture | Append a reading |
| GET /api/utilities/events | utilities.events.read | List outage, peak load, leak, pressure, meter-fault and efficiency events |
| POST /api/utilities/events | utilities.events.manage | Record a utility event |
| POST /api/utilities/events/:eventId/transition | utilities.events.manage | Acknowledge, resolve or cancel an event |

A meter declares utility type, reading mode, unit, multiplier, unit cost/currency, optional cost-centre/source-system and a parent meter. Parent loops, cross-factory parents and inactive parents are rejected. A meter with active child meters or unresolved utility events cannot be deactivated.

For a cumulative meter, the first observation establishes a zero-consumption baseline. Each later observation must be newer than the prior observation, must not decrease the counter and must include the exact previous reading. Consumption is (current - previous) × multiplier. For an interval meter, consumption is reading × multiplier. Cost uses the meter's rate snapshot: consumption × unit_cost. If a positive production quantity is supplied, the ledger derives intensity_per_unit = consumption / production_quantity. Readings are append-only. Counter rollover and corrections are not silently inferred; they require a separately governed correction/rollover workflow.

Example meter payload (JSON):
    {
      "meter_code": "ELEC-MAIN-01",
      "name": "Main electricity incomer",
      "utility_type": "ELECTRICITY",
      "reading_mode": "CUMULATIVE",
      "unit_code": "kWh",
      "multiplier_factor": 1,
      "unit_cost": 12.5,
      "currency_code": "BDT",
      "cost_center_code": "CC-UTILITIES",
      "source_system_code": "METER-GATEWAY-01"
    }

Example reading payload (JSON):
    {
      "reading_at": "2026-10-18T08:00:00Z",
      "reading_value": 25150.25,
      "production_quantity": 1200,
      "source_type": "METER_GATEWAY",
      "source_event_id": "gateway-01:event-4382",
      "notes": "Morning shift counter snapshot"
    }

Utility-event lifecycle: OPEN → ACKNOWLEDGED → RESOLVED, with CANCELLED allowed before resolution. Resolution requires a reason and resolution narrative. Events keep severity, affected meter, timestamp and optional impact minutes/quantity.

## Permit-to-work / LOTO

| Endpoint | Permission | Purpose |
|---|---|---|
| GET /api/ehs/permits | ehs.permits.read | List permits; optional status/risk/limit |
| POST /api/ehs/permits | ehs.permits.manage | Create a DRAFT permit |
| POST /api/ehs/permits/:permitId/transition | ehs.permits.execute | Submit, verify isolation, activate, close, cancel or expire |
| POST /api/ehs/permits/:permitId/decision | ehs.permits.approve | Approve or reject as a separate decision permission |

Lifecycle: DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE → CLOSED. Rejection/cancellation is supported before work starts; expiry is only permitted after the approved/active permit reaches its expiry timestamp. Permit number and intended work scope/window are immutable; changes require a new permit.

Electrical LOTO, confined-space, high-risk and critical-risk permits must declare isolation points. Each declared point must be positively verified with non-empty evidence by an authenticated actor before activation. The requester cannot approve their own permit. Activation must be inside the permit validity window. Close-out requires structured evidence and a reason.

## Incident and corrective action

| Endpoint | Permission | Purpose |
|---|---|---|
| GET /api/ehs/incidents | ehs.incidents.read | List incidents/near-misses/unsafe observations/findings |
| POST /api/ehs/incidents | ehs.incidents.report | Record a report with severity, time, location, optional owner/due date |
| POST /api/ehs/incidents/:incidentId/transition | ehs.incidents.manage | Investigate, require action, resolve, close, reopen or cancel |
| GET /api/ehs/incidents/:incidentId/corrective-actions | ehs.incidents.read | Read action register |
| POST /api/ehs/corrective-actions | ehs.incidents.manage | Add an owned, due-dated action |
| POST /api/ehs/corrective-actions/:actionId/transition | ehs.incidents.manage | Start, submit evidence, reopen or cancel |
| POST /api/ehs/corrective-actions/:actionId/verify | ehs.corrective_actions.verify | Independently verify completion |

Incidents include incident, near-miss, unsafe-observation, injury, environmental-release and audit-finding types. Closure requires root-cause analysis, structured evidence, and all attached corrective actions to be verified or cancelled. Corrective-action submitter, owner, creator and verifier are checked so a single actor cannot perform the full completion/verification path. A reason is required on state transitions; audit events are append-only.

Example permit decision payload (JSON):
    {
      "expected_version": 2,
      "action": "APPROVE",
      "reason": "Reviewed the method statement and isolation plan",
      "decision_reason": "Approved for the stated validity window"
    }

Example corrective-action verification payload (JSON):
    {
      "expected_version": 3,
      "action": "VERIFY",
      "reason": "Independent inspection completed",
      "verification_evidence": {
        "guard_pull_test": "pass",
        "line_released": true,
        "inspector_note": "Replacement and guarding verified at line side"
      }
    }

## Vendor meter source binding, normalized readings and threshold alerts (Task 16)

The additive migration `168_energy_utility_ehs_lifecycle_closure.sql` introduces a tenant/factory-scoped source binding. The API requires an active in-factory meter, a source-system/meter identity, raw unit, approved conversion factor, adapter declaration (`REST_POLL`, `OPC_UA`, `MQTT`, `MODBUS`, `FILE_IMPORT` or `MANUAL_IMPORT`), optional polling interval and a secret-manager reference. A source binding starts as `DRAFT`; activation is versioned and must be approved by someone other than its creator. The database rejects credentials/private keys embedded in source configuration metadata and the API exposes only whether a secret reference is configured, not its value.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/utilities/source-bindings` | `utilities.meters.read` | List approved/configured source identities without exposing credential references |
| `POST /api/utilities/source-bindings` | `utilities.sources.manage` | Create a DRAFT source identity and unit conversion mapping |
| `POST /api/utilities/source-bindings/:bindingId/transition` | `utilities.sources.manage` | Activate/deactivate/retire an approved mapping with expected version and reason |
| `POST /api/utilities/source-events` | `utilities.readings.capture` | Validate a source event against the mapping, normalize its unit and append it to the existing reading ledger |

The ingestion contract requires exact source-system, source-meter and source-unit identity plus a stable source event ID. It normalizes the raw numeric reading using the approved factor, derives a stable idempotency key and retains the original source ID in the normalized reading. The existing utility ledger still checks meter activation, chronological order, cumulative/interval arithmetic, cost snapshot and source-event uniqueness. A repeated event replays the same result; the same idempotency key with a different payload conflicts.

Threshold policies are factory-scoped, DRAFT-first and independently approved. A policy selects a meter and/or utility type, metric (`CONSUMPTION`, `COST` or `INTENSITY`), comparison (`GT`, `GTE`, `LT`, `LTE`), a threshold and unit, and severity. For meter-specific policies the threshold unit must match the meter's reading unit, currency for cost or derived intensity unit. A matching reading creates one immutable policy/readings alert, a linked utility event and a `UTILITIES.THRESHOLD_ALERT_RAISED` transactional outbox event. The alert action reuses the existing utility event lifecycle (acknowledge, resolve with resolution narrative, or permitted cancellation); the event and reading audit records remain the source of truth.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/utilities/threshold-policies` | `utilities.alerts.read` | Read configured policies and approval state |
| `POST /api/utilities/threshold-policies` | `utilities.alerts.manage` | Create a DRAFT threshold policy |
| `POST /api/utilities/threshold-policies/:policyId/transition` | `utilities.alerts.manage` | Activate/deactivate/retire with expected version |
| `GET /api/utilities/threshold-alerts` | `utilities.alerts.read` | Inspect reading-linked alerts and event status |
| `POST /api/utilities/threshold-alerts/:alertId/transition` | `utilities.alerts.manage` | Acknowledge/resolve/cancel through the event lifecycle |

**Vendor integration boundary:** this is an adapter-neutral source-event contract, not a deployed vendor driver or scheduler. The declared adapter and polling interval are governance/configuration metadata only. No live meter was polled and no external vendor credential was exercised by this repository change. Live transport, device/network configuration, interval delivery/late-event policy, rollout credentials, hardware-in-loop and actual meter evidence need a separate staging sign-off. Outbox creation is verified separately from delivery by an external notification provider.

## Emergency drills, chemical/SDS records and contractor induction (Task 16)

Emergency drills now support idempotent plans and versioned `PLANNED → IN_PROGRESS → COMPLETED` or `CANCELLED` lifecycle. A drill cannot be completed until a present attendee and at least one response/action record exist; close-out requires an outcome summary and structured evidence. Attendance and response evidence is append-only; response timestamps must fall between the drill start and the current time, and identified tenant users must be active members of that tenant.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /api/ehs/drills` | `ehs.drills.read` | List drill plans, attendance counts and response counts |
| `POST /api/ehs/drills` | `ehs.drills.manage` | Plan a drill |
| `POST /api/ehs/drills/:drillId/transition` | `ehs.drills.manage` | Start, cancel or close a drill with version/reason and close-out evidence |
| `GET/POST /api/ehs/drills/:drillId/attendance` | `ehs.drills.read/manage` | Read or record a single attendance result with evidence |
| `GET/POST /api/ehs/drills/:drillId/responses` | `ehs.drills.read/manage` | Read or record response/action timing and evidence |
| `GET/POST /api/ehs/chemicals` | `ehs.chemicals.read/manage` | List or register a DRAFT chemical/SDS revision |
| `POST /api/ehs/chemicals/:chemicalId/transition` | `ehs.chemicals.manage` | Activate/deactivate/retire an SDS revision with reason/version |
| `GET/POST /api/ehs/contractors/inductions` | `ehs.contractors.read/manage` | Inspect or register induction evidence and its validity |
| `POST /api/ehs/contractors/inductions/:inductionId/transition` | `ehs.contractors.manage` | Revoke or mark expired induction evidence |

Chemical records preserve chemical identity, hazard class, storage location, SDS revision/document reference, handling/emergency instructions and review-due timestamp. Only controlled HTTPS/object-store references are accepted; this API records document provenance but does not fetch, scan or attest the remote file's contents. Each revision is immutable after creation; an expired review cannot be activated and a new document requires a new revision. Contractor induction records include contractor/person identity, completed training time, topics, evidence and expiry; future training cannot be recorded as completed and expired induction cannot be activated.

Drill, attendance, response, SDS and contractor changes produce append-only `ehs_lifecycle_events` plus transactional `EHS.LIFECYCLE_CHANGED` outbox events. This proves the accountable notification has been queued with its source record; it does **not** prove email/SMS/mobile push delivery. Provider credentials, notification subscriptions/retry/dead-letter monitoring, live recipients and external delivery receipts remain deployment/staging acceptance.

## Validation

PostgreSQL CI applies the ordered migration manifest including migration 168, reapplies the energy/EHS closure migration for DDL idempotency, and runs `services/api/test/energy-ehs-closure.sql`. That fixture covers an independently approved Wh→kWh source binding, a normalized threshold-matching reading and transactional alert outbox, a below-threshold non-alert case, drill completion with attendance/response, a drill-close negative case, an active SDS revision, and contractor-induction audit/outbox evidence. Utility/EHS service unit specs cover request validation and fail-closed source lookup; passing these tests on a candidate SHA is required before this task is release-verified.

Not included or externally unverified: live vendor polling/transport, site-specific meter accuracy/calibration, hardware-in-loop testing, credential provisioning, external SDS download/content scanning, a real on-site emergency drill, mobile/offline worker capture, provider-side email/SMS/push delivery and external delivery receipts. These remain explicit rollout/staging acceptance items. The API-side one-shot OPC UA gateway contract is documented in docs/ot-device-registry-opcua-read-slice.md; it is not a deployed meter poller.
