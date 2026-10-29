import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { S3TenantBackupWriterFenceProvider } from './s3-tenant-backup-writer-fence.provider';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const fenceId = 'c5000000-0000-4000-8000-000000000005';
const keyPrefix = 'factoryos-backups/' + tenant + '/BUSINESS_DATA/';
const configReference = 'backup-storage-erasure.v1';

function createConfig(overrides: Record<string, string | undefined> = {}) {
  return new ConfigService({
    NODE_ENV: 'test',
    FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE: configReference,
    FACTORYOS_BACKUP_STORAGE_ENDPOINT: 'https://s3.example.test',
    FACTORYOS_BACKUP_STORAGE_BUCKET: 'factoryos-backups',
    FACTORYOS_BACKUP_STORAGE_REGION: 'us-east-1',
    FACTORYOS_BACKUP_STORAGE_TIMEOUT_MS: '5000',
    FACTORYOS_BACKUP_STORAGE_POLICY_CONTROLLER_ENABLED: 'true',
    FACTORYOS_BACKUP_STORAGE_POLICY_OWNERSHIP_ACKNOWLEDGED: 'true',
    FACTORYOS_BACKUP_STORAGE_POLICY_CONFIG_REFERENCE: configReference,
    FACTORYOS_BACKUP_STORAGE_POLICY_ACCESS_KEY_ID: 'policy-access-key',
    FACTORYOS_BACKUP_STORAGE_POLICY_SECRET_ACCESS_KEY: 'policy-secret-key',
    FACTORYOS_BACKUP_STORAGE_POLICY_SESSION_TOKEN: '',
    ...overrides,
  });
}

function basePolicy() {
  return {
    Version: '2012-10-17',
    Id: 'factoryos-shared-bucket-policy',
    Statement: [{
      Sid: 'ExistingReadOnly',
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::123456789012:role/backup-auditor' },
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::factoryos-backups/factoryos-backups/*',
    }],
  };
}

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { 'content-type': 'application/xml' } });
}

describe('S3TenantBackupWriterFenceProvider', () => {
  let provider: S3TenantBackupWriterFenceProvider;
  let policy: Record<string, unknown> | null;
  let multipartXml: string;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let policyReadCount: number;
  let policyWriteCount: number;
  let mutateOnSecondPolicyRead: boolean;

  beforeEach(() => {
    policy = basePolicy();
    multipartXml = '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>';
    policyReadCount = 0;
    policyWriteCount = 0;
    mutateOnSecondPolicyRead = false;
    provider = new S3TenantBackupWriterFenceProvider(createConfig());
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.searchParams.has('policy') && method === 'GET') {
        policyReadCount += 1;
        if (mutateOnSecondPolicyRead && policyReadCount === 2 && policy) {
          policy = { ...policy, Id: 'externally-changed-policy' };
        }
        if (!policy) return xmlResponse('<Error><Code>NoSuchBucketPolicy</Code></Error>', 404);
        return new Response(JSON.stringify(policy), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.searchParams.has('policy') && method === 'PUT') {
        policyWriteCount += 1;
        policy = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response('', { status: 200 });
      }
      if (url.searchParams.has('uploads') && method === 'GET') return xmlResponse(multipartXml);
      return xmlResponse('<Error><Code>NotImplemented</Code></Error>', 501);
    });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('does not call the provider when explicit policy-controller enablement/ownership is absent', async () => {
    provider = new S3TenantBackupWriterFenceProvider(createConfig({
      FACTORYOS_BACKUP_STORAGE_POLICY_CONTROLLER_ENABLED: 'false',
    }));
    await expect(provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(policyWriteCount).toBe(0);
  });

  it('denies direct uploads and replication into only the tenant/category prefix while preserving unrelated policy', async () => {
    const evidence = await provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    const statements = (policy as { Statement: Array<Record<string, unknown>> }).Statement;
    const fence = statements.find((statement) => statement.Sid === 'FactoryOSBackupWriterFence' + fenceId.replace(/-/g, ''));
    expect(fence).toEqual({
      Sid: 'FactoryOSBackupWriterFence' + fenceId.replace(/-/g, ''),
      Effect: 'Deny',
      Principal: '*',
      Action: ['s3:PutObject', 's3:ReplicateObject'],
      Resource: 'arn:aws:s3:::factoryos-backups/' + keyPrefix + '*',
    });
    expect(statements.some((statement) => statement.Sid === 'ExistingReadOnly')).toBe(true);
    expect(evidence).toMatchObject({
      providerFenceReference: 's3-bucket-policy-fence.' + fenceId.replace(/-/g, ''),
      pendingMultipartUploads: 0,
    });
    expect(evidence.providerPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.scopePrefixDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.multipartInventoryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(policyReadCount).toBeGreaterThanOrEqual(3);
    expect(policyWriteCount).toBe(1);
  });

  it('refuses to overwrite a conflicting statement that reuses this fence ID', async () => {
    policy = {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'FactoryOSBackupWriterFence' + fenceId.replace(/-/g, ''),
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: 'arn:aws:s3:::some-other-bucket/*',
      }],
    };
    await expect(provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(policyWriteCount).toBe(0);
  });

  it('leaves the provider deny installed but refuses readiness while multipart uploads remain', async () => {
    multipartXml = '<ListMultipartUploadsResult><Upload><Key>' + keyPrefix
      + 'incomplete.tar.zst</Key><UploadId>opaque-multipart-1</UploadId></Upload>'
      + '<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>';
    const evidence = await provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    expect(evidence.pendingMultipartUploads).toBe(1);
    expect(policyWriteCount).toBe(1);
    expect((policy as { Statement: Array<Record<string, unknown>> }).Statement.some((s) =>
      s.Sid === 'FactoryOSBackupWriterFence' + fenceId.replace(/-/g, ''))).toBe(true);
  });

  it('detects bucket-policy changes between preflight and mutation rather than overwriting them', async () => {
    mutateOnSecondPolicyRead = true;
    await expect(provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(policyWriteCount).toBe(0);
    expect((policy as { Id: string }).Id).toBe('externally-changed-policy');
  });

  it('plans and removes only the exact fence statement, with read-back bound to both policy digests', async () => {
    await provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    const plan = await provider.planFenceRemoval({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    expect(plan.policyPresent).toBe(true);
    expect(plan.currentPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.releasePolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    const result = await provider.removeFence({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      expectedCurrentPolicyDigest: plan.currentPolicyDigest,
      expectedReleasePolicyDigest: plan.releasePolicyDigest,
    });
    const statements = (policy as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements.some((statement) => statement.Sid === 'FactoryOSBackupWriterFence' + fenceId.replace(/-/g, ''))).toBe(false);
    expect(statements.some((statement) => statement.Sid === 'ExistingReadOnly')).toBe(true);
    expect(result).toMatchObject({ policyAbsent: true, alreadyAbsent: false, providerPolicyDigest: plan.releasePolicyDigest });
    expect(policyWriteCount).toBe(2);
  });

  it('refuses policy removal after an unreviewed policy mutation', async () => {
    await provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    const plan = await provider.planFenceRemoval({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId });
    policy = { ...(policy as Record<string, unknown>), Id: 'changed-after-release-plan' };
    await expect(provider.removeFence({
      tenantId: tenant, category: Category.BUSINESS_DATA, fenceId,
      expectedCurrentPolicyDigest: plan.currentPolicyDigest,
      expectedReleasePolicyDigest: plan.releasePolicyDigest,
    })).rejects.toBeInstanceOf(ConflictException);
    expect(policyWriteCount).toBe(1);
  });

  it('requires the control-plane config reference to match the backup target reference', async () => {
    provider = new S3TenantBackupWriterFenceProvider(createConfig({
      FACTORYOS_BACKUP_STORAGE_POLICY_CONFIG_REFERENCE: 'different-target',
    }));
    await expect(provider.installFence({ tenantId: tenant, category: Category.BUSINESS_DATA, fenceId }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
