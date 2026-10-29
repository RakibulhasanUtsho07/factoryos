import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { CreateSaasBackupWriterInventorySnapshotDto, SAAS_BACKUP_WRITER_ACCESS_PATHS } from './dto/create-saas-backup-writer-inventory-snapshot.dto';
import { ReviewSaasBackupWriterInventorySnapshotDto } from './dto/review-saas-backup-writer-inventory-snapshot.dto';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

const CATEGORIES = new Set(Object.values(SaasTransferDatasetCategory));
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SAFE_PRODUCER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SAFE_PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const ACCESS_PATHS = new Set<string>(SAAS_BACKUP_WRITER_ACCESS_PATHS);
const SECRET_LIKE = /(secret|password|credential|access[-_]?key|token)/i;

interface InventorySnapshotRow extends QueryResultRow {
  snapshot_id: string;
  tenant_id: string;
  category_code: SaasTransferDatasetCategory;
  revision: string | number;
  inventory_reference: string;
  manifest_digest: string;
  entry_count: number;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  idempotency_key: string;
  request_hash: string;
  registered_by_user_id: string;
  reviewed_by_user_id: string | null;
  review_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}
interface InventoryEntryRow extends QueryResultRow {
  entry_ordinal: number;
  producer_id: string;
  provider_principal_reference: string;
  access_path_code: string;
  permission_scope_digest: string;
}
export interface NormalizedBackupWriterInventoryEntry {
  producerId: string;
  providerPrincipalReference: string;
  accessPathCode: typeof SAAS_BACKUP_WRITER_ACCESS_PATHS[number];
  permissionScopeDigest: string;
}
export interface AcceptedBackupWriterInventorySnapshot {
  snapshotId: string;
  tenantId: string;
  category: SaasTransferDatasetCategory;
  revision: number;
  inventoryReference: string;
  manifestDigest: string;
  entryCount: number;
  status: 'ACCEPTED';
  registeredByUserId: string;
  reviewedByUserId: string;
  reviewedAt: string;
  entries: NormalizedBackupWriterInventoryEntry[];
}

/**
 * Tenant-scoped, immutable inventory snapshots for backup writer principals.
 * The records are human-attested governance inputs, not provider discovery.
 */
@Injectable()
export class SaasTenantBackupWriterInventoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createSnapshot(
    tenantValue: string,
    actorValue: string,
    input: CreateSaasBackupWriterInventorySnapshotDto,
  ) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.write');
    const category = this.category(input?.category_code);
    const inventoryReference = this.reference(input?.inventory_reference, 'inventory_reference');
    const idempotencyKey = this.key(input?.idempotency_key, 'idempotency_key');
    const entries = this.normalizeEntries(input?.entries);
    const manifestDigest = this.hash(entries);
    const requestHash = this.hash({
      operation: 'BACKUP_WRITER_INVENTORY_SNAPSHOT',
      category,
      inventoryReference,
      manifestDigest,
      entryCount: entries.length,
    });

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const replay = await client.query<InventorySnapshotRow>(
        'SELECT * FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND category_code=$2 AND idempotency_key=$3 FOR UPDATE',
        [tenantId, category, idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was reused for a different writer inventory snapshot');
        }
        const replayEntries = await this.readEntries(client, tenantId, replay.rows[0].snapshot_id);
        return { row: replay.rows[0], entries: replayEntries, replayed: true };
      }

      const latestResult = await client.query<InventorySnapshotRow>(
        'SELECT * FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND category_code=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [tenantId, category],
      );
      const latest = latestResult.rows[0];
      if (latest?.status === 'PENDING') {
        throw new ConflictException('The latest backup writer inventory is awaiting independent review');
      }
      const revision = Number(latest?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ConflictException('Writer inventory revision is outside supported bounds');
      }
      const snapshotId = randomUUID();
      const inserted = await client.query<InventorySnapshotRow>(
        `INSERT INTO saas_tenant_backup_writer_inventory_snapshots
         (snapshot_id,tenant_id,category_code,revision,inventory_reference,manifest_digest,entry_count,status,
          idempotency_key,request_hash,registered_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10) RETURNING *`,
        [snapshotId, tenantId, category, revision, inventoryReference, manifestDigest, entries.length,
          idempotencyKey, requestHash, actorUserId],
      );
      await this.insertEntries(client, tenantId, snapshotId, entries);
      await this.auditService.recordWithClient(client, {
        tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
        action: 'BACKUP_WRITER_INVENTORY_SNAPSHOT_SUBMITTED', resourceType: 'SAAS_BACKUP_WRITER_INVENTORY',
        resourceId: snapshotId, correlationId: null, requestId: null, dataClass: 'RESTRICTED',
        payload: { category, revision, inventoryReference, manifestDigest, entryCount: entries.length },
      });
      return { row: inserted.rows[0]!, entries, replayed: false };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-backup-writer-inventory:' + tenantId + ':' + category });

    return { snapshot: this.mapSnapshot(result.row, result.entries), replayed: result.replayed };
  }

  async reviewSnapshot(
    tenantValue: string,
    actorValue: string,
    snapshotValue: string,
    input: ReviewSaasBackupWriterInventorySnapshotDto,
  ) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    const snapshotId = this.uuid(snapshotValue, 'snapshotId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.approve');
    const decision = input?.decision;
    if (decision !== 'ACCEPT' && decision !== 'REJECT') {
      throw new BadRequestException('decision must be ACCEPT or REJECT');
    }
    const reason = this.requiredString(input?.reason, 'reason', 1000, 3);
    const status = decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';

    const result = await this.database.transaction(async (client) => {
      await this.lockTenant(client, tenantId);
      const found = await client.query<InventorySnapshotRow>(
        'SELECT * FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND snapshot_id=$2 FOR UPDATE',
        [tenantId, snapshotId],
      );
      const current = found.rows[0];
      if (!current) throw new NotFoundException('Backup writer inventory snapshot not found');
      if (current.status !== 'PENDING') throw new ConflictException('Only a pending writer inventory snapshot can be reviewed');
      if (current.registered_by_user_id === actorUserId) {
        throw new ConflictException('Writer inventory submission and review require different actors');
      }
      const latest = await client.query<{ revision: string | number; snapshot_id: string }>(
        'SELECT revision,snapshot_id FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND category_code=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [tenantId, current.category_code],
      );
      if (!latest.rows[0] || latest.rows[0].snapshot_id !== snapshotId) {
        throw new ConflictException('Only the current writer inventory revision can be reviewed');
      }
      const entries = await this.readEntries(client, tenantId, snapshotId);
      this.assertSnapshotIntegrity(current, entries);
      const updated = await client.query<InventorySnapshotRow>(
        `UPDATE saas_tenant_backup_writer_inventory_snapshots
         SET status=$3,reviewed_by_user_id=$4,review_reason=$5,reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND snapshot_id=$2 AND status='PENDING' RETURNING *`,
        [tenantId, snapshotId, status, actorUserId, reason],
      );
      if (!updated.rows[0]) throw new ConflictException('Writer inventory changed during review');
      await this.auditService.recordWithClient(client, {
        tenantId, factoryId: null, actorUserId, eventType: 'SAAS_DATA_GOVERNANCE',
        action: 'BACKUP_WRITER_INVENTORY_SNAPSHOT_' + decision, resourceType: 'SAAS_BACKUP_WRITER_INVENTORY',
        resourceId: snapshotId, correlationId: null, requestId: null, dataClass: 'RESTRICTED',
        payload: { category: current.category_code, revision: Number(current.revision), manifestDigest: current.manifest_digest,
          entryCount: Number(current.entry_count), decision, reason },
      });
      return { row: updated.rows[0]!, entries };
    }, { tenantId, userId: actorUserId, advisoryLockKey: 'saas-backup-writer-inventory-review:' + tenantId + ':' + snapshotId });

    return this.mapSnapshot(result.row, result.entries);
  }

  async currentSnapshot(tenantValue: string, actorValue: string, categoryValue: string) {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const actorUserId = this.uuid(actorValue, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'saas.data_retention.read');
    const snapshot = await this.requireCurrentAcceptedSnapshot(tenantId, this.category(categoryValue));
    return this.mapSnapshotView(snapshot, true);
  }

  async requireCurrentAcceptedSnapshot(
    tenantValue: string,
    categoryValue: SaasTransferDatasetCategory,
  ): Promise<AcceptedBackupWriterInventorySnapshot> {
    const tenantId = this.uuid(tenantValue, 'tenantId');
    const category = this.category(categoryValue);
    const result = await this.database.query<InventorySnapshotRow>(
      'SELECT * FROM saas_tenant_backup_writer_inventory_snapshots WHERE tenant_id=$1 AND category_code=$2 ORDER BY revision DESC LIMIT 1',
      [tenantId, category], { tenantId },
    );
    const row = result.rows[0];
    if (!row || row.status !== 'ACCEPTED' || !row.reviewed_by_user_id || !row.reviewed_at) {
      throw new ServiceUnavailableException('The latest backup writer inventory is not independently accepted');
    }
    const entries = await this.readEntriesOutsideTransaction(tenantId, row.snapshot_id);
    this.assertSnapshotIntegrity(row, entries);
    return {
      snapshotId: row.snapshot_id,
      tenantId: row.tenant_id,
      category: row.category_code,
      revision: Number(row.revision),
      inventoryReference: row.inventory_reference,
      manifestDigest: row.manifest_digest,
      entryCount: Number(row.entry_count),
      status: 'ACCEPTED',
      registeredByUserId: row.registered_by_user_id,
      reviewedByUserId: row.reviewed_by_user_id,
      reviewedAt: row.reviewed_at,
      entries,
    };
  }

  private async insertEntries(
    client: PoolClient,
    tenantId: string,
    snapshotId: string,
    entries: NormalizedBackupWriterInventoryEntry[],
  ): Promise<void> {
    const rows = entries.map((entry, index) => ({
      entry_ordinal: index + 1,
      producer_id: entry.producerId,
      provider_principal_reference: entry.providerPrincipalReference,
      access_path_code: entry.accessPathCode,
      permission_scope_digest: entry.permissionScopeDigest,
    }));
    for (let offset = 0; offset < rows.length; offset += 500) {
      await client.query(
        `INSERT INTO saas_tenant_backup_writer_inventory_entries
         (tenant_id,snapshot_id,entry_ordinal,producer_id,provider_principal_reference,access_path_code,permission_scope_digest)
         SELECT $1,$2,x.entry_ordinal,x.producer_id,x.provider_principal_reference,x.access_path_code,x.permission_scope_digest
         FROM jsonb_to_recordset($3::jsonb) AS x(
           entry_ordinal integer,producer_id text,provider_principal_reference text,access_path_code text,permission_scope_digest text
         ) ORDER BY x.entry_ordinal`,
        [tenantId, snapshotId, JSON.stringify(rows.slice(offset, offset + 500))],
      );
    }
  }

  private async readEntries(client: PoolClient, tenantId: string, snapshotId: string): Promise<NormalizedBackupWriterInventoryEntry[]> {
    const result = await client.query<InventoryEntryRow>(
      `SELECT entry_ordinal,producer_id,provider_principal_reference,access_path_code,permission_scope_digest
       FROM saas_tenant_backup_writer_inventory_entries WHERE tenant_id=$1 AND snapshot_id=$2 ORDER BY entry_ordinal`,
      [tenantId, snapshotId],
    );
    return this.normalizeEntries(result.rows.map((row) => ({
      producer_id: row.producer_id,
      provider_principal_reference: row.provider_principal_reference,
      access_path_code: row.access_path_code,
      permission_scope_digest: row.permission_scope_digest,
    })));
  }

  private async readEntriesOutsideTransaction(tenantId: string, snapshotId: string): Promise<NormalizedBackupWriterInventoryEntry[]> {
    const result = await this.database.query<InventoryEntryRow>(
      `SELECT entry_ordinal,producer_id,provider_principal_reference,access_path_code,permission_scope_digest
       FROM saas_tenant_backup_writer_inventory_entries WHERE tenant_id=$1 AND snapshot_id=$2 ORDER BY entry_ordinal`,
      [tenantId, snapshotId], { tenantId },
    );
    return this.normalizeEntries(result.rows.map((row) => ({
      producer_id: row.producer_id,
      provider_principal_reference: row.provider_principal_reference,
      access_path_code: row.access_path_code,
      permission_scope_digest: row.permission_scope_digest,
    })));
  }

  private normalizeEntries(value: unknown): NormalizedBackupWriterInventoryEntry[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10000) {
      throw new BadRequestException('Writer inventory entries must contain 1 to 10,000 records');
    }
    const result: NormalizedBackupWriterInventoryEntry[] = value.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException('Writer inventory entry ' + (index + 1) + ' is malformed');
      }
      const row = raw as Record<string, unknown>;
      const producerId = this.producer(row.producer_id ?? row.producerId);
      const providerPrincipalReference = this.principal(row.provider_principal_reference ?? row.providerPrincipalReference);
      const accessPath = row.access_path_code ?? row.accessPathCode;
      if (typeof accessPath !== 'string' || !ACCESS_PATHS.has(accessPath)) {
        throw new BadRequestException('Writer inventory access path is unsupported');
      }
      const permissionScopeDigest = this.digest(row.permission_scope_digest ?? row.permissionScopeDigest, 'permission_scope_digest');
      return { producerId, providerPrincipalReference, accessPathCode: accessPath as NormalizedBackupWriterInventoryEntry['accessPathCode'], permissionScopeDigest };
    });
    result.sort((a, b) =>
      a.producerId.localeCompare(b.producerId)
      || a.providerPrincipalReference.localeCompare(b.providerPrincipalReference)
      || a.accessPathCode.localeCompare(b.accessPathCode)
      || a.permissionScopeDigest.localeCompare(b.permissionScopeDigest));
    const identities = new Set<string>();
    for (const entry of result) {
      const identity = JSON.stringify([entry.producerId, entry.providerPrincipalReference, entry.accessPathCode]);
      if (identities.has(identity)) throw new BadRequestException('Writer inventory contains a duplicate producer/principal/access-path identity');
      identities.add(identity);
    }
    return result;
  }

  private assertSnapshotIntegrity(
    row: InventorySnapshotRow,
    entries: NormalizedBackupWriterInventoryEntry[],
  ): void {
    if (entries.length !== Number(row.entry_count) || this.hash(entries) !== row.manifest_digest) {
      throw new ServiceUnavailableException('Writer inventory entry digest/count differs from the immutable reviewed snapshot');
    }
  }

  private mapSnapshot(row: InventorySnapshotRow, entries: NormalizedBackupWriterInventoryEntry[], replayed?: boolean) {
    return {
      snapshotId: row.snapshot_id, tenantId: row.tenant_id, category: row.category_code,
      revision: Number(row.revision), inventoryReference: row.inventory_reference,
      manifestDigest: row.manifest_digest, entryCount: Number(row.entry_count), status: row.status,
      idempotencyKey: row.idempotency_key, registeredByUserId: row.registered_by_user_id,
      reviewedByUserId: row.reviewed_by_user_id, reviewReason: row.review_reason,
      reviewedAt: row.reviewed_at, createdAt: row.created_at, updatedAt: row.updated_at,
      entries, ...(replayed === undefined ? {} : { replayed }),
    };
  }
  private mapSnapshotView(row: AcceptedBackupWriterInventorySnapshot, includeEntries: boolean) {
    return {
      snapshotId: row.snapshotId, tenantId: row.tenantId, category: row.category, revision: row.revision,
      inventoryReference: row.inventoryReference, manifestDigest: row.manifestDigest, entryCount: row.entryCount,
      status: row.status, registeredByUserId: row.registeredByUserId, reviewedByUserId: row.reviewedByUserId,
      reviewedAt: row.reviewedAt, ...(includeEntries ? { entries: row.entries } : {}),
    };
  }

  private async lockTenant(client: PoolClient, tenantId: string): Promise<void> {
    const result = await client.query<{ id: string }>('SELECT id::text AS id FROM tenants WHERE id=$1::uuid FOR UPDATE', [tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Tenant not found');
  }
  private uuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
    return value.toLowerCase();
  }
  private category(value: unknown): SaasTransferDatasetCategory {
    if (typeof value !== 'string' || !CATEGORIES.has(value as SaasTransferDatasetCategory)) throw new BadRequestException('Unsupported dataset category');
    return value as SaasTransferDatasetCategory;
  }
  private reference(value: unknown, field: string): string {
    if (typeof value !== 'string' || !SAFE_REFERENCE.test(value) || value.includes('://') || SECRET_LIKE.test(value)) {
      throw new BadRequestException(field + ' must be a non-secret opaque inventory reference');
    }
    return value;
  }
  private principal(value: unknown): string {
    if (typeof value !== 'string' || !SAFE_PRINCIPAL.test(value) || value.includes('://') || SECRET_LIKE.test(value)) {
      throw new BadRequestException('provider_principal_reference must be an opaque principal identifier, not a credential');
    }
    return value;
  }
  private producer(value: unknown): string {
    if (typeof value !== 'string' || !SAFE_PRODUCER.test(value)) throw new BadRequestException('producer_id has invalid characters');
    return value;
  }
  private key(value: unknown, field: string): string {
    if (typeof value !== 'string' || !SAFE_KEY.test(value)) throw new BadRequestException(field + ' has invalid characters');
    return value;
  }
  private digest(value: unknown, field: string): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new BadRequestException(field + ' must be a lowercase SHA-256 digest');
    return value;
  }
  private requiredString(value: unknown, field: string, max: number, min: number): string {
    if (typeof value !== 'string') throw new BadRequestException(field + ' is required');
    const normalized = value.trim();
    if (normalized.length < min || normalized.length > max) throw new BadRequestException(field + ' length is invalid');
    return normalized;
  }
  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }
}
