#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const EXPECTED_SMOKE_RESULT =
  'PASS_FOR_CONFIGURED_STORAGE_AND_FACTORYOS_RECEIVER_CONTRACT_ONLY';
const MIN_SECRET_LENGTH = 8;

function parseObject(text, name) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(name + ' must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(name + ' must be a JSON object');
  }
  return value;
}

/**
 * Checks evidence redaction and prevents this smoke from overclaiming live
 * carrier provenance or effective provider IAM. Not a cryptographic certification.
 */
export function auditProviderEvidenceArtifacts({ evidenceText, policyReportText, secrets = {} }) {
  const evidence = parseObject(evidenceText, 'Provider evidence');
  const policyReport = parseObject(policyReportText, 'Storage policy report');
  const issues = [];

  if (evidence.credentials_recorded !== false || evidence.secret_values_recorded !== false) {
    issues.push('EVIDENCE_SECRET_FLAGS_NOT_FALSE');
  }
  if (evidence.result !== EXPECTED_SMOKE_RESULT) {
    issues.push('UNEXPECTED_OR_OVERCLAIMED_PROVIDER_SMOKE_RESULT');
  }
  if (evidence.evidence?.carrier_sandbox_origin !== 'NOT_PROVEN') {
    issues.push('CARRIER_ORIGIN_MUST_REMAIN_NOT_PROVEN');
  }
  if (evidence.evidence?.storage_iam_least_privilege_review !== 'NOT_VERIFIED_BY_SCRIPT') {
    issues.push('EFFECTIVE_STORAGE_IAM_MUST_REMAIN_UNVERIFIED_BY_SCRIPT');
  }
  if (policyReport.result !== 'PASS_POLICY_SHAPE_ONLY') {
    issues.push('STORAGE_POLICY_SHAPE_CHECK_DID_NOT_PASS');
  }
  if (!Array.isArray(policyReport.limitations) ||
      !policyReport.limitations.some((item) =>
        typeof item === 'string' && item.includes('does not prove the policy is attached'))) {
    issues.push('STORAGE_POLICY_REPORT_LIMITATIONS_MISSING');
  }

  const serialized = evidenceText + '\n' + policyReportText;
  for (const value of Object.values(secrets)) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && serialized.includes(value)) {
      issues.push('CONFIGURED_SECRET_VALUE_FOUND_IN_ARTIFACT');
      break;
    }
  }
  if (/\bAKIA[0-9A-Z]{16}\b/.test(serialized)) issues.push('AWS_ACCESS_KEY_ID_PATTERN_FOUND');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/.test(serialized)) {
    issues.push('PRIVATE_KEY_MATERIAL_FOUND');
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(serialized)) {
    issues.push('BEARER_CREDENTIAL_PATTERN_FOUND');
  }

  return {
    pass: issues.length === 0,
    issues,
    evidence_result: evidence.result ?? 'MISSING',
    carrier_origin: evidence.evidence?.carrier_sandbox_origin ?? 'MISSING',
    effective_storage_iam: 'NOT_VERIFIED_BY_SCRIPT',
    policy_shape_result: policyReport.result ?? 'MISSING',
    secret_values_recorded: false,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const paths = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--evidence', '--policy-report'].includes(key)) {
      throw new Error('Usage: node wms-provider-evidence-safety-check.mjs --evidence <evidence.json> --policy-report <report.json>');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + key);
    paths[key] = value;
    index += 1;
  }
  if (!paths['--evidence'] || !paths['--policy-report']) {
    throw new Error('Usage: node wms-provider-evidence-safety-check.mjs --evidence <evidence.json> --policy-report <report.json>');
  }
  const [evidenceText, policyReportText] = await Promise.all([
    readFile(resolve(paths['--evidence']), 'utf8'),
    readFile(resolve(paths['--policy-report']), 'utf8'),
  ]);
  const report = auditProviderEvidenceArtifacts({
    evidenceText,
    policyReportText,
    secrets: {
      FACTORYOS_CERT_WEBHOOK_SECRET: process.env.FACTORYOS_CERT_WEBHOOK_SECRET,
      FACTORYOS_CERT_BEARER_TOKEN: process.env.FACTORYOS_CERT_BEARER_TOKEN,
      FACTORYOS_CERT_READONLY_BEARER_TOKEN: process.env.FACTORYOS_CERT_READONLY_BEARER_TOKEN,
    },
  });
  // Never print evidence contents, policy JSON or credential values.
  console.log(JSON.stringify({
    schema: 'factoryos.wms.provider-evidence-safety/v1',
    result: report.pass ? 'PASS_EVIDENCE_REDACTION_AND_BOUNDARY_CHECK' : 'FAIL_EVIDENCE_REDACTION_AND_BOUNDARY_CHECK',
    ...report,
  }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('WMS provider evidence safety check failed: ' +
      (error instanceof Error ? error.message : 'unknown error'));
    process.exitCode = 1;
  });
}
