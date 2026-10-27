import assert from 'node:assert/strict';
import test from 'node:test';
import { auditProviderEvidenceArtifacts } from './wms-provider-evidence-safety-check.mjs';

function artifacts(overrides = {}) {
  const evidence = {
    schema: 'factoryos.wms.provider-certification/v1',
    credentials_recorded: false,
    secret_values_recorded: false,
    result: 'PASS_FOR_CONFIGURED_STORAGE_AND_FACTORYOS_RECEIVER_CONTRACT_ONLY',
    evidence: {
      carrier_sandbox_origin: 'NOT_PROVEN',
      storage_iam_least_privilege_review: 'NOT_VERIFIED_BY_SCRIPT',
    },
  };
  const policyReport = {
    schema: 'factoryos.wms.storage-policy-shape/v1',
    result: 'PASS_POLICY_SHAPE_ONLY',
    limitations: [
      'This does not prove the policy is attached to the deployed runtime identity.',
      'Effective permissions still require provider-side owner review.',
    ],
  };
  return {
    evidenceText: JSON.stringify({ ...evidence, ...overrides.evidence }),
    policyReportText: JSON.stringify({ ...policyReport, ...overrides.policyReport }),
    secrets: {
      FACTORYOS_CERT_WEBHOOK_SECRET: 'test-webhook-secret-never-record-this',
      FACTORYOS_CERT_BEARER_TOKEN: 'a-long-test-bearer-token',
      FACTORYOS_CERT_READONLY_BEARER_TOKEN: 'another-long-test-token',
    },
  };
}

test('accepts redacted evidence while preserving carrier and effective-IAM boundaries', () => {
  const report = auditProviderEvidenceArtifacts(artifacts());
  assert.equal(report.pass, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.carrier_origin, 'NOT_PROVEN');
  assert.equal(report.effective_storage_iam, 'NOT_VERIFIED_BY_SCRIPT');
});

test('rejects an artifact containing any configured credential', () => {
  const input = artifacts();
  input.evidenceText = input.evidenceText.replace('NOT_PROVEN', 'test-webhook-secret-never-record-this');
  const report = auditProviderEvidenceArtifacts(input);
  assert.equal(report.pass, false);
  assert.ok(report.issues.includes('CONFIGURED_SECRET_VALUE_FOUND_IN_ARTIFACT'));
});

test('rejects evidence that claims a real carrier-originated callback', () => {
  const report = auditProviderEvidenceArtifacts({ ...artifacts(), evidenceText: JSON.stringify({
    result: 'PASS_FOR_CONFIGURED_STORAGE_AND_FACTORYOS_RECEIVER_CONTRACT_ONLY',
    credentials_recorded: false,
    secret_values_recorded: false,
    evidence: { carrier_sandbox_origin: 'PASS', storage_iam_least_privilege_review: 'NOT_VERIFIED_BY_SCRIPT' },
  }) });
  assert.equal(report.pass, false);
  assert.ok(report.issues.includes('CARRIER_ORIGIN_MUST_REMAIN_NOT_PROVEN'));
});

test('rejects policy shape failure and missing limitation language', () => {
  const input = artifacts();
  input.policyReportText = JSON.stringify({
    result: 'FAIL_POLICY_SHAPE',
    limitations: ['Policy is valid.'],
  });
  const report = auditProviderEvidenceArtifacts(input);
  assert.equal(report.pass, false);
  assert.ok(report.issues.includes('STORAGE_POLICY_SHAPE_CHECK_DID_NOT_PASS'));
  assert.ok(report.issues.includes('STORAGE_POLICY_REPORT_LIMITATIONS_MISSING'));
});

test('rejects bearer credentials even if the exact-secret inventory is incomplete', () => {
  const input = artifacts();
  input.policyReportText = input.policyReportText.replace(
    'Effective permissions still require provider-side owner review.',
    'Authorization: Bearer abcdefghijklmnop.verysecretvalue',
  );
  const report = auditProviderEvidenceArtifacts(input);
  assert.equal(report.pass, false);
  assert.ok(report.issues.includes('BEARER_CREDENTIAL_PATTERN_FOUND'));
});
