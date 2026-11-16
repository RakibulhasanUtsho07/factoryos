import assert from "node:assert/strict";
import test from "node:test";

import {
  createCbbGovernanceClient,
  cbbConflictStatuses,
  cbbEvidenceStates,
  cbbTargetTypes,
} from "./cbb-governance-workbench.mjs";

const VERSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROCESS_ID = "123e4567-e89b-42d3-a456-426614174001";
const TARGET_ID = "123e4567-e89b-42d3-a456-426614174002";

function createClient() {
  const calls = [];
  const client = createCbbGovernanceClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { accepted: true };
    },
  });
  return { client, calls };
}

test("business model, business map, current processes and versions use exact read routes", async () => {
  const { client, calls } = createClient();
  await client.getBusinessModel();
  await client.getBusinessMap();
  await client.listProcesses();
  await client.listVersions();

  assert.deepEqual(calls, [
    { path: "/v1/business-model", options: {} },
    { path: "/v1/business-model/map", options: {} },
    { path: "/v1/business-model/processes", options: {} },
    { path: "/v1/business-model/versions", options: {} },
  ]);
});

test("historical map and process detail validate UUIDs before requesting", async () => {
  const { client, calls } = createClient();
  await client.getVersionMap({ versionId: VERSION_ID.toUpperCase() });
  await client.getProcess({ processId: PROCESS_ID });

  assert.deepEqual(calls, [
    { path: "/v1/business-model/versions/" + VERSION_ID + "/map", options: {} },
    { path: "/v1/business-model/processes/" + PROCESS_ID, options: {} },
  ]);
});

test("internal evidence query uses backend filters and bounded pagination", async () => {
  const { client, calls } = createClient();
  await client.listEvidence({
    state: "verified",
    targetType: "entity",
    targetId: TARGET_ID,
    limit: 75,
    offset: 150,
  });

  assert.equal(
    calls[0].path,
    "/v1/business-model/evidence?state=VERIFIED&target_type=ENTITY&target_id="
      + TARGET_ID + "&limit=75&offset=150",
  );
  assert.deepEqual(calls[0].options, {});
  assert.deepEqual(cbbEvidenceStates, ["VERIFIED", "INFERRED", "PROPOSED", "CONFLICTING", "STALE"]);
});

test("evidence target type and target ID must be supplied as a pair", async () => {
  const { client, calls } = createClient();

  await assert.rejects(
    client.listEvidence({ targetType: "ENTITY" }),
    /must be supplied together/i,
  );
  await assert.rejects(
    client.listEvidence({ targetId: TARGET_ID }),
    /must be supplied together/i,
  );
  assert.equal(calls.length, 0);
});

test("evidence rejects invalid states, target types and pagination before requesting", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listEvidence({ state: "UNKNOWN" }), /Evidence state/i);
  await assert.rejects(client.listEvidence({ targetType: "CUSTOMER" }), /target type/i);
  await assert.rejects(client.listEvidence({ limit: 201 }), /between 1 and 200/i);
  await assert.rejects(client.listEvidence({ offset: 100001 }), /between 0 and 100000/i);
  assert.equal(calls.length, 0);
});

test("conflict query supports only backend status and subject filters", async () => {
  const { client, calls } = createClient();
  await client.listConflicts({
    status: "open",
    subjectType: "process_step",
    limit: 20,
    offset: 40,
  });

  assert.deepEqual(calls, [{
    path: "/v1/business-model/conflicts?status=OPEN&subject_type=PROCESS_STEP&limit=20&offset=40",
    options: {},
  }]);
  assert.deepEqual(cbbConflictStatuses, ["OPEN", "RESOLVED", "DISMISSED"]);
  assert.ok(cbbTargetTypes.includes("PROCESS_STEP"));
});

test("conflict query rejects unsupported statuses and pagination", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.listConflicts({ status: "PENDING" }), /Conflict status/i);
  await assert.rejects(client.listConflicts({ limit: 0 }), /between 1 and 200/i);
  await assert.rejects(client.listConflicts({ offset: -1 }), /between 0 and 100000/i);
  assert.equal(calls.length, 0);
});

test("staleness and terminology use read-only endpoints with bounded search", async () => {
  const { client, calls } = createClient();
  await client.listStaleness();
  await client.listTerminology({ search: "purchase order" });

  assert.deepEqual(calls, [
    { path: "/v1/business-model/staleness", options: {} },
    { path: "/v1/business-model/terminology?search=purchase%20order", options: {} },
  ]);
  await assert.rejects(client.listTerminology({ search: "x".repeat(301) }), /300 characters/i);
  assert.equal(calls.length, 2);
});

test("governance client requires the shared authenticated session request", () => {
  assert.throws(
    () => createCbbGovernanceClient({ request: null }),
    /authenticated.*session/i,
  );
});
