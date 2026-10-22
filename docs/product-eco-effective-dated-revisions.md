# PLM/ECO and effective-dated product revision integration

**Traceability:** FactoryOS SRS v2.1 `FR-UFM-03`, `FR-UFM-07`, `FR-UFM-08` plus HLD/Blueprint tenant scope, least privilege, optimistic concurrency, immutable snapshots, audit and transactional-outbox conventions.

## Revision lifecycle and ECO decision

Product revisions continue to use the existing `product_versions`, BOM lines, approved alternate-material contracts and routing snapshots. An ECO ties an approved source revision to a draft target revision and requires its `effective_on` date to equal the target version's `effective_from` date. The ECO captures a canonical comparison of BOM lines, alternate-material permissions, routing/work-centre assumptions and yield specification before it can be submitted.

A request progresses `DRAFT -> SUBMITTED -> APPROVED | REJECTED`. Submission and reviewer decision require idempotency keys and expected row versions. Approval is maker-checker protected: the reviewer must differ from the ECO creator and target revision creator. In one PostgreSQL transaction it closes the source revision on the day before the target becomes effective, releases the target revision, updates the ECO status, and appends event/outbox evidence. Overlapping approved versions, unresolved draft alternate contracts, an invalid effective date or a stale row version reject the transition.

## API contract

All endpoints derive user/tenant/factory from verified request context, require factory scope and explicit IAM permissions.

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| POST | `/api/products/:productId/engineering-changes` | `products.eco.write` | Idempotently snapshot old/new revision and affected open work orders |
| GET | `/api/products/:productId/engineering-changes` | `products.eco.read` | Read chronological ECO history |
| GET | `/api/products/:productId/engineering-changes/:ecoId` | `products.eco.read` | Read revision snapshots, change flags, effective date and event history |
| GET | `/api/products/:productId/engineering-changes/:ecoId/affected-orders` | `products.eco.read` | Read captured open-order impact and pinned revision |
| POST | `.../:ecoId/submit` | `products.eco.write` | Submit with `expected_version` and `Idempotency-Key` |
| POST | `.../:ecoId/approve` | `products.eco.approve` | Approve and atomically transition effective revision |
| POST | `.../:ecoId/reject` | `products.eco.approve` | Reject with a reason and idempotent evidence |

## Affected orders and snapshot guarantee

The affected-order query identifies open work orders pinned to the source product revision whose due date or planned start is on/after the transition date. DRAFT work orders are marked `REPLAN_BEFORE_RELEASE`; RELEASED, IN_PROGRESS and ON_HOLD work orders are marked `PRESERVE_RELEASED_SNAPSHOT_REVIEW`. Each impact row captures the order ID and number, order-line ID, current work-order row version, pinned product revision, quantity/dates and operation-snapshot digest.

The ECO decision does not rewrite a work order, its route, its material requirement snapshot, its reservation links or any stock/PO state. A draft that can no longer be released against an applicable revision must be explicitly recreated from the applicable approved revision. Released operations remain version-pinned; an engineer/planner must review the impact list and use a separate operational command for any allowed disposition.

## Persistence and tests

Migration `162_product_eco_effective_date_change_orders.sql` adds composite scope foreign keys, idempotency and request hashes, forced tenant RLS, lifecycle/version guards, immutable revision/affected-order snapshots and append-only ECO events. `services/api/src/products/engineering-change-policy.spec.ts` covers stable old/new comparison and no-op detection. `services/api/test/product-eco-capacity-planning-contract.sql` asserts RLS, lifecycle/immutability triggers, scoped revision/order foreign keys and snapshot fields. Migration `163_mrp_finite_capacity_scenarios.sql` creates the separate finite-capacity persistence model; a plan is advisory and does not create inventory reservations or purchase orders.
