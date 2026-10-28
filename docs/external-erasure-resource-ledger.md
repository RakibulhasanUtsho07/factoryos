# External tenant erasure: sealed resource ledger

## Purpose

Migration 219 introduces the durable resource-level evidence required below the existing target-level propagation receipt. The saga now persists an adapter's exact resource identity set, seals that set, and records append-only intent/outcome events before it can report whole-tenant erasure as verified.

This is an orchestration and contract change. It is **not** proof that all external providers have production adapters or that a customer tenant has been erased.

## Adapter contract

Every `SaasTenantExternalDataPropagationAdapter.prepare()` result must include:

- A complete `resources` identity list with resource kind, opaque resource reference and optional immutable version/generation reference.
- `manifestDigest`, computed as SHA-256 of the JSON form of `canonicalizeSaasExternalPropagationResources(resources)`. The canonical form normalizes missing versions to `null` and bytewise sorts by resource kind, reference and version reference.
- A `plannedCopies` value exactly equal to the number of identities, a semantic `adapterVersion`, a `resourceClass`, bounded enumeration/batch limits, a non-secret `policyVersions` object and an opaque `planReference`.

The service independently checks the count, digest, duplicates, reference formats, adapter metadata and policy limits. A plan with a digest that does not match its identity array is rejected before mutation. Resources are capped at 100,000 per target and 32 MiB of serialized identity metadata in this execution path. Database item inserts are chunked at the adapter-declared maximum batch size (never above 1,000).

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
- `saas_tenant_external_propagation_manifest_items`: immutable ordered opaque identities, unique identity digests/references and per-resource operation keys.
- `saas_tenant_external_propagation_resource_events`: append-only per-resource attempts with legal state transitions and receipt/digest binding.

All three relations use forced row-level security and tenant policies and are classified as protected governance evidence in `factoryos_governance.tenant_relation_inventory`. Generic data export excludes this control evidence, and generic erasure must not delete it.

## Acceptance status and remaining limits

The saga contract tests assert that all eight required store classes produce sealed identity manifests and per-resource `PREPARED → DELETE_REQUESTED → DELETED → VERIFIED` evidence, and that the first destructive adapter call occurs after the delete-intent write.

The existing WMS POD S3 deletion helper remains a single-object primitive; it is **not yet registered as a production object-storage erasure adapter**. This change does not provide production connectors for cache, search, vector, learning artifacts, external providers, replicas or backups. Those adapters must implement complete enumeration, stable identity/version references, provider-side idempotency, independent verification and restart reconciliation, with integration tests against isolated provider instances and site-specific credentials. Backup expiry/immutability and provider-specific retention behavior also require explicit evidence.

Until those provider adapters and live provider acceptance evidence exist, external erasure and AS-137/NFR-PROD-14 remain **Partial**; no customer/production deletion is claimed by unit tests.
