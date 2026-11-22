const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = [
  "REVENUE_GROWTH", "MARGIN_EXPANSION", "PRODUCT_MIX", "CUSTOMER_EXPANSION",
  "MARKET_CHANNEL_EXPANSION", "CAPACITY_UNLOCK", "COST_REDUCTION", "WORKING_CAPITAL",
  "RISK_REDUCTION", "RESILIENCE", "EXPORT_READINESS",
];
const EVIDENCE_TYPES = ["RESEARCH_CLAIM", "CBB_ENTITY", "OPERATIONAL_METRIC", "MARKET_SIGNAL", "CLIENT_DOCUMENT"];
const CONSTRAINT_DIMENSIONS = ["CAPACITY", "QUALITY", "CASH", "DELIVERY"];
const SCENARIO_PARAMETERS = [
  "price_change_pct", "volume_change_pct", "variable_cost_change_pct",
  "fixed_cost_change_pct", "investment", "uncertainty_pct",
];

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value, field, { min = -1_000_000_000_000, max = 1_000_000_000_000, decimals = 4 } = {}) {
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

function textValue(value, field, max, min = 1) {
  const result = clean(value);
  if (result.length < min || result.length > max) {
    throw new Error(field + " must contain " + min + "–" + max + " characters.");
  }
  return result;
}

function uuidValue(value, field) {
  const result = clean(value);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result;
}

function isoDateTime(value, field, { allowFuture = false } = {}) {
  const result = clean(value);
  const time = new Date(result);
  if (!result || !Number.isFinite(time.getTime())) throw new Error(field + " must be a valid date/time.");
  if (!allowFuture && time.getTime() > Date.now() + 5 * 60_000) throw new Error(field + " cannot be in the future.");
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(result) ? result : time.toISOString();
}

function listValue(value, field, max, minLength = 1) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "").split(/\r?\n|,/);
  const normalized = items.map((item) => clean(String(item))).filter(Boolean);
  if (normalized.length < minLength || normalized.length > max) {
    throw new Error(field + " must contain " + minLength + "–" + max + " entries.");
  }
  if (new Set(normalized).size !== normalized.length) throw new Error(field + " must not contain duplicates.");
  return normalized;
}

function normalizeEvidence(input) {
  const type = clean(input.evidence_type || "MARKET_SIGNAL").toUpperCase();
  if (!EVIDENCE_TYPES.includes(type)) throw new Error("Unsupported evidence type.");
  const evidence = {
    evidence_type: type,
    description: textValue(input.description, "Evidence description", 4000),
    confidence: numberValue(input.confidence ?? 0.5, "Evidence confidence", { min: 0, max: 1, decimals: 4 }),
  };
  const reference = clean(input.reference_ref);
  const citation = clean(input.citation_url);
  if (type === "RESEARCH_CLAIM") evidence.research_claim_id = uuidValue(input.research_claim_id, "Research claim ID");
  else if (type === "CBB_ENTITY") evidence.business_entity_id = uuidValue(input.business_entity_id, "Business entity ID");
  else if (type === "OPERATIONAL_METRIC" && !reference) throw new Error("Operational metrics require a record/report reference.");
  else if (type === "MARKET_SIGNAL" && !reference && !citation) throw new Error("Market signals require a source reference or citation URL.");
  else if (type === "CLIENT_DOCUMENT" && !reference) throw new Error("Customer documents require a tenant-private evidence reference.");
  if (reference) evidence.reference_ref = textValue(reference, "Evidence reference", 2000);
  if (citation) {
    try {
      const url = new URL(citation);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error("Citation URL must be a valid HTTP(S) URL.");
    }
    evidence.citation_url = citation;
  }
  if (input.evidence_snapshot && typeof input.evidence_snapshot === "object" && !Array.isArray(input.evidence_snapshot)) {
    evidence.evidence_snapshot = input.evidence_snapshot;
  }
  return evidence;
}

export function normalizeGrowthRows(value, key = "items") {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.opportunities)) return value.opportunities;
    if (Array.isArray(value.scenarios)) return value.scenarios;
    if (Array.isArray(value.experiments)) return value.experiments;
  }
  return [];
}

export function buildGrowthOpportunityPayload(input) {
  const category = clean(input.category).toUpperCase();
  if (!CATEGORIES.includes(category)) throw new Error("Select a supported opportunity category.");
  const low = numberValue(input.expected_value_low, "Expected value low");
  const high = numberValue(input.expected_value_high, "Expected value high");
  if (low > high) throw new Error("Expected value low cannot exceed expected value high.");
  const currency = clean(input.currency || "BDT").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter code.");
  const assumptions = listValue(input.assumptions, "Initial assumptions", 30, 1)
    .map((value) => textValue(value, "Assumption", 2000, 5));
  const evidenceInput = input.evidence && typeof input.evidence === "object"
    ? input.evidence
    : {
      evidence_type: input.evidence_type,
      description: input.evidence_description,
      reference_ref: input.reference_ref,
      citation_url: input.citation_url,
      confidence: input.confidence,
      research_claim_id: input.research_claim_id,
      business_entity_id: input.business_entity_id,
    };
  const effort = clean(input.effort).toUpperCase();
  if (!["SMALL", "MEDIUM", "LARGE", "UNKNOWN"].includes(effort)) throw new Error("Select an opportunity effort.");
  const implementationRisk = clean(input.implementation_risk).toUpperCase();
  if (!["LOW", "MEDIUM", "HIGH", "UNKNOWN"].includes(implementationRisk)) throw new Error("Select an implementation risk.");
  return {
    title: textValue(input.title, "Opportunity title", 300),
    category,
    opportunity_statement: textValue(input.opportunity_statement, "Opportunity statement", 8000),
    success_hypothesis: textValue(input.success_hypothesis, "Success hypothesis", 4000),
    assumptions,
    expected_value_low: low,
    expected_value_high: high,
    currency,
    uncertainty_pct: numberValue(input.uncertainty_pct, "Uncertainty", { min: 0, max: 100, decimals: 4 }),
    effort,
    time_to_impact_days: numberValue(input.time_to_impact_days, "Time to impact", { min: 0, max: 3650, decimals: 0 }),
    implementation_risk: implementationRisk,
    evidence: [normalizeEvidence(evidenceInput)],
  };
}

export function buildGrowthOwnerPayload(input) {
  const role = clean(input.role_code).toUpperCase();
  const roles = [
    "BUSINESS_OWNER", "DECISION_OWNER", "FINANCE_REVIEWER", "OPERATIONS_REVIEWER",
    "QUALITY_REVIEWER", "RISK_REVIEWER", "EVIDENCE_OWNER",
  ];
  if (!roles.includes(role)) throw new Error("Select a supported governance owner role.");
  return {
    role_code: role,
    owner_user_id: uuidValue(input.owner_user_id, "Owner user ID"),
    rationale: textValue(input.rationale, "Owner rationale", 2000, 10),
  };
}

export function buildGrowthAssumptionPayload(input) {
  return {
    statement: textValue(input.statement, "Assumption", 4000, 5),
    rationale: clean(input.rationale),
    risk_if_false: clean(input.risk_if_false).toUpperCase(),
    confidence_pct: numberValue(input.confidence_pct, "Confidence", { min: 0, max: 100, decimals: 2 }),
    validation_method: textValue(input.validation_method, "Validation method", 2000, 5),
    evidence_refs: input.evidence_refs ? listValue(input.evidence_refs, "Evidence references", 10) : [],
    blocks_decision: input.blocks_decision !== false,
  };
}

export function buildGrowthAssumptionDecisionPayload(input) {
  const decision = clean(input.decision).toUpperCase();
  if (!["VALIDATED", "REFUTED", "DEFERRED", "NEEDS_EVIDENCE", "WAIVED"].includes(decision)) {
    throw new Error("Unsupported assumption decision.");
  }
  const refs = input.evidence_refs ? listValue(input.evidence_refs, "Evidence references", 10) : [];
  if (["VALIDATED", "REFUTED", "WAIVED"].includes(decision) && refs.length === 0) {
    throw new Error("This assumption decision requires evidence references already attached to the opportunity.");
  }
  return {
    decision,
    reason: textValue(input.reason, "Decision reason", 2000, 10),
    evidence_refs: refs,
  };
}

export function buildGrowthConstraintPayload(input) {
  const dimension = clean(input.dimension).toUpperCase();
  if (!CONSTRAINT_DIMENSIONS.includes(dimension)) throw new Error("Use one of the four required constraint dimensions.");
  const applicability = clean(input.applicability).toUpperCase();
  if (!["APPLICABLE", "NOT_APPLICABLE", "UNKNOWN"].includes(applicability)) throw new Error("Select a constraint applicability.");
  const rationale = textValue(input.rationale, "Constraint rationale", 2000, applicability === "NOT_APPLICABLE" ? 10 : 5);
  const payload = { dimension, applicability, constraint_name: textValue(input.constraint_name || dimension, "Constraint name", 300), rationale };
  if (applicability === "APPLICABLE") {
    const operator = clean(input.limit_operator).toUpperCase();
    if (!["MAX", "MIN", "EQUALS"].includes(operator)) throw new Error("Select a limit operator.");
    payload.limit_operator = operator;
    payload.threshold_value = numberValue(input.threshold_value, "Constraint threshold");
    payload.observed_value = numberValue(input.observed_value, "Observed value");
    payload.unit = textValue(input.unit, "Constraint unit", 60);
    payload.source_evidence_ref = textValue(input.source_evidence_ref, "Constraint evidence reference", 1000);
    payload.source_as_of = isoDateTime(input.source_as_of, "Constraint source vintage");
  }
  return payload;
}

export function buildGrowthEvidenceGapPayload(input) {
  return {
    question: textValue(input.question, "Evidence gap question", 4000, 5),
    required_evidence: textValue(input.required_evidence, "Required evidence", 2000, 5),
    impact: clean(input.impact).toUpperCase(),
    ...(clean(input.due_at) ? { due_at: isoDateTime(input.due_at, "Evidence due date", { allowFuture: true }) } : {}),
    blocks_decision: input.blocks_decision !== false,
  };
}

export function buildGrowthEvidenceGapDecisionPayload(input) {
  const decision = clean(input.decision).toUpperCase();
  if (!["IN_REVIEW", "RESOLVED", "WAIVED", "REOPENED"].includes(decision)) throw new Error("Unsupported evidence-gap decision.");
  const refs = input.evidence_refs ? listValue(input.evidence_refs, "Evidence references", 10) : [];
  if (decision === "RESOLVED" && refs.length === 0) throw new Error("Resolving an evidence gap requires opportunity evidence references.");
  return {
    decision,
    reason: textValue(input.reason, "Evidence-gap decision reason", 2000, 10),
    evidence_refs: refs,
  };
}

export function buildGrowthOpportunityDecisionPayload(input) {
  const decision = clean(input.decision).toUpperCase();
  if (!["ACCEPT", "REJECT"].includes(decision)) throw new Error("Opportunity decision must be ACCEPT or REJECT.");
  return { decision, reason: textValue(input.reason, "Opportunity decision reason", 2000) };
}

function projectedMetrics(profile, currency) {
  if (!profile.include_projected_constraints) return undefined;
  return {
    capacity_utilization_pct: numberValue(profile.capacity_utilization_pct, "Projected capacity utilization", { min: 0, max: 1000 }),
    quality_yield_pct: numberValue(profile.quality_yield_pct, "Projected quality yield", { min: 0, max: 100 }),
    cash_after_investment: numberValue(profile.cash_after_investment, "Projected cash after investment"),
    cash_currency: currency,
    delivery_backlog_days: numberValue(profile.delivery_backlog_days, "Projected delivery backlog", { min: 0, max: 36500 }),
  };
}

function normalizeScenarioProfile(profile, currency, name) {
  const result = {
    price_change_pct: numberValue(profile.price_change_pct, name + " price change", { min: -90, max: 500 }),
    volume_change_pct: numberValue(profile.volume_change_pct, name + " volume change", { min: -90, max: 500 }),
    variable_cost_change_pct: numberValue(profile.variable_cost_change_pct, name + " variable cost change", { min: -100, max: 500 }),
    fixed_cost_change_pct: numberValue(profile.fixed_cost_change_pct, name + " fixed cost change", { min: -100, max: 500 }),
    investment: numberValue(profile.investment, name + " investment", { min: 0 }),
    uncertainty_pct: numberValue(profile.uncertainty_pct, name + " uncertainty", { min: 0, max: 100 }),
  };
  const projection = projectedMetrics(profile, currency);
  if (projection) result.projected_constraint_metrics = projection;
  return result;
}

export function buildGrowthScenarioSetPayload(input, evidenceReferences = []) {
  const setName = textValue(input.set_name, "Scenario set name", 140);
  const dataVintage = isoDateTime(input.data_vintage, "Scenario data vintage");
  const baselineSource = textValue(input.baseline_source_ref, "Baseline source reference", 2000);
  if (!evidenceReferences.includes(baselineSource)) {
    throw new Error("The baseline source must exactly match a reference_ref or citation_url attached to this opportunity.");
  }
  const currency = clean(input.currency || "BDT").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter code.");
  const baseline = {
    baseline_revenue: numberValue(input.baseline_revenue, "Baseline revenue", { min: 0.0001 }),
    baseline_variable_cost: numberValue(input.baseline_variable_cost, "Baseline variable cost", { min: 0 }),
    baseline_fixed_cost: numberValue(input.baseline_fixed_cost, "Baseline fixed cost", { min: 0 }),
  };
  const profiles = {
    base: normalizeScenarioProfile(input.base, currency, "Base"),
    upside: normalizeScenarioProfile(input.upside, currency, "Upside"),
    downside: normalizeScenarioProfile(input.downside, currency, "Downside"),
    stress: normalizeScenarioProfile(input.stress, currency, "Stress"),
  };
  const parameter = clean(input.sensitivity_parameter).toLowerCase();
  if (!SCENARIO_PARAMETERS.includes(parameter)) throw new Error("Select a supported sensitivity parameter.");
  const bounds = {
    price_change_pct: [-90, 500], volume_change_pct: [-90, 500],
    variable_cost_change_pct: [-100, 500], fixed_cost_change_pct: [-100, 500],
    investment: [0, 1_000_000_000_000], uncertainty_pct: [0, 100],
  }[parameter];
  const low = numberValue(input.sensitivity_low, "Sensitivity low", { min: bounds[0], max: bounds[1] });
  const high = numberValue(input.sensitivity_high, "Sensitivity high", { min: bounds[0], max: bounds[1] });
  if (low >= high) throw new Error("Sensitivity low must be less than sensitivity high.");
  const points = numberValue(input.sensitivity_points, "Sensitivity points", { min: 2, max: 11, decimals: 0 });
  return {
    set_name: setName,
    data_vintage: dataVintage,
    baseline_source_ref: baselineSource,
    baseline,
    profiles,
    sensitivity: [{ parameter, low_value: low, high_value: high, points }],
  };
}

export function buildGrowthExperimentPayload(input) {
  const baselineKey = textValue(input.baseline_metric_key, "Baseline metric key", 100);
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(baselineKey)) throw new Error("Baseline metric key must be a lowercase identifier.");
  return {
    name: textValue(input.name, "Experiment name", 300),
    objective: textValue(input.objective, "Experiment objective", 4000),
    hypothesis: textValue(input.hypothesis, "Experiment hypothesis", 4000),
    leading_indicators: listValue(input.leading_indicators, "Leading indicators", 50),
    duration_days: numberValue(input.duration_days, "Duration", { min: 1, max: 3650, decimals: 0 }),
    baseline_measurements: {
      [baselineKey]: numberValue(input.baseline_value, "Baseline measurement"),
      unit: textValue(input.unit, "Measurement unit", 40),
    },
    stop_conditions: listValue(input.stop_conditions, "Stop conditions", 50),
  };
}

export function buildGrowthExperimentResultPayload(input) {
  const metricKey = textValue(input.metric_key, "KPI metric key", 100);
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(metricKey)) throw new Error("KPI metric key must be a lowercase identifier.");
  const evidenceRef = textValue(input.evidence_ref, "KPI evidence reference", 2000);
  const baselineValue = numberValue(input.baseline_value, "KPI baseline");
  const actualValue = numberValue(input.actual_value, "KPI actual");
  const target = clean(String(input.target_value ?? ""));
  const direction = clean(input.direction).toUpperCase();
  if (!["INCREASE", "DECREASE", "TARGET"].includes(direction)) throw new Error("Select a supported KPI direction.");
  const assessment = clean(input.assessment).toUpperCase();
  if (!["POSITIVE", "NEUTRAL", "NEGATIVE", "INCONCLUSIVE"].includes(assessment)) throw new Error("Select a supported experiment assessment.");
  const observedAt = isoDateTime(input.observed_at, "Experiment observation time");
  const unit = textValue(input.unit, "KPI unit", 40);
  return {
    pre_measurements: { [metricKey]: baselineValue },
    post_measurements: { [metricKey]: actualValue },
    assessment,
    stop_condition_triggered: input.stop_condition_triggered === true,
    ...(clean(input.notes) ? { result_notes: textValue(input.notes, "Result notes", 4000) } : {}),
    evidence_refs: [evidenceRef],
    kpi_measurements: [{
      metric_key: metricKey, unit, direction,
      ...(target ? { target_value: numberValue(target, "KPI target") } : {}),
      evidence_ref: evidenceRef,
      baseline_evidence_ref: evidenceRef,
    }],
    observed_at: observedAt,
  };
}

export function buildGrowthOutcomePayload(input) {
  const metricKey = textValue(input.metric_key, "Outcome KPI metric key", 100);
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(metricKey)) throw new Error("Outcome KPI key must be a lowercase identifier.");
  const evidenceRef = textValue(input.evidence_ref, "Outcome evidence reference", 2000);
  const baselineValue = numberValue(input.baseline_value, "Outcome baseline");
  const actualValue = numberValue(input.actual_value, "Outcome actual");
  const target = clean(String(input.target_value ?? ""));
  const direction = clean(input.direction).toUpperCase();
  if (!["INCREASE", "DECREASE", "TARGET"].includes(direction)) throw new Error("Select a supported KPI direction.");
  const assessment = clean(input.assessment).toUpperCase();
  if (!["POSITIVE", "NEUTRAL", "NEGATIVE", "INCONCLUSIVE"].includes(assessment)) throw new Error("Select a supported outcome assessment.");
  const unit = textValue(input.unit, "Outcome KPI unit", 40);
  const observedAt = isoDateTime(input.observed_at, "Outcome observation time");
  return {
    assessment,
    realized_metrics: { [metricKey]: actualValue },
    evidence_refs: [evidenceRef],
    ...(clean(input.notes) ? { notes: textValue(input.notes, "Outcome notes", 4000) } : {}),
    ...(clean(String(input.confidence ?? "")) ? { confidence: numberValue(input.confidence, "Submitter confidence", { min: 0, max: 1, decimals: 4 }) } : {}),
    kpi_measurements: [{
      metric_key: metricKey, unit, direction,
      baseline_value: baselineValue, actual_value: actualValue,
      ...(target ? { target_value: numberValue(target, "KPI target") } : {}),
      evidence_ref: evidenceRef,
      baseline_evidence_ref: evidenceRef,
    }],
    observed_at: observedAt,
  };
}

export function buildGrowthValidationUnknownPayload(input) {
  const method = clean(input.validation_method).toUpperCase();
  const methods = ["MEASURE", "DOCUMENT_REVIEW", "CUSTOMER_INTERVIEW", "PILOT", "SUPPLIER_QUOTE", "MARKET_TEST", "EXPERT_REVIEW"];
  if (!methods.includes(method)) throw new Error("Select a supported validation method.");
  return {
    question: textValue(input.question, "Unknown question", 4000),
    decision_variable: textValue(input.decision_variable, "Decision variable", 200),
    impact_if_wrong: numberValue(input.impact_if_wrong, "Impact if wrong", { min: 0, max: 100 }),
    probability_unknown: numberValue(input.probability_unknown, "Unknown probability", { min: 0, max: 1 }),
    validation_effort: numberValue(input.validation_effort, "Validation effort", { min: 0.1, max: 100 }),
    validation_method: method,
  };
}

export function filterGrowthOpportunities(rows = [], search = "", status = "ALL", category = "ALL") {
  const query = clean(search).toLowerCase();
  return rows.filter((item) => {
    if (status !== "ALL" && String(item.status).toUpperCase() !== status) return false;
    if (category !== "ALL" && String(item.category).toUpperCase() !== category) return false;
    if (!query) return true;
    return [item.title, item.category, item.opportunity_statement, item.success_hypothesis, item.currency]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  });
}

export function summarizeGrowthOpportunities(rows = []) {
  const result = { total: rows.length, proposed: 0, accepted: 0, inProgress: 0, realized: 0, rejected: 0, closed: 0, other: 0 };
  for (const item of rows) {
    const status = String(item.status ?? "").toUpperCase();
    if (status === "PROPOSED") result.proposed += 1;
    else if (status === "ACCEPTED") result.accepted += 1;
    else if (status === "IN_PROGRESS") result.inProgress += 1;
    else if (status === "REALIZED") result.realized += 1;
    else if (status === "REJECTED") result.rejected += 1;
    else if (status === "CLOSED") result.closed += 1;
    else result.other += 1;
  }
  return result;
}

export function growthReadinessSummary(governance) {
  const readiness = governance?.readiness;
  return {
    ready: readiness?.ready === true,
    blockerCount: Array.isArray(readiness?.blockers) ? readiness.blockers.length : 0,
    missingEvidence: Array.isArray(readiness?.missing_evidence) ? readiness.missing_evidence : [],
  };
}
