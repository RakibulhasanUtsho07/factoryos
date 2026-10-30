#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const DEFAULT_TEMPLATE = 'deploy/security/production-security-baseline.yml';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function getAt(object, path) {
  return path.split('.').reduce((value, key) => (
    value !== null && typeof value === 'object' ? value[key] : undefined
  ), object);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validUtc(value) {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value.replace(/\.\d+Z$/, 'Z').replace(/Z$/, ''));
}

function validHttpsUrl(value) {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 &&
      url.username.length === 0 && url.password.length === 0 && url.hash.length === 0;
  } catch {
    return false;
  }
}

function isGitHubActionsRunUrl(value) {
  if (!validHttpsUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.hostname === 'github.com' && url.search.length === 0 &&
      /^\/RakibulhasanUtsho07\/factoryos\/actions\/runs\/[1-9][0-9]*$/.test(url.pathname);
  } catch {
    return false;
  }
}

function safeEvidenceReference(value) {
  return hasText(value) && value.length <= 500 &&
    !/(?:password|secret|credential|access[-_]?key|token)\s*[:=]/i.test(value) &&
    !/https?:\/\/[^/\s:@]+:[^@/\s]+@/i.test(value);
}

export function parseDocument(source) {
  const document = yaml.safeLoad(source, { schema: yaml.DEFAULT_SAFE_SCHEMA });
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Security evidence document must be a YAML mapping');
  }
  return document;
}

/**
 * The checked-in YAML is only a template. This mode ensures edits cannot
 * accidentally turn the example into a claim of production attestation.
 */
export function validateTemplate(document) {
  const errors = [];
  const expect = (path, expected) => {
    if (getAt(document, path) !== expected) {
      errors.push(path + ' must remain ' + JSON.stringify(expected) + ' in the template');
    }
  };
  const expectEmpty = (path) => expect(path, '');
  const expectFalse = (path) => expect(path, false);

  expect('status', 'NOT_ATTESTED');
  for (const path of [
    'candidate.git_sha',
    'candidate.environment',
    'candidate.hosting_provider_and_region',
    'candidate.deployment_topology',
    'candidate.database_service',
    'candidate.evidence_change_reference',
    'identity.oidc.issuer',
    'identity.oidc.audience',
    'identity.oidc.jwks_uri',
    'identity.oidc.idp_mfa_policy_evidence',
    'identity.scim.evidence_reference',
    'service_identities.api_database_role.name',
    'service_identities.migration_role.credential_source',
    'service_identities.monitoring_role.name',
    'service_identities.monitoring_role.evidence_reference',
    'secrets.manager_provider_and_scope',
    'network.evidence_reference',
    'backup_copy_evidence.deployment_platform',
    'backup_copy_evidence.evidence_root_path',
    'backup_copy_evidence.evidence_volume_reference',
    'backup_copy_evidence.deployment_enforcement_reference',
    'backup_copy_evidence.mount_verification.candidate_sha',
    'backup_copy_evidence.mount_verification.workflow_url',
    'backup_copy_evidence.mount_verification.evidence_reference',
    'backup_copy_evidence.mount_verification.tested_environment',
    'backup_copy_evidence.mount_verification.executed_at_utc',
    'security_validation.dependency_audit.workflow_url',
    'security_validation.dependency_audit.candidate_sha',
    'identity.oidc.issuer',
    'identity.oidc.audience',
    'identity.oidc.jwks_uri',
    'release.operator',
    'release.approver',
    'release.approval_reference',
    'release.rollback_artifact_and_procedure',
    'release.rollback_drill_reference',
  ]) expectEmpty(path);

  expect('candidate.api_replica_count', null);
  expect('identity.auth_mode', 'oidc');
  expectFalse('identity.dev_auth_enabled');
  expect('identity.oidc.require_mfa', true);
  expectFalse('identity.oidc.verified_tls');
  expectFalse('identity.scim.repository_implementation_present');
  expect('identity.scim.applicability', 'OWNER_DECISION_REQUIRED');

  for (const path of [
    'service_identities.api_database_role.superuser',
    'service_identities.api_database_role.createdb',
    'service_identities.api_database_role.createrole',
    'service_identities.api_database_role.replication',
    'service_identities.api_database_role.bypassrls',
    'service_identities.api_database_role.grants_reviewed_against_table_inventory',
    'service_identities.migration_role.use_window_and_approver_recorded',
    'service_identities.monitoring_role.superuser',
    'service_identities.monitoring_role.bypassrls',
    'service_identities.monitoring_role.business_table_select',
    'secrets.no_static_secrets_in_image_or_repository_verified',
    'secrets.runtime_secret_versions_attested',
    'network.default_deny_ingress',
    'network.default_deny_egress',
    'network.api_ingress_restricted_to_trusted_edge',
    'network.database_private_only',
    'network.metrics_and_otlp_private_only',
    'network.production_egress_allowlist_reviewed',
    'network.no_public_route_to_ot_networks',
    'backup_copy_evidence.volume_mount_read_only',
    'backup_copy_evidence.api_identity_write_denied',
    'backup_copy_evidence.api_identity_remount_denied',
    'backup_copy_evidence.publisher_identity_separate',
    'identity.scim.group_role_mapping_reviewed',
    'identity.scim.identity_provider_scim_enabled',
    'secrets.database_credential_rotation.tested_application_reconnect',
    'secrets.oidc_client_or_workload_credential_rotation.tested_old_credential_revocation',
    'secrets.signing_key_rotation.jwks_overlap_and_cache_tested',
    'release.release_approved',
  ]) expectFalse(path);

  expect('backup_copy_evidence.mount_verification.result', 'NOT_RUN');
  expect('security_validation.dependency_audit.result', 'NOT_RUN');
  const templateNegativeTests = getAt(document, 'security_validation.tenant_negative_tests') ?? {};
  for (const key of [
    'api_authz_cross_tenant_read',
    'api_cross_tenant_write',
    'postgres_rls_missing_context',
    'postgres_rls_cross_tenant_write',
    'unauthorized_metrics_scrape',
    'dev_auth_disabled_in_production',
    'invalid_oidc_mfa_claims_denied',
  ]) {
    const path = 'security_validation.tenant_negative_tests.' + key;
    expect(path + '.result', 'NOT_RUN');
    for (const field of ['candidate_sha', 'workflow_url', 'evidence_reference', 'tested_environment', 'executed_at_utc']) {
      expect(path + '.' + field, '');
    }
  }
  if (Object.keys(templateNegativeTests).length !== 7) {
    errors.push('security_validation.tenant_negative_tests must retain exactly the seven required evidence records');
  }
  expect('security_validation.external_review.independence_conflict_check', 'NOT_RUN');
  expectFalse('security_validation.external_review.scope_and_exclusions_approved');
  expectEmpty('security_validation.external_review.reviewer_identity');
  expectEmpty('security_validation.external_review.reviewer_organization');
  expectEmpty('security_validation.external_review.authorization_reference');
  expectEmpty('security_validation.external_review.executed_at_utc');
  expectEmpty('security_validation.external_review.report_reference');
  expectFalse('security_validation.external_review.all_high_critical_findings_closed');
  expectFalse('release.release_approved');

  for (const path of [
    'secrets.database_credential_rotation.interval_days',
    'secrets.database_credential_rotation.last_completed_utc',
    'secrets.database_credential_rotation.rollback_credential_overlap_expiry_utc',
    'secrets.oidc_client_or_workload_credential_rotation.interval_days',
    'secrets.oidc_client_or_workload_credential_rotation.last_completed_utc',
  ]) {
    if (getAt(document, path) !== null && getAt(document, path) !== '') {
      errors.push(path + ' must remain blank/null in the checked-in template');
    }
  }

  return errors;
}

/**
 * Validates a completed operator-supplied attestation. A green result means
 * evidence is complete and internally consistent; it does not replace the
 * required human release approval captured in this same attestation.
 */
export function validateSecurityAttestation(document, expectedSha, now = Date.now()) {
  const errors = [];
  const string = (path, { allowEmpty = false } = {}) => {
    const value = getAt(document, path);
    if (typeof value !== 'string' || (!allowEmpty && !hasText(value))) {
      errors.push(path + ' must be ' + (allowEmpty ? 'a string' : 'a non-empty string'));
    }
    return value;
  };
  const equals = (path, expected) => {
    if (getAt(document, path) !== expected) {
      errors.push(path + ' must equal ' + JSON.stringify(expected));
    }
  };
  const bool = (path, expected = true) => equals(path, expected);
  const positiveInteger = (path) => {
    const value = getAt(document, path);
    if (!Number.isSafeInteger(value) || value <= 0) errors.push(path + ' must be a positive integer');
    return value;
  };
  const utc = (path) => {
    const value = string(path);
    if (typeof value === 'string' && (!validUtc(value) || Date.parse(value) > now)) {
      errors.push(path + ' must be a valid UTC timestamp that is not in the future');
    }
  };
  const futureUtc = (path) => {
    const value = string(path);
    if (typeof value === 'string' && (!validUtc(value) || Date.parse(value) <= now)) {
      errors.push(path + ' must be a valid future UTC timestamp');
    }
  };
  const https = (path) => {
    const value = string(path);
    if (typeof value === 'string' && !validHttpsUrl(value)) {
      errors.push(path + ' must be an HTTPS URL without embedded credentials or a fragment');
    }
  };
  const nonEmptyArray = (path) => {
    const value = getAt(document, path);
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => !hasText(item))) {
      errors.push(path + ' must be a non-empty array of non-empty strings');
    }
  };
  const reference = (path) => string(path);

  if (!SHA_PATTERN.test(expectedSha ?? '')) {
    errors.push('expected candidate SHA must be a full 40-character lowercase Git SHA');
  }
  equals('status', 'ATTESTED');
  const candidateSha = string('candidate.git_sha');
  if (typeof candidateSha === 'string' && !SHA_PATTERN.test(candidateSha)) {
    errors.push('candidate.git_sha must be a full 40-character lowercase Git SHA');
  }
  if (typeof candidateSha === 'string' && SHA_PATTERN.test(expectedSha ?? '') && candidateSha !== expectedSha) {
    errors.push('candidate.git_sha must match the expected immutable candidate SHA');
  }
  for (const path of [
    'candidate.environment',
    'candidate.hosting_provider_and_region',
    'candidate.deployment_topology',
    'candidate.database_service',
    'candidate.evidence_change_reference',
  ]) string(path);
  positiveInteger('candidate.api_replica_count');

  equals('identity.auth_mode', 'oidc');
  bool('identity.dev_auth_enabled', false);
  bool('identity.oidc.require_mfa');
  for (const path of ['identity.oidc.issuer', 'identity.oidc.jwks_uri']) https(path);
  string('identity.oidc.audience');
  bool('identity.oidc.verified_tls');
  nonEmptyArray('identity.oidc.mfa_amr_values');
  nonEmptyArray('identity.oidc.mfa_acr_values');
  reference('identity.oidc.idp_mfa_policy_evidence');

  const scimApplicability = getAt(document, 'identity.scim.applicability');
  if (!['REQUIRED', 'NOT_REQUIRED_WITH_APPROVED_ALTERNATIVE'].includes(scimApplicability)) {
    errors.push('identity.scim.applicability must be an owner-approved applicability decision');
  }
  if (scimApplicability === 'REQUIRED') {
    bool('identity.scim.repository_implementation_present');
    bool('identity.scim.identity_provider_scim_enabled');
    bool('identity.scim.group_role_mapping_reviewed');
  } else if (scimApplicability === 'NOT_REQUIRED_WITH_APPROVED_ALTERNATIVE') {
    bool('identity.scim.repository_implementation_present', false);
    bool('identity.scim.identity_provider_scim_enabled', false);
  }
  reference('identity.scim.evidence_reference');

  string('service_identities.api_database_role.name');
  bool('service_identities.api_database_role.login');
  for (const path of [
    'service_identities.api_database_role.superuser',
    'service_identities.api_database_role.createdb',
    'service_identities.api_database_role.createrole',
    'service_identities.api_database_role.replication',
    'service_identities.api_database_role.bypassrls',
  ]) bool(path, false);
  bool('service_identities.api_database_role.grants_reviewed_against_table_inventory');

  bool('service_identities.migration_role.distinct_from_runtime_role');
  bool('service_identities.migration_role.just_in_time_elevation');
  string('service_identities.migration_role.credential_source');
  bool('service_identities.migration_role.use_window_and_approver_recorded');

  bool('service_identities.monitoring_role.separate_from_runtime_role');
  bool('service_identities.monitoring_role.superuser', false);
  bool('service_identities.monitoring_role.bypassrls', false);
  bool('service_identities.monitoring_role.business_table_select', false);
  reference('service_identities.monitoring_role.evidence_reference');

  string('secrets.manager_provider_and_scope');
  bool('secrets.no_static_secrets_in_image_or_repository_verified');
  bool('secrets.runtime_secret_versions_attested');
  positiveInteger('secrets.database_credential_rotation.interval_days');
  utc('secrets.database_credential_rotation.last_completed_utc');
  bool('secrets.database_credential_rotation.tested_application_reconnect');
  futureUtc('secrets.database_credential_rotation.rollback_credential_overlap_expiry_utc');
  positiveInteger('secrets.oidc_client_or_workload_credential_rotation.interval_days');
  utc('secrets.oidc_client_or_workload_credential_rotation.last_completed_utc');
  bool('secrets.oidc_client_or_workload_credential_rotation.tested_old_credential_revocation');
  bool('secrets.signing_key_rotation.issuer_owned');
  bool('secrets.signing_key_rotation.jwks_overlap_and_cache_tested');
  reference('secrets.signing_key_rotation.evidence_reference');

  for (const path of [
    'network.default_deny_ingress',
    'network.default_deny_egress',
    'network.api_ingress_restricted_to_trusted_edge',
    'network.database_private_only',
    'network.metrics_and_otlp_private_only',
    'network.production_egress_allowlist_reviewed',
    'network.no_public_route_to_ot_networks',
  ]) bool(path);
  reference('network.evidence_reference');

  string('backup_copy_evidence.deployment_platform');
  const evidenceRootPath = string('backup_copy_evidence.evidence_root_path');
  if (typeof evidenceRootPath === 'string' &&
      (!evidenceRootPath.startsWith('/') || evidenceRootPath === '/' || evidenceRootPath.includes('\\0') ||
       evidenceRootPath.includes('\\n') || evidenceRootPath.includes('\\r'))) {
    errors.push('backup_copy_evidence.evidence_root_path must be a non-root absolute POSIX path');
  }
  reference('backup_copy_evidence.evidence_volume_reference');
  reference('backup_copy_evidence.deployment_enforcement_reference');
  bool('backup_copy_evidence.volume_mount_read_only');
  bool('backup_copy_evidence.api_identity_write_denied');
  bool('backup_copy_evidence.api_identity_remount_denied');
  bool('backup_copy_evidence.publisher_identity_separate');
  equals('backup_copy_evidence.mount_verification.result', 'PASS');
  const mountVerificationSha = string('backup_copy_evidence.mount_verification.candidate_sha');
  if (typeof mountVerificationSha === 'string' && !SHA_PATTERN.test(mountVerificationSha)) {
    errors.push('backup_copy_evidence.mount_verification.candidate_sha must be a full 40-character lowercase Git SHA');
  }
  if (typeof mountVerificationSha === 'string' && SHA_PATTERN.test(expectedSha ?? '') && mountVerificationSha !== expectedSha) {
    errors.push('backup_copy_evidence.mount_verification.candidate_sha must match the expected immutable candidate SHA');
  }
  const mountWorkflowUrl = string('backup_copy_evidence.mount_verification.workflow_url');
  if (typeof mountWorkflowUrl === 'string' && !isGitHubActionsRunUrl(mountWorkflowUrl)) {
    errors.push('backup_copy_evidence.mount_verification.workflow_url must identify this repository GitHub Actions run');
  }
  const mountEvidenceReference = string('backup_copy_evidence.mount_verification.evidence_reference');
  if (typeof mountEvidenceReference === 'string' && !safeEvidenceReference(mountEvidenceReference)) {
    errors.push('backup_copy_evidence.mount_verification.evidence_reference must be an opaque reference without embedded credentials');
  }
  string('backup_copy_evidence.mount_verification.tested_environment');
  utc('backup_copy_evidence.mount_verification.executed_at_utc');

  https('security_validation.dependency_audit.workflow_url');
  equals('security_validation.dependency_audit.candidate_sha', expectedSha);
  equals('security_validation.dependency_audit.result', 'SUCCESS');
  const negativeTests = getAt(document, 'security_validation.tenant_negative_tests');
  if (negativeTests === null || typeof negativeTests !== 'object' || Array.isArray(negativeTests)) {
    errors.push('security_validation.tenant_negative_tests must be a mapping');
  } else {
    const requiredTests = [
      'api_authz_cross_tenant_read',
      'api_cross_tenant_write',
      'postgres_rls_missing_context',
      'postgres_rls_cross_tenant_write',
      'unauthorized_metrics_scrape',
      'dev_auth_disabled_in_production',
      'invalid_oidc_mfa_claims_denied',
    ];
    for (const key of requiredTests) {
      const path = 'security_validation.tenant_negative_tests.' + key;
      const evidence = getAt(document, path);
      if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
        errors.push(path + ' must be a structured evidence record');
        continue;
      }
      equals(path + '.result', 'PASS');
      const testSha = string(path + '.candidate_sha');
      if (typeof testSha === 'string' && !SHA_PATTERN.test(testSha)) {
        errors.push(path + '.candidate_sha must be a full 40-character lowercase Git SHA');
      }
      if (typeof testSha === 'string' && SHA_PATTERN.test(expectedSha ?? '') && testSha !== expectedSha) {
        errors.push(path + '.candidate_sha must match the expected immutable candidate SHA');
      }
      const workflowUrl = string(path + '.workflow_url');
      if (typeof workflowUrl === 'string' && !isGitHubActionsRunUrl(workflowUrl)) {
        errors.push(path + '.workflow_url must identify this repository GitHub Actions run');
      }
      const evidenceReference = string(path + '.evidence_reference');
      if (typeof evidenceReference === 'string' && !safeEvidenceReference(evidenceReference)) {
        errors.push(path + '.evidence_reference must be an opaque reference without embedded credentials');
      }
      string(path + '.tested_environment');
      utc(path + '.executed_at_utc');
    }
    for (const key of Object.keys(negativeTests)) {
      if (!requiredTests.includes(key)) errors.push('security_validation.tenant_negative_tests contains unsupported evidence key ' + key);
    }
  }

  string('security_validation.external_review.reviewer_identity');
  string('security_validation.external_review.reviewer_organization');
  equals('security_validation.external_review.independence_conflict_check', 'PASS');
  string('security_validation.external_review.authorization_reference');
  bool('security_validation.external_review.scope_and_exclusions_approved');
  utc('security_validation.external_review.executed_at_utc');
  reference('security_validation.external_review.report_reference');
  bool('security_validation.external_review.all_high_critical_findings_closed');

  for (const path of [
    'release.operator',
    'release.approver',
    'release.approval_reference',
    'release.rollback_artifact_and_procedure',
    'release.rollback_drill_reference',
  ]) string(path);
  if (getAt(document, 'release.operator') === getAt(document, 'release.approver')) {
    errors.push('release.operator and release.approver must be different people');
  }
  bool('release.release_approved');

  return errors;
}

async function loadDocument(path) {
  const source = await readFile(resolve(path), 'utf8');
  return parseDocument(source);
}

async function main(argv) {
  const [mode, ...args] = argv;
  try {
    if (mode === '--check-template') {
      const document = await loadDocument(args[0] ?? DEFAULT_TEMPLATE);
      const errors = validateTemplate(document);
      if (errors.length) {
        for (const error of errors) console.error('FAIL: ' + error);
        process.exitCode = 1;
        return;
      }
      console.log('PASS: production security baseline remains an explicitly unattested template');
      return;
    }
    if (mode === '--release-gate') {
      const [file, expectedSha] = args;
      if (!file || !expectedSha) {
        console.error('Usage: validate-production-security-baseline.mjs --release-gate <attestation.yml> <candidate-sha>');
        process.exitCode = 2;
        return;
      }
      const document = await loadDocument(file);
      const errors = validateSecurityAttestation(document, expectedSha);
      if (errors.length) {
        console.error('NOT READY: production security attestation is incomplete or inconsistent');
        for (const error of errors) console.error(' - ' + error);
        process.exitCode = 1;
        return;
      }
      console.log('PASS: required production security evidence is complete and bound to candidate ' + expectedSha);
      return;
    }
    console.error('Usage: validate-production-security-baseline.mjs --check-template [template.yml] | --release-gate <attestation.yml> <candidate-sha>');
    process.exitCode = 2;
  } catch (error) {
    console.error('FAIL: could not validate production security evidence: ' + error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2));
}
