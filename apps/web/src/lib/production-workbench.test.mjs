import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationEventPayload,
  buildProductionOutputPayload,
  buildWorkOrderListQuery,
  buildWorkOrderPayload,
  buildWorkOrderTransitionPayload,
  filterWorkOrders,
  normalizeProductionRows,
  summarizeProduction,
} from "./production-workbench.mjs";

const ORDER_LINE = "a3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const OPERATION = "b3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";
const NEXT_OPERATION = "c3d0a8b2-8aef-4f9d-9d20-8819ee43f2a9";

test("normalizes work-order and shortage-radar API envelopes", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(normalizeProductionRows({ items: rows }), rows);
  assert.deepEqual(normalizeProductionRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeProductionRows({ work_orders: rows }, "work_orders"), rows);
  assert.deepEqual(normalizeProductionRows(null), []);
});

test("builds bounded work-order list query and lifecycle status filter", () => {
  assert.equal(buildWorkOrderListQuery({ limit: 25, status: "in_progress" }), "?limit=25&status=IN_PROGRESS");
  assert.equal(buildWorkOrderListQuery({ limit: 100, status: "ALL" }), "?limit=100");
  assert.throws(() => buildWorkOrderListQuery({ limit: 101 }), /limit/);
  assert.throws(() => buildWorkOrderListQuery({ status: "UNKNOWN" }), /status/);
});

test("builds idempotent work-order creation contract from a sales order line", () => {
  const payload = buildWorkOrderPayload({
    order_line_id: ORDER_LINE, target_quantity: "12.2500",
    planned_start_date: "2026-11-25", due_date: "2026-12-02",
    priority: "2", notes: "Cut and assemble",
  });
  assert.deepEqual(payload, {
    order_line_id: ORDER_LINE, target_quantity: 12.25,
    planned_start_date: "2026-11-25", due_date: "2026-12-02",
    priority: 2, notes: "Cut and assemble",
  });
  assert.equal(Object.hasOwn(payload, "factory_id"), false);
  assert.throws(() => buildWorkOrderPayload({ order_line_id: "bad", target_quantity: 1, planned_start_date: "2026-11-25" }), /UUID/);
  assert.throws(() => buildWorkOrderPayload({ order_line_id: ORDER_LINE, target_quantity: "0", planned_start_date: "2026-11-25" }), /greater than zero/);
  assert.throws(() => buildWorkOrderPayload({ order_line_id: ORDER_LINE, target_quantity: 1, planned_start_date: "2026-02-30" }), /calendar date/);
  assert.throws(() => buildWorkOrderPayload({ order_line_id: ORDER_LINE, target_quantity: 1, planned_start_date: "2026-11-25", due_date: "2026-11-24" }), /before/);
  assert.throws(() => buildWorkOrderPayload({ order_line_id: ORDER_LINE, target_quantity: 1.00001, planned_start_date: "2026-11-25" }), /four decimal/);
});

test("requires expected version and reasons for work-order hold and cancellation", () => {
  assert.deepEqual(buildWorkOrderTransitionPayload("RELEASE", 3), { expected_version: 3 });
  assert.deepEqual(buildWorkOrderTransitionPayload("CANCEL", 4, "Customer cancellation"), {
    expected_version: 4, reason: "Customer cancellation",
  });
  assert.throws(() => buildWorkOrderTransitionPayload("HOLD", 3), /reason is required/);
  assert.throws(() => buildWorkOrderTransitionPayload("DELETE", 3), /Unsupported/);
  assert.throws(() => buildWorkOrderTransitionPayload("RELEASE", 0), /expected_version/);
});

test("builds operation start, pause and downtime events with version fencing", () => {
  assert.deepEqual(buildOperationEventPayload({
    command: "START", expected_work_order_version: 2, expected_operation_version: 1,
  }), {
    command: "START", expected_work_order_version: 2, expected_operation_version: 1, source: "API",
  });
  const downtime = buildOperationEventPayload({
    command: "DOWNTIME_START", expected_work_order_version: 2, expected_operation_version: 2,
    reason: "Machine maintenance",
  });
  assert.equal(downtime.reason, "Machine maintenance");
  assert.throws(() => buildOperationEventPayload({
    command: "DOWNTIME_START", expected_work_order_version: 2, expected_operation_version: 2,
  }), /reason is required/);
});

test("validates zero WIP snapshots, positive transfers and operation targets", () => {
  assert.equal(buildOperationEventPayload({
    command: "WIP_REPORTED", expected_work_order_version: 1,
    expected_operation_version: 1, quantity: "0",
  }).quantity, 0);
  const transfer = buildOperationEventPayload({
    command: "WIP_TRANSFERRED", expected_work_order_version: 1,
    expected_operation_version: 1, quantity: "2.5", operation_id: OPERATION,
    target_operation_id: NEXT_OPERATION,
  });
  assert.equal(transfer.target_operation_id, NEXT_OPERATION);
  assert.throws(() => buildOperationEventPayload({
    command: "WIP_TRANSFERRED", expected_work_order_version: 1,
    expected_operation_version: 1, quantity: 1, operation_id: OPERATION,
  }), /target_operation_id/);
  assert.throws(() => buildOperationEventPayload({
    command: "WIP_TRANSFERRED", expected_work_order_version: 1,
    expected_operation_version: 1, quantity: 1, operation_id: OPERATION,
    target_operation_id: OPERATION,
  }), /same operation/);
  assert.throws(() => buildOperationEventPayload({
    command: "REWORK_REPORTED", expected_work_order_version: 1,
    expected_operation_version: 1, quantity: 0, reason: "Repair",
  }), /greater than zero/);
});

test("validates final production output, scrap rationale and optional serial evidence", () => {
  const payload = buildProductionOutputPayload({
    operation_id: OPERATION, expected_work_order_version: 8,
    expected_operation_version: 4, good_quantity: "3", scrap_quantity: "1",
    scrap_reason: "Fabric defect", finished_good_serial_codes: "FG-001\nFG-002\nFG-003",
  });
  assert.deepEqual(payload.finished_good_serial_codes, ["FG-001", "FG-002", "FG-003"]);
  assert.equal(payload.good_quantity, 3);
  assert.throws(() => buildProductionOutputPayload({
    operation_id: OPERATION, expected_work_order_version: 1,
    expected_operation_version: 1, good_quantity: 0, scrap_quantity: 0,
  }), /cannot both be zero/);
  assert.throws(() => buildProductionOutputPayload({
    operation_id: OPERATION, expected_work_order_version: 1,
    expected_operation_version: 1, good_quantity: 1, scrap_quantity: 1,
  }), /scrap reason/);
  assert.throws(() => buildProductionOutputPayload({
    operation_id: OPERATION, expected_work_order_version: 1,
    expected_operation_version: 1, good_quantity: 2, scrap_quantity: 0,
    finished_good_serial_codes: "FG-001",
  }), /exactly match/);
  assert.throws(() => buildProductionOutputPayload({
    operation_id: OPERATION, expected_work_order_version: 1,
    expected_operation_version: 1, good_quantity: 2, scrap_quantity: 0,
    finished_good_serial_codes: "FG-001\nFG-001",
  }), /unique/);
});

test("filters work-order register and summarizes material shortages", () => {
  const orders = [
    { work_order_number: "WO-SO-1", status: "IN_PROGRESS", product_name: "Cotton Shirt" },
    { work_order_number: "WO-SO-2", status: "DRAFT", product_name: "Jacket" },
  ];
  assert.deepEqual(filterWorkOrders(orders, { status: "IN_PROGRESS" }), [orders[0]]);
  assert.deepEqual(filterWorkOrders(orders, { search: "jacket" }), [orders[1]]);
  assert.deepEqual(summarizeProduction(orders, [
    { projected_shortage_quantity: "2.0000" }, { projected_shortage_quantity: "0.0000" },
  ]), {
    workOrderCount: 2, draftCount: 1, releasedCount: 0, inProgressCount: 1,
    onHoldCount: 0, completedCount: 0, materialRequirementCount: 2,
    shortageRequirementCount: 1, projectedShortageLines: 1,
  });
});
