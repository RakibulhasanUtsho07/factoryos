# Edge signed-package verification and activation boundary

## Included library slice

The package library under `services/api/src/edge/packages` provides:

- Versioned package manifests scoped to a tenant and factory, bound to package/model/policy versions, signer key ID, explicit issue/expiry instants, allowed-tool IDs, artifact paths, SHA-256 digests and byte sizes, plus rollback metadata.
- Canonical signed payload construction and Ed25519 public-key signature verification. Unknown, revoked, malformed or incorrectly scoped signer policy is denied; expired/not-yet-valid packages, disallowed tools, unsafe paths, extra artifacts and digest/size mismatches are rejected.
- Filesystem activation in a private staging directory, content-addressed release storage, artifact syncing and atomic active-pointer updates. Identical package/version/content replay is idempotent; conflicting content cannot overwrite an active version.
- Rollback that re-verifies both stored releases and artifact bytes, checks the signed manifest's rollback authorization, and changes the active pointer only after all checks succeed.
- A host-facing release coordinator that requires an explicit package/version/tenant/factory target and a fresh exact-scope ACTIVE decision supplied by a deployment-owned runtime contract before invoking the activation store.

## Security and operational boundary

This is a library slice, not a registered API service or an automatically enforced model-runtime hook. A production host must route package activation through `EdgePackageReleaseCoordinator`, provide a trusted signer-key policy and a fresh package-control decision, and apply the execution-time allow/deny gate before loading or running any package. Calling lower-level stores directly bypasses coordinator checks.

The companion package-governance API and local signer/control stores provide the server registry, IAM-protected administrative controls, device-token-scoped snapshot/effective-control endpoints, local terminal-revocation persistence, and stale-snapshot fail-closed behavior. However, an agent polling loop that joins these endpoints to the stores, initial key/bootstrap and rotation procedure, automatic activation-path enforcement, execution-time allow/deny wiring, native device transport and hardware-in-loop acceptance remain separate integration gates. Do not represent this library/API layer as a production runtime kill-switch until the deployment host invokes it at both activation and execution boundaries and the full path is independently tested.

Package bytes and policy bundles are verified but never executed by these classes. The host must enforce OS-level ownership/permissions, safe filesystem deployment, resource limits and approved rollback policy. Repository unit tests do not prove customer-site commissioning, signer-key custody or model-runtime safety acceptance.
