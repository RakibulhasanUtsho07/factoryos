# Backup evidence volume deployment provisioning

This procedure turns the repository admission policy into an operator-executed deployment control. It does **not** claim that a production cluster has already been changed.

## Required workload shape

The evidence API must run in a dedicated namespace and use the `factoryos-backup-evidence-api` ServiceAccount. Configure the existing API Deployment before running the provisioner; the script intentionally refuses to rewrite an unknown workload template.

The Pod template must include:

- `serviceAccountName: factoryos-backup-evidence-api` and explicit `automountServiceAccountToken: false`.
- A pre-provisioned, same-namespace PVC named `factoryos-backup-evidence`, in `Bound` state and `Filesystem` volume mode.
- The API image is pinned to an immutable `@sha256:<64-hex-digest>` reference; the Deployment template carries the exact `factoryos.io/candidate-sha` annotation. Every Ready Pod must report the same declared image and runtime `imageID` digest.
- Exactly one regular container defining `FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR`; its value is a normalized absolute non-root path and maps to exactly one `readOnly: true` volumeMount of that PVC. The Pod PVC source also sets `readOnly: true`.
- No `hostPath`, host PID/IPC/network namespaces, shared process namespace, projected ServiceAccount token, or mounted legacy ServiceAccount-token Secret.
- Every regular, init and ephemeral container runs as a non-root UID, has `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `privileged: false`, drops `ALL` capabilities, adds none, uses `RuntimeDefault` seccomp, and does not use an unmasked proc mount.
- No init, sidecar or ephemeral container may mount the evidence PVC writable or expose it as a block device.

Example API container fragment (merge into the existing Deployment; preserve application-specific ports, probes, resources and configuration):

```yaml
spec:
  template:
    metadata:
      annotations:
        factoryos.io/candidate-sha: 0000000000000000000000000000000000000000 # replace with the actual full SHA
    spec:
      serviceAccountName: factoryos-backup-evidence-api
      automountServiceAccountToken: false
      volumes:
        - name: backup-evidence
          persistentVolumeClaim:
            claimName: factoryos-backup-evidence
            readOnly: true
      containers:
        - name: api
          image: ghcr.io/REPLACE_WITH_APPROVED_IMAGE@sha256:REPLACE_WITH_64_HEX_DIGEST
          env:
            - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
              value: /var/run/factoryos/backup-evidence
          volumeMounts:
            - name: backup-evidence
              mountPath: /var/run/factoryos/backup-evidence
              readOnly: true
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            privileged: false
            capabilities:
              drop: ["ALL"]
              add: []
            seccompProfile:
              type: RuntimeDefault
```

Keep the API namespace dedicated to workloads that comply with this baseline. Move evidence publishers and sidecars with different identity or volume needs to separate namespaces. The publisher stages immutable artifacts before the PVC is mounted read-only into the API workload; it must not use the API ServiceAccount.

## Operator provisioning

Run from a reviewed FactoryOS checkout using a cluster-admin or equivalent infrastructure provisioning identity. The provisioner installs cluster-scoped admission policy, creates/locks the API ServiceAccount, locks out legacy ServiceAccount-token Secrets, enrolls the namespace, restarts/re-admits the API Deployment, performs server-side negative admission probes, and executes the runtime probe inside every Ready API replica.

The provisioner checks the current kube context against an explicit expected value, requires the local Git checkout to equal `CANDIDATE_SHA`, requires the Deployment Pod-template annotation and every Ready API Pod to carry that candidate SHA, verifies an immutable sha256-pinned API image and each Pod's runtime `imageID`, and refuses Kubernetes servers older than v1.30. It does not create a storage-class-specific PVC: the infrastructure owner must first provision the approved backing volume/PVC and verify the provider's encryption, retention, restore, backup and IAM behavior.

```sh
EXPECTED_KUBE_CONTEXT=prod-eu-1 \
API_NAMESPACE=factoryos-api \
API_DEPLOYMENT=factoryos-api \
API_CONTAINER=api \
CANDIDATE_SHA="$(git rev-parse HEAD)" \
PROVISIONING_EVIDENCE_OUTPUT=./backup-evidence-provisioning.json \
./deploy/security/provision-backup-copy-evidence-enforcement.sh
```

The script performs server-side dry-runs, applies each policy, waits for each ValidatingAdmissionPolicy to report Accepted, installs Deny bindings and the namespace lock before setting the enrollment label, rolls out/re-admits Pods, and re-reads live Deployment/PVC/ServiceAccount/namespace/RBAC state. It then verifies that a writable init-container alias, CAP_SYS_ADMIN addition, token automount re-enablement, legacy token-Secret creation and namespace-label removal are denied, and runs the mount/write/capability/token probe inside each running API replica.

The JSON output is operator-run evidence bound to the supplied candidate SHA. It is not an independent review and does not prove that the storage control plane is immutable. Store the JSON in the approved evidence vault, authenticate its provenance, and have a separate infrastructure reviewer complete the `deployment_provisioning.independent_review` section of the production security attestation.

## Admission control and privileged boundary

The read-only Pod policy applies to Pods and `pods/ephemeralcontainers` in the enrolled namespace. A dedicated ServiceAccount admission policy keeps token automount disabled and prevents ordinary deletion; a token-Secret policy prevents creation or mutation of legacy `kubernetes.io/service-account-token` Secrets in that namespace. Namespace lock policy preserves the enrollment label and denies ordinary namespace deletion.

Cluster-admin/RBAC protection is still required for the ValidatingAdmissionPolicies and bindings themselves, storage-class/PVC administration, node configuration, CSI control-plane actions, and underlying object/block storage. A privileged host or storage administrator can alter mount state or source bytes outside the API identity boundary; the application runtime check does not claim to defend against that actor. Restrict and audit those administrative permissions independently.

Kubernetes volume `readOnly: true` is a per-mount property, not a global storage-control-plane guarantee. Recursive submount behavior also depends on the actual node/kernel/CSI combination. The application independently verifies the deepest covering Linux mount as read-only for the evidence root and exact files; this provisioner additionally denies the API's write attempt and checks that it runs without `CAP_SYS_ADMIN` and with `NoNewPrivs`. Neither check replaces an independent infrastructure review.

## Release requirements that remain separate

- Real-provider staging is still required for the S3 writer fence, policy deny/read-back, CopyObject, multipart completion, replication/delete markers, policy races, crash recovery, delayed writers, tombstone replay, residual listing and restore.
- Complete inventory of writer principals and every backup/copy class remains open, including PostgreSQL WAL/PITR, Redis persistence backups, filesystem/block snapshots, backup vaults, replicas/failover, external DR, search/vector stores, learning artifacts and external caches.
- A separate reviewer must authenticate the evidence and inspect the deployed cluster, CSI/storage policy, host/storage-admin boundary, role assignments and audit logs.
- Any later deployment or candidate SHA requires a fresh provisioning run and a new candidate-bound attestation.

Until these checks are performed against the real target environment, AS-137 / NFR-PROD-14 remain **PARTIAL** and this work must not be treated as production release approval.
