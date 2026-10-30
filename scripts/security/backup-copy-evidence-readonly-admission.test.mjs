import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Kubernetes admission policy is fail-closed and checks the exact evidence mount', async () => {
  const policy = await read('deploy/security/backup-copy-evidence-readonly-policy.yaml');
  assert.ok(policy.startsWith('apiVersion: admissionregistration.k8s.io/v1'));
  assert.ok(policy.includes('kind: ValidatingAdmissionPolicy'));
  assert.ok(policy.includes('failurePolicy: Fail'));
  assert.ok(policy.includes('operations: ["CREATE", "UPDATE"]'));
  assert.ok(policy.includes('resources: ["pods"]'));
  assert.equal((policy.match(/^    - expression:/gm) ?? []).length, 2);

  for (const required of [
    'FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR',
    'variable.value.startsWith',
    'mount.mountPath == variable.value',
    'mount.readOnly == true',
    '!has(mount.subPath)',
    '!has(mount.subPathExpr)',
    "volume.persistentVolumeClaim.claimName == 'factoryos-backup-evidence'",
    'volume.persistentVolumeClaim.readOnly == true',
    'container.securityContext.runAsNonRoot == true',
    'container.securityContext.allowPrivilegeEscalation == false',
    'container.securityContext.readOnlyRootFilesystem == true',
    'container.securityContext.privileged != true',
    "capability == 'ALL'",
    'object.spec.volumes.all(volume',
    "claimName != 'factoryos-backup-evidence'",
    'object.spec.initContainers.all(container',
    'object.spec.ephemeralContainers.all(container',
  ]) assert.ok(policy.includes(required), 'policy missing check: ' + required);
  assert.doesNotMatch(policy, /has\(container\.(?:env|volumeMounts)/);
  assert.doesNotMatch(policy, /has\(object\.spec\.(?:initContainers|ephemeralContainers)/);
  assert.doesNotMatch(policy, /has\(container\.securityContext\.capabilities\.drop/);
});

test('Kubernetes admission binding denies invalid Pods only in explicitly labelled production namespaces', async () => {
  const binding = await read('deploy/security/backup-copy-evidence-readonly-binding.yaml');
  assert.ok(binding.startsWith('apiVersion: admissionregistration.k8s.io/v1'));
  assert.ok(binding.includes('kind: ValidatingAdmissionPolicyBinding'));
  assert.ok(binding.includes('policyName: factoryos-backup-evidence-readonly'));
  assert.ok(binding.includes('validationActions:'));
  assert.ok(binding.includes('- Deny'));
  assert.ok(binding.includes('factoryos.io/backup-evidence-enforcement: required'));
});
