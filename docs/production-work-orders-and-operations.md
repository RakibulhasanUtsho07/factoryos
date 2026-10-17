# Production work orders and shop-floor operation lifecycle

**Requirement traceability:** SRS v2.1 `FR-UFM-05` (order-linked quantity and due date), `FR-UFM-07` (versioned BOM and routing), `FR-UFM-08` (planning rules and material readiness), `FR-UFM-09` (start, stop, output, WIP, downtime, hold/release, rework and scrap) and `FR-UFM-10` (event source, timestamp, actor/device and factory scope).

## API routes

All paths are under `/api`. Verified authentication middleware and `RequireFactoryScope` determine the tenant and factory; clients cannot supply their own scope. Every write uses an `Idempotency-Key` and optimistic versions where state changes are possible.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/production/work-orders?limit=50&status=IN_PROGRESS` | `production.workorders.read` | List work orders in the verified factory |
| `POST /api/production/work-orders` | `production.workorders.write` | Create a draft from a sales-order line and snapshot its effective routing |
| `GET /api/production/work-orders/:workOrderId` | `production.workorders.read` | Read work-order quantity, operation snapshots, output totals and recent event history |
| `POST /api/production/work-orders/:workOrderId/release` | `production.workorders.release` | Check release readiness and make the first operation ready |
| `POST /api/production/work-orders/:workOrderId/hold` | `production.operations.operate` | Put a released/running work order on hold |
| `POST /api/production/work-orders/:workOrderId/resume` | `production.operations.operate` | Resume an on-hold work order |
| `POST /api/production/work-orders/:workOrderId/complete` | `production.workorders.release` | Complete after all operations and the full processed quantity are reconciled |
| `POST /api/production/work-orders/:workOrderId/cancel` | `production.workorders.release` | Cancel only work that has not started or reported output |
| `POST /api/production/work-orders/:workOrderId/operations/:operationId/events` | `production.operations.operate` | Start/pause/resume/hold/complete/skip an operation; report downtime, WIP or rework |
| `POST /api/production/work-orders/:workOrderId/output-reports` | `production.output.report` | Record good and scrap output against the active final operation |

## Create and release

Example request:

```json
{
  "order_line_id": "a4f159c0-4a80-4b27-b3ac-e5c311fe6cf8",
  "target_quantity": 250,
  "planned_start_date": "2026-10-20",
  "due_date": "2026-10-28",
  "priority": 2,
  "notes": "First production batch"
}
```

Creation requires a confirmed/in-progress order line mapped to an active finished-good inventory item, an active product definition, an approved product version effective on the planned start date, at least one BOM line and one routing step, active BOM components and active work centres. It calculates unallocated order-line quantity from prior good output and the remaining processed target of other open work orders, so two drafts cannot independently allocate the same order-line quantity. Overdue orders may be planned for later dates; that does not rewrite their original due date.

The work order copies the effective route into immutable operation snapshots, including step number, operation code/name, work centre, required skill/instructions, quality-gate flag and planned setup/run/queue/transfer times. Later engineering revisions cannot silently alter an already-created work order.

The work order also snapshots one material requirement for every pinned BOM line. Quantities use the BOM line's immutable inventory-base-unit conversion snapshot and are rounded up to four decimal places:

```text
gross output target = work-order target quantity / (expected yield percent / 100)
required component = gross output target
                   * BOM base_quantity_per
                   * (1 + wastage_percent / 100)
required quantity = CEILING(required component to 0.0001)
```

This is the executable work-order material contract, not the MRP-lite advisory proposal. During release, every requirement must reserve its full quantity from unreserved inventory across active, pickable bins (or the configured eligible virtual/default picking location). A short component or insufficient eligible bin quantity blocks release atomically. The shared inventory reservation service updates aggregate/bin reserved balances, creates immutable reservation rows and writes inventory outbox events within the same transaction as the work-order release and operation readiness event. The requirement and reservation link records remain immutable and can be inspected in the work-order detail response.


A release request requires `expected_version` and is permitted only while the source sales order is `IN_PROGRESS`. It rechecks that the pinned product revision remains approved/effective, BOM components are active, routing operations exist and work centres are active. The first operation becomes `READY`; later operations stay `PLANNED` until preceding operations complete or are explicitly skipped when non-quality-gated. If a later engineering revision supersedes the pinned version, the old draft cannot be released against a now-inapplicable route; create a new work order from the correct revision.

## Lifecycle rules

Work-order states:

```text
DRAFT -> RELEASED -> IN_PROGRESS -> COMPLETED
   |         |            |
   +-> CANCELLED          +-> ON_HOLD -> IN_PROGRESS
              RELEASED/IN_PROGRESS/ON_HOLD may be cancelled only
              while no operation has started and no output exists.
```

Operation states:

```text
PLANNED -> READY -> IN_PROGRESS -> COMPLETED
                       |    |
                       v    v
                    PAUSED  ON_HOLD
                       |       |
                       +-> IN_PROGRESS / PAUSED or READY
PLANNED/READY -> SKIPPED only when the operation is not a quality gate.
```

Only one operation per work order may be running at once. An operation cannot start until every preceding step is `COMPLETED` or `SKIPPED`; skips are prohibited for quality-gate steps. Operation commands require both `expected_work_order_version` and `expected_operation_version`; stale writes fail with a conflict rather than overwriting another operator's work.

The server measures active-run intervals on start/resume and closes them on pause/hold/downtime/complete. Downtime must have a matched start and end; its duration is accounted separately from active run time. WIP and rework event quantities must be positive. Skip, hold, rework and scrap require a reason.

## Good output, scrap and order reconciliation

Example final-operation output report:

```json
{
  "operation_id": "a4f159c0-4a80-4b27-b3ac-e5c311fe6cf8",
  "expected_work_order_version": 4,
  "expected_operation_version": 3,
  "good_quantity": 245,
  "scrap_quantity": 5,
  "scrap_reason": "Failed final dimensional inspection",
  "source": "HMI",
  "device_id": "LINE-A-HMI-02",
  "occurred_at": "2026-10-22T08:25:00Z"
}
```

Output is reported only while the final routing operation is actively running outside downtime. Each report is inserted into the existing immutable `order_production_reports` ledger and linked to the work order and final operation. The database locks the source order and work order, validates scope and caps cumulative good-plus-scrap processed quantity at the work-order target. Scrap requires a reason. Only **good quantity** fulfils the sales-order line; scrap remains quality/output evidence and does not restock raw materials.

The final operation cannot complete until cumulative good plus scrap equals its work-order target. A work order cannot complete until all operations are completed/skipped (quality gates cannot be skipped) and that target is fully reported. The sales order itself cannot transition to `COMPLETED` or `CANCELLED` while it has open work orders; cancel or complete the work orders explicitly first.

Material reservations follow the same terminal transaction: an unstarted work order cancellation releases its raw-material reservations; a completed work order consumes them, decrements aggregate/bin on-hand and reserved balances, creates an ISSUE stock movement for every consumed reservation, and writes inventory outbox evidence. If any reservation, balance or movement is inconsistent, the parent work-order transition rolls back with it. A released work order therefore cannot silently complete without its linked material reservations being consumed.

## Evidence, security and boundaries

Migration `090` adds composite tenant/factory/order-line/product-version/routing foreign keys, forced tenant RLS, guarded state transitions, optimistic row versions, idempotency uniqueness, a partial unique index permitting one running operation per work order, append-only event history, and an output-report link to the existing production report ledger. Work-in-progress and rework report quantities are preserved in the append-only shop-floor event ledger and aggregated in the operation detail response; good output/scrap remain separately recorded in the canonical production report ledger.

Every command records event source (`API`, `HMI`, `MES`, `PLC`, `MOBILE` or `IMPORT`), client occurrence time, server record time, authenticated user, optional device ID and idempotency hash. Canonical state, event and transactional-outbox record commit together; the external audit sink is attempted after commit.

MRP-lite remains the horizon-based material-requirement/shortage planner, including visibility into future approved PO supply. Work-order release is the execution boundary: it reserves actual available on-hand material, and completion consumes those reservations into inventory ISSUE movements. It does not auto-create/approve purchase orders, reserve future incoming supply, post finished goods receipts, schedule finite capacity, infer skill certification, or execute quality disposition. Finished-good stock posting remains an explicit inventory/production posting step outside this work-order completion transaction.
