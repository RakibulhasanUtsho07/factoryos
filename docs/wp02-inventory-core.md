# WP02 — Inventory Core (first vertical slice)

## Scope and traceability

- **Source scope:** SRS v2.1 core manufacturing domain; HLD/LLD §6 (Materials & supply / Inventory-WMS), §12 (transaction + outbox), §22 (tenant isolation); Engineering Implementation Blueprint WP02, WP03, WP12 and §31–§32.
- **Delivery:** factory-scoped inventory catalog, immutable stock-movement ledger, transactional balance projection, reservation/release/consume lifecycle and outbox events. This remains a WP02 vertical slice, not a claim that full WMS, procurement, lot/serial traceability, costing, or production integration are complete.
- **Dependency:** existing IAM, tenant/factory authorization, PostgreSQL RLS, audit service, outbox envelope and CI migration sequence.

## API contract

All routes use the global /api prefix and require a bearer token.

- POST /api/v1/inventory/items — inventory.write + factory scope; create an item master row.
- GET /api/v1/inventory/items?page=1&limit=20&search=... — inventory.read + factory scope; paginated item search.
- POST /api/v1/inventory/movements — inventory.write + factory scope and required Idempotency-Key; record a receipt, issue or adjustment.
- GET /api/v1/inventory/balances?item_id=...&location_code=... — inventory.read + factory scope; list current balance projections.
- GET /api/v1/inventory/movements?page=1&limit=20&item_id=...&location_code=...&movement_type=... — inventory.read + factory scope; append-only movement history.
- POST /api/v1/inventory/reservations — inventory.write + factory scope and required Idempotency-Key; reserve quantity from available stock.
- GET /api/v1/inventory/reservations?page=1&limit=20&item_id=...&status=ACTIVE — inventory.read + factory scope; list reservations.
- POST /api/v1/inventory/reservations/{reservationId}/release — inventory.write + Idempotency-Key; release a live reservation.
- POST /api/v1/inventory/reservations/{reservationId}/consume — inventory.write + Idempotency-Key; consume a live reservation and record an ISSUE movement.

quantity_delta is signed: RECEIPT must be positive, ISSUE must be negative, and ADJUSTMENT may be either direction but cannot be zero. Values are limited to 6 fractional digits. Each accepted operation requires a reason of at least 8 characters. A retry with the same idempotency key and same request hash returns the original movement; reusing the key with a different payload is a conflict.

## Data-integrity controls

- All three inventory tables are tenant-RLS protected and additionally filtered by the verified factory in every query.
- Composite tenant/factory foreign keys prevent an item or balance being linked across factories.
- Stock updates and reservations lock the balance row and execute inside a single PostgreSQL transaction.
- Available stock is on-hand minus reserved quantity. Ordinary issue/negative adjustments cannot consume already-reserved quantity.
- Reservation scope/quantity are immutable; an ACTIVE reservation may transition only once to RELEASED or CONSUMED. Lifecycle events are append-only and database-enforced.
- Consuming a reservation atomically reduces on-hand and reserved quantities, inserts the ISSUE movement and both movement/reservation outbox events.
- Negative stock and quantities above the supported cap are rejected in SQL, not only in TypeScript.
- Each accepted movement inserts the immutable ledger row, updates the balance projection, and inserts INVENTORY.MOVEMENT_RECORDED into the existing outbox within one transaction.
- The ledger database trigger rejects update/delete, while the current balance remains a derived, mutable projection.
- IAM permissions are explicit (inventory.read, inventory.write); the migration grants both to existing system ORG_ADMIN roles only.

## Acceptance evidence

The PostgreSQL integration suite covers receipt/balance/outbox atomicity, idempotent replay, conflicting idempotency payload, insufficient stock, concurrent issue/oversell prevention, reservation availability, release and consume replay, concurrent reservation oversubscription, cross-factory reads, and database-level append-only ledgers. Unit tests cover malformed movement direction, zero/over-precision movement/reservation quantity, and invalid idempotency keys.

## Remaining WP02 work

This is not a full inventory/WMS implementation. Future slices must add product/material master-data ownership, location/warehouse lifecycle, lot/batch/serial traceability, procurement receipt, order/production allocation integration, inventory reconciliation, valuation/cost integration and related acceptance scenarios before full SRS scope can be called complete.


## WP02-B — reservation lifecycle

Migration `045_inventory_reservations.sql` introduces reserved quantity in each stock balance, tenant-scoped reservation records and an immutable lifecycle event ledger. The new API supports creating reservations, listing reservations, releasing unused reservations and consuming a reservation into an atomic ISSUE movement. Every mutating route requires `Idempotency-Key`; transitions are one-way from ACTIVE to RELEASED or CONSUMED.

Acceptance conditions include concurrent reservation attempts against the same stock, prevention of a direct issue that would use reserved units, idempotent release/consume retry, atomic balance/ledger/outbox changes, factory isolation, and database-level lifecycle ledger immutability.
