# Lot/Serial and Product Genealogy

Implements the traceability data/API slice for SRS v2.1 FR-WMS-02, FR-WMS-06, FR-WMS-07 and FR-WMS-09, connecting to the existing inventory stock ledger, posted GRN and production reports.

## Data model and controls

- `traceability_units` registers material/finished-good lots, individual serials, cartons, pallets, bundles and shipment identities. Unit code/barcode are unique case-insensitively per factory; a serial always has quantity 1.
- Material identities may link to an accepted line of a **posted GRN**. The database validates factory scope, derives the inventory item and supplier from the receipt/PO, and prevents registered lot/serial quantities from exceeding the accepted quantity or mixing bulk and serial representations.
- Finished-good identities may link to an order production report. The database binds the order and line from the report and prevents represented good quantity from exceeding reported output. Each report is represented by a bulk/lot identity or serial identities, not both.
- `product_genealogy_events` is an append-only directed graph supporting consumption, processing, split/merge, rework, carton/pallet packing and shipment relationships. Database guards reject cycles, cross-factory links, excessive cumulative source quantity, invalid source status and allocation-policy violations.
- `traceability_unit_status_events` preserves versioned quarantine, recall, disposition and shipment status history. Identity/provenance is immutable; status changes need a reason plus audit/outbox evidence.
- `traceability_label_templates` defines tenant/factory-specific QR, Code 128, Data Matrix or GS1-128 layouts for supported identity types. This stores label template data; label rendering/printing remains a client/scanner responsibility.
- `traceability_settings` configures retention (1–100 years; default 7) and FIFO/FEFO/lot/serial material consumption policy.

All traceability tables force tenant RLS. Composite foreign keys keep source evidence within tenant/factory scope, API mutations use Idempotency-Key where applicable, and identity/status/genealogy writes require transactional audit and outbox evidence.

## API

All routes require authenticated actor, tenant and factory context plus the named IAM permission and factory-scope guard.

- `POST /api/v1/traceability/units` — register a material/finished-good lot, serial, carton, pallet, bundle or shipment identity; requires `traceability.write` and `Idempotency-Key`.
- `GET /api/v1/traceability/units?search=&unit_type=&product_role=&status=&limit=50` — search/filter identities; requires `traceability.read`.
- `GET /api/v1/traceability/units/:unitId` — read identity with GRN/supplier, inventory, production/order and label-template references.
- `POST /api/v1/traceability/genealogy` — add a directed relationship with source, target, quantity, notes and evidence JSON; requires `traceability.write` and `Idempotency-Key`.
- `GET /api/v1/traceability/units/:unitId/forward?depth=5&limit=200` — follow downstream batches, products, packaging and shipment identities.
- `GET /api/v1/traceability/units/:unitId/reverse?depth=5&limit=200` — follow a finished product/carton/shipment upstream to source lots and production identities.
- `POST /api/v1/traceability/units/:unitId/status` and `GET /api/v1/traceability/units/:unitId/status-history` — controlled state changes plus immutable history.
- `POST /api/v1/traceability/label-templates`, `GET /api/v1/traceability/label-templates` — create/read label templates.
- `GET /api/v1/traceability/settings`, `PUT /api/v1/traceability/settings` — read/update factory retention and allocation policy using optimistic `expected_version`.

Forward/reverse queries cap depth at 12 and nodes at 500. Relationship `evidence` JSON can hold external quality certificate, inspection and shipment references.

## Work-order production output genealogy (migration 198)

For new work-order output reports, the output-posting transaction now creates a LOT / FINISHED_GOOD traceability identity for positive accepted-good quantity and binds it through production_output_postings.traceability_unit_id. When scrap is positive, it creates a separate LOT / OTHER scrap evidence identity and binds it through scrap_traceability_unit_id; scrap identities have no inventory item and do not create sellable stock. The finished-good identity is assigned only to stock capacity in the existing default UNASSIGNED bucket, bounded by the item/location ledger and tracked-identity balances.

When a work order completes, the same transaction consumes its remaining material reservations and translates the immutable inventory_reservation_consumption_traceability_allocations rows into append-only product_genealogy_events. Material input quantity remains expressed in the source lot/serial UOM and is deterministically apportioned across each report's good and scrap output quantity using integer four-decimal arithmetic. Matching audit and outbox evidence is inserted in the same transaction, and database constraints validate source/target scope, cumulative source quantity, cycle prevention and policy-order rules. Missing output identities fail the completion transition closed instead of reporting complete without the required traceability.

Migration/contract: migrations/198_production_output_lot_genealogy.sql and services/api/test/production-output-lot-genealogy.sql. Unit tests cover good + scrap identity creation, scrap-only handling and exact consumption-quantity conservation across multiple output reports.

Migration 199 makes this linkage a PostgreSQL invariant, not just an API convention. A genealogy edge into a work-order finished-good or scrap output must bind to an actual `inventory_reservation_consumption_traceability_allocations` row whose reservation belongs to that same work order and whose source lot/serial and output posting/report match. The database rejects arbitrary evidence JSON, checks the edge quantity against the allocated source quantity, and uses deferred constraints to require exact allocation conservation and a `COMPLETED` work order at commit. A work order cannot complete while any consumed tracked material allocation is missing from output genealogy. PostgreSQL acceptance is `services/api/test/work-order-genealogy-consumption-guard.sql`; the ordered manifest and CI replay migration 199 twice.

This is only the production-report-to-output-lot genealogy slice. It deliberately does not backfill historical output quantities into current physical bins, and does not claim finished-good carton/pallet transfer, shipment/customer trace, RFID/offline synchronization, recall-owner acceptance or a live plant end-to-end rehearsal.

## Scope boundary

The repository now has first-class quality inspections, immutable defect-to-lot/serial/order/work-order/operation/production-report/GRN links, verified CAPA actions and controlled rework tasks. A rework output is recorded as a new traceability identity tied to the originating defect; existing genealogy edges are not fabricated through a quarantined source. Physical shipment/dispatch/customer fulfilment, QR/barcode rendering and RFID/offline mobile sync remain separate work. Migration 160 binds material lot/serial stock to physical bins and reservations, resolves factory/sector/material FIFO/FEFO/LOT/SERIAL policy, excludes invalid or held identities at reservation and issue time, and records idempotent partial issues without changing genealogy edges. Recording defect/rework links never posts stock; inventory balances remain owned by the existing inventory ledger and order reservation transactions. The WMS allocation regression is in `services/api/test/inventory-wms-allocation.sql`; live concurrent-reservation and first-production-order evidence still depends on passing the full PostgreSQL CI run.

## Verification

Migration: `074_lot_serial_product_genealogy.sql`. PostgreSQL regression: `services/api/test/traceability.sql`, plus accepted-GRN lot registration coverage in `services/api/test/goods-receipt.sql`. API input regression: `services/api/src/inventory/traceability.service.spec.ts`.
