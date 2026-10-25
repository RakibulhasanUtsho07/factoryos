# FactoryOS Backend Gap-Closure Roadmap

**Baseline:** SRS v2.1 Final / FOS-SRS-001, HLD/LLD v1.0, Engineering Implementation Blueprint v1.0 (2026-10-02).  
**Repository baseline reviewed:** `61327a4a67a07899604d6b6b6197e09e7cb0828b`.  
**Roadmap status:** In progress; this document is a work plan, not acceptance evidence.

## Rules for closing work

1. Work in medium-sized, reviewable slices. Each slice names its SRS requirement(s), owning HLD service/work package, migration impact, direct code tests, PostgreSQL contract, and exact-SHA CI evidence.
2. Keep the promotion path `rakibul-hasan` → `dev` → `main`. Do not promote a failed or unverified candidate, and never force-push shared branches.
3. Distinguish repository implementation from staging/production acceptance. A passing unit test, SQL structure check, green CI, or runbook does not prove a live provider, plant, restored database, or production configuration was exercised.
4. A requirement can be marked PASS only after its current SRS wording/priority is reconciled, direct code/migration/test evidence is linked to the candidate SHA, and any required operational evidence and named owner/reviewer approval are recorded.
5. Do not convert the 950 cumulative scope count, the 899 extracted-ID index, or the 37 source-priority review entries into a completion percentage. The source/priority denominator needs owner-attested reconciliation first.

## Ordered work plan

| Order | Priority / work package | Work to close | Acceptance evidence required | Boundary |
|---|---|---|---|---|
| 0 | **P0 — source and release baseline** | Reconcile the authoritative v2.1 requirement occurrences against inherited versions, the 950 cumulative scope, the 899 text-indexed IDs, and 37 source-priority review entries. Refresh the closure register against the current candidate SHA. | Controlled source revision/hash; owner-reviewed active requirement ledger; every applicable P0/P1 row linked to direct implementation, migration or approved N/A, tests, exact-SHA CI, owner and independent reviewer. | Product/Architecture source-owner approval cannot be fabricated by engineering. This runs in parallel with code work. |
| 1 | **P1 — first governed business executor (WP05/WP06)** | Add read-only `INVENTORY.STOCK.SUMMARY@1.0.0` through the normal registry, permission, subscription, metering, artifact-admission and Tool Gateway path. Keep unregistered tools fail-closed. | Unit tests for result, permission, missing item and missing executor; strict registry input/output schemas; ordered migration and PostgreSQL contract; exact-SHA API and PostgreSQL CI. | This is the first bounded slice, not completion of WP06. Side-effectful production business tools remain unimplemented until individually registered, authorized and tested. |
| 2 | **P0/P1 — manufacturing and WMS end-to-end (WP02)** | Build repeatable cross-domain journeys: order → reservation → PO/GRN → work order/operation → output → quality/disposition/genealogy; test concurrency and replay. Close remaining FEFO/FIFO/lot/serial, costing/valuation, mobile/offline scan and recurrence-scheduler deployment gaps. | PostgreSQL end-to-end fixture; two-session reservation/count tests; negative tenant/factory tests; measured replay/idempotency results; deployment scheduler/warehouse acceptance where required. | RFID, scanner hardware and live ERP/MES behavior require a selected site/device/provider and separate evidence. |
| 3 | **P0/P1 — live AI provider, planner and runtime execution (WP05/WP06)** | Complete the approved model-provider path, planner attestation/live planning, domain-specific tool executors, and task/evaluation acceptance. Test action allow/deny, approval binding, cancellation/deadline, ambiguous side effects, compensation and reconciliation per executor. | Approved provider environment and credentials; signed model/tool artifacts; positive probe plus missing/expired/revoked/mismatched-artifact controls; live tool/executor cases; usage/admission correlation; independent review. | FR-MSO-03 and FR-MSO-05 remain OPEN / NOT_ACCEPTED until approved live evidence exists. |
| 4 | **P0 — privacy, tenant isolation and data lifecycle (WP01/WP10)** | Complete indirect ownership mapping, governed export/import transformations, external-store deletion adapters, residual verification and legal-hold handling across object storage, cache, search/vector indexes, learning artifacts, external providers, replicas and backups. | Reviewed table/store inventory; cross-tenant negative tests; exact-schema and explicit transformation tests; dry-run manifests; immutable provider receipts; zero-residual or authorized retained-residual disposition. | Cloud/object/vector/cache/backup services must be selected and configured in an approved environment; a PostgreSQL receipt alone is not whole-tenant erasure. |
| 5 | **P1 — integration/event and commercial workflows (WP03/WP10)** | Prove Kafka/outbox recovery and the selected ERP/SFTP/finance adapters against real staging endpoints; complete invoice/webhook/retry/tax/accounting-boundary reconciliation with the selected commercial provider. | Provider sandbox evidence; outage/replay/duplicate/mismatch tests; internal ledger vs provider invoice reconciliation; idempotent webhook replay; audited correction and close evidence. | Never treat usage metering as an issued commercial invoice. Tax/accounting acceptance requires appropriate business-owner review. |
| 6 | **P1 — CBB, research, growth and learning (WP04/WP07–WP09)** | Close missing source ingestion/rights and human review, active-learning/label workflow, causal/counterfactual gaps, KPI/outcome linkage, and calibrated forecast/scenario validation. | Source/citation lineage; access/rights decisions; approved labels and holdouts; red-team/privacy controls; representative real observations and realized outcomes; business-owner-approved calibration thresholds. | Synthetic simulations and heuristic uncertainty ranges are not evidence of production learning or calibrated probabilities. |
| 7 | **P0/P1 — OT gateway and field acceptance (WP11)** | Commission the real OPC UA/MQTT/Modbus gateway with site-approved certificates, broker ACLs, network/VLAN rules, encrypted spool/key rotation, reconnect/replay, and read-only PLC contracts. | Simulator plus fault-injection tests, live broker/controller evidence, reboot/power-loss/spool corruption/full-disk tests, isolation proof and operator sign-off. | HIL commissioning needs actual hardware/site and authorized OT operators; no code-only claim can close it. |
| 8 | **P0 — production hardening and release gate (WP12)** | Perform live production security review, encrypted backup/restore, DR, representative load/soak and rollback rehearsal; deploy central observability and test alert routing; approve SLO/RPO/RTO. | Exact-candidate deployment and migration evidence; measured restore/RPO/RTO; cross-tenant/role security tests; vulnerability/penetration-review disposition; central dashboards, fired alerts, approved SLO and Operations sign-off. | Proposed HLD RPO/RTO figures remain proposals until Operations approves them. |

## Current slice and next completion gates

### Step 1 — read-only inventory stock summary

**Implementation target:** `INVENTORY.STOCK.SUMMARY@1.0.0`.

- Reads only the authoritative aggregate inventory balance for one item.
- Calls the existing Inventory domain service, not a caller-supplied query or arbitrary URL.
- Rechecks `inventory.read` through IAM; the SQL query has explicit tenant/factory/item predicates and uses transaction-local RLS context.
- Requires a strict item UUID schema and returns balance quantities as decimal strings plus a balance version.
- Performs no stock mutation. Missing scoped item returns a bounded failure; an absent executor stays fail-closed.
- Adds the tool to the ordered migration manifest and requires API unit tests plus a PostgreSQL registry contract before promotion.

### After Step 1

1. Verify the new executor on the feature PR's exact SHA with API CI and PostgreSQL CI.
2. Promote through `rakibul-hasan` → `dev` → `main` only after checks pass.
3. Refresh WP06/SRS evidence without marking the whole AI runtime accepted.
4. Take the next medium-sized slice from WP02 WMS end-to-end evidence, then proceed by the ordered dependencies above.

### WP02 slice — finished-good lot put-away and directed movement

**Gap:** production output creates a finished-good lot in traceability, but directed inventory movement treated every supplied identity as a raw-material LOT/SERIAL and did not return `traceability_unit_id` to API callers. An identity could also be omitted from a generic move when the tracked stock at the source was a finished-good lot.

**Implementation/acceptance:** migration 200 adds a database guard for scoped, active material LOT/SERIAL and finished-good LOT identities, rejects tracked movements without an explicit identity, and blocks active quality-held/expired/damaged stock. The location service now transfers finished-good lot balances with the aggregate per-location balances and returns the selected identity in API results. Unit/PostgreSQL integration coverage checks put-away from UNASSIGNED to BIN, BIN-to-BIN transfer, BIN-to-STAGING pick, idempotent replay, aggregate/location/identity quantity conservation, and missing-identity rejection. Migration 200 is part of the explicit manifest and its SQL contract is re-run to test migration idempotency.

**Boundary:** this closes the backend directed-movement identity gap for the supported finished-good LOT. It does not claim carton/pallet shipment capture, scanner/RFID hardware acceptance, production-site deployment, or completion of all WP02/SRS requirements.

### WP02 slice — controlled carton/pallet packing and customer shipment traceability

**Gap:** genealogy exposed PACKED_INTO and SHIPPED_AS, but the generic edge accepted arbitrary source/target types, shipment identities could omit customer/order references, and a shipment could be marked SHIPPED before any package was attached.

**Implementation/acceptance:** migration 201 adds a database guard for finished-good LOT/SERIAL → CARTON/PALLET and CARTON → PALLET packing, restricts shipment edges to content-bearing CARTON/PALLET identities, prevents one package from being dispatched under multiple shipment identities, requires customer/customer-order/shipment references, and blocks the SHIPPED lifecycle transition until a valid package edge exists. The API validates reference metadata before starting a DB transaction. PostgreSQL CI checks the function/trigger contract and reruns the migration for idempotency; services/api/test/traceability.sql also checks wrong-type packing rejection, early-dispatch rejection and a valid shipment lifecycle after migration 201 is installed.

**Boundary:** this is a traceability/lifecycle closure, not a physical stock issue. Outbound stock decrement/location movement, carrier/ERP fulfilment integration, scanner/RFID/offline sync, physical-site rehearsal and full WP02/SRS acceptance remain open.

**Release status remains OPEN** until the source/priority reconciliation and all applicable release gates above have direct evidence and authorized review. This roadmap intentionally records external blockers as external rather than inventing acceptance.
