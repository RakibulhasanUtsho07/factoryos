# WMS LOT/SERIAL transformation acceptance boundary

**Implementation status: bounded backend commands implemented on the stacked WP02 branch; SRS product acceptance remains OPEN / NOT_ACCEPTED.**

## Commands and routes

Migration 238 continues to reject generic SPLIT_INTO and MERGED_INTO genealogy writes. Migration 239 adds command-linked stock-conserving execution. The generic POST /api/v1/traceability/genealogy route remains blocked for both relationship types.

- POST /api/v1/traceability/units/:unitId/split takes one source material LOT and 2–100 child identities. All outputs in one command must be either LOT or SERIAL. Each output declares its total quantity and the exact quantities to assign to existing source locations.
- POST /api/v1/traceability/units/merge takes 2–100 compatible source material LOT identities and a new target LOT code. Target location quantities are derived from source identity/location balances; the client cannot invent the result quantity.

Both routes require traceability.write, factory scope and an Idempotency-Key. Repeating the same key and request hash returns the same target IDs without duplicate identities, command lines, genealogy, audit or outbox events. Reusing the key with a changed payload conflicts.

## Transaction and ledger invariants

A command locks the canonical tenant/factory genealogy graph, the inventory item and the aggregate/location/traceability balances in the same item-first lock order used by stock reservation/issue paths. Source material LOTs must be ACTIVE, unexpired, undamaged, unheld, not under an active quality hold, and fully reconciled: tracked on-hand must exactly equal registered quantity less prior CONSUMED_INTO/PROCESSED_INTO genealogy quantities.

Reserved sources are rejected. Any quantity_reserved or outstanding traceability reservation allocation requires the operator to release the reservation before transformation. The command does not silently release or reassign reservations. This is a deliberate fail-closed boundary; allocation-sequence-preserving reservation remapping remains OPEN.

For a successful split, all output quantities must sum exactly to the complete source LOT on-hand quantity. Per-output locations must sum to the output quantity, and the total assigned to each source location must remain exactly equal to that location's source LOT quantity. A SERIAL output is exactly 1.0000 in one location. Mixed LOT/SERIAL outputs in one command, partial parent remainders and physical moves to a different location are not supported.

For a successful merge, all sources must be material LOTs for the same factory/item/base unit, be unreserved and fully tracked, and have identical manufacturing timestamp, expiry, attributes and effective receipt timestamp. The new target LOT quantity equals the sum of all source on-hand quantities. Source identities are moved to DISPOSED; the target identity remains ACTIVE.

Both operations replace only the traceability-unit/location attribution. They do not change aggregate inventory_stock_balances, item/location inventory_location_balances, or physical quantity in any BIN. Traceability-location balance totals are preserved exactly per location. The child's allocation_received_at_override retains the original effective receipt precedence (posted_at, then received_at, then prior override, then identity created_at) so FIFO/FEFO ordering is stable. The reservation allocator and database genealogy policy guard use the same precedence.

Each command writes immutable transformation headers and per-source/target/location lines, genealogy events linked through transformation_id, target unit registration audit/outbox, source disposition status-history/audit/outbox, and a command-level completion audit/outbox event. Database deferred evidence constraints require the associated records to exist before commit. A late uniqueness/write failure rolls the command back, including the header, source balance change, target rows and all evidence.

## Automated acceptance evidence

services/api/test/wms-serial-indivisibility.sql now runs against PostgreSQL and exercises:
- Two compatible LOTs merged into one target LOT, with both source quantities and source identities retired.
- A ten-unit LOT split into ten independently addressable whole-unit SERIAL identities.
- Effective receipt timestamp preservation through merge/split.
- Same-key merge and split replay without duplicate command/genealogy/evidence rows.
- A deliberately late duplicate-identity failure after the source map/header writes begin; the savepoint confirms full rollback.
- Aggregate on-hand/reserved, item/BIN on-hand/reserved and total traceability-location on-hand/reserved conservation.
- API PostgreSQL integration races two different split idempotency keys against the same source LOT: one command commits, the other conflicts after source-state revalidation, and only one command/two genealogy edges remain.
- API PostgreSQL integration races a split against reservation creation: the reservation commits, the split either wins first and the reservation targets only active child LOTs, or the reservation wins first and the split fails closed; no active allocation may reference a disposed LOT, and aggregate/BIN/traceability/reserved totals reconcile.
- Existing SERIAL indivisibility and generic unbacked-genealogy rejection.

The API unit contract tests reject fractional SERIAL outputs, mixed output unit types and duplicate merge source IDs before opening a transaction. API CI and PostgreSQL CI must pass on the exact PR head. The PostgreSQL workflow applies and replays migration 239 before the WMS SQL contract.

## Remaining SRS acceptance gates

FR-WMS-02 / FR-WMS-04 / FR-WMS-09 remain PARTIAL / OPEN / NOT_ACCEPTED pending: reservation allocation remapping without changing per-reservation sequence precedence; mixed good/scrap and larger serial distribution scenarios; full forward/reverse recall impact acceptance through transformations; cross-location physical movement/put-away handling; representative external factory/site/provider rehearsal; physical barcode/RFID/mobile/printer HIL; capacity/recovery testing; and named independent product/operations owner and reviewer acceptance.

Do not promote this command slice to main or mark the SRS rows PASS based only on code/CI. The PR is stacked on the generic-transformation safety guard branch and must be reviewed and accepted in that order.
