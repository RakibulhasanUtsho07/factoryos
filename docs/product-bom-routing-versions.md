# Product definitions, BOM, routing and engineering revisions

**Requirement traceability:** SRS v2.1 `FR-UFM-03` and `FR-UFM-07` (P0); planning-readiness dependency `FR-UFM-08`.
**Architecture alignment:** HLD/LLD tenant isolation, idempotency and optimistic concurrency; Engineering Implementation Blueprint transaction/outbox/audit conventions.

## Contract model

A factory-scoped product definition references one active finished-good inventory item. Product versions are retained engineering revisions with a version number, effective date range, expected yield, change summary and optimistic `row_version`. New revisions begin as `DRAFT`. Approval requires a non-empty BOM, at least one routing step, active finished-good/components/work centres, no unresolved draft alternate material contracts, and a non-overlapping effective interval. Releasing a later-effective version atomically closes the earlier approved interval on the prior calendar day and records the superseding revision; historical queries continue resolving that earlier revision only for the dates it covered. Approved revisions cannot be edited; create a new draft instead. Once alternate-material contracts exist for a draft revision, changing the BOM requires a new product version so the existing contracts and their audit lineage are never cascade-deleted.

Every BOM line references active inventory in the same tenant and factory; has a positive quantity, unit, wastage assumption, unique line number, and optional alternate group. The BOM unit must match the item's base unit or have a **directionally approved** UoM conversion into that unit. Wastage is a planning assumption and does not directly post stock.

An alternate is an explicit contract attached to a BOM line and product version: alternate material, positive conversion factor, unit, rationale, idempotency evidence and independent approval. It cannot refer to the primary component or an item outside the factory. BOM and alternate quantities persist the normalized inventory-base quantity and the approved UoM rule/version/factor/rounding mode used at entry, so later conversion retirement cannot silently reinterpret planning data. Draft alternates block version approval. Routing steps have unique positive sequence numbers, operation code/name, active factory work centre, setup/run/queue/transfer time assumptions, optional skill/instructions and an optional quality gate. Steps whose four duration assumptions are all zero are rejected.

## HTTP contract

All routes are under `/api`, require verified user/tenant and factory scope, and have explicit IAM permissions. The authenticated middleware and factory-scope guard determine scope; request body values cannot choose another tenant or factory.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/products?limit=50` | `products.master.read` | List product definitions in the factory |
| `POST /api/products` | `products.master.write` | Create product; requires `Idempotency-Key` |
| `GET /api/products/work-centres` | `products.master.read` | List routing work centres |
| `POST /api/products/work-centres` | `products.master.write` | Create work centre; requires `Idempotency-Key` |
| `GET /api/products/:productId/versions` | `products.master.read` | List revisions |
| `POST /api/products/:productId/versions` | `products.master.write` | Create a draft revision; requires `Idempotency-Key` |
| `GET /api/products/:productId/versions/:versionId` | `products.master.read` | Read version, BOM, alternates and route |
| `GET /api/products/:productId/versions/effective?at=YYYY-MM-DD` | `products.master.read` | Resolve the single effective revision (including retained historical intervals) and its BOM/route for a date |
| `PUT /api/products/:productId/versions/:versionId/bom` | `products.master.write` | Replace draft BOM with optimistic version check |
| `PUT /api/products/:productId/versions/:versionId/routing` | `products.master.write` | Replace draft routing with optimistic version check |
| `POST /api/products/:productId/versions/:versionId/bom-lines/:lineId/alternates` | `products.master.write` | Create a draft alternate contract; key required |
| `POST /api/products/:productId/versions/:versionId/alternates/:alternateId/approve` | `products.alternate.approve` | Approve alternate; key and expected row version required |
| `POST /api/products/:productId/versions/:versionId/alternates/:alternateId/retire` | `products.alternate.approve` | Retire a draft/approved alternate while its product version is draft |
| `POST /api/products/:productId/versions/:versionId/approve` | `products.version.approve` | Release a revision; key and expected row version required |
| `POST /api/products/:productId/versions/:versionId/retire` | `products.version.approve` | Retire an approved revision; key and expected row version required |

BOM and route replacement bodies carry `expected_version`; stale updates fail with conflict instead of silently overwriting engineering changes. Each replacement accepts 1–200 lines/steps, and list limits are 1–100. BOM detail returns `base_quantity_per` in component inventory-base units; alternate detail returns `inventory_quantity_per_component`. Original entered quantity/unit and normalized quantity/unit remain visible.

## Persistence and safety

Migrations `082` and `083` add composite tenant/factory foreign keys, case-insensitive product/work-centre code uniqueness, database lifecycle triggers, effective-window checks during approval, idempotency ledgers/indexes, and forced tenant RLS. Material-changing commands commit canonical state and an outbox event together. Audit-sink delivery is attempted after commit; the outbox retains durable state-change evidence if the sink is unavailable. SQL queries filter by tenant **and** factory.

Actual production output, scrap, inventory reservations and stock movements remain in their existing domains. BOM yield/wastage are planning assumptions, not inventory postings or automatic procurement actions.


## ECO lifecycle and effective-dated change control

Engineering change orders (ECOs) wrap an existing **draft** product revision in a maker-checker lifecycle. The revision's `effective_from` must exactly match the ECO effective date; backdated submissions are rejected. A submission captures a canonical before/after comparison for specification/yield, BOM lines, routing steps and alternate-material contracts, and freezes the proposed revision's dates/specification and BOM/alternate/routing inputs until the ECO is rejected or approved. Draft alternate contracts must be approved or retired before submission. Approval requires a checker different from the ECO creator and submitter, and a checker distinct from the proposed revision's creator.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/products/:productId/change-orders?limit=50` | `products.eco.read` | List ECO history |
| `POST /api/products/:productId/change-orders` | `products.eco.write` | Create an ECO for a draft version; requires `Idempotency-Key` |
| `GET /api/products/:productId/change-orders/:changeOrderId` | `products.eco.read` | Read before/after diff, state history and affected-order snapshot |
| `POST /api/products/:productId/change-orders/:changeOrderId/submit` | `products.eco.write` | Snapshot the diff/impact list and submit; requires key + `expected_version` |
| `POST /api/products/:productId/change-orders/:changeOrderId/approve` | `products.eco.approve` | Atomically supersede the earlier revision and approve this one from its effective date; requires key + `expected_version` |
| `POST /api/products/:productId/change-orders/:changeOrderId/reject` | `products.eco.approve` | Reject with a mandatory comment; requires key + `expected_version` |

Create request fields are `proposed_version_id`, `title`, `rationale` and `effective_date`. Lifecycle actions use `expected_version`; the optional approval comment is retained and rejection requires a non-empty comment. All writes are factory-scoped, idempotent and optimistic-version checked. ECO status, actor/time evidence, review outcome and event/outbox records are retained rather than deleted.

The affected-order snapshot includes open work orders in `DRAFT`, `RELEASED`, `IN_PROGRESS` or `ON_HOLD` whose planned start or due date reaches the new effective date. It records each order's pinned revision, status and dates at impact calculation time. This list is an impact/review record—not an instruction to rewrite or auto-migrate a live order. The new revision is approved in the same database transaction that closes the prior approved interval at the day before the new effective date; overlapping later-effective revisions fail closed. A work order whose pinned version is no longer effective for its planned start cannot be newly created or have its revision/date silently moved into validity; release readiness remains a separate check.

Migration `162_plm_eco_effective_dated_revision_integration.sql` adds the ECO lifecycle, forced tenant RLS, submitted-revision freeze triggers, a database release gate that prevents bypassing submitted ECO review, and a work-order planned-start/effective-version check. Contract coverage is `services/api/test/product-change-order-contract.sql` plus API tests and the PostgreSQL CI migration replay gate.
