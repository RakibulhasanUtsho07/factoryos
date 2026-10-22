# Finance integration contract and governed financial facts

**SRS traceability:** FactoryOS AI SRS v2.1 — FR-FIN-03 (P1), FR-FIN-04 (P1), FR-FIN-08 (P1), FR-FIN-09 (P0), with the existing commercial quotation lifecycle (FR-FIN-01) and should-cost engine (FR-FIN-02).

This is a read-side integration and financial-input contract. An external accounting platform remains authoritative for its GL, AP, AR, bank-reconciliation and tax/e-invoice records. FactoryOS stores attributed, immutable copies of explicitly mapped facts so operations and finance can explain margin and working-capital drivers. It does **not** post journal entries, payments, bank transactions, tax submissions or accounting changes.

## API contract

All endpoints use the authenticated tenant and factory context, PostgreSQL tenant RLS, IAM permission guards and existing request/trace correlation. The caller cannot choose a different tenant or factory via the financial fact body. Write calls require the **Idempotency-Key** header; a repeated key with a different normalized request returns **409 Conflict**.

| Method and route | Permission | Purpose |
|---|---|---|
| POST /api/finance/connectors | finance.connectors.write | Register a connector in PENDING_APPROVAL |
| GET /api/finance/connectors | finance.connectors.read | List factory-scoped connector configurations and last-ingestion freshness/status |
| GET /api/finance/connectors/:id | finance.connectors.read | Read a single connector's safe configuration and last-run summary |
| POST /api/finance/connectors/:id/approve | finance.connectors.approve | Activate a connector using independent maker-checker approval |
| POST /api/finance/connectors/:id/reject | finance.connectors.approve | Reject a pending connector with a reason |
| POST /api/finance/connectors/:id/pause | finance.connectors.write | Pause an active connector without deleting history |
| POST /api/finance/connectors/:id/facts | finance.facts.ingest | Ingest a normalized, idempotent batch of 1–500 facts (non-FILE_IMPORT modes) |
| POST /api/finance/connectors/:id/file-import | finance.facts.ingest | Import a validated CSV or JSON file through a FILE_IMPORT connector, retaining source filename, format and payload SHA-256 |
| GET /api/finance/facts | finance.facts.read | Query immutable source facts and reconciliation status |
| GET /api/finance/reconciliations | finance.reconciliation.read | List open/resolved/waived quantity or rate mismatches |
| POST /api/finance/reconciliations/:id/review | finance.reconciliation.review | Resolve or waive a mismatch with reviewer/reason retained |
| GET /api/finance/margin/inputs | finance.margin.read | Read period-scoped actual/forecast revenue, cost, margin and variance inputs |
| GET /api/finance/working-capital/inputs | finance.working_capital.read | Read currency-separated positions and horizon cash inputs |

Connector and financial-fact read APIs intentionally omit secret material. Credentials are represented only by a secret-manager reference (vault://... or secret://...), never an inline token/password/API key. Live endpoints must use HTTPS without credentials embedded in the URL.

## Connector domains and fact mapping

A connector is scoped to one tenant and factory and has a stable code, source-system label, domain, declared mode and optional endpoint/secret reference. Configuration, connector code and the system-of-record flag are immutable after creation; to change the integration contract, register a new code. At most one pending or active connector per standard domain (GL/AP/AR/bank/tax) may be marked as a reporting source in a tenant/factory, preventing two configured accounting sources from being silently aggregated. Reporting fact types are deliberately partitioned: GL owns cost/GL/inventory facts, AR owns revenue/shipment/receivable facts, AP owns payable/commitment/LC facts, bank owns bank balance, and tax/e-invoice owns tax liability. CUSTOM connectors are enrichment-only and cannot feed aggregate financial reports until their facts are mapped into an owned domain. A creator cannot approve or reject their own connector. Pause is the reversible operational safety switch.

| Domain | Allowed fact types |
|---|---|
| GL | GL_BALANCE, INVENTORY_VALUE, actual/forecast revenue, cost and contribution-cost facts |
| AP | AP_OPEN, OPEN_PO_COMMITMENT, LC_EXPOSURE, TAX_LIABILITY |
| AR | AR_OPEN, SHIPMENT_MILESTONE, actual/forecast revenue |
| BANK_RECONCILIATION | BANK_BALANCE |
| TAX_EINVOICE | TAX_LIABILITY, ACTUAL_REVENUE |
| CUSTOM | A specifically governed custom mapping, within the same source/actor guards |

The allowed domain-to-fact mapping is checked both in the API and in the database trigger. Each standard domain has at most one pending/active reporting source; reports include only active reporting connectors, and response readiness flags list missing required domains. Pausing a source stops its facts from being treated as current reporting input until another source is approved. An AR connector cannot write arbitrary cost facts. A connector run and each fact retain the connector, external record key, source record reference, effective/due timestamps, currency, dimensions, normalized payload snapshot and SHA-256 request/fact hash. An external fact ID can be ingested only once per connector scope; an idempotent retry returns the existing batch rather than duplicating balances or revenue.

MANUAL, REST_API, WEBHOOK, FILE_IMPORT, FILE_EXPORT, ERP_IMPORT, ERP_EXPORT, SFTP_IMPORT and SFTP_EXPORT are declared contract modes. The authenticated finance fact API and bounded UTF-8 CSV/JSON import (up to 2 MiB / 500 facts) share the same idempotency, domain, evidence and receipt gates. Imports should first call the dry-run validation endpoint; only a `VALID` report for the exact connector, batch, filename, format and payload SHA-256 may be committed. Validation reports preserve row/field error codes, counts, checks, correlation IDs and checksum; successful import receipts preserve the source filename, format, SHA-256, accepted/mismatch counts and trace references. File exports produce deterministic CSV/JSON artifacts with an immutable checksum receipt and support exact-request idempotent replay. SFTP connector configuration requires a secret-manager reference and pinned host-key fingerprint. A deployment-specific `FINANCE_SFTP_TRANSPORT` adapter must resolve credentials from the secret manager, pin DNS/egress, verify the remote host key, make uploads idempotent, and safely archive/quarantine source files. The API deliberately fails closed with service unavailable when no verified SFTP transport adapter is registered. `ERP_IMPORT`/`ERP_EXPORT` use the `FINANCE_ERP_TRANSFER` adapter port for provider-specific REST/file mapping. The adapter must resolve secrets externally, enforce outbound hostname/IP allowlists and DNS pinning, normalize source records, and acknowledge batches only after durable receipts. The adapter is optional and the API fails closed when it is not registered; no adapter may bypass the governed finance domain, source-of-record or database invariants.

## Governed financial facts

The financial_facts ledger is append-only. Corrections must arrive as a new externally identified source record/revision rather than mutating old evidence. Each row has a source system/connector, a source fact key, source record type/reference, effective_at, optional due_at, currency, exact decimal amount, and optional customer/product/order/cost-centre/shipment dimensions. Product/order foreign keys, when supplied, must belong to the same tenant and factory.

Amounts and quantity/rate evidence remain decimal strings through API validation and use PostgreSQL numeric, not binary floating point. Currency codes use uppercase three-letter codes. Amount signs are allowed for GL/bank balances and for actual/forecast revenue/cost adjustment events; open AR/AP, inventory, purchase commitment, LC, shipment and tax-liability values must be non-negative.

For period margin inputs, effective_at is the accounting/forecast period date. For balance-position inputs, it is the effective date of the position snapshot. Margin and working-capital calculations include only connectors marked as the standard domain’s reporting authority. Forecast snapshots are selected by connector + fact type + source fact key + currency and the latest ingested version; balance positions are selected as of the requested date using the latest effective snapshot, rather than summing all prior daily balances. Integrators should use a stable source_fact_key for each distinct line/position and include period identity in the key when multiple forecast periods are present.

## Operational quantity/rate reconciliation (FR-FIN-08)

A fact can include source quantity, source rate and UOM as a complete evidence tuple. Once that tuple is supplied, a reconciliation is mandatory in the same transaction; a deferred database constraint prevents quantity/rate facts from committing without reconciliation evidence. A reconciliation additionally names the expected internal/source record and quantity/rate values with explicit non-negative tolerances. Expected quantity/rate/UOM are resolved against an in-scope approved operational record, not trusted from the caller: an approved order line, approved PO line, posted goods-receipt line or utility meter reading. The caller-supplied expected values must exactly match that authoritative record; source amount currency must match as well. Only the incoming financial fact's observed quantity/rate is compared to the operational evidence using the explicit tolerances. Comparison uses exact decimal arithmetic. Convert quantities before submitting if source and expected UOMs differ.

MATCHED versus MISMATCH is computed from source-vs-expected quantity and rate deltas in the service and re-derived by a database trigger. Reconciliation values must match the immutable financial fact's own source evidence. An open mismatch remains visible and sets the affected margin or working-capital response reporting_ready=false. Only a different reviewer from the fact ingester may transition an open mismatch to RESOLVED or WAIVED, and an explanatory reason plus reviewer/time are retained. Waiving does not erase the mismatch evidence.

## Margin input semantics (FR-FIN-03)

GET /api/finance/margin/inputs?from=...&to=... returns groups by currency, customer, product, order and cost centre. It never adds unlike currencies together; no implicit FX conversion is made. Finance teams must explicitly map facts into a single supported reporting currency through their connector/mapping before cross-currency rollups.

- actual_gross_margin = actual_revenue - actual_cost
- actual_contribution_margin = actual_revenue - actual_contribution_cost
- forecast_gross_margin = forecast_revenue - forecast_cost
- forecast_contribution_margin = forecast_revenue - forecast_contribution_cost
- Revenue, gross-cost, contribution-cost, gross-margin and contribution-margin variances are actual minus forecast. A positive cost variance is an unfavorable cost overrun; a positive revenue/margin variance is above forecast.

Contribution-cost input is kept separate from gross cost so factory teams can decide which variable/direct cost classes belong in the contribution definition. It must be sourced/mapped explicitly; FactoryOS will not silently estimate contribution cost from gross cost. If there are no suitable facts for a group, returned sums are zero for the requested window, while missing actual revenue leaves margin-percent undefined (null), not 0%.

This is a governed input/query layer, not yet a full profitability workbench with internal operational-cost auto-posting, allocation policies, customer dashboards, forecast creation/revision workflow or reconciliation to every production/inventory ledger. Use the should-cost assessment as a separately governed planned-cost snapshot; do not label it as actual cost.

## Working-capital and cash inputs (FR-FIN-04)

GET /api/finance/working-capital/inputs?as_of=...&horizon_days=30 selects latest eligible position facts as of as_of and returns one row per currency. Source facts include:

- AR_OPEN: open receivables (with due date).
- AP_OPEN: open payables (with due date).
- BANK_BALANCE: current reconciled bank balance; signed balances/overdrafts are allowed.
- INVENTORY_VALUE: inventory value at an as-of date.
- OPEN_PO_COMMITMENT: unreceived/open purchase commitments (with expected due date).
- LC_EXPOSURE: outstanding letter-of-credit exposure (with expected due date).
- SHIPMENT_MILESTONE: expected shipment-linked cash/inflow milestone not already represented by an open invoice.
- TAX_LIABILITY: tax/e-invoice liability (with due date).

The output's net_working_capital = receivables + inventory_value - payables. forecast_inflows combines receivables due by the horizon with shipment inflow milestones dated within the horizon. forecast_outflows combines payables, open PO commitments, LC exposure and tax liabilities due by the horizon. projected_cash_at_horizon = bank_balance + forecast_inflows - forecast_outflows. These are transparent source-based inputs, not a bank-reconciled cash ledger, accounting valuation or probabilistic prediction. Avoid representing the same shipment value both as SHIPMENT_MILESTONE and AR_OPEN, or it will be counted twice.

Working capital and margin amounts are reported independently by currency so users do not mistake a mixture of BDT, USD, EUR and other currencies for a valid total. The caller should compare data freshness from effective_at/due_at and connector runs before relying on the forecast; absent/incomplete upstream domains are not synthesized by this slice.

## Database safeguards and eventing

Migration 114_finance_integration_contract.sql introduces five forced-RLS tables: finance_connectors, finance_connector_runs, financial_facts, finance_fact_reconciliations and finance_connector_history. Composite foreign keys preserve tenant/factory scope, unique external IDs and idempotency keys block replay duplicates, triggers enforce immutable facts and reconciliation evidence, connector-domain compatibility, maker-checker approval and secret-key exclusion in JSON snapshots. Connector changes, fact batch ingestion and reconciliation review append audit events and transactional outbox events.

## SRS traceability and limits

| Requirement | Status of this slice |
|---|---|
| FR-FIN-03 — actual/forecast revenue, gross/contribution margin, variance by business dimension | Governed fact schema, read API, grouped gross/contribution margin + revenue/cost/gross-margin variance inputs; full workbench/allocation and automatic operational actual-cost feeds remain separate |
| FR-FIN-04 — AR/AP, inventory value, open PO, LC and shipment cash forecast | Currency-separated inputs, as-of position semantics and deterministic horizon arithmetic provided; automatic feeds, bank reconciliation adapter and advanced cash scenarios remain separate |
| FR-FIN-08 — reconcile operational quantities/rates before finance reporting | Exact qty/rate/UOM matching, immutable evidence, reviewer disposition and reporting_ready gates implemented; per-source mappings/adapters must submit the records |
| FR-FIN-09 — configurable GL/AP/AR/bank/tax connectors and explicit system-of-record boundaries | Connector registry, permissions/maker-checker, secured read-side ingestion and no-posting boundary implemented; provider-specific transport/polling/webhook/file adapters remain separate |
| FR-FIN-01 / FR-FIN-02 | Continue to use docs/commercial-quotation-lifecycle.md and docs/should-cost-engine.md; finance facts do not replace quotation revisions or should-cost evidence |


## ERP / file exchange API (FR-PROD-12, FR-PROD-13, FR-PROD-15, FR-PROD-27)

All paths below are beneath `/api/finance/connectors`, authenticated with tenant/factory middleware and protected by existing IAM permissions. Write endpoints require `Idempotency-Key`.

| Method and route | Permission | Purpose |
|---|---|---|
| POST `/:connectorId/file-import/validate` | `finance.facts.ingest` | Dry-run CSV/JSON validation; writes no financial facts |
| GET `/:connectorId/file-import/reports` | `finance.facts.read` | List latest validation reports |
| GET `/:connectorId/file-import/reports/:reportId` | `finance.facts.read` | Read detailed row/field errors and checks |
| POST `/:connectorId/file-import/commit` | `finance.facts.ingest` | Import only against the matching `VALID` report |
| GET `/:connectorId/file-imports/receipts` | `finance.facts.read` | List immutable successful import receipts |
| GET `/:connectorId/file-imports/:runId/receipt` | `finance.facts.read` | Read one file-import receipt |
| POST `/:connectorId/sftp-import/process` | `finance.facts.ingest` | Poll one file through the registered, host-key-verifying SFTP adapter |
| POST `/:connectorId/erp-import/process` | `finance.facts.ingest` | Poll and validate one provider batch through the registered ERP adapter; durable receipt is required before acknowledgement |
| POST `/:connectorId/file-export` | `finance.facts.export` | Export approved active reporting facts to CSV/JSON (max 500 rows / 2 MiB) |
| GET `/:connectorId/file-exports/receipts` | `finance.facts.read` | List immutable export receipts |
| GET `/:connectorId/file-exports/:receiptId` | `finance.facts.read` | Retrieve the receipt and, for file exports, the base64 artifact |

### Validation, commit and retry semantics

- CSV and JSON are UTF-8, canonical base64 when submitted to the API, and bounded to 2 MiB and 500 facts. Unknown/duplicate CSV headers, malformed quoting, invalid JSON, path-like filenames, invalid DTO fields, secret-bearing metadata and unsupported fact/domain combinations are rejected.
- A validation report is append-only and tenant-RLS protected. Errors include row (when known), field, constraint code and safe explanatory message; the report stores at most 100 individual errors and marks the list truncated when more exist. Invalid-report detail also returns a downloadable escaped UTF-8 CSV error file with a SHA-256 checksum. It includes total/valid/invalid row counts and the checks executed.
- A `VALID` report is bound to the exact payload hash, file name, format, batch reference, connector, tenant and factory. Commit re-parses the file and compares this evidence inside the transaction before writing facts. A changed file cannot reuse a prior report. Invalid reports remain inspectable but cannot be committed.
- A successful import creates an immutable run receipt in the same transaction as the financial facts, reconciliation evidence, audit event and outbox event. A repeated identical key returns the same receipt; a different request under the same key conflicts.
- Export selection includes only facts from the active reporting source for that domain. It does not post to the accounting system or mutate source facts. Exports over 500 rows or 2 MiB must use the existing governed tenant-export job instead. File artifacts use content-derived names and SHA-256 checksums.
- SFTP remote paths must be direct children of the configured remote directory; basename validation and an optional configured file pattern run before acknowledgement. A successfully imported duplicate payload is recognized by SHA-256. Validation failures are quarantined where the configured adapter supports archive/quarantine, while archive failures return an explicit pending status for safe retry.
- The connector registry and pinned endpoint/host-key checks define the security boundary; actual transport credentials are never stored inline. The `FINANCE_SFTP_TRANSPORT` and `FINANCE_ERP_TRANSFER` adapters are optional and the API fails closed if a reviewed deployment adapter is not registered.

### SRS coverage boundary

FR-PROD-15 is covered for bounded finance ERP file exchange by dry-run validation, stored validation/error reports, import/export receipts, checksums, idempotent commit/replay, audit events and tenant scope. The pre-existing SaaS tenant export/migration job remains the asynchronous path for larger tenant-wide datasets. As of 2026-10-22, a named Microsoft Dynamics 365 Business Central Finance Exchange v1 REST adapter, Vault KV-v2 secret resolver, DNS pinning, exact hostname/IP allowlist enforcement, and adapter/Vault contract specs are present; see docs/finance-erp-production-connectors.md. The Business Central provider endpoint depends on a reviewed custom AL extension, and no live provider connection is claimed. SFTP still fails closed until a reviewed FINANCE_SFTP_TRANSPORT implementation is registered. Production/staging credentials, provider fault-injection and finance/security sign-off remain explicit release gates.
