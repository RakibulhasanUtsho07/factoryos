# External store inventory evidence manifest

## Purpose

The `UNCLASSIFIED_EXTERNAL_STORE` coverage sentinel can be marked `NOT_APPLICABLE` only when the evidence artifact is a validated `factoryos.external-store-inventory/v1` JSON manifest. A generic binary evidence pack, a signer statement alone, or a list of discovered resources is insufficient.

The API validates the exact read-only artifact bytes at submission, independent ACCEPT review, propagation preflight, recovery and subsequent provider checkpoints. The digest and Ed25519 attestation already bind those exact bytes to the tenant/category/store-kind/disposition claim. The validator additionally checks the manifest structure and freshness.

## Required manifest fields

The manifest must include:

- `schema`: `factoryos.external-store-inventory/v1`.
- `tenant_id` and `category_code`: exact values from the signed API claim.
- `generated_at`: a current timestamp no more than 30 days old and no more than five minutes in the future.
- `scope`: four arrays of opaque, non-secret references: `provider_references`, `account_references`, `project_references`, and `region_references`. At least one provider, account or project reference is required.
- `scope_sha256`: SHA-256 of the canonical scope object. Each discovery-source result must carry this same digest.
- `inventory_complete: true`, `unclassified_store_count: 0`, and `discovered_store_kinds` containing only unique entries from the eight known store kinds.
- `sources`: exactly one COMPLETE row for every required source kind below. Every row must say `pagination_exhausted: true`, report a positive `pages_fetched`, a non-negative `item_count`, an opaque source reference, a SHA-256 result digest, the same `scope_sha256`, and start/completion timestamps.

Required source kinds:

1. `TENANT_SCOPE_CATALOG`
2. `RESOURCE_TYPE_CATALOG`
3. `IAM_WRITER_PRINCIPALS`
4. `REPLICATION_AND_DELIVERY`
5. `SCHEDULED_AND_DELAYED_WRITERS`
6. `RESTORE_AND_DR_PATHS`
7. `SECONDARY_EXTERNAL_STORES`

A source that cannot be queried, has an incomplete page cursor, reports a partial result, or cannot bind its response to the same scope must not be represented as COMPLETE. Resolve the source gap or submit `UNRESOLVED`; never use `NOT_APPLICABLE` to mean "not checked".

## Operational boundary

This manifest is a structured completeness contract for an owner-attested evidence artifact. The API verifies the artifact's exact bytes, digest, tenant/category binding, required source set, scope binding, pagination completion, freshness and known store-kind catalog. It does **not** independently call cloud provider APIs, authenticate the source query receipts, prove that a malicious owner did not omit an account/region, or defeat a privileged cloud/storage administrator. Provider-native audit receipts, read-only cross-account discovery, source API identities, and independent infrastructure review remain separate production acceptance requirements.

Do not put customer payloads, access tokens, secrets, credentials, connection strings, or raw cloud URLs in the manifest. Use opaque stable references and store the original provider query/response material in the separately controlled evidence system. Sign the exact manifest bytes with the existing external-copy coverage signer and publish the same bytes under the opaque evidence reference in the deployment-owned read-only artifact root.
