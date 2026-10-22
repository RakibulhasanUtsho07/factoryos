# Growth outcome integration and statistical calibration — 2026-10-23

## Scope and production boundary

This slice adds **read-side adapters to existing FactoryOS source-of-record ledgers**. It does not claim that ERP/finance provider polling is automatically deployed: financial facts must already have been ingested through an approved, active Finance reporting connector; production outcomes are read from the immutable production-output/inventory posting ledger. No Finance posting or production stock mutation occurs through the Growth endpoints.

Adapter contract: `factoryos.growth.source-of-record.v1`.

### Supported source mappings

| Source of record | Supported metric keys | Measurement unit | Provenance pin |
|---|---|---|---|
| Approved active Finance reporting connector / `financial_facts` | `finance.actual_revenue`, `finance.actual_cost`, `finance.actual_contribution_cost`, `finance.forecast_revenue`, `finance.forecast_cost`, `finance.forecast_contribution_cost`, `finance.inventory_value`, `finance.open_po_commitment`, `finance.accounts_receivable`, `finance.accounts_payable`, `finance.bank_balance` | Source currency (ISO-style three-letter code) | Source fact ID, effective time, `fact_hash`, adapter version |
| Accepted production output / `production_output_postings` | `production.good_quantity`, `production.scrap_quantity`, `production.yield_percentage`, `production.cumulative_yield_percentage` | Finished-item canonical inventory unit for quantities; `pct` for yield | Posting ID, posting time, immutable `request_hash`, adapter version |

Forecast/commitment/position Finance metrics can be retained as forecasts/context observations but the source-backed realized-experiment endpoint rejects forecast-only Finance keys as actual outcomes. Missing/out-of-scope source rows, inactive or non-reporting Finance connectors, duplicate IDs, unsupported metrics, units or invalid hashes fail closed. Source amount and unit are always read from the canonical row rather than accepted as caller-provided numbers.

## API contract

All endpoints use the active authenticated tenant/factory scope and Growth permissions.

- `POST /growth/opportunities/:opportunityId/source-observations/sync` — body: `source_kind` (`FINANCIAL_FACT` or `PRODUCTION_OUTPUT`), 1–50 canonical `source_record_ids`, 1–8 allowlisted `metric_keys`, and stable `idempotency_key`. The maximum expanded set is 400 measurements per call.
- `GET /growth/opportunities/:opportunityId/source-observations` — filter pinned observations by source kind, metric key and bounded page size.
- `POST /growth/experiments/:experimentId/results/from-source` — map each KPI to immutable baseline and actual observation IDs, with declared direction/optional target plus experiment assessment and stop-condition flag. Values, unit, evidence reference and `observed_at` are reconstructed from the saved observations; callers cannot override them. The baseline timestamp must precede the actual timestamp, KPI key/unit/source kind/version must match, and all KPI actuals in a single experiment-result snapshot must share one observed timestamp.

The source sync writes immutable run and observation rows, links each measurement to a source snapshot in `growth_opportunity_evidence`, emits a transactional outbox event, and records an audit event. The deterministic input fingerprint includes adapter version, tenant/factory/opportunity scope, source kind, sorted source IDs and sorted metric keys, but not the submitting user. Per-observation SHA-256 fingerprints include source ID, value, unit, timestamp, revision hash and adapter version. Replaying the same idempotency key with changed inputs conflicts.

## Calibration policy governance

`POST /growth/calibration-policies` creates a versioned policy keyed by domain, model version, KPI key and unit. The proposed policy defines a minimum observation count and maximum tolerable MAE, RMSE, absolute bias, sMAPE and absolute nominal-coverage gap. Policy creation requires `growth.write`; review uses `growth.review` via `POST /growth/calibration-policies/:policyId/decision`. Maker-checker separation is enforced in both API and PostgreSQL: the author cannot approve/reject their own policy, a reason is required, the final decision is immutable and a configuration change requires a new policy version.

The default policy sample floor is 10 because the policy requires a floor, not because ten observations establish statistical confidence or power. A reviewer must choose appropriate thresholds and sample sizes for the actual KPI, unit, operating domain and decision risk. No thresholds are silently invented or auto-approved.

Calibration reporting is available at `GET /growth/opportunities/:opportunityId/forecast-evaluations/calibration?domain=FINANCE` (the domain filter is optional only when no ambiguity exists). Cohorts are kept separate by model version, metric, unit, declared nominal coverage **and interval semantics**. Only matching approved policy versions assess configured error thresholds. An absent policy returns `NO_APPROVED_POLICY`; a cohort below the policy sample floor returns `INSUFFICIENT_POLICY_SAMPLE`; ambiguous cross-domain policies require the caller to select a domain.

## Uncertainty semantics

The forecast evaluator is deterministic and fixed-point based (`factoryos.growth.forecast-evaluation.v1`). It records signed error, absolute error, RMSE inputs, sMAPE and, if a nominal target was explicitly declared, empirical hit rate and the observed-minus-nominal coverage gap.

- `HEURISTIC_RANGE` means bounds were supplied without a declared nominal coverage. It can report range hits/width as descriptive facts, but coverage calibration is returned as `NOT_CALIBRATABLE_HEURISTIC_RANGE`.
- `DECLARED_NOMINAL_COVERAGE` enables empirical coverage comparison only after enough matching observations exist.
- `NONE` means no interval was supplied; no interval coverage is inferred.

A heuristic `uncertainty_pct`, upside/downside range or sensitivity envelope is never called a confidence interval or a calibrated prediction interval. The system does not automatically refit models and does not infer nominal coverage from observed hit counts.

## Scenario reproducibility

The existing Growth scenario/sensitivity path keeps its model version, data vintage, baseline source reference, normalized input snapshot, constraint snapshot, output snapshot, canonicalization version and SHA-256 input hash immutable. Replaying the same canonical versioned inputs is deterministic; later evidence or source observations do not rewrite prior scenarios. The newly added source observations provide revision-pinned evidence for future scenario inputs, but existing scenarios remain historical snapshots and should be explicitly rerun when a new vintage is wanted.

## Verification map

| Requirement | Evidence |
|---|---|
| Source-of-record allowlist and revision/unit conversion | `growth-source-of-record-adapters.spec.ts` |
| Authoritative source observation sync, stable fingerprint, cross-adapter rejection and missing-source rejection | `growth-source-observation-sync.spec.ts` |
| Baseline/actual feed, actual timestamps, evidence links and forecast rejection | `growth-source-of-record.service.spec.ts` |
| Source observation RLS, canonical row/value/unit/time/revision guard, append-only and evidence cross-link contracts | `services/api/test/growth-kpi-source-observations.sql` |
| Calibration sample floors, approved-policy matching, domain ambiguity and heuristic-range semantics | `growth-calibration-policy-report.spec.ts`, `growth-forecast-evaluation.spec.ts` |
| Calibration policy RLS, version constraints, immutable configuration and maker-checker guard | `services/api/test/growth-calibration-policies.sql` |
| DDL apply/reapply | API PostgreSQL CI replays migrations 177 and 178 and runs both SQL contract files |

## Known deployment gates

1. Activate and validate the actual customer's Finance reporting connector, source-fact schema mapping, currency/period policy and freshness service-level objective.
2. Decide whether production event timestamps need finer grain than the existing production posting's canonical created timestamp, or whether an external shop-floor KPI feed is required.
3. Have domain owners approve thresholds and minimum sample sizes based on real history and risk; no production calibration is claimed until the relevant sample counts and review approvals exist.
4. For statistically calibrated prediction intervals, choose and validate a suitable method (for example, held-out residual quantiles or conformal calibration) under documented time-series/drift assumptions. This work records and compares declared nominal coverage; it does not itself make forecasts statistically calibrated.
5. Run final API and PostgreSQL CI on the exact release candidate SHA before merge/release.

