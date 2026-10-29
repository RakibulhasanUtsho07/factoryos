import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_TRUSTED_KEYS = 100;

export interface BackupCopyClassEvidenceAttestationPayload {
  attestationKeyId: string;
  attestationOwnerReference: string;
  tenantId: string;
  categoryCode: string;
  copyClassCode: string;
  disposition: string;
  evidenceReference: string;
  evidenceSha256: string;
  evidenceAt: string;
  dataOwnerReference: string;
  infrastructureOwnerReference: string;
  policyReference: string;
  reason: string;
}

interface TrustedEvidenceKey {
  keyId: string;
  ownerReference: string;
  publicKeyPem: string;
}

/**
 * Stable wire format signed by the independently trusted evidence owner.
 * Do not change field order or schema version without introducing v2.
 */
export function canonicalizeBackupCopyClassEvidenceAttestation(
  payload: BackupCopyClassEvidenceAttestationPayload,
): string {
  return JSON.stringify({
    schema: 'factoryos.backup-copy-class-evidence-attestation/v1',
    attestationKeyId: payload.attestationKeyId,
    attestationOwnerReference: payload.attestationOwnerReference,
    tenantId: payload.tenantId.toLowerCase(),
    categoryCode: payload.categoryCode,
    copyClassCode: payload.copyClassCode,
    disposition: payload.disposition,
    evidenceReference: payload.evidenceReference,
    evidenceSha256: payload.evidenceSha256,
    evidenceAt: payload.evidenceAt,
    dataOwnerReference: payload.dataOwnerReference,
    infrastructureOwnerReference: payload.infrastructureOwnerReference,
    policyReference: payload.policyReference,
    reason: payload.reason,
  });
}

function loadTrustedEvidenceKeys(raw: string | undefined): Map<string, TrustedEvidenceKey> {
  if (!raw?.trim()) {
    throw new ServiceUnavailableException(
      'Backup copy-class evidence signing is disabled: trusted public keys are not configured',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceUnavailableException('Backup copy-class trusted-key configuration is invalid');
  }

  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_TRUSTED_KEYS) {
    throw new ServiceUnavailableException('Backup copy-class trusted-key configuration is invalid');
  }

  const keys = new Map<string, TrustedEvidenceKey>();
  for (const candidate of parsed) {
    if (
      candidate === null
      || typeof candidate !== 'object'
      || typeof candidate.keyId !== 'string'
      || !KEY_ID.test(candidate.keyId)
      || typeof candidate.ownerReference !== 'string'
      || !SAFE_REFERENCE.test(candidate.ownerReference)
      || candidate.ownerReference.includes('://')
      || /(secret|password|credential|access[-_]?key|token)/i.test(candidate.ownerReference)
      || typeof candidate.publicKeyPem !== 'string'
      || !candidate.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')
      || candidate.publicKeyPem.includes('PRIVATE KEY')
      || keys.has(candidate.keyId)
    ) {
      throw new ServiceUnavailableException('Backup copy-class trusted-key configuration is invalid');
    }

    try {
      const publicKey = createPublicKey(candidate.publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('Trusted evidence keys must use Ed25519');
      }
    } catch {
      throw new ServiceUnavailableException('Backup copy-class trusted-key configuration is invalid');
    }

    keys.set(candidate.keyId, {
      keyId: candidate.keyId,
      ownerReference: candidate.ownerReference,
      publicKeyPem: candidate.publicKeyPem,
    });
  }
  return keys;
}

export function verifyBackupCopyClassEvidenceAttestation(
  payload: BackupCopyClassEvidenceAttestationPayload,
  signatureValue: string,
  trustedKeysJson: string | undefined = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_TRUSTED_KEYS_JSON,
): void {
  if (!KEY_ID.test(payload.attestationKeyId)) {
    throw new BadRequestException('attestation_key_id is invalid');
  }
  if (!SAFE_REFERENCE.test(payload.attestationOwnerReference) || payload.attestationOwnerReference.includes('://')) {
    throw new BadRequestException('attestation_owner_reference is invalid');
  }
  if (
    payload.attestationOwnerReference !== payload.dataOwnerReference
    && payload.attestationOwnerReference !== payload.infrastructureOwnerReference
  ) {
    throw new BadRequestException('attestation owner must match a declared data or infrastructure owner');
  }
  if (!SIGNATURE.test(signatureValue)) {
    throw new BadRequestException('attestation_signature must be a canonical Ed25519 base64url signature');
  }

  const trustedKey = loadTrustedEvidenceKeys(trustedKeysJson).get(payload.attestationKeyId);
  if (!trustedKey) {
    throw new BadRequestException('attestation_key_id is not trusted by this deployment');
  }
  if (trustedKey.ownerReference !== payload.attestationOwnerReference) {
    throw new BadRequestException('attestation key is not authorized for this evidence owner');
  }

  const signature = Buffer.from(signatureValue, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== signatureValue) {
    throw new BadRequestException('attestation_signature is not a canonical Ed25519 signature');
  }
  const publicKey = createPublicKey(trustedKey.publicKeyPem);
  const message = Buffer.from(canonicalizeBackupCopyClassEvidenceAttestation(payload), 'utf8');
  if (!verify(null, message, publicKey, signature)) {
    throw new BadRequestException('backup copy-class evidence attestation signature does not match the submitted claims');
  }
}
