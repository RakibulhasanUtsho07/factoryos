# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL overall.** The persisted acceptance scenario now exercises purchase-order approval, posted GRN, incoming quality hold/release, sales order, material reservation/consumption, work-order operation, output posting, and material-to-output genealogy in one shared PostgreSQL integration test. This is not yet a full factory-lifecycle PASS.

## Scope proven in the shared fixture

The fixture uses the same tenant/factory and drives the service APIs through this persisted path:

`supplier/PO approval → posted GRN and accepted receipt quantity → tracked raw-material lot → bin put-away → incoming inspection HOLD/RELEASE → approved product revision/BOM/routing → sales order → work order → material reservation and consumption → operation events → production output/inventory posting → output lot genealogy`.

The test verifies the incoming hold blocks work-order release until a RELEASE disposition is recorded. It also checks that a production-linked sales order cannot complete early, output replay returns the original report/posting, changed-payload replay is rejected, and final reported/posted quantities, stock balances, consumed quantity, and genealogy quantity reconcile at four-decimal precision.

## Explicit boundaries of this acceptance

The fixture posts a PO/GRN and creates a tracked raw-material lot in the same test journey, but it creates that traceability unit separately through `TraceabilityService.createUnit`; the unit is not explicitly registered with supplier, GRN header, and GRN-line provenance. Same item and quantity do not by themselves prove that provenance link.

The fixture also seeds the finished-good item with 4.0000 units before the order is confirmed. It therefore does not prove the zero-finished-stock make-to-order reservation boundary; that requires the production-order guard and zero-stock acceptance case.

Quality coverage in this scenario is limited to an incoming inspection HOLD followed by RELEASE disposition. It does not exercise finished-output inspection, defect/NCR, output-lot quarantine, REWORK, recovered output, SCRAP, or independent rework verification. It also does not put the finished output through WMS pick/pack, carton/pallet, shipment, carrier callback, POD object storage, or recall in this same fixture. Failure-injection rollback across the complete joined journey remains unproven.

## Remaining acceptance work

Keep overall factory lifecycle status **PARTIAL** until one shared persisted scenario:
1. Links the consumed material lot explicitly to its originating supplier, posted GRN, and GRN line, and proves make-to-order works without pre-existing finished-good stock.
2. Exercises output quality inspection, hold/quarantine, disposition, rework, recovered quantity, scrap, and independent verification using the same lot/genealogy identities.
3. Continues the accepted/recovered output through WMS pick/pack, carton/pallet, shipment, POD storage/digest verification, carrier delivery evidence, and recall.
4. Injects a controlled failure and proves related writes roll back; replays identical and changed-payload requests; and reconciles inventory, audit/outbox, quality state, and forward/reverse genealogy at the end.

The targeted order-to-genealogy slice may be reported separately from the full lifecycle. Use CI checks on the exact current PR head as acceptance evidence; a previously green commit does not certify a later head. Forecast/planning APIs must remain non-committing: they must not create reservations or purchase orders.

## Useful evidence

- `services/api/src/production/manufacturing-lifecycle.integration.spec.ts`
- `services/api/src/production/manufacturing-grn-work-order-output.integration.spec.ts`
- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `services/api/test/goods-receipt.sql`
- `services/api/test/production-work-order-contract.sql`
- `services/api/test/production-output-lot-genealogy.sql`
- `services/api/test/traceability.sql`
- `services/api/test/quality-management-contract.sql`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, and `098_quality_rework_execution_and_verification.sql`.
