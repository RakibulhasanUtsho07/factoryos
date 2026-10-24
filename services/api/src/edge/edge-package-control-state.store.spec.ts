import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  EdgePackageControlStateStore,
  EdgePackageControlStateStoreError,
  type DurableEdgePackageControlState,
} from './edge-package-control-state.store.js';

const ACTIVE: DurableEdgePackageControlState = {
  packageId: 'quality-defect',
  packageVersion: '1.2.0',
  useCaseId: 'inspection',
  status: 'ACTIVE',
  reason: null,
  checkedAt: '2026-10-12T12:00:00.000Z',
  lastErrorCode: null,
};
const REVOKED: DurableEdgePackageControlState = {
  ...ACTIVE,
  status: 'REVOKED',
  reason: 'Package revoked by operator',
};

describe('EdgePackageControlStateStore', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'factoryos-edge-control-state-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('persists state atomically and reloads the exact terminal revocation', async () => {
    const first = new EdgePackageControlStateStore(rootDir);
    await first.initialize();
    await first.save(ACTIVE);
    await first.save(REVOKED);

    const stateFile = join(rootDir, 'package-controls.json');
    const metadata = await stat(stateFile);
    expect(metadata.isFile()).toBe(true);
    expect((metadata.mode & 0o077)).toBe(0);

    const second = new EdgePackageControlStateStore(rootDir);
    await expect(second.initialize()).resolves.toEqual([REVOKED]);
    expect(second.get(REVOKED)).toEqual(REVOKED);
  });

  it('restores non-terminal controls as UNKNOWN while preserving terminal revocation across restart', async () => {
    const first = new EdgePackageControlStateStore(rootDir);
    await first.initialize();
    await first.save({ ...ACTIVE, packageId: 'quality-predictor' });
    await first.save({ ...ACTIVE, packageId: 'quality-alert', status: 'PAUSED' });
    await first.save(REVOKED);

    const restarted = new EdgePackageControlStateStore(rootDir);
    const restored = await restarted.initialize();

    expect(restored).toHaveLength(3);
    expect(restarted.get({ ...ACTIVE, packageId: 'quality-predictor' })).toMatchObject({
      status: 'UNKNOWN',
      lastErrorCode: 'RESTART_REQUIRES_FRESH_SYNC',
    });
    expect(restarted.get({ ...ACTIVE, packageId: 'quality-alert' })).toMatchObject({
      status: 'UNKNOWN',
      lastErrorCode: 'RESTART_REQUIRES_FRESH_SYNC',
    });
    expect(restarted.get(REVOKED)).toEqual(REVOKED);
  });

  it('serializes concurrent updates without dropping separate package scopes', async () => {
    const store = new EdgePackageControlStateStore(rootDir);
    await store.initialize();
    await Promise.all([
      store.save(ACTIVE),
      store.save({ ...ACTIVE, packageId: 'quality-alert', status: 'PAUSED' }),
    ]);

    const restarted = new EdgePackageControlStateStore(rootDir);
    await expect(restarted.initialize()).resolves.toHaveLength(2);
  });

  it('refuses a corrupt persisted state instead of resetting a possible revocation', async () => {
    await writeFile(join(rootDir, 'package-controls.json'), '{"schema_version":1,"controls":[{"status":"ACTIVE"}]}');
    const store = new EdgePackageControlStateStore(rootDir);
    await expect(store.initialize()).rejects.toMatchObject({
      code: 'CONTROL_STATE_CORRUPT',
    });
  });

  it('refuses a symlink in place of the state file', async () => {
    const externalPath = join(rootDir, 'outside.json');
    await writeFile(externalPath, JSON.stringify({ schema_version: 1, controls: [] }));
    await symlink(externalPath, join(rootDir, 'package-controls.json'));
    const store = new EdgePackageControlStateStore(rootDir);
    await expect(store.initialize()).rejects.toBeInstanceOf(EdgePackageControlStateStoreError);
  });

  it('does not allow a stored terminal revocation to be overwritten by ACTIVE', async () => {
    const store = new EdgePackageControlStateStore(rootDir);
    await store.initialize();
    await store.save(REVOKED);
    await expect(store.save(ACTIVE)).rejects.toMatchObject({
      code: 'CONTROL_STATE_CORRUPT',
    });
    expect(store.get(REVOKED)).toEqual(REVOKED);
  });

  it('retains removed revocations but prunes stale non-terminal entries for removed scopes', async () => {
    const store = new EdgePackageControlStateStore(rootDir);
    await store.initialize();
    await store.save(ACTIVE);
    await store.save(REVOKED);
    await store.save({ ...ACTIVE, packageId: 'quality-alert', status: 'PAUSED' });

    const restarted = new EdgePackageControlStateStore(rootDir);
    await expect(restarted.initialize([])).resolves.toEqual([REVOKED]);
  });

  it('does not allow use before initialization', async () => {
    const store = new EdgePackageControlStateStore(rootDir);
    expect(() => store.get(ACTIVE)).toThrow(EdgePackageControlStateStoreError);
    await expect(readFile(join(rootDir, 'package-controls.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
