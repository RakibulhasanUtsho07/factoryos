import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateProvisioningSnapshot } from './validate-backup-copy-evidence-deployment.mjs';

const root = new URL('../../', import.meta.url);
const SA = 'factoryos-backup-evidence-api';
const PVC = 'factoryos-backup-evidence';
const namespace = 'factoryos-api';

function secureContext() {
  return {
    runAsNonRoot: true,
    runAsUser: 10001,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    privileged: false,
    capabilities: { drop: ['ALL'], add: [] },
    seccompProfile: { type: 'RuntimeDefault' },
  };
}
function snapshot() {
  return {
    namespace: { metadata: { name: namespace, labels: { 'factoryos.io/backup-evidence-enforcement': 'required' } } },
    policies: { items: [
      'factoryos-backup-evidence-readonly',
      'factoryos-backup-evidence-api-service-account',
      'factoryos-backup-evidence-api-token-secret',
      'factoryos-backup-evidence-namespace-lock',
    ].map((name) => ({ metadata: { name }, status: { conditions: [{ type: 'Accepted', status: 'True' }] } })) },
    policyBindings: { items: [
      ['factoryos-backup-evidence-readonly', true],
      ['factoryos-backup-evidence-api-service-account', true],
      ['factoryos-backup-evidence-api-token-secret', true],
      ['factoryos-backup-evidence-namespace-lock', false],
    ].map(([name, scoped]) => ({
      metadata: { name },
      spec: {
        policyName: name,
        validationActions: ['Deny'],
        matchResources: scoped ? { namespaceSelector: { matchLabels: { 'factoryos.io/backup-evidence-enforcement': 'required' } } } : {},
      },
    })) },
    serviceAccount: { metadata: { name: SA }, automountServiceAccountToken: false },
    pvc: { metadata: { name: PVC }, status: { phase: 'Bound' }, spec: { volumeName: 'pvc-vol-1', volumeMode: 'Filesystem' } },
    deployment: {
      metadata: { name: 'factoryos-api', namespace, generation: 1 },
      spec: { replicas: 1, selector: { matchLabels: { app: 'factoryos-api' } }, template: { metadata: { labels: { app: 'factoryos-api' }, annotations: { 'factoryos.io/candidate-sha': 'a'.repeat(40) } }, spec: {
        serviceAccountName: SA,
        automountServiceAccountToken: false,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        volumes: [{ name: 'evidence', persistentVolumeClaim: { claimName: PVC, readOnly: true } }],
        initContainers: [],
        ephemeralContainers: [],
        containers: [{
          name: 'api',
          image: 'ghcr.io/rakibulhasanutsho07/factoryos-api@sha256:' + 'a'.repeat(64),
          env: [{ name: 'FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR', value: '/var/run/factoryos/backup-evidence' }],
          securityContext: secureContext(),
          volumeMounts: [{ name: 'evidence', mountPath: '/var/run/factoryos/backup-evidence', readOnly: true }],
        }],
      } } },
      status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1, observedGeneration: 1 },
    },
    roleBindings: { items: [] },
    clusterRoleBindings: { items: [] },
    secrets: { items: [] },
  };
}

test('accepts a fully provisioned, tokenless, read-only evidence workload', () => {
  assert.deepEqual(validateProvisioningSnapshot(snapshot(), { namespace, requireReady: true, requireEnrolled: true, candidateSha: 'a'.repeat(40) }), []);
  const wrongCandidate = snapshot();
  assert.ok(validateProvisioningSnapshot(wrongCandidate, { namespace, candidateSha: 'b'.repeat(40) }).some((error) => error.includes('factoryos.io/candidate-sha')));
  const missingCandidate = snapshot();
  delete missingCandidate.deployment.spec.template.metadata.annotations['factoryos.io/candidate-sha'];
  assert.ok(validateProvisioningSnapshot(missingCandidate, { namespace, candidateSha: 'a'.repeat(40) }).some((error) => error.includes('factoryos.io/candidate-sha')));
  const mutableImage = snapshot();
  mutableImage.deployment.spec.template.spec.containers[0].image = 'ghcr.io/factoryos/api:latest';
  assert.ok(validateProvisioningSnapshot(mutableImage, { namespace }).some((error) => error.includes('immutable sha256 digest')));
});

test('rejects writable source, mount, init alias, and block-device paths', () => {
  const source = snapshot();
  source.deployment.spec.template.spec.volumes[0].persistentVolumeClaim.readOnly = false;
  assert.ok(validateProvisioningSnapshot(source, { namespace }).some((error) => error.includes('source must set')));
  const mount = snapshot();
  mount.deployment.spec.template.spec.containers[0].volumeMounts[0].readOnly = false;
  assert.ok(validateProvisioningSnapshot(mount, { namespace }).some((error) => error.includes('mount must use')));
  const propagated = snapshot();
  propagated.deployment.spec.template.spec.containers[0].volumeMounts[0].mountPropagation = 'HostToContainer';
  assert.ok(validateProvisioningSnapshot(propagated, { namespace }).some((error) => error.includes('read-only and must not use subPath')));
  const init = snapshot();
  init.deployment.spec.template.spec.initContainers.push({
    name: 'init',
    securityContext: secureContext(),
    volumeMounts: [{ name: 'evidence', mountPath: '/evidence', readOnly: false }],
  });
  assert.ok(validateProvisioningSnapshot(init, { namespace }).some((error) => error.includes('Every alias')));
  const block = snapshot();
  block.deployment.spec.template.spec.containers[0].volumeDevices = [{ name: 'evidence', devicePath: '/dev/evidence' }];
  assert.ok(validateProvisioningSnapshot(block, { namespace }).some((error) => error.includes('Block-device')));
});

test('rejects unsafe container privilege, seccomp and host access', () => {
  const unsafePath = snapshot();
  unsafePath.deployment.spec.template.spec.containers[0].env[0].value = '/evidence\ninvalid';
  assert.ok(validateProvisioningSnapshot(unsafePath, { namespace }).some((error) => error.includes('normalized, non-root absolute POSIX path')));
  const cap = snapshot();
  cap.deployment.spec.template.spec.containers[0].securityContext.capabilities.add = ['SYS_ADMIN'];
  assert.ok(validateProvisioningSnapshot(cap, { namespace }).some((error) => error.includes('Every regular')));
  const seccomp = snapshot();
  seccomp.deployment.spec.template.spec.containers[0].securityContext.seccompProfile.type = 'Unconfined';
  assert.ok(validateProvisioningSnapshot(seccomp, { namespace }).some((error) => error.includes('Every regular')));
  const host = snapshot();
  host.deployment.spec.template.spec.hostPID = true;
  assert.ok(validateProvisioningSnapshot(host, { namespace }).some((error) => error.includes('hostPID')));
  const hostPath = snapshot();
  hostPath.deployment.spec.template.spec.volumes.push({ name: 'host', hostPath: { path: '/' } });
  assert.ok(validateProvisioningSnapshot(hostPath, { namespace }).some((error) => error.includes('hostPath')));
});

test('rejects token automount, token projection, and mounted legacy token Secrets', () => {
  const podToken = snapshot();
  podToken.deployment.spec.template.spec.automountServiceAccountToken = true;
  assert.ok(validateProvisioningSnapshot(podToken, { namespace }).some((error) => error.includes('automountServiceAccountToken')));
  const projected = snapshot();
  projected.deployment.spec.template.spec.volumes.push({
    name: 'token',
    projected: { sources: [{ serviceAccountToken: { path: 'token' } }] },
  });
  assert.ok(validateProvisioningSnapshot(projected, { namespace }).some((error) => error.includes('Projected ServiceAccount token')));
  const legacy = snapshot();
  legacy.deployment.spec.template.spec.volumes.push({ name: 'legacy', secret: { secretName: 'api-token' } });
  legacy.secrets.items.push({ metadata: { name: 'api-token', annotations: { 'kubernetes.io/service-account.name': SA } }, type: 'kubernetes.io/service-account-token' });
  assert.ok(validateProvisioningSnapshot(legacy, { namespace }).some((error) => error.includes('Kubernetes ServiceAccount token')));
  const envToken = snapshot();
  envToken.secrets.items.push({ metadata: { name: 'api-token', annotations: { 'kubernetes.io/service-account.name': SA } }, type: 'kubernetes.io/service-account-token' });
  envToken.deployment.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: 'api-token' } }];
  assert.ok(validateProvisioningSnapshot(envToken, { namespace }).some((error) => error.includes('Kubernetes ServiceAccount token')));
  const orphanToken = snapshot();
  orphanToken.secrets.items.push({ metadata: { name: 'orphan-token' }, type: 'kubernetes.io/service-account-token' });
  assert.ok(validateProvisioningSnapshot(orphanToken, { namespace }).some((error) => error.includes('Legacy Kubernetes ServiceAccount token Secret exists')));
  const account = snapshot();
  account.serviceAccount.automountServiceAccountToken = true;
  assert.ok(validateProvisioningSnapshot(account, { namespace }).some((error) => error.includes('ServiceAccount must exist')));
});

test('rejects RBAC grants to the API ServiceAccount and its namespace groups', () => {
  for (const binding of [
    { metadata: { name: 'direct', namespace: 'other-namespace' }, subjects: [{ kind: 'ServiceAccount', name: SA, namespace }] },
    { metadata: { name: 'user' }, subjects: [{ kind: 'User', name: 'system:serviceaccount:' + namespace + ':' + SA }] },
    { metadata: { name: 'group' }, subjects: [{ kind: 'Group', name: 'system:serviceaccounts:' + namespace }] },
    { metadata: { name: 'all' }, subjects: [{ kind: 'Group', name: 'system:serviceaccounts' }] },
  ]) {
    const value = snapshot();
    value.roleBindings.items.push(binding);
    assert.ok(validateProvisioningSnapshot(value, { namespace }).some((error) => error.includes('RoleBinding grants')));
    const cluster = snapshot();
    cluster.clusterRoleBindings.items.push(binding);
    assert.ok(validateProvisioningSnapshot(cluster, { namespace }).some((error) => error.includes('ClusterRoleBinding grants')));
  }
});

test('fails closed when admission policy acceptance or a Deny binding is absent', () => {
  const notAccepted = snapshot();
  notAccepted.policies.items[0].status.conditions[0].status = 'False';
  assert.ok(validateProvisioningSnapshot(notAccepted, { namespace }).some((error) => error.includes('not Accepted')));
  const noBinding = snapshot();
  noBinding.policyBindings.items = noBinding.policyBindings.items.filter((item) => item.metadata.name !== 'factoryos-backup-evidence-readonly');
  assert.ok(validateProvisioningSnapshot(noBinding, { namespace }).some((error) => error.includes('Binding is missing or misconfigured')));
});

test('requires a bound filesystem PVC, namespace enrollment and ready rollout when requested', () => {
  const unbound = snapshot();
  unbound.pvc.status.phase = 'Pending';
  assert.ok(validateProvisioningSnapshot(unbound, { namespace }).some((error) => error.includes('PVC must exist')));
  const unenrolled = snapshot();
  delete unenrolled.namespace.metadata.labels['factoryos.io/backup-evidence-enforcement'];
  assert.ok(validateProvisioningSnapshot(unenrolled, { namespace, requireEnrolled: true }).some((error) => error.includes('not enrolled')));
  const notReady = snapshot();
  notReady.deployment.status.readyReplicas = 0;
  assert.ok(validateProvisioningSnapshot(notReady, { namespace, requireReady: true }).some((error) => error.includes('not fully updated')));
  const staleRollout = snapshot();
  staleRollout.deployment.metadata.generation = 2;
  staleRollout.deployment.status.observedGeneration = 1;
  assert.ok(validateProvisioningSnapshot(staleRollout, { namespace, requireReady: true }).some((error) => error.includes('not fully updated')));
});

test('provisioner checks cluster context, policy acceptance, namespace enrollment, negative probes and runtime evidence', async () => {
  const script = await readFile(new URL('../../deploy/security/provision-backup-copy-evidence-enforcement.sh', import.meta.url), 'utf8');
  for (const required of [
    'EXPECTED_KUBE_CONTEXT',
    'kubectl config current-context',
    'KUBERNETES_VERSION_CHECKER',
    'node "$KUBERNETES_VERSION_CHECKER"',
    'POLICY_STATUS_CHECKER',
    'status.observedGeneration',
    'node "$POLICY_STATUS_CHECKER"',
    '--dry-run=server',
    'validatingadmissionpolicy/factoryos-backup-evidence-readonly',
    'backup-copy-evidence-api-service-account',
    'backup-copy-evidence-api-token-secret',
    'backup-copy-evidence-namespace-lock',
    'LABEL_KEY="factoryos.io/backup-evidence-enforcement"',
    'LABEL_VALUE="required"',
    'rollout status',
    'writable init-container alias',
    'automountServiceAccountToken',
    'backup-copy-evidence-api-token-secret',
    'add: ["SYS_ADMIN"]',
    'probe-backup-copy-evidence-runtime.mjs',
    'CANDIDATE_SHA',
    'independent_infrastructure_review',
    'Deployment requires a non-empty matchLabels selector',
    'Every Ready API replica',
    'imageID',
    'expectedImage.split("@").at(-1)',
    'runtimeId.endsWith(expectedDigest)',
    'rev-parse HEAD',
  ]) assert.ok(script.includes(required), 'provisioner missing ' + required);
});
