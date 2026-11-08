# Utility reading to production work-order cost allocation

**Schema:** migration `243_utility_work_order_cost_allocations.sql`  
**API service:** `services/api/src/utilities/utility-work-order-cost-allocation.service.ts`  
**Finance source type:** `UTILITY_WORK_ORDER_COST_ALLOCATION`

## Purpose and accounting boundary

A utility meter reading is an immutable source record. When a reading covers shared factory activity, the application must not assume which production order consumed it. An authorized operator assigns an explicit quantity to a specific released work order; the database derives cost from the reading's capture-time unit-cost snapshot. A single reading can be split across several work orders, but the total net quantity cannot exceed the source consumption.

This is an operational actual-cost attribution input for the finance reconciliation workbench. It is not a GL journal, supplier invoice, landed-cost valuation, labour/overhead allocation, WIP capitalization or finished-goods valuation. The external accounting platform remains the accounting system of record.

## Capture-time evidence

Migration 241 adds nullable `currency_code_snapshot` and `cost_center_code_snapshot` fields to `utility_meter_readings`. A BEFORE INSERT trigger copies both from the in-factory meter configuration for every new reading. Historical readings remain NULL: the migration deliberately does not invent what currency or cost centre was configured at the time of an old reading. Such a reading cannot be allocated until its source evidence has been repaired through a separately governed process.

## Allocation contract

Each allocation preserves the reading, meter, work order, exact allocated quantity, UOM, frozen unit rate, cost, currency, cost centre, operator, reason, request hash, idempotency key and correlation/request identifiers. Numeric quantities are supplied as decimal strings and stored as PostgreSQL NUMERIC; the API does not convert accounting quantities through JavaScript floating point.

The PostgreSQL guard requires:
- same-tenant and same-factory source reading, meter and work order;
- a non-zero reading with a frozen currency snapshot;
- work-order state IN_PROGRESS or COMPLETED, with the reading timestamp between released_at and completed_at (when present);
- exact source reading UOM, unit-cost, currency and cost-centre snapshots;
- `allocated_cost = ROUND(allocated_quantity × unit_cost_snapshot, 8)`;
- net ALLOCATE minus REVERSAL quantity no greater than source consumption;
- actor identity equal to authenticated database context.

The reading row is locked while net capacity is checked, so concurrent allocations against the same reading serialize at the authoritative database boundary. The API repeats the capacity check for earlier, human-readable rejection, but the database trigger is decisive.

## Reversal and audit

Allocation rows cannot be updated or deleted. A reversal is a new row that references exactly one original allocation and duplicates its quantity, work order, UOM, rate, cost, currency and cost-centre snapshots. Only one full reversal is allowed for an original allocation. Every allocation and reversal creates an immutable `utility_audit_events` entry under `WO_COST_ALLOCATION`. A reversal restores the source reading's unallocated quantity; it does not change the original reading or post a financial journal.

## Finance reconciliation

Finance accepts a single allocation UUID as `expected_source_ref` under source type `UTILITY_WORK_ORDER_COST_ALLOCATION`. It resolves only a live, unreversed allocation, joins the same-factory meter reading and work order, and returns the assigned quantity, frozen rate, UOM and currency. A reversed allocation is no longer valid for a new reconciliation. Any corresponding external finance fact or journal correction remains an accounting-owner action; this API does not mutate the finance system of record.

## API routes

- `GET /api/utilities/meters/:meterId/readings/:readingId/work-order-cost-allocations` — source reading snapshot, net assigned quantity, remaining quantity and allocation/reversal ledger.
- `POST /api/utilities/meters/:meterId/readings/:readingId/work-order-cost-allocations` — body `{ work_order_id, allocated_quantity, reason }`, mandatory `Idempotency-Key`.
- `POST /api/utilities/meters/:meterId/readings/:readingId/work-order-cost-allocations/:allocationId/reverse` — body `{ reason }`, mandatory `Idempotency-Key`.

Routes reuse the existing factory-scoped utility read/capture permissions. They require authenticated tenant/factory context and transaction-local RLS.

## Automated evidence and remaining acceptance

The API unit contract covers decimal validation, exact rate multiplication, historical snapshot rejection, over-allocation rejection, tenant identifiers and conflicting idempotency replay. PostgreSQL CI applies migration 243 from the ordered manifest, replays it to exercise DDL idempotency, verifies forced RLS/guards/reversal uniqueness/audit wiring, and compiles the finance resolver join. The utility lifecycle fixture verifies capture-time currency/cost-centre snapshot behavior.

This does not prove calibrated physical meter accuracy, an operator's allocation basis, labour or overhead allocation, closed-loop WIP/finished-goods valuation, external accounting integration, or finance-owner acceptance. FR-FIN-05, FR-FIN-08 and WP02 therefore remain PARTIAL / OPEN / NOT_ACCEPTED.
