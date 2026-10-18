# Asset registry, preventive maintenance and maintenance work orders

**SRS traceability:** FactoryOS AI SRS v2.1 `FR-UFM-01` (asset hierarchy), `FR-UFM-03` (versioned master data), `FR-UFM-04` (maintenance windows/calendars) and `FR-UFM-18` (asset hierarchy, PM, breakdown work orders and spare parts).

Every route is mounted under `/api`. Requests use verified bearer authentication and factory scope; tenant/factory IDs are taken from the authorization context, never from the request body. State-changing requests require an `Idempotency-Key`. Mutable assets, plans, tasks, parts and work orders use optimistic `expected_version` checks. Maintenance tables enforce tenant RLS and append-only, version-matched event evidence in PostgreSQL.

## Asset registry and hierarchy

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/maintenance/assets?status=ACTIVE&parent_asset_id=...&limit=50` | `maintenance.assets.read` | List factory assets, optionally filtered by status or parent |
| `POST /api/maintenance/assets` | `maintenance.assets.manage` | Register an asset with a factory-unique asset code |
| `GET /api/maintenance/assets/:assetId` | `maintenance.assets.read` | Read an asset, its child assets, PM plans and recent work orders |
| `POST /api/maintenance/assets/:assetId/update` | `maintenance.assets.manage` | Version-checked metadata, hierarchy, criticality and status change |

Example asset payload:

```json
{
  "asset_code": "PACK-LINE-01",
  "name": "Primary packaging line",
  "asset_type": "PRODUCTION_LINE",
  "parent_asset_id": null,
  "manufacturer": "Example OEM",
  "model": "PX-400",
  "serial_number": "PX400-00021",
  "criticality": "HIGH",
  "location": "Building A / Line 1",
  "commissioned_on": "2026-05-12",
  "warranty_expires_on": "2028-05-11",
  "notes": "Primary finished-goods packing line"
}
```

The registry supports parent/child hierarchy, manufacturer/model/serial, criticality (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), lifecycle (`ACTIVE`, `INACTIVE`, `RETIRED`), location, commissioning/warranty dates, optimistic versioning and event history. Parent links must remain within the same factory and cannot contain cycles. A non-active parent cannot have active children; assets with open work orders cannot be retired/inactivated. Asset codes are immutable after registration so historical evidence is never silently renamed.

An update example requires the current version and a reason:

```json
{
  "expected_version": 1,
  "criticality": "CRITICAL",
  "location": "Utilities room",
  "reason": "Risk review identified a plant-wide production dependency"
}
```

## Preventive maintenance (PM)

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/maintenance/pm-plans?status=ACTIVE&asset_id=...&limit=50` | `maintenance.pm.read` | List versioned plans and next due dates |
| `POST /api/maintenance/pm-plans` | `maintenance.pm.manage` | Create a draft revision with interval and checklist |
| `GET /api/maintenance/pm-plans/:planId` | `maintenance.pm.read` | Read one plan revision and its event history |
| `POST /api/maintenance/pm-plans/:planId/transition` | `maintenance.pm.manage` | Activate, pause, resume or retire a plan |
| `POST /api/maintenance/pm-plans/:planId/generate-due` | `maintenance.pm.manage` | Generate one due PM work-order occurrence |

Example PM plan:

```json
{
  "asset_id": "27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a",
  "plan_code": "WEEKLY-INSPECTION",
  "name": "Weekly mechanical inspection",
  "description": "Inspect vibration, guards, lubrication and fasteners",
  "interval_value": 1,
  "interval_unit": "WEEK",
  "next_due_on": "2026-10-25",
  "estimated_duration_minutes": 90,
  "requires_shutdown": true,
  "checklist": [
    { "code": "ISOLATE", "description": "Apply and verify lockout/tagout", "required": true },
    { "code": "VIBRATION", "description": "Record bearing vibration reading", "required": true },
    { "code": "GUARDS", "description": "Inspect and secure guards", "required": true }
  ]
}
```

Supported interval units are `DAY`, `WEEK` and `MONTH`; checklist task codes must be unique within a plan. Plans are created as `DRAFT` and follow `DRAFT → ACTIVE → PAUSED → ACTIVE`, with retirement permitted from draft/active/paused. Activation requires an approver other than the creator. The database permits one active revision for an asset and plan code. Revisions remain historical; work orders snapshot the plan revision, due occurrence and checklist at creation time.

A PM work order can be generated only from an active plan attached to an active asset, when `next_due_on <= CURRENT_DATE`. The operation is idempotent; its occurrence is protected against duplication and the next due date advances in the same database transaction as work-order creation. The current implementation exposes an explicit due-generation route; it does not run a background scheduler that polls plans automatically.

## Maintenance and breakdown work orders

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/maintenance/work-orders?status=IN_PROGRESS&work_order_type=BREAKDOWN&priority=URGENT&asset_id=...&limit=50` | `maintenance.workorders.read` | Queue of planned, running, held, completed or cancelled work |
| `POST /api/maintenance/work-orders` | `maintenance.workorders.manage` | Raise a breakdown work order |
| `GET /api/maintenance/work-orders/:workOrderId` | `maintenance.workorders.read` | Read work-order history, checklist and parts |
| `POST /api/maintenance/work-orders/:workOrderId/transition` | `maintenance.workorders.execute` | Approve, start, hold, resume, complete or cancel |
| `POST /api/maintenance/work-orders/:workOrderId/tasks/:taskId/complete` | `maintenance.workorders.execute` | Complete a checklist task with reason/evidence |
| `POST /api/maintenance/work-orders/:workOrderId/spare-parts` | `maintenance.parts.manage` | Plan a spare-part requirement |
| `POST /api/maintenance/work-orders/:workOrderId/spare-parts/:partId/issue` | `maintenance.parts.manage` | Issue an available spare part from inventory |
| `GET /api/maintenance/spare-parts/availability/:itemId` | `maintenance.parts.manage` | Read on-hand, reserved and available quantity |

Breakdown example:

```json
{
  "asset_id": "27c7247c-1c4f-44eb-8b62-8d1ae4f3ee3a",
  "priority": "URGENT",
  "title": "Drive motor overheating",
  "description": "Motor temperature exceeded the factory operating threshold",
  "failure_code": "OVERHEAT",
  "scheduled_start_at": "2026-10-20T08:00:00Z",
  "due_at": "2026-10-20T12:00:00Z",
  "checklist": [
    { "code": "ISOLATE", "description": "Isolate and verify energy sources", "required": true },
    { "code": "INSPECT", "description": "Inspect cooling and bearings", "required": true },
    { "code": "TEST", "description": "Record post-maintenance test results", "required": true }
  ]
}
```

Work-order lifecycle is `PLANNED → APPROVED → IN_PROGRESS → COMPLETED`, with `IN_PROGRESS → ON_HOLD → IN_PROGRESS` supported. Planned/approved/on-hold orders may be cancelled only when spare-part stock has not already been issued. Every transition carries a reason, expected version, actor and idempotency key. Required checklist items need their own completion reason and evidence before completion is allowed; both API validation and a database trigger enforce the gate.

## Spare parts, stock ledger and event integrity

A spare part must be an active inventory item belonging to the same tenant and factory. Requirements can only be added before work starts, duplicate item requirements are prevented, and planned/issued quantities are limited to four decimal places. Issue requests lock the work order, part requirement, item and stock balance; they reject quantities above the unissued requirement or available unreserved inventory. In the same transaction, the service decrements `inventory_stock_balances.quantity_on_hand`, inserts an immutable `inventory_movements` ISSUE row referencing the maintenance part, increments issued quantity and writes a maintenance event. No second stock ledger is created.

Maintenance events include entity/version, transition, reason, event data, actor, timestamp and correlation ID. A PostgreSQL deferred constraint trigger requires a matching maintenance event for every created or updated asset, plan, work order, checklist task and spare-part requirement. Direct SQL cannot skip version increments, rewrite/delete checklist/part evidence, activate a plan without independent approval, complete a work order with incomplete required tasks, or increase issued quantity without a corresponding inventory movement.

## Requirements delivered

- Asset hierarchy and lifecycle with tenant/factory scope, criticality and versioned audit.
- Versioned preventive plans, maker-checker activation, interval scheduling and due-occurrence guard.
- Breakdown and PM work-order lifecycle, event history, versioned mandatory checklists and cancellation guard.
- Spare-part availability/issue integrated transactionally with the inventory stock ledger.
- PostgreSQL RLS, IAM permissions, input DTO validation, idempotency and optimistic concurrency.
- Migrations `099`–`101`, API unit validation tests, PostgreSQL schema/trigger contract tests and explicit migration registration in API PostgreSQL CI.
