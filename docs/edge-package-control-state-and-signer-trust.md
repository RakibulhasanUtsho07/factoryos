# Edge package-control state and signer trust snapshot

## Purpose

This library slice adds two local, fail-closed stores that support the signed-package verifier and activation coordinator. It does not create the cloud API or automatically wire the stores into the host model runtime.

## Durable package-control state

`EdgePackageControlStateStore` persists package/version/use-case decisions such as ACTIVE, PAUSED and terminal REVOKED. Updates use a private directory, regular-file checks, atomic replacement and file/directory sync. Concurrent updates are serialized. A corrupt file or symlink fails closed instead of initializing an empty control set. A stored REVOKED decision cannot be overwritten by ACTIVE, and removed scopes do not erase historical terminal revocations.

The store is local persistence only; a deployment must still poll its authoritative control endpoint, validate exact target scope and freshness, and have the model/policy host call the gate at the actual activation and execution boundaries.

## Trusted signer-key snapshot

`EdgePackageSigningKeyStore` accepts a complete tenant/factory-scoped signer snapshot, validates Ed25519 public key material and SHA-256 fingerprints, and persists the snapshot atomically. Private-key PEM material is rejected. The store never invents missing keys; a fingerprint mismatch, key-ID rebind, tenant-scope mismatch or corrupted/symlinked state is denied.

Freshness is mandatory when signer keys are returned for package verification. A stale snapshot or later poll failure fails closed, while previously observed REVOKED keys and keys omitted from a purported complete snapshot remain locally revoked, including after restart. This prevents rollback of key revocation through a stale or incomplete poll.

## Acceptance boundary

The companion package-governance API adds the tenant/factory-scoped database signing-key registry and immutable key/control event ledgers, IAM-guarded administrator routes for key registration/rotation/revocation and control pause/resume/revoke, plus device-token-authenticated endpoints for complete signer snapshots and effective package controls. The token—not caller-supplied scope headers—determines the device's tenant/factory/device identity. The snapshot endpoint refuses oversized results rather than silently truncating revoked-key history.

The local stores still do not perform network polling themselves or start/stop a model runtime. The deployment-owned agent must authenticate and poll these endpoints, pass complete snapshots into the signer store, record poll failures, then supply fresh signer policy and exact package-control decisions to the activation coordinator and execution-time gate.

The local files contain public keys and package-control metadata, not private signing keys. Filesystem permissions, OS ownership, backup policy, host-secret custody and production rollout remain deployment controls. Passing repository tests does not constitute SRS production acceptance or prove hardware-in-loop commissioning.
