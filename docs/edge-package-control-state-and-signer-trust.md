# Edge package-control state and signer trust snapshot

## Purpose

This slice adds local, fail-closed control/signer stores and a host-callable execution gate for signed packages. It does not perform network polling itself or automatically register the gate with a model-runtime process.

## Durable package-control state

`EdgePackageControlStateStore` persists package/version/use-case decisions such as ACTIVE, PAUSED and terminal REVOKED. Updates use a private directory, regular-file checks, atomic replacement and file/directory sync. Concurrent updates are serialized. A corrupt file or symlink fails closed instead of initializing an empty control set. A stored REVOKED decision cannot be overwritten by ACTIVE, and removed scopes do not erase historical terminal revocations.

On process restart, only terminal REVOKED decisions remain authoritative; persisted ACTIVE/PAUSED/UNKNOWN records are reset to UNKNOWN with RESTART_REQUIRES_FRESH_SYNC until a new cloud poll succeeds. The store is local persistence only; a deployment must poll its authoritative control endpoint, validate exact target scope and freshness, persist the complete result, and only then confirm that sync to the runtime gate.

## Trusted signer-key snapshot

`EdgePackageSigningKeyStore` accepts a complete tenant/factory-scoped signer snapshot, validates Ed25519 public key material and SHA-256 fingerprints, and persists the snapshot atomically. Private-key PEM material is rejected. The store never invents missing keys; a fingerprint mismatch, key-ID rebind, tenant-scope mismatch or corrupted/symlinked state is denied.

Freshness is mandatory when signer keys are returned for package verification. A stale snapshot or later poll failure fails closed, while previously observed REVOKED keys and keys omitted from a purported complete snapshot remain locally revoked, including after restart. This prevents rollback of key revocation through a stale or incomplete poll.

## Acceptance boundary

The companion package-governance API adds the tenant/factory-scoped database signing-key registry and immutable key/control event ledgers, IAM-guarded administrator routes for key registration/rotation/revocation and control pause/resume/revoke, plus device-token-authenticated endpoints for complete signer snapshots and effective package controls. The token—not caller-supplied scope headers—determines the device's tenant/factory/device identity. The snapshot endpoint refuses oversized results rather than silently truncating revoked-key history.

EdgePackageRuntimeGate supplies a host-callable execution boundary. It requires a complete, bounded set of fresh managed control scopes; fails closed after any poll failure; resolves exact package/version/use-case state; re-verifies the currently active manifest, signing-key status, and every artifact byte at execution time; then rechecks control immediately before invoking the host callback. The execution callback receives copies of the verified artifact bytes, not an unverified path reference.

The local files contain public keys and package-control metadata, not private signing keys. The deployment-owned agent must still authenticate and poll the cloud endpoints, call confirmControlSync only after every managed scope is successfully persisted, and call recordControlSyncFailure on any poll/parse/persistence error. The actual host must route every model/policy execution through EdgePackageRuntimeGate.execute; direct calls to lower-level stores/executors can bypass the gate. Filesystem permissions, OS ownership, backup policy, host-secret custody, live runtime wiring and production rollout remain deployment controls. Passing repository tests does not constitute SRS production acceptance or prove hardware-in-loop commissioning.
