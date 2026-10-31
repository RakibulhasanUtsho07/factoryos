# External store inventory evidence manifest

## Purpose

The `UNCLASSIFIED_EXTERNAL_STORE` coverage sentinel can be marked `NOT_APPLICABLE` only when the evidence artifact is a validated `factoryos.external-store-inventory/v1` JSON manifest. A generic binary evidence pack, a signer statement alone, or a list of discovered resources is insufficient.

The API validates the exact read-only artifact bytes at submission, independent ACCEPT review, propagation preflight, recovery and subsequent provider checkpoints. The outer digest and Ed25519 owner attestation bind those exact bytes to the tenant/category/store-kind/disposition claim. Each discovery source also carries a separate Ed25519 collector receipt checked against a deployment-configured source trust store.

## Required manifest fields

The manifest must include:

- `schema`: `factoryos.external-store-inventory/v1`.
- `tenant_id` and `category_code`: exact values from the signed API claim.
- `generated_at`: a current timestamp no more than 30 days old and no more than five minutes in the future.
- `scope`: four arrays of opaque, non-secret references: `provider_references`, `account_references`, `project_references`, and `region_references`. At least one provider, account or project reference is required.
- `scope_sha256`: SHA-256 of the canonical scope object. Each discovery-source result must carry this same digest.
- `inventory_complete: true`, `unclassified_store_count: 0`, and `discovered_store_kinds` containing only unique entries from the eight known store kinds.
- `manifest_id`: a UUID unique to this inventory run. Every signed source receipt binds to this ID to prevent replay into another manifest.\n- `sources`: exactly one COMPLETE row for every required source kind below. Every row must say `pagination_exhausted: true`, report a positive `pages_fetched`, a non-negative `item_count`, an opaque source reference, a unique `collection_run_reference`, a SHA-256 result digest, the same `scope_sha256`, start/completion timestamps, `attestation_key_id`, `attestation_owner_reference`, and a canonical base64url Ed25519 `attestation_signature`.

Required source kinds:

1. `TENANT_SCOPE_CATALOG`
2. `RESOURCE_TYPE_CATALOG`
3. `IAM_WRITER_PRINCIPALS`
4. `REPLICATION_AND_DELIVERY`
5. `SCHEDULED_AND_DELAYED_WRITERS`
6. `RESTORE_AND_DR_PATHS`
7. `SECONDARY_EXTERNAL_STORES`

A source that cannot be queried, has an incomplete page cursor, reports a partial result, or cannot bind its response to the same scope must not be represented as COMPLETE. Resolve the source gap or submit `UNRESOLVED`; never use `NOT_APPLICABLE` to mean "not checked".

## Independently trusted source receipts

The manifest owner signature is not a substitute for the discovery collector's identity. Every source row must be signed by its own independently provisioned collector key. The API validates the canonical `factoryos.external-store-inventory-source-receipt/v1` payload, including tenant, category, manifest ID, source kind/reference, collection run reference, completion and pagination status, page/item counts, result digest, scope digest and timestamps.

Configure `FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON` in the API runtime. The value must be a JSON array of public-key records with this shape (example values only):

```json
[
  {
    "keyId": "collector.iam-writers.v1",
    "ownerReference": "owner.collector.iam-writers",
    "sourceKinds": ["IAM_WRITER_PRINCIPALS"],
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\nREPLACE_WITH_APPROVED_ED25519_PUBLIC_KEY\\n-----END PUBLIC KEY-----"
  }
]
```

The trust record's `sourceKinds` is an allowlist; a key trusted for one source cannot sign a different source. The `ownerReference` must match the receipt. Use separate collector identities/keys for the discovery source domains where practical. An empty, malformed, duplicate or missing trust store fails closed. The API receives public keys only. Never place collector private keys in the API environment, container image, repository or evidence artifact.

Sign each completed source receipt in the collector-controlled environment:

```powershell
node scripts/security/sign-external-store-inventory-source-receipt.mjs --receipt .\\unsigned-source-receipt.json --private-key-file C:\\secure\\keys\\iam-writer-collector-ed25519-private.pem > .\\signed-source-receipt.json
```

The receipt must be created after the collector has completed pagination and persisted the exact query result artifact. The signer rejects non-COMPLETE/incomplete-pagination claims, stale timestamps, invalid source kinds and non-Ed25519 keys. The resulting receipt is then embedded unchanged in the manifest before the outer owner signs the complete evidence file. A source receipt cannot be moved to another tenant, category, scope, collection run or manifest ID without invalidating its signature.

The trusted key registry authenticates the configured collector identity and its signed claims. It does **not** independently authenticate a provider API response, prove the collector had read-only provider permissions, or prove that the collector queried every authoritative account/control plane. Those requirements still need provider-native audit/query receipts, externally enforced read-only identities and independent infrastructure review.

## Operational boundary

This manifest is a structured completeness contract for an owner-attested evidence artifact. The API verifies the artifact's exact bytes, digest, tenant/category binding, required source set, scope binding, collector receipt signatures, pagination completion, freshness and known store-kind catalog. It does **not** independently call cloud provider APIs, prove that an authenticated collector queried every authoritative account/region, or defeat a privileged cloud/storage administrator. Provider-native audit receipts, read-only cross-account discovery, source API identities, and independent infrastructure review remain separate production acceptance requirements.

Do not put customer payloads, access tokens, secrets, credentials, connection strings, or raw cloud URLs in the manifest. Use opaque stable references and store the original provider query/response material in the separately controlled evidence system. Sign the exact manifest bytes with the existing external-copy coverage signer and publish the same bytes under the opaque evidence reference in the deployment-owned read-only artifact root.
