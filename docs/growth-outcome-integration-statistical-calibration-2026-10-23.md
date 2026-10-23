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
- `POST /growth/experiments/:experimentId/results/from-source` — map each KPI to immutable baseline and actual observation IDs, with declared direction/optional target plus experiment assessment and stop-condition flag. Values, unit, baseline evidence ref, actual evidence ref and `observed_at` are reconstructed from the saved observations; callers cannot override them. The baseline timestamp must precede the actual timestamp, KPI key/unit/source kind/version must match, and all KPI actuals in a single experiment-result snapshot must share one observed timestamp.
- `POST /growth/opportunities/:opportunityId/outcomes/from-source` — converts the same pinned observation pairs into the canonical `growth_opportunity_outcomes` and `growth_outcome_kpi_measurements` ledger used by forecast evaluation. The service derives `realized_metrics`, KPI baseline/actual values, baseline/actual evidence refs and observation time. Optionally link an existing `experiment_result_id`; when linked, the outcome must match all KPI keys, units, baselines, targets, directions and baseline evidence refs from that experiment result.

The source sync writes immutable run and observation rows, links each measurement to a source snapshot in `growth_opportunity_evidence`, emits a transactional outbox event, and records an audit event. Observation evidence uses the repository's neutral default evidence-score value (0.5); that field is not promoted to statistical confidence or causal probability. The deterministic input fingerprint includes adapter version, tenant/factory/opportunity scope, source kind, sorted source IDs and sorted metric keys, but not the submitting user. Per-observation SHA-256 fingerprints include source ID, value, unit, timestamp, revision hash and adapter version. Replaying the same idempotency key with changed inputs conflicts.

## Calibration policy governance

`POST /growth/calibration-policies` creates a versioned policy keyed by domain, model version, KPI key and unit. The proposed policy defines a minimum observation count and maximum tolerable MAE, RMSE, absolute bias, sMAPE and absolute nominal-coverage gap. Policy creation requires `growth.write`; review uses `growth.review` via `POST /growth/calibration-policies/:policyId/decision`. Maker-checker separation is enforced in both API and PostgreSQL: the author cannot approve/reject their own policy, a reason is required, the final decision is immutable and a configuration change requires a new policy version.

The default policy sample floor is 10 because the policy requires a floor, not because ten observations establish statistical confidence or power. A reviewer must choose appropriate thresholds and sample sizes for the actual KPI, unit, operating domain and decision risk. No thresholds are silently invented or auto-approved.

Calibration reporting is available at `GET /growth/opportunities/:opportunityId/forecast-evaluations/calibration?domain=FINANCE&residual_coverage_pct=90` (the domain filter is optional only when no ambiguity exists; the empirical residual threshold defaults to a 90% rank target). Cohorts are kept separate by model version, metric, unit, declared nominal coverage **and interval semantics**. Only matching approved policy versions assess configured error thresholds. An absent policy returns `NO_APPROVED_POLICY`; a cohort below the policy sample floor returns `INSUFFICIENT_POLICY_SAMPLE`; ambiguous cross-domain policies require the caller to select a domain.

## Uncertainty semantics

The forecast evaluator is deterministic and fixed-point based (`factoryos.growth.forecast-evaluation.v1`). It records signed error, absolute error, RMSE inputs, sMAPE and, if a nominal target was explicitly declared, empirical hit rate and the observed-minus-nominal coverage gap.

- `HEURISTIC_RANGE` means bounds were supplied without a declared nominal coverage. It can report range hits/width as descriptive facts, but coverage calibration is returned as `NOT_CALIBRATABLE_HEURISTIC_RANGE`.
- `DECLARED_NOMINAL_COVERAGE` enables empirical coverage comparison only after enough matching observations exist.
- `NONE` means no interval was supplied; no interval coverage is inferred.

A heuristic `uncertainty_pct`, upside/downside range or sensitivity envelope is never called a confidence interval or a calibrated prediction interval. Each calibration cohort also reports `empirical_residual_threshold`, a deterministic absolute-residual order statistic from recorded out-of-sample evaluations. It is withheld below the operational sample floor or when its finite-sample rank is beyond the available sample. Its label and interpretation explicitly state that future coverage is not guaranteed under drift or non-exchangeability; it is not a confidence interval. The system does not automatically refit models and does not infer nominal interval coverage from observed hit counts.

## Scenario reproducibility

The existing Growth scenario/sensitivity path keeps its model version, data vintage, baseline source reference, normalized input snapshot, constraint snapshot, output snapshot, canonicalization version and SHA-256 input hash immutable. For financial sensitivity, `baseline_source_observation_id` can now pin a `finance.actual_revenue` observation. The service checks tenant/factory/opportunity scope, exact adapter version, unit against opportunity currency, source observation timestamp against `data_vintage`, equality with `baseline_revenue`, and the canonical observation URI; then it embeds the observation ID, source revision hash, observation hash, unit, value and time in the scenario input snapshot covered by SHA-256. This does not silently assign total costs into variable/fixed-cost buckets; cost assumptions remain explicit versioned scenario inputs unless the source model has a sound cost segmentation mapping. Replaying the same canonical versioned inputs is deterministic; later evidence or source observations do not rewrite prior scenarios. Existing scenarios remain historical snapshots and should be explicitly rerun when a new vintage is wanted.

## Verification map

| Requirement | Evidence |
|---|---|
| Source-of-record allowlist and revision/unit conversion | `growth-source-of-record-adapters.spec.ts` |
| Authoritative source observation sync, stable fingerprint, cross-adapter rejection and missing-source rejection | `growth-source-observation-sync.spec.ts` |
| Baseline/actual feed, actual timestamps, evidence links and forecast rejection | `growth-source-of-record.service.spec.ts` |
| Source observation RLS, canonical row/value/unit/time/revision guard, append-only and evidence cross-link contracts | `services/api/test/growth-kpi-source-observations.sql` |
| Both baseline and actual refs persisted and guarded against the canonical source observation value, unit, source version and time in experiment/outcome KPI rows | `migrations/179_growth_kpi_baseline_evidence_provenance.sql`; `services/api/test/growth-kpi-baseline-evidence.sql`; source-backed outcome unit tests |
| Calibration sample floors, approved-policy matching, domain ambiguity and heuristic-range semantics | `growth-calibration-policy-report.spec.ts`, `growth-forecast-evaluation.spec.ts` |
| Baseline revenue pinned to exact source revision, source currency and data vintage in deterministic scenario input hash | `growth.service.spec.ts` (source-pinned scenario tests) |
| Calibration policy RLS, version constraints, immutable configuration and maker-checker guard | `services/api/test/growth-calibration-policies.sql` |
| DDL apply/reapply | API PostgreSQL CI applies and replays migrations 177–179 and runs all three `growth-kpi-source-observations.sql`, `growth-calibration-policies.sql`, and `growth-kpi-baseline-evidence.sql` contract tests |

## Known deployment gates

1. Activate and validate the actual customer's Finance reporting connector, source-fact schema mapping, currency/period policy and freshness service-level objective.
2. Decide whether production event timestamps need finer grain than the existing production posting's canonical created timestamp, or whether an external shop-floor KPI feed is required.
3. Have domain owners approve thresholds and minimum sample sizes based on real history and risk; no production calibration is claimed until the relevant sample counts and review approvals exist.
4. For statistically calibrated prediction intervals, choose and validate a suitable method (for example, held-out residual quantiles or conformal calibration) under documented time-series/drift assumptions. This work records and compares declared nominal coverage; it does not itself make forecasts statistically calibrated.
5. Run final API and PostgreSQL CI on the exact release candidate SHA before merge/release.


## Acceptance verification — 2026-10-22 CI evidence

The implemented source-of-record, realized-outcome, pinned scenario-input, calibration-policy and residual-threshold code was validated at commit `f3377cf9f11928a9de1803d29fc7fa5ee38d9c93`. The current branch head adds documentation only on top of that tested code commit.

- [API CI](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39835208031) — **success**. API build/lint and tests passed: **138 suites, 1,214 tests**; AI Tool Registry RLS integration check: **7 tests passed**.
- [API PostgreSQL CI](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39835208047) — **success**. Full API/PostgreSQL suite: **178 suites, 1,397 tests**. Migrations 177–179 were applied and replayed successfully; all three new source-observation, calibration-policy and baseline-provenance SQL contracts passed. Ordered migration manifest SHA-256: `04fb2a578150583e011ef7f792274cc3f10d7391f896ae535992fbb09110783d`.
- [Production dependency security audit](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39833832698) — **success** on the preceding dependency-patched commit; Next.js/React lockfile update is included in the tested source ancestry.

These results establish code/test acceptance for the implemented paths, not production deployment of a customer's external ERP connector or approval of domain thresholds. A customer deployment must still activate and validate its actual connector, use authentic out-of-sample observations, and obtain domain-owner approval for metric-specific thresholds.

## Final repository verification (2026-10-22)

The current `rakibul-hasan` code snapshot passed the following GitHub Actions workflows at commit `a23982ea6a8ea844fccb12302d532084cfed571f`:

- [API CI](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39842245662): **138 suites / 1,224 tests passed**, plus the separate AI Tool Registry RLS suite (**7 tests passed**).
- [API PostgreSQL CI](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39842245643): **178 suites / 1,407 tests passed**; the migration list and DDL passed apply/replay, including the Growth source-observation, calibration-policy and baseline-provenance SQL contracts.
- [Web CI](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39842245654): passed.
- [Production Dependency Security](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39842245806): passed after the patched Next.js/React lockfile update.
- [SRS/HLD/Blueprint Traceability](https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/39842245665): passed.

These runs verify the repository implementation and tests. They do not assert that a specific customer Finance connector is currently active or that a customer has enough real observations to approve a production calibration policy; those remain environment/data-owner release gates.
