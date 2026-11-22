import test from "node:test";
import assert from "node:assert/strict";
import {
  asCycleCountItems,
  buildCycleCountSessionPayload,
  buildCycleCountTaskPayload,
  buildRecurringCycleCountPayload,
  canReviewCycleCountProposal,
  cycleCountSummary,
  cycleCountTaskActions,
  cycleCountVariance,
  expectedSnapshotVisible,
  filterCycleCountTasks,
} from "./cycle-count-operations.mjs";

test("normalizes API lists without treating object payloads as arrays", () => {
  assert.deepEqual(asCycleCountItems({ items: [{ id: "a" }] }), [{ id: "a" }]);
  assert.deepEqual(asCycleCountItems({ tasks: [{ id: "b" }] }, "tasks"), [{ id: "b" }]);
  assert.deepEqual(asCycleCountItems("unexpected"), []);
});

test("summarizes task, session, recurring and review states", () => {
  const result = cycleCountSummary(
    [{ status: "SCHEDULED", overdue: true }, { status: "IN_PROGRESS" }, { status: "AWAITING_REVIEW", variance_escalation_status: "OPEN" }],
    [{ status: "IN_PROGRESS" }],
    [{ status: "ACTIVE" }, { status: "PAUSED" }],
    [{ status: "PENDING_REVIEW" }, { status: "APPLIED" }],
  );
  assert.deepEqual(result, {
    scheduled: 1, inProgress: 1, awaitingReview: 1, overdue: 1,
    activeSessions: 1, activePolicies: 1, pendingProposals: 1, openEscalations: 1,
  });
});

test("filters task board by status and searchable item/location identifiers", () => {
  const tasks = [
    { id: "1", item_sku: "RM-01", item_name: "Cotton", location_code: "BIN-A", status: "SCHEDULED" },
    { id: "2", item_sku: "FG-02", item_name: "Shirt", location_code: "BIN-B", status: "IN_PROGRESS" },
  ];
  assert.equal(filterCycleCountTasks(tasks, "cotton", "ALL").length, 1);
  assert.equal(filterCycleCountTasks(tasks, "", "IN_PROGRESS")[0].id, "2");
});

test("blind count snapshot is never exposed to the submitting counter", () => {
  const proposal = { blind_count_snapshot: true, created_by_user_id: "counter-1", ledger_quantity_at_count: null };
  assert.equal(expectedSnapshotVisible(proposal, "counter-1", true), false);
  assert.equal(cycleCountVariance(proposal), null);
});

test("review is blocked for submitter, missing permission, non-pending state and open escalation", () => {
  const proposal = { status: "PENDING_REVIEW", created_by_user_id: "counter-1" };
  assert.equal(canReviewCycleCountProposal(proposal, "counter-1", true), false);
  assert.equal(canReviewCycleCountProposal(proposal, "reviewer", false), false);
  assert.equal(canReviewCycleCountProposal({ ...proposal, status: "APPLIED" }, "reviewer", true), false);
  assert.equal(canReviewCycleCountProposal(proposal, "reviewer", true, "OPEN"), false);
  assert.equal(canReviewCycleCountProposal(proposal, "reviewer", true, "RESOLVED"), true);
});

test("task payload preserves due time, defaults to blind count and omits blank optional values", () => {
  const result = buildCycleCountTaskPayload({
    item_id: "item-1", due_at: "2026-12-01T08:00", priority: "20",
    blind_count: true, notes: " count ", location_id: "",
  });
  assert.equal(result.item_id, "item-1");
  assert.equal(result.priority, 20);
  assert.equal(result.blind_count, true);
  assert.equal(result.notes, "count");
  assert.equal("location_id" in result, false);
});

test("multi-bin session requires at least two distinct bins", () => {
  const result = buildCycleCountSessionPayload({
    item_id: "item-1", location_ids: ["bin-1", "bin-2", "bin-1"],
    assigned_to_user_id: "user-1", due_at: "2026-12-01T08:00",
  });
  assert.deepEqual(result.location_ids, ["bin-1", "bin-2"]);
  assert.throws(() => buildCycleCountSessionPayload({
    item_id: "item-1", location_ids: ["bin-1"],
    assigned_to_user_id: "user-1", due_at: "2026-12-01T08:00",
  }), /2 and 50/);
});

test("recurring policy uses either one bin or a multi-bin session target", () => {
  const result = buildRecurringCycleCountPayload({
    item_id: "item-1", location_ids: ["bin-1", "bin-2"],
    assigned_to_user_id: "user-1", cadence_unit: "weekly", cadence_interval: "2",
    first_run_at: "2026-12-01T08:00",
  });
  assert.equal(result.cadence_unit, "WEEKLY");
  assert.equal(result.cadence_interval, 2);
  assert.deepEqual(result.location_ids, ["bin-1", "bin-2"]);
  assert.equal("location_id" in result, false);
});

test("task controls respect assignment and lifecycle state", () => {
  assert.equal(cycleCountTaskActions({ status: "SCHEDULED", assigned_to_user_id: "user-1" }, "user-2").canStart, false);
  assert.equal(cycleCountTaskActions({ status: "SCHEDULED", assigned_to_user_id: "user-1" }, "user-1").canStart, true);
  assert.equal(cycleCountTaskActions({ status: "IN_PROGRESS", assigned_to_user_id: "user-1" }, "user-1").canSubmit, true);
});
