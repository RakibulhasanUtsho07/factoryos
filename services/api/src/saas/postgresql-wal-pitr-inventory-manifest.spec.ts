import { ServiceUnavailableException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalizePostgresqlWalPitrSourceReceipt,
  digestPostgresqlWalPitrInventoryScope,
  REQUIRED_POSTGRESQL_WAL_PITR_SOURCES,
  validatePostgresqlWalPitrInventoryManifest,
} from './postgresql-wal-pitr-inventory-manifest';

const tenant = '31000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-11-01T12:00:00.000Z');
const collectorKeys = new Map(REQUIRED_POSTGRESQL_WAL_PITR_SOURCES.map((sourceKind) => {
  const pair = generateKeyPairSync('ed25519');
  return [sourceKind, { keyId: 'collector.' + sourceKind.toLowerCase(), ownerReference: 'owner.collector.' + sourceKind.toLowerCase(),
    publicKey: pair.publicKey, privateKey: pair.privateKey }] as const;
}));
const trustedSourceKeysJson = JSON.stringify([...collectorKeys.entries()].map(([sourceKind, key]) => ({
  keyId: key.keyId, ownerReference: key.ownerReference, sourceKinds: [sourceKind],
  publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
})));

function makeManifest(disposition: 'SUPPORTED' | 'NOT_APPLICABLE' | 'UNRESOLVED' = 'SUPPORTED') {
  const hasArchive = disposition !== 'NOT_APPLICABLE';
  const scope = {
    cluster_references: ['pg.cluster.primary'],
    archive_references: hasArchive ? ['pg.archive.primary'] : [],
    provider_references: hasArchive ? ['cloud.provider'] : [],
    account_references: hasArchive ? ['cloud.account.prod'] : [],
    region_references: hasArchive ? ['cloud.region.primary'] : [],
    writer_principal_references: hasArchive ? ['iam.pg-archive-writer'] : [],
    replication_path_references: hasArchive ? ['pg.replication.dr'] : [],
    restore_path_references: hasArchive ? ['pg.restore.dr'] : [],
  };
  const generatedAt = new Date(now - 10_000).toISOString();
  const startedAt = new Date(now - 90_000).toISOString();
  const completedAt = new Date(now - 30_000).toISOString();
  const counts: Record<string, number> = {
    POSTGRESQL_CLUSTER_CATALOG: 1,
    WAL_ARCHIVE_DESTINATION_CATALOG: hasArchive ? 1 : 0,
    WAL_SEGMENT_CATALOG: hasArchive ? 1 : 0,
    WAL_WRITER_PRINCIPAL_CATALOG: hasArchive ? 1 : 0,
    WAL_REPLICATION_PATH_CATALOG: hasArchive ? 1 : 0,
    PITR_RESTORE_PATH_CATALOG: hasArchive ? 1 : 0,
  };
  const manifest = {
    schema: 'factoryos.postgresql-wal-pitr-inventory/v1',
    tenant_id: tenant,
    category_code: 'BUSINESS_DATA',
    copy_class_code: 'POSTGRESQL_WAL_PITR',
    inventory_id: '31000000-0000-4000-8000-000000000002',
    generated_at: generatedAt,
    scope,
    scope_sha256: digestPostgresqlWalPitrInventoryScope(scope),
    inventory_complete: true,
    pagination_exhausted: true,
    unclassified_archive_count: 0,
    sources: REQUIRED_POSTGRESQL_WAL_PITR_SOURCES.map((source_kind) => ({
      source_kind,
      source_reference: 'source.' + source_kind.toLowerCase(),
      collection_run_reference: 'run.' + source_kind.toLowerCase(),
      status: 'COMPLETE',
      pagination_exhausted: true,
      pages_fetched: 1,
      item_count: counts[source_kind],
      result_sha256: 'a'.repeat(64),
      scope_sha256: digestPostgresqlWalPitrInventoryScope(scope),
      started_at: startedAt,
      completed_at: completedAt,
      attestation_key_id: collectorKeys.get(source_kind)!.keyId,
      attestation_owner_reference: collectorKeys.get(source_kind)!.ownerReference,
      attestation_signature: '',
    })),
    clusters: [{
      cluster_reference: 'pg.cluster.primary',
      system_identifier: '7656119800000000000',
      postgres_major_version: 17,
      timeline_ids: ['00000001'],
    }],
    archives: hasArchive ? [{
      archive_reference: 'pg.archive.primary',
      cluster_reference: 'pg.cluster.primary',
      provider_reference: 'cloud.provider',
      account_reference: 'cloud.account.prod',
      region_reference: 'cloud.region.primary',
      retention_policy_reference: 'policy.pg.wal.v1',
      legal_hold_status: 'NONE',
      writer_principal_references: ['iam.pg-archive-writer'],
      pages_fetched: 1,
      pagination_exhausted: true,
      segment_count: 1,
    }] : [],
    segments: hasArchive ? [{
      archive_reference: 'pg.archive.primary',
      cluster_reference: 'pg.cluster.primary',
      system_identifier: '7656119800000000000',
      timeline_id: '00000001',
      segment_name: '000000010000000000000001',
      first_lsn: '0/00000000',
      last_lsn: '0/00010000',
      archived_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      retention_expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      legal_hold_status: 'NONE',
    }] : [],
    replication_paths: hasArchive ? [{
      replication_path_reference: 'pg.replication.dr',
      source_cluster_reference: 'pg.cluster.primary',
      target_reference: 'pg.cluster.dr',
      archive_references: ['pg.archive.primary'],
      status: 'ACTIVE',
      last_verified_at: new Date(now - 60 * 60 * 1000).toISOString(),
    }] : [],
    restore_paths: hasArchive ? [{
      restore_path_reference: 'pg.restore.dr',
      source_cluster_reference: 'pg.cluster.primary',
      target_reference: 'pg.restore.target',
      archive_references: ['pg.archive.primary'],
      last_rehearsed_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      tombstone_replay_status: 'VERIFIED',
      tombstone_replay_evidence_reference: 'evidence.pg.restore.tombstone.v1',
    }] : [],
  };
  manifest.sources.forEach((source) => resignSource(source, manifest));
  return manifest;
}
function resignSource(source: ReturnType<typeof makeManifest>['sources'][number], inventory: ReturnType<typeof makeManifest>) {
  const collector = collectorKeys.get(source.source_kind as typeof REQUIRED_POSTGRESQL_WAL_PITR_SOURCES[number])!;
  source.attestation_signature = sign(null, Buffer.from(canonicalizePostgresqlWalPitrSourceReceipt(
    source, { tenantId: inventory.tenant_id, categoryCode: inventory.category_code, inventoryId: inventory.inventory_id },
  ), 'utf8'), collector.privateKey).toString('base64url');
}

function validate(manifest: unknown, disposition: 'SUPPORTED' | 'NOT_APPLICABLE' | 'UNRESOLVED' = 'SUPPORTED') {
  validatePostgresqlWalPitrInventoryManifest(
    Buffer.from(JSON.stringify(manifest)),
    tenant,
    'BUSINESS_DATA',
    disposition,
    now,
    trustedSourceKeysJson,
  );
}

describe('PostgreSQL WAL/PITR inventory manifest', () => {
  it('accepts a complete tenant-bound inventory with reconciled source counts and copy metadata', () => {
    expect(() => validate(makeManifest())).not.toThrow();
  });

  it('accepts NOT_APPLICABLE only when all archive, segment, writer, replication and restore inventories are empty', () => {
    expect(() => validate(makeManifest('NOT_APPLICABLE'), 'NOT_APPLICABLE')).not.toThrow();
  });

  it('accepts NOT_APPLICABLE when authoritative provider/account scope proves no PostgreSQL clusters exist', () => {
    const empty = makeManifest('NOT_APPLICABLE');
    empty.scope.cluster_references = [];
    empty.scope.provider_references = ['cloud.provider'];
    empty.scope.account_references = ['cloud.account.prod'];
    empty.scope.region_references = ['cloud.region.primary'];
    empty.scope_sha256 = digestPostgresqlWalPitrInventoryScope(empty.scope);
    empty.sources.forEach((source) => { source.scope_sha256 = empty.scope_sha256; });
    empty.sources[0].item_count = 0;
    empty.clusters = [];
    empty.sources.forEach((source) => resignSource(source, empty));
    expect(() => validate(empty, 'NOT_APPLICABLE')).not.toThrow();
  });

  it('allows a complete inventory to remain UNRESOLVED while no class adapter exists', () => {
    expect(() => validate(makeManifest('UNRESOLVED'), 'UNRESOLVED')).not.toThrow();
  });

  it('rejects a tenant, category or copy-class mismatch', () => {
    const wrongTenant = makeManifest();
    wrongTenant.tenant_id = '31000000-0000-4000-8000-000000000099';
    expect(() => validate(wrongTenant)).toThrow(/tenant does not match/i);

    const wrongCategory = makeManifest();
    wrongCategory.category_code = 'AUDIT_LOG';
    expect(() => validate(wrongCategory)).toThrow(/category or copy class/i);

    const wrongClass = makeManifest();
    wrongClass.copy_class_code = 'POSTGRESQL_BASE_BACKUP';
    expect(() => validate(wrongClass)).toThrow(/category or copy class/i);
  });

  it('rejects stale inventory and missing/duplicate source receipts', () => {
    const stale = makeManifest();
    stale.generated_at = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => validate(stale)).toThrow(/no more than 30 days old/i);

    const missingSource = makeManifest();
    missingSource.sources.pop();
    expect(() => validate(missingSource)).toThrow(/exactly the required source receipt set/i);

    const duplicateSource = makeManifest();
    duplicateSource.sources[1] = { ...duplicateSource.sources[0] };
    expect(() => validate(duplicateSource)).toThrow(/duplicate or unsupported source receipt/i);
  });

  it('rejects incomplete pagination, source digest/scope drift and count mismatch', () => {
    const incomplete = makeManifest();
    incomplete.sources[2].pagination_exhausted = false;
    expect(() => validate(incomplete)).toThrow(/COMPLETE with pagination exhausted/i);

    const wrongScope = makeManifest();
    wrongScope.sources[0].scope_sha256 = 'b'.repeat(64);
    expect(() => validate(wrongScope)).toThrow(/bind a result digest and the complete inventory scope/i);

    const wrongCount = makeManifest();
    wrongCount.sources[2].item_count = 2;
    resignSource(wrongCount.sources[2], wrongCount);
    expect(() => validate(wrongCount)).toThrow(/item_count does not match/i);
  });

  it('rejects archive/provider scope drift and an unknown writer principal', () => {
    const archiveMismatch = makeManifest();
    archiveMismatch.archives[0].region_reference = 'cloud.region.other';
    expect(() => validate(archiveMismatch)).toThrow(/outside the declared cluster/i);

    const writerMismatch = makeManifest();
    writerMismatch.archives[0].writer_principal_references = ['iam.rogue-writer'];
    expect(() => validate(writerMismatch)).toThrow(/outside the declared cluster/i);
  });

  it('rejects malformed, duplicate and out-of-order WAL segment records', () => {
    const malformed = makeManifest();
    malformed.segments[0].segment_name = '../../wal-segment';
    expect(() => validate(malformed)).toThrow(/WAL segment identity/i);

    const duplicate = makeManifest();
    duplicate.segments.push({ ...duplicate.segments[0] });
    duplicate.archives[0].segment_count = 2;
    duplicate.sources[2].item_count = 2;
    duplicate.scope_sha256 = digestPostgresqlWalPitrInventoryScope(duplicate.scope);
    duplicate.sources.forEach((source) => { source.scope_sha256 = duplicate.scope_sha256; });
    duplicate.sources.forEach((source) => resignSource(source, duplicate));
    expect(() => validate(duplicate)).toThrow(/duplicate segment identity/i);

    const reversed = makeManifest();
    reversed.segments[0].first_lsn = '0/00020000';
    reversed.segments[0].last_lsn = '0/00010000';
    expect(() => validate(reversed)).toThrow(/LSN range must be increasing/i);
  });

  it('rejects NOT_APPLICABLE when an archive exists and SUPPORTED when hold status is unknown', () => {
    expect(() => validate(makeManifest(), 'NOT_APPLICABLE')).toThrow(/NOT_APPLICABLE WAL\/PITR disposition contradicts/i);

    const unknownHold = makeManifest();
    unknownHold.archives[0].legal_hold_status = 'UNKNOWN';
    expect(() => validate(unknownHold, 'SUPPORTED')).toThrow(/known legal-hold status/i);
  });

  it('requires an ordered LSN range and current, canonical timestamps', () => {
    const future = makeManifest();
    future.generated_at = new Date(now + 10 * 60 * 1000).toISOString();
    expect(() => validate(future)).toThrow(/no more than 30 days old/i);

    const badTime = makeManifest();
    badTime.segments[0].archived_at = '2026-11-01';
    expect(() => validate(badTime)).toThrow(/canonical ISO-8601/i);
  });

  it('rejects tampered source claims and cross-inventory receipt replay', () => {
    const tampered = makeManifest(); tampered.sources[0].item_count += 1;
    expect(() => validate(tampered)).toThrow(/source receipt signature does not match/i);
    const replayed = makeManifest(); replayed.inventory_id = '31000000-0000-4000-8000-000000000099';
    expect(() => validate(replayed)).toThrow(/source receipt signature does not match/i);
    const unsigned = makeManifest(); unsigned.sources[0].attestation_signature = '';
    expect(() => validate(unsigned)).toThrow(/signing metadata is invalid/i);
  });
  it('fails closed when collector trust is absent, malformed, duplicated or outside the source allowlist', () => {
    const valid = makeManifest();
    expect(() => validatePostgresqlWalPitrInventoryManifest(Buffer.from(JSON.stringify(valid)), tenant, 'BUSINESS_DATA', 'SUPPORTED', now, '')).toThrow(ServiceUnavailableException);
    expect(() => validatePostgresqlWalPitrInventoryManifest(Buffer.from(JSON.stringify(valid)), tenant, 'BUSINESS_DATA', 'SUPPORTED', now, '{invalid')).toThrow(ServiceUnavailableException);
    const trusted = JSON.parse(trustedSourceKeysJson) as Array<Record<string, unknown>>;
    const duplicate = [...trusted, { ...trusted[0], keyId: 'collector.alias.same.public.key' }];
    expect(() => validatePostgresqlWalPitrInventoryManifest(Buffer.from(JSON.stringify(valid)), tenant, 'BUSINESS_DATA', 'SUPPORTED', now, JSON.stringify(duplicate))).toThrow(/duplicate public key/i);
    const wrongAllowlist = trusted.map((entry, index) => index === 0 ? { ...entry, sourceKinds: ['WAL_SEGMENT_CATALOG'] } : entry);
    expect(() => validatePostgresqlWalPitrInventoryManifest(Buffer.from(JSON.stringify(valid)), tenant, 'BUSINESS_DATA', 'SUPPORTED', now, JSON.stringify(wrongAllowlist))).toThrow(/not trusted for POSTGRESQL_CLUSTER_CATALOG/i);
  });
  it('reconciles counts only after verifying the corresponding collector signature', () => {
    const wrongCount = makeManifest(); wrongCount.sources[2].item_count = 2; resignSource(wrongCount.sources[2], wrongCount);
    expect(() => validate(wrongCount)).toThrow(/item_count does not match/i);
  });

});
