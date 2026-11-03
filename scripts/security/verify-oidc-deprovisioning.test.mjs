import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';

import { runDeprovisionProbe, verifySignedOidcToken } from './verify-oidc-deprovisioning.mjs';

const issuer = 'https://idp.example.test/tenant';
const audience = 'factoryos-api';
const jwksUri = 'https://idp.example.test/tenant/.well-known/jwks.json';
const targetTenantId = '11111111-1111-4111-8111-111111111111';
const siblingTenantId = '22222222-2222-4222-8222-222222222222';
const candidateSha = 'a'.repeat(40);
const nowMs = Date.parse('2026-11-03T10:00:00.000Z');

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const publicJwk = createPublicKey(publicKey).export({ format: 'jwk' });
publicJwk.kid = 'test-kid';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function makeToken(overrides = {}, signer = privateKey) {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' });
  const claims = b64({
    iss: issuer,
    aud: audience,
    sub: 'idp-subject-123',
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + 30 * 60 * 1000) / 1000),
    amr: ['pwd', 'otp'],
    ...overrides,
  });
  const signingContent = header + '.' + claims;
  return signingContent + '.' + sign('RSA-SHA256', Buffer.from(signingContent), signer).toString('base64url');
}
const oidc = () => ({ issuer, audience, jwksUri, mfaAmrValues: 'otp,hwk', mfaAcrValues: '' });
const jwksFetch = () => async (url, options) => {
  assert.equal(url, jwksUri);
  assert.equal(options.redirect, 'error');
  return { status: 200, headers: { get: () => '200' }, text: async () => JSON.stringify({ keys: [publicJwk] }) };
};

nodeTest('verifies an IdP-signed RS256 token, JWKS kid, audience and configured MFA assurance', async () => {
  const evidence = await verifySignedOidcToken(makeToken(), oidc(), { now: () => nowMs, fetchImpl: jwksFetch() });
  assert.equal(evidence.mfaVerified, true);
  assert.equal(evidence.mfaMechanism, 'amr');
  assert.equal(evidence.keyId, 'test-kid');
  assert.equal(evidence.issuer, issuer);
  assert.equal(evidence.audience, audience);
  assert.equal(evidence.subjectSha256.length, 64);
  assert.equal(evidence.tokenSha256.length, 64);
  assert.equal('subject' in evidence, false);
});

nodeTest('fails closed on invalid signature, issuer, audience, expiry and missing MFA', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifySignedOidcToken(makeToken({}, other.privateKey), oidc(), {
    now: () => nowMs, fetchImpl: jwksFetch(),
  }), /signature verification failed/);
  await assert.rejects(verifySignedOidcToken(makeToken({ iss: 'https://evil.example.test' }), oidc(), {
    now: () => nowMs, fetchImpl: jwksFetch(),
  }), /issuer does not match/);
  await assert.rejects(verifySignedOidcToken(makeToken({ aud: 'other-api' }), oidc(), {
    now: () => nowMs, fetchImpl: jwksFetch(),
  }), /audience/);
  await assert.rejects(verifySignedOidcToken(makeToken({ exp: Math.floor(nowMs / 1000) - 300 }), oidc(), {
    now: () => nowMs, fetchImpl: jwksFetch(),
  }), /expired/);
  await assert.rejects(verifySignedOidcToken(makeToken({ amr: ['pwd'], acr: 'urn:loa:1' }), oidc(), {
    now: () => nowMs, fetchImpl: jwksFetch(),
  }), /MFA assurance/);
});

nodeTest('requires HTTPS JWKS and rejects missing signing keys', async () => {
  await assert.rejects(verifySignedOidcToken(makeToken(), { ...oidc(), jwksUri: 'http://idp.example.test/jwks' }, {
    now: () => nowMs, fetchImpl: jwksFetch(),
  }), /credential-free HTTPS/);
  await assert.rejects(verifySignedOidcToken(makeToken(), oidc(), {
    now: () => nowMs,
    fetchImpl: async () => ({ status: 200, headers: { get: () => '0' }, text: async () => '{"keys":[]}' }),
  }), /signing key is missing/);
});

nodeTest('before/after rehearsal proves tenant-scoped revocation with the original still-valid token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-as133-'));
  await chmod(directory, 0o700);
  const beforePath = join(directory, 'before.json');
  const afterPath = join(directory, 'after.json');
  const token = makeToken();
  let targetRevoked = false;
  const apiRequest = async (tenant, suppliedToken) => {
    assert.equal(suppliedToken, token);
    if (tenant === targetTenantId && targetRevoked) return { status: 401, payload: null };
    return {
      status: 200,
      payload: { data: { authenticated: true, user: {
        userId: '33333333-3333-4333-8333-333333333333',
        tenantId: tenant,
        membershipId: tenant === targetTenantId ? '44444444-4444-4444-8444-444444444444' : '55555555-5555-4555-8555-555555555555',
      } } },
    };
  };
  const common = {
    candidateSha, targetTenantId, siblingTenantId, token,
    apiOrigin: 'https://staging.factoryos.example.test',
    oidc: oidc(), now: () => nowMs, jwksFetchImpl: jwksFetch(), apiRequest,
  };
  try {
    const before = await runDeprovisionProbe({ ...common, phase: 'before', outputPath: beforePath });
    assert.equal(before.result, 'BASELINE_CAPTURED');
    const baseline = JSON.parse(await readFile(beforePath, 'utf8'));
    assert.equal(baseline.rawBearerTokenStored, false);
    assert.equal(JSON.stringify(baseline).includes(token), false);

    targetRevoked = true;
    const after = await runDeprovisionProbe({
      ...common,
      phase: 'after',
      baselinePath: beforePath,
      outputPath: afterPath,
      eventReference: 'idp-audit/ref-12345',
      deprovisionedAtUtc: new Date(nowMs + 1000).toISOString(),
      maxLatencySeconds: 60,
      now: () => nowMs + 2000,
    });
    assert.equal(after.result, 'DEPROVISION_VERIFIED');
    const evidence = JSON.parse(await readFile(afterPath, 'utf8'));
    assert.equal(evidence.targetTenantStatus, 'UNAUTHORIZED_401_WITH_ORIGINAL_UNEXPIRED_SIGNED_TOKEN');
    assert.equal(evidence.siblingTenantStatus, 'AUTHORIZED_200');
    assert.equal(evidence.siblingUserIdentityPreserved, true);
    assert.equal(evidence.rawBearerTokenStored, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

nodeTest('rejects an IdP event before the baseline, insufficient token lifetime and evidence overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-as133-negative-'));
  await chmod(directory, 0o700);
  const beforePath = join(directory, 'before.json');
  const afterPath = join(directory, 'after.json');
  const token = makeToken();
  const apiRequest = async (tenant) => ({
    status: 200,
    payload: { data: { authenticated: true, user: { userId: 'u-1', tenantId: tenant } } },
  });
  const common = {
    candidateSha, targetTenantId, siblingTenantId, token,
    apiOrigin: 'https://staging.factoryos.example.test',
    oidc: oidc(), now: () => nowMs, jwksFetchImpl: jwksFetch(), apiRequest,
  };
  try {
    await runDeprovisionProbe({ ...common, phase: 'before', outputPath: beforePath });
    await assert.rejects(runDeprovisionProbe({
      ...common, phase: 'after', baselinePath: beforePath, outputPath: afterPath,
      eventReference: 'idp-audit/ref-1',
      deprovisionedAtUtc: new Date(nowMs - 1000).toISOString(),
      maxLatencySeconds: 10,
    }), /after the authenticated baseline/);
    await assert.rejects(runDeprovisionProbe({
      ...common, phase: 'after', baselinePath: beforePath, outputPath: afterPath,
      eventReference: 'idp-audit/ref-1',
      deprovisionedAtUtc: new Date(nowMs + 1000).toISOString(),
      maxLatencySeconds: 3600,
      now: () => nowMs + 2000,
    }), /remain valid beyond/);
    await assert.rejects(runDeprovisionProbe({ ...common, phase: 'before', outputPath: beforePath }), /already exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
