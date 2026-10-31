#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
VALIDATOR="${REPO_ROOT}/scripts/security/validate-backup-copy-evidence-deployment.mjs"
RUNTIME_PROBE="${REPO_ROOT}/scripts/security/probe-backup-copy-evidence-runtime.mjs"
KUBERNETES_VERSION_CHECKER="${REPO_ROOT}/scripts/security/require-supported-kubernetes-version.mjs"
SA_NAME="factoryos-backup-evidence-api"
LABEL_KEY="factoryos.io/backup-evidence-enforcement"
LABEL_VALUE="required"

: "${EXPECTED_KUBE_CONTEXT:?Set EXPECTED_KUBE_CONTEXT to the reviewed production cluster context}"
: "${API_NAMESPACE:?Set API_NAMESPACE to the dedicated API namespace}"
: "${API_DEPLOYMENT:?Set API_DEPLOYMENT to the API Deployment name}"
: "${API_CONTAINER:?Set API_CONTAINER to the API container name}"
: "${CANDIDATE_SHA:?Set CANDIDATE_SHA to the full 40-character release candidate SHA}"

for name in EXPECTED_KUBE_CONTEXT API_NAMESPACE API_DEPLOYMENT API_CONTAINER; do
  value="${!name}"
  [[ "$value" =~ ^[A-Za-z0-9._:/@-]+$ ]] || { echo "Unsafe value for $name" >&2; exit 2; }
done
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "CANDIDATE_SHA must be a full lowercase Git SHA" >&2; exit 2; }
command -v kubectl >/dev/null
command -v node >/dev/null
command -v git >/dev/null
actual_checkout_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[[ "$actual_checkout_sha" == "$CANDIDATE_SHA" ]] || {
  echo "Refusing checkout SHA '$actual_checkout_sha'; expected candidate '$CANDIDATE_SHA'" >&2
  exit 2
}
[[ -f "$VALIDATOR" && -f "$RUNTIME_PROBE" && -f "$KUBERNETES_VERSION_CHECKER" ]] || { echo "Run this script from a complete FactoryOS checkout" >&2; exit 2; }

actual_context="$(kubectl config current-context)"
[[ "$actual_context" == "$EXPECTED_KUBE_CONTEXT" ]] || {
  echo "Refusing cluster context '$actual_context'; expected '$EXPECTED_KUBE_CONTEXT'" >&2
  exit 2
}

kubectl version -o json | node "$KUBERNETES_VERSION_CHECKER"

kubectl get namespace "$API_NAMESPACE" >/dev/null
SA_MANIFEST="$SCRIPT_DIR/backup-copy-evidence-api-service-account.yaml"
POLICY_FILES=(
  "$SCRIPT_DIR/backup-copy-evidence-readonly-policy.yaml"
  "$SCRIPT_DIR/backup-copy-evidence-api-service-account-policy.yaml"
  "$SCRIPT_DIR/backup-copy-evidence-api-token-secret-policy.yaml"
  "$SCRIPT_DIR/backup-copy-evidence-namespace-lock-policy.yaml"
)
BINDING_FILES=(
  "$SCRIPT_DIR/backup-copy-evidence-readonly-binding.yaml"
  "$SCRIPT_DIR/backup-copy-evidence-api-service-account-binding.yaml"
  "$SCRIPT_DIR/backup-copy-evidence-api-token-secret-binding.yaml"
  "$SCRIPT_DIR/backup-copy-evidence-namespace-lock-binding.yaml"
)

echo "Preflighting the dedicated ServiceAccount and admission policies on $EXPECTED_KUBE_CONTEXT"
kubectl apply --server-side --dry-run=server -n "$API_NAMESPACE" -f "$SA_MANIFEST" >/dev/null
for file in "${POLICY_FILES[@]}" "${BINDING_FILES[@]}"; do
  kubectl apply --server-side --dry-run=server -f "$file" >/dev/null
done

kubectl apply -n "$API_NAMESPACE" -f "$SA_MANIFEST" >/dev/null
for file in "${POLICY_FILES[@]}"; do kubectl apply -f "$file" >/dev/null; done

kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-readonly --timeout=90s
kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-api-service-account --timeout=90s
kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-api-token-secret --timeout=90s
kubectl wait --for=condition=Accepted validatingadmissionpolicy/factoryos-backup-evidence-namespace-lock --timeout=90s

for file in "${BINDING_FILES[@]}"; do kubectl apply -f "$file" >/dev/null; done

echo "Validating the preconfigured Deployment, bound PVC, ServiceAccount and current RBAC before namespace enrollment"
preflight_evidence="$(node "$VALIDATOR" --deployment "$API_DEPLOYMENT" --namespace "$API_NAMESPACE" --candidate-sha "$CANDIDATE_SHA")"
printf '%s\n' "$preflight_evidence"

echo "Enrolling namespace in fail-closed evidence admission"
kubectl label namespace "$API_NAMESPACE" "$LABEL_KEY=$LABEL_VALUE" --overwrite
kubectl rollout restart "deployment/$API_DEPLOYMENT" -n "$API_NAMESPACE"
kubectl rollout status "deployment/$API_DEPLOYMENT" -n "$API_NAMESPACE" --timeout=180s

deployment_evidence="$(node "$VALIDATOR" --deployment "$API_DEPLOYMENT" --namespace "$API_NAMESPACE" --candidate-sha "$CANDIDATE_SHA" --require-enrolled --require-ready)"
printf '%s\n' "$deployment_evidence"

echo "Proving the API cannot add a writable init-container alias to the evidence PVC"
if pod_denial="$(kubectl create --dry-run=server -n "$API_NAMESPACE" -f - 2>&1 <<'POD'
apiVersion: v1
kind: Pod
metadata:
  name: factoryos-evidence-negative-writable-alias
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
      image: busybox:1.36
      command: ["sh", "-c", "true"]
      securityContext: &restricted
        runAsNonRoot: true
        runAsUser: 10001
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
          add: []
        seccompProfile:
          type: RuntimeDefault
      volumeMounts:
        - name: evidence
          mountPath: /evidence
          readOnly: false
  containers:
    - name: api
      image: busybox:1.36
      command: ["sh", "-c", "sleep 30"]
      env:
        - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
          value: /evidence
      securityContext: *restricted
      volumeMounts:
        - name: evidence
          mountPath: /evidence
          readOnly: true
POD
)"; then
  echo "Admission unexpectedly accepted a writable evidence PVC alias" >&2
  exit 1
fi
grep -F "The factoryos-backup-evidence PVC must be read-only" <<<"$pod_denial" >/dev/null || {
  echo "Writable-alias negative probe failed for an unexpected reason: $pod_denial" >&2
  exit 1
}

echo "Proving the dedicated ServiceAccount cannot re-enable token automount"
if sa_denial="$(kubectl patch serviceaccount "$SA_NAME" -n "$API_NAMESPACE" --type=merge -p '{"automountServiceAccountToken":true}' --dry-run=server 2>&1)"; then
  echo "Admission unexpectedly enabled ServiceAccount token automount" >&2
  exit 1
fi
grep -F "must keep automountServiceAccountToken=false" <<<"$sa_denial" >/dev/null || {
  echo "ServiceAccount negative probe failed for an unexpected reason: $sa_denial" >&2
  exit 1
}

echo "Proving the namespace rejects legacy ServiceAccount-token Secrets"
if token_secret_denial="$(kubectl create --dry-run=server -n "$API_NAMESPACE" -f - 2>&1 <<'SECRET'
apiVersion: v1
kind: Secret
metadata:
  name: factoryos-evidence-negative-serviceaccount-token
type: kubernetes.io/service-account-token
SECRET
)"; then
  echo "Admission unexpectedly accepted a legacy ServiceAccount-token Secret" >&2
  exit 1
fi
grep -F "ServiceAccount token Secrets are forbidden" <<<"$token_secret_denial" >/dev/null || {
  echo "ServiceAccount-token Secret negative probe failed for an unexpected reason: $token_secret_denial" >&2
  exit 1
}

echo "Proving the Pod admission rejects CAP_SYS_ADMIN"
if capability_denial="$(kubectl create --dry-run=server -n "$API_NAMESPACE" -f - 2>&1 <<'POD'
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
      image: busybox:1.36
      command: ["sh", "-c", "sleep 30"]
      env:
        - name: FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR
          value: /evidence
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
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
)"; then
  echo "Admission unexpectedly accepted CAP_SYS_ADMIN" >&2
  exit 1
fi
grep -F "Every regular, init, and ephemeral container" <<<"$capability_denial" >/dev/null || {
  echo "CAP_SYS_ADMIN negative probe failed for an unexpected reason: $capability_denial" >&2
  exit 1
}

echo "Probing Every Ready API replica inside its own process and mount namespace"
pod_selector="$(kubectl get deployment "$API_DEPLOYMENT" -n "$API_NAMESPACE" -o json | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const selector = JSON.parse(input).spec.selector;
  const labels = selector?.matchLabels ?? {};
  if (Object.keys(labels).length === 0 || (selector.matchExpressions ?? []).length > 0) {
    console.error("Deployment requires a non-empty matchLabels selector without matchExpressions");
    process.exit(1);
  }
  process.stdout.write(Object.entries(labels).map(([key, value]) => key + "=" + value).join(","));
});
')"
api_image_reference="$(node -e 'let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).api_image_reference));' <<< "$deployment_evidence")"
pod_names="$(kubectl get pods -n "$API_NAMESPACE" -l "$pod_selector" -o json | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const pods = JSON.parse(input).items ?? [];
  const ready = pods.filter((pod) =>
    !pod.metadata.deletionTimestamp &&
    pod.status?.phase === "Running" &&
    (pod.status?.conditions ?? []).some((condition) => condition.type === "Ready" && condition.status === "True")
  );
  if (ready.length === 0) {
    console.error("No Ready API Pods match the Deployment selector");
    process.exit(1);
  }
  const expectedSha = process.argv[1];
  const apiContainerName = process.argv[2];
  const expectedImage = process.argv[3];
  const expectedDigest = expectedImage.split("@").at(-1);
  const wrongSha = ready.filter((pod) => pod.metadata.annotations?.["factoryos.io/candidate-sha"] !== expectedSha);
  const wrongImage = ready.filter((pod) => {
    const declared = pod.spec?.containers?.find((container) => container.name === apiContainerName)?.image ?? "";
    const runtimeId = pod.status?.containerStatuses?.find((container) => container.name === apiContainerName)?.imageID ?? "";
    return declared !== expectedImage || !runtimeId.endsWith(expectedDigest);
  });
  if (wrongSha.length > 0 || wrongImage.length > 0) {
    console.error("Ready API Pods do not all match the release SHA and immutable image digest; SHA mismatch: " + wrongSha.map((pod) => pod.metadata.name).join(", ") + "; image mismatch: " + wrongImage.map((pod) => pod.metadata.name).join(", "));
    process.exit(1);
  }
  process.stdout.write(ready.map((pod) => pod.metadata.name).sort().join("\n"));
});
' "$CANDIDATE_SHA" "$API_CONTAINER" "$api_image_reference")"
runtime_records=()
while IFS= read -r pod_name; do
  [[ -n "$pod_name" ]] || continue
  echo "Runtime probe: $pod_name"
  runtime_records+=("$(kubectl exec -i -n "$API_NAMESPACE" "pod/$pod_name" -c "$API_CONTAINER" -- node --input-type=module - < "$RUNTIME_PROBE")")
done <<< "$pod_names"
[[ "${#runtime_records[@]}" -gt 0 ]] || { echo "No API replicas were runtime-probed" >&2; exit 1; }
runtime_evidence="$(printf '%s\n' "${runtime_records[@]}" | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify(input.trim().split("\n").map((line) => JSON.parse(line)))));
')"

operator_identity="$(kubectl auth whoami -o json | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status.userInfo.username))')"
echo "Proving an enrolled namespace cannot remove its enforcement label"
if namespace_label_denial="$(kubectl label namespace "$API_NAMESPACE" "$LABEL_KEY-" --dry-run=server 2>&1)"; then
  echo "Admission unexpectedly allowed removal of the namespace enforcement label" >&2
  exit 1
fi
grep -F "cannot remove its enforcement label" <<<"$namespace_label_denial" >/dev/null || {
  echo "Namespace-lock negative probe failed for an unexpected reason: $namespace_label_denial" >&2
  exit 1
}

evidence_output="${PROVISIONING_EVIDENCE_OUTPUT:-}"
node -e '
const [sha, context, namespace, deployment, container, operator, deploymentSnapshot, runtime] = process.argv.slice(1);
const result = {
  result: "PASS",
  candidate_sha: sha,
  cluster_context: context,
  tested_environment: context,
  namespace,
  deployment,
  api_container: container,
  api_service_account: "factoryos-backup-evidence-api",
  api_image_reference: JSON.parse(deploymentSnapshot).api_image_reference,
  api_image_digest_verified: true,
  operator_identity: operator,
  deployment_snapshot: JSON.parse(deploymentSnapshot),
  runtime: JSON.parse(runtime),
  runtime_write_probe_denied: JSON.parse(runtime).every((probe) => probe.api_write_probe === "DENIED"),
  api_identity_write_denied: JSON.parse(runtime).every((probe) => probe.api_write_probe === "DENIED"),
  api_identity_remount_denied: JSON.parse(runtime).every((probe) => probe.remount_control === "CAP_SYS_ADMIN_ABSENT_AND_NO_NEW_PRIVS"),
  cap_sys_admin_absent: JSON.parse(runtime).every((probe) => probe.cap_sys_admin === "ABSENT"),
  no_new_privileges: JSON.parse(runtime).every((probe) => probe.no_new_privileges === true),
  service_account_token_absent: JSON.parse(runtime).every((probe) => probe.service_account_token === "ABSENT"),
  policy_accepted: JSON.parse(deploymentSnapshot).policy_accepted === true,
  bindings_active: JSON.parse(deploymentSnapshot).bindings_active === true,
  namespace_enrolled: JSON.parse(deploymentSnapshot).namespace_enrolled === true,
  deployment_ready: JSON.parse(deploymentSnapshot).deployment_ready === true,
  pvc_bound_and_read_only: JSON.parse(deploymentSnapshot).pvc_bound_and_read_only === true,
  all_container_security_contexts_verified: JSON.parse(deploymentSnapshot).all_container_security_contexts_verified === true,
  tokenless_service_account: JSON.parse(deploymentSnapshot).tokenless_service_account === true,
  api_identity_rbac_absent: JSON.parse(deploymentSnapshot).api_identity_rbac_absent === true,
  negative_admission_probes_passed: true,
  admission_negative_probes: {
    writable_init_container_alias: "DENIED",
    service_account_token_automount_change: "DENIED",
    service_account_token_secret_creation: "DENIED",
    cap_sys_admin_addition: "DENIED",
    namespace_enforcement_label_removal: "DENIED"
  },
  runtime_probed_pod_count: JSON.parse(runtime).length,
  checked_at_utc: new Date().toISOString(),
  executed_at_utc: new Date().toISOString(),
  independent_infrastructure_review: "NOT_PERFORMED",
  real_provider_staging: "NOT_PERFORMED",
  all_backup_copy_classes: "NOT_ENUMERATED"
};
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
' "$CANDIDATE_SHA" "$EXPECTED_KUBE_CONTEXT" "$API_NAMESPACE" "$API_DEPLOYMENT" "$API_CONTAINER" "$operator_identity" "$deployment_evidence" "$runtime_evidence" | {
  if [[ -n "$evidence_output" ]]; then tee "$evidence_output"; else cat; fi
}

echo "Provisioning probes passed. This is operator-run cluster evidence, not independent review or production release approval."
