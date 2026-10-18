# Energy, Utilities and EHS/Safety — first backend slice

This slice implements the factory-scoped operational foundation called for by FactoryOS AI SRS v2.1:
- FR-UFM-21/22: energy and utility quantities, per-production-unit intensity, meter hierarchy and source-to-cost mapping.
- FR-EHS-01: permit-to-work approval, isolation verification, validity window and close-out evidence.
- FR-EHS-03: incident, near-miss, unsafe-observation and audit-finding capture with owners, due dates and closure evidence.
- FR-EHS-04 is not claimed as complete: the emergency-drill register/attendance/response workflow remains a separate slice.

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

## Validation

PostgreSQL CI explicitly applies migrations 108–111 after the existing workforce migrations and checks the migration inventory. The utility contract exercises RLS, duplicate-source protections, cumulative/interval arithmetic, time ordering, hierarchy-cycle rejection and event resolution. The EHS contract exercises row isolation, permit decision independence, the isolation activation gate, action verification independence and the incident closure gate.

Not included in this first slice: meter vendor/device connectors, automatic polling and threshold-alert scheduling, unit-conversion/utility-billing integrations, energy dashboards, emergency drills, chemical/SDS registry, contractor induction/access validity, EHS workflow notifications, and EHS/worker mobile screens. These remain separate tasks rather than being described as delivered.
