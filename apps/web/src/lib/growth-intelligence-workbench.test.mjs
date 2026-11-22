import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrowthAssumptionDecisionPayload,
  buildGrowthAssumptionPayload,
  buildGrowthConstraintPayload,
  buildGrowthEvidenceGapDecisionPayload,
  buildGrowthEvidenceGapPayload,
  buildGrowthExperimentPayload,
  buildGrowthOpportunityDecisionPayload,
  buildGrowthOpportunityPayload,
  buildGrowthOwnerPayload,
  buildGrowthScenarioSetPayload,
  buildGrowthValidationUnknownPayload,
  filterGrowthOpportunities,
  growthReadinessSummary,
  normalizeGrowthRows,
  summarizeGrowthOpportunities,
} from "./growth-intelligence-workbench.mjs";

const REF = "https://example.com/approved-market-study";
const OWNER = "22222222-2222-4222-8222-222222222222";
const BASE_OPPORTUNITY = {
  title: "Increase export revenue",
  category: "EXPORT_READINESS",
  opportunity_statement: "Expand certified product sales into a new regional market.",
  success_hypothesis: "A verified export channel increases the order pipeline without breaching delivery capacity.",
  assumptions: ["There is validated demand from qualified customers."],
  expected_value_low: "100000",
  expected_value_high: "250000",
  currency: "BDT",
  uncertainty_pct: "20",
  effort: "MEDIUM",
  time_to_impact_days: "120",
  implementation_risk: "MEDIUM",
  evidence: { evidence_type: "MARKET_SIGNAL", description: "Customer interviews and buyer survey", reference_ref: REF, confidence: "0.8" },
};

function scenarioProfile(overrides = {}) {
  return {
    price_change_pct: "0", volume_change_pct: "0", variable_cost_change_pct: "0",
    fixed_cost_change_pct: "0", investment: "0", uncertainty_pct: "10",
    include_projected_constraints: true,
    capacity_utilization_pct: "70", quality_yield_pct: "98",
    cash_after_investment: "500000", delivery_backlog_days: "3",
    ...overrides,
  };
}

test("normalizes opportunity, detail, governance and scenario response envelopes", () => {
  const item = [{ id: "one" }];
  assert.deepEqual(normalizeGrowthRows(item), item);
  assert.deepEqual(normalizeGrowthRows({ items: item }), item);
  assert.deepEqual(normalizeGrowthRows({ opportunities: item }), item);
  assert.deepEqual(normalizeGrowthRows({ scenarios: item }, "scenarios"), item);
  assert.deepEqual(normalizeGrowthRows(null), []);
});

test("builds a scoped growth opportunity with required evidence and assumptions", () => {
  const payload = buildGrowthOpportunityPayload(BASE_OPPORTUNITY);
  assert.equal(payload.category, "EXPORT_READINESS");
  assert.equal(payload.expected_value_low, 100000);
  assert.equal(payload.expected_value_high, 250000);
  assert.equal(payload.evidence[0].reference_ref, REF);
  assert.throws(() => buildGrowthOpportunityPayload({ ...BASE_OPPORTUNITY, expected_value_low: "300000" }));
  assert.throws(() => buildGrowthOpportunityPayload({ ...BASE_OPPORTUNITY, evidence: { description: "No source" } }));
  assert.throws(() => buildGrowthOpportunityPayload({ ...BASE_OPPORTUNITY, assumptions: [] }));
});

test("requires proper category, value range, numeric domains and valid evidence URL", () => {
  assert.throws(() => buildGrowthOpportunityPayload({ ...BASE_OPPORTUNITY, category: "SOMETHING_ELSE" }));
  assert.throws(() => buildGrowthOpportunityPayload({ ...BASE_OPPORTUNITY, uncertainty_pct: "101" }));
  assert.throws(() => buildGrowthOpportunityPayload({
    ...BASE_OPPORTUNITY,
    evidence: { evidence_type: "MARKET_SIGNAL", description: "Signal", citation_url: "javascript:alert(1)" },
  }));
  assert.throws(() => buildGrowthOpportunityPayload({
    ...BASE_OPPORTUNITY,
    evidence: { evidence_type: "RESEARCH_CLAIM", description: "Claim", research_claim_id: "not-a-uuid" },
  }));
});

test("builds a named governance owner and rejects invalid user/role", () => {
  const result = buildGrowthOwnerPayload({ role_code: "DECISION_OWNER", owner_user_id: OWNER, rationale: "Independent executive decision authority" });
  assert.equal(result.owner_user_id, OWNER);
  assert.throws(() => buildGrowthOwnerPayload({ role_code: "DECISION_OWNER", owner_user_id: "x", rationale: "Independent" }));
  assert.throws(() => buildGrowthOwnerPayload({ role_code: "UNKNOWN", owner_user_id: OWNER, rationale: "Independent executive decision authority" }));
});

test("builds blocking assumptions and evidence-backed assumption decisions", () => {
  const assumption = buildGrowthAssumptionPayload({
    statement: "Customer demand is sufficient to support the forecast.",
    risk_if_false: "HIGH", confidence_pct: "65", validation_method: "Structured customer interview",
    rationale: "Validate with signed buyer interest", evidence_refs: [REF], blocks_decision: true,
  });
  assert.equal(assumption.risk_if_false, "HIGH");
  assert.equal(assumption.blocks_decision, true);
  assert.deepEqual(buildGrowthAssumptionDecisionPayload({
    decision: "VALIDATED", reason: "The evidence supports the stated assumption.", evidence_refs: [REF],
  }), { decision: "VALIDATED", reason: "The evidence supports the stated assumption.", evidence_refs: [REF] });
  assert.throws(() => buildGrowthAssumptionDecisionPayload({ decision: "VALIDATED", reason: "No linked evidence" }));
});

test("builds all four governance constraints and requires sourced values when applicable", () => {
  const notApplicable = buildGrowthConstraintPayload({
    dimension: "QUALITY", applicability: "NOT_APPLICABLE", constraint_name: "Quality gate",
    rationale: "No new production process or product specification changes are in scope.",
  });
  assert.equal(notApplicable.applicability, "NOT_APPLICABLE");
  const applicable = buildGrowthConstraintPayload({
    dimension: "CAPACITY", applicability: "APPLICABLE", constraint_name: "Line utilization",
    limit_operator: "MAX", threshold_value: "85", observed_value: "72", unit: "%",
    source_evidence_ref: REF, source_as_of: "2026-11-20T12:00:00Z", rationale: "Current available shift capacity.",
  });
  assert.equal(applicable.observed_value, 72);
  assert.equal(applicable.source_evidence_ref, REF);
  assert.throws(() => buildGrowthConstraintPayload({
    dimension: "CASH", applicability: "APPLICABLE", constraint_name: "Cash",
    rationale: "Measured cash", limit_operator: "MAX", threshold_value: "10", observed_value: "5",
  }));
  assert.throws(() => buildGrowthConstraintPayload({
    dimension: "DELIVERY", applicability: "NOT_APPLICABLE", rationale: "No",
  }));
});

test("builds decision-blocking evidence gaps and requires evidence when resolving", () => {
  const gap = buildGrowthEvidenceGapPayload({
    question: "Can the supplier meet the forecast lead time?",
    required_evidence: "Obtain a written supplier capacity and lead-time confirmation.",
    impact: "HIGH", blocks_decision: true,
  });
  assert.equal(gap.impact, "HIGH");
  assert.deepEqual(buildGrowthEvidenceGapDecisionPayload({
    decision: "RESOLVED", reason: "Supplier confirmation is now attached to the opportunity.", evidence_refs: [REF],
  }), { decision: "RESOLVED", reason: "Supplier confirmation is now attached to the opportunity.", evidence_refs: [REF] });
  assert.throws(() => buildGrowthEvidenceGapDecisionPayload({ decision: "RESOLVED", reason: "No evidence yet" }));
});

test("builds an authorized opportunity decision reason", () => {
  assert.deepEqual(buildGrowthOpportunityDecisionPayload({ decision: "ACCEPT", reason: "Governance is ready and the proposal is approved." }), {
    decision: "ACCEPT", reason: "Governance is ready and the proposal is approved.",
  });
  assert.throws(() => buildGrowthOpportunityDecisionPayload({ decision: "ACCEPT", reason: "" }));
});

test("builds immutable four-case scenario sets with linked baseline and deterministic sensitivity", () => {
  const payload = buildGrowthScenarioSetPayload({
    set_name: "November base planning",
    data_vintage: "2026-11-20T00:00:00Z",
    baseline_source_ref: REF, currency: "BDT",
    baseline_revenue: "1000000", baseline_variable_cost: "500000", baseline_fixed_cost: "200000",
    base: scenarioProfile(),
    upside: scenarioProfile({ volume_change_pct: "10", investment: "50000" }),
    downside: scenarioProfile({ volume_change_pct: "-5", variable_cost_change_pct: "5" }),
    stress: scenarioProfile({ volume_change_pct: "-15", variable_cost_change_pct: "10", investment: "100000" }),
    sensitivity_parameter: "volume_change_pct", sensitivity_low: "-10", sensitivity_high: "10", sensitivity_points: "5",
  }, [REF]);
  assert.equal(payload.profiles.upside.volume_change_pct, 10);
  assert.equal(payload.profiles.base.projected_constraint_metrics.quality_yield_pct, 98);
  assert.equal(payload.sensitivity[0].points, 5);
  assert.throws(() => buildGrowthScenarioSetPayload({
    set_name: "Bad", data_vintage: "2026-11-20T00:00:00Z", baseline_source_ref: "unlinked",
    currency: "BDT", baseline_revenue: "100", baseline_variable_cost: "20", baseline_fixed_cost: "30",
    base: scenarioProfile(), upside: scenarioProfile(), downside: scenarioProfile(), stress: scenarioProfile(),
    sensitivity_parameter: "volume_change_pct", sensitivity_low: "0", sensitivity_high: "0", sensitivity_points: "2",
  }, [REF]));
});

test("supports scenarios without projected constraints while preserving their not-ready boundary", () => {
  const payload = buildGrowthScenarioSetPayload({
    set_name: "First-pass model",
    data_vintage: "2026-11-20T00:00:00Z", baseline_source_ref: REF, currency: "BDT",
    baseline_revenue: "100", baseline_variable_cost: "30", baseline_fixed_cost: "20",
    base: scenarioProfile({ include_projected_constraints: false }),
    upside: scenarioProfile({ include_projected_constraints: false }),
    downside: scenarioProfile({ include_projected_constraints: false }),
    stress: scenarioProfile({ include_projected_constraints: false }),
    sensitivity_parameter: "price_change_pct", sensitivity_low: "-2", sensitivity_high: "2", sensitivity_points: "3",
  }, [REF]);
  assert.equal(payload.profiles.base.projected_constraint_metrics, undefined);
});

test("creates a bounded experiment plan with explicit leading indicators and stop conditions", () => {
  const result = buildGrowthExperimentPayload({
    name: "Customer pilot", objective: "Validate the export distribution channel.",
    hypothesis: "A limited pilot produces qualified purchase intent.",
    leading_indicators: "Qualified leads\nBuyer meeting count", duration_days: "30",
    baseline_metric_key: "qualified_leads", baseline_value: "10", unit: "count",
    stop_conditions: "Regulatory exception\nSupplier delivery failure",
  });
  assert.equal(result.duration_days, 30);
  assert.equal(result.baseline_measurements.qualified_leads, 10);
  assert.equal(result.leading_indicators.length, 2);
  assert.throws(() => buildGrowthExperimentPayload({ name: "X", baseline_metric_key: "Bad Key" }));
});

test("builds a risk-ranked validation unknown", () => {
  const result = buildGrowthValidationUnknownPayload({
    question: "Will the target distributor achieve the required service coverage?",
    decision_variable: "coverage_pct", impact_if_wrong: "80", probability_unknown: "0.5",
    validation_effort: "2", validation_method: "CUSTOMER_INTERVIEW",
  });
  assert.equal(result.probability_unknown, 0.5);
  assert.equal(result.validation_method, "CUSTOMER_INTERVIEW");
});

test("filters growth opportunities and reports lifecycle summary", () => {
  const opportunities = [
    { title: "Export pilot", category: "EXPORT_READINESS", status: "PROPOSED" },
    { title: "Margin improvement", category: "MARGIN_EXPANSION", status: "ACCEPTED" },
    { title: "Second market", category: "EXPORT_READINESS", status: "IN_PROGRESS" },
  ];
  assert.deepEqual(filterGrowthOpportunities(opportunities, "export").map(item => item.title), ["Export pilot", "Second market"]);
  assert.deepEqual(filterGrowthOpportunities(opportunities, "", "ALL", "MARGIN_EXPANSION").map(item => item.title), ["Margin improvement"]);
  assert.deepEqual(summarizeGrowthOpportunities(opportunities), {
    total: 3, proposed: 1, accepted: 1, inProgress: 1, realized: 0, rejected: 0, closed: 0, other: 0,
  });
});

test("keeps governance readiness as a deterministic completeness signal, not a forecast", () => {
  assert.deepEqual(growthReadinessSummary({ readiness: { ready: false, blockers: ["A", "B"], missing_evidence: [{ code: "A" }] } }), {
    ready: false, blockerCount: 2, missingEvidence: [{ code: "A" }],
  });
  assert.equal(growthReadinessSummary({ readiness: { ready: true, blockers: [] } }).ready, true);
});
