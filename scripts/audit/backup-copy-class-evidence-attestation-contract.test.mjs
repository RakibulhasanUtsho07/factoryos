import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const readRepoFile = (path) => readFile(resolve(process.cwd(), path), 'utf8');

test('backup copy-class evidence requires a trusted owner signature bound to the complete claim', async () => {
  const helper = await readRepoFile('services/api/src/saas/backup-copy-class-evidence-attestation.ts');
  const helperSpec = await readRepoFile('services/api/src/saas/backup-copy-class-evidence-attestation.spec.ts');
  const dto = await readRepoFile('services/api/src/saas/dto/create-saas-backup-copy-class-coverage.dto.ts');
  const service = await readRepoFile('services/api/src/saas/saas-tenant-backup-copy-class-coverage.service.ts');
  const migration = await readRepoFile('migrations/228_saas_tenant_backup_copy_class_coverage.sql');
  const apiEnv = await readRepoFile('services/api/.env.example');
  const runbook = await readRepoFile('docs/external-erasure-backup-copy-retention-runbook.md');
  const signingDoc = await readRepoFile('docs/backup-copy-class-evidence-attestation.md');
  const signer = await readRepoFile('scripts/security/sign-backup-copy-class-evidence.mjs');

  assert.match(helper, /factoryos\.backup-copy-class-evidence-attestation\/v1/);
  assert.match(helper, /publicKey\.asymmetricKeyType !== 'ed25519'/);
  assert.match(helper, /ServiceUnavailableException/);
  assert.match(helper, /candidate\.publicKeyPem\.includes\('PRIVATE KEY'\)/);
  assert.match(helper, /trustedKey\.ownerReference !== payload\.attestationOwnerReference/);
  assert.match(helper, /attestationOwnerReference !== payload\.dataOwnerReference/);
  assert.match(helper, /verify\(null, message, publicKey, signature\)/);
  assert.match(helper, /payload\.evidenceSha256/);
  assert.match(helperSpec, /different evidence digest/);
  assert.match(helperSpec, /absent or malformed/);
  assert.match(dto, /attestation_key_id/);
  assert.match(dto, /attestation_owner_reference/);
  assert.match(dto, /attestation_signature/);
  assert.match(service, /verifyBackupCopyClassEvidenceAttestation\(attestation,attestationSignature\)/);
  assert.match(service, /attestationSignatureSha256/);
  assert.match(service, /attestation_signature/);
  assert.match(migration, /attestation_key_id varchar/);
  assert.match(migration, /attestation_owner_reference varchar/);
  assert.match(migration, /attestation_signature varchar\(86\)/);
  assert.match(migration, /NEW\.attestation_signature[\s\S]*?OLD\.attestation_signature/);
  assert.match(migration, /attestation_owner_reference IN \(data_owner_reference,infrastructure_owner_reference\)/);
  assert.match(apiEnv, /FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON=\[\]/);
  assert.match(runbook, /signed backup copy-class evidence/);
  assert.match(signingDoc, /does not replace independent reviewer approval/);
  assert.match(signer, /Evidence pack digest does not match payload evidence_sha256/);
  assert.match(signer, /privateKey\.asymmetricKeyType !== 'ed25519'/);
});
