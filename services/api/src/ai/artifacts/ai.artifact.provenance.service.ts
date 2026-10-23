import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';

import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { DatabaseService } from '../../database/database.service';
import { IamService } from '../../iam/iam.service';

export type AiArtifactType = 'MODEL' | 'TOOL' | 'PROMPT' | 'POLICY';

export interface AiArtifactEnvelope {
  tenantId: string;
  artifactType: AiArtifactType;
  artifactKey: string;
  version: string;
  sha256: string;
  sourceId: string;
  expiresAt: string;
}

export interface CreateAiArtifactSourceInput {
  sourceKey: string;
  label: string;
  publicKeyPem: string;
  validUntil: string;
}

export interface RegisterAiArtifactInput {
  artifactType: AiArtifactType;
  artifactKey: string;
  version: string;
  sha256: string;
  sourceId: string;
  expiresAt: string;
  signatureBase64: string;
}

export interface AssertAiArtifactAdmissibleInput {
  tenantId: string;
  factoryId: string;
  actorUserId: string;
  artifactType: AiArtifactType;
  artifactKey: string;
  version: string;
  expectedSha256: string | null;
  requestRef: string | null;
}

interface TrustedSourceRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  source_key: string;
  label: string;
  public_key_pem: string;
  key_fingerprint: string;
  valid_until: string;
  status: 'PENDING' | 'APPROVED' | 'REVOKED';
  revision: number;
  created_by: string;
  approved_by: string | null;
  created_at: string;
}

interface ArtifactRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  artifact_type: AiArtifactType;
  artifact_key: string;
  version: string;
  sha256: string;
  source_id: string;
  expires_at: string;
  signature_base64: string;
  status: 'ACTIVE' | 'REVOKED';
  revision: number;
  registered_at: string;
}

interface AdmissionLookupRow extends ArtifactRow {
  source_key: string;
  source_status: 'PENDING' | 'APPROVED' | 'REVOKED';
  source_key_fingerprint: string;
  source_public_key_pem: string;
  source_valid_until: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ARTIFACT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const ARTIFACT_TYPES = new Set<AiArtifactType>([
  'MODEL',
  'TOOL',
  'PROMPT',
  'POLICY',
]);

/**
 * This exact UTF-8 message is signed by the approved source's Ed25519 key.
 * All fields affecting artifact identity or production eligibility are bound
 * into the signature. Do not change this envelope without versioning it.
 */
export function canonicalizeAiArtifactEnvelope(
  envelope: AiArtifactEnvelope,
): string {
  const expiry = new Date(envelope.expiresAt);
  if (!Number.isFinite(expiry.getTime())) {
    throw new BadRequestException('Artifact expiry must be a valid ISO date');
  }

  return [
    'factoryos-ai-artifact-envelope-v1',
    envelope.tenantId.toLowerCase(),
    envelope.artifactType,
    envelope.artifactKey,
    envelope.version,
    envelope.sha256.toLowerCase(),
    envelope.sourceId.toLowerCase(),
    expiry.toISOString(),
  ].join('\n');
}

export function aiArtifactKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new BadRequestException('Artifact trust keys must be Ed25519 public keys');
  }

  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function verifyAiArtifactSignature(
  publicKeyPem: string,
  envelope: AiArtifactEnvelope,
  signatureBase64: string,
): boolean {
  try {
    if (
      typeof publicKeyPem !== 'string' ||
      !publicKeyPem.includes('-----BEGIN PUBLIC KEY-----') ||
      typeof signatureBase64 !== 'string' ||
      signatureBase64.length === 0 ||
      signatureBase64.length > 256
    ) {
      return false;
    }

    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;

    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) {
      return false;
    }

    return verifySignature(
      null,
      Buffer.from(canonicalizeAiArtifactEnvelope(envelope), 'utf8'),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

@Injectable()
export class AiArtifactProvenanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
  ) {}

  async createTrustedSource(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    requestRef: string | null,
    input: CreateAiArtifactSourceInput,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.authorizePublisher(actorUserId, tenantId, factoryId);

    const sourceKey = this.requiredText(input.sourceKey, 'sourceKey', 120);
    if (!SOURCE_KEY_PATTERN.test(sourceKey)) {
      throw new BadRequestException('sourceKey contains unsupported characters');
    }
    const label = this.requiredText(input.label, 'label', 240);
    const validUntil = this.futureDate(input.validUntil, 'validUntil');

    if (
      typeof input.publicKeyPem !== 'string' ||
      !input.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----') ||
      input.publicKeyPem.includes('PRIVATE KEY-----')
    ) {
      throw new BadRequestException('A public Ed25519 SubjectPublicKeyInfo PEM is required');
    }

    const keyFingerprint = aiArtifactKeyFingerprint(input.publicKeyPem);

    try {
      return await this.database.transaction(async (client) => {
        const inserted = await client.query<TrustedSourceRow>(
          "INSERT INTO ai_artifact_trusted_sources (\n" +
          " tenant_id, source_key, label, public_key_pem, key_fingerprint,\n" +
          " valid_until, status, revision, created_by\n" +
          ") VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 'PENDING', 1, $7)\n" +
          "RETURNING id::text AS id, tenant_id::text AS tenant_id,\n" +
          " source_key, label, key_fingerprint, valid_until::text AS valid_until,\n" +
          " status, revision, created_by::text AS created_by, NULL::text AS approved_by,\n" +
          " created_at::text AS created_at",
          [tenantId, sourceKey, label, input.publicKeyPem, keyFingerprint, validUntil, actorUserId],
        );

        const row = inserted.rows[0];
        await this.writeEvent(client, {
          tenantId,
          factoryId,
          actorUserId,
          entityType: 'SOURCE',
          entityId: row.id,
          action: 'SOURCE_REGISTERED',
          reason: 'Source registered pending independent approval',
          requestRef,
          payload: { sourceKey, keyFingerprint, status: 'PENDING' },
        });

        return {
          id: row.id,
          sourceKey: row.source_key,
          label: row.label,
          keyFingerprint: row.key_fingerprint,
          validUntil: row.valid_until,
          status: row.status,
          revision: row.revision,
          createdAt: row.created_at,
          approvalRequired: true,
        };
      }, { tenantId, userId: actorUserId });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Source key or public-key fingerprint is already registered for this tenant');
      }
      throw error;
    }
  }

  async approveTrustedSource(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    requestRef: string | null,
    sourceId: string,
    reason: string,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(sourceId, 'sourceId');
    await this.authorizePublisher(actorUserId, tenantId, factoryId);
    const approvalReason = this.requiredReason(reason);

    return this.database.transaction(async (client) => {
      const selected = await client.query<TrustedSourceRow>(
        "SELECT id::text AS id, tenant_id::text AS tenant_id, source_key, label,\n" +
        " public_key_pem, key_fingerprint, valid_until::text AS valid_until,\n" +
        " status, revision, created_by::text AS created_by,\n" +
        " approved_by::text AS approved_by, created_at::text AS created_at\n" +
        "FROM ai_artifact_trusted_sources WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, sourceId],
      );
      const source = selected.rows[0];
      if (!source) throw new NotFoundException('Artifact trust source was not found');
      if (source.status !== 'PENDING') {
        throw new ConflictException('Only a pending source may be approved');
      }
      if (source.created_by === actorUserId) {
        throw new ForbiddenException('A source must be approved by a different user than its registrant');
      }
      if (new Date(source.valid_until).getTime() <= Date.now()) {
        throw new ConflictException('Expired trust sources cannot be approved');
      }

      const updated = await client.query<TrustedSourceRow>(
        "UPDATE ai_artifact_trusted_sources SET status = 'APPROVED',\n" +
        " revision = revision + 1, approved_by = $3, approved_at = NOW(),\n" +
        " approval_reason = $4\n" +
        "WHERE tenant_id = $1 AND id = $2 AND status = 'PENDING'\n" +
        "RETURNING id::text AS id, tenant_id::text AS tenant_id, source_key, label,\n" +
        " key_fingerprint, valid_until::text AS valid_until, status, revision,\n" +
        " created_by::text AS created_by, approved_by::text AS approved_by,\n" +
        " created_at::text AS created_at",
        [tenantId, sourceId, actorUserId, approvalReason],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Source approval lost a concurrent state transition');

      await this.writeEvent(client, {
        tenantId,
        factoryId,
        actorUserId,
        entityType: 'SOURCE',
        entityId: sourceId,
        action: 'SOURCE_APPROVED',
        reason: approvalReason,
        requestRef,
        payload: { sourceKey: row.source_key, keyFingerprint: row.key_fingerprint, revision: row.revision },
      });

      return {
        id: row.id,
        sourceKey: row.source_key,
        label: row.label,
        keyFingerprint: row.key_fingerprint,
        validUntil: row.valid_until,
        status: row.status,
        revision: row.revision,
        approvedBy: row.approved_by,
        createdAt: row.created_at,
      };
    }, { tenantId, userId: actorUserId });
  }

  async revokeTrustedSource(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    requestRef: string | null,
    sourceId: string,
    reason: string,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(sourceId, 'sourceId');
    await this.authorizePublisher(actorUserId, tenantId, factoryId);
    const revokeReason = this.requiredReason(reason);

    return this.database.transaction(async (client) => {
      const selected = await client.query<TrustedSourceRow>(
        "SELECT id::text AS id, tenant_id::text AS tenant_id, source_key, label,\n" +
        " public_key_pem, key_fingerprint, valid_until::text AS valid_until,\n" +
        " status, revision, created_by::text AS created_by,\n" +
        " approved_by::text AS approved_by, created_at::text AS created_at\n" +
        "FROM ai_artifact_trusted_sources WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, sourceId],
      );
      const source = selected.rows[0];
      if (!source) throw new NotFoundException('Artifact trust source was not found');
      if (source.status === 'REVOKED') {
        throw new ConflictException('Artifact trust source is already revoked');
      }

      const updated = await client.query<TrustedSourceRow>(
        "UPDATE ai_artifact_trusted_sources SET status = 'REVOKED',\n" +
        " revision = revision + 1, revoked_by = $3, revoked_at = NOW(),\n" +
        " revoke_reason = $4\n" +
        "WHERE tenant_id = $1 AND id = $2 AND status IN ('PENDING', 'APPROVED')\n" +
        "RETURNING id::text AS id, tenant_id::text AS tenant_id, source_key, label,\n" +
        " key_fingerprint, valid_until::text AS valid_until, status, revision,\n" +
        " created_by::text AS created_by, approved_by::text AS approved_by,\n" +
        " created_at::text AS created_at",
        [tenantId, sourceId, actorUserId, revokeReason],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Source revocation lost a concurrent state transition');

      await this.writeEvent(client, {
        tenantId,
        factoryId,
        actorUserId,
        entityType: 'SOURCE',
        entityId: sourceId,
        action: 'SOURCE_REVOKED',
        reason: revokeReason,
        requestRef,
        payload: { sourceKey: row.source_key, keyFingerprint: row.key_fingerprint, revision: row.revision },
      });
      return { id: row.id, sourceKey: row.source_key, status: row.status, revision: row.revision };
    }, { tenantId, userId: actorUserId });
  }

  async registerArtifact(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    requestRef: string | null,
    input: RegisterAiArtifactInput,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    await this.authorizePublisher(actorUserId, tenantId, factoryId);

    const artifactType = input.artifactType;
    if (!ARTIFACT_TYPES.has(artifactType)) throw new BadRequestException('Unsupported artifactType');
    const artifactKey = this.requiredText(input.artifactKey, 'artifactKey', 200);
    const version = this.requiredText(input.version, 'version', 100);
    if (!ARTIFACT_KEY_PATTERN.test(artifactKey)) throw new BadRequestException('artifactKey contains unsupported characters');
    if (!VERSION_PATTERN.test(version)) throw new BadRequestException('version contains unsupported characters');
    this.validateUuid(input.sourceId, 'sourceId');
    const sha256 = this.normalizeDigest(input.sha256);
    const expiresAt = this.futureDate(input.expiresAt, 'expiresAt');
    const signatureBase64 = this.requiredText(input.signatureBase64, 'signatureBase64', 256);

    try {
      return await this.database.transaction(async (client) => {
        const sourceResult = await client.query<TrustedSourceRow>(
          "SELECT id::text AS id, tenant_id::text AS tenant_id, source_key, label,\n" +
          " public_key_pem, key_fingerprint, valid_until::text AS valid_until,\n" +
          " status, revision, created_by::text AS created_by,\n" +
          " approved_by::text AS approved_by, created_at::text AS created_at\n" +
          "FROM ai_artifact_trusted_sources WHERE tenant_id = $1 AND id = $2 FOR SHARE",
          [tenantId, input.sourceId],
        );
        const source = sourceResult.rows[0];
        if (!source) throw new NotFoundException('Artifact trust source was not found');
        if (source.status !== 'APPROVED') {
          throw new ForbiddenException('Artifact source is not approved');
        }
        if (new Date(source.valid_until).getTime() <= Date.now()) {
          throw new ForbiddenException('Artifact source has expired');
        }
        if (new Date(expiresAt).getTime() > new Date(source.valid_until).getTime()) {
          throw new BadRequestException('Artifact expiry cannot exceed its signing source validity');
        }

        const envelope: AiArtifactEnvelope = {
          tenantId,
          artifactType,
          artifactKey,
          version,
          sha256,
          sourceId: input.sourceId,
          expiresAt,
        };
        if (!verifyAiArtifactSignature(source.public_key_pem, envelope, signatureBase64)) {
          throw new ForbiddenException('Artifact signature verification failed');
        }
        if (aiArtifactKeyFingerprint(source.public_key_pem) !== source.key_fingerprint) {
          throw new ForbiddenException('Artifact source key fingerprint integrity check failed');
        }

        const existingResult = await client.query<ArtifactRow>(
          "SELECT id::text AS id, tenant_id::text AS tenant_id, artifact_type, artifact_key,\n" +
          " version, sha256, source_id::text AS source_id, expires_at::text AS expires_at,\n" +
          " signature_base64, status, revision, registered_at::text AS registered_at\n" +
          "FROM ai_artifact_registry WHERE tenant_id = $1 AND artifact_type = $2\n" +
          " AND artifact_key = $3 AND version = $4 FOR UPDATE",
          [tenantId, artifactType, artifactKey, version],
        );
        const existing = existingResult.rows[0];
        if (existing) {
          const exactReplay =
            existing.sha256 === sha256 &&
            existing.source_id === input.sourceId &&
            new Date(existing.expires_at).toISOString() === expiresAt &&
            existing.signature_base64 === signatureBase64;
          if (exactReplay) return { ...this.artifactSummary(existing), idempotent: true };
          throw new ConflictException('Artifact identity already exists with different immutable content');
        }

        const inserted = await client.query<ArtifactRow>(
          "INSERT INTO ai_artifact_registry (\n" +
          " tenant_id, artifact_type, artifact_key, version, sha256, source_id,\n" +
          " expires_at, signature_base64, status, revision, registered_by\n" +
          ") VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, 'ACTIVE', 1, $9)\n" +
          "RETURNING id::text AS id, tenant_id::text AS tenant_id, artifact_type,\n" +
          " artifact_key, version, sha256, source_id::text AS source_id,\n" +
          " expires_at::text AS expires_at, signature_base64, status, revision,\n" +
          " registered_at::text AS registered_at",
          [tenantId, artifactType, artifactKey, version, sha256, input.sourceId, expiresAt, signatureBase64, actorUserId],
        );
        const row = inserted.rows[0];

        await this.writeEvent(client, {
          tenantId,
          factoryId,
          actorUserId,
          entityType: 'ARTIFACT',
          entityId: row.id,
          action: 'ARTIFACT_REGISTERED',
          reason: 'Artifact registered after Ed25519 signature verification',
          requestRef,
          artifactType,
          artifactKey,
          artifactVersion: version,
          artifactSha256: sha256,
          payload: { sourceId: input.sourceId, sourceKey: source.source_key, keyFingerprint: source.key_fingerprint },
        });

        return { ...this.artifactSummary(row), idempotent: false };
      }, { tenantId, userId: actorUserId });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Artifact identity is already registered; create a new version for changed content');
      }
      throw error;
    }
  }

  async revokeArtifact(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    requestRef: string | null,
    artifactId: string,
    reason: string,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(artifactId, 'artifactId');
    await this.authorizePublisher(actorUserId, tenantId, factoryId);
    const revokeReason = this.requiredReason(reason);

    return this.database.transaction(async (client) => {
      const selected = await client.query<ArtifactRow>(
        "SELECT id::text AS id, tenant_id::text AS tenant_id, artifact_type,\n" +
        " artifact_key, version, sha256, source_id::text AS source_id,\n" +
        " expires_at::text AS expires_at, signature_base64, status, revision,\n" +
        " registered_at::text AS registered_at\n" +
        "FROM ai_artifact_registry WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, artifactId],
      );
      const artifact = selected.rows[0];
      if (!artifact) throw new NotFoundException('AI artifact was not found');
      if (artifact.status === 'REVOKED') throw new ConflictException('AI artifact is already revoked');

      const updated = await client.query<ArtifactRow>(
        "UPDATE ai_artifact_registry SET status = 'REVOKED', revision = revision + 1,\n" +
        " revoked_by = $3, revoked_at = NOW(), revoke_reason = $4\n" +
        "WHERE tenant_id = $1 AND id = $2 AND status = 'ACTIVE'\n" +
        "RETURNING id::text AS id, tenant_id::text AS tenant_id, artifact_type,\n" +
        " artifact_key, version, sha256, source_id::text AS source_id,\n" +
        " expires_at::text AS expires_at, signature_base64, status, revision,\n" +
        " registered_at::text AS registered_at",
        [tenantId, artifactId, actorUserId, revokeReason],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Artifact revocation lost a concurrent state transition');

      await this.writeEvent(client, {
        tenantId,
        factoryId,
        actorUserId,
        entityType: 'ARTIFACT',
        entityId: artifactId,
        action: 'ARTIFACT_REVOKED',
        reason: revokeReason,
        requestRef,
        artifactType: row.artifact_type,
        artifactKey: row.artifact_key,
        artifactVersion: row.version,
        artifactSha256: row.sha256,
        payload: { revision: row.revision },
      });
      return { ...this.artifactSummary(row), idempotent: false };
    }, { tenantId, userId: actorUserId });
  }

  /**
   * Live admission point for the Tool Gateway. Registry state and signature
   * are re-read and re-verified for each production execution; no allow-cache
   * can outlive source revocation or expiry.
   */
  async assertAdmissible(input: AssertAiArtifactAdmissibleInput): Promise<void> {
    this.validateScope(input.tenantId, input.factoryId, input.actorUserId);
    if (!ARTIFACT_TYPES.has(input.artifactType)) {
      throw new ForbiddenException('Unsupported artifact type at runtime');
    }

    const identityValid =
      ARTIFACT_KEY_PATTERN.test(input.artifactKey) &&
      VERSION_PATTERN.test(input.version);
    const expectedDigest =
      typeof input.expectedSha256 === 'string' && SHA256_PATTERN.test(input.expectedSha256.toLowerCase())
        ? input.expectedSha256.toLowerCase()
        : null;
    let reasonCode = 'ARTIFACT_NOT_REGISTERED';
    let artifactId: string | null = null;
    let storedDigest: string | null = null;

    const result = identityValid
      ? await this.database.query<AdmissionLookupRow>(
        "SELECT a.id::text AS id, a.tenant_id::text AS tenant_id, a.artifact_type,\n" +
        " a.artifact_key, a.version, a.sha256, a.source_id::text AS source_id,\n" +
        " a.expires_at::text AS expires_at, a.signature_base64, a.status,\n" +
        " a.revision, a.registered_at::text AS registered_at,\n" +
        " s.source_key, s.status AS source_status, s.key_fingerprint AS source_key_fingerprint,\n" +
        " s.public_key_pem AS source_public_key_pem, s.valid_until::text AS source_valid_until\n" +
        "FROM ai_artifact_registry a JOIN ai_artifact_trusted_sources s\n" +
        " ON s.id = a.source_id AND s.tenant_id = a.tenant_id\n" +
        "WHERE a.tenant_id = $1 AND a.artifact_type = $2\n" +
        " AND a.artifact_key = $3 AND a.version = $4 LIMIT 1",
        [input.tenantId, input.artifactType, input.artifactKey, input.version],
        { tenantId: input.tenantId, userId: input.actorUserId },
      )
      : { rows: [] as AdmissionLookupRow[] };

    const artifact = result.rows[0];
    if (artifact) {
      artifactId = artifact.id;
      storedDigest = artifact.sha256;
      const envelope: AiArtifactEnvelope = {
        tenantId: artifact.tenant_id,
        artifactType: artifact.artifact_type,
        artifactKey: artifact.artifact_key,
        version: artifact.version,
        sha256: artifact.sha256,
        sourceId: artifact.source_id,
        expiresAt: artifact.expires_at,
      };

      if (!expectedDigest) reasonCode = 'EXPECTED_DIGEST_MISSING_OR_INVALID';
      else if (expectedDigest !== artifact.sha256) reasonCode = 'ARTIFACT_DIGEST_MISMATCH';
      else if (artifact.status !== 'ACTIVE') reasonCode = 'ARTIFACT_REVOKED';
      else if (new Date(artifact.expires_at).getTime() <= Date.now()) reasonCode = 'ARTIFACT_EXPIRED';
      else if (artifact.source_status !== 'APPROVED') reasonCode = 'SOURCE_NOT_APPROVED';
      else if (new Date(artifact.source_valid_until).getTime() <= Date.now()) reasonCode = 'SOURCE_EXPIRED';
      else {
        let validSignature = false;
        try {
          validSignature =
            aiArtifactKeyFingerprint(artifact.source_public_key_pem) === artifact.source_key_fingerprint &&
            verifyAiArtifactSignature(
              artifact.source_public_key_pem,
              envelope,
              artifact.signature_base64,
            );
        } catch {
          validSignature = false;
        }
        reasonCode = validSignature ? 'ADMITTED' : 'SIGNATURE_OR_KEY_INTEGRITY_INVALID';
      }
    } else if (!identityValid) {
      reasonCode = 'ARTIFACT_IDENTITY_INVALID';
    } else if (!expectedDigest) {
      reasonCode = 'EXPECTED_DIGEST_MISSING_OR_INVALID';
    }

    const allowed = reasonCode === 'ADMITTED';
    await this.database.query(
      "INSERT INTO ai_artifact_admission_events (\n" +
      " tenant_id, factory_id, actor_user_id, artifact_id, artifact_type,\n" +
      " artifact_key, artifact_version, expected_sha256, registry_sha256,\n" +
      " decision, reason_code, request_ref\n" +
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [
        input.tenantId,
        input.factoryId,
        input.actorUserId,
        artifactId,
        input.artifactType,
        input.artifactKey.slice(0, 200),
        input.version.slice(0, 100),
        expectedDigest,
        storedDigest,
        allowed ? 'ALLOW' : 'DENY',
        reasonCode,
        input.requestRef,
      ],
      { tenantId: input.tenantId, userId: input.actorUserId },
    );

    if (!allowed) {
      throw new ForbiddenException('AI artifact admission denied: ' + reasonCode);
    }
  }

  private async authorizePublisher(
    actorUserId: string,
    tenantId: string,
    factoryId: string,
  ): Promise<void> {
    await this.iamService.authorize(actorUserId, tenantId, 'ai.agents.publish', factoryId);
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string): void {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a UUID');
  }

  private requiredText(value: string, field: string, maximum: number): string {
    if (typeof value !== 'string') throw new BadRequestException(field + ' must be a string');
    const normalized = value.trim();
    if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
      throw new BadRequestException(field + ' is empty, too long, or contains line breaks');
    }
    return normalized;
  }

  private requiredReason(value: string): string {
    const reason = this.requiredText(value, 'reason', 500);
    if (reason.length < 8) throw new BadRequestException('reason must contain at least 8 characters');
    return reason;
  }

  private futureDate(value: string, field: string): string {
    if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) {
      throw new BadRequestException(field + ' must be a valid ISO date');
    }
    const parsed = new Date(value);
    if (parsed.toISOString() !== value || parsed.getTime() <= Date.now()) {
      throw new BadRequestException(field + ' must be a canonical future ISO timestamp');
    }
    return parsed.toISOString();
  }

  private normalizeDigest(value: string): string {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value.toLowerCase())) {
      throw new BadRequestException('sha256 must be a 64-character hexadecimal digest');
    }
    return value.toLowerCase();
  }

  private async writeEvent(
    client: PoolClient,
    event: {
      tenantId: string;
      factoryId: string;
      actorUserId: string;
      entityType: 'SOURCE' | 'ARTIFACT';
      entityId: string;
      action: string;
      reason: string;
      requestRef: string | null;
      artifactType?: AiArtifactType;
      artifactKey?: string;
      artifactVersion?: string;
      artifactSha256?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      "INSERT INTO ai_artifact_provenance_events (\n" +
      " tenant_id, factory_id, actor_user_id, entity_type, entity_id, action,\n" +
      " reason, request_ref, artifact_type, artifact_key, artifact_version,\n" +
      " artifact_sha256, payload\n" +
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)",
      [
        event.tenantId,
        event.factoryId,
        event.actorUserId,
        event.entityType,
        event.entityId,
        event.action,
        event.reason,
        event.requestRef,
        event.artifactType ?? null,
        event.artifactKey ?? null,
        event.artifactVersion ?? null,
        event.artifactSha256 ?? null,
        JSON.stringify(event.payload ?? {}),
      ],
    );
  }

  private artifactSummary(row: ArtifactRow) {
    return {
      id: row.id,
      artifactType: row.artifact_type,
      artifactKey: row.artifact_key,
      version: row.version,
      sha256: row.sha256,
      sourceId: row.source_id,
      expiresAt: row.expires_at,
      status: row.status,
      revision: row.revision,
      registeredAt: row.registered_at,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }
}
