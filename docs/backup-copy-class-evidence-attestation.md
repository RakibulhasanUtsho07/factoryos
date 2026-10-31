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


## Deployment-time read-only volume enforcement

For Kubernetes production clusters, install the checked-in admission policy and binding before creating or restarting the API Pods. The policy uses `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy (stable on Kubernetes v1.30+) and has `failurePolicy: Fail` with a `Deny` binding. It applies to namespaces labelled `factoryos.io/backup-evidence-enforcement=required`.

The policy rejects a Pod container that sets `FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR` unless exactly one direct absolute path is set and exactly one matching mount exists. That mount must use the dedicated same-namespace PVC named `factoryos-backup-evidence`, with both the PVC volume source and the matching volumeMount marked read-only; `subPath` and `subPathExpr` are forbidden. A second validation prevents every Pod in the selected namespace—including regular, init and ephemeral containers—from mounting that PVC writable through an alias. The API container must run non-root, have a read-only root filesystem, disable privilege escalation and drop all Linux capabilities. The evidence publisher must therefore write through a separately controlled workload/namespace before the evidence volume is sealed for API consumption. A missing evidence-root variable remains fail-closed in the application itself; the production security release attestation additionally requires the root path and deployment evidence.

Install and test in this order (the namespace and Deployment names are operator inputs; no namespace is assumed by this repository):

```sh
kubectl apply --server-side --dry-run=server -f deploy/security/backup-copy-evidence-readonly-policy.yaml
kubectl apply --server-side --dry-run=server -f deploy/security/backup-copy-evidence-readonly-binding.yaml

kubectl apply -f deploy/security/backup-copy-evidence-readonly-policy.yaml
kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-readonly --timeout=60s
kubectl apply -f deploy/security/backup-copy-evidence-readonly-binding.yaml

kubectl label namespace "$API_NAMESPACE" factoryos.io/backup-evidence-enforcement=required --overwrite
kubectl rollout restart deployment/"$API_DEPLOYMENT" -n "$API_NAMESPACE"
kubectl rollout status deployment/"$API_DEPLOYMENT" -n "$API_NAMESPACE"
kubectl get validatingadmissionpolicy factoryos-backup-evidence-readonly -o yaml
kubectl get validatingadmissionpolicybinding factoryos-backup-evidence-readonly -o yaml
```

The rollout restart is mandatory after enabling the namespace binding because admission policies apply to newly admitted Pods; changing a Namespace label does not retroactively re-admit existing Pods. Verify a negative admission probe is denied when the evidence mount is writable, uses `subPath`, references any PVC other than `factoryos-backup-evidence`, omits the source-level PVC `readOnly: true`, aliases that claim as a writable volume in another regular/init/ephemeral container, or omits the required container security context. Verify the real API Pod is admitted with the exact `FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR` path and matching read-only volume mount. Do not remove the namespace label or binding as a routine workaround.

This admission policy is Kubernetes-specific and requires Kubernetes v1.30 or later. On another Linux deployment platform, implement an equivalent fail-closed workload policy that enforces a read-only bind/volume mount and denies the API identity write/remount privileges; attach the provider's active policy/identity evidence to the production security attestation. If the platform cannot enforce this boundary, do not accept signed backup-copy evidence and do not activate the backup erasure gate. Applying these manifests to a real cluster and verifying its identity/mount configuration remain operator-controlled deployment actions; a successful CI test does not claim they have been applied.

## Admission policy lock for production evidence namespaces

The Pod policy also matches the `pods/ephemeralcontainers` subresource, so adding an ephemeral container is re-evaluated against the evidence-volume rules. A separate cluster-scoped Namespace ValidatingAdmissionPolicy preserves `factoryos.io/backup-evidence-enforcement=required` after a namespace is enrolled and denies ordinary deletion of that namespace. These controls do not prevent a cluster administrator with permission to remove the policy/binding from disabling enforcement; restrict those RBAC permissions and audit changes to the admission objects.

Install both ValidatingAdmissionPolicies and wait for each to become Accepted before installing the bindings. The namespace-lock binding must be active before applying the namespace label; the update that adds the label is allowed, while later ordinary updates must preserve it.

```sh
kubectl apply --server-side --dry-run=server -f deploy/security/backup-copy-evidence-readonly-policy.yaml
kubectl apply --server-side --dry-run=server -f deploy/security/backup-copy-evidence-namespace-lock-policy.yaml
kubectl apply -f deploy/security/backup-copy-evidence-readonly-policy.yaml
kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-readonly --timeout=60s
kubectl apply -f deploy/security/backup-copy-evidence-namespace-lock-policy.yaml
kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-namespace-lock --timeout=60s
kubectl apply --server-side --dry-run=server -f deploy/security/backup-copy-evidence-readonly-binding.yaml
kubectl apply --server-side --dry-run=server -f deploy/security/backup-copy-evidence-namespace-lock-binding.yaml
kubectl apply -f deploy/security/backup-copy-evidence-readonly-binding.yaml
kubectl apply -f deploy/security/backup-copy-evidence-namespace-lock-binding.yaml
kubectl label namespace "$API_NAMESPACE" factoryos.io/backup-evidence-enforcement=required --overwrite
kubectl rollout restart deployment/"$API_DEPLOYMENT" -n "$API_NAMESPACE"
kubectl rollout status deployment/"$API_DEPLOYMENT" -n "$API_NAMESPACE"
```

Test that the `pods/ephemeralcontainers` subresource rejects a writable evidence-volume alias, that namespace label removal and namespace deletion are denied after enrollment, and that initial label enrolment succeeds. Removing the admission policy/binding itself is a privileged cluster-admin change and must be separately controlled.

## Canonical backup copy-class catalog

The signed `copy_class_code` is restricted to the API's required catalog, applied to every requested data category:

- `S3_OBJECT_VERSIONS`
- `POSTGRESQL_BASE_BACKUP`
- `POSTGRESQL_WAL_PITR`
- `REDIS_AOF_BACKUP`
- `REDIS_RDB_BACKUP`
- `FILESYSTEM_SNAPSHOT`
- `BLOCK_VOLUME_SNAPSHOT`
- `MANAGED_BACKUP_VAULT`
- `REPLICA_FAILOVER_COPY`
- `EXTERNAL_DR_COPY`
- `SEARCH_INDEX_COPY`
- `VECTOR_STORE_COPY`
- `LEARNING_ARTIFACT_COPY`
- `EXTERNAL_PROVIDER_COPY`
- `EXTERNAL_CACHE_COPY`
- `UNCLASSIFIED_EXTERNAL_COPY`

The evidence artifact must provide exhaustive discovery scope and completion evidence, not just an inventory of known resources. Identify all relevant accounts/projects/regions/providers/control planes, source APIs and inventory tools, owner identities, query timestamps, pagination/continuation completion, resource counts, direct and indirect writer identities, delayed retries, replication and restore/DR paths. Reconcile every discovered resource to exactly one catalog class. A new or unmapped resource is `UNCLASSIFIED_EXTERNAL_COPY` and must remain `UNRESOLVED` until a reviewed catalog extension and class-specific procedure exists. A `NOT_APPLICABLE` assertion requires signed evidence that every authoritative source in the declared scope was queried successfully and returned no matching resources; missing or inaccessible sources, incomplete pagination, unknown writers or ambiguous ownership are not proof of absence. The API's static catalog and successful CI checks do not independently discover cloud/provider resources.


## External store-kind coverage attestations

The external copy-coverage registry uses a separate v1 schema, `factoryos.external-copy-coverage-evidence-attestation/v1`. Its signed claims bind tenant, category, store kind, disposition, opaque evidence artifact ID and SHA-256 digest, evidence timestamp, data/infrastructure owners, policy reference and reason. Do not reuse a backup `copy_class_code` signature for a `store_kind` decision.

Generate the API body with:

```sh
node scripts/security/sign-external-copy-coverage-evidence.mjs \
  --payload ./external-copy-coverage-request.json \
  --evidence-file ./external-copy-inventory.json \
  --private-key-file ./external-owner-ed25519-private.pem \
  --tenant-id 00000000-0000-4000-8000-000000000001
```

The signer verifies the local artifact digest and rejects URL/path references. The API independently verifies the deployment trust registry and rereads the artifact from the read-only evidence root at submission, ACCEPT review and every propagation preflight, resume, finalization and provider checkpoint. A legacy unsigned external coverage row remains available for audit but cannot be accepted or authorize propagation. The signing key must remain with the evidence owner and must never be deployed to the API process.
