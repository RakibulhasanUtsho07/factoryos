import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const manifestPath = resolve(root, "scripts/audit/migration-manifest.txt");
const migrationsDir = resolve(root, "migrations");

function fail(message) {
  console.error(`::error::Migration manifest verification failed: ${message}`);
  process.exitCode = 1;
}

const raw = await readFile(manifestPath, "utf8");
const entries = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

const seen = new Set();
const duplicates = [];
for (const entry of entries) {
  if (!/^migrations\/\d{3}_[a-z0-9_]+\.sql$/.test(entry)) {
    fail(`invalid manifest path: ${entry}`);
    continue;
  }
  if (seen.has(entry)) duplicates.push(entry);
  seen.add(entry);
  try {
    const details = await stat(resolve(root, entry));
    if (!details.isFile()) fail(`manifest path is not a regular file: ${entry}`);
  } catch {
    fail(`manifest entry does not exist: ${entry}`);
  }
}

const actual = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => `migrations/${entry.name}`)
  .sort();
const missing = actual.filter((entry) => !seen.has(entry));
const unexpected = entries.filter((entry) => !actual.includes(entry));

if (duplicates.length) fail(`duplicate entries: ${duplicates.join(", ")}`);
if (missing.length) fail(`SQL files omitted from ordered manifest: ${missing.join(", ")}`);
if (unexpected.length) fail(`manifest entries absent from migrations/: ${unexpected.join(", ")}`);
if (entries.length !== actual.length) {
  fail(`entry count ${entries.length} differs from SQL inventory count ${actual.length}`);
}
if (process.exitCode) process.exit(process.exitCode);

const canonical = `${entries.join("\n")}\n`;
const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
console.log(`migration_manifest_entry_count=${entries.length}`);
console.log(`migration_files_inventory_count=${actual.length}`);
console.log(`migration_manifest_sha256=${digest}`);
console.log("migration_manifest_inventory=PASS");
console.log("migration_manifest_order=explicit; dependency-aware, not lexical");
