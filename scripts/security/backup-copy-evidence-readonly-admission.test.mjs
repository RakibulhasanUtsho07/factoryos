import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
async function readYaml(path) {
  const source = await readFile(new URL(path, root), 'utf8');
  return yaml.safeLoad(source, { schema: yaml.DEFAULT_SAFE_SCHEMA });
}

test('Kubernetes admission policy is fail-closed and checks the exact evidence mount', async () => {
  const policy = await readYaml('deploy/security/backup-copy-evidence-readonly-policy.yaml');
  assert.equal(policy.apiVersion, 'admissionregistration.k8s.io/v1');
  assert.equal(policy.kind, 'ValidatingAdmissionPolicy');
  assert.equal(policy.metadata.name, 'factoryos-backup-evidence-readonly');
  assert.equal(policy.spec.failurePolicy, 'Fail');
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [{
    apiGroups: [''],
    apiVersions: ['v1'],
    operations: ['CREATE', 'UPDATE'],
    resources: ['pods'],
  }]);

  const expression = policy.spec.validations.map((rule) => rule.expression).join('\n');
  for (const required of [
    'FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR',
    'variable.value.startsWith',
    'mount.mountPath == variable.value',
    'mount.readOnly == true',
    '!has(mount.subPath)',
    '!has(mount.subPathExpr)',
    'has(volume.persistentVolumeClaim)',
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
  ]) assert.ok(expression.includes(required), 'policy missing check: ' + required);
});

test('Kubernetes admission binding denies invalid Pods only in explicitly labelled production namespaces', async () => {
  const binding = await readYaml('deploy/security/backup-copy-evidence-readonly-binding.yaml');
  assert.equal(binding.apiVersion, 'admissionregistration.k8s.io/v1');
  assert.equal(binding.kind, 'ValidatingAdmissionPolicyBinding');
  assert.equal(binding.spec.policyName, 'factoryos-backup-evidence-readonly');
  assert.deepEqual(binding.spec.validationActions, ['Deny']);
  assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, {
    'factoryos.io/backup-evidence-enforcement': 'required',
  });
});
