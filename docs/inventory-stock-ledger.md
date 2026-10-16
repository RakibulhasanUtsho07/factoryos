# Inventory stock ledger — backend implementation slice

**Status:** Foundational slice implemented; WP02/Core Domain Kernel remains partial.  
**Requirement alignment:** FactoryOS AI v2.1 Blueprint WP02 (Core domain kernel), the SRS manufacturing/inventory scope, and cross-cutting tenant isolation, idempotency, audit and event invariants.

## API surface

The controller is mounted at **/inventory/items**. Each endpoint requires a verified user/tenant context and a factory scope authorized by IAM.

- **POST /inventory/items** creates a factory-scoped item and its zero-quantity balance.
- **GET /inventory/items?search=...&limit=50** lists items and current balances in the authorized factory.
- **POST /inventory/items/:itemId/movements** records a **RECEIPT** or **ISSUE**; the caller must provide an **Idempotency-Key** header.
- **GET /inventory/items/:itemId/movements?limit=50** returns the item's ledger history.
- **POST /inventory/items/:itemId/reservations** reserves currently available stock; an `Idempotency-Key` is required.
- **GET /inventory/items/:itemId/reservations?status=RESERVED&limit=50** lists factory-scoped reservations.
- **POST /inventory/items/:itemId/reservations/:reservationId/transition** releases or consumes a reservation and requires a separate `Idempotency-Key`.

The movement payload accepts movement_type, a positive quantity with up to four decimal places, optional reference_type, optional UUID reference_id, and optional notes.

Order creation accepts an optional `inventory_item_id` on each order line. When supplied, the API requires an active item from the order's same tenant/factory and requires its unit to match the line unit (case-insensitive). Legacy/unmapped lines remain valid with a null binding.

## Data integrity and safety guarantees

Migration 038_inventory_stock_ledger.sql adds three tenant-scoped tables:

- **inventory_items** defines an item identity within a factory.
- **inventory_stock_balances** stores the current quantity and rejects negative values.
- **inventory_movements** stores append-only receipt/issue evidence with the request fingerprint, actor, correlation ID, quantity delta and resulting balance.

Composite foreign keys prevent an item or movement from being attached to another tenant/factory. PostgreSQL RLS is enabled and forced on all three tables. API endpoints additionally pass through IAM's factory-scope permission guard and include tenant/factory predicates.

A movement transaction locks the item row, rechecks the idempotency key, atomically updates the stock balance, inserts the immutable movement row and emits a transactional outbox event. The balance, movement and outbox event commit or roll back together. Migration 058 adds `quantity_reserved`; stock issues cannot lower on-hand stock below the amount still reserved, and each item response reports on-hand, reserved and available quantities.

Reservation creation locks the same item row used by stock movements, fingerprints the complete request and atomically increases reserved quantity, stores the reservation and emits an outbox event. A reservation can make one terminal transition only: `RESERVED -> RELEASED` or `RESERVED -> CONSUMED`. Releasing lowers reserved quantity without changing on-hand stock. Consuming lowers both on-hand and reserved quantities and creates an append-only `ISSUE` movement tied to the reservation. Transition retries are bound to a separate idempotency key; the database prevents reservation payload edits, deletion, or reopening terminal reservations. The unique index on (tenant_id, factory_id, idempotency_key) is the final arbiter for concurrent retries; identical requests replay the stored result, while reusing the key with a different request is rejected. An issue that would make stock negative fails closed.

Migration 059 introduces a nullable `order_lines.inventory_item_id` and backfills `order_lines.factory_id` for existing rows. Composite foreign keys bind each order line to its parent order and, when selected, to an inventory item in the same tenant/factory. A database trigger fills factory scope for legacy SQL inserts that omit it and rejects cross-scope item bindings or unit mismatches. The order create/read API exposes `inventory_item_id`, and the `ORDER.CREATED` outbox payload carries the binding for downstream workflows.

Audit events are attempted after commit using the existing API audit service. A durable inventory domain event is already recorded in the transactional outbox, so downstream consumers have a replayable business-event source.

## Verification evidence

The API unit suite covers normalized item creation, required movement and reservation idempotency keys, receipt recording, same-request replay, mismatched-key rejection, insufficient-stock rejection, reservation create/replay, available-stock checks, consume/release behaviour and terminal-state rejection. PostgreSQL integration coverage checks forced RLS metadata, append-only movement records, factory-scope foreign-key enforcement, non-negative balances, reserved-not-above-on-hand, immutable reservation bindings and terminal lifecycle protection. Order lifecycle integration tests additionally cover confirmation reserve, completion consumption, cancellation release and full rollback on insufficient stock. Migrations 058 and 059 provide the reservation and order-line binding schema.

## Explicitly out of scope

This is a stock-ledger and reservation foundation, not a complete warehouse or manufacturing inventory module. Bound order lines now participate in the order-status transaction: `DRAFT -> CONFIRMED` reserves each mapped line using a stable per-order-line idempotency key; `CONFIRMED -> IN_PROGRESS` consumes the reservation into an append-only issue movement as production starts; `COMPLETED` finalizes the order without issuing stock a second time; and transition to `CANCELLED` releases any active reservations without changing on-hand stock. An insufficient-stock confirmation rolls back the order status, reservations and outbox evidence together. A line with an active reservation under a different idempotency key is rejected rather than double-reserved. Unmapped legacy lines remain valid and do not reserve stock. These guarantees are covered by PostgreSQL integration tests; WP02 remains partial. Location/bin management, purchase receipts, production consumption/scrap beyond order completion, lots/serials, unit conversions, costing/valuation, reorder policy, cycle counting, reconciliation workflows and ERP/MES integration acceptance remain open work. Therefore WP02 and whole-backend completion must not be marked complete on this change alone.
