import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const RUNBOOK = 'docs/external-erasure-backup-copy-retention-runbook.md';
const CACHE_ADAPTER_DOC = 'docs/tenant-cache-erasure-adapter.md';
const RESOURCE_LEDGER_DOC = 'docs/external-erasure-resource-ledger.md';
const BACKUP_ADAPTER_DOC = 'docs/s3-tenant-backup-erasure-adapter.md';
const BACKUP_ADAPTER_SOURCE = 'services/api/src/saas/s3-tenant-backup-erasure.adapter.ts';

async function readRepoFile(path) {
  return readFile(resolve(ROOT, path), 'utf8');
}

test('backup-copy retention runbook covers required historical and secondary copy classes', async () => {
  const source = await readRepoFile(RUNBOOK);
  const requiredSections = [
    '# External Erasure: Backup and Historical-Copy Retention Runbook',
    '## Copy inventory',
    '## Legal holds and retention policy',
    '## Execution procedure',
    '## Required evidence pack',
    '## Supported adapter boundary',
    '## Go-live checklist',
  ];
  for (const section of requiredSections) assert.ok(source.includes(section), 'missing runbook section: ' + section);

  const requiredCoverage = [
    /AOF backups?/i,
    /RDB snapshots?/i,
    /filesystem snapshots/i,
    /block-volume snapshots/i,
    /replicas/i,
    /backup vault/i,
    /point-in-time recovery/i,
    /search indexes/i,
    /vector stores/i,
    /learning artifacts/i,
    /external providers/i,
    /legacy\/external caches/i,
    /restore.*erasure|erasure.*restore/i,
    /independent(?:ly)? (?:read\/list path|verification|absence check)/i,
  ];
  for (const pattern of requiredCoverage) assert.match(source, pattern, 'missing copy/verification coverage: ' + pattern);
});

test('runbook requires policy approval and fail-closed handling of holds and unsupported copies', async () => {
  const source = await readRepoFile(RUNBOOK);
  assert.match(source, /Do \*\*not\*\* invent a universal retention duration/i);
  assert.match(source, /active legal hold/i);
  assert.match(source, /unresolved or unenumerated class blocks a whole-tenant/i);
  assert.match(source, /the request remains incomplete/i);
  assert.match(source, /AS-137 \/ NFR-PROD-14 must remain \*\*PARTIAL\*\*/i);
  assert.match(source, /CI success alone is not production acceptance/i);
});

test('adapter and resource-ledger docs make the backup-copy boundary discoverable', async () => {
  const runbook = await readRepoFile(RUNBOOK);
  const cacheDoc = await readRepoFile(CACHE_ADAPTER_DOC);
  const ledgerDoc = await readRepoFile(RESOURCE_LEDGER_DOC);
  const backupDoc = await readRepoFile(BACKUP_ADAPTER_DOC);

  assert.match(cacheDoc, /\[external erasure backup-copy retention runbook\]\(external-erasure-backup-copy-retention-runbook\.md\)/i);
  assert.match(runbook, /\[the external-erasure resource ledger\]\(external-erasure-resource-ledger\.md\)/i);
  assert.match(ledgerDoc, /backups lack complete reviewed adapters|backups? require evidence|backup expiry\/immutability/i);
  assert.match(runbook, /\[the S3 tenant backup adapter contract\]\(s3-tenant-backup-erasure-adapter\.md\)/i);
  assert.match(backupDoc, /Object Lock/i);
  assert.match(backupDoc, /does not cover|does not prove|out of scope/i);
  assert.match(backupDoc, /freeze must be acquired|write-freeze mechanism/i);
  assert.match(runbook, /provider\/control-plane fence/i);
});

test('BACKUP target cannot activate until an erasure-lifecycle writer fence is implemented', async () => {
  const source = await readRepoFile(BACKUP_ADAPTER_SOURCE);
  assert.match(source, /S3 versioning\/Object Lock(?: alone)? do not[\s\S]*?fence new writes[\s\S]*?return false;/i);
  assert.match(source, /return false;/);
  const doc = await readRepoFile(BACKUP_ADAPTER_DOC);
  assert.match(doc, /`isConfigured\(\)` intentionally returns false/i);
});

test('runbook explicitly distinguishes an operational contract from production deletion evidence', async () => {
  const source = await readRepoFile(RUNBOOK);
  assert.match(source, /not a record of a completed production purge/i);
  assert.match(source, /does not assert that production secrets, provider backups, customer copies, or controlled staging have already been tested or erased/i);
  assert.match(source, /Adapter-generated correlation identifiers are not provider-issued receipts/i);
});

const BACKUP_WRITER_FENCE_SERVICE = 'services/api/src/saas/saas-tenant-backup-writer-fence.service.ts';
const S3_WRITER_FENCE_PROVIDER = 'services/api/src/saas/s3-tenant-backup-writer-fence.provider.ts';
const BACKUP_WRITER_FENCE_MIGRATION = 'migrations/222_saas_tenant_backup_writer_fence_ledger.sql';
const BACKUP_WRITER_FENCE_DOC = 'docs/s3-tenant-backup-writer-fence.md';

test('backup writer-fence ledger provides crash-safe drain and database guardrails', async () => {
  const source = await readRepoFile(BACKUP_WRITER_FENCE_SERVICE);
  const migration = await readRepoFile(BACKUP_WRITER_FENCE_MIGRATION);
  const doc = await readRepoFile(BACKUP_WRITER_FENCE_DOC);
  for (const name of ['beginWriteOperation','finalizeWriteOperation','beginErasureFence','advanceAfterDrain',
    'recordProviderFenceInstalled','markErasureStarted','markErasureVerified','requireRecovery',
    'resumeAfterRecovery','releaseAfterTombstoneReplay']) {
    assert.match(source, new RegExp('\\b' + name + '\\s*\\('), 'missing lifecycle method: ' + name);
  }
  assert.match(migration, /CREATE TABLE IF NOT EXISTS saas_tenant_backup_writer_operations/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS saas_tenant_backup_writer_fences/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /backup writer operations are retained/i);
  assert.match(migration, /invalid backup writer-fence lifecycle transition/i);
  assert.match(migration, /backup writer operation uses a stale writer epoch/i);
  assert.match(migration, /backup writer fence uses a stale writer epoch/i);
  assert.ok(migration.includes("recovery_attestation_reference !~* '://'"));
  assert.match(migration, /state<>'RELEASED'/i);
  assert.match(doc, /Provider activation, producer integration and actual-provider acceptance remain release blockers/i);
  assert.match(doc, /AS-137 \/ NFR-PROD-14 remain PARTIAL/i);
});

test('backup erasure stays fail-closed while S3 policy and producer acceptance gates are open', async () => {
  const adapter = await readRepoFile(BACKUP_ADAPTER_SOURCE);
  const doc = await readRepoFile(BACKUP_WRITER_FENCE_DOC);
  const provider = await readRepoFile('services/api/src/saas/s3-tenant-backup-writer-fence.provider.ts');
  const coordinator = await readRepoFile('services/api/src/saas/s3-tenant-backup-writer-fence.coordinator.ts');
  const env = await readRepoFile('services/api/.env.example');

  assert.match(adapter, /S3 versioning\/Object Lock alone do not[\s\S]*?fence new writes/);
  assert.ok(provider.includes('FACTORYOS_BACKUP_STORAGE_POLICY_CONTROLLER_ENABLED'));
  assert.ok(provider.includes('FACTORYOS_BACKUP_STORAGE_POLICY_OWNERSHIP_ACKNOWLEDGED'));
  assert.ok(provider.includes("Effect: 'Deny'") && provider.includes("'s3:PutObject'") && provider.includes("'s3:ReplicateObject'") && provider.includes("'s3:ReplicateDelete'"));
  assert.ok(provider.includes('listMultipartUploads'));
  assert.ok(provider.includes('independently read-back'));
  assert.ok(coordinator.includes('recordProviderFenceInstalled'));
  assert.ok(coordinator.includes('releasePolicyDigest'));
  assert.ok(coordinator.includes('this.provider.removeFence'));
  assert.ok(env.includes('FACTORYOS_BACKUP_STORAGE_POLICY_CONTROLLER_ENABLED=false'));
  assert.ok(doc.includes('not an independently verified lock on provider policy changes'));
});
test('backup writer-fence ledger is in replay and PostgreSQL acceptance coverage', async () => {
  const manifest = await readRepoFile('scripts/audit/migration-manifest.txt');
  const migration = await readRepoFile('migrations/222_saas_tenant_backup_writer_fence_ledger.sql');
  const contract = await readRepoFile('services/api/test/saas-tenant-propagation-contract.sql');
  const workflow = await readRepoFile('.github/workflows/api-postgres-ci.yml');

  assert.ok(
    manifest.split(/\r?\n/).map((entry) => entry.trim()).includes('migrations/222_saas_tenant_backup_writer_fence_ledger.sql'),
    'writer-fence migration must be included in the canonical PostgreSQL replay',
  );
  assert.match(migration, /tenant_relation_ownership_reviews/i);
  assert.match(migration, /backup writer operation uses a stale writer epoch/i);
  assert.match(contract, /writer fence advanced while upload outcome remained ACTIVE/);
  assert.match(contract, /backup erasure was verified while residual copies remained/);
  assert.match(contract, /stale writer epoch was accepted after release/);
  assert.match(contract, /Tenant B must not see tenant A backup writer fence/);
  assert.match(workflow, /Reapplying the tenant backup writer-fence ledger/);
});


test('S3 writer fence denies direct object writes, replication and replication delete markers', async () => {
  const provider = await readRepoFile(S3_WRITER_FENCE_PROVIDER);
  const providerSpec = await readRepoFile('services/api/src/saas/s3-tenant-backup-writer-fence.provider.spec.ts');
  const doc = await readRepoFile(BACKUP_WRITER_FENCE_DOC);

  assert.match(provider, /Action:\s*\[['"]s3:PutObject['"],\s*['"]s3:ReplicateObject['"],\s*['"]s3:ReplicateDelete['"]\]/);
  assert.ok(providerSpec.includes("Action: ['s3:PutObject', 's3:ReplicateObject', 's3:ReplicateDelete']"));
  assert.match(doc, /s3:PutObject.*s3:ReplicateObject.*s3:ReplicateDelete/);
  assert.match(doc, /S3 BACKUP adapter remains fail-closed/i);
});
