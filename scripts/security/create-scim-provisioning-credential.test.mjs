import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createScimToken,
  hashScimToken,
  validatePreviousToken,
  writePrivateTokenFile,
} from './create-scim-provisioning-credential.mjs';

const tenant = '11111111-1111-4111-8111-111111111111';

test('SCIM tokens are tenant-bound and carry 256 bits of base64url secret material', () => {
  const token = createScimToken(tenant, 'A'.repeat(43));
  assert.equal(token, 'fos_scim_' + tenant + '.' + 'A'.repeat(43));
  assert.equal(hashScimToken(token).length, 64);
  assert.ok(validatePreviousToken(token, tenant));
  assert.equal(validatePreviousToken(token, '22222222-2222-4222-8222-222222222222'), false);
});

test('SCIM token hashes are deterministic without exposing the token', () => {
  const token = createScimToken(tenant, 'B'.repeat(43));
  assert.equal(hashScimToken(token), hashScimToken(token));
  assert.notEqual(hashScimToken(token), hashScimToken(createScimToken(tenant, 'C'.repeat(43))));
});

test('SCIM token construction rejects malformed tenant identifiers and secret material', () => {
  assert.throws(() => createScimToken('not-a-uuid', 'A'.repeat(43)));
  assert.throws(() => createScimToken(tenant, 'short'));
});


test('SCIM bearer token handoff is create-only and owner-private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-scim-token-'));
  await chmod(directory, 0o700);
  const output = join(directory, 'credential.json');
  try {
    const value = { schema: 'factoryos.scim-provisioning-credential/v1', bearer_token: 'sensitive-test-token' };
    await writePrivateTokenFile(output, value);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), value);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateTokenFile(output, { bearer_token: 'replacement' }), /already exists/);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), value);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SCIM bearer token handoff rejects group/world-accessible directories and relative paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-scim-token-mode-'));
  const output = join(directory, 'credential.json');
  try {
    await chmod(directory, 0o755);
    await assert.rejects(writePrivateTokenFile(output, { bearer_token: 'sensitive-test-token' }), /mode 0700/);
    await assert.rejects(writePrivateTokenFile('relative/credential.json', {}), /absolute path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
