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

## Explicit acceptance boundaries

- The registry cryptographically verifies the signer's binding between artifact identity, SHA-256 and expiry. It does not download arbitrary artifacts or prove that remote storage bytes match that signed digest. The trusted build/deployment pipeline must compute the digest from the actual model/package/container and place the same verified digest into the immutable tool definition's metadata.artifactSha256.
- This slice wires the live admission gate to production Tool Gateway execution. It exposes model-artifact registration and the same reusable verification/admission service, but this repository path does not currently contain a single universal live model-provider invocation to intercept. A provider-specific model adapter must call assertAdmissible with the actual resolved model digest before sending inference traffic; until that exists and is covered by provider integration tests, FR-MSO-05 model-inference enforcement remains **partial**.
- Provider/model replacement compatibility and regression evaluation (FR-MSO-06), prompt/policy checksum enforcement at every execution boundary (FR-MSO-07), CI-produced signing attestations, external revocation synchronization, real release-signing custody and production cluster validation remain separate acceptance work.
- No existing artifact gets trusted implicitly. After rollout, production tool definitions without an approved signed artifact reference are intentionally denied until they are re-versioned/configured with artifactSha256 and a matching registration is approved.

## Tests

- services/api/src/ai/artifacts/ai.artifact.provenance.service.spec.ts verifies Ed25519 signatures, tamper detection, non-Ed25519 rejection, missing-registration denial, revocation denial and successful digest-bound admission.
- services/api/test/ai-artifact-provenance.sql verifies forced RLS, uniqueness and database lifecycle guards.
- PostgreSQL CI applies the migration through the explicit manifest and reapplies the new migration plus this SQL contract to exercise DDL idempotency.
