import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  digestSaasBackupProviderAcceptanceScenarios,
  digestSaasBackupProviderAcceptanceScope,
  NormalizedBackupProviderAcceptanceScenario,
  SaasTenantBackupProviderAcceptanceService,
} from './saas-tenant-backup-provider-acceptance.service';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';
import { SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS } from './dto/create-saas-backup-provider-acceptance.dto';

const tenant = 'a1000000-0000-4000-8000-000000000001';
const submittedBy = 'a2000000-0000-4000-8000-000000000001';
const reviewedBy = 'a2000000-0000-4000-8000-000000000002';
const acceptanceId = 'a3000000-0000-4000-8000-000000000001';
const configReference = 'backup-storage-erasure.v1';
const providerReference = 'aws-account-archive-primary';
const providerScopeReference = 'aws-account-000000000000:factoryos-backups:us-east-1';

const config = new ConfigService({
  FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE: configReference,
  FACTORYOS_BACKUP_STORAGE_PROVIDER_REFERENCE: providerReference,
  FACTORYOS_BACKUP_STORAGE_PROVIDER_SCOPE_REFERENCE: providerScopeReference,
});
function evidence(): NormalizedBackupProviderAcceptanceScenario[] {
  return SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS.map((scenarioCode, index) => ({
    scenarioCode, outcome: 'PASS',
    evidenceReference: 'staging.evidence.case-' + index,
    evidenceSha256: String(index + 1).padStart(64, '0'),
    executedAt: new Date(Date.now() - 60_000 - index).toISOString(),
    runnerReference: 'staging-runner.acceptance-' + index,
  }));
}
function acceptanceRow(scenarios: NormalizedBackupProviderAcceptanceScenario[], overrides: Record<string, unknown> = {}) {
  const scopeDigest = digestSaasBackupProviderAcceptanceScope({
    providerReference, providerScopeReference, configurationReference: configReference,
    adapterKey: 's3.tenant-backup.v1', adapterVersion: '1.0.0',
  });
  return {
    acceptance_id: acceptanceId, tenant_id: tenant, category_code: Category.BUSINESS_DATA, revision: 1,
    provider_reference: providerReference, provider_scope_reference: providerScopeReference,
    provider_scope_digest: scopeDigest, configuration_reference: configReference,
    adapter_key: 's3.tenant-backup.v1', adapter_version: '1.0.0',
    staging_evidence_reference: 'staging.release-evidence.backup',
    evidence_manifest_digest: digestSaasBackupProviderAcceptanceScenarios(scenarios), scenario_count: 10,
    status: 'ACCEPTED', idempotency_key: 'provider-acceptance-v1', request_hash: 'b'.repeat(64),
    submitted_by_user_id: submittedBy, reviewed_by_user_id: reviewedBy,
    review_reason: 'Independent provider owner review', submitted_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(), valid_until: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}
function setup(handler: (sql: string, values: unknown[]) => unknown = () => []) {
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => ({
      rows: handler(sql, values) as never[], rowCount: 0,
    })),
    transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback({
      query: jest.fn(async (sql: string, values: unknown[] = []) => ({
        rows: handler(sql, values) as never[], rowCount: 0,
      })),
    })),
  };
  const iam = { authorize: jest.fn(async () => undefined) };
  const audit = { recordWithClient: jest.fn(async () => 'audit-event') };
  return {
    service: new SaasTenantBackupProviderAcceptanceService(database as never, iam as never, audit as never, config),
    database,
  };
}

describe('SaasTenantBackupProviderAcceptanceService', () => {
  it('fails closed when provider scope references are not configured', async () => {
    const unavailableConfig = new ConfigService({ FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE: configReference });
    const broken = new SaasTenantBackupProviderAcceptanceService({ query: jest.fn() } as never,
      { authorize: jest.fn() } as never, { recordWithClient: jest.fn() } as never, unavailableConfig);
    await expect(broken.requireCurrentAcceptedProviderAcceptance(
      tenant, Category.BUSINESS_DATA, configReference, 's3.tenant-backup.v1', '1.0.0',
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('accepts only an intact, current, fully passing ten-scenario record', async () => {
    const scenarios = evidence();
    const row = acceptanceRow(scenarios);
    const { service, database } = setup((sql) => {
      if (sql.includes('FROM saas_tenant_backup_provider_acceptances')) return [row];
      if (sql.includes('FROM saas_tenant_backup_provider_acceptance_revocations')) return [];
      if (sql.includes('FROM saas_tenant_backup_provider_acceptance_evidence')) return scenarios.map((item) => ({
        scenario_code: item.scenarioCode, outcome: item.outcome, evidence_reference: item.evidenceReference,
        evidence_sha256: item.evidenceSha256, executed_at: item.executedAt, runner_reference: item.runnerReference,
      }));
      return [];
    });
    await expect(service.requireCurrentAcceptedProviderAcceptance(
      tenant, Category.BUSINESS_DATA, configReference, 's3.tenant-backup.v1', '1.0.0',
    )).resolves.toEqual(expect.objectContaining({ acceptanceId, status: 'ACCEPTED', scenarioCount: 10 }));
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the acceptance is expired, not accepted, or scoped to another provider', async () => {
    for (const overrides of [
      { status: 'PENDING' },
      { valid_until: new Date(Date.now() - 1_000).toISOString() },
      { provider_scope_reference: 'aws-account-elsewhere:other-bucket:us-east-1' },
    ]) {
      const scenarios = evidence();
      const { service } = setup((sql) => {
        if (sql.includes('FROM saas_tenant_backup_provider_acceptances')) return [acceptanceRow(scenarios, overrides)];
        return [];
      });
      await expect(service.requireCurrentAcceptedProviderAcceptance(
        tenant, Category.BUSINESS_DATA, configReference, 's3.tenant-backup.v1', '1.0.0',
      )).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('provides stable scope digests for identical reviewed provider references', () => {
    const scope = {
      providerReference, providerScopeReference, configurationReference: configReference,
      adapterKey: 's3.tenant-backup.v1', adapterVersion: '1.0.0',
    };
    expect(digestSaasBackupProviderAcceptanceScope(scope)).toBe(digestSaasBackupProviderAcceptanceScope(scope));
    expect(digestSaasBackupProviderAcceptanceScope({ ...scope, providerScopeReference: 'another-scope' }))
      .not.toBe(digestSaasBackupProviderAcceptanceScope(scope));
  });

  it('uses the complete required scenario vocabulary as the canonical matrix', () => {
    expect(new Set(evidence().map((item) => item.scenarioCode)).size).toBe(10);
    expect(digestSaasBackupProviderAcceptanceScenarios(evidence())).toMatch(/^[a-f0-9]{64}$/);
  });
});
