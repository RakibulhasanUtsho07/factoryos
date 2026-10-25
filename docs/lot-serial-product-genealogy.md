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

The production-report-to-output-lot slice deliberately does not backfill historical output quantities into current physical bins. Migration 201 separately closes a bounded carton/pallet packing and customer-dispatch backend slice; RFID/offline synchronization, recall-owner acceptance and a live plant end-to-end rehearsal remain open.


## Carton/pallet packing and customer dispatch (migration 201)

- `POST /api/v1/traceability/containers` creates a carton or pallet identity bound to an active item, a pick-enabled BIN/STAGING location and declared capacity.
- `POST /api/v1/traceability/containers/:containerUnitId/contents` records finished-good lot quantities into cartons or whole sealed cartons into pallets. The immutable `PACKED_INTO` genealogy edge, content row and capacity counter commit together; a carton cannot be nested into more than one pallet.
- `POST /api/v1/traceability/containers/:containerUnitId/seal` seals a non-empty container with an idempotent seal record. Sealed containers cannot accept further contents.
- `GET /api/v1/traceability/shipments?search=...` lists shipments in the authenticated factory and can filter by shipment code, customer name, customer-order reference or carrier tracking reference, so the dispatch is queryable without guessing an identity UUID.
- `POST /api/v1/traceability/containers/:containerUnitId/dispatch` dispatches one sealed carton/pallet to an identified customer and external customer-order reference. The transaction expands package genealogy to finished-good lot leaves, checks item/UOM/location, expiry, quality holds and unreserved stock, issues aggregate and lot-location stock, inserts immutable inventory ISSUE evidence, creates the shipment identity and `SHIPPED_AS` edge, updates shipped statuses, and commits audit/outbox evidence.
- Migration 201 adds tenant RLS, append-only packing/shipment records, database guards for source/container type and capacity, exact packed-quantity reconciliation, shipment-to-inventory-movement binding, and deferred shipment genealogy/status/audit/outbox evidence. Active carton contents also become stock commitments: deferred guards on aggregate, bin and lot balances stop later reservations, transfers or issues from consuming committed packed quantity. Shipment atomically releases the commitment when it marks the package dispatched and posts the stock issue. PostgreSQL CI replays the migration/SQL contract twice and exercises carton → pallet → customer dispatch, idempotent dispatch, and rejected stock depletion beneath an active packing commitment.

**Boundary:** this slice supports one sealed carton or pallet per shipment record and stores the external customer order reference supplied by the caller. It does not claim an internal ERP sales-order/customer-master integration, electronic proof-of-delivery, carrier API integration, barcode/QR rendering, RFID/offline mobile sync or physical plant acceptance.

## Internal customer-order binding and delivery evidence (migration 202)

- `POST /api/v1/traceability/containers/:containerUnitId/dispatch` optionally accepts both `order_id` and `order_line_id`. If either is supplied without the other, dispatch is rejected. The order must belong to the same tenant/factory and be in a dispatchable status; customer name and order reference must match the order, and the order line's SKU/UOM must match the finished-good item.
- Partial shipments are permitted, but shipped quantities for the bound order line are serialized and summed; the dispatch is rejected if it would exceed the line quantity. Migration 202 enforces this again inside PostgreSQL, in addition to API validation. Existing external references remain supported for backward compatibility, so unbound shipments must not be reported as ERP-validated orders.
- Carrier metadata is optional for legacy/external dispatches, but `carrier_name` and `tracking_reference` must be supplied together. Migration 204 enforces that invariant and prevents duplicate tracking bindings within a tenant/factory using case-normalized carrier and tracking identity. Signed carrier webhook lookup uses the same normalization, so a callback cannot ambiguously select between case-differing duplicates.
- `POST /api/v1/traceability/shipments/:shipmentUnitId/delivery-events` appends idempotent delivery lifecycle events (`IN_TRANSIT`, `OUT_FOR_DELIVERY`, `DELIVERY_FAILED`, `DELIVERED`, `RETURNED`). Invalid transitions and post-delivery/post-return events are rejected. `DELIVERED` requires a recipient, proof type, relative object-storage key, SHA-256 digest and signed timestamp. Events are append-only, forced-RLS scoped and committed with audit/outbox evidence; the list endpoint exposes the delivery timeline and latest event on the shipment search response.
- Delivery-event idempotency fingerprints the normalized caller payload: if `event_at` is omitted, the server assigns the timestamp on first insert, but an identical retry replays that original event and timestamp. A changed payload under the same key conflicts; server-generated clock values do not turn a matching retry into a different request.
- PostgreSQL acceptance is `services/api/test/wms-shipment-delivery-order.sql`; the full integration test covers order/SKU/UOM/customer binding, over-shipment rejection without stock loss, delivery-event idempotency, mandatory POD metadata, terminal-state rejection, and tenant isolation. CI applies and re-applies migration 202 and its structural contract.

**Boundary:** this is internal order-line binding and a POD metadata evidence ledger, not a carrier integration or verified file-storage integration. The caller supplies the proof object key and digest; the API does not upload or fetch the proof file, independently recalculate the digest, or authenticate carrier webhooks. A provider-specific carrier adapter, signature/key management and replay acceptance, configured object storage, physical scanner/printer rendering, RFID/offline shipping scan integration and live plant acceptance remain open and require provider/device/site evidence.

## Scope boundary

The repository now has first-class quality inspections, immutable defect-to-lot/serial/order/work-order/operation/production-report/GRN links, verified CAPA actions and controlled rework tasks. A rework output is recorded as a new traceability identity tied to the originating defect; existing genealogy edges are not fabricated through a quarantined source. ERP sales-order integration, proof-of-delivery, QR/barcode rendering and RFID/offline mobile sync remain separate work. The bounded carton/pallet-to-shipment backend flow is described above. Migration 160 binds material lot/serial stock to physical bins and reservations, resolves factory/sector/material FIFO/FEFO/LOT/SERIAL policy, excludes invalid or held identities at reservation and issue time, and records idempotent partial issues without changing genealogy edges. Recording defect/rework links never posts stock; inventory balances remain owned by the existing inventory ledger and order reservation transactions. The WMS allocation regression is in `services/api/test/inventory-wms-allocation.sql`; live concurrent-reservation and first-production-order evidence still depends on passing the full PostgreSQL CI run.

## Verification

Migration: `074_lot_serial_product_genealogy.sql`. PostgreSQL regression: `services/api/test/traceability.sql`, plus accepted-GRN lot registration coverage in `services/api/test/goods-receipt.sql`. API input regression: `services/api/src/inventory/traceability.service.spec.ts`.
