# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL — one persisted GRN → make-to-order work-order → output/genealogy path is now covered; quality disposition/rework/scrap and downstream fulfilment still need one shared acceptance flow.**

## Scope

Task 14 requires the following one-lifecycle path to remain consistent across persistence and service boundaries:

`order → material reservation → purchase order/GRN → released work order → operation events → good/scrap output → inspection → hold/disposition/rework/scrap → finished stock and genealogy`.

Quantity must remain four-decimal fixed-point, a replay must not post a second movement, failed writes must roll back the related ledger records, and audit/outbox, stock balance, lot/serial genealogy and quality status must agree.

## PostgreSQL CI coverage

The `api-postgres` workflow runs the ordered migration manifest, domain SQL checks and the API PostgreSQL integration suite, including `services/api/test/manufacturing-lifecycle-acceptance.sql`. Existing domain fixtures cover:

- `purchase-order-lifecycle.sql` and `goods-receipt.sql`: PO approval, partial/rejected GRN, accepted-quantity stock movement, over-receipt and duplicate-key rejection, audit/outbox evidence.
- `uom-conversion.sql`: approved dimensional conversion, exact/reverse conversion, approval separation and precision enforcement.
- `product-bom-routing-contract.sql` and `product-change-order-contract.sql`: BOM/routing snapshots, approved product revision and effective-date guards.
- `production-work-order-contract.sql`: tenant isolation, work-order/operation state guards, WIP event evidence, output-to-final-operation links and deferred inventory-output posting.
- `manufacturing-grn-work-order-output.integration.spec.ts`: one shared persisted supplier PO/posted GRN/material lot is put away, reserved to a product BOM, consumed on work-order completion, and linked to one accepted finished-good output lot through immutable genealogy, then completes the work order and sales order against the full accepted output. The test also proves that a production-linked sales-order line does not reserve nonexistent finished-good stock at confirmation and that an identical output retry does not post a second report.
- `traceability.sql`: lot/serial identities, forward/reverse genealogy, duplicate/cycle/over-consumption rejection and recall evidence.
- `quality-management-contract.sql`: quality target/event/hold/disposition/rework controls, inspection criteria, tenant isolation and cross-domain enforcement.

The acceptance SQL adds a single cross-slice contract gate for ordered migration markers, required relations, forced tenant RLS, factory-scoped foreign-key links, NUMERIC(18,4) quantity columns, idempotency uniqueness, and enabled lifecycle triggers including commit-deferred GRN, UoM, output, genealogy, quality and rework evidence. A deterministic BOM/yield/wastage arithmetic oracle guards the shared four-decimal rules.

## Acceptance boundary

The new common fixture now exercises one persisted path using the same business identifiers: approved supplier PO/posted GRN → supplier material lot → product revision/BOM/routing → draft sales order → work order planned before confirmation → order confirmation/in-progress → BOM material reservation and issue → accepted output receipt/finished-good lot → material-to-output genealogy → work-order completion. It asserts exact balances (1 unit raw material left, 4 finished-good units posted), 4 units consumed and represented in genealogy, no finished-good order reservation, and idempotent output replay.

The task remains **PARTIAL** because this common fixture does not yet include quality inspection/hold/disposition/rework/scrap, carton/pallet/shipment, proof of delivery, customer recall, or real factory/hardware acceptance in the same persisted journey. Those boundaries must not be inferred from the subset that passes. Forecast/planning APIs must remain non-committing: they must not create reservations or purchase orders.

## Useful evidence

- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `.github/workflows/api-postgres-ci.yml`
- `services/api/test/goods-receipt.sql`
- `services/api/test/uom-conversion.sql`
- `services/api/test/production-work-order-contract.sql`
- `services/api/test/traceability.sql`
- `services/api/test/quality-management-contract.sql`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `075_uom_conversion_controls.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, and `098_quality_rework_execution_and_verification.sql`.
