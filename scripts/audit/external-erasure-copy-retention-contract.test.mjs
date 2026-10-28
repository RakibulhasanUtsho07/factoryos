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
  assert.match(backupDoc, /write-freeze mechanism/i);
  assert.match(runbook, /provider\/control-plane fence/i);
});

test('BACKUP target cannot activate until an erasure-lifecycle writer fence is implemented', async () => {
  const source = await readRepoFile(BACKUP_ADAPTER_SOURCE);
  assert.match(source, /S3 versioning\/Object Lock do not fence new writes[\s\S]*?return false;/i);
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
