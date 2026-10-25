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

The API's credential needs should be limited to GetObject for the dedicated proof bucket/prefix. It does not need bucket listing or object-write permissions for verification. Production endpoint and credentials must be chosen by the deployment/security owner; this repository does not contain live credentials or assert that a provider bucket is provisioned.

## Carrier integration contract

Before sending a DELIVERED callback, the carrier/provider workflow must place the exact proof bytes at the agreed object key in the configured bucket. The signed callback contains that relative key in proof_reference and SHA-256 hex of the exact stored bytes in proof_sha256. The provider must not send arbitrary URLs; keys are validated and the server constructs the request against the fixed configured endpoint. HTTP redirects are rejected, response size is bounded, and no caller-controlled host or URL is fetched.

This implementation is a read-and-verify adapter. It does not yet provide a browser/mobile upload endpoint, mint upload URLs, upload bytes into the bucket, or independently certify a carrier's real sandbox callback format. Those remain separately testable integration/release gates.

## Regression coverage

services/api/src/integrations/wms-pod-storage.spec.ts verifies signed request construction, digest success and mismatch, fail-closed missing config, key-traversal rejection, object size limit and production HTTPS enforcement. integration.service.spec.ts verifies that actual stored bytes must match before the WMS ledger and webhook receipt are committed. CI runs the API tests and PostgreSQL migration/acceptance suite for the PR head.
