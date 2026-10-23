# Trusted AI Agent Planner Attestation Contract

**Status:** Implemented server-side verification contract; deployment of a trusted planner/provider remains an environment release gate.

## Purpose

Caller-supplied `plan_version`, `context_version`, and `context_hash` are not proof that a trusted planner produced a plan. A task containing any registered write-capable tool must include a short-lived Ed25519-signed attestation. FactoryOS verifies it at task creation, persists the exact envelope and normalized plan hash as immutable evidence, and verifies it again immediately before each write-capable execution.

The API deliberately fails closed if no trusted key is configured, the signature is invalid, a binding differs, the attestation expires, or a receipt has already been consumed.

## Deployment trust configuration

Configure these API environment variables through the deployment's secret/configuration system:

- `AI_AGENT_PLANNER_PUBLIC_KEY`: trusted provider's Ed25519 public key in PEM/SPKI format.
- `AI_AGENT_PLANNER_KEY_ID`: exact key identifier expected in the signed payload.

Only the public key belongs in the API environment. Keep the private signing key in the trusted planner/provider's secret-management system. Do not place it in the source repository, task body, execution result, or audit payload. Rotating/removing the trusted key causes new write executions to fail closed until the corresponding trust configuration is restored.

## Request envelope

Pass the envelope as `planner_attestation` in the governed task creation request:

```json
{
  "payload": {
    "schema_version": "factoryos.ai-agent-planner-attestation/v1",
    "attestation_id": "12345678-1234-4234-8234-123456789abc",
    "key_id": "planner-ed25519-2026-01",
    "provider_id": "factoryos-planner-provider",
    "provider_version": "1.4.2",
    "planner_version": "planner-v4",
    "context_version": "context-snapshot-v2",
    "context_hash": "<64 lowercase hex chars>",
    "plan_hash": "<64 lowercase hex chars>",
    "goal_hash": "<64 lowercase hex chars>",
    "tenant_id": "<tenant UUID>",
    "factory_id": "<factory UUID>",
    "decision_id": "<decision UUID>",
    "parent_trace_id": "<trace UUID>",
    "agent_definition_id": "<immutable agent definition UUID>",
    "issued_at": "2026-10-23T03:00:00.000Z",
    "expires_at": "2026-10-23T03:05:00.000Z"
  },
  "signature": "<Ed25519 signature, base64url without padding>"
}
```

Use a fresh UUID in `attestation_id` for each newly generated plan receipt. PostgreSQL enforces single-use receipt IDs. Retrying the same task with the same request/idempotency fingerprint replays the existing task; a different task cannot consume that attestation a second time.

## Canonicalization and hashes

Canonical JSON is produced recursively: object keys are sorted lexicographically at every object level, array order is preserved, and the canonical value is encoded with UTF-8 `JSON.stringify` semantics. Do not normalize, reorder, add, or omit signed payload fields after signing.

- `goal_hash`: SHA-256 of the exact normalized task goal UTF-8 string.
- `context_hash`: SHA-256 of the provider's immutable, versioned context snapshot in the provider's agreed canonical representation. The exact lower-case hash and `context_version` must also be sent in the task request.
- `plan_hash`: SHA-256 of the canonical JSON array representing the exact step contract that FactoryOS will persist. Normalize each step using this field set, in this order before canonical JSON sorting:

```json
[
  {
    "stepKey": "trimmed step key",
    "stepIndex": 0,
    "agentId": "AGENT.EXAMPLE",
    "capability": "trimmed capability",
    "inputSchema": {},
    "outputSchema": {},
    "toolId": "TOOL.ID",
    "toolVersion": "1.0.0",
    "actionType": "TOOL.ID",
    "target": {},
    "payload": {},
    "resourceType": null,
    "resourceId": null,
    "riskClass": null,
    "timeoutMs": 1000,
    "retryLimit": 0,
    "authorityLevel": "TASK_SCOPED",
    "dependsOn": []
  }
]
```

This example illustrates defaults, not a recommended business plan. The provider must hash the actual planned values. Step indexes are zero-based and match the order of steps in the API request. FactoryOS normalizes text fields with trimming; uses `null` for absent `agentId`, resource, and risk values; uses empty objects for absent schemas/target/payload; defaults timeout to 1000 ms, retry limit to 0, authority to `TASK_SCOPED`, and dependencies to an empty array.

## Signed bindings and validity

The signature covers the canonical JSON of the entire `payload` object, including every field above. FactoryOS verifies that the trusted key ID matches configuration and the signed fields exactly match the submitted task scope and contract:

- tenant, factory, decision, parent trace and immutable agent definition ID;
- task goal hash, context version/hash and planner version;
- normalized plan hash.

The payload's `planner_version` must equal the task request's `plan_version`. The payload must use the supported `schema_version`. `issued_at` may be at most 30 seconds in the future; `expires_at` must still be in the future; the issuance-to-expiry interval cannot exceed 15 minutes. Hashes must be 64 lowercase hexadecimal characters and the detached Ed25519 signature must be base64url without padding.

## Fail-closed behavior and evidence

- Missing trust configuration or an invalid signature/binding prevents a write-capable task from being created.
- Immediately before a write-capable executor crosses the side-effect boundary, FactoryOS re-reads and verifies the immutable stored envelope, verifies the task bindings and expiry, and checks the persisted plan hash.
- The envelope, plan hash, and verification timestamp cannot be updated after task creation. A unique PostgreSQL index prevents one attestation UUID from being used by two tasks.
- Live evaluation returns `INCONCLUSIVE`, not `PASS`, when trusted planner attestation is missing or invalid. Evaluation evidence includes the trusted provider/version and a digest of the signed envelope, never the private key or raw signing secret.
- This signature verifies the plan's origin and integrity; it does not make an unsafe plan safe. Policy authorization, scoped entitlement, approval, registered executor contracts, idempotency, deadline/cancellation, outcome reconciliation, approved compensation, privacy/red-team testing and canary/rollback acceptance remain required.

**Provider integration status:** this document defines the verifier contract implemented in FactoryOS. It does not assert that a specific hosted LLM/provider is deployed or that production keys are configured. Attach provider activation and per-side-effecting-executor canary/rollback receipts before declaring full production acceptance.
