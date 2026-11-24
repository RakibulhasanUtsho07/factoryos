import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMaintenanceAssetPayload,
  buildMaintenanceAssetUpdatePayload,
  buildMaintenanceBreakdownWorkOrderPayload,
  buildMaintenanceGenerateDuePayload,
  buildMaintenancePmPlanPayload,
  buildMaintenancePmTransitionPayload,
  buildMaintenanceQuery,
  buildMaintenanceSparePartIssuePayload,
  buildMaintenanceSparePartPayload,
  buildMaintenanceTaskCompletionPayload,
  buildMaintenanceWorkOrderTransitionPayload,
  filterMaintenanceRows,
  normalizeMaintenanceRows,
  parseMaintenanceChecklistDraft,
  summarizeMaintenanceWorkspace,
  validateMaintenanceIdempotencyKey,
} from "./maintenance-workbench.mjs";

const asset = "7e2e7d1a-8a1b-4d6f-9ab7-5a30b102c8a1";
const item = "a2f4c3d8-81a0-4c29-9d0a-5b11d3c7e2f9";

test("normalizes maintenance arrays and named API collection envelopes", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(normalizeMaintenanceRows(rows), rows);
  assert.deepEqual(normalizeMaintenanceRows({ assets: rows }, "assets"), rows);
  assert.deepEqual(normalizeMaintenanceRows({ plans: rows }, "plans"), rows);
  assert.deepEqual(normalizeMaintenanceRows({ work_orders: rows }, "work_orders"), rows);
  assert.deepEqual(normalizeMaintenanceRows({ data: { rows } }), rows);
  assert.deepEqual(normalizeMaintenanceRows(null), []);
});

test("builds bounded asset queries and rejects invalid filters", () => {
  const params = new URLSearchParams(buildMaintenanceQuery({ status: "ACTIVE", limit: 20 }, "assets").slice(1));
  assert.equal(params.get("status"), "ACTIVE");
  assert.equal(params.get("limit"), "20");
  assert.throws(() => buildMaintenanceQuery({ status: "DECOMMISSIONED" }, "assets"), /Asset status/);
  assert.throws(() => buildMaintenanceQuery({ limit: 101 }, "assets"), /between 1 and 100/);
});

test("builds preventive-maintenance query filters", () => {
  const params = new URLSearchParams(buildMaintenanceQuery({ status: "ACTIVE", asset_id: asset }, "plans").slice(1));
  assert.equal(params.get("status"), "ACTIVE");
  assert.equal(params.get("asset_id"), asset);
  assert.throws(() => buildMaintenanceQuery({ status: "APPROVED" }, "plans"), /PM plan status/);
});

test("builds work-order query filters", () => {
  const params = new URLSearchParams(buildMaintenanceQuery({
    status: "IN_PROGRESS", work_order_type: "BREAKDOWN", priority: "URGENT", asset_id: asset,
  }, "work_orders").slice(1));
  assert.equal(params.get("status"), "IN_PROGRESS");
  assert.equal(params.get("work_order_type"), "BREAKDOWN");
  assert.equal(params.get("priority"), "URGENT");
  assert.equal(params.get("asset_id"), asset);
  assert.throws(() => buildMaintenanceQuery({ priority: "CRITICAL" }, "work_orders"), /priority/);
});

test("parses checklist draft rows with required and optional markers", () => {
  assert.deepEqual(parseMaintenanceChecklistDraft(
    "LOCKOUT | Isolate electrical supply\nBEARINGS | Inspect bearing wear | optional",
  ), [
    { code: "LOCKOUT", description: "Isolate electrical supply", required: true },
    { code: "BEARINGS", description: "Inspect bearing wear", required: false },
  ]);
  assert.deepEqual(parseMaintenanceChecklistDraft(""), []);
  assert.throws(() => parseMaintenanceChecklistDraft("invalid row"), /CODE \| description/);
  assert.throws(() => parseMaintenanceChecklistDraft("A | First\nA | Duplicate"), /unique/);
  assert.throws(() => parseMaintenanceChecklistDraft("A | First | maybe"), /required or optional/);
});

test("builds normalized factory asset registration payload", () => {
  assert.deepEqual(buildMaintenanceAssetPayload({
    asset_code: " compressor-01 ", name: " Air Compressor ", asset_type: " machine ",
    manufacturer: "Acme", criticality: "HIGH", commissioned_on: "2026-01-01",
    warranty_expires_on: "2027-01-01", notes: "Main line",
  }), {
    asset_code: "COMPRESSOR-01", name: "Air Compressor", asset_type: "MACHINE",
    manufacturer: "Acme", criticality: "HIGH", commissioned_on: "2026-01-01",
    warranty_expires_on: "2027-01-01", notes: "Main line",
  });
  assert.throws(() => buildMaintenanceAssetPayload({
    asset_code: "A", name: "Machine", asset_type: "Machine",
    commissioned_on: "2026-10-01", warranty_expires_on: "2026-09-30",
  }), /before commissioning/);
  assert.throws(() => buildMaintenanceAssetPayload({
    asset_code: "A", name: "Machine", asset_type: "Machine", criticality: "SEVERE",
  }), /criticality/);
});

test("supports optional parent asset and validates parent UUID", () => {
  assert.equal(buildMaintenanceAssetPayload({
    asset_code: "A", name: "Child", asset_type: "MACHINE", parent_asset_id: asset,
  }).parent_asset_id, asset);
  assert.throws(() => buildMaintenanceAssetPayload({
    asset_code: "A", name: "Child", asset_type: "MACHINE", parent_asset_id: "bad",
  }), /valid UUID/);
});

test("builds optimistic-versioned asset update with reason and selected fields", () => {
  assert.deepEqual(buildMaintenanceAssetUpdatePayload({
    expected_version: "4", name: "Rebuilt compressor", status: "INACTIVE", reason: "Asset removed from line",
  }), {
    expected_version: 4, name: "Rebuilt compressor", status: "INACTIVE", reason: "Asset removed from line",
  });
  assert.throws(() => buildMaintenanceAssetUpdatePayload({
    expected_version: 1, reason: "No changes",
  }), /At least one/);
  assert.throws(() => buildMaintenanceAssetUpdatePayload({
    expected_version: 2, status: "UNKNOWN", reason: "Change state",
  }), /Asset status/);
  assert.throws(() => buildMaintenanceAssetUpdatePayload({
    expected_version: 2, name: "New name", reason: "x",
  }), /Reason/);
});

test("clears nullable asset fields and validates revised warranty dates", () => {
  assert.equal(buildMaintenanceAssetUpdatePayload({
    expected_version: 2, location: "", reason: "Clear old location",
  }).location, null);
  assert.throws(() => buildMaintenanceAssetUpdatePayload({
    expected_version: 2, commissioned_on: "2026-12-01", current_warranty_expires_on: "2026-11-30",
    reason: "Correct commissioning date",
  }), /before commissioning/);
});

test("builds PM plan with bounded interval, due date and checklist", () => {
  assert.deepEqual(buildMaintenancePmPlanPayload({
    asset_id: asset, plan_code: " pm-monthly ", name: "Monthly inspection",
    interval_value: "1", interval_unit: "MONTH", next_due_on: "2026-12-01",
    requires_shutdown: true, checklist: [{ code: "BELT", description: "Inspect belt" }],
  }), {
    asset_id: asset, plan_code: "PM-MONTHLY", name: "Monthly inspection",
    interval_value: 1, interval_unit: "MONTH", next_due_on: "2026-12-01",
    estimated_duration_minutes: 60, requires_shutdown: true,
    checklist: [{ code: "BELT", description: "Inspect belt", required: true }],
  });
  assert.throws(() => buildMaintenancePmPlanPayload({
    asset_id: asset, plan_code: "P", name: "Plan", interval_value: 0,
    interval_unit: "DAY", next_due_on: "2026-12-01",
  }), /interval_value/);
  assert.throws(() => buildMaintenancePmPlanPayload({
    asset_id: asset, plan_code: "P", name: "Plan", interval_value: 1,
    interval_unit: "YEAR", next_due_on: "2026-12-01",
  }), /interval unit/);
});

test("requires real PM due dates and asset UUID", () => {
  assert.throws(() => buildMaintenancePmPlanPayload({
    asset_id: "bad", plan_code: "P", name: "Plan", interval_value: 1,
    interval_unit: "DAY", next_due_on: "2026-02-30",
  }), /valid UUID|real calendar date/);
});

test("builds maker-checker PM transitions with reason and row version", () => {
  assert.deepEqual(buildMaintenancePmTransitionPayload({
    expected_version: "2", action: "ACTIVATE", reason: "Approved by maintenance manager",
  }), { expected_version: 2, action: "ACTIVATE", reason: "Approved by maintenance manager" });
  assert.throws(() => buildMaintenancePmTransitionPayload({
    expected_version: 1, action: "APPROVE", reason: "Approve",
  }), /ACTIVATE/);
});

test("builds due-work-order generation payload from expected PM version", () => {
  assert.deepEqual(buildMaintenanceGenerateDuePayload({
    expected_version: "3", reason: "Monthly PM occurrence",
  }), { expected_version: 3, reason: "Monthly PM occurrence" });
  assert.throws(() => buildMaintenanceGenerateDuePayload({ expected_version: 0 }), /expected_version/);
});

test("builds breakdown work order with optional scheduling and checklist", () => {
  assert.deepEqual(buildMaintenanceBreakdownWorkOrderPayload({
    asset_id: asset, priority: "URGENT", title: "Motor overheated",
    description: "Motor stopped while operating", failure_code: "OVERHEAT",
    scheduled_start_at: "2026-11-24T08:00:00+06:00",
    due_at: "2026-11-24T10:00:00+06:00",
    checklist: [{ code: "ISOLATE", description: "Lockout and isolate" }],
  }), {
    asset_id: asset, priority: "URGENT", title: "Motor overheated",
    description: "Motor stopped while operating", failure_code: "OVERHEAT",
    scheduled_start_at: "2026-11-24T02:00:00.000Z",
    due_at: "2026-11-24T04:00:00.000Z",
    checklist: [{ code: "ISOLATE", description: "Lockout and isolate", required: true }],
  });
  assert.throws(() => buildMaintenanceBreakdownWorkOrderPayload({
    asset_id: asset, priority: "URGENT", title: "Failure", description: "Motor stopped",
    scheduled_start_at: "2026-11-24T10:00:00Z", due_at: "2026-11-24T09:00:00Z",
  }), /before scheduled start/);
});

test("requires an active supported work-order transition action", () => {
  assert.deepEqual(buildMaintenanceWorkOrderTransitionPayload({
    expected_version: 3, action: "START", reason: "Technician began repair",
  }), { expected_version: 3, action: "START", reason: "Technician began repair" });
  assert.throws(() => buildMaintenanceWorkOrderTransitionPayload({
    expected_version: 2, action: "PAUSE", reason: "Hold work",
  }), /not supported/);
});

test("requires non-empty structured checklist evidence and reason", () => {
  assert.deepEqual(buildMaintenanceTaskCompletionPayload({
    expected_version: "2", reason: "Inspection completed",
    evidence: { measured_value: "12.4", unit: "mm", result: "PASS" },
  }), {
    expected_version: 2, reason: "Inspection completed",
    evidence: { measured_value: "12.4", unit: "mm", result: "PASS" },
  });
  assert.throws(() => buildMaintenanceTaskCompletionPayload({
    expected_version: 1, reason: "Completed", evidence: {},
  }), /non-empty structured evidence/);
  assert.throws(() => buildMaintenanceTaskCompletionPayload({
    expected_version: 1, reason: "x", evidence: { result: "PASS" },
  }), /Reason/);
});

test("builds four-decimal spare-part requirement", () => {
  assert.deepEqual(buildMaintenanceSparePartPayload({
    inventory_item_id: item, required_quantity: "2.1250", notes: "Use sealed stock",
  }), {
    inventory_item_id: item, required_quantity: 2.125, notes: "Use sealed stock",
  });
  assert.throws(() => buildMaintenanceSparePartPayload({
    inventory_item_id: item, required_quantity: 0,
  }), /between 0.0001/);
  assert.throws(() => buildMaintenanceSparePartPayload({
    inventory_item_id: item, required_quantity: "1.00001",
  }), /at most 4 decimal places/);
});

test("builds issue command with optimistic part version and mandatory reason", () => {
  assert.deepEqual(buildMaintenanceSparePartIssuePayload({
    expected_version: "5", quantity: "0.75", reason: "Issue for approved repair",
  }), { expected_version: 5, quantity: 0.75, reason: "Issue for approved repair" });
  assert.throws(() => buildMaintenanceSparePartIssuePayload({
    expected_version: 1, quantity: 1, reason: "x",
  }), /Reason/);
});

test("filters maintenance data by safe asset, plan and work-order metadata", () => {
  const rows = [
    { id: "1", asset_code: "CMP-01", name: "Compressor", status: "ACTIVE" },
    { id: "2", asset_code: "PMP-02", name: "Pump", status: "INACTIVE" },
  ];
  assert.deepEqual(filterMaintenanceRows(rows, "compress").map((row) => row.id), ["1"]);
  assert.deepEqual(filterMaintenanceRows(rows, "", "INACTIVE").map((row) => row.id), ["2"]);
});

test("summarizes asset criticality, due plans and open maintenance orders", () => {
  const summary = summarizeMaintenanceWorkspace({
    assets: [{ status: "ACTIVE", criticality: "CRITICAL" }, { status: "INACTIVE", criticality: "LOW" }],
    plans: [{ status: "ACTIVE", next_due_on: "2000-01-01" }, { status: "DRAFT", next_due_on: "2000-01-01" }],
    workOrders: [
      { status: "IN_PROGRESS", priority: "URGENT", due_at: "2000-01-01T00:00:00Z" },
      { status: "COMPLETED", priority: "HIGH", due_at: "2000-01-01T00:00:00Z" },
    ],
  });
  assert.equal(summary.activeAssets, 1);
  assert.equal(summary.criticalAssets, 1);
  assert.equal(summary.activePlans, 1);
  assert.equal(summary.duePlans, 1);
  assert.equal(summary.openWorkOrders, 1);
  assert.equal(summary.urgentWorkOrders, 1);
  assert.equal(summary.overdueWorkOrders, 1);
});

test("validates maintenance API idempotency key length and line breaks", () => {
  assert.equal(validateMaintenanceIdempotencyKey("maintenance:create:asset"), "maintenance:create:asset");
  assert.throws(() => validateMaintenanceIdempotencyKey(""), /1 to 220/);
  assert.throws(() => validateMaintenanceIdempotencyKey("bad\nkey"), /single-line/);
});
