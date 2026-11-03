import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUPPORTED_KUBERNETES_MINOR_VERSIONS,
  validateKubernetesServerVersion,
} from './require-supported-kubernetes-version.mjs';

test('accepts every maintained Kubernetes minor covered by the CI matrix', () => {
  assert.deepEqual(SUPPORTED_KUBERNETES_MINOR_VERSIONS, [35, 36, 37]);
  for (const minor of SUPPORTED_KUBERNETES_MINOR_VERSIONS) {
    assert.deepEqual(
      validateKubernetesServerVersion({ serverVersion: { major: '1', minor: String(minor), gitVersion: 'v1.' + minor + '.0' } }),
      { major: 1, minor, gitVersion: 'v1.' + minor + '.0' },
    );
  }
});

test('accepts kubectl minor strings with the upstream build suffix', () => {
  assert.equal(
    validateKubernetesServerVersion({ serverVersion: { major: '1', minor: '36+' } }).minor,
    36,
  );
});

test('rejects Kubernetes minors that are no longer maintained', () => {
  for (const minor of [29, 30, 31, 32, 33, 34]) {
    assert.throws(
      () => validateKubernetesServerVersion({ serverVersion: { major: '1', minor: String(minor), gitVersion: 'v1.' + minor + '.14' } }),
      /currently maintained, CI-tested version/,
    );
  }
});

test('fails closed for unreviewed future, malformed, and non-v1 servers', () => {
  for (const version of [
    { major: '1', minor: '38' },
    { major: '2', minor: '35' },
    { major: '1', minor: '35-alpha' },
    { major: '1', minor: '' },
    {},
  ]) {
    assert.throws(
      () => validateKubernetesServerVersion({ serverVersion: version }),
      /Unsupported Kubernetes server version/,
    );
  }
});
