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

## Scope boundary

The repository currently has no first-class shipment/dispatch, customer or quality-management aggregates. Shipment identities and evidence can carry external references, but native customer fulfilment, quality-record/certificate modules, physical QR/barcode image generation, RFID, mobile offline synchronization and lot-aware stock/reservation decrements are separate work. Recording genealogy does not post stock; inventory balances remain owned by the existing inventory ledger and order reservation transactions.

## Verification

Migration: `074_lot_serial_product_genealogy.sql`. PostgreSQL regression: `services/api/test/traceability.sql`, plus accepted-GRN lot registration coverage in `services/api/test/goods-receipt.sql`. API input regression: `services/api/src/inventory/traceability.service.spec.ts`.
