import assert from "node:assert/strict";
import test from "node:test";
import { createOrdersWorkspaceClient } from "./orders-workspace.mjs";

const ORDER_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";

test("order list uses the authenticated session with validated pagination", async () => {
  const calls = [];
  const client = createOrdersWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], pagination: { page: 2, limit: 20, total: 0, total_pages: 0 } };
    },
  });

  const result = await client.listOrders({ page: 2, limit: 20 });

  assert.equal(result.pagination.page, 2);
  assert.deepEqual(calls, [{
    path: "/orders?page=2&limit=20",
    options: {},
  }]);
});

test("order list encodes search and applies a supported status filter", async () => {
  const calls = [];
  const client = createOrdersWorkspaceClient({
    request: async (path) => {
      calls.push(path);
      return { items: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } };
    },
  });

  await client.listOrders({
    page: 1,
    limit: 20,
    status: "in_progress",
    search: "Buyer & order 17",
  });

  assert.deepEqual(calls, [
    "/orders?page=1&limit=20&status=IN_PROGRESS&search=Buyer+%26+order+17",
  ]);
});

test("order detail and production reports use encoded UUID paths through the session", async () => {
  const calls = [];
  const client = createOrdersWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return {};
    },
  });

  await client.getOrder(ORDER_ID.toUpperCase());
  await client.listProductionReports(ORDER_ID, { limit: 25 });

  assert.deepEqual(calls, [
    { path: "/orders/" + ORDER_ID, options: {} },
    { path: "/orders/" + ORDER_ID + "/production-reports?limit=25", options: {} },
  ]);
});

test("invalid filters and identifiers fail before a request is made", () => {
  let called = false;
  const client = createOrdersWorkspaceClient({
    request: async () => {
      called = true;
      return {};
    },
  });

  assert.throws(() => client.listOrders({ page: 0 }), /positive integer/);
  assert.throws(() => client.listOrders({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => client.listOrders({ status: "SHIPPED" }), /not supported/);
  assert.throws(() => client.getOrder("../../other-factory"), /valid UUID/);
  assert.throws(() => client.listProductionReports(ORDER_ID, { limit: 101 }), /between 1 and 100/);
  assert.equal(called, false);
});

test("orders client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createOrdersWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
