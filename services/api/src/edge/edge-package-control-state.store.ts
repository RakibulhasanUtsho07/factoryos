import { randomUUID } from 'node:crypto';
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PACKAGE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const USE_CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const MAX_CONTROL_STATE_BYTES = 64 * 1024;
const MAX_CONTROL_STATE_RECORDS = 64;

export type PersistedPackageControlStatus = 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'UNKNOWN';

export interface DurableEdgePackageControlState {
  packageId: string;
  packageVersion: string;
  useCaseId: string | null;
  status: PersistedPackageControlStatus;
  reason: string | null;
  checkedAt: string | null;
  lastErrorCode: string | null;
}

export type EdgePackageControlStateErrorCode =
  | 'CONTROL_STATE_CORRUPT'
  | 'CONTROL_STATE_NOT_INITIALIZED';

export class EdgePackageControlStateStoreError extends Error {
  constructor(readonly code: EdgePackageControlStateErrorCode, message: string) {
    super(message);
    this.name = 'EdgePackageControlStateStoreError';
  }
}

function controlKey(value: Pick<DurableEdgePackageControlState, 'packageId' | 'packageVersion' | 'useCaseId'>): string {
  return JSON.stringify([value.packageId, value.packageVersion, value.useCaseId]);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return getErrorCode(error) === code;
}

function validState(value: unknown): value is DurableEdgePackageControlState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const allowedKeys = [
    'packageId', 'packageVersion', 'useCaseId', 'status', 'reason', 'checkedAt', 'lastErrorCode',
  ];
  return Object.keys(state).length === allowedKeys.length &&
    Object.keys(state).every((key) => allowedKeys.includes(key)) &&
    typeof state.packageId === 'string' && PACKAGE_ID_PATTERN.test(state.packageId) &&
    typeof state.packageVersion === 'string' && state.packageVersion.length <= 128 &&
    PACKAGE_VERSION_PATTERN.test(state.packageVersion) &&
    (state.useCaseId === null ||
      (typeof state.useCaseId === 'string' && USE_CASE_ID_PATTERN.test(state.useCaseId))) &&
    ['ACTIVE', 'PAUSED', 'REVOKED', 'UNKNOWN'].includes(String(state.status)) &&
    (state.reason === null || (typeof state.reason === 'string' && state.reason.length <= 300)) &&
    (state.checkedAt === null ||
      (typeof state.checkedAt === 'string' && Number.isFinite(Date.parse(state.checkedAt)))) &&
    (state.lastErrorCode === null ||
      (typeof state.lastErrorCode === 'string' && ERROR_CODE_PATTERN.test(state.lastErrorCode)));
}

export class EdgePackageControlStateStore {
  private readonly statePath: string;
  private readonly states = new Map<string, DurableEdgePackageControlState>();
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly rootDirectory: string) {
    if (typeof rootDirectory !== 'string' || rootDirectory.trim().length === 0) {
      throw new EdgePackageControlStateStoreError(
        'CONTROL_STATE_CORRUPT',
        'The edge package control state directory is required',
      );
    }
    this.statePath = join(rootDirectory, 'package-controls.json');
  }

  async initialize(
    managedScopes?: Array<Pick<DurableEdgePackageControlState, 'packageId' | 'packageVersion' | 'useCaseId'>>,
  ): Promise<DurableEdgePackageControlState[]> {
    if (this.initialized) return this.list();
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await this.assertDirectory(this.rootDirectory);

    let raw: string;
    try {
      const details = await lstat(this.statePath);
      if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_CONTROL_STATE_BYTES) {
        throw new EdgePackageControlStateStoreError(
          'CONTROL_STATE_CORRUPT',
          'Package control state must be a bounded regular file',
        );
      }
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      this.initialized = true;
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as { schema_version?: unknown; controls?: unknown };
      if (parsed.schema_version !== 1 || !Array.isArray(parsed.controls) ||
          parsed.controls.length > MAX_CONTROL_STATE_RECORDS || !parsed.controls.every(validState)) {
        throw new Error('Invalid package control state envelope');
      }
      for (const state of parsed.controls) {
        const key = controlKey(state);
        if (this.states.has(key)) throw new Error('Duplicate package control scope');
        // Only terminal revocations survive restart as authoritative decisions.
        // ACTIVE/PAUSED/UNKNOWN must wait for a fresh complete cloud poll.
        this.states.set(key, state.status === 'REVOKED'
          ? { ...state }
          : { ...state, status: 'UNKNOWN', lastErrorCode: 'RESTART_REQUIRES_FRESH_SYNC' });
      }
    } catch {
      this.states.clear();
      throw new EdgePackageControlStateStoreError(
        'CONTROL_STATE_CORRUPT',
        'Package control state failed integrity validation; execution remains blocked',
      );
    }
    let changed = this.states.size > 0;
    if (managedScopes !== undefined) {
      const retainedKeys = new Set(managedScopes.map((scope) => controlKey(scope)));
      for (const [key, state] of this.states) {
        // Keep terminal revocations for removed packages so re-adding a scope
        // cannot silently restore a locally revoked package.
        if (state.status !== 'REVOKED' && !retainedKeys.has(key)) {
          this.states.delete(key);
          changed = true;
        }
      }
    }
    if (changed) await this.writeAtomic();
    this.initialized = true;
    return this.list();
  }

  get(value: Pick<DurableEdgePackageControlState, 'packageId' | 'packageVersion' | 'useCaseId'>): DurableEdgePackageControlState | null {
    this.ensureInitialized();
    const state = this.states.get(controlKey(value));
    return state ? { ...state } : null;
  }

  list(): DurableEdgePackageControlState[] {
    this.ensureInitialized();
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  save(state: DurableEdgePackageControlState): Promise<void> {
    return this.withMutationLock(async () => {
      this.ensureInitialized();
      if (!validState(state)) {
        throw new EdgePackageControlStateStoreError(
          'CONTROL_STATE_CORRUPT',
          'Refusing to persist an invalid package control state',
        );
      }
      const existingState = this.states.get(controlKey(state));
      if (existingState?.status === 'REVOKED' && state.status !== 'REVOKED') {
        throw new EdgePackageControlStateStoreError(
          'CONTROL_STATE_CORRUPT',
          'A terminal package revocation cannot be overwritten',
        );
      }
      if (!existingState && this.states.size >= MAX_CONTROL_STATE_RECORDS) {
        throw new EdgePackageControlStateStoreError(
          'CONTROL_STATE_CORRUPT',
          'Package control state exceeds the configured safety bound',
        );
      }

      const key = controlKey(state);
      const previous = this.states.get(key);
      this.states.set(key, { ...state });
      try {
        await this.writeAtomic();
      } catch (error) {
        if (previous) this.states.set(key, previous);
        else this.states.delete(key);
        throw error;
      }
    });
  }

  private async writeAtomic(): Promise<void> {
    const temporaryPath = join(this.rootDirectory, `.package-controls-${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      try {
        const current = await lstat(this.statePath);
        if (!current.isFile() || current.isSymbolicLink() || current.size > MAX_CONTROL_STATE_BYTES) {
          throw new EdgePackageControlStateStoreError(
            'CONTROL_STATE_CORRUPT',
            'Package control state destination must be a bounded regular file',
          );
        }
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      }
      handle = await open(temporaryPath, 'wx', 0o600);
      const contents = JSON.stringify({
        schema_version: 1,
        controls: [...this.states.values()],
      });
      if (Buffer.byteLength(contents, 'utf8') > MAX_CONTROL_STATE_BYTES) {
        throw new EdgePackageControlStateStoreError(
          'CONTROL_STATE_CORRUPT',
          'Package control state exceeds its storage bound',
        );
      }
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.statePath);
      await this.syncDirectory();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async assertDirectory(directory: string): Promise<void> {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new EdgePackageControlStateStoreError(
        'CONTROL_STATE_CORRUPT',
        'Package control state directory must not be a symlink',
      );
    }
  }

  private async syncDirectory(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.rootDirectory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(
        getErrorCode(error) ?? '',
      )) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new EdgePackageControlStateStoreError(
        'CONTROL_STATE_NOT_INITIALIZED',
        'Initialize package control state before use',
      );
    }
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}
