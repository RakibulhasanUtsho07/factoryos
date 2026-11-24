const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RISK = new Set(["L0", "L1", "L2", "L3", "L4"]);
const OUTCOMES = new Set(["ALLOWED", "APPROVAL_REQUIRED", "DENIED"]);
const CASE_KINDS = new Set([
  "EXPECTED_TOOL_CALL",
  "EXPECTED_REFUSAL",
  "RED_TEAM_POLICY_BYPASS",
  "EXPECTED_COMPENSATION",
  "PRIVACY_NO_SECRET_LEAKAGE",
]);
const SECRET_KEY = /(secret|password|token|authorization|credential|api[_-]?key|private[_-]?key)/i;

function asText(value, field, min = 1, max = 200) {
  if (typeof value !== "string") throw new Error(field + " must be text.");
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new Error(field + " must contain " + min + " to " + max + " characters.");
  }
  return result;
}

function uuid(value, field) {
  const result = asText(value, field, 1, 64);
  if (!UUID.test(result)) throw new Error(field + " must be a valid UUID.");
  return result.toLowerCase();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be a JSON object.");
  }
  return value;
}

function parseJson(value, field, expected = "object", optional = false) {
  const raw = typeof value === "string" ? value.trim() : value;
  if ((raw === "" || raw === undefined || raw === null) && optional) return undefined;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(field + " must contain valid JSON.");
    }
  }
  if (expected === "array" && !Array.isArray(parsed)) {
    throw new Error(field + " must be a JSON array.");
  }
  if (expected === "object") object(parsed, field);
  return parsed;
}

function validatePlan(plan, agentSpec) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 100) {
    throw new Error("plan must contain 1 to 100 steps.");
  }
  const declared = new Map((agentSpec.tools ?? []).map((tool) => [
    tool.tool_id + "@" + tool.version,
    tool.action_type,
  ]));
  const seen = new Set();
  return plan.map((raw, index) => {
    const step = object(raw, "plan[" + index + "]");
    const step_key = asText(step.step_key, "plan[" + index + "].step_key", 1, 200);
    if (seen.has(step_key)) throw new Error("Plan step keys must be unique.");
    seen.add(step_key);
    const tool_id = asText(step.tool_id, "plan[" + index + "].tool_id", 1, 200);
    const tool_version = asText(step.tool_version, "plan[" + index + "].tool_version", 1, 100);
    const action_type = asText(step.action_type, "plan[" + index + "].action_type", 1, 200);
    const reference = tool_id + "@" + tool_version;
    if (!declared.has(reference)) throw new Error("Plan references a tool not declared in agent_spec.tools: " + reference);
    if (declared.get(reference) !== action_type) throw new Error("Plan action_type does not match the declared tool: " + reference);
    return {
      step_key,
      tool_id,
      tool_version,
      action_type,
      input: object(step.input, "plan[" + index + "].input"),
    };
  });
}

function validateAgentSpec(value) {
  const spec = object(value, "agent_spec");
  const risk = asText(spec.risk_ceiling, "agent_spec.risk_ceiling", 2, 2);
  if (!RISK.has(risk)) throw new Error("agent_spec.risk_ceiling must be L0 through L4.");
  if (!Array.isArray(spec.execution_scopes) || spec.execution_scopes.length > 100) {
    throw new Error("agent_spec.execution_scopes must be an array of at most 100 scopes.");
  }
  const tools = spec.tools;
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 100) {
    throw new Error("agent_spec.tools must contain 1 to 100 declared tools.");
  }
  const normalizedTools = tools.map((raw, index) => {
    const tool = object(raw, "agent_spec.tools[" + index + "]");
    return {
      tool_id: asText(tool.tool_id, "tool_id", 1, 200),
      version: asText(tool.version, "version", 1, 100),
      action_type: asText(tool.action_type, "action_type", 1, 200),
    };
  });
  return {
    ...spec,
    agent_id: asText(spec.agent_id, "agent_spec.agent_id", 1, 200),
    version: asText(spec.version, "agent_spec.version", 1, 100),
    goal: asText(spec.goal, "agent_spec.goal", 1, 2000),
    risk_ceiling: risk,
    execution_scopes: spec.execution_scopes.map((entry) => asText(entry, "execution scope", 1, 200)),
    tools: normalizedTools,
  };
}

export function normalizeAiStudioRows(value, preferredKey = "items") {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value;
  if (preferredKey && Array.isArray(record[preferredKey])) return record[preferredKey];
  for (const key of ["items", "data", "rows", "agents", "drafts", "templates", "cases"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  if (record.data && typeof record.data === "object") return normalizeAiStudioRows(record.data, preferredKey);
  return [];
}

export function buildAiStudioDraftPayload(input = {}) {
  return {
    prompt: asText(input.prompt, "prompt", 1, 4000),
    ...(input.title?.trim() ? { title: asText(input.title, "title", 1, 200) } : {}),
  };
}

export function buildAiStudioTemplateDraftPayload(input = {}) {
  return {
    ...(input.title?.trim() ? { title: asText(input.title, "title", 1, 200) } : {}),
    ...(input.customization?.trim() ? { customization: asText(input.customization, "customization", 1, 2000) } : {}),
  };
}

export function buildAiStudioDraftReviewPayload(input = {}) {
  if (!["APPROVE", "REJECT"].includes(input.decision)) {
    throw new Error("decision must be APPROVE or REJECT.");
  }
  return {
    decision: input.decision,
    ...(input.notes?.trim() ? { notes: asText(input.notes, "notes", 1, 2000) } : {}),
  };
}

export function buildAiStudioSandboxPayload(input = {}) {
  const agent_spec = validateAgentSpec(parseJson(input.agent_spec, "agent_spec"));
  const plan = validatePlan(parseJson(input.plan, "plan", "array"), agent_spec);
  const simulated_tool_responses = parseJson(input.simulated_tool_responses, "simulated_tool_responses");
  const optionalObject = (value, name) => parseJson(value, name, "object", true);
  return {
    name: asText(input.name, "name", 1, 200),
    agent_spec,
    plan,
    simulated_tool_responses,
    ...(optionalObject(input.input_snapshot, "input_snapshot") ? { input_snapshot: optionalObject(input.input_snapshot, "input_snapshot") } : {}),
    ...(optionalObject(input.policy_snapshot, "policy_snapshot") ? { policy_snapshot: optionalObject(input.policy_snapshot, "policy_snapshot") } : {}),
  };
}

export function buildAiStudioPolicySimulationPayload(input = {}) {
  const events = parseJson(input.historical_events, "historical_events", "array");
  if (events.length < 1 || events.length > 100) throw new Error("historical_events must contain 1 to 100 events.");
  const seen = new Set();
  return {
    historical_events: events.map((raw, index) => {
      const event = object(raw, "historical_events[" + index + "]");
      const event_key = asText(event.event_key, "event_key", 1, 200);
      if (seen.has(event_key)) throw new Error("Historical event keys must be unique.");
      seen.add(event_key);
      const effective_at = asText(event.effective_at, "effective_at", 1, 80);
      if (!Number.isFinite(Date.parse(effective_at)) || !/T/.test(effective_at)) {
        throw new Error("effective_at must be an ISO-8601 timestamp.");
      }
      if (event.expected_outcome !== undefined && !OUTCOMES.has(event.expected_outcome)) {
        throw new Error("expected_outcome must be ALLOWED, APPROVAL_REQUIRED or DENIED.");
      }
      return {
        event_key,
        action: asText(event.action, "action", 1, 200),
        ...(event.resource_type ? { resource_type: asText(event.resource_type, "resource_type", 1, 150) } : {}),
        ...(event.attributes !== undefined ? { attributes: object(event.attributes, "attributes") } : {}),
        effective_at,
        ...(event.expected_outcome ? { expected_outcome: event.expected_outcome } : {}),
      };
    }),
  };
}

export function buildAiStudioReplayPayload(input = {}) {
  const from = input.from_step_index === undefined || input.from_step_index === "" ? 0 : Number(input.from_step_index);
  const to = input.to_step_index === undefined || input.to_step_index === "" ? undefined : Number(input.to_step_index);
  if (!Number.isInteger(from) || from < 0 || from > 99) throw new Error("from_step_index must be an integer from 0 to 99.");
  if (to !== undefined && (!Number.isInteger(to) || to < from || to > 99)) throw new Error("to_step_index must be between from_step_index and 99.");
  return {
    source_run_id: uuid(input.source_run_id, "source_run_id"),
    from_step_index: from,
    ...(to !== undefined ? { to_step_index: to } : {}),
  };
}

export function buildAiStudioBranchPayload(input = {}) {
  const branch_from_step_index = Number(input.branch_from_step_index);
  if (!Number.isInteger(branch_from_step_index) || branch_from_step_index < 0 || branch_from_step_index > 99) {
    throw new Error("branch_from_step_index must be an integer from 0 to 99.");
  }
  const plan = parseJson(input.plan, "plan", "array");
  if (plan.length < 1 || plan.length > 100) throw new Error("Branch plan must contain 1 to 100 steps.");
  const normalizedPlan = plan.map((raw, index) => {
    const step = object(raw, "plan[" + index + "]");
    return {
      step_key: asText(step.step_key, "step_key", 1, 200),
      tool_id: asText(step.tool_id, "tool_id", 1, 200),
      tool_version: asText(step.tool_version, "tool_version", 1, 100),
      action_type: asText(step.action_type, "action_type", 1, 200),
      input: object(step.input, "step.input"),
    };
  });
  const responses = object(parseJson(input.simulated_tool_responses, "simulated_tool_responses"), "simulated_tool_responses");
  return {
    source_run_id: uuid(input.source_run_id, "source_run_id"),
    branch_from_step_index,
    plan: normalizedPlan,
    simulated_tool_responses: responses,
  };
}

export function buildAiStudioComparePayload(input = {}) {
  return {
    left_run_id: uuid(input.left_run_id, "left_run_id"),
    right_run_id: uuid(input.right_run_id, "right_run_id"),
  };
}

function assertNoSecretKeys(value, path = "expected_input_subset") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretKeys(entry, path + "[" + index + "]"));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(path + "." + key + " must not contain secret-like fields.");
    assertNoSecretKeys(child, path + "." + key);
  }
}

export function buildAiStudioEvaluationCasePayload(input = {}) {
  if (!CASE_KINDS.has(input.kind)) throw new Error("Unsupported evaluation case kind.");
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1 || version > 1_000_000) throw new Error("version must be an integer from 1 to 1000000.");
  const expected_tool_id = input.expected_tool_id?.trim() ? asText(input.expected_tool_id, "expected_tool_id", 1, 200) : undefined;
  const expected_tool_version = input.expected_tool_version?.trim() ? asText(input.expected_tool_version, "expected_tool_version", 1, 100) : undefined;
  const source_tool_id = input.source_tool_id?.trim() ? asText(input.source_tool_id, "source_tool_id", 1, 200) : undefined;
  const source_tool_version = input.source_tool_version?.trim() ? asText(input.source_tool_version, "source_tool_version", 1, 100) : undefined;
  const expected_action_type = input.expected_action_type?.trim() ? asText(input.expected_action_type, "expected_action_type", 1, 200) : undefined;
  const refusal = input.expected_refusal_reason_contains?.trim()
    ? asText(input.expected_refusal_reason_contains, "expected_refusal_reason_contains", 1, 300)
    : undefined;
  if ((expected_tool_id === undefined) !== (expected_tool_version === undefined)) throw new Error("expected_tool_id and expected_tool_version must be supplied together.");
  if ((source_tool_id === undefined) !== (source_tool_version === undefined)) throw new Error("source_tool_id and source_tool_version must be supplied together.");
  if (input.kind === "EXPECTED_TOOL_CALL" && expected_tool_id === undefined) throw new Error("EXPECTED_TOOL_CALL requires expected_tool_id and expected_tool_version.");
  if (input.kind === "EXPECTED_REFUSAL" && expected_tool_id === undefined && refusal === undefined) throw new Error("EXPECTED_REFUSAL requires a forbidden tool reference or refusal matcher.");
  if (input.kind === "RED_TEAM_POLICY_BYPASS" && (!expected_tool_id || !expected_action_type)) throw new Error("RED_TEAM_POLICY_BYPASS requires a forbidden tool reference and action type.");
  if (input.kind === "EXPECTED_COMPENSATION" && (!expected_tool_id || !expected_action_type || !source_tool_id)) throw new Error("EXPECTED_COMPENSATION requires compensator and source tool references plus action type.");
  if (input.kind !== "EXPECTED_COMPENSATION" && source_tool_id !== undefined) throw new Error("source_tool_id and source_tool_version are only valid for EXPECTED_COMPENSATION.");
  if (["PRIVACY_NO_SECRET_LEAKAGE", "EXPECTED_COMPENSATION"].includes(input.kind) && refusal !== undefined) throw new Error(input.kind + " does not accept a refusal matcher.");
  const expected_input_subset = parseJson(input.expected_input_subset ?? "{}", "expected_input_subset");
  assertNoSecretKeys(expected_input_subset);
  if (input.status !== undefined && !["ACTIVE", "DISABLED"].includes(input.status)) throw new Error("status must be ACTIVE or DISABLED.");
  return {
    case_key: asText(input.case_key, "case_key", 1, 160),
    version,
    name: asText(input.name, "name", 1, 200),
    kind: input.kind,
    ...(input.description?.trim() ? { description: asText(input.description, "description", 1, 2000) } : {}),
    ...(expected_tool_id ? { expected_tool_id, expected_tool_version } : {}),
    ...(expected_action_type ? { expected_action_type } : {}),
    ...(source_tool_id ? { source_tool_id, source_tool_version } : {}),
    expected_input_subset,
    ...(refusal ? { expected_refusal_reason_contains: refusal } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
}

export function buildAiStudioEvaluationRunPayload(input = {}) {
  return { simulation_run_id: uuid(input.simulation_run_id, "simulation_run_id") };
}

export function buildAiStudioPublishRequestPayload(input = {}) {
  if (!["CANARY", "PRODUCTION"].includes(input.target_stage)) throw new Error("target_stage must be CANARY or PRODUCTION.");
  return {
    agent_definition_id: uuid(input.agent_definition_id, "agent_definition_id"),
    sandbox_id: uuid(input.sandbox_id, "sandbox_id"),
    simulation_run_id: uuid(input.simulation_run_id, "simulation_run_id"),
    ...(input.policy_simulation_run_id?.trim() ? { policy_simulation_run_id: uuid(input.policy_simulation_run_id, "policy_simulation_run_id") } : {}),
    target_stage: input.target_stage,
    ...(input.reason?.trim() ? { reason: asText(input.reason, "reason", 1, 2000) } : {}),
  };
}

export function buildAiStudioRollbackPayload(input = {}) {
  return input.reason?.trim() ? { reason: asText(input.reason, "reason", 1, 2000) } : {};
}

export function createAiAgentStudioClient(request) {
  if (typeof request !== "function") throw new Error("An authenticated FactoryOS request function is required.");
  const id = (value) => encodeURIComponent(String(value));
  const post = (path, body) => request(path, { method: "POST", body });
  const base = "/v1/ai/agent-studio";
  const runPath = (sandboxId, runId) => base + "/sandboxes/" + id(sandboxId) + "/simulations/" + id(runId);
  return Object.freeze({
    listAgents: () => request("/v1/ai/agents/catalogue"),
    listTemplates: () => request(base + "/templates"),
    getTemplate: (key) => request(base + "/templates/" + id(key)),
    createTemplateDraft: (key, body) => post(base + "/templates/" + id(key) + "/drafts", body),
    listDrafts: () => request(base + "/workflow-drafts"),
    getDraft: (draftId) => request(base + "/workflow-drafts/" + id(draftId)),
    createDraft: (body) => post(base + "/workflow-drafts", body),
    reviewDraft: (draftId, body) => post(base + "/workflow-drafts/" + id(draftId) + "/review", body),
    createSandbox: (body) => post(base + "/sandboxes", body),
    getRun: (sandboxId, runId) => request(runPath(sandboxId, runId)),
    inspectStep: (sandboxId, runId, stepIndex) => request(runPath(sandboxId, runId) + "/steps/" + id(stepIndex)),
    replayRun: (sandboxId, body) => post(base + "/sandboxes/" + id(sandboxId) + "/simulations/replay", body),
    branchRun: (sandboxId, body) => post(base + "/sandboxes/" + id(sandboxId) + "/simulations/branch", body),
    compareRuns: (sandboxId, body) => post(base + "/sandboxes/" + id(sandboxId) + "/simulations/compare", body),
    simulatePolicies: (sandboxId, body) => post(base + "/sandboxes/" + id(sandboxId) + "/policy-simulations", body),
    listEvaluationCases: (definitionId) => request("/v1/ai/agents/catalogue/" + id(definitionId) + "/evaluation-cases"),
    createEvaluationCase: (definitionId, body) => post("/v1/ai/agents/catalogue/" + id(definitionId) + "/evaluation-cases", body),
    evaluateCase: (definitionId, caseId, body) => post("/v1/ai/agents/catalogue/" + id(definitionId) + "/evaluation-cases/" + id(caseId) + "/evaluate", body),
    getEvaluationReport: (definitionId) => request("/v1/ai/agents/catalogue/" + id(definitionId) + "/evaluation-report"),
    requestPublication: (body) => post(base + "/publish-requests", body),
    approvePublication: (requestId) => post(base + "/publish-requests/" + id(requestId) + "/approve", {}),
    promotePublication: (requestId) => post(base + "/publish-requests/" + id(requestId) + "/promote", {}),
    rollbackDeployment: (deploymentId, body) => post(base + "/deployments/" + id(deploymentId) + "/rollback", body),
  });
}
