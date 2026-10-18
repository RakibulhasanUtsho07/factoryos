# Workforce: shifts, attendance and operator productivity

This module supplies factory-scoped backend capture and audit APIs for the SRS Workforce requirements (FR-WFC-01/02/05, FR-UFM-19/20), and connects labor records to the frozen operation routing snapshot used by shop-floor execution.

## Core behavior

- **Worker and skill matrix:** worker codes are unique case-insensitively within a factory. Skill certifications retain history as a prior assignment is marked inactive and a replacement is captured. A work-order operation's `required_skill` is authoritative; staffing a linked operation requires a matching, non-expired worker skill.
- **Shift templates and roster:** templates retain local start/end time, IANA time zone, unpaid break, late-grace and overtime threshold settings. Assignments resolve shift instants from the local shift date and the template's time zone. Overnight shifts end on the following calendar date. Invalid local daylight-saving times and ambiguous DST overlaps fail closed instead of silently changing the roster.
- **Roster state:** `PLANNED → CONFIRMED → COMPLETED`; `PLANNED/CONFIRMED → CANCELLED`. Every transition requires a reason and expected row version. Active assignments cannot overlap for the same worker, and an assignment with attendance evidence cannot be cancelled. Completion requires clock-out evidence.
- **Attendance:** append-only `CLOCK_IN`, `BREAK_START`, `BREAK_END`, `CLOCK_OUT` or `ABSENCE_RECORDED` events are accepted from `MANUAL`, `BIOMETRIC`, `QR` and `API` sources. Both API idempotency keys and source event IDs are deduplicated. The database reconstructs the timestamp-ordered stream, so delayed device delivery is permitted only if the final sequence is valid. Repeated break periods are supported. Event timestamps must fit the assignment capture window. The daily attendance read returns raw events and a shift summary. Finalized worked minutes are clock-in-to-clock-out duration less the larger of recorded break duration or the configured unpaid break; lateness is measured after the shift's grace period. Open shifts are not represented as finalized payroll minutes.
- **Biometric privacy:** biometric events are rejected unless the worker has explicit consent active at the event's occurrence time. Consent grants and withdrawals are retained as append-only evidence; raw biometric templates or fingerprints are never accepted as event metadata. Only roles with workforce permissions can browse worker names; the self-service route filters by the authenticated user's linked worker record. Linking a worker account grants a dedicated factory-scoped role that contains only `workforce.self.read`; it does not grant worker-list, attendance-management or overtime-approval permissions.
- **Overtime:** a request is accepted only when recorded clock-out proves overtime beyond the shift template threshold; requested minutes cannot exceed observed post-shift minutes. Approval/rejection is reasoned, version checked, once-only, and maker-checker enforced.
- **Productivity / IE:** labor reports are tied to one roster assignment, work order and frozen operation, and are blocked without attendance, valid required skill, matching operation code/standard minutes, when a worker's report intervals overlap, or when cumulative attributed good+scrap quantity exceeds that operation's work-order target. Productivity query totals aggregate the complete requested date range independently of the paginated/limited report list. Good output and scrap quantities require up to four decimal places; scrap requires a reason. Database-generated values are:
  - `earned_minutes = good_quantity × standard_minutes_per_unit`
  - `efficiency_percent = earned_minutes ÷ actual_minutes × 100`
  
  Range summaries report the weighted efficiency from total earned / total actual minutes, not an unweighted average of operator percentages. These labor reports are attribution evidence; they do **not** post inventory movements or replace the canonical production output/yield/scrap ledger.

## API

Every protected request must carry the authenticated user/tenant/factory context established by the existing auth middleware. Factory scope is derived from that trusted context, never from request-body tenant IDs. Mutation requests require an `Idempotency-Key` header (1–255 characters). Writes use transaction-local RLS context; master updates are versioned and source evidence remains immutable.

| Method | Route | Required permission |
|---|---|---|
| GET / POST | `/workforce/workers` | `workforce.workers.read` / `workforce.workers.manage` |
| POST | `/workforce/workers/:workerId/status` | `workforce.workers.manage` |
| POST | `/workforce/workers/:workerId/biometric-consent` | `workforce.workers.manage` |
| GET / POST | `/workforce/skills` | `workforce.skills.read` / `workforce.skills.manage` |
| POST | `/workforce/workers/:workerId/skills` | `workforce.skills.manage` |
| GET / POST | `/workforce/shifts` | `workforce.shifts.read` / `workforce.shifts.manage` |
| POST | `/workforce/staffing` | `workforce.staffing.manage` |
| POST | `/workforce/staffing/:assignmentId/transition` | `workforce.staffing.manage` |
| GET | `/workforce/staffing/coverage?shift_date=YYYY-MM-DD` | `workforce.staffing.read` |
| POST / GET | `/workforce/attendance/events` / `/workforce/attendance?shift_date=YYYY-MM-DD` | `workforce.attendance.capture` / `workforce.attendance.read` |
| POST / GET | `/workforce/overtime` | `workforce.overtime.request` / `workforce.overtime.read` |
| POST | `/workforce/overtime/:overtimeId/decision` | `workforce.overtime.approve` |
| POST / GET | `/workforce/productivity/reports` | `workforce.productivity.capture` / `workforce.productivity.read` |
| GET | `/workforce/self/records?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD` | `workforce.self.read` |

The attendance, overtime and productivity list endpoints are date-scoped; roster/skill/worker lists accept a `limit` from 1 to 200. Roster coverage flags absence or a missed clock-in after the configured grace period and recommends up to five active, qualified workers who are not scheduled for an overlapping assignment. Attendance summary counts and worked-minute totals cover the whole shift roster even when the visible event and worker-detail lists are limited. Names and backfill candidates are returned only under the corresponding authorized management permission.

## Data integrity and CI

Migrations `102_workforce_shift_attendance_productivity.sql` through `107_workforce_shift_revision_and_attendance_corrections.sql` add tenant/factory-scoped constraints, FORCE RLS, actor-bound triggers, consent timeline projection, source-event attribution, command idempotency, shift-template revisions and immutable correction/audit evidence. `workforce-management-contract.sql` and `workforce-lifecycle.sql` are part of the PostgreSQL CI migration run. The API exposes append-only attendance events plus a permissioned, versioned correction overlay that preserves original evidence. A Bangla mobile/QR worker PWA, offline client queue, vendor-specific biometric adapter, training/induction records, group-level absenteeism cohorts and notification/reminder scheduler remain separate delivery items. Attendance metadata is a flat allow-listed set of low-risk scalar diagnostics only; arbitrary nested payloads and biometric templates/images are rejected in the API and database.

## External source reconciliation

Attendance devices or workforce applications that publish signed integration events should use the shared [operational event reconciliation contract](./operational-event-reconciliation.md). That layer tracks cross-system source identity, event/arrival timestamps, duplicate replays, missing sequence ranges and conflict cases without editing immutable attendance events. Attendance payroll-minute calculations and corrections continue to use the workforce ledger and its versioned correction overlay; a reconciliation-case decision is not itself an attendance correction.
