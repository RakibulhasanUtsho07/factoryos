# Deterministic should-cost engine

**SRS traceability:** FactoryOS AI SRS v2.1 FR-FIN-02 (P0) and acceptance scenario AS-61. This backend slice calculates material, labour, energy, freight, duty, overhead and scrap costs for a product version, order or quotation revision. Every category has a governed formula and retained source evidence. It does not post journals or replace the accounting system of record.

## Workflow and endpoints

All routes are under /api and require verified tenant/factory context, IAM permissions, tenant RLS and database business guards. Write calls use an Idempotency-Key header; lifecycle decisions use expected_version and a reason.

| Method and route | Permission | Purpose |
|---|---|---|
| POST /api/should-cost/profiles | should_cost.profiles.write | Create a new profile version with all seven category formulas |
| GET /api/should-cost/profiles | should_cost.profiles.read | List versions by profile, product and status |
| GET /api/should-cost/profiles/:profileId | should_cost.profiles.read | Read formula definitions and profile history |
| POST /api/should-cost/profiles/:profileId/submit | should_cost.profiles.submit | Validate all seven formulas and submit |
| POST /api/should-cost/profiles/:profileId/approve | should_cost.profiles.approve | Independent maker-checker approval and publish current version |
| POST /api/should-cost/profiles/:profileId/reject | should_cost.profiles.approve | Reject a pending profile with a reason |
| POST /api/should-cost/assessments | should_cost.assessments.calculate | Calculate a deterministic estimate and retain evidence |
| GET /api/should-cost/assessments | should_cost.assessments.read | List assessments by scope type/id |
| GET /api/should-cost/assessments/:assessmentId | should_cost.assessments.read | Return category totals, gross-margin snapshot, evidence and history |

A profile version is a formula contract, not a mutable spreadsheet. Create a new profile version to change currency, output unit, category method, required/optional policy or cost-base dependency. A profile must define every category exactly once. Submission requires all seven category definitions; only an independent user can approve/reject it. Approval publishes it as current and supersedes the previous current version without changing the prior records.

## Formula contract

Calculation formula version: factoryos.should-cost.v1. Arithmetic uses integer-backed fixed-point decimal values rather than binary floating-point aggregation. Category order is deterministic: material → labour → energy → freight → duty → overhead → scrap. Costs and component totals are rounded to four decimal places in the costing currency; quantities use six decimal places, unit rates eight, FX rates ten and percentages four. Cost per output unit is rounded to eight decimal places. Component totals are added in canonical order.

| Category | Allowed formula | Calculation |
|---|---|---|
| Material | DIRECT_RATE | Quantity × unit rate |
| Labour | DIRECT_RATE | Approved routing time in hours × labour rate |
| Energy | DIRECT_RATE | Allocated utility consumption × meter/rate-card unit cost |
| Freight | DIRECT_RATE or FIXED_PER_BATCH | Shipment quantity × rate, or fixed shipment cost allocated to the assessed batch |
| Duty | DIRECT_RATE or PERCENT_OF_BASE | Explicit charge or policy percentage of selected preceding cost categories |
| Overhead | DIRECT_RATE, FIXED_PER_BATCH or PERCENT_OF_BASE | Explicit charge, allocated batch amount or selected preceding cost categories |
| Scrap | DIRECT_RATE or SCRAP_GROSS_UP | Explicit scrap charge, or base × rate / (100% − rate) to account for yield loss |

Percentage formulas may only depend on earlier categories, so cycles and forward dependencies are rejected. Base categories must be unique. Scrap gross-up requires a rate strictly below 100%. Negative rates, quantities and amounts are rejected. N/A is not a silent zero: an optional category needs a dedicated NOT_APPLICABLE evidence row with its reason. Required categories cannot be marked N/A.

The calculator returns total cost, cost per output unit and category totals. Product-version assessments do not claim revenue or margin. Order/quotation assessments snapshot available revenue and any conversion FX rate before deriving gross-margin amount and percentage. This is an estimate from supplied operational and rate evidence; it is not a GL entry or a full actual-cost/profitability ledger.

## Evidence and operational source checks

Every category requires at least one evidence row, and every applicable row retains source type, reference, source date, notes, structured snapshot and a SHA-256 digest of normalized calculation inputs/outputs. The selected profile formula and evidence formula must match.

- **Material:** for BOM evidence, the source must be an approved same-factory product-version BOM line. The service recalculates BOM quantity × target product quantity × (1 + configured wastage) and rejects a submitted quantity or unit that does not match. An order or quotation assessment must contain that source product.
- **Labour:** routing evidence must reference an approved same-factory route step. Expected hours derive from setup + run-per-unit × the product target quantity + queue + transfer, divided by 60. An order/quotation source must contain that product; manual quantities require an explicit snapshot and reference.
- **Energy:** utility-reading evidence must point to a stored same-factory meter reading. Input quantity, unit, historical rate and currency are checked against the persisted reading/meter snapshots. If the reading is associated with production quantity, the service derives allocated energy deterministically; otherwise it retains the reading's consumption allocation.
- **Freight, duty, overhead and scrap:** applicable evidence requires a typed source and structured snapshot such as a carrier quote, purchase record, duty schedule, approved rate card, overhead policy or quality standard. Percentage methods still require dated evidence of the applied rate/formula.
- **Currency:** direct/fixed costs are converted with commercial_exchange_rates rates effective on or before the source date and database current date. The applied FX rate, effective date and source are snapshotted per evidence row. Same-currency costs use an identity rate. The engine fails closed if a needed cross-currency rate is absent.

The output is repeatable from the saved formula version, normalized inputs, source snapshots and applied FX rates; later changes to BOM, routing, utility rate, cost policy or FX history do not rewrite a prior assessment. Recalculating means creating a new assessment.

## Approval and database integrity

- Every profile, assessment and evidence set is tenant/factory scoped with composite foreign keys and forced PostgreSQL RLS.
- Profile formulas, assessments, component evidence and history are append-only. Profile decisions use optimistic row versions and maker-checker; identity and decision reason are protected by database triggers.
- A ready assessment can only use the currently approved profile. Its scope must point to an approved product version, a non-cancelled/non-closed order, or a live current quotation revision in the same factory.
- A deferred database constraint verifies that all seven evidence categories exist and that required components are applicable before an assessment transaction can commit. A database trigger ensures evidence formula/base categories match the profile formula.
- Quotation transition to APPROVED is blocked unless a READY should-cost assessment exists for the exact current quotation revision. Revising a quotation therefore requires a new costing assessment before its revised version can be approved.
- Every profile/assessment decision writes append-only history and a transactional outbox event. Writes are idempotent; reuse of an idempotency key with a different request conflicts.

## Example assessment payload

The request below shows the contract shape; UUIDs, profile and references must be replaced with records from the caller's authenticated factory.

    {
      "scope_type": "PRODUCT_VERSION",
      "target_id": "approved-product-version-uuid",
      "profile_id": "approved-current-profile-uuid",
      "target_quantity": 100,
      "target_unit": "PCS",
      "evidence": [
        {
          "category": "MATERIAL",
          "line_number": 1,
          "applicable": true,
          "input_quantity": 125,
          "unit_code": "M",
          "unit_rate": 20,
          "source_currency": "BDT",
          "source_type": "SUPPLIER_QUOTE",
          "source_reference": "supplier-quote:ref-123",
          "source_as_of": "2026-10-01",
          "quantity_source_type": "BOM",
          "quantity_source_reference": "bom-line-uuid",
          "source_snapshot": {
            "quote_line": "cotton-fabric-001",
            "quoted_unit_rate": "20.00000000"
          },
          "notes": "Rate copied from dated supplier quotation"
        }
      ]
    }

The assessment must provide evidence for all seven categories; this shortened payload is illustrative and will be rejected until all remaining evidence rows are supplied. An N/A example is valid only for a category that the approved profile marks optional, with applicable false, source type NOT_APPLICABLE and a reason in notes.

## Verification and traceability

- Unit contract: services/api/src/should-cost/should-cost-engine.spec.ts covers deterministic calculation, all seven category totals, currency conversion, evidence completeness, category dependency validation and positive/negative margin arithmetic.
- PostgreSQL contract: services/api/test/should-cost.sql verifies forced tenant RLS, IAM/migration registration, profile formula restrictions, immutable records, maker-checker and quotation approval gating.
- CI: the API PostgreSQL workflow applies migrations/113_deterministic_should_cost_engine.sql and runs the should-cost SQL contract before TypeScript build and the complete Jest suite.

| Requirement | Status |
|---|---|
| FR-FIN-02 / AS-61 — deterministic configurable should-cost with source evidence, including all seven categories | Implemented by approved versioned profiles, fixed-point formula calculation and immutable per-category evidence |
| Approval blocked when required costing evidence is missing | Implemented for quotation approval of the exact current revision; assessment transaction requires all seven categories |
| FR-FIN-03 — full actual/forecast profitability, contribution margin and variance by customer/product/order/factory | Not claimed complete; this slice derives estimate gross margin for order/quotation but does not implement full profitability/actual-cost ledger |
| FR-FIN-08 — reconciliation of operational quantities/rates against source records before financial reporting | BOM/routing/utility checks are implemented for costing evidence; complete finance-close reconciliation remains separate work |
