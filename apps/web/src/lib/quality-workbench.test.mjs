import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityDecisionPayload,
  buildQualityDefectPayload,
  buildQualityDispositionPayload,
  buildQualityInspectionPayload,
  buildQualityNcrActionPayload,
  buildQualityNcrTransitionPayload,
  buildQualityNcrVerificationPayload,
  buildQualityPlanPayload,
  buildQualityQuery,
  buildQualityResultPayload,
  filterQualityRows,
  normalizeQualityRows,
  parseQualityCriteriaDraft,
  summarizeQualityWorkspace,
  validateQualityIdempotencyKey,
} from "./quality-workbench.mjs";

const id = "7e2e7d1a-8a1b-4d6f-9ab7-5a30b102c8a1";
const criterion = {
  criterion_code: "WIDTH", name: "Fabric width", value_type: "NUMERIC",
  comparison_operator: "BETWEEN", lower_limit: 10, upper_limit: 12,
  unit: "in", is_required: true, is_critical: true, sequence_number: 1,
};

test("normalizes quality list response arrays and envelopes", () => {
  const rows = [{ id: "a" }];
  assert.deepEqual(normalizeQualityRows(rows), rows);
  assert.deepEqual(normalizeQualityRows({ inspections: rows }, "inspections"), rows);
  assert.deepEqual(normalizeQualityRows({ data: { rows } }), rows);
  assert.deepEqual(normalizeQualityRows(null), []);
});

test("builds inspection list filters and bounds the API limit", () => {
  const params = new URLSearchParams(buildQualityQuery({
    status: "IN_PROGRESS", inspection_type: "FINAL", target_type: "WORK_ORDER", limit: 25,
  }, "inspections").slice(1));
  assert.equal(params.get("status"), "IN_PROGRESS");
  assert.equal(params.get("inspection_type"), "FINAL");
  assert.equal(params.get("target_type"), "WORK_ORDER");
  assert.equal(params.get("limit"), "25");
  assert.throws(() => buildQualityQuery({ status: "UNKNOWN" }, "inspections"), /status/);
  assert.throws(() => buildQualityQuery({ limit: 101 }, "plans"), /between 1 and 100/);
});

test("builds plan queries using supported types and states", () => {
  const params = new URLSearchParams(buildQualityQuery({ status: "ACTIVE", inspection_type: "INCOMING" }, "plans").slice(1));
  assert.equal(params.get("status"), "ACTIVE");
  assert.equal(params.get("inspection_type"), "INCOMING");
  assert.throws(() => buildQualityQuery({ status: "APPROVED" }, "plans"), /Plan status/);
});

test("builds hold and rework filters", () => {
  assert.match(buildQualityQuery({ status: "ACTIVE" }, "holds"), /status=ACTIVE/);
  assert.match(buildQualityQuery({ status: "REWORK_REQUIRED" }, "rework"), /status=REWORK_REQUIRED/);
  assert.throws(() => buildQualityQuery({ status: "OPEN" }, "holds"), /Hold status/);
});

test("builds validated inspection payload and enforces required inspection plans", () => {
  assert.deepEqual(buildQualityInspectionPayload({
    inspection_type: "FINAL", target_type: "WORK_ORDER", target_id: id,
    plan_code: " final-v1 ", sample_quantity: "25.125", notes: "End-line quality gate",
  }), {
    inspection_type: "FINAL", target_type: "WORK_ORDER", target_id: id,
    plan_code: "FINAL-V1", sample_quantity: 25.125, notes: "End-line quality gate",
  });
  assert.throws(() => buildQualityInspectionPayload({
    inspection_type: "INCOMING", target_type: "INVENTORY_ITEM", target_id: id,
  }), /active inspection plan is required/);
  assert.throws(() => buildQualityInspectionPayload({
    inspection_type: "FINAL", target_type: "WORK_ORDER", target_id: "not-a-uuid", plan_code: "F",
  }), /valid UUID/);
  assert.throws(() => buildQualityInspectionPayload({
    inspection_type: "FINAL", target_type: "WORK_ORDER", target_id: id, plan_code: "F", sample_quantity: "1.12345",
  }), /at most 4 decimal places/);
});

test("parses and validates plan criteria with numeric bounds and unique codes", () => {
  assert.deepEqual(parseQualityCriteriaDraft(JSON.stringify([criterion])), [{
    ...criterion, criterion_code: "WIDTH", is_required: true, is_critical: true,
  }]);
  assert.throws(() => parseQualityCriteriaDraft("not json"), /valid JSON/);
  assert.throws(() => parseQualityCriteriaDraft([]), /between 1 and 100/);
  assert.throws(() => parseQualityCriteriaDraft([{ ...criterion, criterion_code: "A" }, { ...criterion, criterion_code: "A" }]), /unique/);
  assert.throws(() => parseQualityCriteriaDraft([{ ...criterion, lower_limit: 13 }]), /less than or equal/);
});

test("enforces criterion value type and comparison operator compatibility", () => {
  assert.throws(() => parseQualityCriteriaDraft([{
    criterion_code: "BOOL", name: "Switch", value_type: "BOOLEAN", comparison_operator: "GT", target_value: "true",
  }]), /Range comparison operators require a NUMERIC/);
  assert.throws(() => parseQualityCriteriaDraft([{
    criterion_code: "TEXT", name: "Label", value_type: "TEXT", comparison_operator: "BETWEEN", lower_limit: 1, upper_limit: 4,
  }]), /require a NUMERIC/);
  assert.throws(() => parseQualityCriteriaDraft([{
    criterion_code: "IN", name: "Grade", value_type: "ENUM", comparison_operator: "IN", allowed_values: [],
  }]), /non-empty allowed_values/);
});

test("builds immutable inspection plan draft payload", () => {
  const payload = buildQualityPlanPayload({
    plan_code: " incoming-a ", name: "Incoming fabric inspection",
    inspection_type: "INCOMING", default_sample_quantity: "5", criteria: JSON.stringify([criterion]),
  });
  assert.equal(payload.plan_code, "INCOMING-A");
  assert.equal(payload.criteria.length, 1);
  assert.equal(payload.default_sample_quantity, 5);
});

test("builds optimistic-versioned inspection decision payloads", () => {
  assert.deepEqual(buildQualityDecisionPayload({ expected_version: "4", action: "START" }), {
    expected_version: 4, action: "START",
  });
  assert.deepEqual(buildQualityDecisionPayload({ expected_version: 2, action: "HOLD", reason: "Await material review" }), {
    expected_version: 2, action: "HOLD", reason: "Await material review",
  });
  assert.throws(() => buildQualityDecisionPayload({ expected_version: 1, action: "FAIL" }), /reason/);
  assert.throws(() => buildQualityDecisionPayload({ expected_version: 1, action: "APPROVE" }), /Choose START/);
});

test("requires defect code, severity, quantity and useful description", () => {
  assert.deepEqual(buildQualityDefectPayload({
    defect_code: " hole ", severity: "major", affected_quantity: "2.5",
    description: "Fabric surface contains a visible hole", evidence_reference: "qc://photo/1",
  }), {
    defect_code: "HOLE", severity: "MAJOR", affected_quantity: 2.5,
    description: "Fabric surface contains a visible hole", evidence: { reference: "qc://photo/1" },
  });
  assert.throws(() => buildQualityDefectPayload({ defect_code: "D", severity: "LOW", description: "bad" }), /severity/);
  assert.throws(() => buildQualityDefectPayload({ defect_code: "D", severity: "MINOR", description: "bad", affected_quantity: 0 }), /between/);
});

test("builds inspection result with optional evidence", () => {
  assert.deepEqual(buildQualityResultPayload({
    criterion_code: " width ", observed_value: "11.5", notes: "Within tolerance", evidence_reference: "qc://measure/2",
  }), {
    criterion_code: "WIDTH", observed_value: "11.5", notes: "Within tolerance",
    evidence: { reference: "qc://measure/2" },
  });
  assert.throws(() => buildQualityResultPayload({ criterion_code: "", observed_value: "" }), /criterion_code/);
});

test("enforces disposition quantity only for inventory stock actions", () => {
  assert.deepEqual(buildQualityDispositionPayload({
    expected_version: "3", action: "SCRAP", quantity: "8", reason: "Unrecoverable nonconforming stock",
  }), { expected_version: 3, action: "SCRAP", quantity: 8, reason: "Unrecoverable nonconforming stock" });
  assert.deepEqual(buildQualityDispositionPayload({
    expected_version: 3, action: "REWORK", reason: "Repair and reinspect",
  }), { expected_version: 3, action: "REWORK", reason: "Repair and reinspect" });
  assert.throws(() => buildQualityDispositionPayload({
    expected_version: 1, action: "SCRAP", reason: "Scrap held stock",
  }), /Quantity is required/);
  assert.throws(() => buildQualityDispositionPayload({
    expected_version: 1, action: "RELEASE", quantity: "1", reason: "Release after review",
  }), /only used/);
});

test("builds NCR containment, corrective and preventive action payloads", () => {
  assert.deepEqual(buildQualityNcrActionPayload({
    action_type: "corrective", action_text: "Replace the faulty needle guide", due_date: "2026-12-01",
  }), { action_type: "CORRECTIVE", action_text: "Replace the faulty needle guide", due_date: "2026-12-01" });
  assert.throws(() => buildQualityNcrActionPayload({
    action_type: "INVESTIGATE", action_text: "Investigate defect",
  }), /CONTAINMENT/);
  assert.throws(() => buildQualityNcrActionPayload({
    action_type: "PREVENTIVE", action_text: "Action", due_date: "2026-02-30",
  }), /real calendar date/);
});

test("CAPA completion and verification require evidence", () => {
  assert.deepEqual(buildQualityNcrTransitionPayload({
    expected_version: 2, action: "COMPLETE", reason: "Corrective action installed", evidence: { work_order: "WO-1" },
  }), {
    expected_version: 2, action: "COMPLETE", reason: "Corrective action installed", evidence: { work_order: "WO-1" },
  });
  assert.throws(() => buildQualityNcrTransitionPayload({
    expected_version: 2, action: "COMPLETE", reason: "Completed",
  }), /non-empty evidence/);
  assert.throws(() => buildQualityNcrTransitionPayload({
    expected_version: 2, action: "COMPLETE", reason: "Completed", evidence: { reference: " " },
  }), /non-empty evidence/);
  assert.deepEqual(buildQualityNcrVerificationPayload({
    expected_version: 3, decision: "PASS", reason: "Independent audit passed", evidence: { audit_ref: "AUD-8" },
  }), {
    expected_version: 3, decision: "PASS", reason: "Independent audit passed", evidence: { audit_ref: "AUD-8" },
  });
  assert.throws(() => buildQualityNcrVerificationPayload({
    expected_version: 1, decision: "PASS", reason: "Passed", evidence: {},
  }), /non-empty evidence/);
  assert.throws(() => buildQualityNcrVerificationPayload({
    expected_version: 1, decision: "PASS", reason: "Passed", evidence: { reference: "" },
  }), /non-empty evidence/);
});

test("summarizes inspections, active plans, holds and rework without inventing counts", () => {
  const summary = summarizeQualityWorkspace({
    inspections: [
      { status: "IN_PROGRESS", defect_count: 1 },
      { status: "FAILED", defect_count: 2 },
      { status: "PASSED", defect_count: 0 },
    ],
    plans: [{ status: "ACTIVE" }, { status: "DRAFT" }],
    holds: [{ status: "ACTIVE" }, { status: "RELEASED" }],
    reworkOrders: [{ status: "IN_PROGRESS" }, { status: "VERIFIED" }],
  });
  assert.deepEqual(summary, {
    inspections: 3, inProgress: 1, failed: 1, activeHolds: 1,
    criticalDefects: 3, activePlans: 1, openRework: 1,
  });
});

test("filters quality lists by status and common identifiers", () => {
  const rows = [
    { id: "1", target_type: "WORK_ORDER", target_id: "WO-100", status: "FAILED" },
    { id: "2", target_type: "INVENTORY_ITEM", target_id: "ITEM-1", status: "PASSED" },
  ];
  assert.deepEqual(filterQualityRows(rows, "wo-100").map((row) => row.id), ["1"]);
  assert.deepEqual(filterQualityRows(rows, "", "PASSED").map((row) => row.id), ["2"]);
});

test("validates idempotency keys against empty, oversized and multiline input", () => {
  assert.equal(validateQualityIdempotencyKey("quality:decision:123"), "quality:decision:123");
  assert.throws(() => validateQualityIdempotencyKey(""), /1 to 220/);
  assert.throws(() => validateQualityIdempotencyKey("bad\nkey"), /single-line/);
  assert.throws(() => validateQualityIdempotencyKey("x".repeat(221)), /1 to 220/);
});
