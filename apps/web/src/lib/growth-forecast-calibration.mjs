const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const METRIC_KEY = /^[a-z][a-z0-9_.-]{0,99}$/;
const DOMAINS = ["FINANCE", "PRODUCTION", "QUALITY", "DELIVERY", "COMMERCIAL", "OTHER"];

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function textValue(value, field, max, min = 1) {
  const result = clean(value);
  if (result.length < min || result.length > max) {
    throw new Error(field + " must contain " + min + "–" + max + " characters.");
  }
  return result;
}

function numberValue(value, field, { min = -1_000_000_000_000, max = 1_000_000_000_000, decimals = 8 } = {}) {
  const raw = clean(String(value ?? ""));
  if (!raw || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new Error(field + " must be a valid number.");
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(field + " must be between " + min + " and " + max + ".");
  }
  const fraction = raw.split(".")[1] ?? "";
  if (fraction.length > decimals) throw new Error(field + " supports at most " + decimals + " decimal places.");
  return parsed;
}

function optionalNumber(value, field, options) {
  return clean(String(value ?? "")) === "" ? undefined : numberValue(value, field, options);
}

function isoDateTime(value, field, { allowFuture = false } = {}) {
  const raw = clean(value);
  const date = new Date(raw);
  if (!raw || !Number.isFinite(date.getTime())) throw new Error(field + " must be a valid date/time.");
  if (!allowFuture && date.getTime() > Date.now() + 5 * 60_000) {
    throw new Error(field + " cannot be in the future.");
  }
  return date.toISOString();
}

export function normalizeGrowthForecastRows(value, key = "items") {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.opportunities)) return value.opportunities;
    if (Array.isArray(value.policies)) return value.policies;
  }
  return [];
}

export function buildGrowthForecastEvaluationPayload(input, context = {}) {
  const outcome = context.outcome;
  const kpi = context.kpi;
  const evidence = Array.isArray(context.evidence) ? context.evidence : [];
  if (!outcome || !UUID.test(clean(outcome.id))) throw new Error("Select a realized outcome from this opportunity.");
  if (!kpi || !METRIC_KEY.test(clean(kpi.metric_key))) throw new Error("Select a valid realized KPI measurement.");
  if (!Array.isArray(outcome.kpi_measurements) || !outcome.kpi_measurements.some((item) =>
    item.metric_key === kpi.metric_key && item.unit === kpi.unit)) {
    throw new Error("The selected KPI does not belong to the selected realized outcome.");
  }

  const modelVersion = textValue(input.model_version, "Model version", 128);
  if (!MODEL_VERSION.test(modelVersion)) throw new Error("Model version must be a stable identifier.");
  const metricKey = textValue(input.metric_key, "Metric key", 100);
  if (!METRIC_KEY.test(metricKey) || metricKey !== kpi.metric_key) {
    throw new Error("Metric key must exactly match the selected realized KPI.");
  }
  const unit = textValue(input.unit, "Unit", 40);
  if (unit !== kpi.unit) throw new Error("Unit must exactly match the selected realized KPI.");

  const origin = isoDateTime(input.forecast_origin_at, "Forecast origin");
  const originTime = new Date(origin).getTime();
  const observedTime = new Date(outcome.observed_at).getTime();
  if (!Number.isFinite(observedTime) || originTime >= observedTime) {
    throw new Error("Forecast origin must be strictly earlier than the realized outcome time.");
  }

  const sourceRef = textValue(input.forecast_source_ref, "Forecast source reference", 2000);
  const source = evidence.find((item) =>
    item && (item.reference_ref === sourceRef || item.citation_url === sourceRef));
  if (!source) throw new Error("Forecast source must exactly match evidence attached to this opportunity.");
  const capturedAt = new Date(source.captured_at).getTime();
  if (!Number.isFinite(capturedAt) || capturedAt > originTime) {
    throw new Error("Forecast source evidence must have been captured on or before the forecast origin.");
  }

  const forecastValue = numberValue(input.forecast_value, "Forecast value");
  const lower = optionalNumber(input.lower_bound, "Lower bound");
  const upper = optionalNumber(input.upper_bound, "Upper bound");
  if ((lower === undefined) !== (upper === undefined)) {
    throw new Error("Lower and upper bounds must be supplied together.");
  }
  if (lower !== undefined && lower > upper) throw new Error("Lower bound cannot exceed upper bound.");
  const nominalCoverage = optionalNumber(input.nominal_coverage_pct, "Nominal coverage", {
    min: 1, max: 99.99, decimals: 2,
  });
  if (nominalCoverage !== undefined && lower === undefined) {
    throw new Error("Nominal coverage requires both interval bounds.");
  }
  const outcomeId = textValue(input.outcome_id, "Outcome ID", 36);
  if (!UUID.test(outcomeId) || outcomeId !== outcome.id) throw new Error("Outcome ID does not match the selected realized outcome.");
  const idempotencyKey = textValue(input.idempotency_key, "Idempotency key", 128, 8);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    throw new Error("Idempotency key must be a stable 8–128 character identifier.");
  }

  return {
    model_version: modelVersion,
    metric_key: metricKey,
    unit,
    forecast_origin_at: origin,
    forecast_source_ref: sourceRef,
    forecast_value: forecastValue,
    ...(lower === undefined ? {} : { lower_bound: lower, upper_bound: upper }),
    ...(nominalCoverage === undefined ? {} : { nominal_coverage_pct: nominalCoverage }),
    outcome_id: outcomeId,
    idempotency_key: idempotencyKey,
  };
}

export function buildGrowthCalibrationPolicyPayload(input) {
  const domain = clean(input.domain).toUpperCase();
  if (!DOMAINS.includes(domain)) throw new Error("Select a supported calibration domain.");
  const modelVersion = textValue(input.model_version, "Model version", 128);
  if (!MODEL_VERSION.test(modelVersion)) throw new Error("Model version must be a stable identifier.");
  const metricKey = textValue(input.metric_key, "Metric key", 100);
  if (!METRIC_KEY.test(metricKey)) throw new Error("Metric key must be a lowercase identifier.");
  const unit = textValue(input.unit, "Unit", 40);

  return {
    domain,
    model_version: modelVersion,
    metric_key: metricKey,
    unit,
    max_mean_absolute_error: numberValue(input.max_mean_absolute_error, "Maximum mean absolute error", { min: 0 }),
    max_root_mean_squared_error: numberValue(input.max_root_mean_squared_error, "Maximum root mean squared error", { min: 0 }),
    max_absolute_mean_error: numberValue(input.max_absolute_mean_error, "Maximum absolute bias", { min: 0 }),
    max_mean_symmetric_percentage_error_pct: numberValue(input.max_mean_symmetric_percentage_error_pct, "Maximum mean sMAPE", { min: 0, max: 200, decimals: 4 }),
    max_absolute_calibration_gap_pct_points: numberValue(input.max_absolute_calibration_gap_pct_points, "Maximum calibration gap", { min: 0, max: 100, decimals: 4 }),
    residual_coverage_target_pct: numberValue(input.residual_coverage_target_pct, "Residual coverage target", { min: 50, max: 99.99, decimals: 2 }),
    max_empirical_absolute_residual: numberValue(input.max_empirical_absolute_residual, "Maximum empirical absolute residual", { min: 0 }),
    minimum_sample_count: numberValue(input.minimum_sample_count, "Minimum sample count", { min: 10, max: 1_000_000, decimals: 0 }),
  };
}

export function buildGrowthCalibrationDecisionPayload(input) {
  const decision = clean(input.decision).toUpperCase();
  if (!["APPROVE", "REJECT"].includes(decision)) throw new Error("Select APPROVE or REJECT.");
  return {
    decision,
    reason: textValue(input.reason, "Review reason", 1000, 8),
  };
}

export function summarizeGrowthCalibrationBuckets(rows = []) {
  const result = {
    cohorts: rows.length,
    assessed: 0,
    insufficient: 0,
    approvedPolicy: 0,
    thresholdBreaches: 0,
  };
  for (const row of rows) {
    if (row.status === "ASSESSABLE") result.assessed += 1;
    else result.insufficient += 1;
    if (row.calibration_policy) result.approvedPolicy += 1;
    if (String(row.error_threshold_assessment ?? "").startsWith("EXCEEDS")
      || String(row.uncertainty_threshold_assessment ?? "").startsWith("EXCEEDS")
      || String(row.interval_threshold_assessment ?? "").startsWith("EXCEEDS")) {
      result.thresholdBreaches += 1;
    }
  }
  return result;
}
