import { ServiceUnavailableException } from '@nestjs/common';

export interface SaasTenantImportForeignKey {
  child_table: string;
  parent_table: string;
  constraint_name: string;
  is_deferrable: boolean;
  child_columns: string[];
}

/**
 * Parent-before-child ordering for one tenant import.
 *
 * This graph contains only non-deferrable FKs whose two endpoints are present
 * in the imported table set. FKs to rows provisioned outside this transfer are
 * enforced by PostgreSQL when the insert runs. Deferrable constraints are
 * intentionally deferred by the importer until transaction commit.
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
      foreignKey.child_columns.some((column) => typeof column !== 'string' || column.length === 0)
    ) {
      throw new ServiceUnavailableException('Destination PostgreSQL returned incomplete foreign-key metadata');
    }
    if (!tableOrder.has(foreignKey.child_table) || !tableOrder.has(foreignKey.parent_table)) {
      throw new ServiceUnavailableException('Destination PostgreSQL returned an FK outside the reviewed import table set');
    }
    if (foreignKey.is_deferrable) continue;

    // This one immediate circular pointer is deliberately omitted in the first
    // INSERT projection and restored only after both relations have been loaded.
    const deferredBlueprintPointer =
      foreignKey.child_table === 'business_blueprints' &&
      foreignKey.parent_table === 'business_blueprint_versions' &&
      foreignKey.child_columns.length === 1 &&
      foreignKey.child_columns[0] === 'current_version_id';
    if (deferredBlueprintPointer) continue;

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