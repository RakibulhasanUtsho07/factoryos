import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWmsPodStoragePolicy } from './wms-storage-iam-policy-check.mjs';

const BUCKET = 'factoryos-pod-staging';
const TARGET = 'arn:aws:s3:::factoryos-pod-staging/pod/*';

function policy(statement) {
  return { Version: '2012-10-17', Statement: statement };
}

test('accepts only GetObject and PutObject on the exact POD object prefix', () => {
  const report = evaluateWmsPodStoragePolicy(policy([{
    Effect: 'Allow',
    Action: ['s3:GetObject', 's3:PutObject'],
    Resource: TARGET,
  }]), { bucket: BUCKET, prefix: 'pod/' });

  assert.equal(report.pass, true);
  assert.deepEqual(report.covered_actions, ['s3:GetObject', 's3:PutObject']);
  assert.deepEqual(report.issues, []);
});

test('accepts split read and write statements when both target the exact approved prefix', () => {
  const report = evaluateWmsPodStoragePolicy(policy([
    { Effect: 'Allow', Action: 's3:GetObject', Resource: TARGET },
    { Effect: 'Allow', Action: 's3:PutObject', Resource: TARGET },
  ]), { bucket: BUCKET, prefix: 'pod/' });

  assert.equal(report.pass, true);
  assert.equal(report.allow_statement_count, 2);
});

test('supports a narrower factory prefix without allowing sibling prefixes', () => {
  const prefix = 'pod/tenant-1/factory-1/';
  const report = evaluateWmsPodStoragePolicy(policy([{
    Effect: 'Allow',
    Action: ['s3:GetObject', 's3:PutObject'],
    Resource: 'arn:aws:s3:::factoryos-pod-staging/pod/tenant-1/factory-1/*',
  }]), { bucket: BUCKET, prefix });

  assert.equal(report.pass, true);
  assert.equal(report.prefix, prefix);
});

test('rejects wildcard actions and extra list/delete privileges', () => {
  for (const action of ['*', 's3:*', 's3:ListBucket', 's3:DeleteObject', 's3:PutObjectTagging']) {
    const report = evaluateWmsPodStoragePolicy(policy([{
      Effect: 'Allow', Action: [action, 's3:GetObject'], Resource: TARGET,
    }]), { bucket: BUCKET, prefix: 'pod/' });
    assert.equal(report.pass, false, 'must reject ' + action);
    assert.ok(report.issues.some((issue) => issue.code === 'UNSUPPORTED_ALLOW_ACTION'));
  }
});

test('rejects wildcard, bucket-wide and unrelated-prefix resources', () => {
  const resources = [
    '*',
    'arn:aws:s3:::factoryos-pod-staging',
    'arn:aws:s3:::factoryos-pod-staging/*',
    'arn:aws:s3:::factoryos-pod-staging/pod-other/*',
    'arn:aws:s3:::other-bucket/pod/*',
    'arn:aws:s3:::factoryos-pod-staging/pod/*/child/*',
  ];
  for (const resource of resources) {
    const report = evaluateWmsPodStoragePolicy(policy([{
      Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: resource,
    }]), { bucket: BUCKET, prefix: 'pod/' });
    assert.equal(report.pass, false, 'must reject resource ' + resource);
  }
});

test('rejects an incomplete policy that grants only upload or only read', () => {
  for (const action of ['s3:GetObject', 's3:PutObject']) {
    const report = evaluateWmsPodStoragePolicy(policy([{
      Effect: 'Allow', Action: action, Resource: TARGET,
    }]), { bucket: BUCKET, prefix: 'pod/' });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) =>
      issue.code === 'REQUIRED_ACTION_NOT_GRANTED_ON_TARGET_PREFIX',
    ));
  }
});

test('rejects unsupported NotAction, NotResource, and resource-policy Principal constructs', () => {
  const statements = [
    { Effect: 'Allow', NotAction: 's3:DeleteObject', Resource: TARGET },
    { Effect: 'Allow', Action: 's3:GetObject', NotResource: 'arn:aws:s3:::bucket/pod/*' },
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: TARGET, Principal: '*' },
  ];
  for (const statement of statements) {
    const report = evaluateWmsPodStoragePolicy(policy([statement]), { bucket: BUCKET, prefix: 'pod/' });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === 'UNSUPPORTED_POLICY_CONSTRUCT'));
  }
});

test('rejects invalid bucket names, non-POD prefixes and malformed policy documents', () => {
  assert.equal(evaluateWmsPodStoragePolicy(policy([{
    Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: TARGET,
  }]), { bucket: '*', prefix: 'pod/' }).pass, false);

  assert.equal(evaluateWmsPodStoragePolicy(policy([{
    Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: TARGET,
  }]), { bucket: BUCKET, prefix: '*' }).pass, false);

  assert.equal(evaluateWmsPodStoragePolicy({}, { bucket: BUCKET, prefix: 'pod/' }).pass, false);
  assert.equal(evaluateWmsPodStoragePolicy(null, { bucket: BUCKET, prefix: 'pod/' }).pass, false);
});

test('broad explicit Deny statements do not grant privileges or replace live smoke', () => {
  const report = evaluateWmsPodStoragePolicy(policy([
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: TARGET },
    { Effect: 'Deny', Action: '*', Resource: '*' },
  ]), { bucket: BUCKET, prefix: 'pod/' });

  // The report is explicitly shape-only: effective access must still be proven
  // by the separate live staging PUT/read-back smoke.
  assert.equal(report.pass, true);
});
