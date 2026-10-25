# WP02 production output lot genealogy — bounded closure slice

SRS linkage: FR-WMS-06 and FR-WMS-08 (both remain Partial overall).
HLD/Blueprint linkage: WP02 Core Domain Kernel; production output, material reservation, quality/yield and traceability.
Base SHA: 1c36f01ea6ab74470ab989f75a36d097e6985aec.
Status: implementation and automated acceptance are in progress until exact-SHA CI results are verified.

## Gap established by code review

Before this change, reportOutput() posted a good-output inventory receipt and immutable yield/scrap posting, while work-order completion separately consumed material reservations and persisted lot/serial consumption-allocation rows. Those paths were not joined into the traceability graph. The traceability API allowed output lots and genealogy events, but production report execution did not create/link the output lot, and completion did not turn actual consumed-lot allocations into genealogy edges.

## Change

- New output reports create a finished-good LOT identity when good_quantity > 0; the posting stores the identity ID.
- Positive scrap creates a LOT / OTHER evidence identity with sellable=false, no inventory item and no stock balance. Scrap-only output creates no zero-quantity movement.
- Finished-good traceable stock is assigned only to available quantity in the factory's default virtual UNASSIGNED location. The location balance guard prevents inventing quantity or double-binding stock already assigned to other identities.
- Work-order completion reads the immutable material consumption-traceability allocations and writes CONSUMED_INTO edges from the source material lot/serial to finished-good lots, and PROCESSED_INTO edges to scrap evidence identities.
- The source material quantity stays in its original UOM. A named deterministic ratio algorithm apportions that quantity against the reported good/scrap output mix using integer four-decimal arithmetic, puts any rounding remainder on the final eligible target, and preserves exact consumed quantity.
- Matching genealogy event, audit event and outbox event are committed in the same transaction as work-order completion. Missing traceability identities fail closed.
- Migration 199 adds a database-level evidence guard: an edge into a work-order output LOT/scrap identity must point to the same work order's real immutable WMS consumption allocation, source material identity, output posting/report and exact target kind. Caller-supplied evidence JSON alone cannot authorize the relationship.
- Deferred PostgreSQL constraints require the entire consumed lot/serial allocation quantity to be represented exactly once across the output genealogy and reject both an unsupported edge commit and a work-order completion that omits an allocation. Replays and the proportional quantity conservation checks remain covered by regression tests.

## Automated test plan

1. API CI: InventoryReservationService unit coverage for good + scrap identity creation, scrap-only handling, plus multi-report genealogy quantity-conservation test.
2. PostgreSQL CI: migrations 198–199, output identity/report/item binding, work-order consumption-evidence binding, deferred exact-allocation conservation, completion gate, traceability RLS contract, and replay/idempotency.
3. API regression: all prior unit tests, lint and build.
4. PostgreSQL regression: full ordered migration application, output-genealogy contract, consumption-evidence guard contract, migration replay/idempotency, and full integration/Jest suite on the exact candidate SHA.

## Explicitly still open

This slice does not backfill historical reports into present-day stock or invent past location provenance. It does not add finished-good-compatible put-away/picking/transfers, carton/pallet packing, shipment/customer linkage, recall business-owner acceptance, RFID/offline mobile sync, or hardware-in-loop evidence. FR-WMS-06/08 and WP02 remain Partial until those applicable requirements are implemented and accepted with direct evidence.
