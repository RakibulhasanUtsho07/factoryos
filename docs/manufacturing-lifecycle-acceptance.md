# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL — database contract gate is wired; one shared data fixture covering the full lifecycle is still required for end-to-end acceptance.**

## Scope

Task 14 requires the following one-lifecycle path to remain consistent across persistence and service boundaries:

`order → material reservation → purchase order/GRN → released work order → operation events → good/scrap output → inspection → hold/disposition/rework/scrap → finished stock and genealogy`.

Quantity must remain four-decimal fixed-point, a replay must not post a second movement, failed writes must roll back the related ledger records, and audit/outbox, stock balance, lot/serial genealogy and quality status must agree.

## PostgreSQL CI coverage

The `api-postgres` workflow runs the domain SQL checks and then `services/api/test/manufacturing-lifecycle-acceptance.sql`. Existing domain fixtures cover:

- `purchase-order-lifecycle.sql` and `goods-receipt.sql`: PO approval, partial/rejected GRN, accepted-quantity stock movement, over-receipt and duplicate-key rejection, audit/outbox evidence.
- `uom-conversion.sql`: approved dimensional conversion, exact/reverse conversion, approval separation and precision enforcement.
- `product-bom-routing-contract.sql` and `product-change-order-contract.sql`: BOM/routing snapshots, approved product revision and effective-date guards.
- `production-work-order-contract.sql`: tenant isolation, work-order/operation state guards, WIP event evidence, output-to-final-operation links and deferred inventory-output posting.
- `traceability.sql`: lot/serial identities, forward/reverse genealogy, duplicate/cycle/over-consumption rejection and recall evidence.
- `quality-management-contract.sql`: quality target/event/hold/disposition/rework controls, inspection criteria, tenant isolation and cross-domain enforcement.

The acceptance SQL adds a single cross-slice contract gate for ordered migration markers, required relations, forced tenant RLS, factory-scoped foreign-key links, NUMERIC(18,4) quantity columns, idempotency uniqueness, and enabled lifecycle triggers including commit-deferred GRN, UoM, output, genealogy, quality and rework evidence. A deterministic BOM/yield/wastage arithmetic oracle guards the shared four-decimal rules.

## Shared GRN → quality hold → rework fixture

`services/api/test/quality-rework-inventory.sql` now creates a real, persisted supplier purchase order and moves it through DRAFT → SUBMITTED → APPROVED, receives the source material through a POSTED goods receipt, posts the accepted quantity to the inventory ledger, and registers the exact accepted lot with supplier, GRN header and GRN-line provenance. The fixture then uses those same receipt and line IDs for the source quality hold, a recorded REWORK disposition, and both the verified-rework and cancellation rework orders.

The same transaction checks that the PO is approved, the GRN is posted, received/rejected quantity reconciles, the receipt movement is linked to the GRN, the lot preserves the supplier/receipt/line identity, the rework tasks keep the same source receipt references, and GRN audit/outbox evidence exists. The physical quantity path still verifies 5.0000 received, 2.0000 issued for rework, 1.5000 recovered and accepted only after independent follow-up PASS, and 0.5000 recorded as rework scrap, plus a separate cancellation issue/restore that returns the full input to stock. The script runs in PostgreSQL CI and rolls back its fixture.

## Acceptance boundary

This is meaningful shared-fixture progress, but the manufacturing lifecycle is **still PARTIAL**, not FULL PASS. The new fixture connects the supplier/PO/GRN/source-lot lineage to quality hold, disposition, rework and recovered-stock accounting; it does not yet create one common sales order, material reservation/consumption, released work order, routed operation sequence, good/scrap output posting, output genealogy edges and final shipment/recall flow with the same persisted identifiers.

Those connected production/output steps remain split across existing regression files. Close the remaining gap by extending the shared fixture through the order, reservation, work-order routing and output-posting path; replay the GRN/reservation/output requests and assert no duplicate movement; inject a failed write and prove all associated ledger/audit/outbox rows roll back; and reconcile the final lot/serial genealogy and stock balances after the hold/rework/scrap path. Forecast/planning APIs must remain non-committing: they must not create reservations or purchase orders.

## Useful evidence

- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `.github/workflows/api-postgres-ci.yml`
- `services/api/test/goods-receipt.sql`
- `services/api/test/uom-conversion.sql`
- `services/api/test/production-work-order-contract.sql`
- `services/api/test/traceability.sql`
- `services/api/test/quality-management-contract.sql`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `075_uom_conversion_controls.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, and `098_quality_rework_execution_and_verification.sql`.
