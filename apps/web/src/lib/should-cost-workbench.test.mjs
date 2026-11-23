import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShouldCostAssessmentPayload,
  buildShouldCostProfilePayload,
  buildShouldCostQuery,
  buildShouldCostTransitionPayload,
  filterShouldCostProfiles,
  formatShouldCostMoney,
  normalizeShouldCostRows,
  shouldCostMarginTone,
  summarizeShouldCost,
} from "./should-cost-workbench.mjs";

const factoryId = "faaab63d-c447-46ce-950d-deebdd7f5f30";
const profileId = "6d66dc85-1c66-41eb-9b48-a842c9c9955d";
const targetId = "7b2e4e96-4f46-4ab5-b68d-7d7debed9b45";
const components = [
  ["MATERIAL", "DIRECT_RATE", [], "BOM material cost guidance"],
  ["LABOUR", "DIRECT_RATE", [], "Approved routing labour cost guidance"],
  ["ENERGY", "DIRECT_RATE", [], "Utility energy cost guidance"],
  ["FREIGHT", "FIXED_PER_BATCH", [], "Freight per shipment batch"],
  ["DUTY", "PERCENT_OF_BASE", ["MATERIAL"], "Duty assessed over material value"],
  ["OVERHEAD", "PERCENT_OF_BASE", ["MATERIAL", "LABOUR", "ENERGY"], "Factory overhead allocation"],
  ["SCRAP", "SCRAP_GROSS_UP", ["MATERIAL", "LABOUR"], "Scrap gross-up allowance"],
].map(([category, calculation_method, base_categories, guidance]) => ({
  category, calculation_method, base_categories, guidance, is_required: true,
}));
const currentProfile = {
  id: profileId, profile_code: "STANDARD", version: 1, currency: "BDT", output_unit: "PCS",
  status: "APPROVED", is_current: true, row_version: 2, created_by_user_id: "a",
  components: components.map(({ category, calculation_method, base_categories, guidance, is_required }) =>
    ({ category, calculation_method, base_categories, guidance, is_required })),
};
const evidence = [
  ...["MATERIAL", "LABOUR", "ENERGY"].map((category) => ({
    category, applicable: true, source_type: "COST_RATE_CARD", source_reference: category + "-RATE-01",
    source_as_of: "2026-11-20", source_snapshot: { rate_card: category },
    unit_code: category === "LABOUR" ? "HOUR" : category === "ENERGY" ? "KWH" : "KG",
    input_quantity: 3, unit_rate: 10, source_currency: "BDT",
    quantity_source_reference: category + "-APPROVED-QUANTITY-01",
    quantity_source_snapshot: { approval_id: category + "-01" },
    notes: "Verified source quantity and rate evidence",
  })),
  {
    category: "FREIGHT", applicable: true, source_type: "FREIGHT_QUOTE",
    source_reference: "FREIGHT-QUOTE-01", source_as_of: "2026-11-20", source_snapshot: { carrier: "approved carrier" },
    fixed_amount: 25, source_currency: "BDT", notes: "Approved freight quote for the batch",
  },
  {
    category: "DUTY", applicable: true, source_type: "DUTY_SCHEDULE",
    source_reference: "DUTY-SCHEDULE-01", source_as_of: "2026-11-20", source_snapshot: { schedule: "standard" },
    percentage_rate: 5, notes: "Current duty schedule for material inputs",
  },
  {
    category: "OVERHEAD", applicable: true, source_type: "OVERHEAD_POLICY",
    source_reference: "OH-POLICY-01", source_as_of: "2026-11-20", source_snapshot: { policy: "factory" },
    percentage_rate: 8, notes: "Approved overhead policy",
  },
  {
    category: "SCRAP", applicable: true, source_type: "QUALITY_STANDARD",
    source_reference: "SCRAP-STD-01", source_as_of: "2026-11-20", source_snapshot: { standard: "quality" },
    percentage_rate: 2, notes: "Quality standard scrap rate",
  },
];

test("normalizes direct arrays and nested API list envelopes", () => {
  const list = [{ id: "one" }];
  assert.deepEqual(normalizeShouldCostRows(list), list);
  assert.deepEqual(normalizeShouldCostRows({ items: list }), list);
  assert.deepEqual(normalizeShouldCostRows({ data: { items: list } }), list);
  assert.deepEqual(normalizeShouldCostRows({ profiles: list }, "profiles"), list);
  assert.deepEqual(normalizeShouldCostRows(null), []);
});

test("builds a canonical seven-category profile with uppercase codes", () => {
  const result = buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "standard", currency: "bdt", output_unit: "pcs", components,
  });
  assert.equal(result.profile_code, "STANDARD");
  assert.equal(result.currency, "BDT");
  assert.equal(result.output_unit, "PCS");
  assert.deepEqual(result.components.map((row) => row.category), [
    "MATERIAL", "LABOUR", "ENERGY", "FREIGHT", "DUTY", "OVERHEAD", "SCRAP",
  ]);
});

test("supports factory-level and product-specific profile scopes", () => {
  assert.equal(buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "FACTORY", currency: "BDT", output_unit: "PCS", components,
  }).product_id, undefined);
  assert.equal(buildShouldCostProfilePayload({
    factory_id: factoryId, product_id: targetId, profile_code: "PRODUCT", currency: "BDT", output_unit: "PCS", components,
  }).product_id, targetId);
});

test("rejects missing or duplicate cost categories", () => {
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BDT", output_unit: "PCS", components: components.slice(1),
  }), /all seven/);
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BDT", output_unit: "PCS",
    components: [...components.slice(0, 6), { ...components[6], category: "MATERIAL" }],
  }), /exactly once/);
});

test("enforces category-specific formula methods and earlier-category dependencies", () => {
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BDT", output_unit: "PCS",
    components: components.map((row) => row.category === "MATERIAL" ? { ...row, calculation_method: "FIXED_PER_BATCH" } : row),
  }), /not supported for MATERIAL/);
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BDT", output_unit: "PCS",
    components: components.map((row) => row.category === "DUTY" ? { ...row, base_categories: ["SCRAP"] } : row),
  }), /earlier cost categories/);
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BDT", output_unit: "PCS",
    components: components.map((row) => row.category === "OVERHEAD" ? { ...row, base_categories: ["MATERIAL", "MATERIAL"] } : row),
  }), /unique/);
});

test("validates profile identity, currency, unit and component guidance", () => {
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: "factory", profile_code: "X", currency: "BDT", output_unit: "PCS", components,
  }), /valid UUID/);
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BD", output_unit: "PCS", components,
  }), /three-letter/);
  assert.throws(() => buildShouldCostProfilePayload({
    factory_id: factoryId, profile_code: "X", currency: "BDT", output_unit: "", components,
  }), /Output unit/);
});

test("builds optimistic-versioned profile transition payloads", () => {
  assert.deepEqual(buildShouldCostTransitionPayload("3", "Reviewed formula dependencies and source guidance"), {
    expected_version: 3, reason: "Reviewed formula dependencies and source guidance",
  });
  assert.throws(() => buildShouldCostTransitionPayload(0, "Reason"), /positive integer/);
  assert.throws(() => buildShouldCostTransitionPayload(1, " "), /1 to 1000/);
});

test("builds complete evidence assessment for a current approved profile", () => {
  const result = buildShouldCostAssessmentPayload({
    scope_type: "QUOTATION", target_id: targetId, profile_id: profileId,
    target_quantity: "100", target_unit: "pcs", evidence,
  }, currentProfile);
  assert.equal(result.scope_type, "QUOTATION");
  assert.equal(result.profile_id, profileId);
  assert.equal(result.evidence.length, 7);
  assert.equal(result.evidence[0].quantity_source_type, "MANUAL_APPROVED");
  assert.equal(result.evidence[3].fixed_amount, 25);
  assert.equal(result.evidence[4].percentage_rate, 5);
});

test("rejects non-current profile and mismatched output unit", () => {
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: 1, target_unit: "PCS", evidence,
  }, { ...currentProfile, is_current: false }), /current approved profile/);
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: 1, target_unit: "KG", evidence,
  }, currentProfile), /output unit/);
});

test("requires every evidence category exactly once and traceable source snapshots", () => {
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: 1, target_unit: "PCS", evidence: evidence.slice(1),
  }, currentProfile), /each of the seven/);
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: 1, target_unit: "PCS",
    evidence: evidence.map((row) => row.category === "FREIGHT" ? { ...row, source_snapshot: "{}" } : row),
  }, currentProfile), /at least one evidence field/);
});

test("rejects missing manual approved quantity lineage for material, labour and energy", () => {
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: 1, target_unit: "PCS",
    evidence: evidence.map((row) => row.category === "MATERIAL" ? { ...row, quantity_source_reference: "" } : row),
  }, currentProfile), /quantity source reference/);
});

test("validates positive quantity/rates and bounded percentages", () => {
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: "0", target_unit: "PCS", evidence,
  }, currentProfile), /greater than zero/);
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: "1.123456", target_unit: "PCS", evidence,
  }, currentProfile), /4 decimal places/);
  const invalidScrap = evidence.map((row) => row.category === "SCRAP" ? { ...row, percentage_rate: 100 } : row);
  assert.throws(() => buildShouldCostAssessmentPayload({
    scope_type: "ORDER", target_id: targetId, profile_id: profileId,
    target_quantity: 1, target_unit: "PCS", evidence: invalidScrap,
  }, currentProfile), /formula limit/);
});

test("builds bounded profile and assessment list filters", () => {
  const profileQuery = new URLSearchParams(buildShouldCostQuery({ status: "approved", profile_code: "STD" }).slice(1));
  assert.equal(profileQuery.get("status"), "APPROVED");
  assert.equal(profileQuery.get("profile_code"), "STD");
  const assessmentQuery = new URLSearchParams(buildShouldCostQuery({
    scope_type: "quotation", target_id: targetId, limit: 50,
  }, "assessments").slice(1));
  assert.equal(assessmentQuery.get("scope_type"), "QUOTATION");
  assert.equal(assessmentQuery.get("target_id"), targetId);
  assert.equal(assessmentQuery.get("limit"), "50");
  assert.throws(() => buildShouldCostQuery({ status: "UNKNOWN" }), /status filter/);
  assert.throws(() => buildShouldCostQuery({ limit: 101 }, "assessments"), /between 1 and 100/);
});

test("summarizes profile lifecycle and assessment value", () => {
  assert.deepEqual(summarizeShouldCost(
    [{ status: "APPROVED", is_current: true }, { status: "PENDING_APPROVAL" }, { status: "DRAFT" }],
    [{ scope_type: "ORDER", scope_id: "1", total_cost: "10.00" }, { scope_type: "ORDER", scope_id: "1", total_cost: "15.00" }],
  ), {
    profiles: 3, currentProfiles: 1, pendingProfiles: 1, draftProfiles: 1,
    assessments: 2, costedTargets: 1, totalCostedValue: 25,
  });
});

test("filters profile register by status and code without exposing identity fields", () => {
  const profiles = [
    { id: "1", profile_code: "STANDARD", status: "APPROVED", created_by_user_id: "user1" },
    { id: "2", profile_code: "PREMIUM", status: "DRAFT", created_by_user_id: "user2" },
  ];
  assert.deepEqual(filterShouldCostProfiles(profiles, "standard").map((row) => row.id), ["1"]);
  assert.deepEqual(filterShouldCostProfiles(profiles, "", "DRAFT").map((row) => row.id), ["2"]);
  assert.deepEqual(filterShouldCostProfiles(profiles, "user1"), []);
});

test("formats money and classifies gross margin", () => {
  assert.equal(formatShouldCostMoney("1234.5", "BDT"), "BDT 1,234.50");
  assert.equal(shouldCostMarginTone("-2"), "NEGATIVE");
  assert.equal(shouldCostMarginTone("8"), "LOW");
  assert.equal(shouldCostMarginTone("15"), "MODERATE");
  assert.equal(shouldCostMarginTone("30"), "HEALTHY");
});
