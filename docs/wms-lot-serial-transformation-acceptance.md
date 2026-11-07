# WMS LOT/SERIAL transformation acceptance boundary

**Status: OPEN — no production split/merge command is implemented.**

## Why the generic genealogy path is insufficient

The product_genealogy_events table is append-only lineage evidence. A SPLIT_INTO or MERGED_INTO row by itself does not move stock, update warehouse bins, release or create reservation allocations, or conserve the inventory ledger. Treating that edge as a completed transformation can make the genealogy graph disagree with the quantity the warehouse can actually pick.

Migration 238 therefore blocks both relationship types through the generic POST /api/v1/traceability/genealogy path and through direct PostgreSQL inserts. Its preflight also refuses to install where historical split/merge edges exist until those records receive explicit owner-audited reconciliation. The API returns 409 Conflict before opening a database transaction. The database guard is authoritative for alternate writers.

## Required design before enabling commands

A future command must have its own authenticated, permission-gated route and typed DTO. It must not reopen the generic genealogy endpoint.

The command must bind tenant, factory, source identities, target identities, inventory item, UOM, source/destination location, expected identity versions, idempotency key, reason and actor. It must take the canonical genealogy graph lock and lock identity, aggregate-balance, location-balance, reservation and allocation rows in one documented order.

For a LOT split, every child identity must be created with unique normalized unit/barcode identity and valid item/UOM scope. The sum of child quantities plus any explicitly retained parent remainder must equal the source's eligible unreserved quantity. SERIAL children are exactly 1.0000; a SERIAL may never be split or merged. The command must conserve aggregate on-hand/reserved quantities and every affected BIN and traceability-location balance, and it must not consume reserved, quarantined, recalled, expired, damaged, held, shipped or otherwise ineligible quantity.

For a LOT merge, all source lots must be compatible in tenant/factory, item, UOM, quality/expiry disposition and policy. Only eligible unreserved quantities may be moved. The new target LOT must have a unique identity, and the sum of source quantities must equal the target quantity. Serial identities remain separate; a merge must never collapse their identity.

Both commands must create immutable genealogy edges, audit events and transactional outbox events in the same transaction as the stock movement. They must replay the original result for an identical idempotency payload, return 409 Conflict for a changed payload under the same key, and reject cross-tenant/factory IDs, duplicate targets, cycles, stale expected versions and concurrent oversubscription. A failed command must leave every balance, reservation, identity and evidence table unchanged.

## Acceptance evidence required

- PostgreSQL integration tests using real inventory fixtures and two concurrent command attempts against the same source quantity.
- Split quantity conservation across parent remainder, children, aggregate stock, every BIN, traceability-location balances and reservation availability.
- Merge source compatibility, exact output quantity, lineage completeness and full stock conservation.
- SERIAL cannot be split or merged; SERIAL child quantities are exactly one.
- Rejected reserved/held/expired/quarantined/recalled/shipped sources, wrong tenant/factory, stale versions, cycles, duplicate idempotency conflicts and insufficient quantity.
- Idempotent replay creates no duplicate units, movements, genealogy, audit or outbox rows.
- Failure injection at each write stage proves transaction rollback.
- Full ordered migration replay, API CI, PostgreSQL CI, dependency security and SRS/HLD/Blueprint traceability on the exact PR head.
- Factory/site rehearsal, physical label/scanner/RFID HIL where applicable, and named independent owner/reviewer acceptance.

Until all evidence is present, FR-WMS-02 / FR-WMS-04 / FR-WMS-09 remain PARTIAL / OPEN / NOT_ACCEPTED. The fail-closed guard is a safety improvement, not proof that the transformation feature has been delivered.
