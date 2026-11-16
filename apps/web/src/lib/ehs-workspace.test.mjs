import assert from "node:assert/strict";
import test from "node:test";
import { createEhsWorkspaceClient } from "./ehs-workspace.mjs";

const INCIDENT_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";

test("incident listing uses exact status and severity query names", async () => {
  const calls = [];
  const client = createEhsWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [] };
    },
  });

  await client.listIncidents();
  await client.listIncidents({
    status: "action_required",
    severity: "critical",
    limit: 40,
  });

  assert.deepEqual(calls, [
    { path: "/ehs/incidents?limit=100", options: {} },
    {
      path: "/ehs/incidents?limit=40&status=ACTION_REQUIRED&severity=CRITICAL",
      options: {},
    },
  ]);
});

test("permit listing uses the backend risk_level query parameter", async () => {
  const calls = [];
  const client = createEhsWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [] };
    },
  });

  await client.listPermits();
  await client.listPermits({
    status: "pending_approval",
    riskLevel: "high",
    limit: 25,
  });

  assert.deepEqual(calls, [
    { path: "/ehs/permits?limit=100", options: {} },
    {
      path: "/ehs/permits?limit=25&status=PENDING_APPROVAL&risk_level=HIGH",
      options: {},
    },
  ]);
});

test("corrective actions require a UUID and use bounded factory-scoped GET path", async () => {
  const calls = [];
  const client = createEhsWorkspaceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { items: [] };
    },
  });

  await client.listCorrectiveActions(INCIDENT_ID.toUpperCase(), { limit: 75 });

  assert.deepEqual(calls, [
    {
      path: "/ehs/incidents/" + INCIDENT_ID + "/corrective-actions?limit=75",
      options: {},
    },
  ]);
});

test("unsupported enums, malformed IDs and out-of-range limits fail before request", () => {
  let called = false;
  const client = createEhsWorkspaceClient({
    request: async () => {
      called = true;
      return { items: [] };
    },
  });

  assert.throws(() => client.listIncidents({ status: "MITIGATED" }), /not supported/);
  assert.throws(() => client.listIncidents({ severity: "URGENT" }), /not supported/);
  assert.throws(() => client.listPermits({ status: "AWAITING_REVIEW" }), /not supported/);
  assert.throws(() => client.listPermits({ riskLevel: "EXTREME" }), /not supported/);
  assert.throws(() => client.listIncidents({ limit: 0 }), /between 1 and 200/);
  assert.throws(() => client.listPermits({ limit: 201 }), /between 1 and 200/);
  assert.throws(() => client.listCorrectiveActions("../other-factory"), /valid UUID/);
  assert.equal(called, false);
});

test("EHS client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createEhsWorkspaceClient({ request: null }),
    /authenticated.*session/i,
  );
});
