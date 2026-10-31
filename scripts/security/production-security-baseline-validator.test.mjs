import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  parseDocument,
  validateSecurityAttestation,
  validateTemplate,
} from './validate-production-security-baseline.mjs';

const now = Date.parse('2026-10-24T12:00:00Z');
const candidateSha = 'a'.repeat(40);
const negativeTestKeys = [
  'api_authz_cross_tenant_read',
  'api_cross_tenant_write',
  'postgres_rls_missing_context',
  'postgres_rls_cross_tenant_write',
  'unauthorized_metrics_scrape',
  'dev_auth_disabled_in_production',
  'invalid_oidc_mfa_claims_denied',
];

// Synthetic evidence values are fixtures only; they are not claims about a live environment.
function negativeTestEvidence(key) {
  return {
    result: 'PASS',
    candidate_sha: candidateSha,
    workflow_url: 'https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/123456789',
    evidence_reference: 'evidence://security/negative-tests/' + key,
    tested_environment: 'isolated-preproduction-eu',
    executed_at_utc: '2026-10-21T09:00:00Z',
  };
}

function validAttestation() {
  return {
    status: 'ATTESTED',
    candidate: {
      git_sha: candidateSha,
      environment: 'factoryos-prod-eu',
      hosting_provider_and_region: 'ApprovedCloud / eu-west',
      deployment_topology: 'dedicated',
      api_replica_count: 3,
      database_service: 'managed-postgres-prod',
      evidence_change_reference: 'https://github.com/RakibulhasanUtsho07/factoryos/issues/900',
    },
    identity: {
      auth_mode: 'oidc',
      dev_auth_enabled: false,
      oidc: {
        issuer: 'https://id.example.com/',
        audience: 'factoryos-api',
        jwks_uri: 'https://id.example.com/.well-known/jwks.json',
        require_mfa: true,
        mfa_amr_values: ['mfa'],
        mfa_acr_values: ['urn:example:loa:2'],
        verified_tls: true,
        idp_mfa_policy_evidence: 'evidence://identity/mfa-policy',
      },
      scim: {
        repository_implementation_present: false,
        applicability: 'NOT_REQUIRED_WITH_APPROVED_ALTERNATIVE',
        identity_provider_scim_enabled: false,
        group_role_mapping_reviewed: false,
        evidence_reference: 'evidence://identity/approved-manual-lifecycle',
      },
    },
    service_identities: {
      api_database_role: {
        name: 'factoryos_app',
        login: true,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        bypassrls: false,
        grants_reviewed_against_table_inventory: true,
      },
      migration_role: {
        distinct_from_runtime_role: true,
        just_in_time_elevation: true,
        credential_source: 'vault://factoryos/migration-role',
        use_window_and_approver_recorded: true,
      },
      monitoring_role: {
        name: 'factoryos_metrics',
        separate_from_runtime_role: true,
        superuser: false,
        bypassrls: false,
        business_table_select: false,
        evidence_reference: 'evidence://database/monitoring-role-audit',
      },
    },
    secrets: {
      manager_provider_and_scope: 'Vault / factoryos-prod',
      no_static_secrets_in_image_or_repository_verified: true,
      runtime_secret_versions_attested: true,
      database_credential_rotation: {
        interval_days: 60,
        last_completed_utc: '2026-10-20T09:00:00Z',
        tested_application_reconnect: true,
        rollback_credential_overlap_expiry_utc: '2027-01-20T09:00:00Z',
      },
      oidc_client_or_workload_credential_rotation: {
        interval_days: 90,
        last_completed_utc: '2026-10-20T09:00:00Z',
        tested_old_credential_revocation: true,
      },
      signing_key_rotation: {
        issuer_owned: true,
        jwks_overlap_and_cache_tested: true,
        evidence_reference: 'evidence://identity/jwks-rotation',
      },
    },
    backup_copy_evidence: {
      deployment_platform: 'Kubernetes v1.30+',
      evidence_root_path: '/var/run/factoryos/backup-evidence',
      evidence_volume_reference: 'evidence-volume://prod/backup-copy-archive',
      deployment_enforcement_reference: 'evidence://deployment/backup-evidence-vap-binding',
      volume_mount_read_only: true,
      api_identity_write_denied: true,
      api_identity_remount_denied: true,
      publisher_identity_separate: true,
      mount_verification: {
        result: 'PASS',
        candidate_sha: candidateSha,
        workflow_url: 'https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/123456789',
        evidence_reference: 'evidence://deployment/mount-probe/exact-candidate',
        tested_environment: 'isolated-preproduction-eu',
        executed_at_utc: '2026-10-21T09:00:00Z',
      },
      deployment_provisioning: {
        result: 'PASS',
        candidate_sha: candidateSha,
        evidence_reference: 'evidence://deployment/provisioning-run/exact-candidate',
        tested_environment: 'isolated-preproduction-eu',
        executed_at_utc: '2026-10-21T10:00:00Z',
        operator_identity: 'PlatformOperator',
        cluster_context: 'isolated-preproduction-eu',
        namespace: 'factoryos-api',
        deployment: 'factoryos-api',
        api_service_account: 'factoryos-backup-evidence-api',
        api_image_reference: 'ghcr.io/rakibulhasanutsho07/factoryos-api@sha256:' + 'a'.repeat(64),
        api_image_digest_verified: true,
        policy_accepted: true,
        bindings_active: true,
        namespace_enrolled: true,
        deployment_ready: true,
        pvc_bound_and_read_only: true,
        all_container_security_contexts_verified: true,
        tokenless_service_account: true,
        api_identity_rbac_absent: true,
        runtime_write_probe_denied: true,
        api_identity_write_denied: true,
        api_identity_remount_denied: true,
        cap_sys_admin_absent: true,
        no_new_privileges: true,
        service_account_token_absent: true,
        negative_admission_probes_passed: true,
        independent_review: {
          reviewer_identity: 'IndependentInfrastructureReviewer',
          reviewer_organization: 'ExternalSecurityFirm',
          scope_includes_mount_and_identity_boundary: true,
          evidence_reference: 'evidence://deployment/independent-infrastructure-review',
          executed_at_utc: '2026-10-21T11:00:00Z',
        },
      },
    },
    network: {
      default_deny_ingress: true,
      default_deny_egress: true,
      api_ingress_restricted_to_trusted_edge: true,
      database_private_only: true,
      metrics_and_otlp_private_only: true,
      production_egress_allowlist_reviewed: true,
      no_public_route_to_ot_networks: true,
      evidence_reference: 'evidence://network/approved-policy-and-denials',
    },
    security_validation: {
      dependency_audit: {
        workflow_url: 'https://github.com/RakibulhasanUtsho07/factoryos/actions/runs/40071027236',
        candidate_sha: candidateSha,
        result: 'SUCCESS',
      },
      tenant_negative_tests: Object.fromEntries(
        negativeTestKeys.map((key) => [key, negativeTestEvidence(key)]),
      ),
      external_review: {
        reviewer_identity: 'IndependentReviewer',
        reviewer_organization: 'ExternalSecurityFirm',
        independence_conflict_check: 'PASS',
        authorization_reference: 'evidence://security/scope-authorization',
        scope_and_exclusions_approved: true,
        executed_at_utc: '2026-10-21T09:00:00Z',
        report_reference: 'evidence://security/review-report',
        all_high_critical_findings_closed: true,
      },
    },
    release: {
      operator: 'OpsOwner',
      approver: 'ReleaseApprover',
      approval_reference: 'evidence://release/approval-record',
      rollback_artifact_and_procedure: 'artifact://release/rollback-and-recovery',
      rollback_drill_reference: 'evidence://release/rollback-drill',
      release_approved: true,
    },
  };
}

test('checked-in security baseline remains an explicitly unattested template', async () => {
  const source = await readFile(new URL('../../deploy/security/production-security-baseline.yml', import.meta.url), 'utf8');
  const document = parseDocument(source);
  assert.deepEqual(validateTemplate(document), []);
});

test('parser rejects duplicate YAML keys rather than accepting ambiguous evidence', () => {
  assert.throws(() => parseDocument('status: NOT_ATTESTED\nstatus: ATTESTED\n'));
});

test('complete security evidence passes only when tied to the exact candidate SHA', () => {
  assert.deepEqual(validateSecurityAttestation(validAttestation(), candidateSha, now), []);
});

test('backup evidence deployment must be read-only, independently published and bound to the candidate', async (t) => {
  await t.test('rejects a writable evidence mount', () => {
    const evidence = validAttestation();
    evidence.backup_copy_evidence.volume_mount_read_only = false;
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('backup_copy_evidence.volume_mount_read_only must equal true')));
  });

  await t.test('rejects API identity write or remount permission', () => {
    const writable = validAttestation();
    writable.backup_copy_evidence.api_identity_write_denied = false;
    assert.ok(validateSecurityAttestation(writable, candidateSha, now).some((error) => error.includes('api_identity_write_denied must equal true')));
    const remountable = validAttestation();
    remountable.backup_copy_evidence.api_identity_remount_denied = false;
    assert.ok(validateSecurityAttestation(remountable, candidateSha, now).some((error) => error.includes('api_identity_remount_denied must equal true')));
  });

  await t.test('rejects a publisher running under the API identity', () => {
    const evidence = validAttestation();
    evidence.backup_copy_evidence.publisher_identity_separate = false;
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('publisher_identity_separate must equal true')));
  });

  await t.test('rejects mount evidence for another candidate SHA', () => {
    const evidence = validAttestation();
    evidence.backup_copy_evidence.mount_verification.candidate_sha = 'b'.repeat(40);
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('mount_verification.candidate_sha must match')));
  });

  await t.test('rejects missing runtime mount evidence', () => {
    const evidence = validAttestation();
    evidence.backup_copy_evidence.mount_verification.result = 'NOT_RUN';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('mount_verification.result must equal "PASS"')));
  });

  await t.test('deployment provisioning evidence is required, exact-SHA-bound and independently reviewed', () => {
    const missing = validAttestation();
    missing.backup_copy_evidence.deployment_provisioning.result = 'NOT_RUN';
    assert.ok(validateSecurityAttestation(missing, candidateSha, now).some((error) => error.includes('deployment_provisioning.result must equal "PASS"')));
    const wrongSha = validAttestation();
    wrongSha.backup_copy_evidence.deployment_provisioning.candidate_sha = 'b'.repeat(40);
    assert.ok(validateSecurityAttestation(wrongSha, candidateSha, now).some((error) => error.includes('deployment_provisioning.candidate_sha must match')));
    const writeAllowed = validAttestation();
    writeAllowed.backup_copy_evidence.deployment_provisioning.api_identity_write_denied = false;
    assert.ok(validateSecurityAttestation(writeAllowed, candidateSha, now).some((error) => error.includes('deployment_provisioning.api_identity_write_denied must equal true')));
    const remountAllowed = validAttestation();
    remountAllowed.backup_copy_evidence.deployment_provisioning.api_identity_remount_denied = false;
    assert.ok(validateSecurityAttestation(remountAllowed, candidateSha, now).some((error) => error.includes('deployment_provisioning.api_identity_remount_denied must equal true')));
    const unsafe = validAttestation();
    unsafe.backup_copy_evidence.deployment_provisioning.cap_sys_admin_absent = false;
    assert.ok(validateSecurityAttestation(unsafe, candidateSha, now).some((error) => error.includes('deployment_provisioning.cap_sys_admin_absent must equal true')));
    const sameReviewer = validAttestation();
    sameReviewer.backup_copy_evidence.deployment_provisioning.independent_review.reviewer_identity = 'PlatformOperator';
    assert.ok(validateSecurityAttestation(sameReviewer, candidateSha, now).some((error) => error.includes('must differ from the provisioning operator')));
    const mutableImage = validAttestation();
    mutableImage.backup_copy_evidence.deployment_provisioning.api_image_reference = 'ghcr.io/factoryos/api:latest';
    assert.ok(validateSecurityAttestation(mutableImage, candidateSha, now).some((error) => error.includes('api_image_reference must be pinned')));
    const wrongIdentity = validAttestation();
    wrongIdentity.backup_copy_evidence.deployment_provisioning.api_service_account = 'default';
    assert.ok(validateSecurityAttestation(wrongIdentity, candidateSha, now).some((error) => error.includes('api_service_account must equal "factoryos-backup-evidence-api"')));
  });

  await t.test('rejects relative or root-only evidence paths', () => {
    const relative = validAttestation();
    relative.backup_copy_evidence.evidence_root_path = 'var/run/evidence';
    assert.ok(validateSecurityAttestation(relative, candidateSha, now).some((error) => error.includes('non-root absolute POSIX path')));
    const rootOnly = validAttestation();
    rootOnly.backup_copy_evidence.evidence_root_path = '/';
    assert.ok(validateSecurityAttestation(rootOnly, candidateSha, now).some((error) => error.includes('non-root absolute POSIX path')));
  });
});

test('incomplete or contradictory security evidence fails closed', async (t) => {
  await t.test('rejects abbreviated candidate SHA', () => {
    const evidence = validAttestation();
    evidence.candidate.git_sha = candidateSha.slice(0, 12);
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('candidate.git_sha must be a full 40-character')));
  });

  await t.test('rejects a different expected candidate SHA', () => {
    assert.ok(validateSecurityAttestation(validAttestation(), 'b'.repeat(40), now).some((error) => error.includes('candidate.git_sha must match')));
  });

  await t.test('rejects production dev-auth mode', () => {
    const evidence = validAttestation();
    evidence.identity.dev_auth_enabled = true;
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('identity.dev_auth_enabled must equal false')));
  });

  await t.test('rejects non-HTTPS identity provider endpoints', () => {
    const evidence = validAttestation();
    evidence.identity.oidc.issuer = 'http://id.example.com/';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('identity.oidc.issuer must be an HTTPS URL')));
  });

  await t.test('rejects unresolved SCIM applicability', () => {
    const evidence = validAttestation();
    evidence.identity.scim.applicability = 'OWNER_DECISION_REQUIRED';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('owner-approved applicability decision')));
  });

  await t.test('rejects RLS-bypass database role', () => {
    const evidence = validAttestation();
    evidence.service_identities.api_database_role.bypassrls = true;
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('api_database_role.bypassrls must equal false')));
  });

  await t.test('rejects dependency evidence from another SHA', () => {
    const evidence = validAttestation();
    evidence.security_validation.dependency_audit.candidate_sha = 'b'.repeat(40);
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('dependency_audit.candidate_sha must equal')));
  });

  await t.test('rejects missing tenant-negative-test outcomes', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.postgres_rls_missing_context.result = 'NOT_RUN';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('postgres_rls_missing_context.result must equal "PASS"')));
  });

  await t.test('rejects a legacy bare PASS string without provenance', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.api_authz_cross_tenant_read = 'PASS';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('api_authz_cross_tenant_read must be a structured evidence record')));
  });

  await t.test('rejects a negative-test record bound to another candidate SHA', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.api_cross_tenant_write.candidate_sha = 'b'.repeat(40);
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('api_cross_tenant_write.candidate_sha must match')));
  });

  await t.test('rejects a test workflow link outside this repository Actions runs', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.postgres_rls_missing_context.workflow_url = 'https://example.com/results/123';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('postgres_rls_missing_context.workflow_url must identify this repository GitHub Actions run')));
  });

  await t.test('rejects missing evidence references and test environment identity', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.api_authz_cross_tenant_read.evidence_reference = '';
    evidence.security_validation.tenant_negative_tests.api_cross_tenant_write.tested_environment = ' ';
    const errors = validateSecurityAttestation(evidence, candidateSha, now);
    assert.ok(errors.some((error) => error.includes('api_authz_cross_tenant_read.evidence_reference must be a non-empty string')));
    assert.ok(errors.some((error) => error.includes('api_cross_tenant_write.tested_environment must be a non-empty string')));
  });

  await t.test('rejects future test evidence timestamps', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.invalid_oidc_mfa_claims_denied.executed_at_utc = '2027-10-21T09:00:00Z';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('invalid_oidc_mfa_claims_denied.executed_at_utc must be a valid UTC timestamp that is not in the future')));
  });

  await t.test('rejects evidence references that embed credentials', () => {
    const evidence = validAttestation();
    evidence.security_validation.tenant_negative_tests.api_cross_tenant_write.evidence_reference = 'artifact:token=secret-value';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('api_cross_tenant_write.evidence_reference must be an opaque reference')));
  });

  await t.test('rejects expired credential overlap window', () => {
    const evidence = validAttestation();
    evidence.secrets.database_credential_rotation.rollback_credential_overlap_expiry_utc = '2026-10-23T09:00:00Z';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('must be a valid future UTC timestamp')));
  });

  await t.test('rejects release approval without rollback drill evidence', () => {
    const evidence = validAttestation();
    evidence.release.rollback_drill_reference = '';
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('release.rollback_drill_reference must be a non-empty string')));
  });

  await t.test('rejects implementer/operator also acting as approver', () => {
    const evidence = validAttestation();
    evidence.release.approver = evidence.release.operator;
    assert.ok(validateSecurityAttestation(evidence, candidateSha, now).some((error) => error.includes('must be different people')));
  });
});
