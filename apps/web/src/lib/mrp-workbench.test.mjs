import test from "node:test";
import assert from "node:assert/strict";
import {
  filterMrpRequirements,
  formatMrpQuantity,
  summarizeCapacityOperations,
  summarizeMrpRequirements,
} from "./mrp-workbench.mjs";

test("formats quantities with a unit and bounded precision", () => {
  assert.equal(formatMrpQuantity("12.34567", "KG"), "12.3457 KG");
  assert.equal(formatMrpQuantity("invalid"), "0");
});

test("summarizes covered, late and unsupplied material requirements", () => {
  const summary = summarizeMrpRequirements([
    { required_quantity: "10", shortage_quantity: "0", allocation_status: "COVERED" },
    { required_quantity: "4", shortage_quantity: "2", allocation_status: "LATE_SUPPLY" },
    { required_quantity: "3", shortage_quantity: "3", allocation_status: "UNSUPPLIED" },
  ]);
  assert.deepEqual(summary, {
    requirements: 3, required: 17, shortage: 5, covered: 1, late: 1, unsupplied: 1, shortageRows: 2,
  });
});

test("filters requirements by status and searchable order/material fields", () => {
  const rows = [
    { order_number: "SO-100", component_sku: "FAB-01", allocation_status: "COVERED" },
    { order_number: "SO-101", component_sku: "ZIP-02", allocation_status: "UNSUPPLIED" },
  ];
  assert.equal(filterMrpRequirements(rows, "zip")[0].order_number, "SO-101");
  assert.equal(filterMrpRequirements(rows, "", "COVERED").length, 1);
  assert.equal(filterMrpRequirements(rows, "nothing").length, 0);
});

test("summarizes finite-capacity operation states without treating blocked work as scheduled", () => {
  assert.deepEqual(summarizeCapacityOperations([
    { status: "SCHEDULED" },
    { status: "CAPACITY_CONFLICT" },
    { status: "BLOCKED_MATERIAL" },
    { status: "FROZEN_HORIZON_CONFLICT" },
  ]), { operations: 4, scheduled: 1, conflicts: 2, blocked: 1 });
});
