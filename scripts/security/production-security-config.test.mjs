import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as prettier from 'prettier';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('production security evidence remains explicitly unapproved until operator attestation', async () => {
  const baseline = await read('deploy/security/production-security-baseline.yml');
  assert.match(baseline, /^status: NOT_ATTESTED/m);
  assert.match(baseline, /^\s*auth_mode: oidc$/m);
  assert.match(baseline, /^\s*dev_auth_enabled: false$/m);
  assert.match(baseline, /^\s*require_mfa: true$/m);
  assert.match(baseline, /^\s*applicability: OWNER_DECISION_REQUIRED$/m);
  assert.match(baseline, /^\s*release_approved: false$/m);
  assert.match(baseline, /^\s*all_high_critical_findings_closed: false$/m);
});

test('network policy proposes default-deny and forbids public paths to database, telemetry and OT networks', async () => {
  const policy = await read('deploy/security/network-egress-policy.yml');
  assert.match(policy, /^  ingress: DENY$/m);
  assert.match(policy, /^  egress: DENY$/m);
  for (const path of [
    'public_internet_to_database',
    'public_internet_to_metrics_or_otlp',
    'public_internet_to_ics_ot_network',
    'api_to_arbitrary_internet_without_exception',
  ]) assert.ok(policy.includes(path), 'missing forbidden path ' + path);
  assert.match(policy, /wildcard_internet_access: DENY/);
  assert.match(policy, /expiry_utc/);
});

test('database role evidence script is read-only and reports RLS bypass and privileged memberships', async () => {
  const sql = await read('deploy/security/postgres-role-audit.sql');
  assert.match(sql, /rolsuper/);
  assert.match(sql, /rolcreatedb/);
  assert.match(sql, /rolcreaterole/);
  assert.match(sql, /rolbypassrls/);
  assert.match(sql, /pg_auth_members/);
  assert.match(sql, /role_table_grants/);
  assert.match(sql, /pg_default_acl/);
  assert.doesNotMatch(sql, /^\s*(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\s/im);
});

test('local development PostgreSQL is not bound to all network interfaces', async () => {
  const compose = await read('docker-compose.yml');
  assert.match(compose, /127\.0\.0\.1:5432:5432/);
  assert.doesNotMatch(compose, /-\s*["']?5432:5432["']?/);
});

test('auth code refuses production dev mode and validates provider-signed MFA claim allowlists', async () => {
  const policy = await read('services/api/src/auth/auth-runtime-policy.ts');
  const strategy = await read('services/api/src/auth/strategies/jwt.strategy.ts');
  const authModule = await read('services/api/src/auth/auth.module.ts');
  assert.match(policy, /AUTH_MODE=oidc is required in production/);
  assert.match(policy, /Development authentication is forbidden in production/);
  assert.match(policy, /OIDC_REQUIRE_MFA=true is required in production/);
  assert.match(policy, /requireHttpsUrl\(config\.oidcIssuer/);
  assert.match(strategy, /oidcClaimsMeetMfaPolicy\(payload, this\.runtimePolicy\)/);
  assert.match(authModule, /if \(authMode === 'oidc'\)/);
});

test('production review artifacts do not claim an independent reviewer or completed test without evidence', async () => {
  const record = await read('docs/production-security-configuration-and-independent-review.md');
  assert.match(record, /PENDING_EXTERNAL_REVIEW/);
  assert.match(record, /Independent review has NOT been performed/);
  assert.match(record, /SCIM.*not implemented/i);
  assert.match(record, /release_approved: false|release approved: no/i);
});

test('production backup evidence policy is installed as a deny binding in selected namespaces', async () => {
  const policy = await read('deploy/security/backup-copy-evidence-readonly-policy.yaml');
  const binding = await read('deploy/security/backup-copy-evidence-readonly-binding.yaml');
  assert.match(policy, /kind: ValidatingAdmissionPolicy/);
  assert.match(policy, /failurePolicy: Fail/);
  assert.match(policy, /mount\.readOnly == true/);
  assert.match(policy, /volumeMounts\.filter/);
  assert.match(policy, /volume\.persistentVolumeClaim/);
  assert.match(policy, /factoryos-backup-evidence/);
  assert.match(policy, /persistentVolumeClaim.readOnly == true/);
  assert.match(policy, /object.spec.ephemeralContainers.all/);
  assert.match(binding, /kind: ValidatingAdmissionPolicyBinding/);
  assert.match(binding, /validationActions:\s*\n\s*- Deny/);
  assert.match(binding, /factoryos\.io\/backup-evidence-enforcement: required/);
});

test('backup evidence policy covers ephemeral container injection and namespace lock', async () => {
  const podPolicy = await read('deploy/security/backup-copy-evidence-readonly-policy.yaml');
  const namespacePolicy = await read('deploy/security/backup-copy-evidence-namespace-lock-policy.yaml');
  const namespaceBinding = await read('deploy/security/backup-copy-evidence-namespace-lock-binding.yaml');
  assert.ok(podPolicy.includes('pods/ephemeralcontainers'));
  assert.ok(namespacePolicy.includes('operations: ["UPDATE", "DELETE"]'));
  assert.ok(namespacePolicy.includes("request.operation == 'UPDATE'"));
  assert.match(namespaceBinding, /policyName: factoryos-backup-evidence-namespace-lock/);
  assert.match(namespaceBinding, /- Deny/);
});
test('security baseline and egress YAML parse successfully', async () => {
  for (const path of [
    'deploy/security/production-security-baseline.yml',
    'deploy/security/network-egress-policy.yml',
    'deploy/security/backup-copy-evidence-readonly-policy.yaml',
    'deploy/security/backup-copy-evidence-readonly-binding.yaml',
    'deploy/security/backup-copy-evidence-namespace-lock-policy.yaml',
    'deploy/security/backup-copy-evidence-namespace-lock-binding.yaml',
  ]) {
    await prettier.format(await read(path), { parser: 'yaml' });
  }
});
