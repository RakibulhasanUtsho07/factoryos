import assert from "node:assert/strict";
import test from "node:test";
import { createProcurementWorkspaceClient } from "./procurement-workspace.mjs";

const PURCHASE_ORDER_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";
const RECEIPT_ID = "4a6d8f10-2233-4455-8899-aabbccddeeff";

test("purchase-order listing uses backend pagination, status and search query names", async () => {
  const calls = [];
  const client = createProcurementWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], pagination: { page: 2, limit: 25, total: 0, total_pages: 0 } };
    },
  });

  await client.listPurchaseOrders();
  await client.listPurchaseOrders({
    page: 2,
    limit: 25,
    status: "submitted",
    search: " PO-42 ",
  });

  assert.deepEqual(calls, [
    { path: "/purchase-orders?page=1&limit=20", options: {} },
    {
      path: "/purchase-orders?page=2&limit=25&status=SUBMITTED&search=PO-42",
      options: {},
    },
  ]);
});

test("purchase-order and goods-receipt details validate UUIDs and use exact GET paths", async () => {
  const calls = [];
  const client = createProcurementWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { id: path.includes("goods-receipts") ? RECEIPT_ID : PURCHASE_ORDER_ID };
    },
  });

  await client.getPurchaseOrder(PURCHASE_ORDER_ID.toUpperCase());
  await client.getGoodsReceipt(RECEIPT_ID.toUpperCase());

  assert.deepEqual(calls, [
    { path: "/purchase-orders/" + PURCHASE_ORDER_ID, options: {} },
    { path: "/goods-receipts/" + RECEIPT_ID, options: {} },
  ]);
});

test("supplier listing uses tenant-scoped page, status and search filters", async () => {
  const calls = [];
  const client = createProcurementWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } };
    },
  });

  await client.listSuppliers();
  await client.listSuppliers({ page: 3, limit: 50, status: "active", search: "acme" });

  assert.deepEqual(calls, [
    { path: "/suppliers?page=1&limit=20", options: {} },
    { path: "/suppliers?page=3&limit=50&status=ACTIVE&search=acme", options: {} },
  ]);
});

test("goods receipts are listed for a validated purchase order with a bounded limit", async () => {
  const calls = [];
  const client = createProcurementWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { purchase_order_id: PURCHASE_ORDER_ID, receipts: [] };
    },
  });

  await client.listGoodsReceipts(PURCHASE_ORDER_ID.toUpperCase(), { limit: 75 });

  assert.deepEqual(calls, [
    {
      path: "/purchase-orders/" + PURCHASE_ORDER_ID + "/goods-receipts?limit=75",
      options: {},
    },
  ]);
});

test("unsupported statuses, malformed IDs, invalid pagination and oversized search fail before request", () => {
  let called = false;
  const client = createProcurementWorkspaceClient({
    request: async () => {
      called = true;
      return {};
    },
  });

  assert.throws(() => client.listPurchaseOrders({ status: "IN_PROGRESS" }), /not supported/);
  assert.throws(() => client.listSuppliers({ status: "PENDING" }), /not supported/);
  assert.throws(() => client.listPurchaseOrders({ page: 0 }), /positive integer/);
  assert.throws(() => client.listSuppliers({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => client.listPurchaseOrders({ search: "x".repeat(101) }), /at most 100/);
  assert.throws(() => client.getPurchaseOrder("../other-factory"), /valid UUID/);
  assert.throws(() => client.listGoodsReceipts("not-a-uuid"), /valid UUID/);
  assert.throws(() => client.getGoodsReceipt("../other-factory"), /valid UUID/);
  assert.equal(called, false);
});

test("procurement client requires the authenticated session request function", () => {
  assert.throws(
    () => createProcurementWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
