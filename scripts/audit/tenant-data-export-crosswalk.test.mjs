import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PATHS = {
  source: "services/api/src/saas/saas-tenant-postgres-dataset-source.ts",
  migration: "migrations/156_tenant_privacy_inventory_and_rls_guardrails.sql",
  inventorySql: "services/api/test/tenant-data-governance-inventory.sql",
  ownership: "migrations/159_tenant_relation_ownership_reviews.sql",
  dto: "services/api/src/saas/dto/create-saas-schema-compatibility-rule.dto.ts",
  doc: "docs/tenant-data-export-crosswalk.md",
  governanceDoc: "docs/tenant-data-governance-and-isolation.md",
  columnContractMigration: "migrations/233_tenant_export_column_contract.sql",
  columnContractSql: "services/api/test/tenant-data-export-column-contract.sql",
  migrationManifest: "scripts/audit/migration-manifest.txt",
  postgresWorkflow: ".github/workflows/api-postgres-ci.yml",
};
const BLOCKED_WITHOUT_ADAPTER = ["FILE_REFERENCES", "INTEGRATION_METADATA"];
const DIRECT_IAM_TABLES = ["tenant_memberships", "roles"];
const IAM_RELATIONS = ["tenant_memberships", "roles", "user_roles", "role_permissions"];
const IAM_LOGICAL_OUTPUTS = ["iam_memberships", "iam_roles", "iam_user_roles", "iam_role_permissions"];

async function readRepoFile(path) {
  return readFile(resolve(ROOT, path), "utf8");
}
function requiredMatch(source, regex, label) {
  const match = source.match(regex);
  assert.ok(match, "could not parse " + label);
  return match;
}
function quotedTables(block) {
  return [...block.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]);
}
function sorted(values) {
  return [...values].sort();
}
async function loadSources() {
  const entries = await Promise.all(Object.entries(PATHS).map(async ([key, path]) => [key, await readRepoFile(path)]));
  return Object.fromEntries(entries);
}
function parseAdapterMaps(source) {
  return [...source.matchAll(/\[SaasTransferDatasetCategory\.(\w+)\]:\s*Object\.freeze\(\[([\s\S]*?)\]\)/g)]
    .map((match) => ({ category: match[1], tables: quotedTables(match[2]) }));
}
function parseMigrationCategories(migration) {
  const start = migration.indexOf("category := CASE");
  const end = migration.indexOf("erasure_policy := CASE", start);
  assert.ok(start >= 0 && end > start, "migration 156 category CASE is missing");
  const source = migration.slice(start, end);
  const entries = [];
  for (const match of source.matchAll(/WHEN item\.relation_name IN\s*\(([\s\S]*?)\)\s*THEN '([A-Z_]+)'/g)) {
    entries.push({ tables: quotedTables(match[1]), category: match[2] });
  }
  for (const match of source.matchAll(/WHEN item\.relation_name = '([a-z][a-z0-9_]*)'\s*THEN '([A-Z_]+)'/g)) {
    entries.push({ tables: [match[1]], category: match[2] });
  }
  return entries;
}
function categoriesFor(entries, table) {
  return entries.filter((entry) => entry.tables.includes(table)).map((entry) => entry.category);
}

test("TypeScript direct-table adapters, migration 156 and PostgreSQL inventory allowlist agree bidirectionally", async () => {
  const files = await loadSources();
  const maps = parseAdapterMaps(files.source);
  assert.ok(maps.length > 0, "at least one reviewed direct-table adapter must exist");
  const sourceTables = maps.flatMap((map) => map.tables);
  assert.equal(new Set(sourceTables).size, sourceTables.length, "a direct table may belong to only one export category");

  const migrationBlock = requiredMatch(
    files.migration,
    /is_export_allowlisted\s*:=\s*item\.relation_name\s+IN\s*\(([\s\S]*?)\n\s*\);/,
    "migration 156 direct export allowlist",
  )[1];
  const migrationTables = quotedTables(migrationBlock);
  const sqlBlock = requiredMatch(
    files.inventorySql,
    /i\.relation_name\s*<>\s*ALL\s*\(\s*ARRAY\s*\[([\s\S]*?)\]\s*::text\[\]\s*\)/,
    "tenant-data-governance-inventory.sql direct export guard",
  )[1];
  const sqlTables = quotedTables(sqlBlock);

  const expectedDatabaseTables = sourceTables.concat(DIRECT_IAM_TABLES);
  assert.deepEqual(sorted(migrationTables), sorted(expectedDatabaseTables),
    "migration 156 may allow only TypeScript source tables plus the two direct IAM relations emitted by the logical adapter");
  assert.deepEqual(sorted(sqlTables), sorted(migrationTables),
    "PostgreSQL inventory contract must guard exactly the migration 156 allowlist");
  assert.equal(new Set(migrationTables).size, migrationTables.length, "migration 156 allowlist contains duplicate relations");
  assert.equal(new Set(sqlTables).size, sqlTables.length, "PostgreSQL inventory allowlist contains duplicate relations");
});

test("each direct export table has one matching migration 156 data category", async () => {
  const files = await loadSources();
  const maps = parseAdapterMaps(files.source);
  const migrationCategories = parseMigrationCategories(files.migration);
  for (const map of maps) {
    for (const table of map.tables) {
      assert.deepEqual(categoriesFor(migrationCategories, table), [map.category],
        "migration 156 must classify public." + table + " as " + map.category);
    }
  }
  for (const table of DIRECT_IAM_TABLES) {
    assert.deepEqual(categoriesFor(migrationCategories, table), ["IAM_ACCESS"],
      "direct IAM relation public." + table + " must remain in IAM_ACCESS");
  }
});

test("every transfer category is either mapped, logically adapted, or explicitly blocked", async () => {
  const files = await loadSources();
  const enumBlock = requiredMatch(files.dto, /export enum SaasTransferDatasetCategory\s*\{([\s\S]*?)\}/,
    "SaasTransferDatasetCategory enum")[1];
  const categories = [...enumBlock.matchAll(/^\s*([A-Z_]+)\s*=/gm)].map((match) => match[1]);
  const maps = parseAdapterMaps(files.source);
  const mapped = new Set(maps.map((map) => map.category).concat(["IAM_ACCESS"]));
  const unsupported = categories.filter((category) => !mapped.has(category));
  assert.deepEqual(sorted(unsupported), sorted(BLOCKED_WITHOUT_ADAPTER),
    "new transfer categories need a reviewed adapter or an explicit fail-closed disposition");

  const requiredBlock = requiredMatch(files.dto,
    /export const REQUIRED_TRANSFER_CATEGORIES\s*=\s*\[([\s\S]*?)\]\s*as const/,
    "required transfer categories")[1];
  const required = [...requiredBlock.matchAll(/SaasTransferDatasetCategory\.(\w+)/g)].map((match) => match[1]);
  for (const category of ["BUSINESS_DATA", "AUDIT_LOG", "EVIDENCE", "APPROVALS", "EFFECTIVE_DATED_MASTER_DATA", "IAM_ACCESS"]) {
    assert.ok(required.includes(category), "required transfer categories must include " + category);
  }
  for (const category of unsupported) {
    assert.ok(!required.includes(category), "unsupported category " + category + " cannot become mandatory");
  }
  assert.match(files.source,
    /if\s*\(!tables\s*\|\|\s*tables\.length\s*===\s*0\)\s*\{\s*throw new ServiceUnavailableException\(/,
    "an unmapped category must fail with ServiceUnavailableException before emitting rows");
});

test("IAM exports only the dedicated logical remapping for direct and derived identity relations", async () => {
  const files = await loadSources();
  assert.match(files.source, /if\s*\(category\s*===\s*SaasTransferDatasetCategory\.IAM_ACCESS\)/);
  const start = files.source.indexOf("private async *readIamDatasetOnClient");
  const end = files.source.indexOf("private async *readDatasetOnClient", start);
  assert.ok(start >= 0 && end > start, "logical IAM reader is missing");
  const iamSource = files.source.slice(start, end);
  for (const relation of IAM_RELATIONS) {
    assert.ok(iamSource.includes("public." + relation), "logical IAM adapter must explicitly read " + relation);
  }
  for (const output of IAM_LOGICAL_OUTPUTS) {
    assert.ok(iamSource.includes("__factoryos_table: '" + output + "'"),
      "logical IAM output " + output + " is missing");
  }
  assert.match(files.ownership,
    /item\.relation_name IN \('user_roles',\s*'role_permissions'\) THEN 'ALLOWLISTED'/,
    "migration 159 may allow derived IAM tables only for the dedicated logical remapping");
});


test("generic export requires an immutable, versioned column contract before SELECT *", async () => {
  const files = await loadSources();
  const migration = files.columnContractMigration;
  const source = files.source;
  const readerStart = source.indexOf("private async *readDatasetOnClient");
  assert.ok(readerStart >= 0, "generic dataset reader is missing");
  const reader = source.slice(readerStart);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS factoryos_governance\.tenant_export_column_contracts/);
  assert.match(migration, /jsonb_agg\([\s\S]*column_meta\.attisdropped/);
  assert.match(migration, /format_type\(column_meta\.atttypid, column_meta\.atttypmod\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /ON CONFLICT \(schema_name, relation_name, contract_version\) DO NOTHING/);
  assert.match(migration, /GRANT SELECT ON factoryos_governance\.tenant_export_column_contracts TO factoryos_app/);

  assert.match(reader, /await this\.assertExportColumnContracts\(client, category, tables\)/);
  assert.ok(
    reader.indexOf("await this.assertExportColumnContracts") < reader.indexOf("SELECT dataset_row\.\*"),
    "column contract must be checked before SELECT * can emit any row",
  );
  assert.match(source, /latest_contracts\.column_manifest = live_manifests\.column_manifest/);
  assert.match(source, /pg_catalog\.pg_attribute/);
  assert.match(source, /pg_get_expr\(default_value\.adbin, default_value\.adrelid\)/);

  assert.match(files.columnContractSql, /ALTER TABLE public\.orders ADD COLUMN factoryos_ci_unreviewed_export_probe text/);
  assert.match(files.columnContractSql, /ROLLBACK_EXPORT_SCHEMA_DRIFT_PROBE/);
  assert.match(files.columnContractSql, /tenant_export_column_contracts/);
  assert.match(files.postgresWorkflow, /tenant-data-export-column-contract\.sql/);
  assert.ok(files.migrationManifest.includes("migrations/233_tenant_export_column_contract.sql"));
});

test("crosswalk documentation lists every relation and preserves explicit unsupported boundaries", async () => {
  const files = await loadSources();
  const maps = parseAdapterMaps(files.source);
  for (const map of maps) {
    assert.match(files.doc, new RegExp("### " + map.category + "\\b"),
      "crosswalk documentation is missing category " + map.category);
    for (const table of map.tables) {
      assert.ok(files.doc.includes("\`" + table + "\`"), "crosswalk documentation omits public." + table);
    }
  }
  for (const table of DIRECT_IAM_TABLES.concat(IAM_RELATIONS.filter((item) => !DIRECT_IAM_TABLES.includes(item)))) {
    assert.ok(files.doc.includes("\`" + table + "\`"), "crosswalk documentation omits IAM relation " + table);
  }
  for (const output of IAM_LOGICAL_OUTPUTS) {
    assert.ok(files.doc.includes("\`" + output + "\`"), "crosswalk documentation omits logical output " + output);
  }
  for (const category of BLOCKED_WITHOUT_ADAPTER) {
    assert.ok(files.doc.includes("\`" + category + "\`"), "crosswalk documentation omits blocked category " + category);
  }
  assert.ok(files.doc.includes("ServiceUnavailableException"), "unsupported categories must be documented as fail closed");
  assert.ok(files.doc.includes("PARTIAL"), "crosswalk documentation must not imply whole-tenant erasure/export acceptance");
  assert.ok(files.governanceDoc.includes("[Tenant export crosswalk](tenant-data-export-crosswalk.md)"),
    "tenant governance documentation must link to the canonical crosswalk");
});
