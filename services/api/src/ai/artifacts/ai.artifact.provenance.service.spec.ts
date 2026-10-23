import { generateKeyPairSync, sign } from 'node:crypto';
import { jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';

import {
  AiArtifactProvenanceService,
  aiArtifactKeyFingerprint,
  canonicalizeAiArtifactEnvelope,
  verifyAiArtifactSignature,
} from './ai.artifact.provenance.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';
const actorUserId = '7fa03a36-6e3e-45ff-8f48-9ce3e2af0002';
const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestRef = '8fa03a36-6e3e-45ff-8f48-9ce3e2af0003';

describe('AI artifact provenance', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const envelope = {
    tenantId,
    artifactType: 'TOOL' as const,
    artifactKey: 'factoryos.example-tool',
    version: '1.2.0',
    sha256: 'a'.repeat(64),
    sourceId,
    expiresAt: '2099-10-23T00:00:00.000Z',
  };
  const signatureBase64 = sign(
    null,
    Buffer.from(canonicalizeAiArtifactEnvelope(envelope), 'utf8'),
    keys.privateKey,
  ).toString('base64');

  it('cryptographically verifies an Ed25519 signature over the full canonical envelope', () => {
    expect(verifyAiArtifactSignature(publicKeyPem, envelope, signatureBase64)).toBe(true);
    expect(verifyAiArtifactSignature(publicKeyPem, { ...envelope, sha256: 'b'.repeat(64) }, signatureBase64)).toBe(false);
    expect(verifyAiArtifactSignature(publicKeyPem, { ...envelope, version: '1.2.1' }, signatureBase64)).toBe(false);
  });

  it('rejects malformed signatures and non-Ed25519 keys', () => {
    expect(verifyAiArtifactSignature(publicKeyPem, envelope, 'not-base64')).toBe(false);
    expect(verifyAiArtifactSignature('invalid pem', envelope, signatureBase64)).toBe(false);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(verifyAiArtifactSignature(
      rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      envelope,
      signatureBase64,
    )).toBe(false);
  });

  it('writes a denial receipt and blocks an unregistered production artifact', async () => {
    const database = {
      query: jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(),
      transaction: jest.fn(),
    };
    const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
    database.query.mockResolvedValueOnce({ rows: [] });
    database.query.mockResolvedValueOnce({ rows: [] });
    const service = new AiArtifactProvenanceService(database as never, iam as never);

    await expect(service.assertAdmissible({
      tenantId,
      factoryId,
      actorUserId,
      artifactType: 'TOOL',
      artifactKey: 'factoryos.example-tool',
      version: '1.2.0',
      expectedSha256: 'a'.repeat(64),
      requestRef,
    })).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.query).toHaveBeenCalledTimes(2);
    expect(String(database.query.mock.calls[1]?.[0])).toContain('INSERT INTO ai_artifact_admission_events');
    expect(database.query.mock.calls[1]?.[1]).toContain('DENY');
    expect(database.query.mock.calls[1]?.[1]).toContain('ARTIFACT_NOT_REGISTERED');
  });

  it('admits an active, unexpired artifact only when digest, approved source and signature agree', async () => {
    const database = {
      query: jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(),
      transaction: jest.fn(),
    };
    const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };

    database.query.mockResolvedValueOnce({ rows: [{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: tenantId,
      artifact_type: 'TOOL',
      artifact_key: envelope.artifactKey,
      version: envelope.version,
      sha256: envelope.sha256,
      source_id: sourceId,
      expires_at: envelope.expiresAt,
      signature_base64: signatureBase64,
      status: 'ACTIVE',
      revision: 1,
      registered_at: '2026-10-23T00:00:00.000Z',
      source_key: 'approved-source',
      source_status: 'APPROVED',
      source_key_fingerprint: aiArtifactKeyFingerprint(publicKeyPem),
      source_public_key_pem: publicKeyPem,
      source_valid_until: '2100-01-01T00:00:00.000Z',
    }] });
    database.query.mockResolvedValueOnce({ rows: [] });
    const service = new AiArtifactProvenanceService(database as never, iam as never);

    await expect(service.assertAdmissible({
      tenantId,
      factoryId,
      actorUserId,
      artifactType: 'TOOL',
      artifactKey: envelope.artifactKey,
      version: envelope.version,
      expectedSha256: envelope.sha256,
      requestRef,
    })).resolves.toBeUndefined();

    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query.mock.calls[1]?.[1]).toContain('ALLOW');
    expect(database.query.mock.calls[1]?.[1]).toContain('ADMITTED');
  });

  it('denies an artifact if its trusted source has been revoked', async () => {
    const database = {
      query: jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(),
      transaction: jest.fn(),
    };
    const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
    database.query.mockResolvedValueOnce({ rows: [{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: tenantId,
      artifact_type: 'TOOL',
      artifact_key: envelope.artifactKey,
      version: envelope.version,
      sha256: envelope.sha256,
      source_id: sourceId,
      expires_at: envelope.expiresAt,
      signature_base64: signatureBase64,
      status: 'ACTIVE',
      revision: 1,
      registered_at: '2026-10-23T00:00:00.000Z',
      source_key: 'approved-source',
      source_status: 'REVOKED',
      source_key_fingerprint: aiArtifactKeyFingerprint(publicKeyPem),
      source_public_key_pem: publicKeyPem,
      source_valid_until: '2100-01-01T00:00:00.000Z',
    }] });
    database.query.mockResolvedValueOnce({ rows: [] });
    const service = new AiArtifactProvenanceService(database as never, iam as never);

    await expect(service.assertAdmissible({
      tenantId,
      factoryId,
      actorUserId,
      artifactType: 'TOOL',
      artifactKey: envelope.artifactKey,
      version: envelope.version,
      expectedSha256: envelope.sha256,
      requestRef,
    })).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.query.mock.calls[1]?.[1]).toContain('DENY');
    expect(database.query.mock.calls[1]?.[1]).toContain('SOURCE_NOT_APPROVED');
  });

  it('denies a registered artifact when the runtime digest differs', async () => {
    const database = {
      query: jest.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(),
      transaction: jest.fn(),
    };
    const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
    database.query.mockResolvedValueOnce({ rows: [{
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenant_id: tenantId,
      artifact_type: 'TOOL',
      artifact_key: envelope.artifactKey,
      version: envelope.version,
      sha256: envelope.sha256,
      source_id: sourceId,
      expires_at: envelope.expiresAt,
      signature_base64: signatureBase64,
      status: 'ACTIVE',
      revision: 1,
      registered_at: '2026-10-23T00:00:00.000Z',
      source_key: 'approved-source',
      source_status: 'APPROVED',
      source_key_fingerprint: aiArtifactKeyFingerprint(publicKeyPem),
      source_public_key_pem: publicKeyPem,
      source_valid_until: '2100-01-01T00:00:00.000Z',
    }] });
    database.query.mockResolvedValueOnce({ rows: [] });
    const service = new AiArtifactProvenanceService(database as never, iam as never);

    await expect(service.assertAdmissible({
      tenantId,
      factoryId,
      actorUserId,
      artifactType: 'TOOL',
      artifactKey: envelope.artifactKey,
      version: envelope.version,
      expectedSha256: 'b'.repeat(64),
      requestRef,
    })).rejects.toBeInstanceOf(ForbiddenException);

    expect(database.query.mock.calls[1]?.[1]).toContain('DENY');
    expect(database.query.mock.calls[1]?.[1]).toContain('ARTIFACT_DIGEST_MISMATCH');
  });
});
