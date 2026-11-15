/**
 * Creates an AI workspace client over the shared authenticated session.
 * The session owns bearer credentials, tenant identity and active factory scope.
 * The backend remains authoritative for every read and material action.
 */
export function createAiAgentControlCenterClient({ request }) {
  if (typeof request !== "function") {
    throw new Error("An authenticated, factory-scoped session request function is required.");
  }

  const encoded = (value) => encodeURIComponent(String(value));

  return Object.freeze({
    listAgents: () => request("/v1/ai/agents/catalogue"),
    listTasks: (limit = 50) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Task list limit must be an integer between 1 and 100.");
      }
      return request("/v1/ai/tasks?limit=" + limit);
    },
    listWorkflowDrafts: () => request("/v1/ai/agent-studio/workflow-drafts"),
    listTemplates: () => request("/v1/ai/agent-studio/templates"),
    getAgent: (id) => request("/v1/ai/agents/catalogue/" + encoded(id)),
    getAgentControl: (id) => request("/v1/ai/agents/catalogue/" + encoded(id) + "/control"),
    getEvaluationReport: (id) => request("/v1/ai/agents/catalogue/" + encoded(id) + "/evaluation-report"),
    getTask: (id) => request("/v1/ai/tasks/" + encoded(id)),
    setAgentControl: (id, body) => request("/v1/ai/agents/catalogue/" + encoded(id) + "/control", {
      method: "POST",
      body,
    }),
    cancelTask: (id) => request("/v1/ai/tasks/" + encoded(id) + "/cancel", { method: "POST" }),
    executeStep: (taskId, stepId) => request(
      "/v1/ai/tasks/" + encoded(taskId) + "/steps/" + encoded(stepId) + "/execute",
      { method: "POST" },
    ),
    resumeTaskStep: (taskId, stepId) => request(
      "/v1/ai/tasks/" + encoded(taskId) + "/steps/" + encoded(stepId) + "/resume",
      { method: "POST" },
    ),
    verifyTask: (id) => request("/v1/ai/tasks/" + encoded(id) + "/verify", { method: "POST" }),
  });
}

export function isTerminalAgentTaskState(state) {
  return ['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(state);
}

export function canExecuteAgentStep(step, now = Date.now()) {
  if (!step || step.status !== 'PENDING') return false;
  if (!step.nextRetryAt) return true;
  const retryAt = Date.parse(step.nextRetryAt);
  return Number.isFinite(retryAt) && retryAt <= now;
}
