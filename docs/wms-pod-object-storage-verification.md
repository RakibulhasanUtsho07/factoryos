# WMS proof-of-delivery object verification

## Purpose and acceptance rule

For a signed WMS_CARRIER webhook whose lifecycle event is DELIVERED, FactoryOS no longer treats the carrier's proof_sha256 field as proof that the stored object has those bytes. Before opening the WMS business transaction, the API retrieves the object from one configured S3-compatible endpoint, computes SHA-256 over the response bytes, and constant-time compares the result with the signed digest. A missing configuration, missing object, failed retrieval, oversized/empty object or digest mismatch prevents the delivery event and webhook receipt from being committed.

Non-delivery lifecycle events do not fetch proof objects. An exact already-accepted replay is acknowledged through the existing receipt path without another object-storage read; payload conflicts still follow the webhook conflict/reconciliation path.

## Required server configuration

Set these environment values in the API deployment and store credentials only in the deployment secret manager:

| Variable | Required / default | Notes |
| --- | --- | --- |
| WMS_POD_STORAGE_ENDPOINT | Required | Credential-free S3-compatible endpoint. Production must use HTTPS. |
| WMS_POD_STORAGE_BUCKET | Required | Lowercase bucket name used with path-style addressing. |
| WMS_POD_STORAGE_REGION | Required | SigV4 region configured by the storage provider. |
| WMS_POD_STORAGE_ACCESS_KEY_ID | Required | Least-privilege read-only object access. |
| WMS_POD_STORAGE_SECRET_ACCESS_KEY | Required | Secret; do not commit or expose it. |
| WMS_POD_STORAGE_SESSION_TOKEN | Optional | Temporary-credential session token, when provided by the approved credential mechanism. |
| WMS_POD_STORAGE_MAX_BYTES | 10,485,760 | Maximum object body size, from 1 byte to 25 MiB. |
| WMS_POD_STORAGE_TIMEOUT_MS | 5,000 | Bounded fetch timeout, from 1,000 to 30,000 ms. |

The API's storage principal needs GetObject for independent digest verification and PutObject for the authenticated upload prefix (scoped to the dedicated POD bucket/prefix); it does not need bucket listing. Separate upload workflows can use their own least-privilege principal. Production endpoint and credentials must be chosen by the deployment/security owner; this repository does not contain live credentials or assert that a provider bucket is provisioned.

## Carrier integration contract

Before sending a DELIVERED callback, the carrier/provider workflow must place the exact proof bytes at the agreed object key in the configured bucket. The signed callback contains that relative key in proof_reference and SHA-256 hex of the exact stored bytes in proof_sha256. The provider must not send arbitrary URLs; keys are validated and the server constructs the request against the fixed configured endpoint. HTTP redirects are rejected, response size is bounded, and no caller-controlled host or URL is fetched.

## Authenticated POD upload endpoint

The API now exposes `POST /api/integrations/wms/shipments/:shipmentUnitId/pod-object` for a user with the factory-scoped `inventory.write` permission. Send one multipart field named `file`; the upload is accepted only when the shipment belongs to the caller's tenant/factory and is already `DISPATCHED`. The endpoint accepts JPEG, PNG or PDF only, confirms the file signature matches the declared media type, and applies a 25 MiB HTTP hard limit plus the configured `WMS_POD_STORAGE_MAX_BYTES` application limit.

The server creates the storage key under `pod/{tenant_id}/{factory_id}/{shipment_unit_id}/{object_id}`; clients cannot supply an object key, bucket, endpoint or URL. The adapter signs an S3-compatible `PUT` with SigV4, sends the exact uploaded bytes, then performs a separate `GET` and hashes the stored response bytes. A successful response includes `object_id`, `shipment_unit_id`, `proof_reference`, `proof_sha256`, `byte_length`, `content_type` and `verified: true`. The operation is recorded in audit and outbox evidence only after the read-back digest matches.

Uploading a file is not itself a delivery event and must not mark a shipment delivered. The carrier's signed `WMS.SHIPMENT_DELIVERY` callback must reference this object key and digest; the existing webhook path performs a fresh storage GET/SHA-256 verification before it commits the immutable delivery event and webhook receipt. A carrier may also place the object directly in the agreed bucket using its approved workflow, but it must follow the same key/digest contract.

The API CI workflow additionally starts an ephemeral RustFS 1.0.3 S3-compatible test server with CI-only credentials and runs `wms-pod-storage.s3.integration.spec.ts`. That acceptance creates an isolated bucket with a signed request, performs the adapter's actual signed object PUT and read-back GET, independently re-reads the object, compares SHA-256 and byte length, and confirms that a deliberately wrong digest is rejected. This verifies the request-signing and object persistence path against the isolated test server rather than only mocked `fetch` responses. The full PostgreSQL Jest suite has no object-storage service and skips this one acceptance suite only when all storage settings are absent; if any storage setting is supplied but the required configuration is incomplete, the suite fails rather than silently skipping. It does not certify every S3 provider implementation or prove that a deployment's external account is correctly configured. No live storage account, deployment credentials, object lifecycle policy, carrier sandbox certification or production bucket has been provisioned or verified by this change; those remain deployment and external-certification gates.

## Regression coverage

`services/api/src/integrations/wms-pod-storage.spec.ts` verifies signed GET/PUT construction, mocked successful read-back digest verification, stored-byte mismatch, content-signature spoofing, missing configuration, key traversal, size bounds and production HTTPS enforcement. `services/api/src/integrations/wms-pod-storage.s3.integration.spec.ts` runs against the isolated RustFS test server in API CI and verifies actual signed bucket creation, PUT persistence, GET read-back and mismatch rejection. `integration.service.spec.ts` verifies that a tenant/factory-scoped dispatched-shipment upload emits audit/outbox evidence only after read-back verification, and that a failed digest never creates upload evidence. Existing webhook tests verify that the separately fetched stored bytes must match before the WMS delivery event and webhook receipt commit. The isolated service is only an S3-compatible test target; external provider configuration and certification remain separate release gates.


## Scoped object-deletion primitive (2026-10-28)

The API now contains `deleteWmsPodObjectAndVerifyGone` as a narrowly scoped building block for a future reviewed external-erasure adapter. It accepts one explicit object identity, requires the canonical `pod/{tenant UUID}/{factory UUID}/{shipment UUID}/{object UUID}` hierarchy, verifies the current stored bytes against the expected SHA-256, independently reads bucket versioning and blocks versioned or unknown configurations, issues a signed S3 DELETE, then performs a separate signed GET and accepts only HTTP 404 as proof of absence.

The function is intentionally **not registered as a SaaS erasure adapter** and is not evidence of whole-tenant erasure. The provider resource inventory must still be captured, tenant-bound and durably pinned to the erasure request/run; per-resource operation receipts and uncertain-outcome recovery must be implemented before the function may be invoked by the erasure saga. Cache/index/vector/replica/backup/provider copies remain outside this primitive. The RustFS integration tests exercise the destructive request only against the isolated CI bucket.
