# Finite-capacity MRP-lite planning and scenario comparison

**Traceability:** SRS v2.1 `FR-UFM-05`, `FR-UFM-07`, `FR-UFM-08`, `FR-UFM-13`; HLD tenant isolation, immutable version snapshots, idempotent writes and transactional outbox.

## Design

A capacity scenario is calculated only from an existing immutable `mrp_plans` run and its requirement snapshots. The engine reuses each order-line's effective product revision, BOM/UoM/wastage and the MRP-lite material view (on-hand less existing reservations, approved incoming purchase-order balance after accepted GRN, and approved alternate what-if visibility). The route comes from that exact product revision; setup, per-unit run time (SAM/SMV), queue and transfer durations determine the workload. Capacity comes from versioned work-centre/date/shift calendar rows with efficiency and skill eligibility.

The scheduler is deterministic: demand is sorted by need-by date, sales-order number, line and operation; capacity buckets are sorted by date, shift and work-centre. Required minutes are rounded up to four decimals. No eligible skill, exhausted shift capacity, unsupplied material, late completion or frozen-revision drift is explicit in the resulting operation status/conflict codes. A scenario carries the approved alternate-material what-if snapshots already computed by MRP-lite alongside primary-material readiness, so planners can see eligible alternatives and their material positions while assessing a shortage. Alternate options remain advisory; the scheduler does not silently replace the BOM or reserve alternative stock. A scenario may be compared with an earlier capacity plan from the same source MRP run; the stored diff distinguishes added, removed and changed operations.

## API

All endpoints require authenticated tenant/factory context, factory scope and the indicated IAM permission.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/mrp-lite/capacity-calendars?start=YYYY-MM-DD&end=YYYY-MM-DD` | `mrp.capacity.read` | Read shift calendars |
| POST | `/api/mrp-lite/capacity-calendars` | `mrp.capacity.manage` | Add one work-centre/date/shift capacity slot with `Idempotency-Key` |
| PUT | `/api/mrp-lite/capacity-calendars/:calendarId` | `mrp.capacity.manage` | Change minutes, efficiency or skills with reason, idempotency key and `expected_version` |
| POST | `/api/mrp-lite/capacity-plans` | `mrp.capacity.write` | Calculate an immutable finite-capacity scenario |
| GET | `/api/mrp-lite/capacity-plans?source_mrp_plan_id=...` | `mrp.capacity.read` | List scenario versions |
| GET | `/api/mrp-lite/capacity-plans/:planId` | `mrp.capacity.read` | Read scheduled operations, material readiness, conflicts and scenario diff |

Capacity plan requests reference a source MRP-lite run and define their horizon and frozen-horizon start/end. The capacity horizon must fit inside the source plan's material horizon. Scenario comparison is permitted only when both plans originate from the same material plan. Calendar changes are optimistic-versioned, require a change reason, and preserve idempotency evidence.

## Safety boundary

Capacity plans and operation rows are immutable calculation snapshots; use a new plan version for changes. The frozen horizon retains previous scheduled segments where available and emits conflicts if pinned revision/work centre/workload no longer agrees. A capacity forecast never creates or approves a purchase order, never places inventory reservations, never posts movements and never releases a work order. It is a recommendation for a planner to review, not an operational commitment.

## Verification

Migration `163_mrp_finite_capacity_scenarios.sql` establishes RLS, scoped revision/routing/work-centre foreign keys, versioned shift-calendar guardrails and immutable plan snapshots. `capacity-scheduler.spec.ts` tests repeatable scheduling, finite-capacity conflicts, unsupplied-material blocking, skill mismatch, frozen-horizon consistency and scenario differences. The PostgreSQL contract test is `services/api/test/product-eco-capacity-planning-contract.sql`.
