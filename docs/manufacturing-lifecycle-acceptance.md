# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL — a shared persisted order-to-genealogy integration scenario has been added, but it is not accepted until PostgreSQL CI passes; purchase receipt and quality disposition/rework are not yet in that same journey.**

## Scope

The targeted acceptance path connects these records through the real API services and the same tenant/factory fixture:

`sales order → approved product revision/BOM/routing → work order → material reservation and lot consumption → operation events → production output/inventory posting → output lot genealogy`.

The scenario uses one order line, work order, reserved material lot, output report/posting and correlated genealogy evidence. It also checks that a production-linked sales order cannot be completed early, the same output idempotency key replays the original report/posting, and reusing that key with changed output quantities is rejected.

Quantities remain four-decimal fixed-point. The final database assertions compare reservation consumption, reported versus posted good output, raw/finished stock balances and the material-to-output genealogy edge quantity.

## Added integration coverage

- `services/api/src/production/manufacturing-lifecycle.integration.spec.ts`: shared PostgreSQL fixture driving product/version, BOM/routing, sales order, work order, operation, output and genealogy APIs; verifies persisted final state and output idempotency.
- `services/api/test/manufacturing-lifecycle-acceptance.sql`: schema/trigger/RLS/migration contract gate remains as a separate prerequisite; it is not considered proof of a persisted end-to-end journey by itself.
- `.github/workflows/api-postgres-ci.yml`: the API Jest suite runs with the PostgreSQL integration environment, so the new `src/**/*.spec.ts` file is included in CI discovery.

## Remaining acceptance boundary

Keep the lifecycle status **PARTIAL** until the new integration test has passed against the CI PostgreSQL database and its exact commit SHA has a green required check.

The new scenario intentionally covers the requested order/reservation/consumption/operations/output/genealogy slice; it does not yet stitch the purchase-order/GRN stock-receipt path or quality inspection, hold, disposition, rework and scrap into the same persisted journey. Those are still separately tested domain paths, and their presence in separate fixtures is not evidence that the complete factory lifecycle is end-to-end accepted.

Full lifecycle acceptance still requires one shared fixture that links purchase order and posted GRN stock to the consumed material lot, then exercises the required quality path, failure rollback, final inventory/genealogy reconciliation and replay safety. Forecast/planning APIs must remain non-committing: they must not create reservations or purchase orders.

## Useful evidence

- `services/api/src/production/manufacturing-lifecycle.integration.spec.ts`
- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `services/api/test/goods-receipt.sql`
- `services/api/test/uom-conversion.sql`
- `services/api/test/production-work-order-contract.sql`
- `services/api/test/production-output-lot-genealogy.sql`
- `services/api/test/traceability.sql`
- `services/api/test/quality-management-contract.sql`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `075_uom_conversion_controls.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, and `098_quality_rework_execution_and_verification.sql`.
