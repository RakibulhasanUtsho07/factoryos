import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupCopyClassEvidenceArtifactReader } from './backup-copy-class-evidence-artifact-reader';

describe('BackupCopyClassEvidenceArtifactReader', () => {
  const root = mkdtempSync(join(tmpdir(), 'factoryos-backup-evidence-reader-'));
  const oldRoot = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
  const reader = new BackupCopyClassEvidenceArtifactReader();

  beforeEach(() => {
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = root;
  });

  afterAll(() => {
    if (oldRoot === undefined) delete process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
    else process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = oldRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the exact source bytes and returns the actual digest and size', async () => {
    const bytes = Buffer.from('synthetic, immutable backup inventory evidence', 'utf8');
    const reference = 'evidence-pack-valid-v1';
    writeFileSync(join(root, reference), bytes);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');

    await expect(reader.verifyArtifact(reference, expectedDigest)).resolves.toEqual({
      reference, sha256: expectedDigest, sizeBytes: bytes.length,
    });
  });

  it('rejects digest mismatch instead of accepting a caller-claimed digest', async () => {
    writeFileSync(join(root, 'evidence-pack-wrong-digest-v1'), 'the actual bytes differ');
    await expect(reader.verifyArtifact('evidence-pack-wrong-digest-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects path separators and traversal-like evidence references', async () => {
    for (const reference of ['../outside', 'folder/evidence', 'folder\\evidence', 'C:private', 'https://example.test/evidence']) {
      await expect(reader.verifyArtifact(reference, 'a'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('rejects symlinks and non-regular files', async () => {
    const source = join(root, 'evidence-source-v1');
    writeFileSync(source, 'immutable test bytes');
    symlinkSync(source, join(root, 'evidence-symlink-v1'));
    await expect(reader.verifyArtifact(
      'evidence-symlink-v1', createHash('sha256').update('immutable test bytes').digest('hex'),
    )).rejects.toBeInstanceOf(ConflictException);

    await expect(reader.verifyArtifact(
      'evidence-source-v1', createHash('sha256').update('immutable test bytes').digest('hex'),
    )).resolves.toMatchObject({ reference: 'evidence-source-v1' });

    mkdirSync(join(root, 'evidence-directory-v1'));
    await expect(reader.verifyArtifact('evidence-directory-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed when the evidence root is missing or not configured', async () => {
    delete process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
    await expect(reader.verifyArtifact('evidence-pack-missing-root-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR = join(root, 'does-not-exist');
    await expect(reader.verifyArtifact('evidence-pack-missing-root-v1', 'a'.repeat(64)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects oversized artifacts before reading their contents', async () => {
    const reference = 'evidence-pack-oversized-v1';
    writeFileSync(join(root, reference), '');
    truncateSync(join(root, reference), 16 * 1024 * 1024 + 1);
    await expect(reader.verifyArtifact(reference, 'a'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
  });
});
