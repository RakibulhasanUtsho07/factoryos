# Inventory stock ledger — backend implementation slice

**Status:** Foundational slice implemented; WP02/Core Domain Kernel remains partial.  
**Requirement alignment:** FactoryOS AI v2.1 Blueprint WP02 (Core domain kernel), the SRS manufacturing/inventory scope, and cross-cutting tenant isolation, idempotency, audit and event invariants.

## API surface

The controller is mounted at **/inventory/items**. Each endpoint requires a verified user/tenant context and a factory scope authorized by IAM.

- **POST /inventory/items** creates a factory-scoped item and its zero-quantity balance.
- **GET /inventory/items?search=...&limit=50** lists items and current balances in the authorized factory.
- **POST /inventory/items/:itemId/movements** records a **RECEIPT** or **ISSUE**; the caller must provide an **Idempotency-Key** header.
- **GET /inventory/items/:itemId/movements?limit=50** returns the item's ledger history.

The movement payload accepts movement_type, a positive quantity with up to four decimal places, optional reference_type, optional UUID reference_id, and optional notes.

## Data integrity and safety guarantees

Migration 038_inventory_stock_ledger.sql adds three tenant-scoped tables:

- **inventory_items** defines an item identity within a factory.
- **inventory_stock_balances** stores the current quantity and rejects negative values.
- **inventory_movements** stores append-only receipt/issue evidence with the request fingerprint, actor, correlation ID, quantity delta and resulting balance.

Composite foreign keys prevent an item or movement from being attached to another tenant/factory. PostgreSQL RLS is enabled and forced on all three tables. API endpoints additionally pass through IAM's factory-scope permission guard and include tenant/factory predicates.

A movement transaction locks the item row, rechecks the idempotency key, atomically updates the stock balance, inserts the immutable movement row and emits a transactional outbox event. The balance, movement and outbox event commit or roll back together. The unique constraint on (tenant_id, factory_id, idempotency_key) is the final arbiter for concurrent retries; identical requests replay the stored result, while reusing the key with a different request is rejected. An issue that would make stock negative fails closed.

Audit events are attempted after commit using the existing API audit service. A durable inventory domain event is already recorded in the transactional outbox, so downstream consumers have a replayable business-event source.

## Verification evidence

The API unit suite covers normalized item creation, required idempotency keys, receipt recording, same-request replay, mismatched-key rejection, and insufficient-stock rejection. PostgreSQL integration coverage checks forced RLS metadata, append-only movement records, factory-scope foreign-key enforcement, and the database non-negative balance constraint. The PostgreSQL CI workflow applies migration 038 after migrations 001–037.

## Explicitly out of scope

This is a stock-ledger foundation, not a complete warehouse or manufacturing inventory module. Location/bin management, reservations/allocations, purchase receipts, production consumption/scrap, lots/serials, unit conversions, costing/valuation, reorder policy, cycle counting, reconciliation workflows and ERP/MES integration acceptance remain open work. Therefore WP02 and whole-backend completion must not be marked complete on this change alone.
