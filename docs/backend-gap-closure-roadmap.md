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

### WP02 current slice — automatic production material genealogy

**Status:** Implemented on branch `work/wp02-production-output-genealogy`; awaiting exact-SHA API and PostgreSQL CI acceptance.

- Work-order completion links actual consumed material lot/serial allocation records to ACTIVE finished-good identities already bound to positive-good production reports, within the same PostgreSQL transaction.
- Bulk material issue quantity is apportioned by finished identity quantity; integer four-decimal arithmetic conserves the full issued amount. A serialized input remains indivisible and is assigned deterministically to one finished-good identity.
- Each genealogy edge includes its source consumption, reservation, allocation, source bin, production report and allocation method. Audit and outbox evidence are in the same transaction; deterministic idempotency keys protect replay.
- When tracked material allocations exist, missing/inactive/wrong-item output identity or mismatched output quantity fails completion closed. Register output identities through Traceability after reporting output and before completing the work order.
- The genealogy database guard now resolves material → sector → factory → factory-default policy, and checks an earlier FIFO/FEFO lot only if eligible, unreserved quantity remains in a pickable bin.
- Known boundary: all-scrap output with tracked input still needs an explicit scrap/disposition genealogy path. Warehouse offline/RFID/mobile and shipment-to-customer genealogy remain separate gaps.

### After this WP02 slice

1. Verify API unit tests and the ordered migration/PostgreSQL contract on the feature PR's exact SHA; repair and rerun failures.
2. Promote through `rakibul-hasan` → `dev` → `main` only after the required exact-SHA checks pass.
3. Keep FR-WMS-06/08 partial until full API/data-path evidence, reverse-trace acceptance and remaining mobile/shipment workflows are independently accepted.
4. Continue with another medium-sized WP02 gap after this slice is reviewed.

**Release status remains OPEN** until the source/priority reconciliation and all applicable release gates above have direct evidence and authorized review. This roadmap intentionally records external blockers as external rather than inventing acceptance.
