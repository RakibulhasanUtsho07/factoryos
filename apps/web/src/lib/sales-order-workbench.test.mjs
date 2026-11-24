import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderMaterialDispositionPayload,
  buildOrderProductionReportPayload,
  buildSalesOrderCreatePayload,
  buildSalesOrderListQuery,
  buildSalesOrderTransitionPayload,
  createSalesOrderClient,
  normalizeSalesOrderPagination,
  normalizeSalesOrderRows,
  summarizeSalesOrders,
} from "./sales-order-workbench.mjs";

const factoryId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d27";
const orderId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d28";
const lineId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d29";
const reservationId = "70e1db4f-dc2e-4cab-a3ec-13cc4c744d30";

test("normalizes list envelopes and rejects malformed list wrappers", () => {
  const items = [{ id: orderId, order_number: "SO-1" }];
  assert.deepEqual(normalizeSalesOrderRows(items), items);
  assert.deepEqual(normalizeSalesOrderRows({ items }), items);
  assert.deepEqual(normalizeSalesOrderRows({ data: { items } }), items);
  assert.deepEqual(normalizeSalesOrderRows(null), []);
  assert.deepEqual(normalizeSalesOrderRows({ unexpected: true }), []);
});

test("normalizes backend pagination with safe defaults", () => {
  assert.deepEqual(normalizeSalesOrderPagination({ pagination: {
    page: 2, limit: 20, total: 61, total_pages: 4,
  } }), { page: 2, limit: 20, total: 61, total_pages: 4 });
  assert.deepEqual(normalizeSalesOrderPagination({ pagination: {
    page: -1, limit: 0, total: -1, total_pages: "bad",
  } }), { page: 1, limit: 20, total: 0, total_pages: 0 });
});

test("builds bounded server-side paging, status and search query", () => {
  assert.equal(buildSalesOrderListQuery(), "?page=1&limit=20");
  assert.equal(buildSalesOrderListQuery({
    page: 3, limit: 50, status: "IN_PROGRESS", search: "SO 2026",
  }), "?page=3&limit=50&status=IN_PROGRESS&search=SO+2026");
  assert.throws(() => buildSalesOrderListQuery({ page: 0 }), /page/);
  assert.throws(() => buildSalesOrderListQuery({ limit: 101 }), /limit/);
  assert.throws(() => buildSalesOrderListQuery({ status: "ARCHIVED" }), /supported order status/);
  assert.throws(() => buildSalesOrderListQuery({ search: "x".repeat(101) }), /search/);
});

test("creates an order payload with normalized factory, line and optional fields", () => {
  const payload = buildSalesOrderCreatePayload({
    factory_id: factoryId,
    order_number: "  SO-2026-001 ",
    customer_name: " Example Customer ",
    customer_reference: "PO-77",
    order_date: "2026-11-24",
    requested_delivery_date: "2026-12-01",
    currency: "bdt",
    notes: "priority production",
    lines: [{
      line_number: 1, product_code: "FG-01", product_name: "Finished good",
      quantity: "10.2500", unit: "PCS", inventory_item_id: lineId,
      unit_price: "125.5",
    }],
  });
  assert.equal(payload.factory_id, factoryId);
  assert.equal(payload.order_number, "SO-2026-001");
  assert.equal(payload.currency, "BDT");
  assert.deepEqual(payload.lines[0], {
    line_number: 1, product_code: "FG-01", product_name: "Finished good",
    quantity: 10.25, unit: "PCS", inventory_item_id: lineId, unit_price: 125.5,
  });
});

test("rejects malformed, duplicate, over-precision and empty order lines", () => {
  const base = { factory_id: factoryId, order_number: "SO-1", lines: [{
    line_number: 1, product_code: "A", product_name: "Item A", quantity: 1, unit: "PCS",
  }] };
  assert.throws(() => buildSalesOrderCreatePayload({ ...base, factory_id: "bad" }), /factory_id/);
  assert.throws(() => buildSalesOrderCreatePayload({ ...base, lines: [] }), /At least one/);
  assert.throws(() => buildSalesOrderCreatePayload({ ...base, lines: [
    base.lines[0], { ...base.lines[0], line_number: 1 },
  ] }), /Duplicate order line numbers/);
  assert.throws(() => buildSalesOrderCreatePayload({ ...base, lines: [
    { ...base.lines[0], quantity: "1.00001" },
  ] }), /decimal places/);
});

test("requires an optimistic order version for status transitions", () => {
  assert.deepEqual(buildSalesOrderTransitionPayload({
    target_status: "CONFIRMED", expected_version: "2",
  }), { target_status: "CONFIRMED", expected_version: 2 });
  assert.throws(() => buildSalesOrderTransitionPayload({
    target_status: "CONFIRMED", expected_version: 0,
  }), /expected_version/);
  assert.throws(() => buildSalesOrderTransitionPayload({
    target_status: "UNKNOWN", expected_version: 2,
  }), /supported order status/);
});

test("validates good/scrap quantities and requires a scrap reason", () => {
  assert.deepEqual(buildOrderProductionReportPayload({
    order_line_id: lineId, good_quantity: "8.5", scrap_quantity: "1.5",
    scrap_reason: "surface defect", notes: "shift A",
  }), {
    order_line_id: lineId, good_quantity: 8.5, scrap_quantity: 1.5,
    scrap_reason: "surface defect", notes: "shift A",
  });
  assert.throws(() => buildOrderProductionReportPayload({
    order_line_id: lineId, good_quantity: 0, scrap_quantity: 0,
  }), /both be zero/);
  assert.throws(() => buildOrderProductionReportPayload({
    order_line_id: lineId, good_quantity: 1, scrap_quantity: 1,
  }), /scrap_reason is required/);
});

test("validates returned/scrapped material disposition", () => {
  assert.deepEqual(buildOrderMaterialDispositionPayload({
    reservation_id: reservationId, disposition_type: "RETURN_TO_STOCK",
    quantity: "0.5", notes: "unopened excess",
  }), {
    reservation_id: reservationId, disposition_type: "RETURN_TO_STOCK",
    quantity: 0.5, notes: "unopened excess",
  });
  assert.throws(() => buildOrderMaterialDispositionPayload({
    reservation_id: reservationId, disposition_type: "LOST", quantity: 1,
  }), /RETURN_TO_STOCK or SCRAPPED/);
  assert.throws(() => buildOrderMaterialDispositionPayload({
    reservation_id: "bad", disposition_type: "SCRAPPED", quantity: 1,
  }), /reservation_id/);
});

test("summarizes only loaded page rows and flags open overdue delivery promises", () => {
  const summary = summarizeSalesOrders([
    { status: "DRAFT", requested_delivery_date: "2026-11-23" },
    { status: "IN_PROGRESS", requested_delivery_date: "2026-11-20" },
    { status: "COMPLETED", requested_delivery_date: "2026-11-01" },
    { status: "CANCELLED", requested_delivery_date: "2026-11-22" },
  ], "2026-11-24");
  assert.deepEqual(summary, {
    total_loaded: 4, draft: 1, confirmed: 0, in_progress: 1,
    completed: 1, cancelled: 1, overdue: 2,
  });
});

test("client binds every operation to exact factory-scoped API paths and idempotency metadata", async () => {
  const calls = [];
  const client = createSalesOrderClient(async (path, options) => {
    calls.push({ path, options });
    return { ok: true };
  });
  await client.list({ page: 2, limit: 10, status: "DRAFT" });
  await client.get(orderId);
  await client.create({ order_number: "SO-1" }, "create-key");
  await client.transition(orderId, { target_status: "CONFIRMED", expected_version: 1 });
  await client.listProductionReports(orderId, 40);
  await client.createProductionReport(orderId, { good_quantity: 1 }, "report-key");
  await client.createMaterialDisposition(orderId, { quantity: 1 }, "disposition-key");
  assert.equal(calls[0].path, "/orders?page=2&limit=10&status=DRAFT");
  assert.equal(calls[1].path, "/orders/" + orderId);
  assert.equal(calls[2].path, "/orders");
  assert.equal(calls[2].options.idempotencyKey, "create-key");
  assert.equal(calls[3].path, "/orders/" + orderId + "/status");
  assert.equal(calls[4].path, "/orders/" + orderId + "/production-reports?limit=40");
  assert.equal(calls[5].options.idempotencyKey, "report-key");
  assert.equal(calls[6].path, "/orders/" + orderId + "/material-dispositions");
  assert.equal(calls[6].options.idempotencyKey, "disposition-key");
  assert.throws(() => client.get("not-a-uuid"), /UUID/);
});
