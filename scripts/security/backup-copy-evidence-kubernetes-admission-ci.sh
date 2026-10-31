#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy/security"
VERSION_CHECKER="$SCRIPT_DIR/require-supported-kubernetes-version.mjs"
NAMESPACE="factoryos-backup-evidence-ci"
LABEL_KEY="factoryos.io/backup-evidence-enforcement"
LABEL_VALUE="required"
POD_NAME="factoryos-evidence-admission-positive"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

for command_name in kubectl node; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 2; }
done
[[ -f "$VERSION_CHECKER" ]] || { echo "Missing Kubernetes version checker" >&2; exit 2; }

echo "Checking the actual Kubernetes API server version"
kubectl version -o json | node "$VERSION_CHECKER"

echo "Creating an isolated namespace and installing the four fail-closed policies"
kubectl create namespace "$NAMESPACE" >/dev/null
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-api-service-account-policy.yaml"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-api-token-secret-policy.yaml"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-readonly-policy.yaml"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-namespace-lock-policy.yaml"

POLICY_STATUS_CHECKER="$SCRIPT_DIR/validate-kubernetes-admission-policy-status.mjs"
[[ -f "$POLICY_STATUS_CHECKER" ]] || { echo "Missing admission-policy status verifier" >&2; exit 2; }

for policy_name in \
  factoryos-backup-evidence-readonly \
  factoryos-backup-evidence-api-service-account \
  factoryos-backup-evidence-api-token-secret \
  factoryos-backup-evidence-namespace-lock; do
  generation="$(kubectl get validatingadmissionpolicy "$policy_name" -o jsonpath='{.metadata.generation}')"
  if ! kubectl wait --for=jsonpath='{.status.observedGeneration}'="$generation" "validatingadmissionpolicy/$policy_name" --timeout=120s; then
    echo "ValidatingAdmissionPolicy did not observe the current generation: $policy_name" >&2
    kubectl get validatingadmissionpolicy "$policy_name" -o yaml >&2 || true
    exit 1
  fi
  if ! kubectl get validatingadmissionpolicy "$policy_name" -o json | node "$POLICY_STATUS_CHECKER"; then
    echo "ValidatingAdmissionPolicy CEL type-check did not pass: $policy_name" >&2
    kubectl get validatingadmissionpolicy "$policy_name" -o yaml >&2 || true
    exit 1
  fi
done

echo "Activating Deny bindings before enrolling the namespace"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-readonly-binding.yaml"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-api-service-account-binding.yaml"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-api-token-secret-binding.yaml"
kubectl apply -f "$DEPLOY_DIR/backup-copy-evidence-namespace-lock-binding.yaml"
kubectl label namespace "$NAMESPACE" "$LABEL_KEY=$LABEL_VALUE"
kubectl apply -n "$NAMESPACE" -f "$DEPLOY_DIR/backup-copy-evidence-api-service-account.yaml"

expect_denied() {
  local description="$1"
  local expected_message="$2"
  shift 2
  local output
  if output="$("$@" 2>&1)"; then
    echo "Admission unexpectedly ALLOWED: $description" >&2
    exit 1
  fi
  if ! grep -F "$expected_message" <<<"$output" >/dev/null; then
    echo "Admission denied for an unexpected reason: $description" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "PASS — denied $description"
}

cat > "$WORK_DIR/valid-pod.yaml" <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: factoryos-evidence-admission-positive
spec:
  serviceAccountName: factoryos-backup-evidence-api
  automountServiceAccountToken: false
  volumes:
    - name: evidence
      persistentVolumeClaim:
        claimName: factoryos-backup-evidence
        readOnly: true
  containers:
    - name: api
      image: registry.k8s.io/pause:3.10
      env:
        - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
          value: /evidence
      securityContext: &restricted
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
      volumeMounts:
        - name: evidence
          mountPath: /evidence
          readOnly: true
POD

cat > "$WORK_DIR/writable-init-pod.yaml" <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: factoryos-evidence-negative-writable-init
spec:
  serviceAccountName: factoryos-backup-evidence-api
  automountServiceAccountToken: false
  volumes:
    - name: evidence
      persistentVolumeClaim:
        claimName: factoryos-backup-evidence
        readOnly: true
  initContainers:
    - name: writable-alias
      image: registry.k8s.io/pause:3.10
      securityContext: &restricted
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
      volumeMounts:
        - name: evidence
          mountPath: /evidence-init
          readOnly: false
  containers:
    - name: api
      image: registry.k8s.io/pause:3.10
      env:
        - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
          value: /evidence
      securityContext: *restricted
      volumeMounts:
        - name: evidence
          mountPath: /evidence
          readOnly: true
POD

cat > "$WORK_DIR/unsafe-capability-pod.yaml" <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: factoryos-evidence-negative-cap-sys-admin
spec:
  serviceAccountName: factoryos-backup-evidence-api
  automountServiceAccountToken: false
  volumes:
    - name: evidence
      persistentVolumeClaim:
        claimName: factoryos-backup-evidence
        readOnly: true
  containers:
    - name: api
      image: registry.k8s.io/pause:3.10
      env:
        - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
          value: /evidence
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        privileged: false
        capabilities:
          drop: ["ALL"]
          add: ["SYS_ADMIN"]
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: evidence
          mountPath: /evidence
          readOnly: true
POD

cat > "$WORK_DIR/token-automount-pod.yaml" <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: factoryos-evidence-negative-token-automount
spec:
  serviceAccountName: factoryos-backup-evidence-api
  automountServiceAccountToken: true
  volumes:
    - name: evidence
      persistentVolumeClaim:
        claimName: factoryos-backup-evidence
        readOnly: true
  containers:
    - name: api
      image: registry.k8s.io/pause:3.10
      env:
        - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
          value: /evidence
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
      volumeMounts:
        - name: evidence
          mountPath: /evidence
          readOnly: true
POD

echo "Positive control: the valid read-only Pod must pass server-side admission"
kubectl create --dry-run=server -n "$NAMESPACE" -f "$WORK_DIR/valid-pod.yaml" >/dev/null

expect_denied \
  "writable init-container alias" \
  "The factoryos-backup-evidence PVC must be read-only" \
  kubectl create --dry-run=server -n "$NAMESPACE" -f "$WORK_DIR/writable-init-pod.yaml"

expect_denied \
  "CAP_SYS_ADMIN in an API container" \
  "Every regular, init, and ephemeral container" \
  kubectl create --dry-run=server -n "$NAMESPACE" -f "$WORK_DIR/unsafe-capability-pod.yaml"

expect_denied \
  "Pod-level ServiceAccount token automount" \
  "The evidence API Pod must use the dedicated token-disabled ServiceAccount" \
  kubectl create --dry-run=server -n "$NAMESPACE" -f "$WORK_DIR/token-automount-pod.yaml"

expect_denied \
  "ServiceAccount token automount re-enablement" \
  "must keep automountServiceAccountToken=false" \
  kubectl patch serviceaccount factoryos-backup-evidence-api -n "$NAMESPACE" --type=merge -p '{"automountServiceAccountToken":true}' --dry-run=server

expect_denied \
  "deletion of the dedicated API ServiceAccount" \
  "must keep automountServiceAccountToken=false" \
  kubectl delete serviceaccount factoryos-backup-evidence-api -n "$NAMESPACE" --dry-run=server

cat > "$WORK_DIR/legacy-token-secret.yaml" <<'SECRET'
apiVersion: v1
kind: Secret
metadata:
  name: factoryos-evidence-negative-token
type: kubernetes.io/service-account-token
SECRET

expect_denied \
  "legacy ServiceAccount-token Secret creation" \
  "ServiceAccount token Secrets are forbidden" \
  kubectl create --dry-run=server -n "$NAMESPACE" -f "$WORK_DIR/legacy-token-secret.yaml"

echo "Persisting one valid Pod so the pods/ephemeralcontainers subresource can be exercised"
kubectl create -n "$NAMESPACE" -f "$WORK_DIR/valid-pod.yaml" >/dev/null

ephemeral_capability='{"spec":{"ephemeralContainers":[{"name":"debug-capability","image":"registry.k8s.io/pause:3.10","targetContainerName":"api","securityContext":{"runAsNonRoot":true,"runAsUser":10001,"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"privileged":false,"capabilities":{"drop":["ALL"],"add":["SYS_ADMIN"]},"seccompProfile":{"type":"RuntimeDefault"}}}]}}'
expect_denied \
  "CAP_SYS_ADMIN added through pods/ephemeralcontainers" \
  "Every regular, init, and ephemeral container" \
  kubectl patch pod "$POD_NAME" -n "$NAMESPACE" --subresource=ephemeralcontainers --type=merge --patch "$ephemeral_capability" --dry-run=server

ephemeral_writable='{"spec":{"ephemeralContainers":[{"name":"debug-writable","image":"registry.k8s.io/pause:3.10","targetContainerName":"api","securityContext":{"runAsNonRoot":true,"runAsUser":10001,"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"privileged":false,"capabilities":{"drop":["ALL"],"add":[]},"seccompProfile":{"type":"RuntimeDefault"}},"volumeMounts":[{"name":"evidence","mountPath":"/evidence-debug","readOnly":false}]}]}}'
expect_denied \
  "writable evidence mount through pods/ephemeralcontainers" \
  "The factoryos-backup-evidence PVC must be read-only" \
  kubectl patch pod "$POD_NAME" -n "$NAMESPACE" --subresource=ephemeralcontainers --type=merge --patch "$ephemeral_writable" --dry-run=server

expect_denied \
  "namespace enforcement-label removal" \
  "cannot remove its enforcement label" \
  kubectl label namespace "$NAMESPACE" "$LABEL_KEY-" --dry-run=server

expect_denied \
  "ordinary deletion of an enrolled namespace" \
  "cannot remove its enforcement label" \
  kubectl delete namespace "$NAMESPACE" --dry-run=server

echo "PASS — Kubernetes API server accepted the policies and enforced all positive/negative admission cases."
