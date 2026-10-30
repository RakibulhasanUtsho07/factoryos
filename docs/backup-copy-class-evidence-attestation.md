# Signed backup copy-class evidence attestation

**Purpose:** prevent a caller from inventing or altering a backup-copy-class evidence claim without a signature from an owner key explicitly trusted by the API deployment.

**Boundary:** this proves a trusted key signed canonical claims, and the API can read the exact evidence bytes from its deployment-owned read-only evidence root and compare SHA-256 before submission, acceptance review, and propagation checkpoints. It still does not discover arbitrary remote artifacts or prove that every provider backup copy has been enumerated; independent reviewers and real-provider staging acceptance remain required.

## Trust configuration

Configure `FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON` only from reviewed deployment configuration or the approved secret/configuration manager. It is a JSON array whose entries contain `keyId`, `ownerReference`, and an Ed25519 **public** key in PEM format. Every key ID must be unique, and the owner reference must exactly match the data-owner or infrastructure-owner reference in the signed claim. The runtime refuses empty/malformed trust stores, non-Ed25519 keys, duplicate IDs, private-key material, unknown key IDs, and owner mismatches.

The committed examples intentionally set the trust store to `[]`. That means API submissions fail closed until the infrastructure/security owner validates the identity, custody, and owner mapping of a public key. Do not commit real trust configuration or any private key. Keep the public key registry deployment-controlled, with an audited rotation and revocation procedure.

Illustrative environment value (replace all placeholders with approved values; this is not a working key):

```json
[
  {
    "keyId": "owner-infrastructure-ed25519-v1",
    "ownerReference": "owner.infrastructure.v1",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\nREPLACE_WITH_APPROVED_PUBLIC_KEY_BYTES\\n-----END PUBLIC KEY-----"
  }
]
```

The JSON environment value must escape PEM line breaks as `\\n`. The API accepts at most 100 trusted keys. Do not put private key bytes in this setting.

## Create and sign a claim

Create a JSON request body using the API DTO's snake_case field names. It must include category, copy class, disposition, an opaque evidence reference, a lower-case SHA-256 digest for the exact evidence pack, timestamp, key ID, attesting owner, both accountable owner references, policy reference, reason, and idempotency key. Use a source file/immutable package containing inventory, enumeration completeness, provider/control-plane read-back, retention/legal-hold disposition and supporting source evidence. Do not put credentials or customer payloads in the reference or claim.

From a controlled owner environment, calculate the digest of that exact evidence pack and sign only after the owner validates the pack and reference. The command validates the file digest against `evidence_sha256`, requires an Ed25519 private key and produces a signed API body:

```powershell
node scripts/security/sign-backup-copy-class-evidence.mjs --payload .\\unsigned-claim.json --evidence-file C:\\secure\\evidence\\backup-copy-class-pack.bin --private-key-file C:\\secure\\keys\\owner-ed25519-private.pem --tenant-id 28000000-0000-4000-8000-000000000001 > .\\signed-claim.json
```

Use the real tenant UUID and approved protected file paths. Treat the private key as sensitive; the API runtime should receive only public keys. The example tenant identifier is illustrative, and the command must not be run against production data just to test the workflow.

The signature covers this versioned canonical JSON schema: `factoryos.backup-copy-class-evidence-attestation/v1`. Its claims, in fixed order, are key ID, attesting owner, tenant UUID (lowercase), category, copy class, disposition, evidence reference, evidence SHA-256, normalized ISO timestamp, data-owner reference, infrastructure-owner reference, policy reference, and reason. Timestamp normalization and trimmed reason must match the API. Do not hand-edit a signed request; changing a field invalidates the signature. Use a new evidence revision and idempotency key when claims need correction.

## Submit, review and block safely

Submit the signed body to `POST /v2/saas/data-retention/backup-copy-classes`. The API verifies the signature against the deployment trust store before beginning the database transaction, then persists the signature and attestation metadata in the tenant-scoped immutable decision. The reviewer must be a different authorized actor. Review still checks that the evidence is fresh, the revision is latest, and the same tenant/category/copy-class scope remains current.

An empty or broken trust store is a service-configuration failure, and invalid/unknown signatures or owner bindings are rejected. Do not downgrade to unsigned rows, re-sign a stale claim, or mark a missing source artifact `NOT_APPLICABLE`. If a key is compromised, remove it from the deployment trust store, rotate under the documented key-management policy and submit new evidence; a revoked/missing key must not be treated as a valid current source attestation.

Synthetic CI keys and SQL fixture signatures exist only to test cryptographic/control contracts. They are not evidence of real PostgreSQL, Redis, S3, vault, snapshot, replica or disaster-recovery behavior. Provider staging, an independently reviewed evidence pack, owner-approved retention policy, and full copy-class coverage remain required for production release acceptance.


## Source artifact read-back

Set `FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR` to an absolute directory mounted into the API runtime and owned by the deployment/evidence pipeline. It must be a real directory, not a symlink. Mount it read-only for the API identity. The API does not follow URLs and does not fetch caller-supplied HTTP(S) destinations. It also rejects a root directory whose POSIX mode has any write bit, evidence files with any write bit, and files with more than one hard link. Provision the evidence directory with mode `0555` and each artifact with mode `0444` (or stricter), and ensure no ACL or storage-layer permission grants the API identity write access. The runtime additionally reads Linux `/proc/self/mountinfo` and requires the deepest mount covering both the canonical evidence root and the exact artifact path to carry the per-mount `ro` option. A writable nested bind/file mount, missing mount metadata, unsupported platform, or no matching mount fails closed. These controls do not defeat a privileged host/storage administrator; keep the API identity unable to write/remount the volume and keep the publisher separate. Independent deployment verification of the mount and identity permissions remains mandatory.

Every `evidence_reference` is a single opaque file identifier matching `[A-Za-z0-9][A-Za-z0-9._-]{0,199}`. The referenced file must exist under the configured root, be a regular non-empty file, be opened without following symlinks, and be no larger than 16 MiB. The API streams the bytes with a bounded buffer, computes SHA-256 itself, checks the actual byte count, and rejects metadata/content changes detected during reading. The result must equal the signed `evidence_sha256`; missing files, symbolic links, directory entries, oversize data, wrong digest or an unavailable/unsafe root fail closed.

Copy the *same evidence pack bytes* used by the signer into the read-only evidence root under the opaque reference before submission. Do not put a directory name, path, URL, tenant data, or secret into the reference. If the source evidence changes, publish a new artifact ID and digest, create a new signed revision, and obtain independent review. Old accepted decisions are rechecked against the current artifact at every propagation preflight/recovery/provider checkpoint, so a missing or replaced artifact blocks execution.

This source reader is a deployment-local immutable-artifact contract, not yet an S3/GCS/Vault object-source adapter. A mounted immutable evidence volume or approved artifact staging pipeline must supply the file. Real provider metadata, IAM ownership, inventory completeness and backup enumeration still require independently reviewed source evidence.
