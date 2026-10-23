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

The server measures active-run intervals on start/resume and closes them on pause/hold/downtime/complete. Downtime must have a matched start and end; its duration is accounted separately from active run time, and a downtime interval can open only while an operation timer is actively running. Each `WIP_REPORTED` event replaces the operation’s current WIP snapshot (including an explicit `0` to clear it); WIP may not be negative, and the sum of current WIP snapshots across all routing operations may not exceed the work-order target. Rework quantities must be positive and are retained as append-only rework evidence. Skip, hold, downtime-start, rework and scrap require a reason.

Example operation-event request (all state-changing commands require the current versions and an idempotency key):

```http
POST /api/production/work-orders/{workOrderId}/operations/{operationId}/events
Idempotency-Key: line-a-op-1-start-00042
Content-Type: application/json
```

```json
{
  "command": "START",
  "expected_work_order_version": 3,
  "expected_operation_version": 2,
  "source": "HMI",
  "device_id": "LINE-A-HMI-02",
  "occurred_at": "2026-10-22T08:00:00Z"
}
```

Use the same endpoint for `PAUSE`, `RESUME`, `COMPLETE`, `DOWNTIME_START`, `DOWNTIME_END`, `WIP_REPORTED`, `WIP_TRANSFERRED` and `REWORK_REPORTED`. WIP is an absolute current-quantity snapshot, not a delta:

```json
{
  "command": "WIP_REPORTED",
  "quantity": 0,
  "expected_work_order_version": 5,
  "expected_operation_version": 4,
  "source": "HMI",
  "device_id": "LINE-A-HMI-02"
}
```

A zero WIP snapshot explicitly clears the current operation WIP before finishing/transferring. A downtime-start command requires an open active-run timer and a reason; downtime-end requires an open interval. The server computes elapsed run/downtime from its own timestamps rather than trusting device-supplied duration values.

### Explicit WIP transfer

`WIP_TRANSFERRED` moves a positive quantity only from an `IN_PROGRESS` or `PAUSED` operation to the immediate next routing operation in the same work order. Both source and target operation versions are serialized under the work-order transaction; source WIP is decreased and target WIP increased atomically. The work-order-wide sum of WIP across all operations is capped at the target quantity, so a WIP snapshot cannot duplicate the same planned units across two routing stages. The transfer is rejected if it would overdraw source WIP, exceed the work-order target, skip over an operation, target an already running/completed operation, or occur while source downtime is open.

```json
{
  "command": "WIP_TRANSFERRED",
  "quantity": 25,
  "target_operation_id": "7ffb7604-2066-4e94-8b9f-7bfb1cbef115",
  "expected_work_order_version": 8,
  "expected_operation_version": 5,
  "source": "HMI",
  "device_id": "LINE-A-HMI-02",
  "occurred_at": "2026-10-22T09:15:00Z"
}
```

One immutable `WIP_TRANSFERRED` event records the from/to operation and before/after quantities. Matching source and target `WIP_REPORTED` snapshot events are written in the same transaction so both persisted WIP changes remain auditable; a deferred PostgreSQL constraint rejects any WIP change missing that evidence. Reusing the same `Idempotency-Key` for a different command at the operation-events endpoint produces a conflict rather than executing a second command.

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

Output is reported only while the final routing operation is actively running outside downtime. Each report is inserted into the immutable `order_production_reports` ledger and linked to the work order and final operation. The request locks the source order and work order, validates factory/tenant scope and caps cumulative good-plus-scrap processed quantity at the work-order target. Scrap requires a reason. Only **good quantity** fulfils the sales-order line; scrap remains separate quality/output evidence and never increases raw-material or finished-good stock.

Within that same database transaction, the service calculates per-report and cumulative yield (`good / (good + scrap) × 100`) at four-decimal precision, writes the append-only `production_output_postings` record, and posts accepted good output as a `RECEIPT` inventory movement for the work order's pinned `finished_item_id`. The inventory balance, immutable movement, `INVENTORY.STOCK_RECEIVED` outbox event, production report/posting and `PRODUCTION.OUTPUT_REPORTED` event either commit together or roll back together. Receipts go to the factory's `UNASSIGNED` virtual location until directed put-away moves them to a physical bin. Scrap-only reports write yield/scrap evidence without creating a zero-quantity inventory movement.

The output-report response exposes `production_report_id`, `production_output_posting_id`, `finished_good_movement_id`, `output_yield_percentage` and `cumulative_yield_percentage`. Work-order detail also reports aggregate/per-operation yield, posted finished-good quantity and output-posting count. The order-level `POST /api/orders/:orderId/production-reports` endpoint remains supported for lines that have no production work-order history: the order line must be bound to a finished-good inventory item, and its response includes `report_yield_percent`, `production_output_posting_id` and `finished_good_movement_id`. Once any work order has been created for a line, all new output for that line must use the work-order `/output-reports` endpoint and its final routing operation, even if earlier work orders were later cancelled. The API and migration 092's PostgreSQL trigger both reject unlinked order-level reports for work-order-managed lines; create a replacement work order to resume production. Same-key retries return the stored report/posting links without receiving stock twice; legacy reports created before migration 091 without posting evidence are surfaced as a reconciliation conflict instead of a successful inventory-linked replay.

The final operation cannot complete until cumulative good plus scrap equals its work-order target. A work order cannot complete until all operations are completed/skipped (quality gates cannot be skipped), WIP is zero, all output reports have matching immutable posting/yield evidence, reported good and scrap totals reconcile with the posting ledger, and the target is fully reported. A good-output report is not successful unless its linked finished-good receipt is present. The sales order itself cannot transition to `COMPLETED` or `CANCELLED` while it has open work orders; cancel or complete the work orders explicitly first. In addition, when a production work order has been created for a line, the sales order cannot become `COMPLETED` until cumulative accepted good output for that line meets the ordered quantity. Scrap does not fulfill demand, so a shortfall requires a replacement work order and more accepted good output. The rule also applies if every work order for the line was later cancelled; cancelling a work order is not evidence that ordered good output was fulfilled. The API pre-check provides a specific conflict response, and migration `091` repeats the completion rule in PostgreSQL for direct SQL writers.

Material reservations follow the same terminal transaction: an unstarted work order cancellation releases its raw-material reservations; a completed work order consumes them, decrements aggregate/bin on-hand and reserved balances, creates an ISSUE stock movement for every consumed reservation, and writes inventory outbox evidence. If any reservation, balance or movement is inconsistent, the parent work-order transition rolls back with it. A released work order therefore cannot silently complete without its linked material reservations being consumed.

## Evidence, security and boundaries

The cross-slice PostgreSQL gate and its explicit acceptance boundary are tracked in [manufacturing lifecycle acceptance](manufacturing-lifecycle-acceptance.md). Its current contract verifies the required domain links and commit-deferred guards after the individual PO/GRN, UoM, BOM/routing, production, quality and traceability regressions. Because those SQL regressions currently roll back independent fixtures, the shared single-fixture end-to-end acceptance remains open and is not inferred from this bounded production lifecycle implementation.

Migration `090` adds composite tenant/factory/order-line/product-version/routing foreign keys, forced tenant RLS, guarded state transitions, optimistic row versions, idempotency uniqueness, a partial unique index permitting one running operation per work order, append-only event history, and an output-report link to the production report ledger. Migration `091` adds the immutable `production_output_postings` bridge, scoped report and inventory-movement foreign keys, forced tenant RLS, and a deferred PostgreSQL constraint that rejects any work-order output report not accompanied by matching yield/scrap and inventory-posting evidence at commit. A second trigger validates that the stock movement is a `RECEIPT` for the exact finished item, quantity and report; another prevents posting edits/deletes. Work-in-progress snapshots and rework quantities are preserved in the append-only shop-floor event ledger.

Every command records event source (`API`, `HMI`, `MES`, `PLC`, `MOBILE` or `IMPORT`), client occurrence time, server record time, authenticated user, optional device ID and idempotency hash. Canonical state, event and transactional-outbox record commit together; the external audit sink is attempted after commit.

MRP-lite remains the horizon-based material-requirement/shortage planner, including visibility into future approved PO supply. Work-order release is the execution boundary: it reserves actual available on-hand material, and completion consumes those reservations into inventory ISSUE movements. Accepted finished goods are posted during the output-report transaction; scrap is never counted as sellable stock. The broader module does not auto-create/approve purchase orders, reserve future incoming supply, schedule finite capacity, infer skill certification, or execute quality disposition. Lot/serial-aware finished-good receipt allocation remains separate follow-on work. Quality rework tasks are tracked under `/api/quality/rework-orders`, linked back to the originating defect and lot/order/operation/production evidence, and require a separate follow-up inspection; completing rework does not silently post recovered quantity to inventory.


## Engineering changes and pinned production snapshots

ECO approval changes the effective product revision, not a production order's historical engineering contract. Each work order retains its original `product_version_id`, copied routing operation snapshots and immutable material-requirement/reservation links. The ECO affected-order list records what must be reviewed; it does not update work orders, operations, reservations, or consumption evidence. If a not-yet-started order must follow the new design, cancel/close it under the existing lifecycle rules and create a replacement against the revision effective on its planned start date. Released or running orders require an explicit disposition decision rather than an in-place revision swap.

The database validates revision effectiveness for new work-order planning and keeps the existing work-order lifecycle, operation-snapshot, and material-snapshot immutability guards active. Submitted ECO affected-order evidence is immutable; approval locks and compares the current order set and returns a conflict if status, pinned revision, planned dates or membership drifted since submission. Reject/recreate the ECO to recalculate, rather than overwriting the original impact evidence. The ECO SQL contract test checks these guards together so adding engineering change control cannot accidentally weaken production snapshot protection.
