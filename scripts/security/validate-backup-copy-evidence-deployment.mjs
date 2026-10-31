#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_SERVICE_ACCOUNT = 'factoryos-backup-evidence-api';
export const EVIDENCE_PVC = 'factoryos-backup-evidence';
export const EVIDENCE_ROOT_ENV = 'FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR';

const fail = (errors, message) => errors.push(message);
const list = (value) => Array.isArray(value) ? value : [];
const labels = (object) => object?.metadata?.labels ?? {};

function containerList(pod) {
  return [
    ...list(pod?.containers),
    ...list(pod?.initContainers),
    ...list(pod?.ephemeralContainers),
  ];
}

function hasEvidenceEnv(container) {
  return list(container?.env).filter((entry) => entry?.name === EVIDENCE_ROOT_ENV);
}

function isSafeAbsolutePath(value) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    value !== '/' &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r') &&
    path.posix.normalize(value) === value;
}

function isSafeContainer(container) {
  const security = container?.securityContext;
  const capabilities = security?.capabilities;
  const dropped = list(capabilities?.drop);
  const added = list(capabilities?.add);
  return security?.runAsNonRoot === true &&
    Number.isSafeInteger(security?.runAsUser) &&
    security.runAsUser > 0 &&
    security?.allowPrivilegeEscalation === false &&
    security?.readOnlyRootFilesystem === true &&
    security?.privileged !== true &&
    dropped.includes('ALL') &&
    added.length === 0 &&
    security?.procMount !== 'Unmasked' &&
    security?.seccompProfile?.type === 'RuntimeDefault';
}

function referencedSecretNames(volumes, containers) {
  const names = new Set();
  for (const volume of list(volumes)) {
    if (volume?.secret?.secretName) names.add(volume.secret.secretName);
    for (const source of list(volume?.projected?.sources)) {
      if (source?.secret?.name) names.add(source.secret.name);
    }
  }
  for (const container of list(containers)) {
    for (const item of list(container?.envFrom)) {
      if (item?.secretRef?.name) names.add(item.secretRef.name);
    }
    for (const item of list(container?.env)) {
      const secretName = item?.valueFrom?.secretKeyRef?.name;
      if (secretName) names.add(secretName);
    }
  }
  return names;
}

function bindingTargetsApiIdentity(binding, namespace) {
  const protectedUser = 'system:serviceaccount:' + namespace + ':' + API_SERVICE_ACCOUNT;
  const protectedGroups = new Set(['system:serviceaccounts', 'system:serviceaccounts:' + namespace]);
  return list(binding?.subjects).some((subject) => (
    (subject?.kind === 'ServiceAccount' &&
      subject?.name === API_SERVICE_ACCOUNT &&
      (subject?.namespace ?? binding?.metadata?.namespace) === namespace) ||
    (subject?.kind === 'User' && subject?.name === protectedUser) ||
    (subject?.kind === 'Group' && protectedGroups.has(subject?.name))
  ));
}

/**
 * Validate the desired Deployment and the live Kubernetes objects returned by
 * the operator's read-only kubectl snapshot. This does not attest the storage
 * control plane or protect against a privileged host/storage administrator.
 */
export function validateProvisioningSnapshot(snapshot, options = {}) {
  const errors = [];
  const deployment = snapshot?.deployment;
  const pod = deployment?.spec?.template?.spec;
  const namespace = options.namespace ?? deployment?.metadata?.namespace ?? '';
  const serviceAccount = snapshot?.serviceAccount;
  const pvc = snapshot?.pvc;
  const namespaceObject = snapshot?.namespace;

  if (!deployment || !pod || !namespace) {
    fail(errors, 'Deployment, Pod template, and namespace are required');
    return errors;
  }

  if (deployment?.metadata?.namespace !== namespace) {
    fail(errors, 'Deployment must belong to the requested API namespace');
  }
  if (options.candidateSha) {
    const deploymentSha = deployment?.spec?.template?.metadata?.annotations?.['factoryos.io/candidate-sha'];
    if (deploymentSha !== options.candidateSha) {
      fail(errors, 'Deployment Pod template factoryos.io/candidate-sha must match the immutable release candidate');
    }
  }
  const selector = deployment?.spec?.selector;
  const selectorLabels = selector?.matchLabels ?? {};
  if (Object.keys(selectorLabels).length === 0 || list(selector?.matchExpressions).length > 0) {
    fail(errors, 'Deployment must have a non-empty matchLabels selector without matchExpressions for complete replica probing');
  }
  for (const [key, value] of Object.entries(selectorLabels)) {
    if (deployment?.spec?.template?.metadata?.labels?.[key] !== value) {
      fail(errors, 'Deployment Pod-template labels must satisfy selector ' + key + '=' + value);
    }
  }
  if (pod.serviceAccountName !== API_SERVICE_ACCOUNT) {
    fail(errors, 'Deployment must use the dedicated ' + API_SERVICE_ACCOUNT + ' ServiceAccount');
  }
  if (pod.automountServiceAccountToken !== false) {
    fail(errors, 'Pod automountServiceAccountToken must be explicitly false');
  }
  for (const key of ['hostPID', 'hostIPC', 'hostNetwork', 'shareProcessNamespace']) {
    if (pod[key] === true) fail(errors, 'Pod ' + key + ' must not be enabled');
  }

  if (!serviceAccount || serviceAccount?.metadata?.name !== API_SERVICE_ACCOUNT ||
      serviceAccount?.automountServiceAccountToken !== false) {
    fail(errors, 'The dedicated ServiceAccount must exist and explicitly disable token automount');
  }
  if (options.requireEnrolled && labels(namespaceObject)['factoryos.io/backup-evidence-enforcement'] !== 'required') {
    fail(errors, 'API namespace is not enrolled in backup-evidence enforcement');
  }

  const requiredPolicies = [
    'factoryos-backup-evidence-readonly',
    'factoryos-backup-evidence-api-service-account',
    'factoryos-backup-evidence-api-token-secret',
    'factoryos-backup-evidence-namespace-lock',
  ];
  const requiredBindings = [
    ['factoryos-backup-evidence-readonly', 'factoryos-backup-evidence-readonly', true],
    ['factoryos-backup-evidence-api-service-account', 'factoryos-backup-evidence-api-service-account', true],
    ['factoryos-backup-evidence-api-token-secret', 'factoryos-backup-evidence-api-token-secret', true],
    ['factoryos-backup-evidence-namespace-lock', 'factoryos-backup-evidence-namespace-lock', false],
  ];
  const policyItems = list(snapshot?.policies?.items);
  for (const name of requiredPolicies) {
    const policy = policyItems.find((item) => item?.metadata?.name === name);
    const accepted = list(policy?.status?.conditions).some((condition) =>
      condition?.type === 'Accepted' && condition?.status === 'True');
    if (!accepted) fail(errors, 'Required ValidatingAdmissionPolicy is missing or not Accepted: ' + name);
  }
  const bindingItems = list(snapshot?.policyBindings?.items);
  for (const [name, policyName, namespaceScoped] of requiredBindings) {
    const binding = bindingItems.find((item) => item?.metadata?.name === name);
    const selector = binding?.spec?.matchResources?.namespaceSelector?.matchLabels;
    if (!binding || binding?.spec?.policyName !== policyName ||
        !list(binding?.spec?.validationActions).includes('Deny') ||
        (namespaceScoped && selector?.['factoryos.io/backup-evidence-enforcement'] !== 'required') ||
        (!namespaceScoped && binding?.spec?.matchResources?.namespaceSelector)) {
      fail(errors, 'Required Deny ValidatingAdmissionPolicyBinding is missing or misconfigured: ' + name);
    }
  }

  const volumes = list(pod.volumes);
  const evidenceVolumes = volumes.filter((volume) =>
    volume?.persistentVolumeClaim?.claimName === EVIDENCE_PVC);
  if (evidenceVolumes.length !== 1) {
    fail(errors, 'Pod must reference exactly one ' + EVIDENCE_PVC + ' PVC volume');
  }
  const evidenceVolume = evidenceVolumes[0];
  if (evidenceVolume && evidenceVolume.persistentVolumeClaim.readOnly !== true) {
    fail(errors, 'Evidence PVC source must set persistentVolumeClaim.readOnly=true');
  }
  if (volumes.some((volume) => Boolean(volume?.hostPath))) {
    fail(errors, 'hostPath volumes are forbidden in the evidence API Pod');
  }
  if (volumes.some((volume) =>
    list(volume?.projected?.sources).some((source) => Boolean(source?.serviceAccountToken)))) {
    fail(errors, 'Projected ServiceAccount token volumes are forbidden');
  }
  if (!pvc || pvc?.metadata?.name !== EVIDENCE_PVC ||
      pvc?.status?.phase !== 'Bound' ||
      !pvc?.spec?.volumeName ||
      (pvc?.spec?.volumeMode && pvc.spec.volumeMode !== 'Filesystem')) {
    fail(errors, 'Evidence PVC must exist, be Bound, resolve to a backing volume, and use Filesystem mode');
  }

  const regularContainers = list(pod.containers);
  const configured = regularContainers.filter((container) => hasEvidenceEnv(container).length > 0);
  if (configured.length !== 1 || hasEvidenceEnv(configured[0]).length !== 1) {
    fail(errors, 'Exactly one regular API container must define ' + EVIDENCE_ROOT_ENV);
  }
  const rootValue = hasEvidenceEnv(configured[0] ?? {})[0]?.value;
  if (!isSafeAbsolutePath(rootValue)) {
    fail(errors, EVIDENCE_ROOT_ENV + ' must be a normalized, non-root absolute POSIX path');
  }
  const apiImageReference = configured[0]?.image;
  if (typeof apiImageReference !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/.test(apiImageReference)) {
    fail(errors, 'The API image must be pinned to an immutable sha256 digest');
  }

  if (configured.length === 1 && isSafeAbsolutePath(rootValue) && evidenceVolume) {
    const rootMounts = list(configured[0].volumeMounts).filter((mount) => mount?.mountPath === rootValue);
    if (rootMounts.length !== 1) {
      fail(errors, 'The evidence root must map to exactly one container volumeMount');
    } else {
      const mount = rootMounts[0];
      if (mount.name !== evidenceVolume.name || mount.readOnly !== true ||
          mount.subPath !== undefined || mount.subPathExpr !== undefined ||
          (mount.mountPropagation !== undefined && mount.mountPropagation !== 'None')) {
        fail(errors, 'Evidence root mount must use the dedicated PVC read-only, without subPath or mount propagation');
      }
    }
  }

  for (const container of containerList(pod)) {
    if (!isSafeContainer(container)) {
      fail(errors, 'Every regular, init, and ephemeral container must be non-root, read-only-rootfs, no-escalation, drop ALL capabilities, add none, use RuntimeDefault seccomp, and avoid Unmasked proc');
    }
    if (evidenceVolume && list(container?.volumeDevices).some((device) => device?.name === evidenceVolume.name)) {
      fail(errors, 'Block-device use of the evidence PVC is forbidden');
    }
    if (evidenceVolume) {
      for (const mount of list(container?.volumeMounts).filter((entry) => entry?.name === evidenceVolume.name)) {
        if (mount.readOnly !== true || mount.subPath !== undefined || mount.subPathExpr !== undefined ||
            (mount.mountPropagation !== undefined && mount.mountPropagation !== 'None')) {
          fail(errors, 'Every alias of the evidence PVC must be read-only and must not use subPath');
        }
      }
    }
  }

  const legacyTokenSecrets = list(snapshot?.secrets?.items)
    .filter((secret) => secret?.type === 'kubernetes.io/service-account-token' ||
      Boolean(secret?.metadata?.annotations?.['kubernetes.io/service-account.name']));
  for (const secret of legacyTokenSecrets) {
    fail(errors, 'Legacy Kubernetes ServiceAccount token Secret exists in the dedicated API namespace: ' + secret.metadata?.name);
  }

  for (const binding of list(snapshot?.roleBindings?.items)) {
    if (bindingTargetsApiIdentity(binding, namespace)) {
      fail(errors, 'A namespace RoleBinding grants roles to the evidence API ServiceAccount or its ServiceAccount groups: ' + binding.metadata?.name);
    }
  }
  for (const binding of list(snapshot?.clusterRoleBindings?.items)) {
    if (bindingTargetsApiIdentity(binding, namespace)) {
      fail(errors, 'A ClusterRoleBinding grants roles to the evidence API ServiceAccount or its ServiceAccount groups: ' + binding.metadata?.name);
    }
  }

  if (options.requireReady) {
    const desired = deployment?.spec?.replicas ?? 1;
    const status = deployment?.status ?? {};
    const ready = status.readyReplicas ?? 0;
    const available = status.availableReplicas ?? 0;
    const updated = status.updatedReplicas ?? 0;
    const observed = status.observedGeneration ?? 0;
    const generation = deployment?.metadata?.generation ?? 0;
    if (ready < desired || available < desired || updated < desired || observed < generation) {
      fail(errors, 'Deployment is not fully updated, observed, available and ready after policy re-admission');
    }
  }

  return [...new Set(errors)];
}

function kubectlJson(args) {
  const result = spawnSync('kubectl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('kubectl ' + args.join(' ') + ' failed: ' + (result.stderr || result.stdout).trim());
  return JSON.parse(result.stdout);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--require-ready' || key === '--require-enrolled') result[key.slice(2)] = true;
    else if (key.startsWith('--') && argv[i + 1]) result[key.slice(2)] = argv[++i];
    else throw new Error('Unexpected argument: ' + key);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.deployment || !args.namespace || !/^[0-9a-f]{40}$/.test(args['candidate-sha'] ?? '')) {
    throw new Error('Usage: validate-backup-copy-evidence-deployment.mjs --deployment NAME --namespace NAMESPACE --candidate-sha FULL_SHA [--require-ready] [--require-enrolled]');
  }
  const ns = args.namespace;
  const snapshot = {
    deployment: kubectlJson(['get', 'deployment', args.deployment, '-n', ns, '-o', 'json']),
    serviceAccount: kubectlJson(['get', 'serviceaccount', API_SERVICE_ACCOUNT, '-n', ns, '-o', 'json']),
    pvc: kubectlJson(['get', 'pvc', EVIDENCE_PVC, '-n', ns, '-o', 'json']),
    namespace: kubectlJson(['get', 'namespace', ns, '-o', 'json']),
    policies: kubectlJson(['get', 'validatingadmissionpolicies', '-o', 'json']),
    policyBindings: kubectlJson(['get', 'validatingadmissionpolicybindings', '-o', 'json']),
    roleBindings: kubectlJson(['get', 'rolebindings', '--all-namespaces', '-o', 'json']),
    clusterRoleBindings: kubectlJson(['get', 'clusterrolebindings', '-o', 'json']),
    secrets: kubectlJson(['get', 'secrets', '-n', ns, '-o', 'json']),
  };
  const errors = validateProvisioningSnapshot(snapshot, {
    namespace: ns,
    requireReady: Boolean(args['require-ready']),
    requireEnrolled: Boolean(args['require-enrolled']),
    candidateSha: args['candidate-sha'],
  });
  if (errors.length) {
    for (const error of errors) console.error('BLOCKED: ' + error);
    process.exitCode = 1;
    return;
  }
  const apiImageReference = snapshot.deployment.spec.template.spec.containers.find((container) =>
    list(container.env).some((variable) => variable.name === EVIDENCE_ROOT_ENV))?.image ?? '';
  console.log(JSON.stringify({
    result: 'PASS',
    deployment: args.deployment,
    namespace: ns,
    candidate_sha: args['candidate-sha'],
    api_image_reference: apiImageReference,
    api_image_spec_pinned: true,
    service_account: API_SERVICE_ACCOUNT,
    evidence_pvc: EVIDENCE_PVC,
    ready_replicas: snapshot.deployment.status?.readyReplicas ?? 0,
    namespace_enrolled: labels(snapshot.namespace)['factoryos.io/backup-evidence-enforcement'] === 'required',
    policy_accepted: true,
    bindings_active: true,
    deployment_ready: (snapshot.deployment.status?.readyReplicas ?? 0) >= (snapshot.deployment.spec?.replicas ?? 1),
    pvc_bound_and_read_only: snapshot.pvc.status?.phase === 'Bound' && snapshot.deployment.spec.template.spec.volumes.some((volume) => volume?.persistentVolumeClaim?.claimName === EVIDENCE_PVC && volume.persistentVolumeClaim.readOnly === true),
    all_container_security_contexts_verified: true,
    tokenless_service_account: snapshot.serviceAccount.automountServiceAccountToken === false && snapshot.deployment.spec.template.spec.automountServiceAccountToken === false,
    api_identity_rbac_absent: true,
    service_account_token_absent: true,
    checked_at_utc: new Date().toISOString(),
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('BLOCKED: ' + error.message);
    process.exitCode = 1;
  });
}
