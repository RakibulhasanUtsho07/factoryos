import { ServiceUnavailableException } from '@nestjs/common';

export interface SaasTenantImportForeignKey {
  child_table: string;
  parent_table: string;
  constraint_name: string;
  is_deferrable: boolean;
  child_columns: string[];
  parent_columns: string[];
}

/**
 * Parent-before-child ordering for one tenant import.
 *
 * The graph includes non-deferrable FKs whose endpoints are both in this import.
 * Three migration-defined exceptions have dedicated two-phase or ordered-row
 * handling in the importer: the blueprint current-version pointer, the research
 * release evaluation pointer, and the business-evidence predecessor chain.
 * Every other non-deferrable cycle remains a hard error.
 */
export function resolveSaasTenantImportOrder(
  tables: readonly string[],
  foreignKeys: readonly SaasTenantImportForeignKey[],
): string[] {
  const tableOrder = new Map<string, number>();
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table) || tableOrder.has(table)) {
      throw new ServiceUnavailableException('Tenant import table inventory is malformed or contains duplicates');
    }
    tableOrder.set(table, tableOrder.size);
  }

  const inDegree = new Map(tables.map((table) => [table, 0]));
  const children = new Map(tables.map((table) => [table, new Set<string>()]));

  for (const foreignKey of foreignKeys) {
    if (
      typeof foreignKey.child_table !== 'string' ||
      typeof foreignKey.parent_table !== 'string' ||
      typeof foreignKey.constraint_name !== 'string' ||
      typeof foreignKey.is_deferrable !== 'boolean' ||
      !Array.isArray(foreignKey.child_columns) ||
      foreignKey.child_columns.length === 0 ||
      foreignKey.child_columns.some((column) => typeof column !== 'string' || column.length === 0) ||
      new Set(foreignKey.child_columns).size !== foreignKey.child_columns.length ||
      !Array.isArray(foreignKey.parent_columns) ||
      foreignKey.parent_columns.length !== foreignKey.child_columns.length ||
      foreignKey.parent_columns.some((column) => typeof column !== 'string' || column.length === 0) ||
      new Set(foreignKey.parent_columns).size !== foreignKey.parent_columns.length
    ) {
      throw new ServiceUnavailableException('Destination PostgreSQL returned incomplete foreign-key metadata');
    }
    if (!tableOrder.has(foreignKey.child_table) || !tableOrder.has(foreignKey.parent_table)) {
      throw new ServiceUnavailableException('Destination PostgreSQL returned an FK outside the reviewed import table set');
    }
    if (foreignKey.is_deferrable) continue;

    // A cycle exception is valid only for the exact ordered FK mapping from the
    // reviewed migration. A matching name and one matching column are not enough:
    // widened, reordered or redirected composite FKs must remain graph edges.
    const exactColumns = (actual: readonly string[], expected: readonly string[]) =>
      actual.length === expected.length && actual.every((column, index) => column === expected[index]);
    const reviewedBlueprintPointer =
      foreignKey.constraint_name === 'fk_business_blueprints_current_version' &&
      foreignKey.child_table === 'business_blueprints' &&
      foreignKey.parent_table === 'business_blueprint_versions' &&
      exactColumns(foreignKey.child_columns, ['current_version_id', 'tenant_id', 'factory_id']) &&
      exactColumns(foreignKey.parent_columns, ['id', 'tenant_id', 'factory_id']);
    const reviewedResearchEvaluationPointer =
      foreignKey.constraint_name === 'fk_research_release_evaluation_owner' &&
      foreignKey.child_table === 'research_knowledge_releases' &&
      foreignKey.parent_table === 'research_release_evaluations' &&
      exactColumns(foreignKey.child_columns, ['evaluation_id', 'id']) &&
      exactColumns(foreignKey.parent_columns, ['id', 'release_id']);
    const reviewedEvidencePredecessor =
      foreignKey.constraint_name === 'fk_business_evidence_supersedes_scope' &&
      foreignKey.child_table === 'business_evidence' &&
      foreignKey.parent_table === 'business_evidence' &&
      exactColumns(foreignKey.child_columns, ['supersedes_evidence_id', 'tenant_id', 'factory_id']) &&
      exactColumns(foreignKey.parent_columns, ['id', 'tenant_id', 'factory_id']);

    // These exact edges have importer-side preservation logic; do not make
    // unrelated cycles disappear merely because their table names are similar.
    if (reviewedBlueprintPointer || reviewedResearchEvaluationPointer || reviewedEvidencePredecessor) continue;

    // An edge parent -> child means the referenced row must exist first.
    const dependents = children.get(foreignKey.parent_table);
    if (!dependents) {
      throw new ServiceUnavailableException('Destination PostgreSQL returned an unknown FK parent relation');
    }
    if (!dependents.has(foreignKey.child_table)) {
      dependents.add(foreignKey.child_table);
      inDegree.set(foreignKey.child_table, (inDegree.get(foreignKey.child_table) ?? 0) + 1);
    }
  }

  const ready = tables.filter((table) => inDegree.get(table) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (tableOrder.get(left) ?? 0) - (tableOrder.get(right) ?? 0));
    const table = ready.shift();
    if (!table) break;
    ordered.push(table);
    for (const child of children.get(table) ?? []) {
      const remaining = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }

  if (ordered.length !== tables.length) {
    const blocked = tables.filter((table) => (inDegree.get(table) ?? 0) > 0);
    throw new ServiceUnavailableException(
      'Destination schema contains an unhandled non-deferrable FK cycle in the tenant import set: ' +
      blocked.join(', '),
    );
  }
  return ordered;
}