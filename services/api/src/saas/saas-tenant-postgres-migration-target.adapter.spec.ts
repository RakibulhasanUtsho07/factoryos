import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { REQUIRED_TRANSFER_CATEGORIES } from './dto/create-saas-schema-compatibility-rule.dto';
import { SaasTenantPostgresMigrationTargetAdapter, TenantExportTextReader } from './saas-tenant-postgres-migration-target.adapter';
import type { SaasTenantTransferExportManifest } from './saas-tenant-data-transfer.adapters';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const transferId = '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const manifest = Object.fromEntries(REQUIRED_TRANSFER_CATEGORIES.map((category) => [
  category,
  { record_count: 0, sha256: emptyHash },
])) as SaasTenantTransferExportManifest;

function chunksOf(text: string, sizes: number[]): AsyncIterable<Buffer> {
  return (async function* () {
    let offset = 0;
    let sizeIndex = 0;
    while (offset < text.length) {
      const size = sizes[sizeIndex % sizes.length];
      yield Buffer.from(text.slice(offset, offset + size));
      offset += size;
      sizeIndex += 1;
    }
  })();
}

describe('SaasTenantPostgresMigrationTargetAdapter', () => {
  it('fails closed when no dedicated target database URL is configured', async () => {
    const config = { get: jest.fn(() => undefined) };
    const sourceDb = { query: jest.fn() };
    const adapter = new SaasTenantPostgresMigrationTargetAdapter(config as never, sourceDb as never);
    await expect(adapter.importBundle({
      tenantId,
      transferId,
      sourceSchemaVersion: '1.0.0',
      targetSchemaVersion: '1.0.0',
      sourceBundle: chunksOf('{}', [1]),
      sourceManifest: manifest,
      requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sourceDb.query).not.toHaveBeenCalled();
  });

  it('refuses cross-version copies until a schema transformation adapter exists', async () => {
    const config = { get: jest.fn(() => undefined) };
    const sourceDb = { query: jest.fn() };
    const adapter = new SaasTenantPostgresMigrationTargetAdapter(config as never, sourceDb as never);
    await expect(adapter.importBundle({
      tenantId,
      transferId,
      sourceSchemaVersion: '1.0.0',
      targetSchemaVersion: '2.0.0',
      sourceBundle: chunksOf('{}', [2, 1]),
      sourceManifest: manifest,
      requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(config.get).not.toHaveBeenCalled();
    expect(sourceDb.query).not.toHaveBeenCalled();
  });

  it('rejects an incomplete manifest before creating a database connection', async () => {
    const config = { get: jest.fn(() => undefined) };
    const sourceDb = { query: jest.fn() };
    const adapter = new SaasTenantPostgresMigrationTargetAdapter(config as never, sourceDb as never);
    await expect(adapter.importBundle({
      tenantId,
      transferId,
      sourceSchemaVersion: '1.0.0',
      targetSchemaVersion: '1.0.0',
      sourceBundle: chunksOf('{}', [2, 1]),
      sourceManifest: { AUDIT_LOG: manifest.AUDIT_LOG },
      requiredCategories: [...REQUIRED_TRANSFER_CATEGORIES],
    })).rejects.toBeInstanceOf(ConflictException);
    expect(config.get).not.toHaveBeenCalled();
  });

  it('reads header delimiters, nested records and manifests correctly across arbitrary chunk boundaries', async () => {
    const json = '{"format":"FACTORYOS_TENANT_EXPORT","formatVersion":1,"tenantId":"' + tenantId +
      '","schemaVersion":"1.0.0","datasets":{"AUDIT_LOG":[{"id":"' + transferId +
      '","tenant_id":"' + tenantId + '","payload":{"message":"comma, brace }, bracket ] and quote \\\\" "}}]},"manifest":' +
      JSON.stringify({ AUDIT_LOG: manifest.AUDIT_LOG }) + '}';
    const reader = new TenantExportTextReader(chunksOf(json, [1, 2, 7, 3, 11]));
    const prefix = await reader.readUntil(',"datasets":{', 16384);
    const header = JSON.parse(prefix + '}') as Record<string, unknown>;
    expect(header.tenantId).toBe(tenantId);
    expect(await reader.readJsonString(128)).toBe('AUDIT_LOG');
    await reader.expect(':');
    await reader.expect('[');
    const rowText = await reader.readJsonObject(16 * 1024 * 1024);
    const row = JSON.parse(rowText) as { id: string; payload: { message: string } };
    expect(row.id).toBe(transferId);
    expect(row.payload.message).toContain('comma, brace');
    await reader.expect(']');
    await reader.expect('}');
    await reader.expect(',');
    expect(await reader.readJsonString(32)).toBe('manifest');
    await reader.expect(':');
    const manifestText = await reader.readJsonObject(65536);
    expect(JSON.parse(manifestText)).toEqual({ AUDIT_LOG: manifest.AUDIT_LOG });
    await reader.expect('}');
    await reader.assertEnd();
  });
});
