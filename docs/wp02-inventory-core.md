# WP02 — Inventory Core (first vertical slice)

## Scope and traceability

- **Source scope:** SRS v2.1 core manufacturing domain; HLD/LLD §6 (Materials & supply / Inventory-WMS), §12 (transaction + outbox), §22 (tenant isolation); Engineering Implementation Blueprint WP02, WP03, WP12 and §31–§32.
- **Delivery:** factory-scoped inventory catalog, immutable stock-movement ledger, transactional balance projection and outbox event. This does not claim full WMS, procurement, lot/serial traceability, reservations, costing, or production consumption are complete.
- **Dependency:** existing IAM, tenant/factory authorization, PostgreSQL RLS, audit service, outbox envelope and CI migration sequence.

## API contract

All routes use the global /api prefix and require a bearer token.

- POST /api/v1/inventory/items — inventory.write + factory scope; create an item master row.
- GET /api/v1/inventory/items?page=1&limit=20&search=... — inventory.read + factory scope; paginated item search.
- POST /api/v1/inventory/movements — inventory.write + factory scope and required Idempotency-Key; record a receipt, issue or adjustment.
- GET /api/v1/inventory/balances?item_id=...&location_code=... — inventory.read + factory scope; list current balance projections.
- GET /api/v1/inventory/movements?page=1&limit=20&item_id=...&location_code=...&movement_type=... — inventory.read + factory scope; append-only movement history.

quantity_delta is signed: RECEIPT must be positive, ISSUE must be negative, and ADJUSTMENT may be either direction but cannot be zero. Values are limited to 6 fractional digits. Each accepted operation requires a reason of at least 8 characters. A retry with the same idempotency key and same request hash returns the original movement; reusing the key with a different payload is a conflict.

## Data-integrity controls

- All three inventory tables are tenant-RLS protected and additionally filtered by the verified factory in every query.
- Composite tenant/factory foreign keys prevent an item or balance being linked across factories.
- Stock updates lock the balance row and execute inside a single PostgreSQL transaction.
- Negative stock and quantities above the supported cap are rejected in SQL, not only in TypeScript.
- Each accepted movement inserts the immutable ledger row, updates the balance projection, and inserts INVENTORY.MOVEMENT_RECORDED into the existing outbox within one transaction.
- The ledger database trigger rejects update/delete, while the current balance remains a derived, mutable projection.
- IAM permissions are explicit (inventory.read, inventory.write); the migration grants both to existing system ORG_ADMIN roles only.

## Acceptance evidence

The PostgreSQL integration suite covers receipt/balance/outbox atomicity, idempotent replay, conflicting idempotency payload, insufficient stock, concurrent issue/oversell prevention, cross-factory reads, and database-level ledger immutability. Unit tests cover malformed movement direction, zero/over-precision quantity, and invalid idempotency keys.

## Remaining WP02 work

This is not a full inventory/WMS implementation. Future slices must add product/material master-data ownership, locations/warehouses, reservations and allocations, lot/batch/serial traceability, procurement receipt, production consumption/output, inventory reconciliation, valuation/cost integration and related acceptance scenarios before full SRS scope can be called complete.
