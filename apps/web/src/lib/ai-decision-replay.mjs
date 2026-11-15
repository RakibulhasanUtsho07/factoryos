const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAiTraceId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/**
 * Read-only adapter for the authenticated, factory-scoped session client.
 * The API authorizes ai.replay.read and never re-executes the original action.
 */
export function createAiDecisionReplayClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  return Object.freeze({
    replay(traceId) {
      if (!isAiTraceId(traceId)) {
        throw new Error("Trace ID must be a valid UUID.");
      }

      return request("/v2/ai/replay/" + encodeURIComponent(traceId.trim().toLowerCase()));
    },
  });
}
