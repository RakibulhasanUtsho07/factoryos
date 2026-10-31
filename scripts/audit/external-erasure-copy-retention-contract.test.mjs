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

test('BACKUP target stays inactive unless runtime writer-fence acceptance gates are complete', async () => {
  const adapter = await readRepoFile(BACKUP_ADAPTER_SOURCE);
  const provider = await readRepoFile(S3_WRITER_FENCE_PROVIDER);
  const doc = await readRepoFile(BACKUP_ADAPTER_DOC);

  assert.match(adapter, /await this\.assertVersioningEnabled\(storage\);[\s\S]*?await this\.assertObjectLockEnabled\(storage\);/);
  assert.match(adapter, /if \(!this\.supportsTarget\(target\) \|\| !this\.writerFenceProvider \|\| !this\.writerInventory \|\| !this\.providerAcceptance\) return false/);
  const activation = adapter.slice(adapter.indexOf('async isConfigured'), adapter.indexOf('async prepare'));
  assert.match(activation, /this\.writerFenceProvider\.getProviderAcceptanceReferences\(\)/);
  assert.match(activation, /requireCurrentAcceptedProviderAcceptance/);
  assert.match(activation, /requireCurrentAcceptedProviderAcceptance[\s\S]*?return true;/);
  assert.match(activation, /catch\s*\{\s*return false/);
  assert.match(provider, /getProviderAcceptanceReferences/);
  assert.match(provider, /FACTORYOS_BACKUP_STORAGE_ERASURE_RUNNER_ENABLED/);
  assert.match(doc, /durable, independently reviewed provider-acceptance (?:record|registry)/i);
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
const BACKUP_WRITER_INVENTORY_SERVICE = 'services/api/src/saas/saas-tenant-backup-writer-inventory.service.ts';
const BACKUP_WRITER_INVENTORY_MIGRATION = 'migrations/223_saas_backup_writer_principal_inventory.sql';
const BACKUP_WRITER_FENCE_COORDINATOR = 'services/api/src/saas/s3-tenant-backup-writer-fence.coordinator.ts';
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

  assert.match(adapter, /this\.writerFenceProvider\.getProviderAcceptanceReferences\(\)/);
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
test('backup writer-fence and inventory migrations are in replay and PostgreSQL acceptance coverage', async () => {
  const manifest = await readRepoFile('scripts/audit/migration-manifest.txt');
  const migration = await readRepoFile('migrations/222_saas_tenant_backup_writer_fence_ledger.sql');
  const inventoryMigration = await readRepoFile('migrations/223_saas_backup_writer_principal_inventory.sql');
  const contract = await readRepoFile('services/api/test/saas-tenant-propagation-contract.sql');
  const workflow = await readRepoFile('.github/workflows/api-postgres-ci.yml');

  const manifestEntries = manifest.split(/\r?\n/).map((entry) => entry.trim());
  assert.ok(manifestEntries.includes('migrations/222_saas_tenant_backup_writer_fence_ledger.sql'),
    'writer-fence migration must be included in the canonical PostgreSQL replay');
  assert.ok(manifestEntries.includes('migrations/223_saas_backup_writer_principal_inventory.sql'),
    'writer inventory migration must be included in the canonical PostgreSQL replay');
  assert.match(migration, /tenant_relation_ownership_reviews/i);
  assert.match(migration, /backup writer operation uses a stale writer epoch/i);
  assert.match(inventoryMigration, /saas_tenant_backup_writer_inventory_snapshots/);
  assert.match(inventoryMigration, /saas_tenant_backup_writer_fence_inventory_binding_guard/);
  assert.doesNotMatch(inventoryMigration, /\bAS \$(?:\r?\n)|\bEND \$(?:;|\r?\n)/,
    'inventory migration PL/pgSQL dollar-quote delimiters must be balanced');
  assert.ok(inventoryMigration.trimEnd().endsWith('COMMIT;'),
    'inventory migration must be one closed transaction');
  assert.match(contract, /writer fence advanced while upload outcome remained ACTIVE/);
  assert.match(contract, /backup erasure was verified while residual copies remained/);
  assert.match(contract, /stale writer epoch was accepted after release/);
  assert.match(contract, /Tenant B must not see tenant A backup writer fence/);
  assert.match(workflow, /Reapplying the tenant backup writer-fence ledger/);
  assert.match(workflow, /Reapplying the reviewed backup writer-principal inventory[\s\S]*?migrations\/223_saas_backup_writer_principal_inventory\.sql/);
});


test('S3 writer fence denies direct object writes, replication and replication delete markers', async () => {
  const provider = await readRepoFile(S3_WRITER_FENCE_PROVIDER);
  const providerSpec = await readRepoFile('services/api/src/saas/s3-tenant-backup-writer-fence.provider.spec.ts');
  const doc = await readRepoFile(BACKUP_WRITER_FENCE_DOC);

  assert.match(provider, /Action:\s*\[['"]s3:PutObject['"],\s*['"]s3:ReplicateObject['"],\s*['"]s3:ReplicateDelete['"]\]/);
  assert.ok(providerSpec.includes("Action: ['s3:PutObject', 's3:ReplicateObject', 's3:ReplicateDelete']"));
  assert.match(doc, /s3:PutObject.*s3:ReplicateObject.*s3:ReplicateDelete/);
  assert.match(doc, /S3 BACKUP erasure adapter remains fail-closed/i);
});

test('propagation runner acquires the backup fence before any target inventory', async () => {
  const runner = await readRepoFile('services/api/src/saas/saas-tenant-propagation.service.ts');
  const coordinator = await readRepoFile('services/api/src/saas/s3-tenant-backup-writer-fence.coordinator.ts');
  const env = await readRepoFile('services/api/.env.example');
  const migration = await readRepoFile('migrations/222_saas_tenant_backup_writer_fence_ledger.sql');
  const adapterDoc = await readRepoFile('docs/s3-tenant-backup-erasure-adapter.md');
  const runbook = await readRepoFile(RUNBOOK);
  const fenceDoc = await readRepoFile(BACKUP_WRITER_FENCE_DOC);

  assert.match(adapterDoc, /propagation runner is now wired to the coordinator/i);
  assert.match(runbook, /propagation runner now acquires and reads back the fence before any target adapter inventory/i);
  assert.doesNotMatch(runbook, /runtime writer-fence coordinator is implemented/i);
  assert.doesNotMatch(fenceDoc, /until the controller is integrated into the propagation run before inventory/i);
  assert.match(runner, /beginPropagationFence/);
  assert.match(runner, /beginPropagationFence[\s\S]*?for \(const target of prepared\.targets\)/);
  assert.match(runner, /recordPropagationVerification/);
  const runStart = runner.indexOf('beginPropagationFence');
  const targetLoop = runner.indexOf('for (const target of prepared.targets)');
  const firstPrepare = runner.indexOf('plan = await adapter.prepare(context)');
  const firstDelete = runner.indexOf('deletion = await adapter.erase({ ...context, plan })');
  const prepareFenceCheck = runner.indexOf('await this.backupWriterFenceCoordinator.assertFenceHeld', targetLoop);
  const deleteFenceCheck = runner.indexOf('await this.backupWriterFenceCoordinator!.assertFenceHeld', targetLoop);
  assert.ok(runStart >= 0 && runStart < targetLoop && targetLoop < prepareFenceCheck && prepareFenceCheck < firstPrepare);
  assert.ok(deleteFenceCheck > firstPrepare && deleteFenceCheck < firstDelete);
  assert.match(coordinator, /getProviderAcceptanceReferences/);
  assert.match(coordinator, /requireCurrentAcceptedProviderAcceptance/);
  assert.match(coordinator, /PROVIDER_ACCEPTANCE_REVOKED/);
  assert.match(coordinator, /installAndRecordFence[\s\S]*?markErasureStarted/);
  assert.match(migration, /chk_saas_backup_writer_fence_acceptance_references/);
  assert.match(migration, /staging_acceptance_reference IS NOT NULL/);
  assert.ok(migration.trimEnd().endsWith('COMMIT;'), 'writer-fence migration must be one closed transaction');
  assert.match(env, /FACTORYOS_BACKUP_STORAGE_ERASURE_RUNNER_ENABLED=false/);
  assert.match(env, /FACTORYOS_BACKUP_STORAGE_POLICY_OWNERSHIP_REVIEW_REFERENCE=/);
});


test('backup writer fences are bound to the latest independently reviewed inventory snapshot', async () => {
  const service = await readRepoFile(BACKUP_WRITER_INVENTORY_SERVICE);
  const migration = await readRepoFile(BACKUP_WRITER_INVENTORY_MIGRATION);
  const coordinator = await readRepoFile(BACKUP_WRITER_FENCE_COORDINATOR);
  assert.match(service, /requireCurrentAcceptedSnapshot/);
  assert.match(service, /reviewedByUserId/);
  assert.match(service, /this\.hash\(entries\) !== row\.manifest_digest/);
  assert.match(migration, /writer inventory entries may be added only to a pending snapshot/);
  assert.match(migration, /writer inventory review requires the exact sealed entry count/);
  assert.match(migration, /snapshot_digest IS DISTINCT FROM NEW\.writer_inventory_digest/);
  assert.match(migration, /writer_inventory_snapshot_id/);
  assert.match(coordinator, /getProviderAcceptanceReferences/);
  assert.match(coordinator, /requireCurrentAcceptedSnapshot/);
  assert.match(coordinator, /WRITER_INVENTORY_CHANGED/);
  assert.match(coordinator, /requireCurrentAcceptedProviderAcceptance/);
  assert.match(coordinator, /PROVIDER_ACCEPTANCE_REVOKED/);
});


test('next writer epoch remains gated until provider policy removal is durably confirmed', async () => {
  const migration = await readRepoFile('migrations/225_saas_backup_writer_release_confirmation.sql');
  const service = await readRepoFile('services/api/src/saas/saas-tenant-backup-writer-fence.service.ts');
  const coordinator = await readRepoFile('services/api/src/saas/s3-tenant-backup-writer-fence.coordinator.ts');
  const contract = await readRepoFile('services/api/test/saas-tenant-propagation-contract.sql');
  const serviceSpec = await readRepoFile('services/api/src/saas/saas-tenant-backup-writer-fence.service.spec.ts');
  const manifest = await readRepoFile('scripts/audit/migration-manifest.txt');
  const workflow = await readRepoFile('.github/workflows/api-postgres-ci.yml');

  assert.ok(manifest.split(/\r?\n/).map((entry) => entry.trim()).includes('migrations/225_saas_backup_writer_release_confirmation.sql'));
  assert.match(migration, /provider_release_confirmed_at timestamptz/);
  assert.match(migration, /factoryos_guard_saas_backup_writer_release_gate/);
  assert.match(migration, /factoryos_guard_saas_backup_writer_fence_release_gate/);
  assert.match(migration, /provider release confirmation is a one-way fact/);
  assert.match(service, /async confirmProviderFenceReleased/);
  assert.match(service, /provider_release_confirmed_at === null/);
  assert.match(coordinator, /this\.lifecycle\.confirmProviderFenceReleased/);
  const releaseStart = coordinator.indexOf('async releaseAfterTombstoneReplay');
  const policyRemoval = coordinator.indexOf('this.provider.removeFence', releaseStart);
  const releaseConfirm = coordinator.indexOf('this.lifecycle.confirmProviderFenceReleased', releaseStart);
  assert.ok(releaseStart >= 0 && policyRemoval > releaseStart && releaseConfirm > policyRemoval);
  assert.match(contract, /next writer epoch was accepted before provider release confirmation/);
  assert.match(serviceSpec, /blocks the next writer epoch until provider policy removal is confirmed/);
  assert.match(workflow, /Reapplying provider-release confirmation gate[\s\S]*?migrations\/225_saas_backup_writer_release_confirmation\.sql/);
  assert.ok(migration.trimEnd().endsWith('COMMIT;'), 'writer-release confirmation migration must be one closed transaction');
});

test('backup provider activation requires durable, independently reviewed, revocable staging evidence', async () => {
  const adapter = await readRepoFile(BACKUP_ADAPTER_SOURCE);
  const service = await readRepoFile('services/api/src/saas/saas-tenant-backup-provider-acceptance.service.ts');
  const migration = await readRepoFile('migrations/224_saas_backup_provider_acceptance_registry.sql');
  const docs = await readRepoFile('docs/s3-backup-provider-acceptance.md');
  const scenarioDto = await readRepoFile('services/api/src/saas/dto/create-saas-backup-provider-acceptance.dto.ts');
  const requiredScenarios = [
    'POLICY_DENY_READBACK', 'COPY_OBJECT_DURING_FENCE', 'MULTIPART_COMPLETION_DURING_FENCE',
    'REPLICATION_DELETE_MARKER', 'POLICY_DRIFT_DETECTED', 'CRASH_RECOVERY_DENY_PRESERVED',
    'DELAYED_WRITER_REJECTED', 'TOMBSTONE_REPLAY_BEFORE_RELEASE',
    'INDEPENDENT_RESIDUAL_LISTING', 'RESTORE_AFTER_TOMBSTONE_REPLAY',
  ];
  assert.match(service, /SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS/);
  assert.match(service, /for \(const required of SAAS_BACKUP_PROVIDER_ACCEPTANCE_SCENARIOS\)/);
  for (const scenario of requiredScenarios) {
    assert.ok(scenarioDto.includes("'" + scenario + "'"), 'DTO is missing provider staging scenario: ' + scenario);
    assert.ok(migration.includes("'" + scenario + "'"), 'database constraint lacks scenario: ' + scenario);
    assert.ok(docs.includes(scenario), 'provider acceptance doc lacks scenario: ' + scenario);
  }
  assert.match(adapter, /requireCurrentAcceptedProviderAcceptance/);
  assert.match(service, /valid_until/);
  assert.match(service, /BACKUP_PROVIDER_ACCEPTANCE_REVOKED/);
  assert.match(service, /policyOwnershipReviewReference/);
  assert.match(service, /stagingAcceptanceReference/);
  assert.match(service, /restoreReplayReference/);
  assert.match(migration, /policy_ownership_review_reference varchar/);
  assert.match(migration, /restore_replay_reference varchar/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /provider acceptance revocations are append-only/);
});

test('backup writer operation registration is bound to the current accepted producer inventory', async () => {
  const source = await readRepoFile('services/api/src/saas/saas-tenant-backup-writer-fence.service.ts');
  assert.match(source, /requireCurrentAcceptedSnapshot\(tenantId, category\)/);
  assert.match(source, /acceptedInventory\.entries\.some\(\(entry\) => entry\.producerId === producerId\)/);
  assert.match(source, /FROM saas_tenant_backup_writer_inventory_snapshots/);
  assert.match(source, /ORDER BY revision DESC LIMIT 1 FOR SHARE/);
  assert.match(source, /Backup writer operations require an independently accepted writer-principal inventory/);
});


test('whole-tenant erasure requires current reviewed evidence for every copy class and category', async () => {
 const migration=await readRepoFile('migrations/226_saas_external_copy_class_coverage.sql');
 const manifest=await readRepoFile('scripts/audit/migration-manifest.txt');
 const workflow=await readRepoFile('.github/workflows/api-postgres-ci.yml');
 const source=await readRepoFile('services/api/src/saas/saas-tenant-propagation.service.ts');
 const coverageService=await readRepoFile('services/api/src/saas/saas-tenant-external-copy-coverage.service.ts');
 const controller=await readRepoFile('services/api/src/saas/saas-tenant-external-copy-coverage.controller.ts');
 const module=await readRepoFile('services/api/src/saas/saas.module.ts');
 const runbook=await readRepoFile(RUNBOOK);
 assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.saas_tenant_external_copy_coverage_decisions'));
 assert.ok(migration.includes('FORCE ROW LEVEL SECURITY'));
 assert.ok(workflow.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO factoryos_app;'));
 assert.ok(migration.includes('external copy-class coverage decisions are immutable'));
 assert.ok(migration.includes('separate reviewer and reason'));
 assert.ok(migration.includes('evidence expired before approval'));
 assert.ok(migration.includes('CREATE TRIGGER saas_tenant_external_copy_coverage_decision_guard'));
 assert.ok(manifest.split(/\r?\n/).includes('migrations/226_saas_external_copy_class_coverage.sql'));
 assert.ok(workflow.includes('Reapplying reviewed external copy-class coverage'));
 assert.ok(workflow.includes('migrations/226_saas_external_copy_class_coverage.sql'));
 for(const disposition of ['SUPPORTED','NOT_APPLICABLE','UNRESOLVED']) assert.ok(source.includes(disposition));
 assert.ok(source.includes('assertCurrentCopyCoverage') && source.includes('adapter.erase'));
 assert.ok(source.includes('assertCurrentCopyCoverage') && source.includes('adapter.verify'));
 assert.ok(source.includes('copyClassCoverageDigest'));
 assert.ok(source.includes('row.required !== true'));
 assert.ok(source.includes('const finalTargetsActive = finalRelevantRows.every((row) => row.status === \'ACTIVE\' && row.required === true)'));
 assert.ok(coverageService.includes('Idempotency-Key was reused for a different copy-class coverage decision'));
 assert.ok(coverageService.includes('submission and review require different actors'));
 assert.ok(controller.includes("RequirePermission('saas.data_retention.approve')"));
 assert.ok(module.includes('SaasTenantExternalCopyCoverageController'));
 assert.ok(runbook.includes('Machine-enforced copy-class coverage'));
 assert.ok(runbook.includes('UNRESOLVED') && runbook.includes('block erasure'));
});


test('copy-class coverage and required target inventory cannot drift while an erasure run is RUNNING', async () => {
 const migration=await readRepoFile('migrations/227_saas_external_copy_coverage_run_fence.sql');
 const manifest=await readRepoFile('scripts/audit/migration-manifest.txt');
 const workflow=await readRepoFile('.github/workflows/api-postgres-ci.yml');
 const runbook=await readRepoFile(RUNBOOK);
 assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_external_copy_coverage_run_fence()'));
 assert.ok(migration.includes('PERFORM 1 FROM public.tenants WHERE id=scope_tenant FOR UPDATE'));
 assert.ok(migration.includes("r.status='RUNNING'"));
 assert.ok(migration.includes('saas_tenant_external_data_targets'));
 assert.ok(migration.includes('BEFORE INSERT OR UPDATE OR DELETE'));
 assert.ok(manifest.split(/\r?\n/).includes('migrations/227_saas_external_copy_coverage_run_fence.sql'));
 assert.ok(workflow.includes('Reapplying external copy-coverage run fence'));
 assert.ok(runbook.includes('A database-level run fence takes the tenant lock') && runbook.includes('while any propagation run is'));
});


test('granular backup copy-class coverage blocks unresolved backup media and binds reviewed evidence', async () => {
 const migration=await readRepoFile('migrations/228_saas_tenant_backup_copy_class_coverage.sql');
 const manifest=await readRepoFile('scripts/audit/migration-manifest.txt');
 const workflow=await readRepoFile('.github/workflows/api-postgres-ci.yml');
 const source=await readRepoFile('services/api/src/saas/saas-tenant-propagation.service.ts');
 const constants=await readRepoFile('services/api/src/saas/backup-copy-class-coverage.constants.ts');
 const coverageService=await readRepoFile('services/api/src/saas/saas-tenant-backup-copy-class-coverage.service.ts');
 const controller=await readRepoFile('services/api/src/saas/saas-tenant-backup-copy-class-coverage.controller.ts');
 const module=await readRepoFile('services/api/src/saas/saas.module.ts');
 const sql=await readRepoFile('services/api/test/saas-tenant-propagation-contract.sql');
 const runbook=await readRepoFile(RUNBOOK);
 assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.saas_tenant_backup_copy_class_coverage_decisions'));
 assert.ok(migration.includes('FORCE ROW LEVEL SECURITY'));
 assert.ok(migration.includes('factoryos_guard_saas_external_copy_coverage_run_fence'));
 assert.ok(migration.includes('backup copy-class evidence and scope are immutable'));
 assert.ok(migration.includes('separate reviewer and reason'));
 assert.ok(manifest.split(/\r?\n/).includes('migrations/228_saas_tenant_backup_copy_class_coverage.sql'));
 assert.ok(workflow.includes('Reapplying granular backup copy-class registry'));
 for(const code of ['POSTGRESQL_BASE_BACKUP','POSTGRESQL_WAL_PITR','REDIS_AOF_BACKUP','REDIS_RDB_BACKUP','FILESYSTEM_SNAPSHOT','BLOCK_VOLUME_SNAPSHOT','MANAGED_BACKUP_VAULT','REPLICA_FAILOVER_COPY','EXTERNAL_DR_COPY']) assert.ok(constants.includes(code));
 assert.ok(source.includes('assertBackupCopyClassCoverage'));
 assert.ok(source.includes('backupCopyClassCoverageDigest'));
 assert.ok(source.includes('Unresolved backup copy class blocks whole-tenant erasure'));
 assert.ok(source.includes('No reviewed erasure adapter is registered for backup copy class'));
 assert.ok(coverageService.includes('submission and review require different actors'));
 assert.ok(controller.includes("RequirePermission('saas.data_retention.approve')"));
 assert.ok(module.includes('SaasTenantBackupCopyClassCoverageController'));
 assert.ok(sql.includes('saas_tenant_backup_copy_class_coverage_decisions'));
 assert.ok(sql.includes('backup copy-class evidence changed while an erasure run was RUNNING'));
 assert.ok(runbook.includes('Granular backup copy-class acceptance'));
});

test('canonical backup copy-class catalog covers documented backup and secondary-copy planes', async () => {
  const constants = await readRepoFile('services/api/src/saas/backup-copy-class-coverage.constants.ts');
  const migration = await readRepoFile('migrations/230_saas_tenant_backup_copy_class_catalog_expansion.sql');
  const manifest = await readRepoFile('scripts/audit/migration-manifest.txt');
  const runbook = await readRepoFile(RUNBOOK);
  const attestationGuide = await readRepoFile('docs/backup-copy-class-evidence-attestation.md');
  const propagation = await readRepoFile('services/api/src/saas/saas-tenant-propagation.service.ts');
  const expected = ["S3_OBJECT_VERSIONS","POSTGRESQL_BASE_BACKUP","POSTGRESQL_WAL_PITR","REDIS_AOF_BACKUP","REDIS_RDB_BACKUP","FILESYSTEM_SNAPSHOT","BLOCK_VOLUME_SNAPSHOT","MANAGED_BACKUP_VAULT","REPLICA_FAILOVER_COPY","EXTERNAL_DR_COPY","SEARCH_INDEX_COPY","VECTOR_STORE_COPY","LEARNING_ARTIFACT_COPY","EXTERNAL_PROVIDER_COPY","EXTERNAL_CACHE_COPY","UNCLASSIFIED_EXTERNAL_COPY"];
  for (const code of expected) {
    assert.ok(constants.includes("'" + code + "'"), 'API catalog is missing ' + code);
    assert.ok(migration.includes("'" + code + "'"), 'PostgreSQL catalog constraint is missing ' + code);
    assert.ok(runbook.includes('`' + code + '`'), 'runbook is missing ' + code);
    assert.ok(attestationGuide.includes('`' + code + '`'), 'attestation guide is missing ' + code);
  }
  assert.ok(manifest.includes('migrations/230_saas_tenant_backup_copy_class_catalog_expansion.sql'),
    'catalog expansion migration must be in the ordered PostgreSQL replay manifest');
  assert.ok(propagation.includes('for (const copyClass of REQUIRED_BACKUP_COPY_CLASSES)'),
    'whole-tenant erasure must iterate the complete API catalog');
  assert.match(propagation, /No reviewed erasure adapter is registered for backup copy class/);
  assert.match(runbook, /NOT_APPLICABLE` decision is valid only when the signed evidence pack proves the relevant inventory scope was exhaustively enumerated/);
  assert.match(runbook, /UNCLASSIFIED_EXTERNAL_COPY/);
});


test('external copy-coverage decisions require trusted signatures and exact source-byte read-back', async () => {
  const migration = await readRepoFile('migrations/231_saas_external_copy_coverage_evidence_attestation.sql');
  const unclassifiedMigration = await readRepoFile('migrations/232_saas_external_copy_coverage_unclassified_store_guard.sql');
  const manifest = await readRepoFile('scripts/audit/migration-manifest.txt');
  const apiWorkflow = await readRepoFile('.github/workflows/api-postgres-ci.yml');
  const sqlContract = await readRepoFile('services/api/test/saas-tenant-propagation-contract.sql');
  const source = await readRepoFile('services/api/src/saas/saas-tenant-external-copy-coverage.service.ts');
  const adapters = await readRepoFile('services/api/src/saas/saas-tenant-propagation.adapters.ts');
  const propagation = await readRepoFile('services/api/src/saas/saas-tenant-propagation.service.ts');
  const policy = await readRepoFile('deploy/security/backup-copy-evidence-readonly-policy.yaml');
  const attestation = await readRepoFile('services/api/src/saas/backup-copy-class-evidence-attestation.ts');
  const dto = await readRepoFile('services/api/src/saas/dto/create-saas-external-copy-coverage.dto.ts');
  const signer = await readRepoFile('scripts/security/sign-external-copy-coverage-evidence.mjs');
  const inventoryManifest = await readRepoFile('services/api/src/saas/external-store-inventory-manifest.ts');
  const inventoryEvidenceDoc = await readRepoFile('docs/external-store-inventory-evidence.md');
  const sourceReceiptSigner = await readRepoFile('scripts/security/sign-external-store-inventory-source-receipt.mjs');
  const sourceReceiptSignerTest = await readRepoFile('scripts/security/sign-external-store-inventory-source-receipt.test.mjs');
  const sourceTrustExample = await readRepoFile('deploy/security/backup-copy-evidence-trust.env.example');
  const runbook = await readRepoFile(RUNBOOK);
  assert.ok(migration.includes('attestation_key_id') && migration.includes('attestation_owner_reference') && migration.includes('attestation_signature'));
  assert.ok(migration.includes('new external copy-class coverage requires signed opaque evidence'));
  assert.ok(migration.includes('unsigned legacy external copy-class evidence cannot be accepted'));
  assert.ok(migration.includes('IS DISTINCT FROM'));
  assert.ok(manifest.split(/\r?\n/).includes('migrations/231_saas_external_copy_coverage_evidence_attestation.sql'));
  assert.ok(manifest.split(/\r?\n/).includes('migrations/232_saas_external_copy_coverage_unclassified_store_guard.sql'));
  assert.ok(apiWorkflow.includes('migrations/231_saas_external_copy_coverage_evidence_attestation.sql'));
  assert.ok(apiWorkflow.includes('migrations/232_saas_external_copy_coverage_unclassified_store_guard.sql'));
  assert.ok(sqlContract.includes('attestation_key_id,attestation_owner_reference,attestation_signature'));
  assert.ok(sqlContract.includes('pending external copy-coverage signature was mutable'));
  assert.ok(migration.includes('attestation_key_id IS NOT NULL') && migration.includes('attestation_signature IS NOT NULL'));
  assert.ok(dto.includes('attestation_signature') && dto.includes('attestation_key_id'));
  assert.ok(source.includes('verifyExternalCopyCoverageEvidenceAttestation'));
  assert.ok(source.includes('evidenceArtifactReader.verifyArtifact'));
  assert.ok(source.includes('validateExternalStoreInventoryManifest'));
  assert.ok(source.includes('readVerifiedArtifact'));
  assert.ok(inventoryManifest.includes('REQUIRED_EXTERNAL_INVENTORY_SOURCE_KINDS'));
  assert.ok(inventoryManifest.includes('pagination_exhausted'));
  assert.ok(inventoryManifest.includes('scope_sha256'));
  assert.ok(inventoryManifest.includes('EXTERNAL_STORE_INVENTORY_SOURCE_RECEIPT_SCHEMA'));
  assert.ok(inventoryManifest.includes('FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON'));
  assert.ok(inventoryManifest.includes('canonicalizeExternalStoreInventorySourceReceipt'));
  assert.ok(sourceReceiptSigner.includes('factoryos.external-store-inventory-source-receipt/v1'));
  assert.ok(sourceReceiptSigner.includes('pagination_exhausted'));
  assert.ok(sourceReceiptSignerTest.includes('valid Ed25519 signature'));
  assert.ok(sourceReceiptSignerTest.includes('rejects incomplete pagination'));
  assert.ok(sourceTrustExample.includes('FACTORYOS_EXTERNAL_INVENTORY_SOURCE_TRUSTED_KEYS_JSON=[]'));
  assert.ok(inventoryEvidenceDoc.includes('factoryos.external-store-inventory/v1'));
  assert.ok(inventoryEvidenceDoc.includes('Independently trusted source receipts'));
  assert.ok(inventoryEvidenceDoc.includes('does **not** independently call cloud provider APIs'));
  assert.ok(propagation.includes('validateExternalStoreInventoryManifest'));
  assert.ok(propagation.includes('readVerifiedArtifact'));
  assert.ok(source.includes('Unsigned legacy external copy-coverage evidence cannot be accepted'));
  assert.ok(propagation.includes('await this.assertTargetCoverage'));
  assert.ok(propagation.includes('External copy-coverage evidence attestation is invalid'));
  assert.ok(propagation.includes('await this.backupEvidenceArtifactReader.verifyArtifact(decision.evidence_reference, decision.evidence_sha256)'));
  assert.ok(attestation.includes('factoryos.external-copy-coverage-evidence-attestation/v1'));
  assert.ok(signer.includes('store_kind') && signer.includes('evidence_sha256'));
  assert.ok(runbook.includes('Ed25519') && runbook.includes('read-back'));
  assert.ok(unclassifiedMigration.includes('UNCLASSIFIED_EXTERNAL_STORE'));
  assert.ok(unclassifiedMigration.includes("disposition IN ('NOT_APPLICABLE','UNRESOLVED')"));
  assert.ok(adapters.includes('UNCLASSIFIED_EXTERNAL_STORE_KIND'));
  assert.ok(adapters.includes('EXTERNAL_COPY_COVERAGE_STORE_KINDS'));
  assert.ok(propagation.includes('An unclassified external store type was discovered or remains unresolved'));
  assert.ok(policy.includes('Init containers must not attach writable volume mounts'));
});
