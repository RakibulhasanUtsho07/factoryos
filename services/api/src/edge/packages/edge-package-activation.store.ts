import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  lstat,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  EdgePackageVerificationError,
  edgePackageSigningPayload,
  verifyEdgePackage,
  type EdgePackageVerificationPolicy,
  type SignedEdgePackageInput,
  type VerifiedEdgePackage,
} from './edge-package-manifest-verifier.js';

const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type EdgePackageActivationErrorCode =
  | 'NO_ACTIVE_RELEASE'
  | 'NO_ROLLBACK_TARGET'
  | 'ROLLBACK_TARGET_MISMATCH'
  | 'RELEASE_VERSION_CONFLICT'
  | 'RELEASE_STORE_CORRUPT'
  | 'INVALID_PACKAGE_ID';

export class EdgePackageActivationError extends Error {
  constructor(
    readonly code: EdgePackageActivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EdgePackageActivationError';
  }
}

export interface EdgePackageReleaseRef {
  version: string;
  manifestSha256: string;
}

export interface EdgePackageActivationState {
  schemaVersion: 1;
  packageId: string;
  active: EdgePackageReleaseRef;
  previous: EdgePackageReleaseRef | null;
  activatedAt: string;
}

export interface EdgePackageActivationResult {
  activated: boolean;
  idempotent: boolean;
  state: EdgePackageActivationState;
  manifestSha256: string;
  artifactBytes: number;
}

/**
 * Filesystem activation store for a single edge-agent writer.
 *
 * All package files are staged in a private temporary directory and moved into
 * an immutable, content-addressed release directory. The active pointer is
 * replaced by a same-directory rename so readers see the old or new pointer,
 * never a partially written document. Hosts must keep this store on a local
 * filesystem with atomic same-volume rename semantics and a single writer.
 */
export class EdgePackageActivationStore {
  private readonly rootDirectory: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string, private readonly clock: () => Date = () => new Date()) {
    if (typeof rootDirectory !== 'string' || rootDirectory.trim().length === 0) {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'The edge package store directory is required',
      );
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  async activate(
    input: SignedEdgePackageInput,
    policy: EdgePackageVerificationPolicy,
  ): Promise<EdgePackageActivationResult> {
    const verified = verifyEdgePackage(input, policy);
    const packageId = verified.manifest.packageId;

    return this.withPackageLock(packageId, async () => {
      const priorState = await this.readState(packageId);
      if (
        priorState?.active.version === verified.manifest.version &&
        priorState.active.manifestSha256 === verified.manifestSha256
      ) {
        await this.loadVerifiedRelease(packageId, priorState.active, policy);
        return {
          activated: false,
          idempotent: true,
          state: priorState,
          manifestSha256: verified.manifestSha256,
          artifactBytes: verified.artifactBytes,
        };
      }

      if (priorState?.active.version === verified.manifest.version) {
        throw new EdgePackageActivationError(
          'RELEASE_VERSION_CONFLICT',
          'A different manifest is already active for this package version',
        );
      }

      if (
        priorState !== null &&
        verified.manifest.rollback.enabled &&
        verified.manifest.rollback.targetVersion !== priorState.active.version
      ) {
        throw new EdgePackageActivationError(
          'ROLLBACK_TARGET_MISMATCH',
          'The package rollback target must match the currently active version',
        );
      }

      await this.persistVerifiedRelease(input, verified, policy);
      const now = this.clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new EdgePackageActivationError(
          'RELEASE_STORE_CORRUPT',
          'The activation clock is invalid',
        );
      }

      const state: EdgePackageActivationState = {
        schemaVersion: 1,
        packageId,
        active: {
          version: verified.manifest.version,
          manifestSha256: verified.manifestSha256,
        },
        previous: priorState?.active ?? null,
        activatedAt: now.toISOString(),
      };
      await this.writeStateAtomically(state);

      return {
        activated: true,
        idempotent: false,
        state,
        manifestSha256: verified.manifestSha256,
        artifactBytes: verified.artifactBytes,
      };
    });
  }

  async rollback(
    packageId: string,
    policy: EdgePackageVerificationPolicy,
  ): Promise<EdgePackageActivationState> {
    this.assertPackageId(packageId);
    return this.withPackageLock(packageId, async () => {
      const current = await this.readState(packageId);
      if (current === null) {
        throw new EdgePackageActivationError(
          'NO_ACTIVE_RELEASE',
          'There is no active edge package release to roll back',
        );
      }
      if (current.previous === null) {
        throw new EdgePackageActivationError(
          'NO_ROLLBACK_TARGET',
          'There is no persisted previous release to restore',
        );
      }

      const activeRelease = await this.loadVerifiedRelease(packageId, current.active, policy);
      const targetRelease = await this.loadVerifiedRelease(packageId, current.previous, policy);
      if (
        activeRelease.manifest.rollback.enabled !== true ||
        activeRelease.manifest.rollback.targetVersion !== targetRelease.manifest.version ||
        targetRelease.manifest.packageId !== packageId
      ) {
        throw new EdgePackageActivationError(
          'ROLLBACK_TARGET_MISMATCH',
          'The signed active manifest does not authorize the persisted rollback target',
        );
      }

      const now = this.clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new EdgePackageActivationError(
          'RELEASE_STORE_CORRUPT',
          'The activation clock is invalid',
        );
      }
      const state: EdgePackageActivationState = {
        schemaVersion: 1,
        packageId,
        active: current.previous,
        previous: current.active,
        activatedAt: now.toISOString(),
      };
      await this.writeStateAtomically(state);
      return state;
    });
  }

  async getState(packageId: string): Promise<EdgePackageActivationState | null> {
    this.assertPackageId(packageId);
    return this.withPackageLock(packageId, () => this.readState(packageId));
  }

  private async persistVerifiedRelease(
    input: SignedEdgePackageInput,
    verified: VerifiedEdgePackage,
    policy: EdgePackageVerificationPolicy,
  ): Promise<void> {
    const packageDirectory = this.packageDirectory(verified.manifest.packageId);
    const releasesDirectory = join(packageDirectory, 'releases');
    await mkdir(releasesDirectory, { recursive: true, mode: 0o700 });

    const destination = this.releaseDirectory(verified.manifest.packageId, verified.manifestSha256);
    try {
      const existing = await lstat(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new EdgePackageActivationError(
          'RELEASE_STORE_CORRUPT',
          'The content-addressed release path is not a directory',
        );
      }
      await this.loadVerifiedRelease(
        verified.manifest.packageId,
        { version: verified.manifest.version, manifestSha256: verified.manifestSha256 },
        policy,
      );
      return;
    } catch (error) {
      if (error instanceof EdgePackageActivationError || error instanceof EdgePackageVerificationError) {
        throw error;
      }
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }

    const stagingDirectory = await mkdtemp(join(releasesDirectory, '.staging-'));
    try {
      for (const descriptor of verified.manifest.artifacts) {
        const artifactBytes = input.artifacts[descriptor.path];
        if (!(artifactBytes instanceof Uint8Array)) {
          throw new EdgePackageVerificationError(
            'ARTIFACT_MISMATCH',
            'A verified package artifact is missing from the supplied input',
          );
        }
        const destinationPath = join(stagingDirectory, ...descriptor.path.split('/'));
        await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
        await writeFileDurably(destinationPath, Buffer.from(artifactBytes));
      }
      await writeFileDurably(
        join(stagingDirectory, 'manifest.json'),
        Buffer.from(JSON.stringify(verified.manifest), 'utf8'),
      );
      await writeFileDurably(
        join(stagingDirectory, 'signature.ed25519'),
        Buffer.from(input.signature, 'utf8'),
      );
      await writeFileDurably(
        join(stagingDirectory, 'release.json'),
        Buffer.from(JSON.stringify({
          schemaVersion: 1,
          packageId: verified.manifest.packageId,
          version: verified.manifest.version,
          manifestSha256: verified.manifestSha256,
          artifactBytes: verified.artifactBytes,
        }), 'utf8'),
      );
      await rename(stagingDirectory, destination);
      await syncDirectory(releasesDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY')) {
        const existing = await this.readReleaseFiles(
          verified.manifest.packageId,
          verified.manifestSha256,
        );
        const existingVerification = verifyEdgePackage(existing, policy);
        if (existingVerification.manifestSha256 === verified.manifestSha256) return;
      }
      throw error;
    }
  }

  private async loadVerifiedRelease(
    packageId: string,
    ref: EdgePackageReleaseRef,
    policy: EdgePackageVerificationPolicy,
  ): Promise<VerifiedEdgePackage> {
    const input = await this.readReleaseFiles(packageId, ref.manifestSha256);
    const verified = verifyEdgePackage(input, policy);
    if (
      verified.manifest.packageId !== packageId ||
      verified.manifest.version !== ref.version ||
      verified.manifestSha256 !== ref.manifestSha256
    ) {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'Persisted release metadata does not match its activation reference',
      );
    }
    const releaseMetadataPath = join(
      this.releaseDirectory(packageId, ref.manifestSha256),
      'release.json',
    );
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(releaseMetadataPath, 'utf8')) as unknown;
    } catch {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'Persisted release metadata is unreadable',
      );
    }
    if (
      !isPlainRecord(metadata) ||
      metadata.schemaVersion !== 1 ||
      metadata.packageId !== packageId ||
      metadata.version !== ref.version ||
      metadata.manifestSha256 !== ref.manifestSha256 ||
      metadata.artifactBytes !== verified.artifactBytes
    ) {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'Persisted release metadata failed integrity validation',
      );
    }
    return verified;
  }

  private async readReleaseFiles(
    packageId: string,
    manifestSha256: string,
  ): Promise<SignedEdgePackageInput> {
    this.assertPackageId(packageId);
    if (!SHA256_PATTERN.test(manifestSha256)) {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'The persisted manifest digest is invalid',
      );
    }
    const directory = this.releaseDirectory(packageId, manifestSha256);
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as unknown;
      const signature = await readFile(join(directory, 'signature.ed25519'), 'utf8');
      if (!isPlainRecord(manifest) || !Array.isArray(manifest.artifacts)) {
        throw new EdgePackageActivationError(
          'RELEASE_STORE_CORRUPT',
          'The persisted package manifest is malformed',
        );
      }
      // Validate every persisted path and reject unknown fields before reading any artifact file.
      edgePackageSigningPayload(manifest);
      const artifacts: Record<string, Uint8Array> = {};
      for (const value of manifest.artifacts) {
        if (!isPlainRecord(value) || typeof value.path !== 'string') {
          throw new EdgePackageActivationError(
            'RELEASE_STORE_CORRUPT',
            'A persisted artifact descriptor is malformed',
          );
        }
        Object.defineProperty(artifacts, value.path, {
          value: await readFile(join(directory, ...value.path.split('/'))),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return { manifest, signature, artifacts };
    } catch (error) {
      if (error instanceof EdgePackageActivationError || error instanceof EdgePackageVerificationError) {
        throw error;
      }
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'Persisted package files are missing or unreadable',
      );
    }
  }

  private async readState(packageId: string): Promise<EdgePackageActivationState | null> {
    const statePath = this.statePath(packageId);
    let raw: string;
    try {
      raw = await readFile(statePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'The persisted activation state is unreadable',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'The persisted activation state is malformed',
      );
    }
    if (
      !isPlainRecord(value) ||
      value.schemaVersion !== 1 ||
      value.packageId !== packageId ||
      !isReleaseRef(value.active) ||
      !(value.previous === null || isReleaseRef(value.previous)) ||
      typeof value.activatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.activatedAt))
    ) {
      throw new EdgePackageActivationError(
        'RELEASE_STORE_CORRUPT',
        'The persisted activation state failed validation',
      );
    }
    return value as unknown as EdgePackageActivationState;
  }

  private async writeStateAtomically(state: EdgePackageActivationState): Promise<void> {
    const directory = join(this.packageDirectory(state.packageId), 'state');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.statePath(state.packageId);
    const temporary = join(directory, '.' + state.packageId + '.' + randomUUID() + '.tmp');
    try {
      await writeFileDurably(temporary, Buffer.from(JSON.stringify(state), 'utf8'));
      await rename(temporary, target);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private packageDirectory(packageId: string): string {
    return join(this.rootDirectory, packageId);
  }

  private releaseDirectory(packageId: string, manifestSha256: string): string {
    return join(this.packageDirectory(packageId), 'releases', manifestSha256);
  }

  private statePath(packageId: string): string {
    return join(this.packageDirectory(packageId), 'state', 'active.json');
  }

  private assertPackageId(packageId: string): void {
    if (typeof packageId !== 'string' || !PACKAGE_ID_PATTERN.test(packageId)) {
      throw new EdgePackageActivationError(
        'INVALID_PACKAGE_ID',
        'The edge package identifier is invalid',
      );
    }
  }

  private async withPackageLock<T>(
    packageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertPackageId(packageId);
    const previous = this.locks.get(packageId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(packageId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(packageId) === tail) this.locks.delete(packageId);
    }
  }
}

async function writeFileDurably(path: string, contents: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isReleaseRef(value: unknown): value is EdgePackageReleaseRef {
  return isPlainRecord(value) &&
    typeof value.version === 'string' && SEMVER_PATTERN.test(value.version) &&
    typeof value.manifestSha256 === 'string' && SHA256_PATTERN.test(value.manifestSha256);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}
