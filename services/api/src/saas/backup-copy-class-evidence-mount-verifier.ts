import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function pathIsWithinMount(targetPath: string, mountPoint: string): boolean {
  if (mountPoint === '/') return targetPath.startsWith('/');
  const boundary = mountPoint.endsWith(sep) ? mountPoint : mountPoint + sep;
  return targetPath === mountPoint || targetPath.startsWith(boundary);
}

/**
 * Returns true only when the deepest mount covering targetPath is marked "ro"
 * in the per-mount VFS options (field 6 of Linux /proc/self/mountinfo).
 * Superblock options are deliberately not substituted for per-mount options:
 * a writable bind mount over a read-only parent must fail the gate.
 */
export function isPathOnReadOnlyLinuxMount(targetPathValue: string, mountInfo: string): boolean {
  if (!targetPathValue.startsWith('/')) return false;
  const targetPath = resolve(targetPathValue);
  const matches: Array<{ mountPoint: string; options: string[] }> = [];

  for (const line of mountInfo.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split(' ');
    const separatorIndex = fields.indexOf('-');
    // mountinfo: ID parent major:minor root mount-point mount-options ... - fs-type source super-options
    if (separatorIndex < 6 || fields.length < separatorIndex + 4) continue;
    if (!fields[4].startsWith('/')) continue;
    const mountPoint = resolve(decodeMountInfoPath(fields[4]));
    const options = fields[5].split(',');
    if (options.length === 0) continue;
    if (pathIsWithinMount(targetPath, mountPoint)) matches.push({ mountPoint, options });
  }

  if (!matches.length) return false;
  const deepestLength = Math.max(...matches.map((entry) => entry.mountPoint.length));
  const deepest = matches.filter((entry) => entry.mountPoint.length === deepestLength);
  // Duplicate mountpoints can represent stacked mounts. Be conservative and fail
  // if any equally-deep visible candidate is not explicitly read-only.
  return deepest.every((entry) => entry.options.includes('ro') && !entry.options.includes('rw'));
}

export interface BackupCopyEvidenceMountVerifier {
  assertPathMountedReadOnly(path: string): Promise<void>;
}

@Injectable()
export class LinuxReadOnlyEvidenceMountVerifier implements BackupCopyEvidenceMountVerifier {
  async assertPathMountedReadOnly(path: string): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('Backup evidence read-back requires Linux mount metadata; refusing to infer read-only state on this platform');
    }
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
    if (!isPathOnReadOnlyLinuxMount(path, mountInfo)) {
      throw new Error('Backup evidence path is not covered by a read-only mount for this API process');
    }
  }
}
