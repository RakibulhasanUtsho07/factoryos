import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';

const SAFE_ARTIFACT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface VerifiedBackupCopyClassEvidenceArtifact {
  reference: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Reads an evidence artifact from a deployment-owned, read-only evidence directory.
 * References are opaque single file IDs, never URLs or paths. This intentionally
 * does not fetch caller-supplied URLs, so evidence validation cannot become an SSRF
 * primitive. Deployments must mount the evidence root read-only and keep writers
 * outside the API process.
 */
@Injectable()
export class BackupCopyClassEvidenceArtifactReader {
  async verifyArtifact(referenceValue: string, expectedDigestValue: string): Promise<VerifiedBackupCopyClassEvidenceArtifact> {
    if (typeof referenceValue !== 'string' || !SAFE_ARTIFACT_REFERENCE.test(referenceValue)) {
      throw new ConflictException('Backup copy-class evidence artifact reference is invalid or cannot be resolved');
    }
    if (typeof expectedDigestValue !== 'string' || !SHA256.test(expectedDigestValue)) {
      throw new ConflictException('Backup copy-class evidence artifact digest is invalid');
    }

    const configuredRoot = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR?.trim();
    if (!configuredRoot || !isAbsolute(configuredRoot)) {
      throw new ServiceUnavailableException(
        'Backup copy-class evidence read-back is disabled: an absolute deployment-owned evidence root is not configured',
      );
    }

    let root: string;
    try {
      const rootEntry = await lstat(configuredRoot);
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory() || (rootEntry.mode & 0o222) !== 0) {
        throw new Error('Evidence root must be a real, non-writable directory');
      }
      root = await realpath(configuredRoot);
      const resolvedRoot = await stat(root);
      if (!resolvedRoot.isDirectory() || (resolvedRoot.mode & 0o222) !== 0) {
        throw new Error('Resolved evidence root must not have write permission bits');
      }
    } catch {
      throw new ServiceUnavailableException('Backup copy-class evidence read-back root is unavailable or unsafe');
    }

    // Single opaque filename only: no URL, slash, backslash, drive prefix or traversal segment.
    const artifactPath = join(root, referenceValue);
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== 'number') {
      throw new ServiceUnavailableException('This runtime cannot securely open evidence artifacts without following links');
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(artifactPath, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_ARTIFACT_BYTES)
        || (before.mode & 0o222n) !== 0n || before.nlink !== 1n) {
        throw new Error('Evidence artifact must be a non-empty, non-writable regular file with one link within the configured size bound');
      }

      const hash = createHash('sha256');
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > MAX_ARTIFACT_BYTES) throw new Error('Evidence artifact exceeds the size bound');
        hash.update(buffer.subarray(0, bytesRead));
      }

      const after = await handle.stat({ bigint: true });
      const stable = before.dev === after.dev && before.ino === after.ino
        && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
        && before.mode === after.mode && before.nlink === after.nlink && BigInt(position) === before.size;
      if (!stable) throw new Error('Evidence artifact changed during verification');

      const actualDigest = hash.digest('hex');
      if (actualDigest !== expectedDigestValue) {
        throw new Error('Evidence artifact bytes do not match the claimed digest');
      }
      return { reference: referenceValue, sha256: actualDigest, sizeBytes: position };
    } catch {
      throw new ConflictException(
        'Backup copy-class evidence artifact is not a stable, readable regular file matching the claimed SHA-256 digest',
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
