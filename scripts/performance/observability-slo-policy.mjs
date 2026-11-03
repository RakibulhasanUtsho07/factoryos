#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../..');
const DEFAULT_POLICY = resolve(REPOSITORY_ROOT, 'deploy/observability/slo-policy.yml');
const DEFAULT_ALERT_RULES = resolve(REPOSITORY_ROOT, 'deploy/observability/alert-rules.yml');

const TARGET_FIELDS = Object.freeze([
  'availability_percent',
  'error_rate_percent_max',
  'latency_p95_ms_max',
  'latency_p99_ms_max',
  'throughput_requests_per_second_min',
  'queue_freshness_seconds_max',
  'saturation_recovery_seconds_max',
]);
const APPROVAL_FIELDS = Object.freeze([
  'service_owner',
  'approver',
  'approval_reference',
  'approved_at_utc',
  'reviewed_candidate_sha',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim() === ''
    || /\b(?:todo|tbd|placeholder|replace[-_ ]?me|example\.invalid)\b|\[[^\]]*\]|<[^>]*>/i.test(value);
}

function parseScalar(value, lineNumber) {
  const raw = value.trim();
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'string') throw new Error('quoted scalar is not a string');
      return parsed;
    } catch {
      throw new Error('Invalid quoted scalar in SLO policy at line ' + lineNumber);
    }
  }
  if (/^[A-Za-z0-9_.-]+$/.test(raw)) return raw;
  throw new Error('Unsupported YAML scalar in SLO policy at line ' + lineNumber);
}

/**
 * Strict parser for the deliberately small mapping/scalar subset used by
 * deploy/observability/slo-policy.yml. Rejects aliases, tags, sequences,
 * duplicate keys and implicit YAML constructs rather than guessing.
 */
export function parseSloPolicyYaml(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('SLO policy file is empty');
  }
  const root = Object.create(null);
  const stack = [{ indent: -2, value: root }];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.includes('\t')) throw new Error('Tabs are not allowed in SLO policy YAML at line ' + (index + 1));
    const match = /^( *)([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) throw new Error('Unsupported SLO policy YAML syntax at line ' + (index + 1));
    const indent = match[1].length;
    if (indent % 2 !== 0) throw new Error('SLO policy indentation must use two-space levels at line ' + (index + 1));
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (indent !== parent.indent + 2) {
      throw new Error('Unexpected SLO policy indentation at line ' + (index + 1));
    }
    const key = match[2];
    if (Object.prototype.hasOwnProperty.call(parent.value, key)) {
      throw new Error('Duplicate SLO policy key "' + key + '" at line ' + (index + 1));
    }
    const rawValue = match[3] ?? '';
    if (rawValue === '') {
      const nested = Object.create(null);
      parent.value[key] = nested;
      stack.push({ indent, value: nested });
    } else {
      parent.value[key] = parseScalar(rawValue, index + 1);
    }
  }
  return root;
}

function parseUtcTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function validateSloPolicy(policy) {
  const errors = [];
  if (!isRecord(policy)) return ['policy must be a YAML mapping'];
  if (!['NOT_OWNER_APPROVED', 'APPROVED'].includes(policy.status)) {
    errors.push('status must be NOT_OWNER_APPROVED or APPROVED');
  }
  if (!/^[1-9]\d*[mhdw]$/.test(policy.measurement_window ?? '')) {
    errors.push('measurement_window must be a positive duration such as 30d');
  }
  if (!isRecord(policy.traffic_contract)) {
    errors.push('traffic_contract must be a mapping');
  } else {
    const minimumRps = policy.traffic_contract.minimum_requests_per_second;
    if (minimumRps !== null && !positiveNumber(minimumRps)) {
      errors.push('traffic_contract.minimum_requests_per_second must be null or a positive number');
    }
    if (typeof policy.traffic_contract.representative_routes_reviewed !== 'boolean') {
      errors.push('traffic_contract.representative_routes_reviewed must be boolean');
    }
  }
  if (!isRecord(policy.targets)) {
    errors.push('targets must be a mapping');
  } else {
    for (const field of TARGET_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(policy.targets, field)) {
        errors.push('targets.' + field + ' is required');
      }
    }
  }
  if (!isRecord(policy.proposal_only_starting_points)) {
    errors.push('proposal_only_starting_points must be a mapping');
  } else {
    for (const field of [
      'error_rate_percent_max',
      'latency_p95_ms_max',
      'latency_p99_ms_max',
      'queue_freshness_seconds_max',
      'saturation_recovery_seconds_max',
    ]) {
      if (!positiveNumber(policy.proposal_only_starting_points[field])) {
        errors.push('proposal_only_starting_points.' + field + ' must be a positive proposal value');
      }
    }
  }

  if (policy.status === 'NOT_OWNER_APPROVED') {
    for (const field of APPROVAL_FIELDS) {
      if (policy[field] !== '') errors.push('NOT_OWNER_APPROVED requires ' + field + ' to remain blank');
    }
    if (isRecord(policy.targets)) {
      for (const field of TARGET_FIELDS) {
        if (policy.targets[field] !== null) {
          errors.push('NOT_OWNER_APPROVED requires targets.' + field + ' to remain null');
        }
      }
    }
    if (isRecord(policy.traffic_contract)) {
      if (policy.traffic_contract.minimum_requests_per_second !== null) {
        errors.push('NOT_OWNER_APPROVED requires the approved minimum request rate to remain null');
      }
      if (policy.traffic_contract.representative_routes_reviewed !== false) {
        errors.push('NOT_OWNER_APPROVED requires representative_routes_reviewed=false');
      }
    }
  }

  if (policy.status === 'APPROVED') {
    for (const field of ['service_owner', 'approver', 'approval_reference']) {
      if (isPlaceholder(policy[field])) errors.push('APPROVED requires a non-placeholder ' + field);
    }
    if (!parseUtcTimestamp(policy.approved_at_utc)) {
      errors.push('APPROVED requires approved_at_utc as an ISO-8601 UTC timestamp');
    }
    if (!/^[a-f0-9]{40}$/i.test(policy.reviewed_candidate_sha ?? '')) {
      errors.push('APPROVED requires reviewed_candidate_sha to be a 40-hex commit SHA');
    }
    if (!isRecord(policy.traffic_contract)
        || !positiveNumber(policy.traffic_contract.minimum_requests_per_second)
        || policy.traffic_contract.representative_routes_reviewed !== true) {
      errors.push('APPROVED requires an owner-reviewed representative route mix and positive minimum request rate');
    }
    if (isRecord(policy.targets)) {
      for (const field of TARGET_FIELDS) {
        const value = policy.targets[field];
        const valid = field === 'error_rate_percent_max'
          ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
          : positiveNumber(value);
        if (!valid) errors.push('APPROVED requires a valid numeric targets.' + field);
      }
      const availability = policy.targets.availability_percent;
      const errorRate = policy.targets.error_rate_percent_max;
      if (typeof availability === 'number' && (availability <= 0 || availability > 100)) {
        errors.push('targets.availability_percent must be greater than 0 and at most 100');
      }
      if (typeof errorRate === 'number' && errorRate > 100) {
        errors.push('targets.error_rate_percent_max must not exceed 100');
      }
      const p95 = policy.targets.latency_p95_ms_max;
      const p99 = policy.targets.latency_p99_ms_max;
      if (typeof p95 === 'number' && typeof p99 === 'number' && p99 < p95) {
        errors.push('targets.latency_p99_ms_max must be greater than or equal to p95');
      }
    }
  }
  return errors;
}

function alertBlocks(rulesText) {
  const matches = [...rulesText.matchAll(/^      - alert: ([A-Za-z0-9_]+)[ \t]*$/gm)];
  return matches.map((match, index) => ({
    name: match[1],
    text: rulesText.slice(match.index, matches[index + 1]?.index ?? rulesText.length),
  }));
}

function expressionFor(block) {
  const marker = block.text.indexOf('expr:');
  if (marker < 0) return '';
  const valueStart = marker + 'expr:'.length;
  const nextFieldOffsets = ['for:', 'labels:', 'annotations:']
    .map((field) => block.text.indexOf(String.fromCharCode(10) + '        ' + field, valueStart))
    .filter((offset) => offset >= 0);
  const end = nextFieldOffsets.length > 0 ? Math.min(...nextFieldOffsets) : block.text.length;
  return block.text.slice(valueStart, end);
}

function containsNumericThreshold(expression, expected) {
  const values = [...expression.matchAll(/>\s*([0-9]+(?:\.[0-9]+)?)/g)].map((match) => Number(match[1]));
  return values.some((value) => Math.abs(value - expected) < 1e-9);
}

export function validateAlertRules(policy, rulesText) {
  const errors = [];
  if (typeof rulesText !== 'string' || rulesText.trim() === '') return ['alert-rules file is empty'];
  const blocks = alertBlocks(rulesText);
  if (blocks.length === 0) return ['alert-rules file contains no alert definitions'];

  const expectedLabel = policy.status === 'APPROVED' ? 'approved' : 'proposed';
  for (const block of blocks) {
    if (!block.text.split(/\r?\n/).some((line) => line.trim() === 'policy_status: ' + expectedLabel)) {
      errors.push('alert ' + block.name + ' must use policy_status: ' + expectedLabel);
    }
  }

  const thresholdCases = [
    ['FactoryOSApiHigh5xxRatio', policy.status === 'APPROVED'
      ? policy.targets.error_rate_percent_max / 100
      : policy.proposal_only_starting_points.error_rate_percent_max / 100],
    ['FactoryOSApiHighP95Latency', (policy.status === 'APPROVED'
      ? policy.targets.latency_p95_ms_max
      : policy.proposal_only_starting_points.latency_p95_ms_max) / 1000],
    ['FactoryOSApiHighP99Latency', (policy.status === 'APPROVED'
      ? policy.targets.latency_p99_ms_max
      : policy.proposal_only_starting_points.latency_p99_ms_max) / 1000],
    ['FactoryOSOutboxQueueOldestAge', policy.status === 'APPROVED'
      ? policy.targets.queue_freshness_seconds_max
      : policy.proposal_only_starting_points.queue_freshness_seconds_max],
    ['FactoryOSOutboxStalePublication', policy.status === 'APPROVED'
      ? policy.targets.queue_freshness_seconds_max
      : policy.proposal_only_starting_points.queue_freshness_seconds_max],
  ];
  for (const [name, expected] of thresholdCases) {
    const block = blocks.find((item) => item.name === name);
    if (!block) {
      errors.push('alert-rules is missing ' + name);
      continue;
    }
    if (!containsNumericThreshold(expressionFor(block), expected)) {
      errors.push(name + ' threshold does not match the ' + expectedLabel + ' SLO policy (expected ' + expected + '; expression was ' + JSON.stringify(expressionFor(block)) + ')');
    }
  }
  return errors;
}

export function validateObservabilitySloPolicy(policyText, rulesText, options = {}) {
  let policy;
  try {
    policy = parseSloPolicyYaml(policyText);
  } catch (error) {
    return { policy: null, errors: [error instanceof Error ? error.message : 'Unable to parse SLO policy'] };
  }
  const errors = validateSloPolicy(policy);
  if (options.requireApproved === true && policy.status !== 'APPROVED') {
    errors.push('release acceptance requires status: APPROVED; current status is ' + policy.status);
  }
  if (options.candidateSha && policy.status === 'APPROVED'
      && policy.reviewed_candidate_sha?.toLowerCase() !== String(options.candidateSha).toLowerCase()) {
    errors.push('reviewed_candidate_sha does not match the release candidate SHA');
  }
  if (errors.length === 0) errors.push(...validateAlertRules(policy, rulesText));
  return { policy, errors };
}

function parseArguments(argv) {
  const options = { policyPath: DEFAULT_POLICY, alertRulesPath: DEFAULT_ALERT_RULES, requireApproved: false, candidateSha: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--require-approved') options.requireApproved = true;
    else if (item === '--policy') options.policyPath = resolve(argv[++index] ?? '');
    else if (item === '--alert-rules') options.alertRulesPath = resolve(argv[++index] ?? '');
    else if (item === '--candidate-sha') options.candidateSha = argv[++index] ?? '';
    else throw new Error('Unknown argument: ' + item);
  }
  if (options.candidateSha && !/^[a-f0-9]{40}$/i.test(options.candidateSha)) {
    throw new Error('--candidate-sha must be a 40-hex commit SHA');
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const [policyText, rulesText] = await Promise.all([
    readFile(options.policyPath, 'utf8'),
    readFile(options.alertRulesPath, 'utf8'),
  ]);
  const result = validateObservabilitySloPolicy(policyText, rulesText, options);
  for (const error of result.errors) process.stderr.write('ERROR: ' + error + '\n');
  if (result.errors.length > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('OBSERVABILITY_SLO_POLICY=' + result.policy.status + '\n');
  if (result.policy.status === 'NOT_OWNER_APPROVED') {
    process.stdout.write('Production numeric SLO acceptance remains BLOCKED pending accountable service-owner approval.\n');
  } else {
    process.stdout.write('Approved SLO metadata and alert-rule thresholds are internally consistent.\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write('SLO policy validation failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
