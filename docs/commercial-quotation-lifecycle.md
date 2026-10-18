# Commercial quotation, pricing and order conversion

This slice implements the versioned quotation-to-order record required by FactoryOS AI SRS v2.1 **FR-FIN-01 (P0)** and supports the customer-commercial history described by **FR-SUP-04**. Acceptance scenario AS-61 also calls for should-cost and margin views; those require the separate FR-FIN-02 cost-component/evidence model and are not represented as completed by this quotation slice.

## Lifecycle

A quotation starts as **DRAFT**. A creator can revise a draft or rejected quotation; each revision creates a new immutable quotation-version row and immutable line snapshots. The current revision number and master-record optimistic version advance separately. Submission either moves to **PENDING_APPROVAL** or **APPROVED** when the effective policy does not require maker-checker approval. Only a different user can approve or reject a submitted quotation. Approved quotations can be marked sent; sent quotations can be accepted; only accepted, in-date quotations can be converted to an order. Cancellation follows the database and service transition graph.

Each decision writes an append-only quotation_history record with actor, reason, request/trace identifiers, revision and (on conversion) order ID. Lifecycle events are inserted into the transactional outbox in the same PostgreSQL transaction. Quotation versions, line snapshots, exchange rates and history cannot be updated or deleted. Database triggers guard the state transition, actor identity, optimistic version increment and maker-checker rule independently of HTTP validation.

## HTTP endpoints

All endpoints use the global /api prefix and require authenticated user, tenant and factory context. The request factory_id on create-rule/rate/create-quote payloads must match the authenticated factory scope.

| Method and path | Permission | Purpose |
|---|---|---|
| POST /api/quotations | quotations.write | Create a quotation; accepts optional Idempotency-Key |
| GET /api/quotations | quotations.read | List/search by status, customer or quote number |
| GET /api/quotations/:id | quotations.read | Current revision, lines and full lifecycle history |
| GET /api/quotations/:id/revisions | quotations.read | All immutable commercial/FX/line snapshots |
| PATCH /api/quotations/:id/revise | quotations.write | Create the next revision using expected_version and a reason |
| POST /api/quotations/:id/submit | quotations.write | Submit for approval or auto-approve under policy |
| POST /api/quotations/:id/approve | quotations.approve | Independent approval |
| POST /api/quotations/:id/reject | quotations.approve | Reject with reason |
| POST /api/quotations/:id/send | quotations.send | Record dispatch of approved quote |
| POST /api/quotations/:id/accept | quotations.accept | Record customer acceptance |
| POST /api/quotations/:id/cancel | quotations.write | Cancel according to lifecycle rules |
| POST /api/quotations/:id/convert | quotations.convert | Atomically create an order and link it to the accepted quote |
| POST /api/quotation-rules and GET /api/quotation-rules | quotation_rules.write / quotation_rules.read | Create immutable pricing-rule versions and list versions |
| POST /api/exchange-rates and GET /api/exchange-rates | exchange_rates.write / exchange_rates.read | Record sourced, effective-dated FX rates and list rates |

All lifecycle commands require expected_version and a non-empty reason. Clients should reload the quotation after a 409 Conflict instead of retrying with a stale version.

## Pricing and currency behavior

- Pricing rules are scoped by tenant and factory. A customer-reference-specific current rule takes precedence over the factory default rule. Replacing a rule retires the old current version; historical rule versions and quotation snapshots remain readable.
- A missing configured rule falls back to a restrictive BDT-only policy: zero discount cap and approval required. A requested but unknown/inactive explicit rule is rejected.
- Rules contain base currency, supported currencies, default tax, maximum discount, approval-required flag, total threshold, discount threshold and incoterms/payment-term requirements. Those effective terms are copied into the quotation revision at creation time; later policy changes do not silently reprice an existing revision.
- Exchange-rate requests store currency as the source currency and base_currency as the target/base currency. For example, currency: USD, base_currency: BDT, rate_to_base: 120 represents 1 USD = 120 BDT. A quote uses the latest rate effective on or before the database's current date. The applied rate, effective date and source are snapshotted; the current market rate never silently rewrites an older quote.
- Quantities and unit prices use four decimal places; tax and discount percentages use two. Line subtotal, discount, tax and total are computed with integer-backed decimal arithmetic and rounded to four decimal places before storage. The revision includes quote-currency totals and a base-currency total.
- Manual discount values above the rule cap are rejected. Approval is required when the active rule says so, or when a configured approval total/discount threshold is met. Required incoterms and payment terms are checked on submission.
- Currency codes are restricted to uppercase three-letter codes. FX rates must be positive, have a non-empty source, and cannot be updated or deleted after recording.

## Transaction and data safety

The request actor and tenant are taken from verified request context, not arbitrary identity headers. All writes establish PostgreSQL transaction-local RLS context and use the authenticated factory scope. Composite tenant/factory foreign keys, forced RLS, row guards, optimistic versions and append-only evidence complement the application permission guards. Quote conversion locks the quote, validates the accepted state/revision, creates the order and order lines, marks the quote converted, appends history, and writes both outbox events in one database transaction. A same-order-number retry returns the prior conversion; attempting to convert the same quote to a different order number conflicts.

The resulting manufacturing order starts in DRAFT; order confirmation, inventory reservation and production release remain the existing order lifecycle's responsibility. Tax/incoterms/payment-term detail remains on the linked immutable quotation revision because the existing order schema does not yet own all commercial tax/term fields.

## Verification

- Unit contract: services/api/src/commercial/quotation-lifecycle.spec.ts covers allowed status transitions, decimal price/tax calculation, discount cap and currency normalization.
- PostgreSQL contract: services/api/test/commercial-quotation.sql checks forced tenant RLS, policy/permission/migration registration, append-only rate/rule/line evidence, invalid direct transitions and self-approval protection.
- CI: the API PostgreSQL workflow applies migrations/112_commercial_quotation_lifecycle.sql and runs the commercial SQL contract before the API build and complete Jest suite.

## SRS traceability and boundary

| Requirement | Coverage in this slice |
|---|---|
| FR-FIN-01 — versioned quotation-to-order commercial records, price, currency, tax, incoterms/payment terms, customer rules and approval history | Implemented with version snapshots, pricing rules, effective-dated FX, lifecycle/approval trail and accepted-quote conversion |
| FR-SUP-04 — quote/order/approval commercial history | Quotation history and order-linked conversion record implemented; RFQ, customer complaint/RMA and external customer communications remain separate slices |
| AS-61 / FR-FIN-02 — should-cost evidence and margin views, block approval when required cost components are missing | Not claimed complete here; a governed cost-component evidence model and approval gate must be built separately rather than inventing unsupported cost values |
