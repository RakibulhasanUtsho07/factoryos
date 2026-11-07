# WP02 production material-consumption reference-rate reconciliation

**SRS traceability:** FR-FIN-08 (partial evidence); WP02 Core Domain Kernel.  
**Design boundary:** this slice reconciles a production material-consumption quantity/rate against its directly linked procurement source. It does not calculate or post full manufacturing actual cost, inventory valuation, WIP capitalization or finished-goods valuation.

## Canonical source reference

For `WORK_ORDER_MATERIAL_CONSUMPTION`, `expected_source_ref` is the UUID of exactly one row in `inventory_reservation_consumption_traceability_allocations`. The resolver follows this immutable chain:

`consumption traceability allocation → reservation consumption → work-order material reservation → consumed MATERIAL LOT/SERIAL → posted GRN line → approved PO line → approved purchase order`.

It returns:
- the exact allocated consumption quantity (not the full original receipt quantity);
- the PO line's unit price as the procurement reference rate;
- the PO line UOM, after verifying it matches the consumed traceability identity UOM; and
- the PO currency.

Every join is constrained to the same tenant and factory. The source must be a work-order material reservation, a MATERIAL LOT or SERIAL, a directly linked GRN line, a POSTED receipt with a posting timestamp, an APPROVED purchase order and a non-null PO unit price. Exactly one complete source row must resolve.

## Fail-closed conditions and rate semantics

A missing GRN link, unapproved PO, unposted receipt, missing price, UOM mismatch, cross-factory reference, unknown allocation ID or ambiguous source returns no evidence and rejects the reconciliation. The resolver does not substitute a should-cost estimate, inventory average, a different lot's rate or an inferred FX rate.

The returned rate is **PO unit price**, not supplier-invoiced landed cost. It excludes any unlinked invoice price variance, freight, duty, tax, overhead, labour, energy and other conversion costs. This slice does not back-propagate a cost to transformed or merged identities whose own traceability unit has no direct GRN line; those require an independently governed quantity-weighted provenance/cost-allocation contract first.

The existing finance ingestion boundary still owns external accounting facts. FactoryOS only validates source quantity/rate/UOM/currency evidence; it does not create journal entries, revalue inventory, capitalize WIP, or decide the accounting policy for scrap or finished goods.

## Automated verification

`services/api/src/finance/finance-operational-source.spec.ts` verifies:
- the allocation-ID reference is parameterized with tenant and factory scope;
- the resolver follows all WMS → GRN → PO joins and requires the direct provenance/status/UOM predicates;
- quantity, unit price, UOM and currency are returned from the canonical rows; and
- missing and ambiguous provenance fails closed.

The API CI runs the resolver unit contract; the PostgreSQL CI continues to verify the underlying reservation-consumption, traceability, GRN and PO ledgers. These checks establish repository-level technical behavior only, not a finance owner's approval or an external accounting reconciliation.

## Remaining acceptance gates

FR-FIN-02/03/08 and WP02 remain PARTIAL. Actual-cost and finished-good valuation still need governed source rates for transformed/merged lots, supplier invoice and landed-cost allocation, explicit FX policy, labour and energy actuals, freight/duty/overhead, scrap/yield cost treatment, WIP-to-finished-goods roll-up, external GL reconciliation and independent finance-owner sign-off. No missing amount is inferred by this implementation.
