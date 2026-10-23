# Finance workbench acceptance evidence — 2026-10-22

**Task:** 19 — Finance costing, profitability and working-capital workbench  
**Branch:** `rakibul-hasan`  
**Candidate code/migration/test/workflow SHA:** `de5447776127cb8c3fea15e0ddb92a32da54f468`  
**Implementation status:** Backend and database contracts committed  
**Automated exact-SHA CI status:** PENDING VERIFICATION — do not mark PASS until the run's API and PostgreSQL jobs conclude successfully  
**Finance-owner close acceptance:** OPEN

## Implemented in the candidate

- Added `GET /api/finance/workbench` to return calendar-month actual/forecast costing and profitability, contribution margin, actual-minus-forecast variance attributed by mapped product/order/customer/cost center, operational quantity/rate variance by source/fact type and business dimensions, working-capital balances, cash-horizon projection, reporting-domain readiness, and unreconciled facts.
- Added a currency filter and strict currency separation. No implicit FX conversion is applied. Monthly bucketing is explicit UTC; report ranges are validated before SQL queries. Date-only end bounds include the full UTC calendar day in the workbench and existing margin/working-capital input APIs.
- Forecast versions are selected per connector/fact type/source key/currency/month. Actual facts remain immutable and separately identified.
- Overdue receivables/payables remain visible and are included in due-date cash horizon totals. Open PO commitments, LC exposure, bank position, inventory value and tax liability are presented by source currency.
- Added currency/period-specific finance-close snapshots with SHA-256 snapshot binding, expected row versions, append-only history, transactional audit/outbox events, forced tenant RLS, source-readiness submission gate (active reporting sources must also have at least one completed ingestion receipt), stale-snapshot approval rejection and independent maker-checker approval. Last-ingestion timestamps are exposed, but no arbitrary freshness-age threshold is enforced until a finance owner approves one.
- Added migration `170_finance_costing_profitability_close_workbench.sql`, inserted in the ordered `scripts/audit/migration-manifest.txt`.
- Added nine focused Jest cases in `services/api/src/finance/finance-workbench.service.spec.ts` covering currency/period outputs, open mismatch visibility, date-only UTC end bounds, missing-ingestion readiness, reversed-period validation, stale-snapshot approval refusal, creator self-approval refusal, independent approval audit/history/outbox, and idempotent transition replay/key collision. Added `services/api/test/finance-workbench-contract.sql` for database-side lifecycle/RLS/role assertions and wired it in `.github/workflows/api-postgres-ci.yml`. The workflow replays migration 170 after development-role seeding to verify idempotent DDL and role grants.
- Updated the Finance Integration Contract and HLD/Blueprint WP03/WP07 evidence matrix.
- No journal-posting, payment-execution, bank-write or tax-submission API was added.

## Automated evidence required

The candidate SHA above is the current branch head. The repository status query returned no combined status checks, and the available commit/workflow query returned no PR-triggered run for that SHA. Therefore the exact-SHA automated result is still **PENDING VERIFICATION**. Capture the push-triggered GitHub Actions result and verify:
1. API lint/build and the workbench service spec pass.
2. PostgreSQL CI applies the entire ordered migration manifest including migration 170, runs `finance-integration.sql` and `finance-workbench-contract.sql`, and passes the forced-RLS, maker-checker, approved-snapshot immutability and cross-tenant checks.
3. SRS/HLD/Blueprint traceability validation passes after the evidence matrix change.

The available repository metadata did not expose a completed push-triggered workflow result for this candidate; therefore this document intentionally records CI as **PENDING VERIFICATION** rather than fabricating a green result.

## Acceptance still required from Finance

- Compare a representative month-end close to the external source of record for GL/AP/AR/bank/tax, including inventory value, purchase commitments, LC exposure and due-date forecast.
- Confirm which forecast version wins for the named provider and accounting calendar, the factory/time-zone policy for period boundaries, and handling of overlapping PO/LC cash exposures.
- Reconcile all open quantity/rate mismatches or record a separately authorized, reasoned waiver before submission.
- Obtain independent finance-close approval on a real staging snapshot and record the reference, timestamp and exact tested SHA. No live source connection, staging credentials or finance-owner approval was available to fabricate in this change.

**Release decision:** Automated implementation is present, but production finance-close acceptance remains **OPEN** until exact-SHA CI evidence and a real finance-owner reconciliation/approval are recorded.
