import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiDecisionReplayClient,
  isAiTraceId,
} from "./ai-decision-replay.mjs";

const TRACE_ID = "2f4c0a2a-3b4d-4f66-8b7a-9c0d1e2f3a4b";

test("AI replay client delegates the scoped trace lookup to the authenticated session", async () => {
  const calls = [];
  const client = createAiDecisionReplayClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { replayHash: "sha256:fixture", replay: { traceId: TRACE_ID } };
    },
  });

  const result = await client.replay(TRACE_ID.toUpperCase());

  assert.deepEqual(result, { replayHash: "sha256:fixture", replay: { traceId: TRACE_ID } });
  assert.deepEqual(calls, [{
    path: "/v2/ai/replay/" + TRACE_ID,
    options: {},
  }]);
});

test("AI replay client rejects malformed trace IDs before making a request", () => {
  let called = false;
  const client = createAiDecisionReplayClient({
    request: async () => {
      called = true;
      return {};
    },
  });

  assert.throws(() => client.replay("../../other-tenant"), /valid UUID/i);
  assert.equal(called, false);
});

test("trace ID validation accepts RFC 4122 UUIDs and rejects empty input", () => {
  assert.equal(isAiTraceId(TRACE_ID), true);
  assert.equal(isAiTraceId("  " + TRACE_ID + "  "), true);
  assert.equal(isAiTraceId(""), false);
  assert.equal(isAiTraceId(null), false);
});

test("AI replay client requires the shared authenticated request function", () => {
  assert.throws(
    () => createAiDecisionReplayClient({ request: null }),
    /authenticated.*session/i,
  );
});
