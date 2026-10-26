# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL — a shared PostgreSQL WMS acceptance journey now covers GRN-to-work-order output through put-away, shipment/POD, recall and reverse material genealogy; wider quality/rollback acceptance and external provider/site sign-off remain open.**

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

## Acceptance boundary

The SQL domain checks use independent fixtures. A separate shared PostgreSQL integration journey now uses persisted PO/GRN/material-lot IDs, approved product revision/BOM/routing, work-order material reservation/consumption, output posting, forward/reverse genealogy, directed put-away and pick-to-staging, carton-in-pallet packing, order-bound pallet shipment, delivery/POD and recall. It does not yet exercise quality inspection/hold/disposition/rework/scrap in that same persisted journey, nor provider-originated carrier callbacks or deployed storage IAM policy.

Therefore, the task remains **PARTIAL** until the shared scenario also includes replay-without-duplicate-stock assertions, injected-failure rollback, quality disposition/rework/scrap and final stock reconciliation. The forecast/planning APIs must remain non-committing: they must not create reservations or purchase orders. The separate live carrier/storage runbook and authorized factory sign-off also remain mandatory external release gates.

## Useful evidence

- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `.github/workflows/api-postgres-ci.yml`
- `services/api/test/goods-receipt.sql`
- `services/api/test/uom-conversion.sql`
- `services/api/test/production-work-order-contract.sql`
- `services/api/test/traceability.sql`
- `services/api/test/quality-management-contract.sql`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `075_uom_conversion_controls.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, and `098_quality_rework_execution_and_verification.sql`.
