import assert from "node:assert/strict";
import test from "node:test";
import { createQualityWorkspaceClient } from "./quality-workspace.mjs";

const INSPECTION_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";

test("inspection listing uses validated filters and bounded limits", async () => {
  const calls = [];
  const client = createQualityWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return [];
    },
  });

  await client.listInspections();
  await client.listInspections({
    status: "in_progress",
    inspectionType: "incoming",
    targetType: "goods_receipt_line",
    limit: 25,
  });

  assert.deepEqual(calls, [
    { path: "/quality/inspections?limit=50", options: {} },
    {
      path: "/quality/inspections?limit=25&status=IN_PROGRESS&inspection_type=INCOMING&target_type=GOODS_RECEIPT_LINE",
      options: {},
    },
  ]);
});

test("inspection detail requires a UUID and uses the authenticated session", async () => {
  const calls = [];
  const client = createQualityWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { id: INSPECTION_ID };
    },
  });

  const result = await client.getInspection(INSPECTION_ID.toUpperCase());

  assert.equal(result.id, INSPECTION_ID);
  assert.deepEqual(calls, [
    { path: "/quality/inspections/" + INSPECTION_ID, options: {} },
  ]);
});

test("inspection plans, holds and rework queues use exact API query names", async () => {
  const calls = [];
  const client = createQualityWorkspaceClient({
    request: async (path) => {
      calls.push(path);
      return [];
    },
  });

  await client.listInspectionPlans({ status: "active", inspectionType: "final", limit: 30 });
  await client.listHolds({ status: "released", limit: 20 });
  await client.listReworkOrders({ status: "rework_required", limit: 10 });

  assert.deepEqual(calls, [
    "/quality/plans?limit=30&status=ACTIVE&inspection_type=FINAL",
    "/quality/holds?limit=20&status=RELEASED",
    "/quality/rework-orders?limit=10&status=REWORK_REQUIRED",
  ]);
});

test("unsupported enum filters, malformed IDs and out-of-range limits fail before request", () => {
  let called = false;
  const client = createQualityWorkspaceClient({
    request: async () => {
      called = true;
      return [];
    },
  });

  assert.throws(() => client.listInspections({ status: "SHIPPED" }), /not supported/);
  assert.throws(() => client.listInspections({ inspectionType: "AUDIT" }), /not supported/);
  assert.throws(() => client.listInspections({ targetType: "CUSTOMER" }), /not supported/);
  assert.throws(() => client.listInspectionPlans({ status: "APPROVED" }), /not supported/);
  assert.throws(() => client.listHolds({ status: "PENDING" }), /not supported/);
  assert.throws(() => client.listReworkOrders({ status: "ON_HOLD" }), /not supported/);
  assert.throws(() => client.listInspections({ limit: 0 }), /between 1 and 100/);
  assert.throws(() => client.listHolds({ limit: 101 }), /between 1 and 100/);
  assert.throws(() => client.getInspection("../other-factory"), /valid UUID/);
  assert.equal(called, false);
});

test("quality client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createQualityWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
