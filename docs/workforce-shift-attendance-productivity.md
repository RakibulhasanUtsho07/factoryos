# Workforce: Shifts, Attendance, Overtime and Operator Productivity

This document describes the factory-scoped Workforce API and its evidence rules. The module is backend-only; it does not claim that a Bangla worker PWA, biometric-device connector, or offline browser queue is shipped.

## Scope and SRS mapping

- **FR-WFC-01 / FR-UFM-19:** worker registry, skill/certificate matrix, and skill requirements linked to frozen work-order operations.
- **FR-WFC-02:** daily staffing assignments, attendance comparison, late/absence visibility, and skill-valid backfill candidates. Worker names are exposed only through factory-scoped permissions.
- **FR-WFC-05:** an authenticated worker linked to a worker record can read their own attendance and overtime through the least-privilege `workforce.self.read` route.
- **FR-UFM-20:** overtime is threshold-gated by observed clock-out time, requires reasoned decision evidence, rejects self-approval, and is immutable once decided.
- **MES / IE productivity:** attendance-linked operator reports are tied to canonical shop-floor output or WIP transfer events; earned minutes and efficiency are generated from the released routing snapshot.

## API routes

All routes below require a bearer token. Except `GET /api/workforce/self/records`, these endpoints require authorized factory scope and the named permission. Mutating POST operations require an `Idempotency-Key` header.

| Method and route | Permission | Purpose |
|---|---|---|
| `GET /api/workforce/workers` | `workforce.workers.read` | List factory worker records |
| `POST /api/workforce/workers` | `workforce.workers.manage` | Register a worker; optional linked user must be an active tenant member |
| `POST /api/workforce/workers/:workerId/status` | `workforce.workers.manage` | Versioned worker activation/inactivation with reason |
| `GET /api/workforce/skills`, `POST /api/workforce/skills` | `workforce.skills.read/manage` | Read/create operation skills |
| `POST /api/workforce/workers/:workerId/skills` | `workforce.skills.manage` | Set skill level and certification dates; active certification cannot have inverted dates |
| `POST /api/workforce/workers/:workerId/biometric-consent` | `workforce.workers.manage` | Record a consent grant or withdrawal with purpose and reason |
| `GET /api/workforce/shifts`, `POST /api/workforce/shifts` | `workforce.shifts.read/manage` | Read/create shift templates |
| `POST /api/workforce/shifts/:shiftId/update` | `workforce.shifts.manage` | Versioned schedule/threshold edits or status transition with optimistic version and reason |
| `POST /api/workforce/staffing` | `workforce.staffing.manage` | Assign a worker to a shift/date; optionally bind work order, operation and required skill |
| `POST /api/workforce/staffing/:assignmentId/transition` | `workforce.staffing.manage` | Confirm, cancel or complete a roster assignment with optimistic version and reason |
| `GET /api/workforce/staffing/coverage?shift_date=YYYY-MM-DD` | `workforce.staffing.read` | Compare roster to attendance and suggest non-overlapping backfill with valid required skill |
| `POST /api/workforce/attendance/events` | `workforce.attendance.capture` | Append clock-in, break-start/end, clock-out or absence event |
| `POST /api/workforce/attendance/events/:eventId/correction` | `workforce.attendance.correct` | Append a versioned correction overlay to an original attendance event; requires a reason and idempotency key |
| `GET /api/workforce/attendance?shift_date=YYYY-MM-DD` | `workforce.attendance.read` | Read ordered attendance and worked/late-minute summaries |
| `POST /api/workforce/overtime` | `workforce.overtime.request` | Request observed overtime |
| `GET /api/workforce/overtime?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD` | `workforce.overtime.read` | Read overtime queue and decision evidence |
| `POST /api/workforce/overtime/:overtimeId/decision` | `workforce.overtime.approve` | Approve bounded minutes or reject with reason; cannot be the requester |
| `POST /api/workforce/productivity/reports` | `workforce.productivity.capture` | Attribute canonical shop-floor output to one worker and attendance interval |
| `GET /api/workforce/productivity/reports?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD` | `workforce.productivity.read` | Read productivity records and range-wide weighted efficiency |
| `GET /api/workforce/self/records?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD` | `workforce.self.read` | Read only the authenticated worker's own attendance/overtime |

## Shift and staffing behavior

- A shift stores local start/end time, IANA time zone, unpaid break minutes, late-grace minutes, and the overtime threshold.
- If an end time is earlier than or equal to the start time, the scheduled end resolves on the next calendar day. The resolved interval must be positive and no longer than 24 hours.
- Nonexistent and ambiguous daylight-saving wall-clock times are rejected rather than guessed. The default time zone is `Asia/Dhaka`.
- The database rejects overlapping active shift assignments for the same worker, inactive workers, inactive shift templates, cross-factory order/operation references, and operation skill requirements unsupported by a currently valid worker skill/certificate.
- Coverage queries count only planned/confirmed assignments; cancelled shifts must not inflate rostered, absent or worked-minute totals. Backfill candidates must be active, free over the target interval and suitably skilled on the shift date.

## Attendance and privacy

- Attendance is append-only evidence. Events carry occurrence time, capture source, optional device/source event ID, correlation ID and an idempotency key. `capture_metadata` accepts only a bounded flat set of non-sensitive scalar diagnostics (`device_id`, `reader_id`, `terminal_id`, `site_code`, `source_sequence`, `sync_batch_id`, `capture_method`, `reader_timestamp`, `firmware_version`, `signal_quality`, `device_event_type`, `client_version`, `device_timezone`, `offline_synced`, `latency_ms`, `batch_id`, `protocol_version`, `reader_status`, `status_code`, `error_code`, `integration_id`); nested objects, unknown fields, images, biometric templates and arbitrary blobs are rejected by both API validation and PostgreSQL.
- Timestamps must use an explicit UTC designator or offset (for example `2026-10-18T08:05:00+06:00`). Timestamp order, paired breaks and the final clock-out are validated against the whole occurred-at timeline, allowing an offline device to upload earlier events later if the effective timeline remains valid.
- Biometric events are accepted only when an explicit consent grant was effective at the event's occurrence time and no withdrawal had already become effective. Consent evidence distinguishes effective time from later ingestion time; source attendance records are not rewritten.
- Event source IDs and idempotency keys are unique within the factory scope. Reusing a key with different request data returns a conflict.
- RLS is forced on Workforce records. Worker, tenant and factory identifiers are resolved/validated by backend context rather than trusted from request-body input. Audit evidence is appended by database triggers and retained against deletion.
- Attendance correction is append-only evidence layered over the original device/manual event. Newest correction version drives the effective attendance view; the correction guard revalidates event ordering and refuses changes that would invalidate recorded overtime requests or productivity intervals. Correction permission is separately granted from ordinary attendance read/capture.
- Shift-template updates are versioned with an expected row version and reason. Existing shift assignments keep their resolved planned start/end snapshots, so changing a template does not silently rewrite a published roster.
- A Bangla worker PWA, offline client queue, external biometric device connector, HR approval/review of correction requests, and notification/reminder scheduler are not included as shipped UI/integration capabilities in this backend task.

## Overtime policy

A request is allowed only after a valid clock-out and only when actual post-shift minutes exceed the configured threshold. Requested minutes may not exceed the observed interval. An approval must be made by a different actor, with expected-version control and a reason; approved minutes must be greater than zero and cannot exceed the request. Decisions are one-way and auditable.

## Productivity attribution and formulas

The productivity request carries:

```json
{
  "shift_assignment_id": "UUID",
  "source_operation_event_id": "UUID",
  "work_order_id": "UUID",
  "work_order_operation_id": "UUID",
  "production_started_at": "2026-10-18T09:00:00+06:00",
  "production_ended_at": "2026-10-18T09:30:00+06:00",
  "good_quantity": 100,
  "scrap_quantity": 2,
  "standard_minutes_per_unit": 0.45,
  "actual_minutes": 28,
  "scrap_reason": "Broken needle"
}
```

Use the `source_operation_event_id` returned by the production work-order operation-event or output-report endpoint. It must reference a shop-floor `OUTPUT_REPORTED` or `WIP_TRANSFERRED` event for the same work order and operation. Output endpoint responses expose `source_operation_event_id` so a client can chain the request without guessing event identifiers.

- The source event's immutable good/scrap quantities are the upper bound for worker attribution. One worker cannot be attributed the same source event twice, and combined attributed quantity is bounded by both the source event and the operation's work-order target. Worker's production intervals cannot overlap.
- The worker must have clock-in evidence, the linked shift assignment must be confirmed/completed, and the work interval must fit inside the actual attendance window. If the operation bulletin requires a skill, its certificate must be valid on the shift date.
- `earned_minutes = good_quantity × standard_minutes_per_unit`.
- `efficiency_percent = earned_minutes ÷ actual_minutes × 100`.
- `standard_minutes_per_unit` must match the frozen operation routing `run_minutes_per_unit`. Scrap remains explicit defect evidence and does not earn standard minutes. Both formulas are generated by PostgreSQL to prevent client-supplied KPI tampering.
- Range-wide summary totals are computed across the entire selected period, not just the limited page of displayed reports.

## Verification

The PostgreSQL CI schema list includes migrations 102–107 in explicit order. The Workforce SQL contract asserts RLS, permissions, immutable/actor guards and the source-event/consent constraints. The lifecycle SQL contract covers ordered attendance, biometric-consent denial, roster overlap, correction version chaining with raw-event preservation, overtime maker-checker and immutable source evidence; the schema contract verifies the correction view/RLS/triggers and shift revision guard. Unit tests cover input validation, explicit timestamp offsets, productivity interval/quantity consistency and range-wide calculations.
