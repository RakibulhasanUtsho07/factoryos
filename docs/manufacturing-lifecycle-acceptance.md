# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL — the combined PR branch now carries persisted quality/rework/WMS acceptance plus a separate zero-finished-stock make-to-order/GRN-genealogy acceptance. The exact current-head API and PostgreSQL CI must pass before these software scenarios are accepted; live provider and factory/site sign-off remain external release gates.**

## Required lifecycle

Task 14 requires one consistent path across persistence and service boundaries:

`sales order → PO/GRN → supplier-linked material lot → approved product revision/BOM/routing → work order → material reservation/consumption → operation events → good/scrap output → inspection/hold/disposition/rework → finished stock/genealogy → put-away/pick → carton/pallet → shipment/POD → recall`.

Quantities use four-decimal fixed point. Identical idempotency-key replays must not post duplicate movements; changed-payload replay must fail closed; failed writes must roll back inventory, quality, genealogy, audit and outbox rows together.

## Persisted PostgreSQL acceptance fixtures

### Full quality and WMS journey

`services/api/src/inventory/inventory.location.postgres.integration.spec.ts` drives a shared persisted GRN → work-order output → genealogy → quality → WMS journey using the same tenant/factory and inventory/traceability identities.

- The output lot is inspected, defected, held and quarantined; a recorded REWORK disposition consumes 3.0000 source units and records exactly 2.0000 recovered plus 1.0000 scrap.
- A separate recovered lot requires follow-up inspection PASS and independent verification. Replaying the verification key must not post a duplicate movement.
- The original quarantined lot stays held. Only the accepted recovered lot proceeds through put-away/pick, carton/pallet packing, order-bound shipment, delivery/POD evidence and recall.
- The test injects a database failure during rework verification/output posting and compares the rework state/version, quality-event, audit/outbox counts and stock balance before retrying.
- Item-level quality holds block all lots for an item; a traceability-unit hold blocks that unit only, so a separate accepted recovered lot with the same SKU can proceed while the original lot remains quarantined.

### Zero-finished-stock make-to-order boundary

`services/api/src/production/manufacturing-grn-work-order-output.integration.spec.ts` exercises the complementary make-to-order path:

- PO approval and posted GRN create a supplier- and GRN-line-linked source material lot.
- A work order can be planned against a draft sales-order line.
- The production-managed sales line must not reserve nonexistent finished-good stock at order confirmation; the work order instead reserves its BOM material.
- The same received material lot flows into consumption, operation/output posting and material-to-output genealogy, with replay and final-balance assertions.

Migration `207_production_order_finished_good_reservation_boundary.sql` enforces the make-to-order reservation boundary in the database. Migration `208_wms_traceability_scoped_quality_holds.sql` supersedes the earlier location-transfer guard behaviour; migration `209_wms_scoped_quality_hold_guards.sql` applies the same lot-scoped policy to genealogy-source allocation and carton-packing database guards. Thus a lot-targeted hold does not block an independently accepted sibling lot, while a hold without a traceability identity remains item-wide. Migrations 207–209 are listed in the audited manifest and re-applied in PostgreSQL CI to test idempotency.

These are complementary persisted fixtures, not one single fixture containing every assertion above. Keep that limitation explicit; do not infer complete lifecycle acceptance merely because each slice passes independently.

## PostgreSQL domain contract checks

The existing SQL fixtures continue to cover:
- `purchase-order-lifecycle.sql` and `goods-receipt.sql`: PO approval, partial/rejected GRN, receipt quantity, over-receipt and duplicate-key rejection, audit/outbox evidence.
- `uom-conversion.sql`: dimensional conversion, approval separation and precision enforcement.
- `product-bom-routing-contract.sql` and `product-change-order-contract.sql`: approved revisions, BOM/routing snapshots and effective-date rules.
- `production-work-order-contract.sql`: tenant isolation, operation state guards, WIP evidence and deferred output posting.
- `traceability.sql`: lot/serial identity, forward/reverse genealogy, duplicate/cycle/over-consumption rejection and recall evidence.
- `quality-management-contract.sql`: inspection criteria, holds, disposition, rework controls and tenant isolation.
- `manufacturing-lifecycle-acceptance.sql`: migration ordering, required relations, RLS, scoped foreign keys, four-decimal quantity columns, idempotency uniqueness and lifecycle triggers.

## Remaining acceptance boundary

Overall factory lifecycle remains **PARTIAL** until:
1. The current exact-head API CI, PostgreSQL integration CI, production dependency/security checks and SRS/HLD/Blueprint traceability check complete successfully.
2. The full combined branch is reviewed for overlap between PR #240's quality/WMS journey and PR #243's make-to-order guard, without duplicated or conflicting migrations. PR #244's order-to-genealogy fixture should remain separate unless it demonstrates distinct required coverage beyond these fixtures.
3. Provider-originated carrier sandbox callbacks/native signature/retry evidence, effective object-storage IAM, independent upload/read-back digest verification and authorized factory/site sign-off are recorded against the tested release SHA.
4. Physical barcode/QR/printer/mobile-offline/RFID hardware-in-the-loop acceptance is completed where required by the release scope.

The forecast/planning APIs must remain non-committing: planning must not create inventory reservations or purchase orders. A green CI suite proves the tested software persistence contract; it does not certify a real carrier account, production storage permissions, physical hardware or customer/factory acceptance.

## Useful evidence

- `services/api/src/inventory/inventory.location.postgres.integration.spec.ts`
- `services/api/src/production/manufacturing-grn-work-order-output.integration.spec.ts`
- `services/api/src/production/manufacturing-lifecycle.integration.spec.ts`
- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `.github/workflows/api-postgres-ci.yml`
- `scripts/audit/migration-manifest.txt`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, `098_quality_rework_execution_and_verification.sql`, `207_production_order_finished_good_reservation_boundary.sql`, `208_wms_traceability_scoped_quality_holds.sql`, and `209_wms_scoped_quality_hold_guards.sql`.
