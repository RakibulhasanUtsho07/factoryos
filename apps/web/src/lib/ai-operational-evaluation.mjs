const DOMAINS = new Set(["PLANNING", "QUALITY", "MAINTENANCE", "FINANCE", "ENERGY"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLICY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,49}$/;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredText(value, field, maximum) {
  const result = clean(value);
  if (!result || result.length > maximum) {
    throw new Error(field + " must contain 1 to " + maximum + " characters.");
  }
  return result;
}

function domainValue(value) {
  const result = clean(value).toUpperCase();
  if (!DOMAINS.has(result)) throw new Error("Domain must be PLANNING, QUALITY, MAINTENANCE, FINANCE or ENERGY.");
  return result;
}

function uuidValue(value, field) {
  const result = clean(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result;
}

function decimal(value, field, maximum, allowZero = true) {
  if (value === null || value === undefined || clean(String(value)) === "") {
    throw new Error(field + " is required.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed > maximum || (allowZero ? parsed < 0 : parsed <= 0) ||
    Math.round(parsed * 1_000_000) / 1_000_000 !== parsed) {
    throw new Error(field + " must be a finite number with at most six decimal places.");
  }
  return parsed;
}

export function normalizeAiOperationalRows(value, preferredKey = "") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (preferredKey && Array.isArray(value[preferredKey])) return value[preferredKey];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.rows)) return value.rows;
  if (value.data !== undefined) return normalizeAiOperationalRows(value.data, preferredKey);
  return [];
}

export function buildAiOperationalQuery(filters = {}, kind = "accuracy") {
  const params = new URLSearchParams();
  const domain = clean(filters.domain);
  const metricKey = clean(filters.metric_key);
  const modelVersion = clean(filters.model_version);
  if (domain && domain !== "ALL") params.set("domain", domainValue(domain));
  if (metricKey) params.set("metric_key", requiredText(metricKey, "metric_key", 100));
  if (modelVersion) params.set("model_version", requiredText(modelVersion, "model_version", 100));
  if (kind === "calibration") {
    const bins = filters.bins === undefined || filters.bins === "" ? 10 : Number(filters.bins);
    if (!Number.isInteger(bins) || bins < 2 || bins > 20) throw new Error("Calibration bins must be an integer between 2 and 20.");
    params.set("bins", String(bins));
  } else if (kind === "comparison") {
    const baseline = requiredText(filters.baseline_model_version, "baseline_model_version", 100);
    const candidate = requiredText(filters.candidate_model_version, "candidate_model_version", 100);
    if (baseline === candidate) throw new Error("Baseline and candidate model versions must be different.");
    params.set("baseline_model_version", baseline);
    params.set("candidate_model_version", candidate);
    if (filters.policy_key) params.set("policy_key", requiredText(filters.policy_key, "policy_key", 150));
  } else if (kind === "policies" && filters.policy_key) {
    params.set("policy_key", requiredText(filters.policy_key, "policy_key", 150));
  } else if (!["accuracy", "calibration", "comparison", "policies"].includes(kind)) {
    throw new Error("Unsupported operational evaluation query.");
  }
  const query = params.toString();
  return query ? "?" + query : "";
}

export function buildAiObservedEvaluationPayload(input) {
  const evaluationKey = requiredText(input.evaluation_key, "evaluation_key", 255);
  const confidence = decimal(input.confidence, "confidence", 1);
  if (typeof input.prediction_correct !== "boolean") throw new Error("prediction_correct must be true or false.");
  let observedAt;
  if (clean(input.observed_at)) {
    const date = new Date(input.observed_at);
    if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now()) {
      throw new Error("observed_at must be a valid date that is not in the future.");
    }
    observedAt = date.toISOString();
  }
  return {
    decision_id: uuidValue(input.decision_id, "decision_id"),
    evaluation_key: evaluationKey,
    domain: domainValue(input.domain),
    metric_key: requiredText(input.metric_key, "metric_key", 100),
    model_version: requiredText(input.model_version, "model_version", 100),
    confidence,
    prediction_correct: input.prediction_correct,
    ...(observedAt ? { observed_at: observedAt } : {}),
  };
}

export function buildAiForecastReconciliationPayload(input) {
  return {
    source_outcome_id: uuidValue(input.source_outcome_id, "source_outcome_id"),
    evaluation_key: requiredText(input.evaluation_key, "evaluation_key", 255),
    domain: domainValue(input.domain),
    metric_key: requiredText(input.metric_key, "metric_key", 100),
    model_version: requiredText(input.model_version, "model_version", 100),
    confidence: decimal(input.confidence, "confidence", 1),
    tolerance: decimal(input.tolerance, "tolerance", 1_000_000_000_000_000),
  };
}

export function buildAiEvaluationPolicyPayload(input) {
  const policyKey = requiredText(input.policy_key, "policy_key", 150);
  const policyVersion = requiredText(input.policy_version, "policy_version", 50);
  if (!POLICY_KEY.test(policyKey)) throw new Error("policy_key contains unsupported characters.");
  if (!POLICY_VERSION.test(policyVersion)) throw new Error("policy_version contains unsupported characters.");
  const minimumSamples = Number(input.minimum_samples);
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 1_000_000) {
    throw new Error("minimum_samples must be an integer between 1 and 1000000.");
  }
  const result = {
    policy_key: policyKey,
    policy_version: policyVersion,
    domain: domainValue(input.domain),
    metric_key: requiredText(input.metric_key, "metric_key", 100),
    minimum_samples: minimumSamples,
  };
  const fields = [
    ["max_mean_absolute_error", 1_000_000_000_000_000],
    ["max_mean_absolute_percentage_error", 1_000_000_000],
    ["min_within_tolerance_rate", 1],
    ["max_expected_calibration_error", 1],
  ];
  let configured = 0;
  for (const [field, maximum] of fields) {
    if (input[field] !== undefined && input[field] !== null && clean(String(input[field])) !== "") {
      result[field] = decimal(input[field], field, maximum);
      configured += 1;
    }
  }
  if (!configured) throw new Error("Configure at least one evaluation threshold.");
  return result;
}

export function summarizeAiOperationalSeries(accuracy, calibration, policies) {
  const rows = Array.isArray(accuracy?.series) ? accuracy.series : [];
  const calibrationRows = Array.isArray(calibration?.series) ? calibration.series : [];
  return {
    seriesCount: rows.length,
    totalSamples: Number(accuracy?.totalSamples ?? rows.reduce((sum, row) => sum + Number(row.sampleCount ?? 0), 0)),
    meanWithinTolerance: rows.length
      ? rows.reduce((sum, row) => sum + Number(row.withinToleranceRate ?? 0), 0) / rows.length
      : null,
    calibrationGroups: calibrationRows.length,
    policyCount: Array.isArray(policies) ? policies.length : 0,
  };
}

export function filterAiOperationalSeries(rows = [], filters = {}) {
  const domain = clean(filters.domain).toUpperCase();
  const metric = clean(filters.metric_key).toLowerCase();
  const version = clean(filters.model_version).toLowerCase();
  return rows.filter((row) =>
    (!domain || domain === "ALL" || String(row.domain ?? "").toUpperCase() === domain) &&
    (!metric || String(row.metricKey ?? "").toLowerCase().includes(metric)) &&
    (!version || String(row.modelVersion ?? "").toLowerCase().includes(version))
  );
}
