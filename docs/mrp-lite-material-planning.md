# MRP-lite material requirements and shortage radar

**Traceability:** SRS v2.1 `FR-UFM-13` (required, on-hand, allocated, incoming and shortage date) and `FR-UFM-08` (approved product rules and material readiness); the HLD/LLD and Engineering Implementation Blueprint retain factory isolation, idempotency, audit and transactional-outbox conventions.

## API

All routes are under `/api` and derive user, tenant and factory scope from authenticated middleware. A request body cannot select a different factory.

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `POST /api/mrp-lite/runs` | `mrp.write` | Calculate and persist an immutable plan; requires `Idempotency-Key` |
| `GET /api/mrp-lite/runs?limit=50` | `mrp.read` | List recent factory-scoped runs |
| `GET /api/mrp-lite/runs/:runId` | `mrp.read` | Read a planning snapshot and material requirements |

Request example:

```json
{
  "horizon_start": "2026-10-17",
  "horizon_end": "2026-11-30"
}
```

Dates must be real calendar dates, start cannot follow end, and the inclusive horizon is limited to 366 calendar days. Reusing an idempotency key with the same horizon returns the existing run; reusing it for a different horizon returns a conflict.

## Demand and material quantity

The run uses open sales-order lines in `CONFIRMED` or `IN_PROGRESS` state whose required date is on or before `horizon_end`. Including overdue lines is intentional: old commitments must not disappear from shortage visibility. A line's required date is its own requested delivery date, then the order's requested delivery date, then order date. Completed good production is subtracted from the ordered quantity; scrap does not count as good output.

Finished-good inventory items map to active product definitions. For each due date, MRP resolves the approved or historically retained product revision effective on that date and uses that revision's BOM/UoM snapshots. A line without product mapping, a released version, or BOM lines is returned in the plan's `exceptions`; an inactive component is not silently treated as stocked.

For a component line, the conservative material requirement is calculated in base inventory units and rounded **up** to four decimal places:

```text
gross finished quantity = remaining good output target / (expected yield percent / 100)
component requirement = gross finished quantity
                      * BOM base_quantity_per
                      * (1 + wastage_percent / 100)
required quantity = CEILING(component requirement to 0.0001)
```

The yield gross-up and BOM wastage are planning assumptions only. They do not issue material, change stock, or post consumption.

## Availability and order allocation

* **On hand** is the stock-balance quantity at run time.
* **Allocated** is the quantity already reserved by operational inventory reservations at run time.
* **Available on hand** is `max(on_hand - allocated, 0)`. MRP never allocates already-reserved stock a second time.
* **Incoming** is remaining quantity on an `APPROVED` purchase order, after posted GRN accepted quantity is subtracted. Cancelled/draft/unapproved orders are not supply; receipt quantities are not counted a second time as incoming.
* **Planned on-hand allocation** and **planned incoming allocation** are advisory assignments across demand, using due-date FIFO. Demands are ordered by required date, order date, order number, sales-order line number and BOM line number. Each stock or PO supply bucket can be consumed only once in the run.
* Incoming supply is eligible for dated coverage only when it has an ETA on or after the database's current date. A future ETA that is earlier than a future `horizon_start` can still cover a later requirement; rejecting it merely because it predates the horizon would create a false shortage. Undated and overdue POs remain visible in incoming totals but are not trusted to meet a future due date.
* **Shortage quantity** is the component quantity not coverable by unreserved stock and eligible incoming supply by the required date. **Shortage date** is that demand's required date. If a later dated PO ETA can cover the whole shortfall, `projected_available_date` and `LATE_SUPPLY` explain the recovery without hiding the original shortage; otherwise the status is `UNSUPPLIED`. A fully covered row is `COVERED`.

Every requirement keeps the order and effective BOM revision IDs, component-unit quantity snapshots, stock/reservation/incoming quantities, both advisory allocation quantities, shortage/projection dates and alternate-material scenarios. Approved alternates are shown only as `WHAT_IF_ONLY` scenarios, including the estimated alternate quantity derived from the shortage and approved conversion snapshot plus that alternate item's own on-hand, reserved and incoming quantities. Scenarios do not consume a shared alternate supply pool across hypothetical choices and do not auto-substitute materials.

## Persistence and boundaries

A plan and its requirements are immutable snapshots, protected with forced tenant RLS, factory-scope foreign keys, uniqueness and idempotency constraints. State-change events are written to the transactional outbox, and the audit sink is attempted after the transaction. Recalculate to refresh a plan after order, stock, reservation, GRN, PO or engineering changes.

MRP-lite does **not** create or approve purchase orders, book stock reservations, move inventory, perform finite-capacity scheduling, or promise supplier delivery. Actual reservation and inventory movements remain owned by Inventory/WMS; purchasing remains owned by Procurement. The FIFO proposal is a material-readiness view for planners, not a replacement for operational approvals.
