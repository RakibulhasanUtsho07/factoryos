# Finance costing, profitability and working-capital workbench

**Task:** 19 — Finance costing, profitability ও working-capital workbench  
**SRS traceability:** FR-FIN-02, FR-FIN-03, FR-FIN-04, FR-FIN-08, FR-FIN-09; should-cost acceptance scenario AS-61; Finance Integration Contract.  
**Design boundary:** this is a governed read-side workbench and close-approval ledger. The external accounting platform remains the source of record for GL, AP, AR, bank reconciliation and tax/e-invoice records. FactoryOS must not post journals, execute payments, write bank transactions or submit taxes.

## Capabilities

- **Period and currency scoped inputs.** The workbench groups monetary facts by ISO currency and UTC calendar month inside the requested effective-time range. Date-only `to` bounds include the entire UTC calendar day; explicit timestamps retain their supplied instant. It does not add currencies together or apply an implicit foreign-exchange rate. Cross-currency comparison requires an explicitly governed FX policy/input rather than an inferred conversion.
- **Actual versus forecast.** Actual revenue, cost and contribution-cost facts are immutable reported actuals. Forecast inputs are reported separately; for each approved reporting connector, fact type, source key, currency and calendar month, the latest recorded forecast version is used. No forecast is silently relabelled as actual.
- **Margin and variance.** Gross margin = revenue − cost; contribution margin = revenue − contribution cost. Margin percentages are omitted when revenue is zero. Variance rows show actual minus forecast for revenue, cost, contribution cost, gross margin and contribution margin, with negative/positive sign retained.
- **Operational quantity/rate attribution.** Reconciliation rows remain linked to the external finance fact and same-factory operational source. The summary reports quantity variance at expected rate, rate variance at source quantity and their combined amount-equivalent difference. The source UOM must match the operational evidence UOM; conversions must happen before ingest. Open, resolved and waived mismatches remain separately visible, including fact/source references.
- **Working capital and cash horizon.** Position totals remain currency-separated: AR/open receivables, AP/open payables, inventory value, open PO commitments, LC exposure, bank balances and tax liability. A configurable 1–365 day cash horizon reports overdue AR/AP separately, eligible due-date inflows/outflows, and projected horizon-end cash. Overdue amounts are visible as a collection/payment risk and are not assumed to clear automatically; only amounts due after the as-of time and within the selected horizon enter forecast cash inflows/outflows. Scheduled shipment milestones are included when due inside the horizon. Undated items are not assumed to be timed cash movements.
- **Source-of-record readiness.** Aggregates include only active approved reporting connectors. The response lists required reporting domains, connector freshness evidence, open unreconciled fact count and a bounded set of unreconciled fact details. Missing source domains or open mismatches make the workbench's readiness false; a dashboard is not a replacement for finance sign-off.
- **Finance close.** A close period pins currency, explicit start/end dates, a deterministic snapshot hash and immutable transition history. Every close-period write requires an Idempotency-Key and lifecycle transitions also require the expected row version. It is created as DRAFT, can be refreshed only while DRAFT, and is submitted only when all required reporting domains are active and no open reconciliation mismatch exists in that currency and period. A reviewer distinct from both creator and submitter may approve it. Approval re-builds the snapshot and refuses the transition if governed inputs/readiness changed after submission. A replay of the same transition key/request returns its prior period state; reusing a key for different transition contents conflicts. Approved snapshots are immutable; they are not journal entries.

## API

All routes require the existing verified user/tenant/factory context, IAM permissions, transaction-local tenant RLS and audit correlation. Every POST route requires an `Idempotency-Key`; lifecycle retries are bound to an immutable request hash and optimistic row version.

| Method | Route | Permission | Behavior |
|---|---|---|---|
| GET | `/api/finance/workbench` | `finance.workbench.read` | Period margin, operational variance, working-capital/cash horizon, source readiness and unreconciled facts. Optional `from`, `to`, `currency`, `horizon_days`, `unreconciled_limit`. |
| GET | `/api/finance/close-periods` | `finance.close.read` | List close periods; filters: status, currency and date overlap. |
| POST | `/api/finance/close-periods` | `finance.close.write` | Create a currency/date-scoped DRAFT snapshot. Requires `Idempotency-Key`. |
| POST | `/api/finance/close-periods/:periodId/refresh` | `finance.close.write` | Rebuild a DRAFT snapshot with expected row version and a reason. |
| POST | `/api/finance/close-periods/:periodId/submit` | `finance.close.submit` | Rebuild and submit only if input-source and reconciliation readiness passes. |
| POST | `/api/finance/close-periods/:periodId/recall` | `finance.close.submit` | Return a submitted close to DRAFT, by its original submitter only. |
| POST | `/api/finance/close-periods/:periodId/approve` | `finance.close.approve` | Independently approve an unchanged submitted snapshot, using expected row version and an explanation. |

The pre-existing `GET /api/finance/margin/inputs`, `GET /api/finance/working-capital/inputs`, `GET /api/finance/reconciliations` and `GET /api/finance/facts` remain available as focused inputs/details. The new workbench consolidates those inputs without replacing source facts or should-cost evidence.

## Snapshot and lifecycle integrity

Migration `170_finance_costing_profitability_close_workbench.sql` adds `finance_close_periods` and append-only `finance_close_period_history`. Both tables use forced tenant RLS and scoped factory foreign keys. A database trigger blocks deletion, skips invalid transitions, enforces strictly incrementing row versions, binds actors to the authenticated database context, prevents self-approval and freezes approved snapshots. Every application transition appends history and a transactional audit/outbox record in the same database transaction.

A close snapshot carries the observed reporting-domain state, actual/forecast costing/profitability facts, period-end working-capital positions, currency policy, unreconciled mismatch count and a readiness decision. Hash mismatch between submitted and current source snapshot requires recall, refresh and resubmission rather than silently approving stale inputs.

## Verification and release gates

The PostgreSQL contract `services/api/test/finance-workbench-contract.sql` verifies close table RLS/policies, lifecycle triggers, permission/migration registration, independent approval, append-only history, immutable approved snapshot and cross-tenant invisibility. It runs in the API PostgreSQL CI workflow alongside the existing `finance-integration.sql` contract. The ordered manifest `scripts/audit/migration-manifest.txt` includes migration 170 and is checked by `scripts/audit/verify-migration-manifest.mjs`.

This automated contract is not a finance-close business approval. Production acceptance still requires a finance owner to verify sample month-end facts and forecast-version rules for each configured accounting source, sign off currency/period policies, compare a close snapshot with external GL/AP/AR/bank/tax records and approve the reconciliation. No live accounting side-effect is permitted, and no external system credentials or live-close sign-off are fabricated by this repository change.
