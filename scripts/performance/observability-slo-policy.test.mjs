import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  parseSloPolicyYaml,
  validateObservabilitySloPolicy,
  validateSloPolicy,
} from './observability-slo-policy.mjs';

const root = new URL('../../', import.meta.url);
async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

function approvedPolicy() {
  const policy = parseSloPolicyYaml(currentPolicyText);
  policy.status = 'APPROVED';
  policy.service_owner = 'FactoryOS Service Owner';
  policy.approver = 'Operations Director';
  policy.approval_reference = 'CHG-2026-1103';
  policy.approved_at_utc = '2026-11-03T10:00:00Z';
  policy.reviewed_candidate_sha = 'a'.repeat(40);
  policy.traffic_contract.minimum_requests_per_second = 50;
  policy.traffic_contract.representative_routes_reviewed = true;
  policy.targets = {
    availability_percent: 99.9,
    error_rate_percent_max: 1,
    latency_p95_ms_max: 500,
    latency_p99_ms_max: 1500,
    throughput_requests_per_second_min: 50,
    queue_freshness_seconds_max: 300,
    saturation_recovery_seconds_max: 30,
  };
  return policy;
}

let currentPolicyText;
let currentAlertRulesText;

test('repository SLO register remains valid but explicitly NOT_OWNER_APPROVED', async () => {
  currentPolicyText = await read('deploy/observability/slo-policy.yml');
  currentAlertRulesText = await read('deploy/observability/alert-rules.yml');
  const result = validateObservabilitySloPolicy(currentPolicyText, currentAlertRulesText);
  assert.deepEqual(result.errors, []);
  assert.equal(result.policy.status, 'NOT_OWNER_APPROVED');
  assert.ok(Object.values(result.policy.targets).every((value) => value === null));
});

test('release validation refuses to treat proposal values as approved targets', () => {
  const result = validateObservabilitySloPolicy(currentPolicyText, currentAlertRulesText, { requireApproved: true });
  assert.ok(result.errors.some((error) => error.includes('requires status: APPROVED')));
});

test('a complete owner-approved policy is accepted only when alert thresholds and labels match', () => {
  const approvedRules = currentAlertRulesText.replaceAll('policy_status: proposed', 'policy_status: approved');
  const yaml = [
    'status: APPROVED',
    'service_owner: "FactoryOS Service Owner"',
    'approver: "Operations Director"',
    'approval_reference: "CHG-2026-1103"',
    'approved_at_utc: "2026-11-03T10:00:00Z"',
    'reviewed_candidate_sha: "' + 'a'.repeat(40) + '"',
    'measurement_window: 30d',
    'traffic_contract:',
    '  minimum_requests_per_second: 50',
    '  representative_routes_reviewed: true',
    'targets:',
    '  availability_percent: 99.9',
    '  error_rate_percent_max: 1',
    '  latency_p95_ms_max: 500',
    '  latency_p99_ms_max: 1500',
    '  throughput_requests_per_second_min: 50',
    '  queue_freshness_seconds_max: 300',
    '  saturation_recovery_seconds_max: 30',
    'proposal_only_starting_points:',
    '  error_rate_percent_max: 1',
    '  latency_p95_ms_max: 500',
    '  latency_p99_ms_max: 1500',
    '  queue_freshness_seconds_max: 300',
    '  saturation_recovery_seconds_max: 30',
  ].join('\n');
  const valid = validateObservabilitySloPolicy(yaml, approvedRules, {
    requireApproved: true,
    candidateSha: 'a'.repeat(40),
  });
  assert.deepEqual(valid.errors, []);
});


test('approved SLO values cannot drift from the threshold expressions in alert-rules.yml', () => {
  const yaml = [
    'status: APPROVED',
    'service_owner: "FactoryOS Service Owner"',
    'approver: "Operations Director"',
    'approval_reference: "CHG-2026-1103"',
    'approved_at_utc: "2026-11-03T10:00:00Z"',
    'reviewed_candidate_sha: "' + 'a'.repeat(40) + '"',
    'measurement_window: 30d',
    'traffic_contract:',
    '  minimum_requests_per_second: 50',
    '  representative_routes_reviewed: true',
    'targets:',
    '  availability_percent: 99.9',
    '  error_rate_percent_max: 1',
    '  latency_p95_ms_max: 700',
    '  latency_p99_ms_max: 1500',
    '  throughput_requests_per_second_min: 50',
    '  queue_freshness_seconds_max: 300',
    '  saturation_recovery_seconds_max: 30',
    'proposal_only_starting_points:',
    '  error_rate_percent_max: 1',
    '  latency_p95_ms_max: 500',
    '  latency_p99_ms_max: 1500',
    '  queue_freshness_seconds_max: 300',
    '  saturation_recovery_seconds_max: 30',
  ].join('\n');
  const rules = currentAlertRulesText.replaceAll('policy_status: proposed', 'policy_status: approved');
  const result = validateObservabilitySloPolicy(yaml, rules, {
    requireApproved: true,
    candidateSha: 'a'.repeat(40),
  });
  assert.ok(result.errors.some((error) => error.includes('FactoryOSApiHighP95Latency threshold')));
});

test('approval is rejected when owner evidence, traffic review or numeric targets are incomplete', () => {
  const policy = approvedPolicy();
  policy.approver = '';
  policy.approved_at_utc = 'not-a-date';
  policy.reviewed_candidate_sha = 'main';
  policy.traffic_contract.representative_routes_reviewed = false;
  policy.targets.latency_p99_ms_max = 400;
  const errors = validateSloPolicy(policy);
  assert.ok(errors.some((error) => error.includes('approver')));
  assert.ok(errors.some((error) => error.includes('approved_at_utc')));
  assert.ok(errors.some((error) => error.includes('reviewed_candidate_sha')));
  assert.ok(errors.some((error) => error.includes('representative route mix')));
  assert.ok(errors.some((error) => error.includes('p99')));
});

test('unapproved register rejects partially populated numeric targets', () => {
  const policy = parseSloPolicyYaml(currentPolicyText);
  policy.targets.latency_p95_ms_max = 500;
  assert.ok(validateSloPolicy(policy).some((error) => error.includes('must remain null')));
});

test('policy parser fails closed on duplicate keys and unsupported YAML constructs', () => {
  assert.throws(() => parseSloPolicyYaml('status: NOT_OWNER_APPROVED\nstatus: APPROVED'));
  assert.throws(() => parseSloPolicyYaml('status: !!js/function alert(1)'));
});

test('approved policy cannot be used for a different release candidate SHA', () => {
  const yaml = [
    'status: APPROVED',
    'service_owner: "FactoryOS Service Owner"',
    'approver: "Operations Director"',
    'approval_reference: "CHG-2026-1103"',
    'approved_at_utc: "2026-11-03T10:00:00Z"',
    'reviewed_candidate_sha: "' + 'a'.repeat(40) + '"',
    'measurement_window: 30d',
    'traffic_contract:',
    '  minimum_requests_per_second: 50',
    '  representative_routes_reviewed: true',
    'targets:',
    '  availability_percent: 99.9',
    '  error_rate_percent_max: 1',
    '  latency_p95_ms_max: 500',
    '  latency_p99_ms_max: 1500',
    '  throughput_requests_per_second_min: 50',
    '  queue_freshness_seconds_max: 300',
    '  saturation_recovery_seconds_max: 30',
    'proposal_only_starting_points:',
    '  error_rate_percent_max: 1',
    '  latency_p95_ms_max: 500',
    '  latency_p99_ms_max: 1500',
    '  queue_freshness_seconds_max: 300',
    '  saturation_recovery_seconds_max: 30',
  ].join('\n');
  const rules = currentAlertRulesText.replaceAll('policy_status: proposed', 'policy_status: approved');
  const result = validateObservabilitySloPolicy(yaml, rules, {
    requireApproved: true,
    candidateSha: 'b'.repeat(40),
  });
  assert.ok(result.errors.some((error) => error.includes('does not match the release candidate SHA')));
});
