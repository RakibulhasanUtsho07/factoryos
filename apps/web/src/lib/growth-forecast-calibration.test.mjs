import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGrowthCalibrationDecisionPayload,
  buildGrowthCalibrationPolicyPayload,
  buildGrowthForecastEvaluationPayload,
  normalizeGrowthForecastRows,
  summarizeGrowthCalibrationBuckets,
} from "./growth-forecast-calibration.mjs";

const outcome = {
  id: "f8b1cda5-fdb0-49f1-9db6-4b4a9f2a08c3",
  observed_at: "2026-11-20T12:00:00.000Z",
  kpi_measurements: [{ metric_key: "net_revenue", unit: "BDT", actual_value: "1250", evidence_ref: "outcome-doc-1" }],
};
const evidence = [{
  reference_ref: "forecast-source-1",
  citation_url: null,
  captured_at: "2026-11-19T09:00:00.000Z",
}];
const forecastInput = {
  model_version: "factoryos.revenue.v1",
  metric_key: "net_revenue",
  unit: "BDT",
  forecast_origin_at: "2026-11-19T10:00:00Z",
  forecast_source_ref: "forecast-source-1",
  forecast_value: "1200",
  lower_bound: "1100",
  upper_bound: "1300",
  nominal_coverage_pct: "90",
  outcome_id: outcome.id,
  idempotency_key: "growth-eval-12345678",
};

test("normalizes direct and wrapped opportunity/policy arrays", () => {
  assert.equal(normalizeGrowthForecastRows([1, 2]).length, 2);
  assert.deepEqual(normalizeGrowthForecastRows({ policies: [1] }, "policies"), [1]);
  assert.deepEqual(normalizeGrowthForecastRows({ items: [2] }), [2]);
  assert.deepEqual(normalizeGrowthForecastRows({ unknown: [] }), []);
});

test("builds a forecast evaluation tied to an outcome KPI and dated source evidence", () => {
  const payload = buildGrowthForecastEvaluationPayload(forecastInput, { outcome, kpi: outcome.kpi_measurements[0], evidence });
  assert.equal(payload.model_version, "factoryos.revenue.v1");
  assert.equal(payload.metric_key, "net_revenue");
  assert.equal(payload.forecast_value, 1200);
  assert.equal(payload.nominal_coverage_pct, 90);
  assert.equal(payload.forecast_origin_at, "2026-11-19T10:00:00.000Z");
});

test("rejects a forecast origin at or after the observed outcome", () => {
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, forecast_origin_at: "2026-11-20T12:00:00Z",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /strictly earlier/);
});

test("rejects a source captured after the forecast origin", () => {
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, forecast_origin_at: "2026-11-19T08:00:00Z",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /captured on or before/);
});

test("requires exact source reference and exact realized KPI metric and unit", () => {
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, forecast_source_ref: "unlinked-source",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /exactly match evidence/);
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, unit: "USD",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /exactly match/);
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, metric_key: "orders",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /exactly match/);
});

test("requires paired bounds and nominal coverage only for an interval", () => {
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, upper_bound: "",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /supplied together/);
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, lower_bound: "1400", upper_bound: "1300",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /cannot exceed/);
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, lower_bound: "", upper_bound: "", nominal_coverage_pct: "90",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /requires both interval bounds/);
});

test("rejects invalid idempotency identifiers and missing outcome linkage", () => {
  assert.throws(() => buildGrowthForecastEvaluationPayload({
    ...forecastInput, idempotency_key: "short",
  }, { outcome, kpi: outcome.kpi_measurements[0], evidence }), /Idempotency key/);
  assert.throws(() => buildGrowthForecastEvaluationPayload(forecastInput, { outcome: null, kpi: null, evidence }), /realized outcome/);
});

const policyInput = {
  domain: "FINANCE",
  model_version: "factoryos.revenue.v1",
  metric_key: "net_revenue",
  unit: "BDT",
  max_mean_absolute_error: "100",
  max_root_mean_squared_error: "150",
  max_absolute_mean_error: "75",
  max_mean_symmetric_percentage_error_pct: "30",
  max_absolute_calibration_gap_pct_points: "10",
  residual_coverage_target_pct: "90",
  max_empirical_absolute_residual: "250",
  minimum_sample_count: "30",
};

test("builds immutable calibration policy thresholds within API bounds", () => {
  const payload = buildGrowthCalibrationPolicyPayload(policyInput);
  assert.equal(payload.domain, "FINANCE");
  assert.equal(payload.minimum_sample_count, 30);
  assert.equal(payload.max_empirical_absolute_residual, 250);
  assert.equal(payload.residual_coverage_target_pct, 90);
});

test("rejects calibration policies below the API minimum held-out sample count", () => {
  assert.throws(() => buildGrowthCalibrationPolicyPayload({
    ...policyInput, minimum_sample_count: "9",
  }), /between 10 and 1000000/);
  assert.throws(() => buildGrowthCalibrationPolicyPayload({
    ...policyInput, residual_coverage_target_pct: "49",
  }), /between 50 and 99.99/);
});

test("builds reasoned maker-checker policy decisions", () => {
  assert.deepEqual(buildGrowthCalibrationDecisionPayload({ decision: "approve", reason: "Independent review complete" }), {
    decision: "APPROVE", reason: "Independent review complete",
  });
  assert.throws(() => buildGrowthCalibrationDecisionPayload({ decision: "APPROVE", reason: "ok" }), /8–1000/);
  assert.throws(() => buildGrowthCalibrationDecisionPayload({ decision: "CHANGE", reason: "A longer reason" }), /APPROVE or REJECT/);
});

test("summarizes calibration buckets without converting missing data into zero", () => {
  const summary = summarizeGrowthCalibrationBuckets([
    { status: "ASSESSABLE", calibration_policy: { id: "1" }, error_threshold_assessment: "EXCEEDS_APPROVED_ERROR_THRESHOLDS" },
    { status: "INSUFFICIENT_SAMPLE", calibration_policy: null, uncertainty_threshold_assessment: "INSUFFICIENT_SAMPLE" },
  ]);
  assert.deepEqual(summary, { cohorts: 2, assessed: 1, insufficient: 1, approvedPolicy: 1, thresholdBreaches: 1 });
});
