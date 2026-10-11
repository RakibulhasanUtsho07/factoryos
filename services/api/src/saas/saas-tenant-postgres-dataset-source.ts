import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { QueryResultRow } from 'pg';
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
    'business_acl',
    'growth_opportunities',
    'growth_scenarios',
    'growth_experiments',
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
    'ai_outcome_links',
    'ai_learning_signals',
    'ai_agent_evaluation_cases',
    'ai_agent_evaluation_results',
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
 * Read a tenant dataset from the live FactoryOS schema.
 *
 * Every category runs in a repeatable-read, read-only transaction with RLS
 * context installed on the same PostgreSQL connection. Explicit tenant
 * predicates complement RLS, and UUID keyset pagination avoids offset scans.
 */
@Injectable()
export class SaasTenantPostgresDatasetSource {
  constructor(private readonly database: DatabaseService) {}

  async *readDataset(
    tenantId: string,
    schemaVersion: string,
    category: SaasTransferDatasetCategory,
  ): AsyncIterable<unknown> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new BadRequestException('Tenant dataset scope must be a UUID');
    }
    if (!SCHEMA_VERSION_PATTERN.test(schemaVersion)) {
      throw new BadRequestException('Dataset source schema version is invalid');
    }

    const tables = SAAS_TENANT_DATASET_TABLES[category];
    if (!tables || tables.length === 0) {
      throw new ServiceUnavailableException(
        'Tenant transfer category ' + category + ' has no reviewed PostgreSQL source adapter',
      );
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

      for (const table of tables) {
        let afterId: string | null = null;
        while (true) {
          // Table identifiers can only originate from the reviewed constant allowlist.
          const result = await client.query<TenantDatasetRow>(
            'SELECT dataset_row.* FROM public.' +
              table +
              ' AS dataset_row ' +
              'WHERE dataset_row.tenant_id = $1::uuid ' +
              'AND ($2::uuid IS NULL OR dataset_row.id > $2::uuid) ' +
              'ORDER BY dataset_row.id ASC LIMIT $3',
            [tenantId, afterId, PAGE_SIZE],
          );

          for (const row of result.rows) {
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

      await client.query('COMMIT');
      transactionOpen = false;
    } finally {
      if (transactionOpen) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      client.release();
    }
  }
}
