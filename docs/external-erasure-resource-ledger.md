# External tenant erasure: sealed resource ledger

## Purpose

Migration 219 introduces the durable resource-level evidence required below the existing target-level propagation receipt. The saga now persists an adapter's exact resource identity set, seals that set, and records append-only intent/outcome events before it can report whole-tenant erasure as verified.

This is an orchestration and contract change. It is **not** proof that all external providers have production adapters or that a customer tenant has been erased.

## Adapter contract

Every `SaasTenantExternalDataPropagationAdapter.prepare()` result must include:

- A complete `resources` identity list with resource kind, opaque resource reference, optional immutable version/generation reference, and optional SHA-256 content digest captured from persisted provider bytes.
- `manifestDigest`, computed as SHA-256 of the JSON form of `canonicalizeSaasExternalPropagationResources(resources)`. The canonical form normalizes missing version/content digests to `null` and bytewise sorts by resource kind, reference, version reference and content digest.
- A `plannedCopies` value exactly equal to the number of identities, a semantic `adapterVersion`, a `resourceClass`, bounded enumeration/batch limits, a non-secret `policyVersions` object and an opaque `planReference`.

The service independently checks the count, digest, duplicates, reference formats, adapter metadata and policy limits. The adapter implementation exposes its own semantic `adapterVersion`; the plan version must match it on the first attempt and every retry, so a deployment cannot silently run a different adapter build against an already sealed identity set. A plan with a digest that does not match its identity array is rejected before mutation. Resources are capped at 100,000 per target and 32 MiB of serialized identity metadata in this execution path. Database item inserts are chunked at the adapter-declared maximum batch size (never above 1,000).

Resource references must be stable opaque identifiers. Credentials, tokens, URLs, payloads and connection strings must not be placed in the manifest or event ledger.

## Durable sequence

For a newly prepared target, one PostgreSQL transaction:

1. Inserts a `STAGING` manifest bound to tenant, erasure request/version, run, reviewed target, adapter version, source-export digest, canonical manifest digest and policy versions.
2. Inserts all identities in ordinal order with per-identity SHA-256 and a stable operation key.
3. Transitions the manifest to `SEALED` only after the database trigger confirms the exact declared count and contiguous ordinals.
4. Appends the first `PREPARED` event for every identity.
5. Attaches the manifest ID to the run plan in the same transaction.

Only after that transaction commits does the saga append `DELETE_REQUESTED` for every resource and call the provider adapter's idempotent erase operation. It appends `DELETED` only when the provider receipt matches the exact digest and the deleted count equals the sealed plan. It appends `VERIFIED` only when independent verification returns the same digest, all planned copies are accounted for, and residual count and residual identity list are both zero/empty.

An incomplete or uncertain attempt is recorded as `FAILED_RETRYABLE`; a retry must start a new numbered `PREPARED` attempt for the same sealed identities. A retry does not enumerate a wider scope under the same run. A process restart after `DELETE_REQUESTED` or `DELETED` loads the stored manifest and calls adapter recovery before retrying or verifying.

## Database safeguards

Migration `219_saas_external_erasure_resource_manifest_receipts.sql` defines:

- `saas_tenant_external_propagation_manifests`: source/target binding, bounded limits, digest, resource count, policy versions and seal state.
- `saas_tenant_external_propagation_manifest_items`: immutable ordered opaque identities, optional verified content digests, unique identity digests/references and per-resource operation keys.
- `saas_tenant_external_propagation_resource_events`: append-only per-resource attempts with legal state transitions and receipt/digest binding.

All three relations use forced row-level security and tenant policies and are classified as protected governance evidence in `factoryos_governance.tenant_relation_inventory`. Generic data export excludes this control evidence, and generic erasure must not delete it.

## Acceptance status and remaining limits

The saga contract tests assert that all eight required store classes produce sealed identity manifests and per-resource `PREPARED → DELETE_REQUESTED → DELETED → VERIFIED` evidence, and that the first destructive adapter call occurs after the delete-intent write.

The WMS POD S3 adapter is now registered under `OBJECT_STORAGE / wms.pod.s3.v1`, but its capability is deliberately narrow: required targets must cover `EVIDENCE` only, and `config_reference` must exactly match the deployment's `WMS_POD_STORAGE_CONFIG_REFERENCE`. It uses the configured POD bucket credentials and requires an independently readable, disabled bucket-versioning state. It enumerates all ListObjectsV2 pages under `pod/{tenant UUID}/`, rejects unknown key shapes and incomplete/repeated pagination, limits plans to 100,000 objects, reads and SHA-256 hashes each persisted object before sealing, then checks the digest again before deletion. A fresh tenant-prefix listing after deletion is the independent residual check.

The content digest is persisted in `resource_content_digest` and is included in the canonical resource-manifest digest and each resource identity digest. When a retry finds an object already absent after durable deletion intent, that identity is idempotently accounted for; a present object whose bytes changed from the sealed digest is not deleted. The deterministic `wms-pod-s3-delete.*` receipt is an adapter-generated correlation reference for S3's successful DELETE plus read-back flow, **not a provider-issued deletion receipt**.

This is the first concrete external erasure adapter implementation, not whole-tenant provider closure. The saga still requires a reviewed target for every required store class/category, and production configuration plus controlled provider acceptance have not been demonstrated here. Cache, search, vector, learning artifacts, external providers, replicas and backups still need their own complete inventory/deletion/verification/recovery adapters. Backup expiry/immutability and provider-specific retention behavior also require explicit evidence.

AS-137/NFR-PROD-14 remain **Partial** until all required adapters are available and controlled staging evidence passes. CI uses an isolated S3-compatible server, not production credentials or customer objects; no production/customer deletion is claimed.
