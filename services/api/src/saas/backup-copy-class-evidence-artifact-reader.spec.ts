import { jest } from '@jest/globals';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupCopyClassEvidenceArtifactReader } from './backup-copy-class-evidence-artifact-reader';

describe('BackupCopyClassEvidenceArtifactReader', () => {
  const root = mkdtempSync(join(tmpdir(), 'factoryos-backup-evidence-reader-'));
  const oldRoot = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
  const mountVerifier = { assertPathMountedReadOnly: jest.fn(async (_path: string) => undefined) };
  const reader = new BackupCopyClassEvidenceArtifactReader(mountVerifier as never);

  const writeArtifact = (reference: string, bytes: Buffer | string, mode = 0o444) => {
    const path = join(root, reference);
    writeFileSync(path, bytes, { mode });
    chmodSync(path, mode);
    return path;
  };
  const sealRoot = () => chmodSync(root, 0o555);

  beforeEach(() => {
    mountVerifier.assertPathMountedReadOnly.mockClear();
    chmodSync(root, 0o755);
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = root;
  });

  afterAll(() => {
    chmodSync(root, 0o755);
    if (oldRoot === undefined) delete process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
    else process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the exact source bytes and returns the actual digest and size', async () => {
    const bytes = Buffer.from('synthetic, immutable backup inventory evidence', 'utf8');
    const reference = 'evidence-pack-valid-v1';
    writeArtifact(reference, bytes);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    sealRoot();

    await expect(reader.verifyArtifact(reference, expectedDigest)).resolves.toEqual({
      reference, sha256: expectedDigest, sizeBytes: bytes.length,
    });
    await expect(reader.readVerifiedArtifact(reference, expectedDigest)).resolves.toEqual({
      reference, sha256: expectedDigest, sizeBytes: bytes.length, bytes,
    });
    expect(mountVerifier.assertPathMountedReadOnly).toHaveBeenNthCalledWith(1, root);
    expect(mountVerifier.assertPathMountedReadOnly).toHaveBeenNthCalledWith(2, join(root, reference));
  });

  it('rejects digest mismatch instead of accepting a caller-claimed digest', async () => {
    const reference = 'evidence-pack-wrong-digest-v1';
    writeArtifact(reference, 'the actual bytes differ');
    sealRoot();
    await expect(reader.verifyArtifact(reference, 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects path separators and traversal-like evidence references', async () => {
    sealRoot();
    for (const reference of ['../outside', 'folder/evidence', 'folder\\evidence', 'C:private', 'https://example.test/evidence']) {
      await expect(reader.verifyArtifact(reference, 'a'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('rejects symlinks and non-regular files', async () => {
    const source = writeArtifact('evidence-source-v1', 'immutable test bytes');
    symlinkSync(source, join(root, 'evidence-symlink-v1'));
    mkdirSync(join(root, 'evidence-directory-v1'));
    sealRoot();

    await expect(reader.verifyArtifact(
      'evidence-symlink-v1', createHash('sha256').update('immutable test bytes').digest('hex'),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(reader.verifyArtifact(
      'evidence-source-v1', createHash('sha256').update('immutable test bytes').digest('hex'),
    )).resolves.toMatchObject({ reference: 'evidence-source-v1' });
    await expect(reader.verifyArtifact('evidence-directory-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects writable roots and writable or multiply-linked evidence files', async () => {
    const bytes = Buffer.from('read-only evidence bytes', 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeArtifact('evidence-read-only-v1', bytes);
    await expect(reader.verifyArtifact('evidence-read-only-v1', digest))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    writeArtifact('evidence-writable-v1', bytes, 0o644);
    const hardlinkedPath = writeArtifact('evidence-hardlinked-v1', bytes);
    linkSync(hardlinkedPath, join(root, 'evidence-hardlink-alias-v1'));
    sealRoot();

    await expect(reader.verifyArtifact('evidence-read-only-v1', digest))
      .resolves.toMatchObject({ reference: 'evidence-read-only-v1', sha256: digest });
    await expect(reader.verifyArtifact('evidence-writable-v1', digest))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(reader.verifyArtifact('evidence-hardlinked-v1', digest))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed when the evidence root is missing or not configured', async () => {
    sealRoot();
    delete process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
    await expect(reader.verifyArtifact('evidence-pack-missing-root-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = join(root, 'does-not-exist');
    await expect(reader.verifyArtifact('evidence-pack-missing-root-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects oversized artifacts before reading their contents', async () => {
    const reference = 'evidence-pack-oversized-v1';
    const path = writeArtifact(reference, '', 0o600);
    truncateSync(path, 16 * 1024 * 1024 + 1);
    chmodSync(path, 0o444);
    sealRoot();
    await expect(reader.verifyArtifact(reference, 'a'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
  });
});
