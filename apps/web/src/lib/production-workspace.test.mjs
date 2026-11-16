import assert from "node:assert/strict";
import test from "node:test";
import { createProductionWorkspaceClient } from "./production-workspace.mjs";

const WORK_ORDER_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";

test("work-order listing uses exact status and bounded limit query parameters", async () => {
  const calls = [];
  const client = createProductionWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return [];
    },
  });

  await client.listWorkOrders();
  await client.listWorkOrders({ status: "in_progress", limit: 40 });

  assert.deepEqual(calls, [
    { path: "/production/work-orders?limit=100", options: {} },
    { path: "/production/work-orders?limit=40&status=IN_PROGRESS", options: {} },
  ]);
});

test("work-order detail requires a UUID and delegates to the shared session", async () => {
  const calls = [];
  const client = createProductionWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { id: WORK_ORDER_ID, operations: [], materials: [] };
    },
  });

  const result = await client.getWorkOrder(WORK_ORDER_ID.toUpperCase());

  assert.equal(result.id, WORK_ORDER_ID);
  assert.deepEqual(calls, [
    { path: "/production/work-orders/" + WORK_ORDER_ID, options: {} },
  ]);
});

test("material shortage radar uses the server-owned bounded endpoint", async () => {
  const calls = [];
  const client = createProductionWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], work_order_count: 0, requirement_count: 0 };
    },
  });

  await client.getMaterialShortageRadar({ limit: 75 });

  assert.deepEqual(calls, [
    {
      path: "/production/work-orders/material-shortage-radar?limit=75",
      options: {},
    },
  ]);
});

test("unsupported lifecycle states, malformed IDs and invalid limits fail before request", () => {
  let called = false;
  const client = createProductionWorkspaceClient({
    request: async () => {
      called = true;
      return [];
    },
  });

  assert.throws(() => client.listWorkOrders({ status: "READY" }), /not supported/);
  assert.throws(() => client.listWorkOrders({ status: "ARCHIVED" }), /not supported/);
  assert.throws(() => client.listWorkOrders({ limit: 0 }), /between 1 and 100/);
  assert.throws(() => client.listWorkOrders({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => client.getMaterialShortageRadar({ limit: -1 }), /between 1 and 100/);
  assert.throws(() => client.getWorkOrder("../other-factory"), /valid UUID/);
  assert.equal(called, false);
});

test("production client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createProductionWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
