import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type {
  SaasTenantMigrationTargetAdapter,
  SaasTenantTransferExportManifest,
} from './saas-tenant-data-transfer.adapters';
import { SAAS_TENANT_DATASET_TABLES } from './saas-tenant-postgres-dataset-source';
import { assertSaasTenantTransferFieldSafe } from './saas-tenant-transfer-field-guard';
import { assertSaasTenantIamEffectiveAccess, buildSaasTenantIamRemappingPlan } from './saas-tenant-iam-remapping.plan';
import type { SaasTenantIamPortableSnapshot, SaasTenantIamTargetDirectory, SaasIamTransferStatus, SaasTenantMembershipStatus } from './saas-tenant-iam-remapping.plan';
import {
  REQUIRED_TRANSFER_CATEGORIES,
  SaasTransferDatasetCategory,
} from './dto/create-saas-schema-compatibility-rule.dto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION_PATTERN = /^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/;
const HEADER_MARKER = ',"datasets":{';
const MAX_HEADER_BYTES = 16_384;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 65_536;
const STAGE_BATCH_SIZE = 100;
const PAGE_SIZE = 500;
const IAM_TABLES = new Set(['iam_memberships', 'iam_roles', 'iam_user_roles', 'iam_role_permissions']);

type BundleEvent =
  | { kind: 'header'; value: Record<string, unknown> }
  | { kind: 'category'; value: SaasTransferDatasetCategory }
  | { kind: 'row'; category: SaasTransferDatasetCategory; table: string; value: Record<string, unknown> }
  | { kind: 'manifest'; value: SaasTenantTransferExportManifest };

interface TargetReceipt {
  id: string;
  source_schema_version: string;
  target_schema_version: string;
  source_manifest: SaasTenantTransferExportManifest;
  target_manifest: SaasTenantTransferExportManifest;
  target_snapshot_digest: string;
}

/**
 * Exact-schema PostgreSQL importer for isolated targets.
 * The destination tenant must be pre-provisioned, including its referenced users.
 * Existing tenant rows are never overwritten: the import either verifies an
 * existing receipt or atomically inserts a previously empty reviewed dataset.
 */
@Injectable()
export class SaasTenantPostgresMigrationTargetAdapter
  implements SaasTenantMigrationTargetAdapter, OnModuleDestroy
{
  private targetPool?: Pool;

  constructor(
    private readonly configService: ConfigService,
    private readonly sourceDatabase: DatabaseService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.targetPool?.end();
  }

  async importBundle(input: {
    tenantId: string;
    transferId: string;
    sourceSchemaVersion: string;
    targetSchemaVersion: string;
    sourceBundle: AsyncIterable<Buffer>;
    sourceManifest: SaasTenantTransferExportManifest;
    requiredCategories: SaasTransferDatasetCategory[];
  }): Promise<{
    targetBundleReference: string;
    targetBundleDigest: string;
    targetManifest: SaasTenantTransferExportManifest;
  }> {
    this.validateRequest(input);
    if (input.sourceSchemaVersion !== input.targetSchemaVersion) {
      throw new ServiceUnavailableException(
        'This target adapter supports exact-schema copies only; a schema transformation adapter is required for different versions',
      );
    }

    const categories = Object.keys(input.sourceManifest) as SaasTransferDatasetCategory[];
    const categoryTables = this.resolveCategoryTables(categories);
    const allTables = [...new Set(categoryTables.flatMap((entry) => entry.tables))];
    const pool = await this.getTargetPool();
    await this.assertDistinctDatabase(pool);

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [input.tenantId, ''],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [input.tenantId + ':' + input.transferId],
      );

      await this.assertReceiptTableExists(client);
      const prior = await client.query<TargetReceipt>(
        'SELECT id, source_schema_version, target_schema_version, source_manifest, ' +
          'target_manifest, target_snapshot_digest ' +
          'FROM public.saas_tenant_import_receipts ' +
          'WHERE tenant_id = $1::uuid AND transfer_id = $2::uuid LIMIT 1',
        [input.tenantId, input.transferId],
      );
      if (prior.rows[0]) {
        const receipt = prior.rows[0];
        if (
          receipt.source_schema_version !== input.sourceSchemaVersion ||
          receipt.target_schema_version !== input.targetSchemaVersion ||
          this.canonicalJson(receipt.source_manifest) !== this.canonicalJson(input.sourceManifest)
        ) {
          throw new ConflictException(
            'A target import receipt exists for this transfer with a different source manifest',
          );
        }
        // A receipt proves what was imported once, not that mutable target rows
        // still match that import. Re-measure on every retry before returning success.
        const replayManifest = await this.measureTargetManifest(client, input.tenantId, categoryTables);
        this.assertManifestMatchesInput(replayManifest, receipt.target_manifest, input.requiredCategories);
        const replayDigest = createHash('sha256').update(this.canonicalJson({
          tenantId: input.tenantId,
          transferId: input.transferId,
          sourceSchemaVersion: input.sourceSchemaVersion,
          targetSchemaVersion: input.targetSchemaVersion,
          manifest: replayManifest,
        })).digest('hex');
        if (replayDigest !== receipt.target_snapshot_digest) {
          throw new ConflictException(
            'Target tenant data changed after the recorded import; refusing to attest a replay',
          );
        }

        await client.query('COMMIT');
        transactionOpen = false;
        return {
          targetBundleReference: 'pgimport:' + receipt.id,
          targetBundleDigest: replayDigest,
          targetManifest: replayManifest,
        };
      }

      const tenant = await client.query(
        'SELECT id FROM public.tenants WHERE id = $1::uuid LIMIT 1',
        [input.tenantId],
      );
      if (tenant.rowCount !== 1) {
        throw new ConflictException('Target tenant must be provisioned before data import');
      }

      const columns = await this.readTargetColumns(client, allTables);
      for (const table of allTables) {
        const tableColumns = columns.get(table);
        if (!tableColumns?.has('id') || !tableColumns.has('tenant_id')) {
          throw new ServiceUnavailableException(
            'Target schema does not expose the reviewed id/tenant_id contract for ' + table,
          );
        }
        const existing = await client.query(
          'SELECT 1 FROM public.' + this.quoteIdentifier(table) +
            ' WHERE tenant_id = $1::uuid LIMIT 1',
          [input.tenantId],
        );
        if (existing.rowCount) {
          throw new ConflictException(
            'Target tenant already contains rows in ' + table +
            '; imports never overwrite existing tenant data',
          );
        }
      }

      await client.query(
        'CREATE TEMP TABLE factoryos_transfer_stage (' +
          'sequence BIGSERIAL PRIMARY KEY, category TEXT NOT NULL, ' +
          'table_name TEXT NOT NULL, row_payload JSONB NOT NULL' +
        ') ON COMMIT DROP',
      );

      const tableColumnsInBundle = new Map<string, string[]>();
      const categoriesSeen = new Set<SaasTransferDatasetCategory>();
      let stagedCount = 0;
      let batch: Array<{
        category: string;
        table: string;
        payload: Record<string, unknown>;
      }> = [];

      const flushStage = async () => {
        if (batch.length === 0) return;
        const values: unknown[] = [];
        const tuples = batch.map((entry, index) => {
          const base = index * 3;
          values.push(entry.category, entry.table, JSON.stringify(entry.payload));
          return '($' + (base + 1) + ', $' + (base + 2) + ', $' + (base + 3) + '::jsonb)';
        });
        await client.query(
          'INSERT INTO pg_temp.factoryos_transfer_stage (category, table_name, row_payload) VALUES ' +
            tuples.join(', '),
          values,
        );
        stagedCount += batch.length;
        batch = [];
      };

      let headerSeen = false;
      let trailerSeen = false;
      for await (const event of this.readBundleEvents(input.sourceBundle)) {
        if (event.kind === 'header') {
          headerSeen = true;
          if (
            event.value.format !== 'FACTORYOS_TENANT_EXPORT' ||
            event.value.formatVersion !== 2 ||
            event.value.tenantId !== input.tenantId ||
            event.value.schemaVersion !== input.sourceSchemaVersion
          ) {
            throw new ConflictException(
              'Source bundle header does not match the requested tenant/schema contract',
            );
          }
          continue;
        }
        if (!headerSeen) throw new BadRequestException('Source bundle is missing its header');

        if (event.kind === 'category') {
          if (categoriesSeen.has(event.value)) {
            throw new ConflictException('Source bundle contains a duplicate dataset category');
          }
          categoriesSeen.add(event.value);
          continue;
        }
        if (event.kind === 'manifest') {
          trailerSeen = true;
          this.assertManifestMatchesInput(event.value, input.sourceManifest, input.requiredCategories);
          continue;
        }
        if (trailerSeen) throw new BadRequestException('Source bundle contains records after its manifest');
        if (!categoriesSeen.has(event.category)) {
          throw new BadRequestException('Source bundle row appeared before its category declaration');
        }

        const row = event.value;
        const payload = { ...row };
        delete payload.__factoryos_table;
        if (row.tenant_id !== input.tenantId) {
          throw new BadRequestException('Source bundle contains a row without the authenticated tenant scope');
        }
        // Validate nested JSON fields too; checking only the top-level table
        // columns would allow secret hashes to hide inside JSONB values.
        this.canonicalJson(payload);
        const keys = Object.keys(payload).sort();

        if (event.category === SaasTransferDatasetCategory.IAM_ACCESS) {
          if (!IAM_TABLES.has(event.table)) {
            throw new ServiceUnavailableException('No reviewed IAM remapper is registered for ' + event.table);
          }
          this.validateIamPortableRow(event.table, payload, input.tenantId);
          batch.push({ category: event.category, table: event.table, payload });
          if (batch.length >= STAGE_BATCH_SIZE) await flushStage();
          continue;
        }

        const approvedTables = SAAS_TENANT_DATASET_TABLES[event.category];
        if (!approvedTables?.includes(event.table)) {
          throw new ServiceUnavailableException(
            'No reviewed target importer is registered for ' + event.category + '/' + event.table,
          );
        }
        if (typeof row.id !== 'string' || !UUID_PATTERN.test(row.id)) {
          throw new BadRequestException('Source bundle contains a row without a valid logical row ID');
        }
        for (const key of keys) {
          if (!columns.get(event.table)?.has(key)) {
            throw new ConflictException(
              'Source relation ' + event.table +
                ' has a column not available in the target schema: ' + key,
            );
          }
        }
        const previousKeys = tableColumnsInBundle.get(event.table);
        if (previousKeys && this.canonicalJson(previousKeys) !== this.canonicalJson(keys)) {
          throw new ConflictException('Source rows have inconsistent field sets in relation ' + event.table);
        }
        tableColumnsInBundle.set(event.table, keys);
        batch.push({ category: event.category, table: event.table, payload });
        if (batch.length >= STAGE_BATCH_SIZE) await flushStage();
      }
      await flushStage();

      if (!headerSeen || !trailerSeen) {
        throw new BadRequestException('Source bundle is incomplete or has no verified manifest');
      }
      for (const category of Object.keys(input.sourceManifest)) {
        if (!categoriesSeen.has(category as SaasTransferDatasetCategory)) {
          throw new ConflictException('Source bundle is missing a manifest category: ' + category);
        }
      }
      for (const category of input.requiredCategories) {
        if (!categoriesSeen.has(category)) {
          throw new ConflictException('Source bundle is missing required category ' + category);
        }
      }
      if (!Number.isSafeInteger(stagedCount)) {
        throw new ConflictException('Source bundle exceeds the supported record-count limit');
      }

      await client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of this.dependencyOrder(allTables)) {
        const keys = tableColumnsInBundle.get(table);
        if (!keys) continue;
        if (table === 'inventory_locations') {
          await this.importInventoryLocations(client, input.tenantId, keys);
          continue;
        }
        const columnSql = keys.map((key) => this.quoteIdentifier(key)).join(', ');
        const projectionSql = keys.map((key) =>
          table === 'business_blueprints' && key === 'current_version_id'
            ? 'NULL AS ' + this.quoteIdentifier(key)
            : 'target_row.' + this.quoteIdentifier(key),
        ).join(', ');
        await client.query(
          'INSERT INTO public.' + this.quoteIdentifier(table) + ' (' + columnSql + ') ' +
          'SELECT ' + projectionSql + ' ' +
          'FROM pg_temp.factoryos_transfer_stage AS staged ' +
          'CROSS JOIN LATERAL jsonb_populate_record(NULL::public.' + this.quoteIdentifier(table) +
          ', staged.row_payload) AS target_row ' +
          'WHERE staged.table_name = $1 ORDER BY staged.sequence',
          [table],
        );
      }

      // business_blueprints and business_blueprint_versions have a circular, immediate FK.
      // Insert blueprints with a null current pointer, insert versions, then restore the pointer.
      if (tableColumnsInBundle.get('business_blueprints')?.includes('current_version_id')) {
        await client.query(
          'UPDATE public.business_blueprints AS target_row ' +
            'SET current_version_id = (staged.row_payload->>\'current_version_id\')::uuid ' +
            'FROM pg_temp.factoryos_transfer_stage AS staged ' +
            'WHERE staged.table_name = \'business_blueprints\' ' +
            'AND target_row.id = (staged.row_payload->>\'id\')::uuid ' +
            'AND staged.row_payload->>\'current_version_id\' IS NOT NULL',
        );
      }

      if (categoriesSeen.has(SaasTransferDatasetCategory.IAM_ACCESS)) {
        await this.applyIamAccess(client, input.tenantId);
      }

      const targetManifest = await this.measureTargetManifest(client, input.tenantId, categoryTables);
      this.assertManifestMatchesInput(targetManifest, input.sourceManifest, input.requiredCategories);

      const targetSnapshotDigest = createHash('sha256').update(this.canonicalJson({
        tenantId: input.tenantId,
        transferId: input.transferId,
        sourceSchemaVersion: input.sourceSchemaVersion,
        targetSchemaVersion: input.targetSchemaVersion,
        manifest: targetManifest,
      })).digest('hex');
      const receiptId = randomUUID();
      await client.query(
        'INSERT INTO public.saas_tenant_import_receipts (' +
          'id, tenant_id, transfer_id, source_schema_version, target_schema_version, ' +
          'source_manifest, target_manifest, source_manifest_digest, target_snapshot_digest' +
        ') VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8, $9)',
        [
          receiptId,
          input.tenantId,
          input.transferId,
          input.sourceSchemaVersion,
          input.targetSchemaVersion,
          JSON.stringify(input.sourceManifest),
          JSON.stringify(targetManifest),
          createHash('sha256').update(this.canonicalJson(input.sourceManifest)).digest('hex'),
          targetSnapshotDigest,
        ],
      );

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        targetBundleReference: 'pgimport:' + receiptId,
        targetBundleDigest: targetSnapshotDigest,
        targetManifest,
      };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private validateRequest(input: {
    tenantId: string;
    transferId: string;
    sourceSchemaVersion: string;
    targetSchemaVersion: string;
    sourceManifest: SaasTenantTransferExportManifest;
    requiredCategories: SaasTransferDatasetCategory[];
  }): void {
    if (!UUID_PATTERN.test(input.tenantId) || !UUID_PATTERN.test(input.transferId)) {
      throw new BadRequestException('Tenant and transfer identifiers must be UUIDs');
    }
    if (
      !SCHEMA_VERSION_PATTERN.test(input.sourceSchemaVersion) ||
      !SCHEMA_VERSION_PATTERN.test(input.targetSchemaVersion)
    ) {
      throw new BadRequestException('Source and target schema versions are invalid');
    }
    if (!input.sourceManifest || typeof input.sourceManifest !== 'object' || Array.isArray(input.sourceManifest)) {
      throw new BadRequestException('Source manifest must be an object');
    }
    const keys = Object.keys(input.sourceManifest) as SaasTransferDatasetCategory[];
    if (keys.some((category) => !Object.values(SaasTransferDatasetCategory).includes(category))) {
      throw new BadRequestException('Source manifest contains an unsupported dataset category');
    }
    if (
      REQUIRED_TRANSFER_CATEGORIES.some((category) => !keys.includes(category)) ||
      input.requiredCategories.some((category) => !keys.includes(category))
    ) {
      throw new ConflictException('Source manifest is missing a mandatory preservation category');
    }
    for (const [category, entry] of Object.entries(input.sourceManifest)) {
      if (
        !entry ||
        !Number.isSafeInteger(entry.record_count) ||
        entry.record_count < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) {
        throw new BadRequestException('Source manifest entry is invalid for ' + category);
      }
    }
  }

  private resolveCategoryTables(categories: SaasTransferDatasetCategory[]) {
    return categories.map((category) => {
      if (category === SaasTransferDatasetCategory.IAM_ACCESS) return { category, tables: [] as readonly string[] };
      const tables = SAAS_TENANT_DATASET_TABLES[category];
      if (!tables?.length) {
        throw new ServiceUnavailableException(
          'No reviewed PostgreSQL target adapter is registered for ' + category,
        );
      }
      return { category, tables };
    });
  }

  private async getTargetPool(): Promise<Pool> {
    if (this.targetPool) return this.targetPool;
    const connectionString = this.configService.get<string>('SAAS_TRANSFER_TARGET_DATABASE_URL');
    if (!connectionString) {
      throw new ServiceUnavailableException(
        'Tenant migration is disabled until SAAS_TRANSFER_TARGET_DATABASE_URL points to a dedicated target database',
      );
    }
    const pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    try {
      await pool.query('SELECT 1');
      this.targetPool = pool;
      return pool;
    } catch {
      await pool.end().catch(() => undefined);
      throw new ServiceUnavailableException('Configured tenant transfer target database is not reachable');
    }
  }

  private async assertDistinctDatabase(targetPool: Pool): Promise<void> {
    const sourceResult = await this.sourceDatabase.query<{
      database_name: string;
      database_oid: string;
      server_address: string | null;
      server_port: number | null;
    }>(
      'SELECT current_database() AS database_name, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid, ' +
        'inet_server_addr()::text AS server_address, inet_server_port() AS server_port',
    );
    const targetResult = await targetPool.query<{
      database_name: string;
      database_oid: string;
      server_address: string | null;
      server_port: number | null;
    }>(
      'SELECT current_database() AS database_name, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid, ' +
        'inet_server_addr()::text AS server_address, inet_server_port() AS server_port',
    );
    const source = sourceResult.rows[0];
    const target = targetResult.rows[0];
    if (!source || !target) {
      throw new ServiceUnavailableException('Could not verify target database isolation');
    }
    if (source.database_name === target.database_name && source.database_oid === target.database_oid) {
      throw new ConflictException('Tenant migration target must be a different PostgreSQL database from the source');
    }
  }

  private async assertReceiptTableExists(client: PoolClient): Promise<void> {
    const result = await client.query(
      "SELECT to_regclass('public.saas_tenant_import_receipts') AS relation",
    );
    if (!result.rows[0]?.relation) {
      throw new ServiceUnavailableException('Target database is missing migration 053_saas_tenant_import_receipts');
    }
  }

  private async readTargetColumns(client: PoolClient, tables: string[]): Promise<Map<string, Set<string>>> {
    const result = await client.query<{
      table_name: string;
      column_name: string;
      is_generated: string;
    }>(
      "SELECT table_name, column_name, is_generated FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
      [tables],
    );
    const columns = new Map<string, Set<string>>();
    for (const row of result.rows) {
      if (row.is_generated !== 'ALWAYS') {
        const tableColumns = columns.get(row.table_name) ?? new Set<string>();
        tableColumns.add(row.column_name);
        columns.set(row.table_name, tableColumns);
      }
    }
    for (const table of tables) {
      if (!columns.has(table)) {
        throw new ServiceUnavailableException('Target database is missing reviewed relation ' + table);
      }
    }
    return columns;
  }

  private async importInventoryLocations(
    client: PoolClient,
    tenantId: string,
    keys: string[],
  ): Promise<void> {
    const table = 'inventory_locations';
    const defaultCountResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pg_temp.factoryos_transfer_stage " +
        "WHERE table_name = $1 AND (row_payload->>'is_default')::boolean IS TRUE",
      [table],
    );
    const defaultCount = Number(defaultCountResult.rows[0]?.count ?? '0');
    if (!Number.isSafeInteger(defaultCount) || defaultCount < 0) {
      throw new ConflictException('Source inventory-location default count is invalid');
    }

    if (defaultCount > 0) {
      const savepoint = 'factoryos_inventory_location_rebind';
      await client.query('SAVEPOINT ' + savepoint);
      try {
        await client.query(
          "SELECT set_config('app.saas_tenant_transfer_import', 'on', true)",
        );
        const setList = keys
          .map((key) => 'target_row.' + this.quoteIdentifier(key) + ' = source_row.' + this.quoteIdentifier(key))
          .join(', ');
        const rebound = await client.query<{ id: string }>(
          'UPDATE public.inventory_locations AS target_row SET ' + setList + ' ' +
          'FROM pg_temp.factoryos_transfer_stage AS staged ' +
          'CROSS JOIN LATERAL jsonb_populate_record(NULL::public.inventory_locations, staged.row_payload) AS source_row ' +
          'WHERE staged.table_name = $1 ' +
          'AND source_row.is_default IS TRUE ' +
          'AND target_row.tenant_id = $2::uuid ' +
          'AND target_row.factory_id = source_row.factory_id ' +
          'AND target_row.is_default IS TRUE ' +
          'AND target_row.location_code = source_row.location_code ' +
          'RETURNING target_row.id::text AS id',
          [table, tenantId],
        );
        if (rebound.rowCount !== defaultCount) {
          throw new ConflictException(
            'Target factory-created default locations do not match the source inventory-location manifest',
          );
        }
        await client.query("SELECT set_config('app.saas_tenant_transfer_import', '', true)");
        await client.query('RELEASE SAVEPOINT ' + savepoint);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT ' + savepoint).catch(() => undefined);
        await client.query('RELEASE SAVEPOINT ' + savepoint).catch(() => undefined);
        throw error;
      }
    }

    const nonDefaultCountResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pg_temp.factoryos_transfer_stage " +
        "WHERE table_name = $1 AND (row_payload->>'is_default')::boolean IS DISTINCT FROM TRUE",
      [table],
    );
    const nonDefaultCount = Number(nonDefaultCountResult.rows[0]?.count ?? '0');
    if (!Number.isSafeInteger(nonDefaultCount) || nonDefaultCount < 0) {
      throw new ConflictException('Source inventory-location count is invalid');
    }
    if (nonDefaultCount === 0) return;

    const columnSql = keys.map((key) => this.quoteIdentifier(key)).join(', ');
    const projectionSql = keys.map((key) => 'source_row.' + this.quoteIdentifier(key)).join(', ');
    const inserted = await client.query(
      'WITH RECURSIVE location_hierarchy(sequence, row_payload, location_id, parent_location_id, depth) AS (' +
        'SELECT staged.sequence, staged.row_payload, (staged.row_payload->>\'id\')::uuid, ' +
          'NULLIF(staged.row_payload->>\'parent_location_id\', \'\')::uuid, 0 ' +
        'FROM pg_temp.factoryos_transfer_stage AS staged ' +
        'WHERE staged.table_name = $1 ' +
          'AND (staged.row_payload->>\'parent_location_id\' IS NULL OR staged.row_payload->>\'parent_location_id\' = \'\') ' +
        'UNION ALL ' +
        'SELECT child.sequence, child.row_payload, (child.row_payload->>\'id\')::uuid, ' +
          'NULLIF(child.row_payload->>\'parent_location_id\', \'\')::uuid, parent.depth + 1 ' +
        'FROM pg_temp.factoryos_transfer_stage AS child ' +
        'JOIN location_hierarchy AS parent ' +
          'ON NULLIF(child.row_payload->>\'parent_location_id\', \'\')::uuid = parent.location_id ' +
        'WHERE child.table_name = $1 ' +
          'AND NULLIF(child.row_payload->>\'parent_location_id\', \'\') IS NOT NULL' +
      ') ' +
      'INSERT INTO public.inventory_locations (' + columnSql + ') ' +
      'SELECT ' + projectionSql + ' ' +
      'FROM location_hierarchy AS staged ' +
      'CROSS JOIN LATERAL jsonb_populate_record(NULL::public.inventory_locations, staged.row_payload) AS source_row ' +
      'WHERE source_row.is_default IS DISTINCT FROM TRUE ' +
      'ORDER BY staged.depth, staged.sequence',
      [table],
    );
    if (inserted.rowCount !== nonDefaultCount) {
      throw new ConflictException(
        'Target inventory locations could not be imported in parent-before-child order',
      );
    }
  }

  private dependencyOrder(tables: string[]): string[] {
    const preferred = [
      'legal_entities', 'factories', 'inventory_locations',
      'business_blueprints', 'business_blueprint_versions',
      'business_entities', 'business_relations',
      'business_processes', 'business_process_steps',
      'business_rules', 'business_terms', 'business_exceptions',
      'business_change_proposals', 'business_conflicts', 'business_feedback',
      'orders', 'order_lines', 'order_event_projections',
      'inventory_items', 'inventory_stock_balances', 'inventory_movements',
      'growth_opportunities', 'growth_scenarios', 'growth_experiments',
      'risk_classes', 'policies', 'approvals',
      'saas_usage_rate_cards', 'saas_usage_events', 'saas_usage_adjustments',
      'saas_usage_reconciliations', 'saas_usage_budgets', 'saas_budget_evaluations',
      'saas_workload_control_events', 'saas_budget_alerts', 'saas_budget_alert_acknowledgements',
      'saas_provider_cost_events', 'saas_provider_cost_reconciliations',
      'ai_decision_envelopes', 'ai_context_packages', 'ai_verification_runs',
      'research_sources', 'research_claims', 'research_claim_links',
      'research_knowledge_releases', 'research_relevance_mappings',
      'research_release_evaluations',
      'business_evidence', 'business_evidence_links', 'growth_opportunity_evidence',
      'growth_experiment_results', 'growth_opportunity_outcomes',
      'audit_events',
    ];    const ordered = preferred.filter((table) => tables.includes(table));
    for (const table of tables) if (!ordered.includes(table)) ordered.push(table);
    return ordered;
  }

  private validateIamPortableRow(table: string, row: Record<string, unknown>, tenantId: string): void {
    if (row.tenant_id !== tenantId) throw new BadRequestException('IAM portable record is outside the requested tenant scope');
    const expectedFields: Record<string, string[]> = {
      iam_memberships: ['status', 'tenant_id', 'user_id'],
      iam_roles: ['code', 'description', 'is_system', 'name', 'status', 'tenant_id'],
      iam_user_roles: ['factory_code', 'role_code', 'tenant_id', 'user_id'],
      iam_role_permissions: ['permission_code', 'role_code', 'tenant_id'],
    };
    const expected = expectedFields[table];
    if (!expected || this.canonicalJson(Object.keys(row).sort()) !== this.canonicalJson(expected)) {
      throw new BadRequestException('IAM portable record has an unexpected field set for ' + table);
    }
    if (table === 'iam_memberships') {
      if (typeof row.user_id !== 'string' || !UUID_PATTERN.test(row.user_id) ||
          !['ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED'].includes(String(row.status))) {
        throw new BadRequestException('IAM portable membership is invalid');
      }
      return;
    }
    if (table === 'iam_roles') {
      if (typeof row.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.code) ||
          typeof row.name !== 'string' || row.name.trim().length === 0 || row.name.length > 200 ||
          (row.description !== null && (typeof row.description !== 'string' || row.description.length > 2000)) ||
          typeof row.is_system !== 'boolean' || row.status !== 'ACTIVE') {
        throw new BadRequestException('IAM portable role definition is invalid');
      }
      return;
    }
    if (table === 'iam_user_roles') {
      if (typeof row.user_id !== 'string' || !UUID_PATTERN.test(row.user_id) ||
          typeof row.role_code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.role_code) ||
          (row.factory_code !== null && (typeof row.factory_code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.factory_code)))) {
        throw new BadRequestException('IAM portable user-role assignment is invalid');
      }
      return;
    }
    if (typeof row.role_code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.role_code) ||
        typeof row.permission_code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.permission_code)) {
      throw new BadRequestException('IAM portable permission grant is invalid');
    }
  }

  private async applyIamAccess(client: PoolClient, tenantId: string): Promise<void> {
    const staged = await client.query<{ table_name: string; row_payload: Record<string, unknown> }>(
      'SELECT table_name, row_payload FROM pg_temp.factoryos_transfer_stage WHERE category = $1 ORDER BY sequence ASC',
      [SaasTransferDatasetCategory.IAM_ACCESS],
    );
    const source: SaasTenantIamPortableSnapshot = { memberships: [], roles: [], userRoles: [], rolePermissions: [] };
    for (const { table_name, row_payload: row } of staged.rows) {
      switch (table_name) {
        case 'iam_memberships':
          source.memberships.push({ userId: row.user_id as string, status: row.status as SaasTenantMembershipStatus });
          break;
        case 'iam_roles':
          source.roles.push({
            code: row.code as string, name: row.name as string, description: row.description as string | null,
            isSystem: row.is_system as boolean, status: row.status as SaasIamTransferStatus,
          });
          break;
        case 'iam_user_roles':
          source.userRoles.push({ userId: row.user_id as string, roleCode: row.role_code as string, factoryCode: row.factory_code as string | null });
          break;
        case 'iam_role_permissions':
          source.rolePermissions.push({ roleCode: row.role_code as string, permissionCode: row.permission_code as string });
          break;
        default:
          throw new BadRequestException('Staged IAM record has an unrecognized logical relation');
      }
    }
    const memberIds = [...new Set(source.memberships.map((row) => row.userId))];
    const roleCodes = [...new Set(source.roles.map((row) => row.code))];
    const factoryCodes = [...new Set(source.userRoles.flatMap((row) => row.factoryCode ? [row.factoryCode] : []))];
    const permissionCodes = [...new Set(source.rolePermissions.map((row) => row.permissionCode))];
    const users = memberIds.length
      ? (await client.query<{ user_id: string; status: string }>('SELECT id::text AS user_id, status FROM public.users WHERE id = ANY($1::uuid[])', [memberIds])).rows : [];
    const memberships = memberIds.length
      ? (await client.query<{ id: string; user_id: string; status: string }>(
          'SELECT id::text AS id, user_id::text AS user_id, status FROM public.tenant_memberships WHERE tenant_id = $1::uuid AND user_id = ANY($2::uuid[])',
          [tenantId, memberIds],
        )).rows : [];
    const roles = roleCodes.length
      ? (await client.query<{ id: string; code: string; name: string; description: string | null; is_system: boolean; status: string }>(
          "SELECT id::text AS id, code, name, description, is_system, 'ACTIVE'::text AS status FROM public.roles WHERE tenant_id = $1::uuid AND code = ANY($2::text[])",
          [tenantId, roleCodes],
        )).rows : [];
    const factories = factoryCodes.length
      ? (await client.query<{ id: string; code: string; status: string }>(
          'SELECT id::text AS id, code, status FROM public.factories WHERE tenant_id = $1::uuid AND code = ANY($2::text[])',
          [tenantId, factoryCodes],
        )).rows : [];
    const permissions = permissionCodes.length
      ? (await client.query<{ id: string; code: string }>('SELECT id::text AS id, code FROM public.permissions WHERE code = ANY($1::text[])', [permissionCodes])).rows.map((row) => ({ ...row, status: 'ACTIVE' as const })) : [];

    await this.assertIamRelationshipsConsistent(client, tenantId);
    const userRoles = memberIds.length
      ? (await client.query<{ user_id: string; role_code: string; factory_code: string | null }>(
          'SELECT tm.user_id::text AS user_id, r.code AS role_code, f.code AS factory_code ' +
            'FROM public.user_roles ur INNER JOIN public.tenant_memberships tm ON tm.id = ur.membership_id AND tm.tenant_id = $1::uuid ' +
            'INNER JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = $1::uuid LEFT JOIN public.factories f ON f.id = ur.factory_id AND f.tenant_id = $1::uuid ' +
            'WHERE tm.user_id = ANY($2::uuid[]) ORDER BY tm.user_id ASC, r.code ASC, f.code ASC NULLS FIRST',
          [tenantId, memberIds],
        )).rows : [];
    const rolePermissions = roleCodes.length
      ? (await client.query<{ role_code: string; permission_code: string }>(
          'SELECT r.code AS role_code, p.code AS permission_code FROM public.role_permissions rp INNER JOIN public.roles r ON r.id = rp.role_id AND r.tenant_id = $1::uuid ' +
            'INNER JOIN public.permissions p ON p.id = rp.permission_id WHERE r.code = ANY($2::text[]) ORDER BY r.code ASC, p.code ASC',
          [tenantId, roleCodes],
        )).rows : [];
    const target: SaasTenantIamTargetDirectory = {
      users: users.map((row) => ({ userId: row.user_id, status: row.status as SaasIamTransferStatus })),
      memberships: memberships.map((row) => ({ id: row.id, userId: row.user_id, status: row.status as SaasTenantMembershipStatus })),
      roles: roles.map((row) => ({ id: row.id, code: row.code, name: row.name, description: row.description, isSystem: row.is_system, status: row.status as SaasIamTransferStatus })),
      factories: factories.map((row) => ({ id: row.id, code: row.code, status: row.status as SaasIamTransferStatus })),
      permissions,
      userRoles: userRoles.map((row) => ({ userId: row.user_id, roleCode: row.role_code, factoryCode: row.factory_code })),
      rolePermissions: rolePermissions.map((row) => ({ roleCode: row.role_code, permissionCode: row.permission_code })),
    };
    const plan = buildSaasTenantIamRemappingPlan(source, target);
    for (const membership of plan.membershipsToCreate) {
      const result = await client.query('INSERT INTO public.tenant_memberships (id, tenant_id, user_id, status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3)', [tenantId, membership.userId, membership.status]);
      if (result.rowCount !== 1) throw new ConflictException('Could not create a remapped tenant membership');
    }
    for (const role of plan.rolesToCreate) {
      const result = await client.query('INSERT INTO public.roles (id, tenant_id, code, name, description, is_system) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5)', [tenantId, role.code, role.name, role.description, role.isSystem]);
      if (result.rowCount !== 1) throw new ConflictException('Could not create a remapped tenant role');
    }
    for (const assignment of plan.userRolesToCreate) {
      const result = await client.query(
        'INSERT INTO public.user_roles (id, membership_id, role_id, factory_id) SELECT gen_random_uuid(), tm.id, r.id, f.id ' +
          'FROM public.tenant_memberships tm INNER JOIN public.roles r ON r.tenant_id = $1::uuid AND r.code = $3 ' +
          'LEFT JOIN public.factories f ON f.tenant_id = $1::uuid AND f.code = $4 ' +
          'WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid AND (($4::text IS NULL AND f.id IS NULL) OR f.id IS NOT NULL)',
        [tenantId, assignment.userId, assignment.roleCode, assignment.factoryCode],
      );
      if (result.rowCount !== 1) throw new ConflictException('Could not create a remapped user-role assignment');
    }
    for (const grant of plan.rolePermissionsToCreate) {
      const result = await client.query(
        'INSERT INTO public.role_permissions (role_id, permission_id) SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p WHERE r.tenant_id = $1::uuid AND r.code = $2 AND p.code = $3',
        [tenantId, grant.roleCode, grant.permissionCode],
      );
      if (result.rowCount !== 1) throw new ConflictException('Could not create a remapped role-permission grant');
    }
    const access = memberIds.length
      ? (await client.query<{ user_id: string; permission_code: string; factory_code: string | null }>(
          "SELECT DISTINCT tm.user_id::text AS user_id, p.code AS permission_code, f.code AS factory_code FROM public.user_roles ur " +
            "INNER JOIN public.tenant_memberships tm ON tm.id = ur.membership_id AND tm.tenant_id = $1::uuid AND tm.status = 'ACTIVE' " +
            'INNER JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = $1::uuid INNER JOIN public.role_permissions rp ON rp.role_id = r.id ' +
            'INNER JOIN public.permissions p ON p.id = rp.permission_id LEFT JOIN public.factories f ON f.id = ur.factory_id AND f.tenant_id = $1::uuid ' +
            'WHERE tm.user_id = ANY($2::uuid[]) AND (ur.factory_id IS NULL OR f.id IS NOT NULL) ORDER BY user_id ASC, permission_code ASC, factory_code ASC NULLS FIRST',
          [tenantId, memberIds],
        )).rows : [];
    assertSaasTenantIamEffectiveAccess(plan.expectedEffectiveAccess, access.map((row) => ({
      userId: row.user_id, permissionCode: row.permission_code, factoryCode: row.factory_code,
    })));
  }

  private async assertIamRelationshipsConsistent(client: PoolClient, tenantId: string): Promise<void> {
    const result = await client.query<{ invalid_assignment_count: string }>(
      'SELECT COUNT(*)::text AS invalid_assignment_count FROM public.user_roles ur ' +
        'LEFT JOIN public.tenant_memberships tm ON tm.id = ur.membership_id LEFT JOIN public.roles r ON r.id = ur.role_id ' +
        'LEFT JOIN public.factories f ON f.id = ur.factory_id WHERE (tm.tenant_id = $1::uuid OR r.tenant_id = $1::uuid OR f.tenant_id = $1::uuid) ' +
        'AND (tm.tenant_id IS DISTINCT FROM $1::uuid OR r.tenant_id IS DISTINCT FROM $1::uuid OR (ur.factory_id IS NOT NULL AND f.tenant_id IS DISTINCT FROM $1::uuid))',
      [tenantId],
    );
    const invalidCount = result.rows[0]?.invalid_assignment_count;
    if (result.rowCount !== 1 || !invalidCount || !/^\d+$/.test(invalidCount)) {
      throw new ServiceUnavailableException('Unable to verify tenant IAM relationship integrity');
    }
    if (BigInt(invalidCount) > 0n) throw new ConflictException('Target IAM contains a cross-tenant or unresolved assignment');
  }

  private async measureTargetManifest(
    client: PoolClient,
    tenantId: string,
    categoryTables: Array<{ category: SaasTransferDatasetCategory; tables: readonly string[] }>,
  ): Promise<SaasTenantTransferExportManifest> {
    const manifest: SaasTenantTransferExportManifest = {};
    for (const entry of categoryTables) {
      if (entry.category === SaasTransferDatasetCategory.IAM_ACCESS) {
        manifest[entry.category] = await this.measureIamAccessManifest(client, tenantId);
        continue;
      }
      const hash = createHash('sha256');
      let count = 0;
      for (const table of entry.tables) {
        let afterId: string | null = null;
        while (true) {
          const result: QueryResult<QueryResultRow> = await client.query(
            'SELECT * FROM public.' + this.quoteIdentifier(table) +
              ' WHERE tenant_id = $1::uuid AND ($2::uuid IS NULL OR id > $2::uuid)' +
              ' ORDER BY id ASC LIMIT $3',
            [tenantId, afterId, PAGE_SIZE],
          );
          for (const row of result.rows as Array<Record<string, unknown>>) {
            const canonical = this.canonicalJson({ ...row, __factoryos_table: table });
            hash.update(canonical, 'utf8');
            hash.update('\n', 'utf8');
            afterId = String(row.id);
            count += 1;
          }
          if (result.rows.length < PAGE_SIZE) break;
        }
      }
      manifest[entry.category] = { record_count: count, sha256: hash.digest('hex') };
    }
    return manifest;
  }

  private async measureIamAccessManifest(client: PoolClient, tenantId: string): Promise<{ record_count: number; sha256: string }> {
    await this.assertIamRelationshipsConsistent(client, tenantId);
    const hash = createHash('sha256');
    let count = 0;
    const addRows = (table: string, rows: Array<Record<string, unknown>>) => {
      for (const row of rows) {
        hash.update(this.canonicalJson({ ...row, __factoryos_table: table }), 'utf8');
        hash.update('\n', 'utf8');
        count += 1;
      }
    };
    const memberships = await client.query<{ tenant_id: string; user_id: string; status: string }>(
      'SELECT tenant_id::text AS tenant_id, user_id::text AS user_id, status FROM public.tenant_memberships WHERE tenant_id = $1::uuid ORDER BY user_id ASC', [tenantId],
    );
    addRows('iam_memberships', memberships.rows as Array<Record<string, unknown>>);
    const roles = await client.query<{ tenant_id: string; code: string; name: string; description: string | null; is_system: boolean; status: string }>(
      "SELECT tenant_id::text AS tenant_id, code, name, description, is_system, 'ACTIVE'::text AS status FROM public.roles WHERE tenant_id = $1::uuid ORDER BY code ASC", [tenantId],
    );
    addRows('iam_roles', roles.rows as Array<Record<string, unknown>>);
    const assignments = await client.query<{ tenant_id: string; user_id: string; role_code: string; factory_code: string | null }>(
      'SELECT tm.tenant_id::text AS tenant_id, tm.user_id::text AS user_id, r.code AS role_code, f.code AS factory_code ' +
        'FROM public.user_roles ur INNER JOIN public.tenant_memberships tm ON tm.id = ur.membership_id AND tm.tenant_id = $1::uuid ' +
        'INNER JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = $1::uuid LEFT JOIN public.factories f ON f.id = ur.factory_id AND f.tenant_id = $1::uuid ' +
        'WHERE (ur.factory_id IS NULL OR f.id IS NOT NULL) ORDER BY tm.user_id ASC, r.code ASC, f.code ASC NULLS FIRST', [tenantId],
    );
    addRows('iam_user_roles', assignments.rows as Array<Record<string, unknown>>);
    const grants = await client.query<{ tenant_id: string; role_code: string; permission_code: string }>(
      'SELECT r.tenant_id::text AS tenant_id, r.code AS role_code, p.code AS permission_code FROM public.role_permissions rp ' +
        'INNER JOIN public.roles r ON r.id = rp.role_id AND r.tenant_id = $1::uuid INNER JOIN public.permissions p ON p.id = rp.permission_id ORDER BY r.code ASC, p.code ASC', [tenantId],
    );
    addRows('iam_role_permissions', grants.rows as Array<Record<string, unknown>>);
    if (!Number.isSafeInteger(count)) throw new ConflictException('IAM record count exceeds the supported limit');
    return { record_count: count, sha256: hash.digest('hex') };
  }

  private assertManifestMatchesInput(
    actual: SaasTenantTransferExportManifest,
    expected: SaasTenantTransferExportManifest,
    requiredCategories: SaasTransferDatasetCategory[],
  ): void {
    if (this.canonicalJson(Object.keys(actual).sort()) !== this.canonicalJson(Object.keys(expected).sort())) {
      throw new ConflictException('Source bundle categories do not match the attested manifest');
    }
    for (const category of requiredCategories) {
      if (!actual[category]) throw new ConflictException('Source manifest is missing required category ' + category);
    }
    for (const category of Object.keys(expected)) {
      const source = expected[category as SaasTransferDatasetCategory];
      const measured = actual[category as SaasTransferDatasetCategory];
      if (!measured || source.record_count !== measured.record_count || source.sha256 !== measured.sha256) {
        throw new ConflictException('Target preservation verification failed for dataset category ' + category);
      }
    }
  }

  private async *readBundleEvents(chunks: AsyncIterable<Buffer>): AsyncIterable<BundleEvent> {
    const reader = new TenantExportTextReader(chunks);
    const headerText = await reader.readUntil(HEADER_MARKER, MAX_HEADER_BYTES);
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(headerText + '}') as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Source bundle header is malformed');
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      throw new BadRequestException('Source bundle header must be an object');
    }
    yield { kind: 'header', value: header };

    while (true) {
      const key = await reader.readJsonString(128);
      if (!Object.values(SaasTransferDatasetCategory).includes(key as SaasTransferDatasetCategory)) {
        throw new BadRequestException('Source bundle contains an invalid dataset category');
      }
      const category = key as SaasTransferDatasetCategory;
      await reader.expect(':');
      await reader.expect('[');
      yield { kind: 'category', value: category };

      while (true) {
        const next = await reader.peekNonWhitespace();
        if (next === ']') {
          await reader.expect(']');
          break;
        }
        const rowText = await reader.readJsonObject(MAX_ROW_BYTES);
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(rowText) as Record<string, unknown>;
        } catch {
          throw new BadRequestException('Source dataset row contains invalid JSON');
        }
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new BadRequestException('Source dataset rows must be JSON objects');
        }
        const table = row.__factoryos_table;
        if (typeof table !== 'string') {
          throw new BadRequestException('Source dataset row is missing its source-table discriminator');
        }
        yield { kind: 'row', category, table, value: row };
        const separator = await reader.peekNonWhitespace();
        if (separator === ',') {
          await reader.expect(',');
        } else if (separator === ']') {
          await reader.expect(']');
          break;
        } else {
          throw new BadRequestException('Source dataset array is malformed');
        }
      }

      const separator = await reader.peekNonWhitespace();
      if (separator === ',') {
        await reader.expect(',');
        continue;
      }
      if (separator === '}') {
        await reader.expect('}');
        break;
      }
      throw new BadRequestException('Source bundle datasets object is malformed');
    }

    await reader.expect(',');
    const manifestKey = await reader.readJsonString(32);
    if (manifestKey !== 'manifest') throw new BadRequestException('Source bundle manifest is missing');
    await reader.expect(':');
    const manifestText = await reader.readJsonObject(MAX_MANIFEST_BYTES);
    let manifest: SaasTenantTransferExportManifest;
    try {
      manifest = JSON.parse(manifestText) as SaasTenantTransferExportManifest;
    } catch {
      throw new BadRequestException('Source bundle manifest is malformed');
    }
    await reader.expect('}');
    await reader.assertEnd();
    yield { kind: 'manifest', value: manifest };
  }

  private canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value) as string;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new BadRequestException('Target rows contain non-finite numbers');
      return JSON.stringify(value);
    }
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new BadRequestException('Target rows contain invalid dates');
      return JSON.stringify(value.toISOString());
    }
    if (typeof value !== 'object' || value === undefined) {
      throw new BadRequestException('Target rows must be JSON-compatible');
    }
    if (ancestors.has(value)) throw new BadRequestException('Target rows contain circular references');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return '[' + value.map((item) => this.canonicalJson(item, ancestors)).join(',') + ']';
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new BadRequestException('Target rows must be plain JSON objects');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      for (const key of keys) this.assertSafeField(key);
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + this.canonicalJson(record[key], ancestors)).join(',') + '}';
    } finally {
      ancestors.delete(value);
    }
  }

  private assertSafeField(field: string): void {
    assertSaasTenantTransferFieldSafe(field, 'target');
  }

  private quoteIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"';
  }
}

export class TenantExportTextReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer = '';
  private offset = 0;
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readUntil(marker: string, maxBytes: number): Promise<string> {
    let collected = '';
    while (true) {
      const available = this.buffer.slice(this.offset);
      const index = available.indexOf(marker);
      if (index >= 0) {
        collected += available.slice(0, index);
        this.offset += index + marker.length;
        if (Buffer.byteLength(collected, 'utf8') > maxBytes) throw new BadRequestException('Source bundle header is too large');
        return collected;
      }
      if (this.ended) throw new BadRequestException('Source bundle dataset section is missing');
      const safeLength = Math.max(0, available.length - (marker.length - 1));
      collected += available.slice(0, safeLength);
      this.offset += safeLength;
      if (Buffer.byteLength(collected, 'utf8') > maxBytes) throw new BadRequestException('Source bundle header is too large');
      await this.fill();
    }
  }

  async readJsonString(maxBytes: number): Promise<string> {
    await this.skipWhitespace();
    if (await this.peekRaw() !== '"') throw new BadRequestException('Expected a JSON string in source bundle');
    let raw = '"';
    await this.consumeRaw();
    let escaped = false;
    while (true) {
      if (!(await this.ensure())) throw new BadRequestException('Source bundle contains an unterminated string');
      const start = this.offset;
      while (this.offset < this.buffer.length) {
        const char = this.buffer[this.offset++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          raw += this.buffer.slice(start, this.offset);
          if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new BadRequestException('A source bundle string token is too large');
          try {
            const decoded = JSON.parse(raw) as unknown;
            if (typeof decoded !== 'string') throw new Error('not a string');
            return decoded;
          } catch {
            throw new BadRequestException('Source bundle contains an invalid JSON string');
          }
        }
      }
      raw += this.buffer.slice(start, this.offset);
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new BadRequestException('A source bundle string token is too large');
    }
  }

  async readJsonObject(maxBytes: number): Promise<string> {
    await this.skipWhitespace();
    if (await this.peekRaw() !== '{') throw new BadRequestException('Expected a JSON object in source bundle');
    let raw = '';
    let objectDepth = 0;
    let arrayDepth = 0;
    let inString = false;
    let escaped = false;
    while (true) {
      if (!(await this.ensure())) throw new BadRequestException('Source bundle contains an unterminated JSON object');
      const start = this.offset;
      while (this.offset < this.buffer.length) {
        const char = this.buffer[this.offset++];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{') objectDepth += 1;
        else if (char === '}') {
          objectDepth -= 1;
          if (objectDepth === 0 && arrayDepth === 0) {
            raw += this.buffer.slice(start, this.offset);
            if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new BadRequestException('A source bundle JSON object is too large');
            return raw;
          }
        } else if (char === '[') arrayDepth += 1;
        else if (char === ']') {
          arrayDepth -= 1;
          if (arrayDepth < 0) throw new BadRequestException('Source bundle JSON arrays are malformed');
        }
        if (objectDepth < 0) throw new BadRequestException('Source bundle JSON objects are malformed');
      }
      raw += this.buffer.slice(start, this.offset);
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new BadRequestException('A source bundle JSON object is too large');
    }
  }

  async expect(expected: string): Promise<void> {
    await this.skipWhitespace();
    const actual = await this.peekRaw();
    if (actual !== expected) throw new BadRequestException('Source bundle format is invalid (expected ' + expected + ')');
    await this.consumeRaw();
  }

  async peekNonWhitespace(): Promise<string | null> {
    await this.skipWhitespace();
    return this.peekRaw();
  }

  async assertEnd(): Promise<void> {
    await this.skipWhitespace();
    if (await this.peekRaw() !== null) throw new BadRequestException('Source bundle contains trailing data');
  }

  private async skipWhitespace(): Promise<void> {
    while (true) {
      if (!(await this.ensure())) return;
      while (this.offset < this.buffer.length && /\s/.test(this.buffer[this.offset])) this.offset += 1;
      if (this.offset < this.buffer.length) return;
    }
  }

  private async peekRaw(): Promise<string | null> {
    if (!(await this.ensure())) return null;
    return this.buffer[this.offset];
  }

  private async consumeRaw(): Promise<string | null> {
    if (!(await this.ensure())) return null;
    return this.buffer[this.offset++];
  }

  private async ensure(): Promise<boolean> {
    while (this.offset >= this.buffer.length && !this.ended) await this.fill();
    return this.offset < this.buffer.length;
  }

  private async fill(): Promise<void> {
    if (this.offset > 0) {
      this.buffer = this.buffer.slice(this.offset);
      this.offset = 0;
    }
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return;
    }
    this.buffer += Buffer.from(next.value).toString('utf8');
  }
}
