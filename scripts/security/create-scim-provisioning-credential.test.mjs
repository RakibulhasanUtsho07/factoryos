import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createScimToken,
  hashScimToken,
  validatePreviousToken,
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
