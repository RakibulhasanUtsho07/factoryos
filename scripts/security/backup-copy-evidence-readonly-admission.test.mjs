import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Kubernetes admission policy binds the API identity and evidence root to a fail-closed read-only Pod', async () => {
  const policy = await read('deploy/security/backup-copy-evidence-readonly-policy.yaml');
  assert.ok(policy.startsWith('apiVersion: admissionregistration.k8s.io/v1'));
  assert.ok(policy.includes('kind: ValidatingAdmissionPolicy'));
  assert.ok(policy.includes('failurePolicy: Fail'));
  assert.ok(policy.includes('operations: ["CREATE", "UPDATE"]'));
  assert.ok(policy.includes('resources: ["pods", "pods/ephemeralcontainers"]'));
  assert.equal((policy.match(/^    - expression:/gm) ?? []).length, 3);

  for (const required of [
    "object.spec.serviceAccountName == 'factoryos-backup-evidence-api'",
    'object.spec.automountServiceAccountToken == false',
    '!has(object.spec.hostPID) || object.spec.hostPID != true',
    '!has(object.spec.hostIPC) || object.spec.hostIPC != true',
    '!has(object.spec.hostNetwork) || object.spec.hostNetwork != true',
    '!has(object.spec.shareProcessNamespace) || object.spec.shareProcessNamespace != true',
    '!has(volume.hostPath)',
    '!has(source.serviceAccountToken)',
    'FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR',
    'variable.value.startsWith',
    'mount.mountPath == variable.value',
    'mount.readOnly == true',
    "mount.mountPropagation == 'None'",
    "!has(mount.subPath)",
    "!has(mount.subPathExpr)",
    "volume.persistentVolumeClaim.claimName == 'factoryos-backup-evidence'",
    'has(volume.persistentVolumeClaim.readOnly) && volume.persistentVolumeClaim.readOnly == true',
    'object.spec.containers.all(container',
    'object.spec.initContainers.all(container',
    'object.spec.ephemeralContainers.all(container',
    '!container.volumeDevices.exists(device',
    'object.spec.initContainers.all(container',,
    'container.securityContext.runAsNonRoot == true',
    'container.securityContext.runAsUser > 0',
    'container.securityContext.allowPrivilegeEscalation == false',
    'container.securityContext.readOnlyRootFilesystem == true',
    '!has(container.securityContext.privileged) || container.securityContext.privileged != true',
    "capability == 'ALL'",
    'container.securityContext.capabilities.add.size() == 0',
    "!has(container.securityContext.procMount) || container.securityContext.procMount != 'Unmasked'",
    "container.securityContext.seccompProfile.type == 'RuntimeDefault'",
  ]) assert.ok(policy.includes(required), 'policy missing check: ' + required);
});

test('read-only admission binding is limited to enrolled production namespaces', async () => {
  const binding = await read('deploy/security/backup-copy-evidence-readonly-binding.yaml');
  assert.ok(binding.includes('kind: ValidatingAdmissionPolicyBinding'));
  assert.ok(binding.includes('policyName: factoryos-backup-evidence-readonly'));
  assert.ok(binding.includes('- Deny'));
  assert.ok(binding.includes('factoryos.io/backup-evidence-enforcement: required'));
  const tokenPolicy = await read('deploy/security/backup-copy-evidence-api-token-secret-policy.yaml');
  const tokenBinding = await read('deploy/security/backup-copy-evidence-api-token-secret-binding.yaml');
  assert.ok(tokenPolicy.includes("object.type != 'kubernetes.io/service-account-token'"));
  assert.ok(tokenBinding.includes('policyName: factoryos-backup-evidence-api-token-secret'));
  assert.ok(tokenBinding.includes('factoryos.io/backup-evidence-enforcement: required'));
});

test('dedicated ServiceAccount token automount is immutable after namespace enrollment', async () => {
  const account = await read('deploy/security/backup-copy-evidence-api-service-account.yaml');
  const policy = await read('deploy/security/backup-copy-evidence-api-service-account-policy.yaml');
  const binding = await read('deploy/security/backup-copy-evidence-api-service-account-binding.yaml');
  assert.ok(account.includes('name: factoryos-backup-evidence-api'));
  assert.ok(account.includes('automountServiceAccountToken: false'));
  assert.ok(policy.includes('operations: ["CREATE", "UPDATE", "DELETE"]'));
  assert.ok(policy.includes('object.automountServiceAccountToken == false'));
  assert.ok(policy.includes("request.operation == 'DELETE'"));
  assert.ok(policy.includes('oldObject.metadata.name'));
  assert.ok(binding.includes('policyName: factoryos-backup-evidence-api-service-account'));
  assert.ok(binding.includes('factoryos.io/backup-evidence-enforcement: required'));
});

test('namespace enrollment remains locked against label removal and ordinary deletion', async () => {
  const policy = await read('deploy/security/backup-copy-evidence-namespace-lock-policy.yaml');
  const binding = await read('deploy/security/backup-copy-evidence-namespace-lock-binding.yaml');
  assert.ok(policy.includes('operations: ["UPDATE", "DELETE"]'));
  assert.ok(policy.includes("request.operation == 'UPDATE'"));
  assert.ok(binding.includes('policyName: factoryos-backup-evidence-namespace-lock'));
  assert.ok(binding.includes('- Deny'));
});
