# AI Runtime and Agent Execution Traceability

**Scope:** Backend WP05 (AI Runtime Contract) and WP06 (Tool/agent execution) only.  
**Branch:** `rakibul-hasan`  
**Source baseline:** FactoryOS AI SRS v2.1 FINAL, HLD/LLD v1.0, Engineering Implementation Blueprint v1.0 (all dated 2 October 2026).

This is a scoped engineering traceability record, not a statement that the full SRS or the full backend is complete. Requirements outside the rows below remain unassessed here.

## Source hierarchy

1. **SRS v2.1 FINAL** is authoritative for product behaviour, requirement priority, acceptance expectations, and non-functional obligations.
2. **HLD/LLD v1.0** defines architecture ownership, service boundaries, runtime design, and data/security constraints.
3. **Implementation Blueprint v1.0** turns those contracts into code structure, migrations, CI/test suites, and work-package exit evidence.
4. Code changes must remain traceable to an SRS requirement, HLD capability, approved ADR, defect, security control, or operational necessity. Proposed implementation choices must not be presented as new SRS requirements.

## Requirement and work-package map

| Source requirement / contract | Priority / exit evidence | Repository evidence | Current assessment |
|---|---|---|---|
| SRS §13.1, **FR-AGT-01** — agents are catalogued with purpose, allowed tools, maximum risk, data scopes, language and owner; admins can enable, pause, or restrict agents | P0 | `services/api/src/ai/agents/ai.agent.catalogue.service.ts`; `services/api/src/ai/agents/ai.agent.catalogue.controller.ts`; `services/api/src/ai/agents/ai.agent.runtime.service.ts`; `migrations/029_ai_agent_operational_controls.sql`; `migrations/030_ai_agent_language_owner.sql` | **Partial, improved.** Append-only admin controls support ENABLED/PAUSED/RESTRICTED; restrictions narrow declared scopes and are re-checked before execution/compensation. Agent definitions now capture a normalized BCP 47 language tag and a tenant-member owner, defaulting to the authenticated creator. Existing historical definitions may retain a null owner until explicitly versioned; end-to-end acceptance still remains. |
| SRS §13.1, **FR-AGT-06** — per-agent test cases cover expected tool calls and refusals, with results available per agent in the AI Control Center | P1 | `services/api/src/ai/agents/ai.agent.evaluation.service.ts`; `services/api/src/ai/agents/ai.agent.evaluation.controller.ts`; `services/api/src/ai/agents/dto/create-ai-agent-evaluation-case.dto.ts`; `migrations/031_ai_agent_evaluation_cases.sql`; evaluation service/controller specs | **Backend foundation implemented; acceptance partial.** Versioned per-agent EXPECTED_TOOL_CALL and EXPECTED_REFUSAL cases and aggregate reports exist. Expected-call PASS now requires an indexed simulation observation explicitly marked simulated/non-live, a supplied response flag, and a matching response entry; summaries disclose synthetic evidence provenance. A mock tool response is not treated as proof that the agent refused. This still evaluates caller-provided sandbox plans/results rather than executing the agent planner/policy, and it is not proof of frontend AI Control Center integration. |
| HLD/LLD §11.1 — agent state machine: CREATED → CONTEXT_READY → PLAN_READY → AWAITING_AUTH/APPROVAL → EXECUTING → VERIFYING → COMPLETED, with BLOCKED / FAILED / CANCELLED terminal paths | Architecture contract | `services/api/src/ai/agents/ai.agent.runtime.service.ts`; `services/api/src/ai/agents/ai.agent.runtime.service.spec.ts` | **Implemented in the runtime paths touched here; not a full state-machine acceptance sign-off.** State-transition coverage must continue to be reviewed against all reachable transitions. |
| HLD/LLD §11.2 — registered immutable tool version, strict input/output schema, risk class, required scopes, approval mode, bounded timeout, execution audit, rollback and idempotency for write tools | Architecture contract | `services/api/src/ai/tools/ai.tool.registry.service.ts`; `services/api/src/ai/tools/ai.tool.gateway.service.ts`; `migrations/018_ai_tool_registry.sql`; gateway/registry specs | **Implemented for the registry/gateway contract currently in code.** Production domain executors remain separately scoped and must fail closed when not registered. |
| Blueprint §14.3 — tool execution path: resolve registered/entitled tool → validate contract → re-check permissions → risk/approval policy → scoped token → idempotent execution → verify result → persist audit/decision linkage → eventual outcome capture | Engineering implementation contract | `services/api/src/ai/ai.runtime.service.ts`; `services/api/src/ai/agents/ai.agent.runtime.service.ts`; `services/api/src/ai/tools/ai.tool.gateway.service.ts`; `migrations/032_ai_agent_execution_evidence.sql` | **Governed execution includes pre-execution action-intent binding checks and post-execution validation of the durable record's decision, action intent, execution key, executor type, tool version, status and input hash. A mismatch fails the task rather than publishing a falsely correlated success. Versioned, token-free evidence is persisted on the agent step and emitted to audit; production domain execution and downstream outcome capture remain scoped to their own work packages.** |
| Blueprint WP05 — AI Gateway/runtime, context/policy integration, verification, decision ledger; exit evidence: canonical flow acceptance | WP05 | `services/api/src/ai/ai.runtime.service.ts`; `services/api/src/ai/ai.runtime.service.wave2.spec.ts`; `services/api/src/ai/ai.runtime.execution-claim-recovery.spec.ts`; `services/api/src/ai/agents/ai.agent.studio.policy.simulation.service.ts` | **Core runtime controls present; canonical-flow acceptance must be assessed across all runtime stages, not inferred from a single green suite.** Historical policy simulation now records actual PolicyService outcomes, rejects duplicate event keys, and binds each normalized input, plan step, PolicyService observation and case result using a SHA-256 input fingerprint. It will not mark results ready for review unless each event has an expected outcome baseline. This remains policy-simulation evidence, not proof that an LLM planner created the events. |
| Blueprint WP06 — tool registry, tokens, workflow and initial agents; exit evidence: approval + rollback + loop-bound tests | WP06 | `services/api/src/ai/tools/`; `services/api/src/ai/agents/ai.agent.runtime.service.ts`; `services/api/src/ai/agents/ai.agent.runtime.service.spec.ts` | **In progress.** The touched paths cover approval re-checks, compensation contract refusal and binding, token-free execution evidence, tool-call budget limits, durable claims, and fail-closed execution. Continue expanding concurrent/recovery and end-to-end rollback acceptance. |
| HLD/LLD §21 (caching, concurrency and idempotency) and Blueprint security/reliability controls — no unsafe automatic replay when a previous side effect may have occurred | Architecture/security control | `migrations/027_ai_execution_idempotency_claims.sql`; `migrations/028_ai_execution_claim_reconciliation.sql`; `services/api/src/ai/ai.runtime.service.ts`; `services/api/src/ai/ai.runtime.execution-claim-recovery.spec.ts` | **Durable claim and operator-led reconciliation path exist.** Reconciliation remains manual; a stale claim is not proof of failure and must not trigger automatic replay. |

## Recent defect and remediation

A compensation retry originally used a fresh random idempotency key for each authorization request while the durable execution key was derived from the attempt number. That could create multiple action intents for one logical recovery attempt.

The runtime computes the compensation attempt number first and uses the same stable key for authorization and durable execution:

`agent:<taskId>:<stepId>:compensation:<attemptNumber>`

Before the gateway call, it now verifies the authorized action's tenant/factory/decision, rollback tool and version, action type, target, resource binding, payload, and payload hash against the registered compensation contract. It also validates the resulting durable execution record against the same action intent, decision, execution key and input hash. A token-free, schema-versioned compensation evidence envelope links the rollback attempt to its source execution and is included in the audit event and response. Regression tests assert this linkage and prove that mismatched authorization or execution records fail closed; this does not replace durable claim locks or manual reconciliation safeguards.

## Execution evidence and fail-closed correlation

Agent task steps now expose a nullable, schema-versioned `executionEvidence` field backed by `agent_task_steps.execution_evidence`. When a durable execution returns, the runtime verifies its decision ID, action-intent ID, execution key, executor type, tool version, status and input hash against the authorization/step binding before treating the outcome as valid. The evidence records the task, step, decision, parent trace, action intent, execution record, execution key, tool/version, input hash, final status and a SHA-256 digest over the outcome status/result/error. Raw results remain in the existing `output` field; action tokens and payload contents are not copied into the evidence or its audit event.

If the returned record is inconsistent, the agent step does not become successful. Because the runtime call may already have crossed the execution boundary, the failure path does not automatically replay the side effect; operators must use the existing execution-claim reconciliation flow. Step evidence describes the most recently completed durable execution attempt; `agent_action_attempts` continues to hold the per-attempt execution-record references.

## Verification policy

Before this scope is accepted for merge/release:

- API lint and build must pass.
- The complete API unit suite must pass, including agent, registry, gateway, and execution-claim recovery tests.
- PostgreSQL integration tests must pass for the exact candidate commit.
- Tenant/factory negative tests, approval/refusal cases, write-tool idempotency, compensation/rollback, and loop-bound behavior must have explicit evidence.
- Production domain writes must use registered executors, authoritative domain transactions, audit linkage and canonical event/outbox behaviour as required by the relevant domain work package.
- The release/readiness checklist and this traceability record must be updated when evidence changes.

## Current limitations

- This document tracks only the AI runtime and agent/tool-execution slice. It is **not** a completion percentage for all FactoryOS backend requirements.
- FR-AGT-01 remains partial: operational enable/pause/restrict controls and runtime scope enforcement are now implemented in this slice, but language/owner metadata and full acceptance evidence remain outstanding.
- FR-AGT-06 remains partial: case authoring and backend reporting exist, but the sandbox path still evaluates caller-provided plans and simulated responses rather than demonstrating the actual agent planner/policy's decisions; frontend Control Center acceptance is also not demonstrated.
- No claim is made here that WP05/WP06 are fully accepted. The Blueprint's exit criteria are stricter than “the code compiles.”
- The latest GitHub Actions result for the exact candidate commit must be checked on the branch before merging.
