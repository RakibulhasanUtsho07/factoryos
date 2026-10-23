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


## Finite-capacity planning integration

Migration `163_mrp_finite_capacity_planning.sql` adds a dated finite-capacity layer above—not instead of—the immutable MRP material run. First create an MRP material run; it retains the effective product revision/BOM and deterministic four-decimal yield+wastage gross-up, unreserved stock, posted-GRN accepted quantities subtracted from approved open PO lines, shortage date/projected availability, and approved alternate-material what-if evidence.

### Capacity calendar and scenarios API

All routes require the authenticated factory scope. Mutation endpoints require an `Idempotency-Key` and the documented permission. They produce planning evidence only.

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/mrp-lite/capacity-calendar?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&limit=500` | `mrp.capacity.read` | Read dated work-centre / named-line / shift slots |
| `POST /api/mrp-lite/capacity-calendar` | `mrp.capacity.write` | Create a dated capacity entry; duplicate business slots return conflict |
| `POST /api/mrp-lite/capacity-calendar/:calendarId/update` | `mrp.capacity.write` | Versioned minutes, parallel-line or active-state update |
| `POST /api/mrp-lite/runs/:runId/capacity-plans` | `mrp.capacity.plan` | Calculate and persist a finite-capacity scenario from an immutable MRP run |
| `GET /api/mrp-lite/runs/:runId/capacity-plans?limit=50` | `mrp.capacity.read` | List immutable capacity plan versions for that material run |
| `GET /api/mrp-lite/capacity-plans/:capacityPlanId` | `mrp.capacity.read` | Read the schedule, capacity allocations, conflicts and frozen-horizon diff |

Product creation accepts optional, bounded `style_code` and `size_code` identity labels. Existing BOM-per-version modelling remains per product definition: for a garment style/size, map the finished-good inventory item to its own product definition and effective-dated product version/BOM; MRP snapshots the style/size labels beside the selected product revision. The labels can be omitted for non-sized goods and are immutable once assigned. A calendar entry specifies `work_centre_id`, `shift_template_id`, `capacity_date`, `line_code`, `available_minutes` (0–1440) and `parallel_lines` (1–100). Effective shift minutes are the shift's local interval minus unpaid break; the usable slot is bounded by the calendar minutes and the net shift. Date queries are real calendar dates and are bounded to 366 days. Calendar revisions are versioned; historical entries are deactivated, not deleted.

The capacity-plan request contains `scenario_name`, `frozen_horizon_days`, optional `compare_to_capacity_plan_id`, and up to 500 capacity adjustments. An adjustment names an existing work-centre/shift/date/line slot; missing or duplicate slots and invalid capacity totals are rejected. Each new run increments `plan_version` per source MRP run. When a prior scenario exists it is used as the comparison default; a non-zero frozen horizon requires a baseline.

### Deterministic constrained scheduling

The scheduler uses stable due-date/order/line/routing-step and calendar ordering, fixed-point integer arithmetic, and upward rounding to 0.0001 minute/material units. Required operation time is the released routing's setup plus quantity × run minutes per unit (the SAM/SMV input captured in routing), bounded by a configured work-centre capacity rate if that rate is stricter. The engine consumes finite minutes per date/shift/work centre/line and available certified skill-worker minutes. A worker appearing under multiple skills is one resource and cannot be consumed twice in the same shift. Work waits until projected materials become available and any unresolved material shortfall blocks operation scheduling.

Operation statuses explain `SCHEDULED`, `CAPACITY_CONFLICT`, `BLOCKED_MATERIAL`, `BLOCKED_ROUTING`, `BLOCKED_PREDECESSOR` and `FROZEN_HORIZON_CONFLICT`. A scheduled finish after a demand date remains visible with the `FINISH_AFTER_NEED_BY_DATE` conflict code instead of being hidden. Each operation keeps the product/style/size/version identity, routing step, required/scheduled minutes, dates, skill, conflicts and its dated line/shift allocations.

### Scenario version and frozen horizon

Capacity-plan headers, operation rows and line/shift/worker allocations are immutable snapshots, with factory-scoped foreign keys, forced tenant RLS, audit/outbox evidence and idempotent requests. Compare-to plans produce a before/after diff for added, removed and changed operations. The frozen window uses the baseline operation date and worker/slot allocations: matching operations are pinned and their capacity consumed before the remaining work is scheduled. If a pinned allocation cannot fit the selected calendar/qualified workforce, the plan reports `FROZEN_HORIZON_CONFLICT`; the diff marks the frozen-horizon violation rather than rewriting the baseline. Review that exception explicitly before using the scenario as a planning recommendation.

### Non-committing boundary and tests

The planner only reads sales/material/engineering/PO/GRN/inventory-reservation/workforce/routing evidence and writes new capacity-plan snapshots plus the transactional outbox. It never inserts inventory reservations, changes stock/consumption, or creates, edits, approves or releases a purchase order. Any actual action remains a separately authorized inventory or procurement workflow.

Regression coverage is in `mrp-finite-capacity-planning.spec.ts` and `services/api/test/mrp-finite-capacity-planning-contract.sql`, run by API CI and API PostgreSQL CI, including migration `163` replay. The arithmetic/scheduling tests cover yield/wastage, SAM/SMV setup/run minutes, work-centre unit-rate caps, finite-capacity conflicts, material blocks, multi-skilled worker non-double-booking, and frozen-horizon scenario differences.
