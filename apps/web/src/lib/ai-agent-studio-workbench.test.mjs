import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAiStudioBranchPayload,
  buildAiStudioComparePayload,
  buildAiStudioDraftPayload,
  buildAiStudioDraftReviewPayload,
  buildAiStudioEvaluationCasePayload,
  buildAiStudioEvaluationRunPayload,
  buildAiStudioPolicySimulationPayload,
  buildAiStudioPublishRequestPayload,
  buildAiStudioReplayPayload,
  buildAiStudioRollbackPayload,
  buildAiStudioSandboxPayload,
  buildAiStudioTemplateDraftPayload,
  createAiAgentStudioClient,
  normalizeAiStudioRows,
} from "./ai-agent-studio-workbench.mjs";

const sandbox = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const run = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const tool = { tool_id: "INVENTORY.STOCK.SUMMARY", version: "1.0.0", action_type: "INVENTORY.READ" };
const spec = {
  agent_id: "stock-helper",
  version: "1.0.0",
  goal: "Summarize current stock levels",
  risk_ceiling: "L1",
  execution_scopes: ["INVENTORY.READ"],
  tools: [tool],
};
const plan = [{ step_key: "stock", tool_id: tool.tool_id, tool_version: tool.version, action_type: tool.action_type, input: { sku: "SKU-01" } }];

test("normalizes array, named collection and nested API envelopes", () => {
  const rows = [{ id: "1" }];
  assert.deepEqual(normalizeAiStudioRows(rows), rows);
  assert.deepEqual(normalizeAiStudioRows({ items: rows }), rows);
  assert.deepEqual(normalizeAiStudioRows({ cases: rows }, "cases"), rows);
  assert.deepEqual(normalizeAiStudioRows({ data: { rows } }), rows);
  assert.deepEqual(normalizeAiStudioRows(null), []);
});

test("builds a bounded natural-language draft payload", () => {
  assert.deepEqual(buildAiStudioDraftPayload({ prompt: "Build a read-only stock assistant", title: "Stock assistant" }), {
    prompt: "Build a read-only stock assistant", title: "Stock assistant",
  });
  assert.throws(() => buildAiStudioDraftPayload({ prompt: "" }), /prompt/);
  assert.throws(() => buildAiStudioDraftPayload({ prompt: "x".repeat(4001) }), /prompt/);
  assert.throws(() => buildAiStudioDraftPayload({ prompt: "valid", title: "x".repeat(201) }), /title/);
});

test("template drafts omit optional values and enforce customization bounds", () => {
  assert.deepEqual(buildAiStudioTemplateDraftPayload({}), {});
  assert.deepEqual(buildAiStudioTemplateDraftPayload({ title: "Maintenance triage", customization: "Require review for critical work orders." }), {
    title: "Maintenance triage", customization: "Require review for critical work orders.",
  });
  assert.throws(() => buildAiStudioTemplateDraftPayload({ customization: "x".repeat(2001) }), /customization/);
});

test("draft review only accepts explicit APPROVE or REJECT decisions", () => {
  assert.deepEqual(buildAiStudioDraftReviewPayload({ decision: "APPROVE", notes: "Spec is ready for the next governed step." }), {
    decision: "APPROVE", notes: "Spec is ready for the next governed step.",
  });
  assert.throws(() => buildAiStudioDraftReviewPayload({ decision: "PROMOTE" }), /decision/);
  assert.throws(() => buildAiStudioDraftReviewPayload({ decision: "REJECT", notes: "x".repeat(2001) }), /notes/);
});

test("sandbox payload validates the immutable agent spec and plan contract", () => {
  const payload = buildAiStudioSandboxPayload({
    name: "Stock simulation",
    agent_spec: JSON.stringify(spec),
    plan: JSON.stringify(plan),
    simulated_tool_responses: JSON.stringify({ "INVENTORY.STOCK.SUMMARY@1.0.0": { available: 12 } }),
  });
  assert.equal(payload.agent_spec.risk_ceiling, "L1");
  assert.equal(payload.plan[0].tool_id, tool.tool_id);
  assert.equal(payload.simulated_tool_responses["INVENTORY.STOCK.SUMMARY@1.0.0"].available, 12);
  assert.equal("trace_id" in payload, false);
});

test("sandbox requires a JSON object for the agent spec and simulated responses", () => {
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: "[]", plan: JSON.stringify(plan), simulated_tool_responses: "{}" }), /agent_spec/);
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify(plan), simulated_tool_responses: "[]" }), /simulated_tool_responses/);
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: "{", plan: "[]", simulated_tool_responses: "{}" }), /valid JSON/);
});

test("sandbox rejects unsupported risk ceilings and empty declared tools", () => {
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify({ ...spec, risk_ceiling: "L5" }), plan: JSON.stringify(plan), simulated_tool_responses: "{}" }), /risk_ceiling/);
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify({ ...spec, tools: [] }), plan: JSON.stringify(plan), simulated_tool_responses: "{}" }), /tools/);
});

test("sandbox plan step must match a declared tool version and action", () => {
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify([{ ...plan[0], tool_version: "2.0.0" }]), simulated_tool_responses: "{}" }), /not declared/);
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify([{ ...plan[0], action_type: "INVENTORY.WRITE" }]), simulated_tool_responses: "{}" }), /action_type/);
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify([{ ...plan[0], input: [] }]), simulated_tool_responses: "{}" }), /input/);
});

test("sandbox enforces unique step keys and the 100-step bound", () => {
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify([plan[0], plan[0]]), simulated_tool_responses: "{}" }), /unique/);
  const tooMany = Array.from({ length: 101 }, (_, i) => ({ ...plan[0], step_key: "step-" + i }));
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify(tooMany), simulated_tool_responses: "{}" }), /1 to 100/);
});

test("sandbox accepts optional object snapshots but rejects invalid JSON", () => {
  const payload = buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify(plan), simulated_tool_responses: "{}", input_snapshot: "{\"source\":\"fixture\"}" });
  assert.equal(payload.input_snapshot.source, "fixture");
  assert.throws(() => buildAiStudioSandboxPayload({ name: "x", agent_spec: JSON.stringify(spec), plan: JSON.stringify(plan), simulated_tool_responses: "{}", policy_snapshot: "[]" }), /policy_snapshot/);
});

test("policy simulation requires one to one hundred events and complete unique keys", () => {
  const events = [{ event_key: "first", action: "INVENTORY.READ", effective_at: "2026-11-24T00:00:00Z", expected_outcome: "ALLOWED" }];
  assert.equal(buildAiStudioPolicySimulationPayload({ historical_events: JSON.stringify(events) }).historical_events.length, 1);
  assert.throws(() => buildAiStudioPolicySimulationPayload({ historical_events: "[]" }), /1 to 100/);
  assert.throws(() => buildAiStudioPolicySimulationPayload({ historical_events: JSON.stringify([events[0], events[0]]) }), /unique/);
});

test("policy event validates ISO timestamps, outcomes and attributes objects", () => {
  const base = { event_key: "one", action: "A", effective_at: "2026-11-24T00:00:00Z" };
  assert.throws(() => buildAiStudioPolicySimulationPayload({ historical_events: JSON.stringify([{ ...base, effective_at: "yesterday" }]) }), /ISO-8601/);
  assert.throws(() => buildAiStudioPolicySimulationPayload({ historical_events: JSON.stringify([{ ...base, expected_outcome: "ALLOW" }]) }), /expected_outcome/);
  assert.throws(() => buildAiStudioPolicySimulationPayload({ historical_events: JSON.stringify([{ ...base, attributes: [] }]) }), /attributes/);
});

test("policy simulation maps only supported fields and preserves optional expected outcome", () => {
  const payload = buildAiStudioPolicySimulationPayload({ historical_events: JSON.stringify([{
    event_key: "review", action: "WORK_ORDER.COMPLETE", resource_type: "WORK_ORDER",
    attributes: { priority: "HIGH" }, effective_at: "2026-11-24T01:02:03Z", expected_outcome: "APPROVAL_REQUIRED",
  }]) });
  assert.deepEqual(payload.historical_events[0], {
    event_key: "review", action: "WORK_ORDER.COMPLETE", resource_type: "WORK_ORDER",
    attributes: { priority: "HIGH" }, effective_at: "2026-11-24T01:02:03Z", expected_outcome: "APPROVAL_REQUIRED",
  });
});

test("replay payload validates source UUID and inclusive step range", () => {
  assert.deepEqual(buildAiStudioReplayPayload({ source_run_id: run, from_step_index: "1", to_step_index: "3" }), {
    source_run_id: run, from_step_index: 1, to_step_index: 3,
  });
  assert.equal(buildAiStudioReplayPayload({ source_run_id: run }).from_step_index, 0);
  assert.throws(() => buildAiStudioReplayPayload({ source_run_id: "bad" }), /UUID/);
  assert.throws(() => buildAiStudioReplayPayload({ source_run_id: run, from_step_index: 3, to_step_index: 2 }), /between/);
});

test("branch payload requires a valid source and a bounded plan array", () => {
  const payload = buildAiStudioBranchPayload({ source_run_id: run, branch_from_step_index: 0, plan: JSON.stringify(plan), simulated_tool_responses: "{}" });
  assert.equal(payload.plan[0].step_key, "stock");
  assert.throws(() => buildAiStudioBranchPayload({ source_run_id: run, branch_from_step_index: -1, plan: JSON.stringify(plan), simulated_tool_responses: "{}" }), /branch_from_step_index/);
  assert.throws(() => buildAiStudioBranchPayload({ source_run_id: run, branch_from_step_index: 0, plan: "[]", simulated_tool_responses: "{}" }), /1 to 100/);
});

test("branch and run comparison inputs reject malformed UUIDs or objects", () => {
  assert.throws(() => buildAiStudioBranchPayload({ source_run_id: run, branch_from_step_index: 0, plan: JSON.stringify(plan), simulated_tool_responses: "[]" }), /object/);
  assert.deepEqual(buildAiStudioComparePayload({ left_run_id: run, right_run_id: sandbox }), { left_run_id: run, right_run_id: sandbox });
  assert.throws(() => buildAiStudioComparePayload({ left_run_id: run, right_run_id: "none" }), /UUID/);
});

test("evaluation cases require known kinds and positive bounded versions", () => {
  assert.equal(buildAiStudioEvaluationCasePayload({ case_key: "expect-stock", version: 1, name: "Stock summary", kind: "EXPECTED_TOOL_CALL", expected_tool_id: tool.tool_id, expected_tool_version: tool.version }).kind, "EXPECTED_TOOL_CALL");
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 0, name: "X", kind: "EXPECTED_REFUSAL", expected_refusal_reason_contains: "deny" }), /version/);
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "RANDOM" }), /kind/);
});

test("EXPECTED_TOOL_CALL and EXPECTED_REFUSAL enforce their required expectations", () => {
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_TOOL_CALL" }), /requires expected_tool/);
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_REFUSAL" }), /requires a forbidden/);
  assert.equal(buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_REFUSAL", expected_refusal_reason_contains: "policy denial" }).expected_refusal_reason_contains, "policy denial");
});

test("RED_TEAM_POLICY_BYPASS requires a version-pinned prohibited action", () => {
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "RED_TEAM_POLICY_BYPASS", expected_tool_id: "TOOL", expected_tool_version: "1" }), /action type/);
  assert.equal(buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "RED_TEAM_POLICY_BYPASS", expected_tool_id: "TOOL", expected_tool_version: "1", expected_action_type: "WRITE" }).expected_action_type, "WRITE");
});

test("EXPECTED_COMPENSATION requires source and compensator references", () => {
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_COMPENSATION", expected_tool_id: "TOOL", expected_tool_version: "1", expected_action_type: "COMPENSATE" }), /source tool/);
  assert.equal(buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_COMPENSATION", expected_tool_id: "UNDO", expected_tool_version: "2", expected_action_type: "UNDO", source_tool_id: "DO", source_tool_version: "1" }).source_tool_id, "DO");
});

test("evaluation cases reject secret-like fields recursively in expected input subsets", () => {
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_REFUSAL", expected_refusal_reason_contains: "denied", expected_input_subset: "{\"nested\":{\"api_key\":\"should-not-be-here\"}}" }), /secret-like/);
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_COMPENSATION", expected_tool_id: "UNDO", expected_tool_version: "2", expected_action_type: "UNDO", source_tool_id: "DO", source_tool_version: "1", expected_refusal_reason_contains: "secret" }), /does not accept/);
});

test("evaluation status and optional tool version pairs are strict", () => {
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_REFUSAL", expected_refusal_reason_contains: "denied", expected_tool_id: "TOOL" }), /supplied together/);
  assert.throws(() => buildAiStudioEvaluationCasePayload({ case_key: "x", version: 1, name: "X", kind: "EXPECTED_REFUSAL", expected_refusal_reason_contains: "denied", status: "PENDING" }), /status/);
});

test("evaluation execution requires a simulation run ID and cannot select a live task", () => {
  assert.deepEqual(buildAiStudioEvaluationRunPayload({ simulation_run_id: run }), { simulation_run_id: run });
  assert.throws(() => buildAiStudioEvaluationRunPayload({ simulation_run_id: "live-task" }), /UUID/);
});

test("publish requests require catalogue, sandbox and simulation references", () => {
  assert.deepEqual(buildAiStudioPublishRequestPayload({ agent_definition_id: agent, sandbox_id: sandbox, simulation_run_id: run, target_stage: "CANARY" }), {
    agent_definition_id: agent, sandbox_id: sandbox, simulation_run_id: run, target_stage: "CANARY",
  });
  assert.throws(() => buildAiStudioPublishRequestPayload({ agent_definition_id: agent, sandbox_id: sandbox, simulation_run_id: run, target_stage: "PROD" }), /target_stage/);
  assert.throws(() => buildAiStudioPublishRequestPayload({ agent_definition_id: "bad", sandbox_id: sandbox, simulation_run_id: run, target_stage: "CANARY" }), /UUID/);
});

test("production publish references the supplied policy simulation and bounded reason", () => {
  const payload = buildAiStudioPublishRequestPayload({ agent_definition_id: agent, sandbox_id: sandbox, simulation_run_id: run, policy_simulation_run_id: sandbox, target_stage: "PRODUCTION", reason: "Release candidate reviewed." });
  assert.equal(payload.policy_simulation_run_id, sandbox);
  assert.throws(() => buildAiStudioPublishRequestPayload({ agent_definition_id: agent, sandbox_id: sandbox, simulation_run_id: run, target_stage: "CANARY", reason: "x".repeat(2001) }), /reason/);
});

test("rollback reason is optional but bounded", () => {
  assert.deepEqual(buildAiStudioRollbackPayload({}), {});
  assert.deepEqual(buildAiStudioRollbackPayload({ reason: "Revert after failed canary." }), { reason: "Revert after failed canary." });
  assert.throws(() => buildAiStudioRollbackPayload({ reason: "x".repeat(2001) }), /reason/);
});

test("client uses the shared-session request adapter and the exact draft/sandbox paths", async () => {
  const calls = [];
  const client = createAiAgentStudioClient(async (path, options = {}) => { calls.push({ path, options }); return { ok: true }; });
  await client.listTemplates();
  await client.createDraft({ prompt: "Build review" });
  await client.createSandbox({ name: "test" });
  assert.equal(calls[0].path, "/v1/ai/agent-studio/templates");
  assert.deepEqual(calls[1], { path: "/v1/ai/agent-studio/workflow-drafts", options: { method: "POST", body: { prompt: "Build review" } } });
  assert.equal(calls[2].path, "/v1/ai/agent-studio/sandboxes");
});

test("client encodes identifiers and targets run inspection and policy routes", async () => {
  const calls = [];
  const client = createAiAgentStudioClient(async (path, options = {}) => { calls.push({ path, options }); return {}; });
  await client.getRun(sandbox, run);
  await client.inspectStep(sandbox, run, 1);
  await client.simulatePolicies(sandbox, {});
  assert.equal(calls[0].path, "/v1/ai/agent-studio/sandboxes/" + sandbox + "/simulations/" + run);
  assert.ok(calls[1].path.endsWith("/steps/1"));
  assert.ok(calls[2].path.endsWith("/policy-simulations"));
});

test("client delegates evaluation and publish lifecycle without inventing a publish-list endpoint", async () => {
  const calls = [];
  const client = createAiAgentStudioClient(async (path, options = {}) => { calls.push({ path, options }); return {}; });
  await client.listEvaluationCases(agent);
  await client.evaluateCase(agent, sandbox, { simulation_run_id: run });
  await client.requestPublication({ target_stage: "CANARY" });
  await client.approvePublication(run);
  await client.promotePublication(run);
  await client.rollbackDeployment(sandbox, { reason: "Rollback" });
  assert.ok(calls[0].path.endsWith("/evaluation-cases"));
  assert.ok(calls[1].path.endsWith("/" + sandbox + "/evaluate"));
  assert.equal(calls[2].path, "/v1/ai/agent-studio/publish-requests");
  assert.ok(calls[3].path.endsWith("/" + run + "/approve"));
  assert.ok(calls[4].path.endsWith("/" + run + "/promote"));
  assert.ok(calls[5].path.endsWith("/" + sandbox + "/rollback"));
});

test("client refuses to initialize without an authenticated request adapter", () => {
  assert.throws(() => createAiAgentStudioClient(null), /authenticated/);
});
