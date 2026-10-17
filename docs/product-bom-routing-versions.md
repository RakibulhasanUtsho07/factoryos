# Product definitions, BOM, routing and engineering revisions

**Requirement traceability:** SRS v2.1 `FR-UFM-03` and `FR-UFM-07` (P0); planning-readiness dependency `FR-UFM-08`.
**Architecture alignment:** HLD/LLD tenant isolation, idempotency and optimistic concurrency; Engineering Implementation Blueprint transaction/outbox/audit conventions.

## Contract model

A factory-scoped product definition references one active finished-good inventory item. Product versions are retained engineering revisions with a version number, effective date range, expected yield, change summary and optimistic `row_version`. New revisions begin as `DRAFT`. Approval requires a non-empty BOM, at least one routing step, no unresolved draft alternate material contracts, and a non-overlapping effective interval against other approved versions. Approved revisions cannot be edited; create a new draft instead.

Every BOM line references active inventory in the same tenant and factory; has a positive quantity, unit, wastage assumption, unique line number, and optional alternate group. The BOM unit must match the item's base unit or have a **directionally approved** UoM conversion into that unit. Wastage is a planning assumption and does not directly post stock.

An alternate is an explicit contract attached to a BOM line and product version: alternate material, positive conversion factor, unit, rationale, idempotency evidence and independent approval. It cannot refer to the primary component or an item outside the factory. Draft alternates block version approval. Routing steps have unique positive sequence numbers, operation code/name, active factory work centre, setup/run/queue/transfer time assumptions, optional skill/instructions and an optional quality gate. Steps whose four duration assumptions are all zero are rejected.

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
| `PUT /api/products/:productId/versions/:versionId/bom` | `products.master.write` | Replace draft BOM with optimistic version check |
| `PUT /api/products/:productId/versions/:versionId/routing` | `products.master.write` | Replace draft routing with optimistic version check |
| `POST /api/products/:productId/versions/:versionId/bom-lines/:lineId/alternates` | `products.master.write` | Create a draft alternate contract; key required |
| `POST /api/products/:productId/versions/:versionId/alternates/:alternateId/approve` | `products.alternate.approve` | Approve alternate; key and expected row version required |
| `POST /api/products/:productId/versions/:versionId/approve` | `products.version.approve` | Release a revision; key and expected row version required |
| `POST /api/products/:productId/versions/:versionId/retire` | `products.version.approve` | Retire an approved revision; key and expected row version required |

BOM and route replacement bodies carry `expected_version`; stale updates fail with conflict instead of silently overwriting engineering changes. Each replacement accepts 1–200 lines/steps, and list limits are 1–100.

## Persistence and safety

Migrations `082` and `083` add composite tenant/factory foreign keys, case-insensitive product/work-centre code uniqueness, database lifecycle triggers, effective-window checks during approval, idempotency ledgers/indexes, and forced tenant RLS. Material-changing commands commit canonical state and an outbox event together. Audit-sink delivery is attempted after commit; the outbox retains durable state-change evidence if the sink is unavailable. SQL queries filter by tenant **and** factory.

Actual production output, scrap, inventory reservations and stock movements remain in their existing domains. BOM yield/wastage are planning assumptions, not inventory postings or automatic procurement actions.
