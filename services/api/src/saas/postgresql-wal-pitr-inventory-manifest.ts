import { createHash } from 'node:crypto';

export const POSTGRESQL_WAL_PITR_INVENTORY_SCHEMA = 'factoryos.postgresql-wal-pitr-inventory/v1';

export const REQUIRED_POSTGRESQL_WAL_PITR_SOURCES = [
  'POSTGRESQL_CLUSTER_CATALOG',
  'WAL_ARCHIVE_DESTINATION_CATALOG',
  'WAL_SEGMENT_CATALOG',
  'WAL_WRITER_PRINCIPAL_CATALOG',
  'WAL_REPLICATION_PATH_CATALOG',
  'PITR_RESTORE_PATH_CATALOG',
] as const;

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface PostgresqlWalPitrInventoryScope {
  cluster_references: string[];
  archive_references: string[];
  provider_references: string[];
  account_references: string[];
  region_references: string[];
  writer_principal_references: string[];
  replication_path_references: string[];
  restore_path_references: string[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(field + ' must be an object');
  }
  return value as Record<string, unknown>;
}

function reference(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://')
    || /(secret|password|credential|access[-_]?key|token)/i.test(value)) {
    throw new Error(field + ' must be a non-secret opaque reference');
  }
  return value;
}

function referenceArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(field + ' must be an array');
  const values = value.map((item, index) => reference(item, field + '[' + index + ']'));
  if (new Set(values).size !== values.length) throw new Error(field + ' must not contain duplicates');
  return values.sort();
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(field + ' is outside the supported integer range');
  }
  return value as number;
}

function isoTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string' || !value.trim()) throw new Error(field + ' must be an ISO-8601 UTC timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(field + ' must be a canonical ISO-8601 UTC timestamp');
  }
  return parsed;
}

function canonicalScope(value: unknown): PostgresqlWalPitrInventoryScope {
  const source = object(value, 'scope');
  const scope: PostgresqlWalPitrInventoryScope = {
    cluster_references: referenceArray(source.cluster_references, 'scope.cluster_references'),
    archive_references: referenceArray(source.archive_references, 'scope.archive_references'),
    provider_references: referenceArray(source.provider_references, 'scope.provider_references'),
    account_references: referenceArray(source.account_references, 'scope.account_references'),
    region_references: referenceArray(source.region_references, 'scope.region_references'),
    writer_principal_references: referenceArray(source.writer_principal_references, 'scope.writer_principal_references'),
    replication_path_references: referenceArray(source.replication_path_references, 'scope.replication_path_references'),
    restore_path_references: referenceArray(source.restore_path_references, 'scope.restore_path_references'),
  };
  if (scope.cluster_references.length === 0) {
    throw new Error('WAL/PITR inventory must identify at least one PostgreSQL cluster');
  }
  return scope;
}

export function digestPostgresqlWalPitrInventoryScope(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalScope(value)), 'utf8').digest('hex');
}

function sourceCount(sources: Map<string, Record<string, unknown>>, kind: string): number {
  const source = sources.get(kind);
  if (!source) throw new Error('required WAL/PITR source is missing: ' + kind);
  return source.item_count as number;
}

function lsnValue(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(value)) {
    throw new Error(field + ' must be a PostgreSQL LSN');
  }
  const [high, low] = value.split('/');
  return (BigInt('0x' + high) << 32n) | BigInt('0x' + low);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Validates a tenant/category-bound, owner-signed WAL/PITR inventory artifact.
 * The caller must first read the exact artifact bytes from the deployment-owned
 * read-only evidence root and verify their SHA-256 digest.
 */
export function validatePostgresqlWalPitrInventoryManifest(
  bytes: Buffer,
  expectedTenantId: string,
  expectedCategoryCode: string,
  expectedDisposition: 'SUPPORTED' | 'NOT_APPLICABLE' | 'UNRESOLVED',
  nowValue: Date | number = Date.now(),
): void {
  const now = nowValue instanceof Date ? nowValue.getTime() : nowValue;
  if (!Number.isFinite(now)) throw new Error('validation clock is invalid');

  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('WAL/PITR evidence must contain a valid JSON inventory manifest');
  }
  const manifest = object(decoded, 'manifest');
  if (manifest.schema !== POSTGRESQL_WAL_PITR_INVENTORY_SCHEMA) {
    throw new Error('WAL/PITR inventory schema is unsupported');
  }
  if (typeof manifest.tenant_id !== 'string' || manifest.tenant_id.toLowerCase() !== expectedTenantId.toLowerCase()) {
    throw new Error('WAL/PITR inventory tenant does not match the signed evidence claim');
  }
  if (manifest.category_code !== expectedCategoryCode || manifest.copy_class_code !== 'POSTGRESQL_WAL_PITR') {
    throw new Error('WAL/PITR inventory category or copy class does not match the signed evidence claim');
  }
  if (typeof manifest.inventory_id !== 'string' || !UUID.test(manifest.inventory_id)) {
    throw new Error('WAL/PITR inventory_id must be a UUID');
  }
  const generatedAt = isoTimestamp(manifest.generated_at, 'generated_at');
  if (generatedAt > now + CLOCK_SKEW_MS || generatedAt < now - MAX_AGE_MS) {
    throw new Error('WAL/PITR inventory must be current and no more than 30 days old');
  }

  const scope = canonicalScope(manifest.scope);
  const scopeDigest = digestPostgresqlWalPitrInventoryScope(scope);
  if (manifest.scope_sha256 !== scopeDigest) {
    throw new Error('WAL/PITR inventory scope digest does not match its canonical scope');
  }
  if (manifest.inventory_complete !== true || manifest.pagination_exhausted !== true
    || manifest.unclassified_archive_count !== 0) {
    throw new Error('WAL/PITR inventory must be complete, exhaust pagination and contain no unclassified archives');
  }

  if (!Array.isArray(manifest.sources) || manifest.sources.length !== REQUIRED_POSTGRESQL_WAL_PITR_SOURCES.length) {
    throw new Error('WAL/PITR inventory must contain exactly the required source receipt set');
  }
  const sources = new Map<string, Record<string, unknown>>();
  const runReferences = new Set<string>();
  for (const candidate of manifest.sources) {
    const source = object(candidate, 'source receipt');
    if (typeof source.source_kind !== 'string'
      || !REQUIRED_POSTGRESQL_WAL_PITR_SOURCES.includes(source.source_kind as typeof REQUIRED_POSTGRESQL_WAL_PITR_SOURCES[number])
      || sources.has(source.source_kind)) {
      throw new Error('WAL/PITR inventory has a missing, duplicate or unsupported source receipt');
    }
    reference(source.source_reference, 'source_reference');
    const runReference = reference(source.collection_run_reference, 'collection_run_reference');
    if (runReferences.has(runReference)) throw new Error('source collection run references must be unique');
    runReferences.add(runReference);
    if (source.status !== 'COMPLETE' || source.pagination_exhausted !== true) {
      throw new Error('every WAL/PITR source must be COMPLETE with pagination exhausted');
    }
    integer(source.pages_fetched, 'source.pages_fetched', 1, 100000);
    integer(source.item_count, 'source.item_count', 0, Number.MAX_SAFE_INTEGER);
    if (typeof source.result_sha256 !== 'string' || !SHA256.test(source.result_sha256)
      || source.scope_sha256 !== scopeDigest) {
      throw new Error('WAL/PITR source receipt must bind a result digest and the complete inventory scope');
    }
    const startedAt = isoTimestamp(source.started_at, 'source.started_at');
    const completedAt = isoTimestamp(source.completed_at, 'source.completed_at');
    if (completedAt < startedAt || startedAt < generatedAt - MAX_SOURCE_AGE_MS
      || completedAt > generatedAt + CLOCK_SKEW_MS) {
      throw new Error('WAL/PITR source receipts must complete within 24 hours before inventory generation');
    }
    sources.set(source.source_kind, source);
  }
  for (const kind of REQUIRED_POSTGRESQL_WAL_PITR_SOURCES) {
    if (!sources.has(kind)) throw new Error('required WAL/PITR source is missing: ' + kind);
  }

  if (!Array.isArray(manifest.clusters) || manifest.clusters.length !== scope.cluster_references.length) {
    throw new Error('WAL/PITR cluster catalog does not match the declared scope');
  }
  const clusters = new Map<string, { systemIdentifier: string; timelineIds: Set<string> }>();
  for (const candidate of manifest.clusters) {
    const cluster = object(candidate, 'cluster');
    const clusterReference = reference(cluster.cluster_reference, 'cluster.cluster_reference');
    if (!scope.cluster_references.includes(clusterReference) || clusters.has(clusterReference)) {
      throw new Error('WAL/PITR cluster catalog contains an out-of-scope or duplicate cluster');
    }
    if (typeof cluster.system_identifier !== 'string' || !/^\d{1,20}$/.test(cluster.system_identifier)) {
      throw new Error('cluster.system_identifier is invalid');
    }
    integer(cluster.postgres_major_version, 'cluster.postgres_major_version', 9, 99);
    if (!Array.isArray(cluster.timeline_ids) || cluster.timeline_ids.length < 1
      || cluster.timeline_ids.some((item) => typeof item !== 'string' || !/^[A-F0-9]{8}$/.test(item))
      || new Set(cluster.timeline_ids).size !== cluster.timeline_ids.length) {
      throw new Error('cluster.timeline_ids must contain unique eight-character hexadecimal IDs');
    }
    clusters.set(clusterReference, {
      systemIdentifier: cluster.system_identifier,
      timelineIds: new Set(cluster.timeline_ids as string[]),
    });
  }

  if (!Array.isArray(manifest.archives) || manifest.archives.length !== scope.archive_references.length) {
    throw new Error('WAL archive destination catalog does not match the declared scope');
  }
  const archives = new Map<string, { clusterReference: string; legalHoldStatus: string; writerRefs: string[] }>();
  for (const candidate of manifest.archives) {
    const archive = object(candidate, 'archive');
    const archiveReference = reference(archive.archive_reference, 'archive.archive_reference');
    const clusterReference = reference(archive.cluster_reference, 'archive.cluster_reference');
    const providerReference = reference(archive.provider_reference, 'archive.provider_reference');
    const accountReference = reference(archive.account_reference, 'archive.account_reference');
    const regionReference = reference(archive.region_reference, 'archive.region_reference');
    reference(archive.retention_policy_reference, 'archive.retention_policy_reference');
    const legalHoldStatus = archive.legal_hold_status;
    if (!['NONE', 'ACTIVE', 'UNKNOWN'].includes(String(legalHoldStatus))) {
      throw new Error('archive.legal_hold_status is invalid');
    }
    const writerRefs = referenceArray(archive.writer_principal_references, 'archive.writer_principal_references');
    if (writerRefs.length === 0 || !clusters.has(clusterReference) || !scope.provider_references.includes(providerReference)
      || !scope.account_references.includes(accountReference) || !scope.region_references.includes(regionReference)
      || !scope.archive_references.includes(archiveReference) || archives.has(archiveReference)
      || writerRefs.some((item) => !scope.writer_principal_references.includes(item))) {
      throw new Error('WAL archive destination is outside the declared cluster, provider, account, region or writer scope');
    }
    integer(archive.pages_fetched, 'archive.pages_fetched', 1, 100000);
    if (archive.pagination_exhausted !== true) throw new Error('WAL archive destination pagination is incomplete');
    archives.set(archiveReference, { clusterReference, legalHoldStatus: String(legalHoldStatus), writerRefs });
  }

  if (!Array.isArray(manifest.segments)) throw new Error('WAL segments must be an array');
  const segmentKeys = new Set<string>();
  const segmentCounts = new Map<string, number>();
  for (const candidate of manifest.segments) {
    const segment = object(candidate, 'WAL segment');
    const archiveReference = reference(segment.archive_reference, 'segment.archive_reference');
    const clusterReference = reference(segment.cluster_reference, 'segment.cluster_reference');
    const archive = archives.get(archiveReference);
    const cluster = clusters.get(clusterReference);
    const systemIdentifier = segment.system_identifier;
    const timelineId = segment.timeline_id;
    const segmentName = segment.segment_name;
    if (!archive || !cluster || archive.clusterReference !== clusterReference
      || systemIdentifier !== cluster.systemIdentifier
      || typeof timelineId !== 'string' || !cluster.timelineIds.has(timelineId)
      || typeof segmentName !== 'string' || !/^[A-F0-9]{24}$/.test(segmentName)
      || !segmentName.startsWith(timelineId)) {
      throw new Error('WAL segment identity does not match a discovered cluster and archive destination');
    }
    const segmentKey = archiveReference + ':' + clusterReference + ':' + segmentName;
    if (segmentKeys.has(segmentKey)) throw new Error('WAL segment inventory contains a duplicate segment identity');
    segmentKeys.add(segmentKey);
    const firstLsn = lsnValue(segment.first_lsn, 'segment.first_lsn');
    const lastLsn = lsnValue(segment.last_lsn, 'segment.last_lsn');
    if (lastLsn <= firstLsn) throw new Error('WAL segment LSN range must be increasing');
    const archivedAt = isoTimestamp(segment.archived_at, 'segment.archived_at');
    if (archivedAt > now + CLOCK_SKEW_MS) throw new Error('WAL segment archive time cannot be in the future');
    if (segment.retention_expires_at !== null) isoTimestamp(segment.retention_expires_at, 'segment.retention_expires_at');
    if (!['NONE', 'ACTIVE', 'UNKNOWN'].includes(String(segment.legal_hold_status))) {
      throw new Error('segment.legal_hold_status is invalid');
    }
    if (archive.legalHoldStatus === 'ACTIVE' && segment.legal_hold_status === 'NONE') {
      throw new Error('a segment cannot claim no legal hold while its archive destination is under active hold');
    }
    segmentCounts.set(archiveReference, (segmentCounts.get(archiveReference) ?? 0) + 1);
  }
  for (const [archiveReference, archive] of archives) {
    const actual = segmentCounts.get(archiveReference) ?? 0;
    const declared = manifest.archives instanceof Array
      ? (manifest.archives.map((item) => object(item, 'archive')).find((item) => item.archive_reference === archiveReference)?.segment_count)
      : undefined;
    if (integer(declared, 'archive.segment_count', 0, Number.MAX_SAFE_INTEGER) !== actual) {
      throw new Error('archive segment_count does not match the enumerated WAL segment set');
    }
  }

  if (!Array.isArray(manifest.replication_paths) || !Array.isArray(manifest.restore_paths)) {
    throw new Error('WAL/PITR replication_paths and restore_paths must be arrays');
  }
  const replicationRefs: string[] = [];
  for (const candidate of manifest.replication_paths) {
    const path = object(candidate, 'replication path');
    const pathReference = reference(path.replication_path_reference, 'replication_path_reference');
    const sourceCluster = reference(path.source_cluster_reference, 'replication.source_cluster_reference');
    reference(path.target_reference, 'replication.target_reference');
    if (!clusters.has(sourceCluster) || !archives.size || !['ACTIVE', 'PAUSED', 'RETIRED'].includes(String(path.status))) {
      throw new Error('WAL replication path is incomplete or outside the discovered cluster/archive scope');
    }
    const archiveRefs = referenceArray(path.archive_references, 'replication.archive_references');
    if (archiveRefs.length === 0 || archiveRefs.some((item) => !archives.has(item))) throw new Error('replication path must reference at least one known archive destination');
    isoTimestamp(path.last_verified_at, 'replication.last_verified_at');
    replicationRefs.push(pathReference);
  }
  if (new Set(replicationRefs).size !== replicationRefs.length
    || JSON.stringify(sortedUnique(replicationRefs)) !== JSON.stringify(scope.replication_path_references)) {
    throw new Error('replication path catalog does not match the declared scope');
  }

  const restoreRefs: string[] = [];
  for (const candidate of manifest.restore_paths) {
    const path = object(candidate, 'restore path');
    const pathReference = reference(path.restore_path_reference, 'restore_path_reference');
    const sourceCluster = reference(path.source_cluster_reference, 'restore.source_cluster_reference');
    reference(path.target_reference, 'restore.target_reference');
    if (!clusters.has(sourceCluster)) throw new Error('PITR restore path references an unknown PostgreSQL cluster');
    const archiveRefs = referenceArray(path.archive_references, 'restore.archive_references');
    if (archiveRefs.length === 0 || archiveRefs.some((item) => !archives.has(item))) throw new Error('restore path must reference at least one known archive destination');
    const replayStatus = path.tombstone_replay_status;
    if (!['VERIFIED', 'NOT_RUN', 'FAILED'].includes(String(replayStatus))) {
      throw new Error('restore path tombstone_replay_status is invalid');
    }
    const rehearsedAt = isoTimestamp(path.last_rehearsed_at, 'restore.last_rehearsed_at');
    if (rehearsedAt > now + CLOCK_SKEW_MS) throw new Error('PITR restore rehearsal time cannot be in the future');
    if (replayStatus === 'VERIFIED') reference(path.tombstone_replay_evidence_reference, 'restore.tombstone_replay_evidence_reference');
    restoreRefs.push(pathReference);
  }
  if (new Set(restoreRefs).size !== restoreRefs.length
    || JSON.stringify(sortedUnique(restoreRefs)) !== JSON.stringify(scope.restore_path_references)) {
    throw new Error('PITR restore path catalog does not match the declared scope');
  }

  const expectedScope = {
    cluster_references: sortedUnique([...clusters.keys()]),
    archive_references: sortedUnique([...archives.keys()]),
    writer_principal_references: sortedUnique([...archives.values()].flatMap((archive) => archive.writerRefs)),
    replication_path_references: sortedUnique(replicationRefs),
    restore_path_references: sortedUnique(restoreRefs),
  };
  // Provider/account/region scope is independently checked against each archive above.
  // Preserve the explicit source scope arrays in the final canonical scope digest.
  if (JSON.stringify(expectedScope.cluster_references) !== JSON.stringify(scope.cluster_references)
    || JSON.stringify(expectedScope.archive_references) !== JSON.stringify(scope.archive_references)
    || JSON.stringify(expectedScope.writer_principal_references) !== JSON.stringify(scope.writer_principal_references)
    || JSON.stringify(expectedScope.replication_path_references) !== JSON.stringify(scope.replication_path_references)
    || JSON.stringify(expectedScope.restore_path_references) !== JSON.stringify(scope.restore_path_references)) {
    throw new Error('WAL/PITR discovered resources do not reconcile to the declared inventory scope');
  }
  const archiveProviders = sortedUnique((manifest.archives as unknown[]).map((item) => reference(object(item, 'archive').provider_reference, 'archive.provider_reference')));
  const archiveAccounts = sortedUnique((manifest.archives as unknown[]).map((item) => reference(object(item, 'archive').account_reference, 'archive.account_reference')));
  const archiveRegions = sortedUnique((manifest.archives as unknown[]).map((item) => reference(object(item, 'archive').region_reference, 'archive.region_reference')));
  if (JSON.stringify(archiveProviders) !== JSON.stringify(scope.provider_references)
    || JSON.stringify(archiveAccounts) !== JSON.stringify(scope.account_references)
    || JSON.stringify(archiveRegions) !== JSON.stringify(scope.region_references)) {
    throw new Error('WAL/PITR provider, account or region scope does not reconcile to discovered archives');
  }

  const writerCount = expectedScope.writer_principal_references.length;
  const expectedCounts: Record<string, number> = {
    POSTGRESQL_CLUSTER_CATALOG: clusters.size,
    WAL_ARCHIVE_DESTINATION_CATALOG: archives.size,
    WAL_SEGMENT_CATALOG: segmentKeys.size,
    WAL_WRITER_PRINCIPAL_CATALOG: writerCount,
    WAL_REPLICATION_PATH_CATALOG: replicationRefs.length,
    PITR_RESTORE_PATH_CATALOG: restoreRefs.length,
  };
  for (const [kind, count] of Object.entries(expectedCounts)) {
    if (sourceCount(sources, kind) !== count) throw new Error(kind + ' item_count does not match the enumerated WAL/PITR inventory');
  }

  if (expectedDisposition === 'NOT_APPLICABLE'
    && (archives.size > 0 || segmentKeys.size > 0 || writerCount > 0 || replicationRefs.length > 0 || restoreRefs.length > 0)) {
    throw new Error('NOT_APPLICABLE WAL/PITR disposition contradicts discovered archives, writers or restore/replication paths');
  }
  if (expectedDisposition === 'SUPPORTED'
    && (archives.size === 0 || segmentKeys.size === 0
      || [...archives.values()].some((archive) => archive.legalHoldStatus !== 'NONE')
      || (manifest.segments as unknown[]).some((item) => object(item, 'segment').legal_hold_status !== 'NONE')
      || (manifest.restore_paths as unknown[]).some((item) => object(item, 'restore path').tombstone_replay_status !== 'VERIFIED'))) {
    throw new Error('SUPPORTED WAL/PITR disposition requires enumerated archives/segments and known legal-hold status');
  }
}
