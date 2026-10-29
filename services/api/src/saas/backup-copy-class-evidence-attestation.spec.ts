import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalizeBackupCopyClassEvidenceAttestation,
  verifyBackupCopyClassEvidenceAttestation,
  type BackupCopyClassEvidenceAttestationPayload,
} from './backup-copy-class-evidence-attestation';

describe('backup copy-class evidence attestation', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = 'copy-owner-ed25519-test-v1';
  const ownerReference = 'owner.infrastructure.v1';
  const trustedKeys = JSON.stringify([{
    keyId,
    ownerReference,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }]);
  const payload: BackupCopyClassEvidenceAttestationPayload = {
    attestationKeyId: keyId,
    attestationOwnerReference: ownerReference,
    tenantId: '28000000-0000-4000-8000-000000000001',
    categoryCode: 'BUSINESS_DATA',
    copyClassCode: 'POSTGRESQL_WAL_PITR',
    disposition: 'UNRESOLVED',
    evidenceReference: 'backup.inventory.wal.v1',
    evidenceSha256: 'a'.repeat(64),
    evidenceAt: '2026-10-29T04:00:00.000Z',
    dataOwnerReference: 'owner.data.v1',
    infrastructureOwnerReference: ownerReference,
    policyReference: 'policy.retention.v1',
    reason: 'WAL archive class needs investigation',
  };

  function signatureFor(claims: BackupCopyClassEvidenceAttestationPayload): string {
    return sign(null, Buffer.from(canonicalizeBackupCopyClassEvidenceAttestation(claims), 'utf8'), privateKey)
      .toString('base64url');
  }

  it('accepts a valid trusted Ed25519 signature bound to tenant, class and evidence digest', () => {
    expect(() => verifyBackupCopyClassEvidenceAttestation(payload, signatureFor(payload), trustedKeys)).not.toThrow();
  });

  it('rejects a valid signature replayed against a different evidence digest', () => {
    const changed = { ...payload, evidenceSha256: 'b'.repeat(64) };
    expect(() => verifyBackupCopyClassEvidenceAttestation(changed, signatureFor(payload), trustedKeys))
      .toThrow(BadRequestException);
  });

  it('rejects a trusted key whose configured owner does not match the attested owner', () => {
    const wrongOwnerKeys = JSON.stringify([{
      keyId,
      ownerReference: 'owner.other.v1',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }]);
    expect(() => verifyBackupCopyClassEvidenceAttestation(payload, signatureFor(payload), wrongOwnerKeys))
      .toThrow(BadRequestException);
  });

  it('rejects unknown key ids and a signer not listed as a data or infrastructure owner', () => {
    expect(() => verifyBackupCopyClassEvidenceAttestation(
      { ...payload, attestationKeyId: 'unknown-ed25519-v1' }, signatureFor(payload), trustedKeys,
    )).toThrow(BadRequestException);
    const unrelatedOwner = { ...payload, attestationOwnerReference: 'owner.unrelated.v1' };
    expect(() => verifyBackupCopyClassEvidenceAttestation(unrelatedOwner, signatureFor(unrelatedOwner), trustedKeys))
      .toThrow(BadRequestException);
  });

  it('fails closed when trust configuration is absent or malformed', () => {
    expect(() => verifyBackupCopyClassEvidenceAttestation(payload, signatureFor(payload), undefined))
      .toThrow(ServiceUnavailableException);
    expect(() => verifyBackupCopyClassEvidenceAttestation(payload, signatureFor(payload), '{not-json'))
      .toThrow(ServiceUnavailableException);
  });

  it('rejects non-Ed25519 and duplicate trusted-key entries', () => {
    const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => verifyBackupCopyClassEvidenceAttestation(payload, signatureFor(payload), JSON.stringify([{
      keyId, ownerReference, publicKeyPem: rsaKey,
    }]))).toThrow(ServiceUnavailableException);
    expect(() => verifyBackupCopyClassEvidenceAttestation(payload, signatureFor(payload), JSON.stringify([
      { keyId, ownerReference, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      { keyId, ownerReference, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    ]))).toThrow(ServiceUnavailableException);
  });
});
