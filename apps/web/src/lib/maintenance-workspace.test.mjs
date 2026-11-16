import assert from "node:assert/strict";
import test from "node:test";
import { createMaintenanceWorkspaceClient } from "./maintenance-workspace.mjs";

const ASSET_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";
const WORK_ORDER_ID = "6a1d3c5e-7f90-4a12-8b34-5c6d7e8f9012";

test("maintenance lists use bounded API filters through the authenticated session", async () => {
  const calls = [];
  const client = createMaintenanceWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { count: 0 };
    },
  });

  await client.listAssets();
  await client.listPmPlans({ limit: 25 });
  await client.listWorkOrders({ limit: 10 });

  assert.deepEqual(calls, [
    { path: "/maintenance/assets?limit=50", options: {} },
    { path: "/maintenance/pm-plans?limit=25", options: {} },
    { path: "/maintenance/work-orders?limit=10", options: {} },
  ]);
});

test("asset, preventive-plan and work-order filters are normalized and encoded", async () => {
  const calls = [];
  const client = createMaintenanceWorkspaceClient({
    request: async (path) => {
      calls.push(path);
      return {};
    },
  });

  await client.listAssets({ status: "active" });
  await client.listPmPlans({ status: "paused", assetId: ASSET_ID.toUpperCase() });
  await client.listWorkOrders({
    status: "in_progress",
    type: "breakdown",
    priority: "urgent",
    assetId: ASSET_ID,
  });

  assert.deepEqual(calls, [
    "/maintenance/assets?limit=50&status=ACTIVE",
    "/maintenance/pm-plans?limit=50&status=PAUSED&asset_id=" + ASSET_ID,
    "/maintenance/work-orders?limit=50&status=IN_PROGRESS&work_order_type=BREAKDOWN&priority=URGENT&asset_id=" + ASSET_ID,
  ]);
});

test("work-order detail validates UUID and uses the session request function", async () => {
  const calls = [];
  const client = createMaintenanceWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { work_order: { id: WORK_ORDER_ID } };
    },
  });

  const result = await client.getWorkOrder(WORK_ORDER_ID.toUpperCase());

  assert.equal(result.work_order.id, WORK_ORDER_ID);
  assert.deepEqual(calls, [
    { path: "/maintenance/work-orders/" + WORK_ORDER_ID, options: {} },
  ]);
});

test("unsupported filters, out-of-range limits and malformed IDs fail before a request", () => {
  let called = false;
  const client = createMaintenanceWorkspaceClient({
    request: async () => {
      called = true;
      return {};
    },
  });

  assert.throws(() => client.listAssets({ status: "BROKEN" }), /not supported/);
  assert.throws(() => client.listPmPlans({ status: "APPROVED" }), /not supported/);
  assert.throws(() => client.listWorkOrders({ status: "SHIPPED" }), /not supported/);
  assert.throws(() => client.listWorkOrders({ type: "OTHER" }), /not supported/);
  assert.throws(() => client.listWorkOrders({ priority: "BLOCKER" }), /not supported/);
  assert.throws(() => client.listAssets({ limit: 0 }), /between 1 and 100/);
  assert.throws(() => client.listWorkOrders({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => client.listPmPlans({ assetId: "../../other-factory" }), /valid UUID/);
  assert.throws(() => client.getWorkOrder("../other-factory"), /valid UUID/);
  assert.equal(called, false);
});

test("maintenance client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createMaintenanceWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
