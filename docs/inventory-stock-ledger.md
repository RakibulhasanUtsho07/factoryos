# Inventory stock ledger — backend implementation slice

**Status:** Foundational slice implemented; WP02/Core Domain Kernel remains partial.  
**Requirement alignment:** FactoryOS AI v2.1 Blueprint WP02 (Core domain kernel), the SRS manufacturing/inventory scope, and cross-cutting tenant isolation, idempotency, audit and event invariants.

## API surface

The controller is mounted at **/inventory/items**. Each endpoint requires a verified user/tenant context and a factory scope authorized by IAM.

- **POST /inventory/items** creates a factory-scoped item and its zero-quantity balance.
- **GET /inventory/items?search=...&limit=50** lists items and current balances in the authorized factory.
- **POST /inventory/items/:itemId/movements** records a **RECEIPT** or **ISSUE**; the caller must provide an **Idempotency-Key** header.
- **POST /inventory/items/:itemId/reconciliations** performs an immediate privileged stock adjustment; it requires `inventory.reconcile.direct` (ORG_ADMIN) and an **Idempotency-Key** header. `CYCLE_COUNT` is deliberately rejected on this path.
- **GET /inventory/items/:itemId/reconciliations?limit=50** lists immutable count/reconciliation history.
- **POST /inventory/items/:itemId/cycle-counts** submits a physical count for independent review; `inventory.reconcile` and an **Idempotency-Key** are required.
- **GET /inventory/items/:itemId/cycle-counts?status=PENDING_REVIEW&limit=50** lists factory-scoped count proposals.
- **POST /inventory/items/:itemId/cycle-counts/:proposalId/approve** applies a reviewed count atomically; it requires `inventory.cycle-count.review` and a distinct **Idempotency-Key**.
- **POST /inventory/items/:itemId/cycle-counts/:proposalId/reject** rejects a count with a required review reason; it requires `inventory.cycle-count.review` and an **Idempotency-Key**.
- **GET /inventory/items/:itemId/movements?limit=50** returns the item's ledger history.
- **POST /inventory/items/:itemId/reservations** reserves currently available stock; an `Idempotency-Key` is required. An optional `location_id` pins the reservation to an active `BIN` in the same factory; that bin must have sufficient unreserved on-hand stock.
- **GET /inventory/items/:itemId/reservations?status=RESERVED&limit=50** lists factory-scoped reservations.
- **POST /inventory/items/:itemId/reservations/:reservationId/transition** releases or consumes a reservation and requires a separate `Idempotency-Key`.
- **POST /orders/:orderId/material-dispositions** records a partial or full `RETURN_TO_STOCK` or `SCRAPPED` quantity against a consumed order-line reservation; an `Idempotency-Key` is required.
- **POST /orders/:orderId/production-reports** records good finished output and scrap output for one order line; it requires `orders.write` and an `Idempotency-Key`.
- **POST /inventory/locations** creates a factory-scoped `WAREHOUSE`, `STAGING`, or child `BIN`; bins must belong to an active warehouse/staging location.
- **GET /inventory/locations?limit=50** lists the factory locations, including the protected `UNASSIGNED` bucket that preserves compatibility for global stock operations.
- **GET /inventory/items/:itemId/locations?limit=100** returns per-location quantities and the aggregate on-hand/reserved/available totals for the item.
- **POST /inventory/items/:itemId/location-transfers** moves stock between active locations with an `Idempotency-Key`; transfers do not change aggregate on-hand and reject stock reserved for open work.
- **GET /inventory/items/:itemId/location-transfers?limit=50** lists immutable transfer evidence.
- **GET /orders/:orderId/production-reports?limit=50** lists immutable, factory-scoped output/yield reports for an order and requires `orders.read`.

The movement payload accepts movement_type, a positive quantity with up to four decimal places, optional reference_type, optional UUID reference_id, and optional notes.

Order creation accepts an optional `inventory_item_id` on each order line. When supplied, the API requires an active item from the order's same tenant/factory and requires its unit to match the line unit (case-insensitive). Legacy/unmapped lines remain valid with a null binding.

## Data integrity and safety guarantees

Migration 038_inventory_stock_ledger.sql adds three tenant-scoped tables:

- **inventory_items** defines an item identity within a factory.
- **inventory_stock_balances** stores the current quantity and rejects negative values.
- **inventory_movements** stores append-only receipt/issue evidence with the request fingerprint, actor, correlation ID, quantity delta and resulting balance.

Composite foreign keys prevent an item or movement from being attached to another tenant/factory. PostgreSQL RLS is enabled and forced on all three tables. API endpoints additionally pass through IAM's factory-scope permission guard and include tenant/factory predicates.

A movement transaction locks the item row, rechecks the idempotency key, atomically updates the stock balance, inserts the immutable movement row and emits a transactional outbox event. The balance, movement and outbox event commit or roll back together. Migration 058 adds `quantity_reserved`; stock issues cannot lower on-hand stock below the amount still reserved, and each item response reports on-hand, reserved and available quantities.

Stock reconciliation uses the same item-first lock order. A cycle count is first recorded as a pending proposal without changing stock. Only a different reviewer can approve it; approval then snapshots the ledger quantity, compares it to the count, and in one transaction updates the balance, writes immutable reconciliation evidence, emits `INVENTORY.STOCK_RECONCILED` and `INVENTORY.CYCLE_COUNT_APPROVED`, adds a matching `RECEIPT` or `ISSUE` movement when the variance is non-zero, and changes the proposal to `APPLIED`. Submission also captures the ledger balance version; if any stock/reservation transaction changes that balance before approval, the review is rejected as stale and the operator must submit a fresh count. A database trigger verifies that the movement matches the reconciliation row; zero-variance counts are recorded without creating a no-op movement. Counts below `quantity_reserved` are rejected so the balance cannot invalidate open reservations. `inventory.reconcile` lets `ORG_ADMIN` and `FACTORY_MANAGER` submit count proposals; `inventory.cycle-count.review` lets those roles review them, while the database enforces submitter/reviewer separation. The immediate reconciliation permission `inventory.reconcile.direct` is reserved to `ORG_ADMIN`. Submit and review retries are factory-scoped and reject changed payloads. Rejected proposals require a reason, and cycle-count evidence and review decisions are append-only/terminal.

Reservation creation locks the same item row used by stock movements, fingerprints the complete request (including an optional bin), and atomically increases aggregate reserved quantity, stores the reservation and emits an outbox event. An explicit `location_id` must identify an active `BIN` in the same factory; the bin's `quantity_reserved` is updated in the same transaction and database deferred constraints require it to equal the sum of active reservations assigned to that bin. Reservations created without `location_id`, including the existing order-confirmation flow, remain unallocated across locations for backward compatibility. A reservation can make one terminal transition only: `RESERVED -> RELEASED` or `RESERVED -> CONSUMED`. Releasing lowers aggregate and (when pinned) bin reserved quantities without changing on-hand stock. Consuming lowers both aggregate and bin on-hand/reserved quantities, and creates an append-only `ISSUE` movement attributed to the reserved bin. Location transfers cannot move stock below that bin's reserved quantity. Legacy aggregate-only issues drain only unreserved bin quantities, preventing them from silently consuming stock committed to a bin reservation. Transition retries are bound to a separate idempotency key; the database prevents reservation payload/location edits, deletion, or reopening terminal reservations. The unique index on (tenant_id, factory_id, idempotency_key) is the final arbiter for concurrent retries; identical requests replay the stored result, while reusing the key with a different request is rejected. An issue that would make stock negative fails closed.

Migration 059 introduces a nullable `order_lines.inventory_item_id` and backfills `order_lines.factory_id` for existing rows. Composite foreign keys bind each order line to its parent order and, when selected, to an inventory item in the same tenant/factory. A database trigger fills factory scope for legacy SQL inserts that omit it and rejects cross-scope item bindings or unit mismatches. The order create/read API exposes `inventory_item_id`, and the `ORDER.CREATED` outbox payload carries the binding for downstream workflows.

Audit events are attempted after commit using the existing API audit service. A durable inventory domain event is already recorded in the transactional outbox, so downstream consumers have a replayable business-event source.

## Verification evidence

The API unit suite covers normalized item creation, required movement and reservation idempotency keys, receipt recording, same-request replay, mismatched-key rejection, insufficient-stock rejection, reservation create/replay, available-stock checks, consume/release behaviour and terminal-state rejection. PostgreSQL integration coverage checks forced RLS metadata, append-only movement records, factory-scope foreign-key enforcement, non-negative balances, reserved-not-above-on-hand, immutable reservation bindings and terminal lifecycle protection. Order lifecycle integration tests additionally cover confirmation reserve, completion consumption, cancellation release and full rollback on insufficient stock. Stock-reconciliation PostgreSQL integration tests cover positive/negative variance, matching receipt/issue movement, exact idempotent replay, changed-payload conflict, zero variance without a no-op movement, and rejection of a count below reserved stock. Cycle-count integration tests cover non-mutating submission, self-approval rejection, independent approval, atomic application, review idempotency and reasoned rejection. Migrations 058–062 provide reservations, order-line binding, immutable material-disposition history, stock-reconciliation evidence, and cycle-count review with forced RLS and movement-link integrity.

Order cancellation after production has started requires explicit material disposition. `POST /orders/:orderId/material-dispositions` records an idempotent quantity as `RETURN_TO_STOCK` or `SCRAPPED` against a consumed order-line reservation. Returned quantities create a positive immutable `RECEIPT` movement and update on-hand balance; scrap is recorded as immutable evidence without adding stock. Partial dispositions are allowed while an order is `IN_PROGRESS`, but the sum for each consumed reservation must equal the issued quantity before it can be cancelled. Application checks and a PostgreSQL trigger enforce this condition; dispositions cannot be edited or deleted. A cancellation that has not fully dispositioned consumed materials fails without changing the order status.

## Production yield and scrap reporting (migration 063)

Production reports distinguish accepted finished output from scrapped finished output. They do not represent raw-material disposition: returned raw material still uses the separate material-disposition workflow above, and finished-good scrap never increases raw-material stock.

- A report can only be recorded while its order is `IN_PROGRESS`; the order line must belong to the same order, tenant, and factory.
- Both output quantities are non-negative and use the existing four-decimal quantity precision. At least one must be positive, and a non-zero scrap quantity requires a reason.
- Cumulative accepted good output cannot exceed the planned order-line quantity; scrap is tracked separately because it does not fulfill customer demand and may require replacement production. The order row is locked for each report, so concurrent submissions cannot over-report accepted good output.
- Reports are append-only and factory/tenant-scoped, have required idempotency keys, and reject key reuse with a different request. PostgreSQL validates order state, output limits, cumulative snapshots, scope and immutability as a second enforcement layer.
- Each accepted report records cumulative good quantity, cumulative scrap quantity and yield percentage (`good / (good + scrap) × 100`). The report and `ORDER.PRODUCTION_REPORTED` outbox event commit atomically; audit logging is attempted after commit.

## Warehouse, bin and location-level stock (migration 064)

Each factory has a protected virtual `UNASSIGNED` stock bucket. Existing aggregate stock is backfilled there; future factory creation automatically creates the bucket. `inventory_location_balances` stores item quantities by location, while an after-trigger keeps the sum consistent with the authoritative aggregate `inventory_stock_balances` whenever legacy/global services adjust on-hand stock. Legacy aggregate issues drain location buckets deterministically; they do not assert that a physical pick occurred from a specific bin.

- Create a `WAREHOUSE` or `STAGING` location, then create `BIN` children under that parent. Codes are unique case-insensitively per factory; cross-tenant/factory parent bindings are rejected.
- Stock receipts/issues may optionally include `location_id`. The chosen location balance delta and aggregate stock balance commit together; issues cannot make that bin negative, and aggregate reservations remain protected.
- If `location_id` is omitted, receipts go to `UNASSIGNED`. Legacy/global issues reduce `UNASSIGNED` first, then other bins in deterministic location-ID order; their movement record retains a null location because no single physical source bin was specified.
- A location transfer is a separate immutable record with source/destination before/after quantities, required idempotency, actor, audit attempt and transactional `INVENTORY.STOCK_LOCATION_TRANSFERRED` outbox event. Transfers lock the item and its aggregate first, cannot move more than currently unreserved aggregate stock, and do not change aggregate on-hand.
- Location, location-balance and transfer tables force tenant RLS. Location transfers and default-location identity are protected from direct mutation.

This is the first location/bin vertical slice. Location-scoped cycle-count approvals, allocation of reservations to specific bins, directed put-away/picking, lot/serial genealogy, warehouse replenishment and multi-step receiving remain follow-on work.

## Explicitly out of scope

This is a stock-ledger and reservation foundation, not a complete warehouse or manufacturing inventory module. Bound order lines participate in the order-status transaction: `DRAFT -> CONFIRMED` reserves each mapped line with a stable per-order-line idempotency key; `CONFIRMED -> IN_PROGRESS` consumes the reservation into an append-only issue movement as production starts; `COMPLETED` finalizes the order without issuing stock again; and cancellation of an order that never started releases any active reservations without changing on-hand stock.

For cancellation after production has started, the API exposes `POST /orders/:orderId/material-dispositions`. Each consumed reservation's issued quantity must be explicitly accounted for as `RETURN_TO_STOCK` or `SCRAPPED` while the order is `IN_PROGRESS`. Returned quantities generate a receipt movement and increase on-hand stock; scrap records evidence without adding stock. Partial dispositions are allowed, but the total per reservation must equal its consumed quantity before cancellation succeeds. Idempotency, tenant/factory scope, immutable records, audit/outbox events, and a database trigger protect the workflow. An insufficient-stock confirmation and an incomplete-disposition cancellation both roll back without changing order state. Unmapped legacy lines remain valid and do not reserve stock.

Lot/serial identity registration and product genealogy are implemented as a scoped traceability slice (migration 074; see `docs/lot-serial-product-genealogy.md`). Approved UoM definitions/conversions and quantity validation are implemented in migrations 075–077 (see `docs/unit-of-measure-conversion.md`), including base-unit precision enforcement in both API and database-side stock movement validation. Formal customer/shipment order processing, quality-management record systems, RFID/mobile offline synchronization, lot-aware stock/reservation decrements, costing/valuation, reorder policies, location/bin-level cycle counting, allocation of reservations to bins, directed put-away/picking, approval thresholds and full ERP/MES integration acceptance remain separate work. The first stock-reconciliation slice records and applies count differences, but does not yet implement a separate draft/review/approve cycle-count workflow. These inventory capabilities are still a partial WP02 implementation; neither WP02 nor whole-backend completion should be marked complete on this slice alone.
