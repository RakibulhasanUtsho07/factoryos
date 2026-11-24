import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiEvaluationPolicyPayload,
  buildAiForecastReconciliationPayload,
  buildAiObservedEvaluationPayload,
  buildAiOperationalQuery,
  filterAiOperationalSeries,
  normalizeAiOperationalRows,
  summarizeAiOperationalSeries,
} from "./ai-operational-evaluation.mjs";

const UUID = "a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";

test("normalizes evaluation, calibration and policy response envelopes", () => {
  const rows = [{ id: "1" }];
  assert.deepEqual(normalizeAiOperationalRows({ series: rows }, "series"), rows);
  assert.deepEqual(normalizeAiOperationalRows({ policies: rows }, "policies"), rows);
  assert.deepEqual(normalizeAiOperationalRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeAiOperationalRows(null), []);
});

test("builds scoped forecast accuracy and calibration queries", () => {
  const accuracy = new URLSearchParams(buildAiOperationalQuery({
    domain: "quality", metric_key: "defect_rate", model_version: "v2",
  }, "accuracy").slice(1));
  assert.equal(accuracy.get("domain"), "QUALITY");
  assert.equal(accuracy.get("metric_key"), "defect_rate");
  assert.equal(accuracy.get("model_version"), "v2");

  const calibration = new URLSearchParams(buildAiOperationalQuery({
    domain: "ENERGY", bins: 8,
  }, "calibration").slice(1));
  assert.equal(calibration.get("bins"), "8");
  assert.equal(calibration.get("domain"), "ENERGY");
});

test("builds descriptive and policy-evaluated model comparison queries", () => {
  const query = new URLSearchParams(buildAiOperationalQuery({
    domain: "PLANNING", metric_key: "demand", baseline_model_version: "v1",
    candidate_model_version: "v2", policy_key: "demand-forecast",
  }, "comparison").slice(1));
  assert.equal(query.get("baseline_model_version"), "v1");
  assert.equal(query.get("candidate_model_version"), "v2");
  assert.equal(query.get("policy_key"), "demand-forecast");
  assert.throws(() => buildAiOperationalQuery({
    metric_key: "demand", baseline_model_version: "v1", candidate_model_version: "v1",
  }, "comparison"), /must be different/);
});

test("rejects unsupported domains, query modes and calibration bin counts", () => {
  assert.throws(() => buildAiOperationalQuery({ domain: "SALES" }, "accuracy"), /Domain must be/);
  assert.throws(() => buildAiOperationalQuery({ bins: 1 }, "calibration"), /between 2 and 20/);
  assert.throws(() => buildAiOperationalQuery({}, "not-real"), /Unsupported/);
});

test("builds observed classification evaluation without caller scope fields", () => {
  const payload = buildAiObservedEvaluationPayload({
    decision_id: UUID, evaluation_key: "eval:quality:0001", domain: "quality",
    metric_key: "defect_risk", model_version: "2026.11", confidence: "0.92",
    prediction_correct: true,
  });
  assert.deepEqual(payload, {
    decision_id: UUID, evaluation_key: "eval:quality:0001", domain: "QUALITY",
    metric_key: "defect_risk", model_version: "2026.11", confidence: 0.92,
    prediction_correct: true,
  });
  assert.equal(Object.hasOwn(payload, "tenant_id"), false);
  assert.equal(Object.hasOwn(payload, "factory_id"), false);
});

test("rejects malformed observed evaluation identity and confidence", () => {
  const base = {
    decision_id: UUID, evaluation_key: "eval:one", domain: "QUALITY",
    metric_key: "precision", model_version: "v1", confidence: 0.8, prediction_correct: true,
  };
  assert.throws(() => buildAiObservedEvaluationPayload({ ...base, decision_id: "bad" }), /valid UUID/);
  assert.throws(() => buildAiObservedEvaluationPayload({ ...base, confidence: 1.001 }), /confidence/);
  assert.throws(() => buildAiObservedEvaluationPayload({ ...base, confidence: 0.1234567 }), /confidence/);
  assert.throws(() => buildAiObservedEvaluationPayload({ ...base, prediction_correct: "true" }), /true or false/);
});

test("builds forecast reconciliation from a source outcome ID and bounded tolerance", () => {
  const payload = buildAiForecastReconciliationPayload({
    source_outcome_id: UUID, evaluation_key: "forecast:1", domain: "planning",
    metric_key: "demand_units", model_version: "v4", confidence: 0.75, tolerance: 12.5,
  });
  assert.equal(payload.source_outcome_id, UUID);
  assert.equal(payload.domain, "PLANNING");
  assert.equal(payload.tolerance, 12.5);
  assert.throws(() => buildAiForecastReconciliationPayload({
    source_outcome_id: UUID, evaluation_key: "forecast:1", domain: "planning",
    metric_key: "demand_units", model_version: "v4", confidence: 0.75, tolerance: -1,
  }), /tolerance/);
});

test("builds immutable evaluation policy versions with at least one threshold", () => {
  const payload = buildAiEvaluationPolicyPayload({
    policy_key: "quality-score", policy_version: "v1.2", domain: "quality",
    metric_key: "defect_risk", minimum_samples: "100",
    max_expected_calibration_error: "0.08", min_within_tolerance_rate: "0.9",
  });
  assert.deepEqual(payload, {
    policy_key: "quality-score", policy_version: "v1.2", domain: "QUALITY",
    metric_key: "defect_risk", minimum_samples: 100,
    max_expected_calibration_error: 0.08, min_within_tolerance_rate: 0.9,
  });
  assert.throws(() => buildAiEvaluationPolicyPayload({
    policy_key: "quality-score", policy_version: "v1", domain: "QUALITY",
    metric_key: "x", minimum_samples: 10,
  }), /at least one/);
});

test("rejects invalid policy identifiers, sample bounds and thresholds", () => {
  const base = {
    policy_key: "quality-score", policy_version: "v1", domain: "QUALITY",
    metric_key: "defect_risk", minimum_samples: 100, max_mean_absolute_error: 2,
  };
  assert.throws(() => buildAiEvaluationPolicyPayload({ ...base, policy_key: "bad key" }), /unsupported characters/);
  assert.throws(() => buildAiEvaluationPolicyPayload({ ...base, policy_version: "bad version" }), /unsupported characters/);
  assert.throws(() => buildAiEvaluationPolicyPayload({ ...base, minimum_samples: 0 }), /minimum_samples/);
  assert.throws(() => buildAiEvaluationPolicyPayload({ ...base, max_expected_calibration_error: 1.2 }), /max_expected_calibration_error/);
});

test("filters model series by domain, metric and version and summarizes only loaded API data", () => {
  const rows = [
    { domain: "QUALITY", metricKey: "defect_risk", modelVersion: "v1" },
    { domain: "PLANNING", metricKey: "demand_units", modelVersion: "v2" },
  ];
  assert.deepEqual(filterAiOperationalSeries(rows, { domain: "quality" }).map((r) => r.modelVersion), ["v1"]);
  assert.deepEqual(filterAiOperationalSeries(rows, { metric_key: "DEMAND" }).map((r) => r.modelVersion), ["v2"]);
  assert.deepEqual(summarizeAiOperationalSeries(
    { totalSamples: 10, series: [{ sampleCount: 10, withinToleranceRate: 0.8 }] },
    { series: [{ sampleCount: 10 }] }, [{ policyKey: "x" }],
  ), {
    seriesCount: 1, totalSamples: 10, meanWithinTolerance: 0.8,
    calibrationGroups: 1, policyCount: 1,
  });
});
