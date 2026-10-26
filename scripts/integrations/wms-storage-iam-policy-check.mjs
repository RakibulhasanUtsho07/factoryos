#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED_ACTIONS = ['s3:GetObject', 's3:PutObject'];
const MAX_POLICY_BYTES = 1024 * 1024;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_PATTERN = /^pod\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*$/;

function asArray(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
}

function addIssue(issues, code, statementIndex = null) {
  issues.push({ code, ...(statementIndex === null ? {} : { statement_index: statementIndex }) });
}

function validBucket(bucket) {
  return typeof bucket === 'string'
    && BUCKET_PATTERN.test(bucket)
    && !bucket.includes('..')
    && !bucket.includes('.-')
    && !bucket.includes('-.');
}

function validPrefix(prefix) {
  return typeof prefix === 'string' && PREFIX_PATTERN.test(prefix);
}

function inspectResource(resource, bucket, prefix) {
  if (typeof resource !== 'string') return { ok: false, code: 'INVALID_RESOURCE' };
  const match = resource.match(/^arn:([^:]+):s3:::([^/]+)\/(.+)$/);
  if (!match || match[2] !== bucket) {
    return { ok: false, code: 'RESOURCE_MUST_NAME_EXACT_BUCKET_OBJECTS' };
  }

  const keyPattern = match[3];
  if (keyPattern.includes('?') || keyPattern.includes('//')
      || /(^|\/)\.{1,2}(\/|$)/.test(keyPattern)) {
    return { ok: false, code: 'RESOURCE_HAS_UNSAFE_KEY_PATTERN' };
  }
  const wildcardCount = [...keyPattern].filter((character) => character === '*').length;
  if (wildcardCount > 1 || (wildcardCount === 1 && !keyPattern.endsWith('/*'))) {
    return { ok: false, code: 'RESOURCE_HAS_UNSUPPORTED_WILDCARD' };
  }
  if (!keyPattern.startsWith(prefix)) {
    return { ok: false, code: 'RESOURCE_OUTSIDE_APPROVED_PREFIX' };
  }
  return {
    ok: true,
    coversRequestedPrefix: keyPattern === prefix + '*',
  };
}

/**
 * Checks only the least-privilege shape of an S3-compatible identity policy.
 * It does not resolve attached policies or provider-side effective permissions.
 */
export function evaluateWmsPodStoragePolicy(policy, { bucket, prefix = 'pod/' } = {}) {
  const issues = [];
  const coveredActions = new Set();
  let allowStatementCount = 0;

  if (!validBucket(bucket)) addIssue(issues, 'INVALID_BUCKET_NAME');
  if (!validPrefix(prefix)) addIssue(issues, 'INVALID_POD_PREFIX');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    addIssue(issues, 'INVALID_POLICY_DOCUMENT');
    return { pass: false, issues, covered_actions: [], allow_statement_count: 0 };
  }

  const statements = Array.isArray(policy.Statement)
    ? policy.Statement
    : policy.Statement && typeof policy.Statement === 'object'
      ? [policy.Statement]
      : null;
  if (!statements || statements.length === 0) {
    addIssue(issues, 'MISSING_POLICY_STATEMENTS');
    return { pass: false, issues, covered_actions: [], allow_statement_count: 0 };
  }

  if (issues.length > 0) {
    return { pass: false, issues, covered_actions: [], allow_statement_count: 0 };
  }

  statements.forEach((statement, index) => {
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)) {
      addIssue(issues, 'INVALID_STATEMENT', index);
      return;
    }
    if (Object.hasOwn(statement, 'NotAction') || Object.hasOwn(statement, 'NotResource')
        || Object.hasOwn(statement, 'Principal')) {
      addIssue(issues, 'UNSUPPORTED_POLICY_CONSTRUCT', index);
      return;
    }

    const effect = typeof statement.Effect === 'string' ? statement.Effect.toLowerCase() : '';
    if (effect === 'allow' && Object.hasOwn(statement, 'Condition')) {
      addIssue(issues, 'UNSUPPORTED_ALLOW_CONDITION', index);
      return;
    }
    if (effect === 'deny') {
      // Explicit Deny can reduce access but cannot grant privileges. The live
      // upload/read-back smoke remains necessary to verify effective access.
      return;
    }
    if (effect !== 'allow') {
      addIssue(issues, 'INVALID_EFFECT', index);
      return;
    }
    allowStatementCount += 1;

    const actions = asArray(statement.Action).map((action) =>
      typeof action === 'string' ? action.trim().toLowerCase() : '',
    );
    if (actions.length === 0 || actions.some((action) =>
      !REQUIRED_ACTIONS.some((required) => required.toLowerCase() === action),
    )) {
      addIssue(issues, 'UNSUPPORTED_ALLOW_ACTION', index);
      return;
    }

    const resources = asArray(statement.Resource);
    if (resources.length === 0) {
      addIssue(issues, 'MISSING_ALLOW_RESOURCE', index);
      return;
    }

    const inspected = resources.map((resource) => inspectResource(resource, bucket, prefix));
    for (const result of inspected) {
      if (!result.ok) addIssue(issues, result.code, index);
    }
    if (inspected.some((result) => !result.ok)) return;

    if (inspected.some((result) => result.coversRequestedPrefix)) {
      for (const action of actions) {
        const canonical = REQUIRED_ACTIONS.find((required) => required.toLowerCase() === action);
        if (canonical) coveredActions.add(canonical);
      }
    }
  });

  for (const action of REQUIRED_ACTIONS) {
    if (!coveredActions.has(action)) addIssue(issues, 'REQUIRED_ACTION_NOT_GRANTED_ON_TARGET_PREFIX');
  }
  if (allowStatementCount === 0) addIssue(issues, 'NO_ALLOW_STATEMENTS');

  const deduplicatedIssues = issues.filter((issue, index) =>
    issues.findIndex((candidate) =>
      candidate.code === issue.code && candidate.statement_index === issue.statement_index,
    ) === index,
  );

  return {
    pass: deduplicatedIssues.length === 0,
    issues: deduplicatedIssues,
    covered_actions: [...coveredActions].sort(),
    allow_statement_count: allowStatementCount,
    bucket,
    prefix,
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--policy', '--bucket', '--prefix'].includes(key)) {
      throw new Error('Usage: node scripts/integrations/wms-storage-iam-policy-check.mjs --policy <private-policy.json> --bucket <bucket> [--prefix pod/]');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + key);
    values[key] = value;
    index += 1;
  }
  if (!values['--policy'] || !values['--bucket']) {
    throw new Error('Usage: node scripts/integrations/wms-storage-iam-policy-check.mjs --policy <private-policy.json> --bucket <bucket> [--prefix pod/]');
  }
  return {
    policyPath: values['--policy'],
    bucket: values['--bucket'],
    prefix: values['--prefix'] ?? 'pod/',
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const raw = await readFile(args.policyPath);
  if (raw.byteLength > MAX_POLICY_BYTES) throw new Error('Policy file exceeds the 1 MiB safety limit');

  let policy;
  try {
    policy = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Policy file must contain valid JSON');
  }

  const report = evaluateWmsPodStoragePolicy(policy, args);
  report.schema = 'factoryos.wms.storage-policy-shape/v1';
  report.result = report.pass ? 'PASS_POLICY_SHAPE_ONLY' : 'FAIL_POLICY_SHAPE';
  report.policy_sha256 = createHash('sha256').update(raw).digest('hex');
  report.limitations = [
    'This is a static policy-shape check; it does not prove the policy is attached to the deployed runtime identity.',
    'It does not resolve bucket policies, permission boundaries, organization policies, session policies, KMS grants, credential expiry or rotation.',
    'A live staging upload and independent read-back plus an owner-reviewed provider policy export are still required.',
  ];
  delete report.pass;
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'PASS_POLICY_SHAPE_ONLY') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('WMS POD storage policy check failed: ' + error.message);
    process.exitCode = 1;
  });
}
