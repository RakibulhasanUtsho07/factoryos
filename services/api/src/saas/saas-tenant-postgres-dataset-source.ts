import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { QueryResult, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SaasTransferDatasetCategory } from './dto/create-saas-schema-compatibility-rule.dto';

/**
 * The source is deliberately an allowlist, not a generic table dumper.
 *
 * Each relation is known to be tenant-owned and expose UUID id + tenant_id
 * columns. New tables must be reviewed and assigned to a category explicitly.
 * Auth identities, credential stores, queue internals, and transfer control-plane
 * rows are intentionally not exported.
 */
export const SAAS_TENANT_DATASET_TABLES: Partial<
  Record<SaasTransferDatasetCategory, readonly string[]>
> = Object.freeze({
  [SaasTransferDatasetCategory.BUSINESS_DATA]: Object.freeze([
    'legal_entities',
    'factories',
    'orders',
    'order_lines',
    'order_event_projections',
    'inventory_items',
    'inventory_stock_balances',
    'inventory_movements',
    'business_blueprints',
    'business_blueprint_versions',
    'business_entities',
    'business_relations',
    'business_processes',
    'business_process_steps',
    'business_rules',
    'business_terms',
    'business_exceptions',
    'business_change_proposals',
    'business_conflicts',
    'business_feedback',
    'growth_opportunities',
    'growth_scenarios',
    'growth_experiments',
    // SaaS commercial/usage history required for a tenant-preserving migration.
    'saas_usage_events',
    'saas_usage_adjustments',
    'saas_usage_reconciliations',
    'saas_budget_evaluations',
    'saas_workload_control_events',
    'saas_budget_alerts',
    'saas_budget_alert_acknowledgements',
    'saas_provider_cost_events',
    'saas_provider_cost_reconciliations',
  ]),
  [SaasTransferDatasetCategory.AUDIT_LOG]: Object.freeze([
    'audit_events',
  ]),
  [SaasTransferDatasetCategory.EVIDENCE]: Object.freeze([
    'business_evidence',
    'business_evidence_links',
    'growth_opportunity_evidence',
  ]),
  [SaasTransferDatasetCategory.APPROVALS]: Object.freeze([
    'approvals',
  ]),
  [SaasTransferDatasetCategory.EFFECTIVE_DATED_MASTER_DATA]: Object.freeze([
    'risk_classes',
    'policies',
    'saas_usage_rate_cards',
    'saas_usage_budgets',
  ]),
  [SaasTransferDatasetCategory.AI_CONTEXT]: Object.freeze([
    'ai_decision_envelopes',
    'ai_context_packages',
    'ai_verification_runs',
    'research_sources',
    'research_claims',
    'research_claim_links',
    'research_knowledge_releases',
    'research_relevance_mappings',
  ]),
  [SaasTransferDatasetCategory.LEARNING_EVALUATION]: Object.freeze([
    'research_release_evaluations',
    'growth_experiment_results',
    'growth_opportunity_outcomes',
  ]),
});

const PAGE_SIZE = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION_PATTERN = /^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/;

interface TenantDatasetRow extends QueryResultRow {
  id: string;
  tenant_id: string;
}

/**
 * Read a tenant export from one live PostgreSQL snapshot.
 *
 * A single callback owns a single read-only REPEATABLE READ transaction for
 * all requested categories. Tenant RLS context is installed on that same
 * connection; explicit tenant predicates and UUID keyset pagination remain
 * defense-in-depth. The session is invalidated before its connection is
 * returned to the pool.
 */
@Injectable()
export class SaasTenantPostgresDatasetSource {
  constructor(private readonly database: DatabaseService) {}

  async assertIamMigrationReady(tenantId: string): Promise<void> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new BadRequestException('Tenant IAM scope must be a UUID');
    }

    const client = await this.database.getClient();
    let transactionOpen = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionOpen = true;
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [tenantId, ''],
      );

      const result = await client.query<{
        membership_count: string;
        role_count: string;
        user_role_count: string;
        role_permission_count: string;
      }>(
        'SELECT ' +
          '(SELECT COUNT(*)::text FROM public.tenant_memberships WHERE tenant_id = $1::uuid) AS membership_count, ' +
          '(SELECT COUNT(*)::text FROM public.roles WHERE tenant_id = $1::uuid) AS role_count, ' +
          '(SELECT COUNT(*)::text FROM public.user_roles ur ' +
            'INNER JOIN public.tenant_memberships tm ON tm.id = ur.membership_id ' +
            'WHERE tm.tenant_id = $1::uuid) AS user_role_count, ' +
          '(SELECT COUNT(*)::text FROM public.role_permissions rp ' +
            'INNER JOIN public.roles r ON r.id = rp.role_id ' +
            'WHERE r.tenant_id = $1::uuid) AS role_permission_count',
        [tenantId],
      );

      const counts = result.rows[0];
      if (
        result.rowCount !== 1 ||
        !counts ||
        [counts.membership_count, counts.role_count, counts.user_role_count, counts.role_permission_count]
          .some((value) => !/^\d+$/.test(value))
      ) {
        throw new ServiceUnavailableException(
          'Unable to verify tenant IAM portability; migration was blocked',
        );
      }

      await client.query('COMMIT');
      transactionOpen = false;
    } finally {
      if (transactionOpen) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      client.release();
    }
  }

  async withSnapshot<T>(
    tenantId: string,
    schemaVersion: string,
    callback: (snapshot: import('./saas-tenant-data-transfer.adapters').SaasTenantTransferDatasetSnapshot) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new BadRequestException('Tenant dataset scope must be a UUID');
    }
    if (!SCHEMA_VERSION_PATTERN.test(schemaVersion)) {
      throw new BadRequestException('Dataset source schema version is invalid');
    }

    const client = await this.database.getClient();
    let transactionOpen = false;
    let active = true;
    let abandonedReader = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionOpen = true;
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [tenantId, ''],
      );

      const snapshot = {
        readDataset: (category: SaasTransferDatasetCategory): AsyncIterable<unknown> => {
          return (async function* (source: SaasTenantPostgresDatasetSource) {
            let completed = false;
            try {
              if (!active) {
                throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
              }
              yield* source.readDatasetOnClient(client, tenantId, category, () => active);
              completed = true;
            } finally {
              if (!completed) abandonedReader = true;
            }
          })(this);
        },
      };

      const result = await callback(snapshot);
      if (abandonedReader) {
        throw new ServiceUnavailableException(
          'Tenant export snapshot was abandoned before a dataset category was fully read',
        );
      }

      active = false;
      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } finally {
      active = false;
      if (transactionOpen) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      client.release();
    }
  }

  private async *readIamDatasetOnClient(
    client: Awaited<ReturnType<DatabaseService['getClient']>>,
    tenantId: string,
    isActive: () => boolean,
  ): AsyncIterable<unknown> {
    const integrity = await client.query<{ invalid_assignment_count: string }>(
      'SELECT COUNT(*)::text AS invalid_assignment_count FROM public.user_roles ur ' +
        'LEFT JOIN public.tenant_memberships tm ON tm.id = ur.membership_id ' +
        'LEFT JOIN public.roles r ON r.id = ur.role_id LEFT JOIN public.factories f ON f.id = ur.factory_id ' +
        'WHERE (tm.tenant_id = $1::uuid OR r.tenant_id = $1::uuid OR f.tenant_id = $1::uuid) ' +
        'AND (tm.tenant_id IS DISTINCT FROM $1::uuid OR r.tenant_id IS DISTINCT FROM $1::uuid ' +
        'OR (ur.factory_id IS NOT NULL AND f.tenant_id IS DISTINCT FROM $1::uuid))',
      [tenantId],
    );
    const invalidCount = integrity.rows[0]?.invalid_assignment_count;
    if (integrity.rowCount !== 1 || !invalidCount || !/^\d+$/.test(invalidCount)) {
      throw new ServiceUnavailableException('Unable to verify tenant IAM relationship integrity');
    }
    if (BigInt(invalidCount) > 0n) throw new ServiceUnavailableException('Tenant IAM contains a cross-tenant or unresolved assignment');

    if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
    const memberships = await client.query<{ user_id: string; status: string }>(
      'SELECT user_id::text AS user_id, status FROM public.tenant_memberships WHERE tenant_id = $1::uuid ORDER BY user_id ASC',
      [tenantId],
    );
    for (const row of memberships.rows) {
      if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
      if (!['ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED'].includes(row.status)) throw new ServiceUnavailableException('Tenant membership has an unsupported lifecycle status');
      yield { tenant_id: tenantId, user_id: row.user_id, status: row.status, __factoryos_table: 'iam_memberships' };
    }

    if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
    const roles = await client.query<{ code: string; name: string; description: string | null; is_system: boolean }>(
      'SELECT code, name, description, is_system FROM public.roles WHERE tenant_id = $1::uuid ORDER BY code ASC',
      [tenantId],
    );
    for (const row of roles.rows) {
      if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
      yield { tenant_id: tenantId, code: row.code, name: row.name, description: row.description, is_system: row.is_system, status: 'ACTIVE', __factoryos_table: 'iam_roles' };
    }

    if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
    const assignments = await client.query<{ user_id: string; role_code: string; factory_code: string | null }>(
      'SELECT tm.user_id::text AS user_id, r.code AS role_code, f.code AS factory_code ' +
        'FROM public.user_roles ur INNER JOIN public.tenant_memberships tm ON tm.id = ur.membership_id ' +
        'INNER JOIN public.roles r ON r.id = ur.role_id AND r.tenant_id = $1::uuid ' +
        'LEFT JOIN public.factories f ON f.id = ur.factory_id AND f.tenant_id = $1::uuid ' +
        'WHERE tm.tenant_id = $1::uuid AND (ur.factory_id IS NULL OR f.id IS NOT NULL) ' +
        'ORDER BY tm.user_id ASC, r.code ASC, f.code ASC NULLS FIRST',
      [tenantId],
    );
    for (const row of assignments.rows) {
      if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
      yield { tenant_id: tenantId, user_id: row.user_id, role_code: row.role_code, factory_code: row.factory_code, __factoryos_table: 'iam_user_roles' };
    }

    if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
    const grants = await client.query<{ role_code: string; permission_code: string }>(
      'SELECT r.code AS role_code, p.code AS permission_code FROM public.role_permissions rp ' +
        'INNER JOIN public.roles r ON r.id = rp.role_id AND r.tenant_id = $1::uuid ' +
        'INNER JOIN public.permissions p ON p.id = rp.permission_id ORDER BY r.code ASC, p.code ASC',
      [tenantId],
    );
    for (const row of grants.rows) {
      if (!isActive()) throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
      yield { tenant_id: tenantId, role_code: row.role_code, permission_code: row.permission_code, __factoryos_table: 'iam_role_permissions' };
    }
  }


  /**
   * Compare the complete exportable table shape with its reviewed, append-only
   * migration snapshot before any row can be emitted. A new column is not
   * implicitly exportable merely because the table is already allowlisted.
   */
  private async assertExportColumnContracts(
    client: Awaited<ReturnType<DatabaseService['getClient']>>,
    category: SaasTransferDatasetCategory,
    tables: readonly string[],
  ): Promise<void> {
    const result = await client.query<{
      table_name: string;
      contract_version: number | null;
      matches: boolean | null;
    }>(
      `WITH requested AS (
        SELECT unnest($1::text[]) AS relation_name
      ),
      latest_contracts AS (
        SELECT DISTINCT ON (contract.schema_name, contract.relation_name)
          contract.schema_name,
          contract.relation_name,
          contract.contract_version,
          contract.data_category,
          contract.column_manifest
        FROM factoryos_governance.tenant_export_column_contracts contract
        INNER JOIN requested ON requested.relation_name = contract.relation_name
        WHERE contract.schema_name = 'public'
        ORDER BY contract.schema_name, contract.relation_name, contract.contract_version DESC
      ),
      live_columns AS (
        SELECT
          relation.relname AS relation_name,
          jsonb_agg(
            jsonb_build_object(
              'ordinal', column_meta.attnum,
              'name', column_meta.attname,
              'type', format_type(column_meta.atttypid, column_meta.atttypmod),
              'notNull', column_meta.attnotnull,
              'identity', column_meta.attidentity,
              'generated', column_meta.attgenerated,
              'default', pg_get_expr(default_value.adbin, default_value.adrelid),
              'collation', CASE
                WHEN column_meta.attcollation = 0 THEN NULL
                ELSE collation_schema.nspname || '.' || collation.collname
              END
            )
            ORDER BY column_meta.attnum
          ) AS columns
        FROM pg_catalog.pg_class relation
        INNER JOIN pg_catalog.pg_namespace relation_schema
          ON relation_schema.oid = relation.relnamespace
        INNER JOIN requested
          ON requested.relation_name = relation.relname
        INNER JOIN pg_catalog.pg_attribute column_meta
          ON column_meta.attrelid = relation.oid
          AND column_meta.attnum > 0
          AND NOT column_meta.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef default_value
          ON default_value.adrelid = relation.oid
          AND default_value.adnum = column_meta.attnum
        LEFT JOIN pg_catalog.pg_collation collation
          ON collation.oid = column_meta.attcollation
          AND column_meta.attcollation <> 0
        LEFT JOIN pg_catalog.pg_namespace collation_schema
          ON collation_schema.oid = collation.collnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
        GROUP BY relation.relname
      ),
      live_manifests AS (
        SELECT
          requested.relation_name,
          inventory.data_category,
          CASE
            WHEN live_columns.columns IS NULL THEN NULL
            ELSE jsonb_build_object(
              'category', inventory.data_category,
              'columns', live_columns.columns
            )
          END AS column_manifest
        FROM requested
        LEFT JOIN factoryos_governance.tenant_relation_inventory inventory
          ON inventory.schema_name = 'public'
          AND inventory.relation_name = requested.relation_name
          AND inventory.scope_model = 'DIRECT_TENANT_ID'
          AND inventory.export_disposition = 'ALLOWLISTED'
        LEFT JOIN live_columns
          ON live_columns.relation_name = requested.relation_name
      )
      SELECT
        requested.relation_name AS table_name,
        latest_contracts.contract_version,
        (
          latest_contracts.relation_name IS NOT NULL
          AND live_manifests.column_manifest IS NOT NULL
          AND latest_contracts.data_category = $2
          AND live_manifests.data_category = $2
          AND latest_contracts.column_manifest = live_manifests.column_manifest
        ) AS matches
      FROM requested
      LEFT JOIN latest_contracts
        ON latest_contracts.relation_name = requested.relation_name
      LEFT JOIN live_manifests
        ON live_manifests.relation_name = requested.relation_name
      ORDER BY requested.relation_name`,
      [[...tables], category],
    );

    if (
      result.rows.length !== tables.length ||
      result.rows.some((row) =>
        row.matches !== true ||
        !Number.isInteger(Number(row.contract_version)) ||
        Number(row.contract_version) < 1
      )
    ) {
      throw new ServiceUnavailableException(
        'Tenant export column contract is missing or stale for this dataset; export is blocked until schema changes are reviewed',
      );
    }
  }

  private async *readDatasetOnClient(
    client: Awaited<ReturnType<DatabaseService['getClient']>>,
    tenantId: string,
    category: SaasTransferDatasetCategory,
    isActive: () => boolean,
  ): AsyncIterable<unknown> {
    if (!isActive()) {
      throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
    }
    if (category === SaasTransferDatasetCategory.IAM_ACCESS) {
      yield* this.readIamDatasetOnClient(client, tenantId, isActive);
      return;
    }

    const tables = SAAS_TENANT_DATASET_TABLES[category];
    if (!tables || tables.length === 0) {
      throw new ServiceUnavailableException(
        'Tenant transfer category ' + category + ' has no reviewed PostgreSQL source adapter',
      );
    }

    // Validate every table in the category before yielding the first row.
    await this.assertExportColumnContracts(client, category, tables);

    for (const table of tables) {
      let afterId: string | null = null;
      while (true) {
        if (!isActive()) {
          throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
        }
        // Table identifiers can only originate from the reviewed constant allowlist.
        const result: QueryResult<TenantDatasetRow> = await client.query<TenantDatasetRow>(
          'SELECT dataset_row.* FROM public.' +
            table +
            ' AS dataset_row ' +
            'WHERE dataset_row.tenant_id = $1::uuid ' +
            'AND ($2::uuid IS NULL OR dataset_row.id > $2::uuid) ' +
            'ORDER BY dataset_row.id ASC LIMIT $3',
          [tenantId, afterId, PAGE_SIZE],
        );

        for (const row of result.rows) {
          if (!isActive()) {
            throw new ServiceUnavailableException('Tenant dataset snapshot is no longer active');
          }
          if (
            typeof row.id !== 'string' ||
            !UUID_PATTERN.test(row.id) ||
            row.tenant_id !== tenantId
          ) {
            throw new BadRequestException(
              'Tenant dataset source returned a row outside the requested tenant scope',
            );
          }

          afterId = row.id;
          yield { ...row, __factoryos_table: table };
        }

        if (result.rows.length < PAGE_SIZE) break;
      }
    }
  }
}
