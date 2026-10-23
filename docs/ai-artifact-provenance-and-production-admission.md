# AI artifact provenance and production admission

## SRS scope

This implementation slice targets SRS v2.1 **FR-MSO-03** (artifact provenance, signature/integrity verification and approved sources) and **FR-MSO-05** (fail-closed blocking of unregistered/expired artifacts at production admission). It also records the version and checksum fields needed to bind artefacts to immutable identities. It is not a claim that all model-management requirements are complete.

## Source and signing contract

- Each tenant registers an Ed25519 public key as **PENDING**. Registration alone does not trust the key.
- A different user with the existing ai.agents.publish permission must approve the source. The API refuses self-approval, expired keys, private-key PEMs and non-Ed25519 keys.
- The artifact signer signs the exact UTF-8 envelope built by the canonicalizeAiArtifactEnvelope function in services/api/src/ai/artifacts/ai.artifact.provenance.service.ts. The envelope includes the version string factoryos-ai-artifact-envelope-v1, tenant UUID, artifact type/key/version, lower-case SHA-256, source UUID and canonical UTC expiry timestamp, each separated by one LF byte with no trailing newline.
- Signatures use Ed25519 (Node crypto.sign with a null digest algorithm and the UTF-8 envelope) and standard base64. Private keys remain in the build/signing system; the API stores only public keys and signatures.
- An artifact version is immutable. Replaying an identical signed registration is idempotent; changing its digest, source, expiry or signature under the same tenant/type/key/version returns a conflict. New bytes require a new version.
- Revoking an artifact or its source causes subsequent admission checks to deny the artifact. Expiry is evaluated against server time on every production Tool Gateway admission; there is no positive-decision cache.

## API workflow

All endpoints require factory scope and ai.agents.publish:

1. POST /api/v2/ai/artifacts/sources creates a pending source with source_key, label, public_key_pem and valid_until.
2. POST /api/v2/ai/artifacts/sources/:sourceId/approve independently approves it with a reason.
3. POST /api/v2/ai/artifacts registers an artifact using artifact_type (MODEL, TOOL, PROMPT or POLICY), artifact_key, version, sha256, source_id, expires_at and signature_base64. Registration verifies the signature before persistence.
4. POST /api/v2/ai/artifacts/:artifactId/revoke and POST /api/v2/ai/artifacts/sources/:sourceId/revoke revoke a registry identity or its entire signing authority with a mandatory reason.

The source, artifact and lifecycle records are tenant-scoped and protected by forced PostgreSQL RLS. Their immutable identity, explicit approval/revocation transitions and append-only provenance/admission receipts are database guarded. A caller-supplied verified=true flag is not accepted as signature evidence.

## Production gate

Before any Tool Gateway execution outside explicit development/test environments, the API re-reads the tenant's exact TOOL artifact identity, checks the registered digest against tool.metadata.artifactSha256, verifies that the artifact and source are active and unexpired, checks the source-key fingerprint, and cryptographically verifies the stored signature again. Missing digest/registration, mismatched digest, expired or revoked artifact/source, malformed identity, or signature/key-integrity failure is denied before usage metering and executor invocation. Every allow/deny decision creates an append-only database receipt tied to tenant, factory, actor and action-intent reference. The gate does not rely on an in-memory positive cache.

For local development and automated test environments, the Tool Gateway deliberately does not enforce the production-only gate so engineers can run tests without live signing keys. Any other environment name (including an unset NODE_ENV) is fail-closed for all Tool Gateway workloads.

## Model-provider admission boundary

`AiModelProviderGatewayService.invoke` is the shared pre-inference boundary for live model-provider adapters. The adapter must resolve the exact immutable MODEL artifact key, version and SHA-256 from its approved deployment/model package, and place the provider network call inside the supplied callback. The callback receives the same frozen, normalized artifact reference that was checked.

Outside explicit `development` and `test` modes—including staging and an unset `NODE_ENV`—the gateway re-reads the current tenant-scoped registry, verifies digest, expiry, source approval/revocation and Ed25519 signature, writes an append-only admission decision, and only then invokes the provider callback. Missing digests are passed to the admission service and denied with evidence; a failed admission/database check never falls through to inference. Positive decisions are not cached.

The gateway is a reusable enforcement boundary, not evidence that a provider is already integrated. This repository still has no concrete live provider adapter routed through it; FR-MSO-05 model-inference coverage therefore remains **partial** until each real adapter uses this gateway and passes provider-level tests against the exact model digest.

## OpenAI-compatible inference route

The authenticated `POST /api/v2/ai/inference/chat-completions` route is the first concrete provider adapter wired through `AiModelProviderGatewayService`. It accepts a bounded user prompt, a bounded completion-token limit and temperature; caller-provided model names, endpoints, API keys and system messages are not accepted. The provider credential and endpoint come only from deployment configuration, the API key is sent only in the Authorization header, and upstream error bodies are never returned to callers.

Configuration:
- `AI_MODEL_PROVIDER_CHAT_COMPLETIONS_URL`: full `https://.../chat/completions` endpoint; production/staging require HTTPS with no embedded credentials, query or fragment.
- `AI_MODEL_PROVIDER_API_KEY`: provider secret, held by the deployment secret store.
- `AI_MODEL_PROVIDER_MODEL_ID`: exact version-pinned model/deployment identifier; response model identity must equal this value exactly.
- `AI_MODEL_PROVIDER_ARTIFACT_VERSION`: immutable FactoryOS route release version.
- `AI_MODEL_PROVIDER_EGRESS_APPROVED=true`: required outside explicit development/test environments after data-residency, provider-contract and outbound-network approval.
- `AI_MODEL_PROVIDER_TIMEOUT_MS`: optional bounded timeout from 1 to 60000 ms (default 15000).

For remote inference, the MODEL artifact SHA-256 is computed from `canonicalizeAiModelProviderRouteManifest` in `services/api/src/ai/ai.openai-compatible.provider.service.ts`. That canonical JSON binds schema version, adapter/provider code, normalized endpoint URL, exact provider model ID and route artifact version. The trusted signer registers the SHA-256 of those exact UTF-8 bytes as the MODEL artifact digest, using `artifact_key = AI_MODEL_PROVIDER_MODEL_ID` and `version = AI_MODEL_PROVIDER_ARTIFACT_VERSION`, then signs the normal FactoryOS artifact envelope. Changing the endpoint, model ID or route version changes the manifest digest and therefore fails admission until a new signed version is approved.

The canonical route-manifest digest also includes the SHA-256 of the exact built-in system prompt bytes; changing that prompt changes the manifest digest and requires a newly signed/approved route artifact. The API revalidates the tenant-scoped MODEL registry on every request before checking subscription entitlement, recording AI call usage, or sending inference traffic. After admission it checks the current AI subscription, persists an AI gateway call meter before outbound network I/O, and records provider-reported input/output tokens when present. Failed admission, missing/revoked/expired signatures, absent production egress approval, invalid configuration, or usage-write failure prevents the outbound request. Token details are only recorded when the provider response supplies valid non-negative token counts. Model identity substitution is rejected; upstream response content is not returned on that failure.

This digest is a signed route/deployment manifest digest, **not a cryptographic measurement of a remote vendor's private model weights**. The route cannot independently prove the vendor executed those exact weights, and provider-specific deployment immutability/data-residency remains a release acceptance check. The endpoint is prompt-only: it does not retrieve tenant records, execute tools, authorize writes or mark an AI planner's output as trusted. Existing decision/runtime policy integration and provider-specific production acceptance remain separate requirements.

## Explicit acceptance boundaries

- The registry cryptographically verifies the signer's binding between artifact identity, SHA-256 and expiry. It does not download arbitrary artifacts or prove that remote storage bytes match that signed digest. The trusted build/deployment pipeline must compute the digest from the actual model/package/container and place the same verified digest into the immutable tool definition's metadata.artifactSha256.
- This slice wires the production Tool Gateway gate and adds a shared model-provider gateway primitive that can verify the exact MODEL artifact immediately before a provider callback. The repository still has no concrete live model-provider adapter routed through that primitive. FR-MSO-05 model-inference enforcement remains **partial** until every real provider route uses the gateway and has provider-level tests with an immutable model digest.
- Provider/model replacement compatibility and regression evaluation (FR-MSO-06), prompt/policy checksum enforcement at every execution boundary (FR-MSO-07), CI-produced signing attestations, external revocation synchronization, real release-signing custody and production cluster validation remain separate acceptance work.
- No existing artifact gets trusted implicitly. After rollout, production tool definitions without an approved signed artifact reference are intentionally denied until they are re-versioned/configured with artifactSha256 and a matching registration is approved.

## Tests

- services/api/src/ai/artifacts/ai.artifact.provenance.service.spec.ts verifies Ed25519 signatures, tamper detection, non-Ed25519 rejection, missing-registration denial, revocation denial and successful digest-bound admission.
- services/api/test/ai-artifact-provenance.sql verifies forced RLS, uniqueness and database lifecycle guards.
- PostgreSQL CI applies the migration through the explicit manifest and reapplies the new migration plus this SQL contract to exercise DDL idempotency.
