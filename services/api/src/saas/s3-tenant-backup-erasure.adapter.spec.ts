import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { S3TenantBackupErasureAdapter } from './s3-tenant-backup-erasure.adapter';
import type { SaasExternalPropagationContext } from './saas-tenant-propagation.adapters';
import { SaasTransferDatasetCategory as Category } from './dto/create-saas-schema-compatibility-rule.dto';

const tenant = 'c1000000-0000-4000-8000-000000000001';
const configReference = 'backup-storage-erasure.v1';
const key = 'factoryos-backups/' + tenant + '/BUSINESS_DATA/archive-001.tar.zst';
const otherTenantKey = 'factoryos-backups/c2000000-0000-4000-8000-000000000002/BUSINESS_DATA/archive-002.tar.zst';
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

interface StoredVersion {
  key: string;
  versionId: string;
  kind: 'version' | 'delete-marker';
  bytes?: Buffer;
  legalHold?: 'ON' | 'OFF';
  retainUntil?: string;
}

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { 'content-type': 'application/xml' } });
}

function createConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE: configReference,
    FACTORYOS_BACKUP_STORAGE_ENDPOINT: 'https://backup.example.test',
    FACTORYOS_BACKUP_STORAGE_BUCKET: 'factoryos-backups',
    FACTORYOS_BACKUP_STORAGE_REGION: 'us-east-1',
    FACTORYOS_BACKUP_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    FACTORYOS_BACKUP_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    FACTORYOS_BACKUP_STORAGE_MAX_OBJECT_BYTES: '1048576',
    FACTORYOS_BACKUP_STORAGE_TIMEOUT_MS: '5000',
    ...overrides,
  };
  return new ConfigService(values);
}

describe('S3TenantBackupErasureAdapter', () => {
  let versions: StoredVersion[];
  let adapter: S3TenantBackupErasureAdapter;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let addResidualAfterDelete: boolean;
  let failVersionList: boolean;
  let deleted: Array<{ key: string; versionId: string }>;

  const target = {
    tenantId: tenant,
    targetId: 'backup-archive-primary',
    storeKind: 'BACKUP' as const,
    adapterKey: 's3.tenant-backup.v1',
    configReference,
    categories: [Category.BUSINESS_DATA],
    required: true,
  };

  const context = (overrides: Partial<SaasExternalPropagationContext> = {}): SaasExternalPropagationContext => ({
    tenantId: tenant,
    requestId: 'c3000000-0000-4000-8000-000000000001',
    requestVersion: 2,
    runId: 'c4000000-0000-4000-8000-000000000001',
    categories: [Category.BUSINESS_DATA],
    sourceExportDigest: 'a'.repeat(64),
    sourceManifest: { categories: [Category.BUSINESS_DATA] },
    idempotencyKey: 'backup-version-erasure-test',
    target,
    ...overrides,
  });

  beforeEach(() => {
    versions = [
      { key, versionId: 'version-a', kind: 'version', bytes: Buffer.from('previous archive bytes') },
      { key, versionId: 'version-b', kind: 'version', bytes: Buffer.from('current archive bytes') },
      { key, versionId: 'delete-marker-a', kind: 'delete-marker' },
      { key: otherTenantKey, versionId: 'other-tenant-version', kind: 'version', bytes: Buffer.from('other tenant') },
    ];
    addResidualAfterDelete = false;
    failVersionList = false;
    deleted = [];
    adapter = new S3TenantBackupErasureAdapter(createConfig());

    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const init = args[1] ?? {};
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      const method = init.method ?? 'GET';
      const keyFromUrl = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
      const versionId = url.searchParams.get('versionId');

      if (url.searchParams.has('versioning')) return xmlResponse('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>');
      if (url.searchParams.has('object-lock')) return xmlResponse('<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>');

      if (url.searchParams.has('versions')) {
        if (failVersionList) return xmlResponse('<Error><Code>AccessDenied</Code></Error>', 403);
        const prefix = url.searchParams.get('prefix') ?? '';
        const keyMarker = url.searchParams.get('key-marker');
        const versionMarker = url.searchParams.get('version-id-marker');
        const selected = versions
          .filter((item) => item.key.startsWith(prefix))
          .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0)
          .filter((item) => {
            if (keyMarker === null) return true;
            return item.key > keyMarker || (item.key === keyMarker && item.versionId > (versionMarker ?? ''));
          });
        const page = selected.slice(0, 1000);
        const entries = page.map((item) => {
          const tag = item.kind === 'delete-marker' ? 'DeleteMarker' : 'Version';
          return '<' + tag + '><Key>' + item.key + '</Key><VersionId>' + item.versionId
            + '</VersionId><IsLatest>false</IsLatest></' + tag + '>';
        }).join('');
        const more = selected.length > page.length;
        const last = page.at(-1);
        const next = more && last
          ? '<NextKeyMarker>' + last.key + '</NextKeyMarker><NextVersionIdMarker>' + last.versionId + '</NextVersionIdMarker>'
          : '';
        return xmlResponse('<ListVersionsResult><IsTruncated>' + String(more) + '</IsTruncated>' + entries + next + '</ListVersionsResult>');
      }

      const stored = versions.find((item) => item.key === keyFromUrl && item.versionId === versionId);
      if (url.searchParams.has('legal-hold')) {
        if (!stored || stored.kind === 'delete-marker') return xmlResponse('<Error/>', 404);
        return xmlResponse('<LegalHold><Status>' + (stored.legalHold ?? 'OFF') + '</Status></LegalHold>');
      }
      if (url.searchParams.has('retention')) {
        if (!stored || stored.kind === 'delete-marker') return xmlResponse('<Error/>', 404);
        if (stored.retainUntil) {
          return xmlResponse('<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>' + stored.retainUntil + '</RetainUntilDate></Retention>');
        }
        return xmlResponse('<Retention/>');
      }
      if (method === 'DELETE' && versionId !== null) {
        if (!stored) return new Response(null, { status: 404 });
        versions = versions.filter((item) => !(item.key === keyFromUrl && item.versionId === versionId));
        deleted.push({ key: keyFromUrl, versionId });
        if (addResidualAfterDelete) {
          addResidualAfterDelete = false;
          versions.push({ key: 'factoryos-backups/' + tenant + '/BUSINESS_DATA/late-arriving.tar.zst', versionId: 'late-version', kind: 'version', bytes: Buffer.from('late copy') });
        }
        return new Response(null, { status: 204 });
      }
      if (method === 'GET' && versionId !== null) {
        if (!stored || stored.kind === 'delete-marker' || !stored.bytes) return new Response(null, { status: 404 });
        return new Response(Buffer.from(stored.bytes), { status: 200, headers: { 'content-length': String(stored.bytes.length) } });
      }
      return xmlResponse('<Error><Code>UnsupportedTestRequest</Code></Error>', 400);
    });
  });

  afterEach(() => fetchMock.mockRestore());

  it('enumerates and removes every exact object version and delete marker, then verifies the full tenant/category scope is empty', async () => {
    expect(await adapter.isConfigured(target)).toBe(true);
    const plan = await adapter.prepare(context());
    expect(plan).toMatchObject({
      plannedCopies: '3',
      adapterVersion: '1.0.0',
      resourceClass: 'S3_TENANT_BACKUP_VERSION',
    });
    expect(plan.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceKind: 'S3_BACKUP_OBJECT_VERSION', resourceReference: key, resourceVersionReference: 'version-a', resourceContentDigest: digest('previous archive bytes') }),
      expect.objectContaining({ resourceKind: 'S3_BACKUP_OBJECT_VERSION', resourceReference: key, resourceVersionReference: 'version-b', resourceContentDigest: digest('current archive bytes') }),
      expect.objectContaining({ resourceKind: 'S3_BACKUP_DELETE_MARKER', resourceReference: key, resourceVersionReference: 'delete-marker-a', resourceContentDigest: null }),
    ]));
    expect(JSON.stringify(plan)).not.toContain('other-tenant-version');

    await adapter.recover({ ...context(), plan });
    const deletion = await adapter.erase({ ...context(), plan });
    expect(deletion).toMatchObject({ deletedCopies: '3', manifestDigest: plan.manifestDigest });
    expect(deleted).toHaveLength(3);
    expect(versions).toEqual([expect.objectContaining({ key: otherTenantKey, versionId: 'other-tenant-version' })]);

    const verification = await adapter.verify({ ...context(), plan, deletion });
    expect(verification).toMatchObject({ verifiedManifestDigest: plan.manifestDigest, residualCopies: '0', residualReferences: [] });
  });

  it('blocks the whole plan if any backup version has an active legal hold', async () => {
    versions[1]!.legalHold = 'ON';
    await expect(adapter.prepare(context())).rejects.toBeInstanceOf(ConflictException);
    expect(deleted).toHaveLength(0);
    expect(versions.some((item) => item.legalHold === 'ON')).toBe(true);
  });

  it('blocks backup deletion while provider-enforced object retention has not expired', async () => {
    versions[0]!.retainUntil = new Date(Date.now() + 60_000).toISOString();
    await expect(adapter.prepare(context())).rejects.toBeInstanceOf(ConflictException);
    expect(deleted).toHaveLength(0);
  });

  it('rechecks the content digest immediately before deleting a sealed version', async () => {
    const plan = await adapter.prepare(context());
    versions.find((item) => item.versionId === 'version-b')!.bytes = Buffer.from('mutated archive bytes');
    await expect(adapter.erase({ ...context(), plan })).rejects.toBeInstanceOf(ConflictException);
    expect(deleted).toHaveLength(0);
  });

  it('reports versions that arrive after the sealed plan as residuals instead of declaring success', async () => {
    const plan = await adapter.prepare(context());
    addResidualAfterDelete = true;
    const deletion = await adapter.erase({ ...context(), plan });
    const verification = await adapter.verify({ ...context(), plan, deletion });
    expect(verification.residualCopies).toBe('1');
    expect(verification.residualReferences[0]).toContain('late-arriving.tar.zst');
  });

  it('fails closed when version inventory is unavailable or the target is outside the reviewed scope', async () => {
    failVersionList = true;
    await expect(adapter.prepare(context())).rejects.toThrow();
    expect(await adapter.isConfigured({ ...target, configReference: 'unreviewed-ref' })).toBe(false);

    await expect(adapter.prepare(context({
      target: { ...target, categories: [Category.BUSINESS_DATA, Category.AUDIT_LOG] },
    }))).rejects.toBeInstanceOf(ConflictException);
    expect(deleted).toHaveLength(0);
  });

  it('refuses activation when bucket versioning or Object Lock cannot be proven', async () => {
    const versioningConfig = createConfig({ FACTORYOS_BACKUP_STORAGE_ENDPOINT: 'https://backup.example.test' });
    const noLockConfig = createConfig({ FACTORYOS_BACKUP_STORAGE_CONFIG_REFERENCE: 'other-ref' });
    const wrongTarget = { ...target, configReference: 'other-ref' };
    expect(await new S3TenantBackupErasureAdapter(noLockConfig).isConfigured(target)).toBe(false);
    expect(await new S3TenantBackupErasureAdapter(versioningConfig).isConfigured(wrongTarget)).toBe(false);
  });
});
