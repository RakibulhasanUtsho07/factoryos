import assert from "node:assert/strict";
import test from "node:test";
import { createWorkforceWorkspaceClient } from "./workforce-workspace.mjs";

const SHIFT_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";

test("worker and shift lists use bounded limits through the authenticated session", async () => {
  const calls = [];
  const client = createWorkforceWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], limit: 100 };
    },
  });

  await client.listWorkers({ limit: 100 });
  await client.listShifts();

  assert.deepEqual(calls, [
    { path: "/workforce/workers?limit=100", options: {} },
    { path: "/workforce/shifts?limit=200", options: {} },
  ]);
});

test("staffing coverage encodes the selected shift date and optional template", async () => {
  const calls = [];
  const client = createWorkforceWorkspaceClient({
    request: async (path) => {
      calls.push(path);
      return { planned_assignments: 4, uncovered_count: 1 };
    },
  });

  await client.staffingCoverage({ shiftDate: "2026-11-15" });
  await client.staffingCoverage({
    shiftDate: "2026-11-15",
    shiftTemplateId: SHIFT_ID.toUpperCase(),
  });

  assert.deepEqual(calls, [
    "/workforce/staffing/coverage?shift_date=2026-11-15",
    "/workforce/staffing/coverage?shift_date=2026-11-15&shift_template_id=" + SHIFT_ID,
  ]);
});

test("attendance query requests a bounded event history for the selected shift date", async () => {
  const calls = [];
  const client = createWorkforceWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [], shifts: [], attendance_summary: {} };
    },
  });

  await client.listAttendance({
    shiftDate: "2026-11-15",
    shiftTemplateId: SHIFT_ID,
    limit: 125,
  });

  assert.deepEqual(calls, [
    {
      path: "/workforce/attendance?shift_date=2026-11-15&shift_template_id=" + SHIFT_ID + "&limit=125",
      options: {},
    },
  ]);
});

test("invalid limits, calendar dates and shift IDs fail before making a request", () => {
  let called = false;
  const client = createWorkforceWorkspaceClient({
    request: async () => {
      called = true;
      return {};
    },
  });

  assert.throws(() => client.listWorkers({ limit: 0 }), /between 1 and 200/);
  assert.throws(() => client.listShifts({ limit: 201 }), /between 1 and 200/);
  assert.throws(() => client.staffingCoverage({ shiftDate: "2026-02-29" }), /real calendar date/);
  assert.throws(() => client.listAttendance({ shiftDate: "15-11-2026" }), /YYYY-MM-DD/);
  assert.throws(
    () => client.staffingCoverage({ shiftDate: "2026-11-15", shiftTemplateId: "../other-factory" }),
    /valid UUID/,
  );
  assert.equal(called, false);
});

test("workforce client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createWorkforceWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
