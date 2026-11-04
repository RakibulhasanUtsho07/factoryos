# Manufacturing lifecycle cross-slice acceptance

**Status: PARTIAL — the consolidated PostgreSQL journey now exercises concurrent PO/GRN/work-order/release/output retries and an approved KG→G BOM snapshot across supplier receipt, production consumption/output, quality rework/scrap and recovered-lot WMS shipment/POD/recall. Exact-head CI and release evidence remain required.**

## Required lifecycle

Task 14 requires one consistent path across persistence and service boundaries:

`draft sales order → PO/GRN → supplier-linked material lot → approved product revision/BOM/routing → work-order planning → order confirmation without finished-stock reservation → BOM material reservation/consumption → operation events/output → genealogy → quality hold/disposition/rework/scrap → recovered-lot acceptance → put-away/pick → carton/pallet → shipment/POD → recall`.

Quantities use four-decimal fixed point. Identical idempotency-key replays must not post duplicate movements; changed-payload replay must fail closed; failed writes must roll back inventory, quality, genealogy, audit and outbox rows together.

The consolidated fixture includes deterministic concurrent duplicate-delivery checks at PO create, GRN post, work-order create, work-order release and production output. Each pair uses the same idempotency key and canonical request from parallel calls; the test asserts one first execution, one replay and one persisted business effect. The GRN assertion reads back one receipt, one stock movement and exactly `3000.0000 G` accepted.

The same fixture creates factory-scoped KG and G units, submits and independently approves the exact `1000/1` conversion, receives base-unit G stock, and writes the product BOM as `1 KG` per finished unit. The immutable BOM snapshot retains the approved conversion rule ID/version/factor and resolves to `1000.0000 G`; a three-unit work order therefore reserves and consumes exactly `3000.0000 G`, with that quantity/unit carried through the material lot and consumption genealogy. Finished output remains `3.0000 PCS`. This is an explicit cross-module UoM boundary test, not merely a standalone conversion check.

## Independent order confirmation under shared-stock contention

Authoritative PostgreSQL test: `services/api/src/orders/order-lifecycle.service.integration.spec.ts`, test `serializes independent order confirmations competing for the same shared stock`.

The scenario creates one factory-scoped inventory item with `5.0000 PCS` on hand and two distinct draft sales orders, each demanding `4.0000 PCS` of that same item across two lines (`0.7500` and `3.2500 PCS`). The fixture assigns the lower UUID to the smaller line because the service processes lines by item ID and line UUID; this guarantees the losing order first acquires a partial `0.7500 PCS` reservation before its `3.2500 PCS` line encounters insufficient stock. Their confirmations run concurrently in separate service transactions with distinct trace IDs. Exactly one order must commit as `CONFIRMED`; the other must receive the insufficient-stock conflict and remain `DRAFT` at its original version. Read-back requires exactly the winner's two order-line reservations (`0.7500` and `3.2500 PCS`), aggregate on-hand/reserved values of `5.0000/4.0000 PCS`, only the winner's `INVENTORY.STOCK_RESERVED` outbox events, and exactly one `ORDER.CONFIRMED` outbox event. Both partial reservation and event writes from the losing order must roll back.

This is deliberately different from duplicate-request replay: it validates two independent business transactions contending for the same authoritative stock, including rollback of the losing order transition. It proves the repository PostgreSQL transaction/locking contract covered by CI; it does not certify production lock-wait capacity, peak concurrency or a live factory topology.

## Consolidated persisted PostgreSQL acceptance

Authoritative integration path: `services/api/src/inventory/inventory.location.postgres.integration.spec.ts`, test `runs GRN-to-work-order output through put-away, shipment POD, recall and reverse genealogy`.

The scenario uses one tenant/factory and connected persisted identities:

1. **GRN provenance and incoming quality:** supplier and approved PO → posted GRN → traceability lot tied to the exact supplier, GRN header, GRN line and accepted quantity. A supplier inspection HOLD is persisted against the received line, and work-order release is asserted to fail while that hold is active. A recorded RELEASE disposition removes the hold before the same work order can be released.
2. **Make-to-order guard:** a draft sales order line is created with zero finished-good stock. The work order is planned before confirmation. Order confirmation is asserted to leave finished-good on-hand/reserved quantities at `0.0000` and create zero `ORDER_LINE` reservations. The work-order BOM reservation is the material allocation boundary.
3. **Production and genealogy:** the exact GRN-linked material lot is consumed once by the released work order; operation events, output posting and the material-to-output genealogy connect to the same sales order/work order. The cross-UoM assertion proves the BOM's `1 KG → 1000 G` snapshot drives a `3000.0000 G` requirement and consumption for three finished units.
   Concurrent identical output calls with one key return one first execution and one replay; changed-payload reuse is rejected and a persisted query confirms exactly one production report and one output posting remain for the work order.
4. **Quality/rework:** the output lot is inspected, defected, held and quarantined; REWORK consumes `3.0000` source units and records exactly `2.0000` recovered plus `1.0000` scrap. The recovered lot is separately identified, requires follow-up inspection PASS and an independent verifier. Verification replay does not create a duplicate movement. A persisted `REWORKED_INTO` genealogy edge connects the quarantined source lot to the recovered lot only after verified rework and passed follow-up inspection; its audit/outbox evidence is asserted, and premature edges are rejected.
5. **WMS shipment:** only the separately accepted recovered lot proceeds through put-away/pick, carton/pallet packing, order-line-bound shipment, delivery/POD and recall. Shipment persistence must reference the same sales `order_id` and `order_line_id` created for the make-to-order flow; the quarantined source identity is never packed or shipped.
6. **Failure and isolation:** injected failure during rework verification/output posting compares rework state/version, quality-event, audit/outbox counts and stock balances to prove rollback. Cross-tenant reads fail closed.

The previous standalone make-to-order acceptance spec, `services/api/src/production/manufacturing-grn-work-order-output.integration.spec.ts`, duplicates core order-confirmation, GRN consumption, output and genealogy assertions and is removed from this consolidated PR branch so the combined persisted scenario is the single authoritative acceptance path for those behaviours. Migration 207 remains included; migrations 207–212 are listed in `scripts/audit/migration-manifest.txt` and reapplied in PostgreSQL CI for idempotency. Migration 212 requires a verified, quantity/item/UOM-matched `REWORKED_INTO` edge before the recovered lot becomes downstream recall-traceable. Migration 210 keeps the aggregate inventory issue guard fail-closed while validating `WMS_SHIPMENT` against its `SHIPPED_AS` edge and recursively resolved carton/pallet leaf identities, so a held source lot cannot be bypassed while an unrelated quarantined sibling lot does not block accepted recovered stock.

## Other PostgreSQL domain contract checks

The existing SQL fixtures continue to cover:
- `purchase-order-lifecycle.sql` and `goods-receipt.sql`: PO approval, partial/rejected GRN, receipt quantity, over-receipt and duplicate-key rejection, audit/outbox evidence.
- `uom-conversion.sql`: dimensional conversion, approval separation and precision enforcement.
- `product-bom-routing-contract.sql` and `product-change-order-contract.sql`: approved revisions, BOM/routing snapshots and effective-date rules.
- `production-work-order-contract.sql`: tenant isolation, operation state guards, WIP evidence and deferred output posting.
- `traceability.sql`: lot/serial identity, forward/reverse genealogy, duplicate/cycle/over-consumption rejection and recall evidence.
- `quality-management-contract.sql`: inspection criteria, holds, disposition, rework controls and tenant isolation.
- `manufacturing-lifecycle-acceptance.sql`: migration ordering, required relations, RLS, scoped foreign keys, four-decimal quantity columns, idempotency uniqueness and lifecycle triggers.

## Reconciliation of PR #240, #243 and #244

- **PR #240** is the consolidation branch for the persisted rework/WMS journey and the zero-stock make-to-order guard. Review its current combined diff and exact-head checks as the source of truth for this merged acceptance path.
- **PR #243** provides the narrower make-to-order/GRN-to-genealogy slice. Do not merge its duplicate test or re-apply migration 207 independently after the combined path is accepted. Close/supersede it only after verifying its guard implementation and test expectations are present in the consolidation branch.
- **PR #244** overlaps with the order-to-genealogy journey and its unique incoming-material inspection HOLD/RELEASE behaviour is now represented in the consolidated fixture. Review the remaining diff for any other unique acceptance requirement; do not merge its whole duplicate manufacturing journey solely for the duplicate flow.

## Independent GRN-to-rework SQL fixture

`services/api/test/quality-rework-inventory.sql` now creates a real, persisted supplier purchase order and moves it through DRAFT → SUBMITTED → APPROVED, receives the source material through a POSTED goods receipt, posts the accepted quantity to the inventory ledger, and registers the exact accepted lot with supplier, GRN header and GRN-line provenance. The fixture then uses those same receipt and line IDs for the source quality hold, a recorded REWORK disposition, and both the verified-rework and cancellation rework orders.

The same transaction checks that the PO is approved, the GRN is posted, received/rejected quantity reconciles, the receipt movement is linked to the GRN, the lot preserves the supplier/receipt/line identity, the rework tasks keep the same source receipt references, and GRN audit/outbox evidence exists. The physical quantity path still verifies 5.0000 received, 2.0000 issued for rework, 1.5000 recovered and accepted only after independent follow-up PASS, and 0.5000 recorded as rework scrap, plus a separate cancellation issue/restore that returns the full input to stock. The script runs in PostgreSQL CI and rolls back its fixture.

## Remaining acceptance boundary

Overall factory lifecycle remains **PARTIAL** until:

1. API CI, full PostgreSQL integration CI, production dependency/security checks and SRS/HLD/Blueprint traceability pass on the exact current PR head; rerun after every source change.
2. Independent review confirms no duplicate/conflicting migrations and the cross-UoM conversion snapshot, concurrent replay, incoming-quality HOLD/RELEASE and rollback assertions pass in the consolidated fixture.
3. Repeat independent-order contention in the approved staging topology under representative connection-pool/load conditions; PostgreSQL CI now proves the distinct-order transaction/rollback contract, not production lock-wait, timeout or site-capacity acceptance.
4. Lot-and-serial identities are exercised together across receipt, reservations, multi-operation WIP, output, quality and forward/reverse genealogy, including partial consumption, split/merge and mixed-unit conversions at the factory's configured precision.
5. Actual-cost capture, material/labour/overhead allocation, WIP/finished-goods valuation and downstream accounting/stock valuation reconciliation are integrated with production and signed off by the finance owner. The existing finance workbench is not proof of manufacturing actual-cost posting.
6. The complete maker-checker cycle-count journey (blind count, independent approval, stale-balance rejection, recount/escalation and reconciliation) is accepted on physical mobile clients with offline queue, cross-device replay and real ledger reconciliation.
7. Provider-originated carrier sandbox callbacks/native signature/retry evidence, effective object-storage IAM, independent upload/read-back digest verification and authorized factory/site sign-off are recorded against the tested release SHA.
8. Physical barcode/QR/GS1 DataMatrix and GS1-128 printer/scanner, mobile-offline and RFID hardware-in-the-loop acceptance is completed where required. [Issue #283](https://github.com/RakibulhasanUtsho07/factoryos/issues/283) remains open until target-device evidence and site-owner approval are attached.
9. Branch promotion `rakibul-hasan → dev → main` is reviewed with exact-head CI and post-merge commit verification.

The forecast/planning APIs must remain non-committing: planning must not create inventory reservations or purchase orders. A green CI suite proves only the tested software persistence contract; it does not certify real carrier/storage accounts, physical hardware or factory acceptance.

## Useful evidence

- `services/api/src/inventory/inventory.location.postgres.integration.spec.ts` (including tenant cleanup of `order_idempotency_keys` so failed assertions do not leave the test tenant undeletable)
- `services/api/test/manufacturing-lifecycle-acceptance.sql`
- `.github/workflows/api-postgres-ci.yml`
- `scripts/audit/migration-manifest.txt`
- `migrations/067_supplier_purchase_order_lifecycle.sql`, `072_goods_receipt_grn.sql`, `074_lot_serial_product_genealogy.sql`, `082_product_bom_routing_version_contracts.sql`, `090_production_work_order_operation_lifecycle.sql`, `091_production_output_inventory_posting.sql`, `093_quality_inspection_ncr_holds_disposition.sql`, `098_quality_rework_execution_and_verification.sql`, `207_production_order_finished_good_reservation_boundary.sql`, `208_wms_traceability_scoped_quality_holds.sql`, `209_wms_scoped_quality_hold_guards.sql`, `210_quality_guard_wms_shipment_leaf_holds.sql`, `211_quality_guard_wms_shipment_hold_scope.sql`, and `212_quality_rework_genealogy_link_guard.sql`.

**Release rule:** do not mark the full lifecycle PASS until exact-head automation, review, actual-cost/valuation and cycle-count acceptance, applicable live-provider evidence, hardware acceptance and named site/process-owner sign-off are recorded.
