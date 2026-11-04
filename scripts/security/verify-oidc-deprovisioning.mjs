#!/usr/bin/env node
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  readFile,
  stat,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_SHA = /^[a-f0-9]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_JWKS_BYTES = 256 * 1024;
const SCIM_PROBE_PATH = '/api/auth/me';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function decodeJsonSegment(segment, label) {
  if (!BASE64URL.test(segment)) throw new Error('OIDC token has an invalid ' + label + ' segment');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); }
  catch { throw new Error('OIDC token has an invalid ' + label + ' JSON document'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OIDC token ' + label + ' must be a JSON object');
  }
  return parsed;
}

function requireHttpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(name + ' must be a valid absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(name + ' must be credential-free HTTPS');
  }
  return url;
}

function csvSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function satisfiesMfa(claims, amrValues, acrValues) {
  const amr = Array.isArray(claims.amr) ? claims.amr.filter((value) => typeof value === 'string') : [];
  const acr = typeof claims.acr === 'string' ? claims.acr : null;
  const byAmr = amr.some((value) => amrValues.has(value));
  const byAcr = acr !== null && acrValues.has(acr);
  return { accepted: byAmr || byAcr, mechanism: byAmr ? 'amr' : byAcr ? 'acr' : null };
}

async function readLimitedJson(response, maximumBytes) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maximumBytes) throw new Error('OIDC JWKS response exceeds the size limit');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error('OIDC JWKS response exceeds the size limit');
  try { return JSON.parse(text); } catch { throw new Error('OIDC JWKS endpoint did not return valid JSON'); }
}

/** Cryptographically verify the real signed IdP token and the configured MFA assurance. */
export async function verifySignedOidcToken(token, config, options = {}) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 32 * 1024) {
    throw new Error('OIDC bearer token is missing or outside the accepted size range');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OIDC bearer token must have three JWT segments');

  const header = decodeJsonSegment(parts[0], 'header');
  const claims = decodeJsonSegment(parts[1], 'claims');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
    throw new Error('OIDC token must use RS256 and include a key id');
  }

  const issuerUrl = requireHttpsUrl(config.issuer, 'OIDC_ISSUER');
  const jwksUrl = requireHttpsUrl(config.jwksUri, 'OIDC_JWKS_URI');
  if (typeof config.audience !== 'string' || !config.audience.trim()) throw new Error('OIDC_AUDIENCE is required');
  if (claims.iss !== config.issuer) throw new Error('OIDC token issuer does not match the configured issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.audience)) throw new Error('OIDC token audience does not contain the configured audience');

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const skewSeconds = Number.isInteger(config.clockSkewSeconds) ? config.clockSkewSeconds : 30;
  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds - skewSeconds) {
    throw new Error('OIDC token is expired or has no valid exp claim');
  }
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + skewSeconds)) {
    throw new Error('OIDC token is not yet valid');
  }
  if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + skewSeconds)) {
    throw new Error('OIDC token has an invalid future iat claim');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 255) {
    throw new Error('OIDC token has an invalid subject');
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(jwksUrl.href, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: options.signal || AbortSignal.timeout(5000),
  });
  if (!response || response.status !== 200) throw new Error('OIDC JWKS endpoint did not return HTTP 200');

  const jwks = await readLimitedJson(response, MAX_JWKS_BYTES);
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length > 100) {
    throw new Error('OIDC JWKS response has an invalid or oversized keys collection');
  }
  const jwk = jwks.keys.find((key) => key && key.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig') ||
      (jwk.alg && jwk.alg !== 'RS256') || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('OIDC signing key is missing or is not an allowed RS256 RSA key');
  }

  let publicKey;
  try {
    const { kid: _kid, alg: _alg, use: _use, ...publicJwk } = jwk;
    publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
  } catch { throw new Error('OIDC signing JWK is malformed'); }

  const signedContent = parts[0] + '.' + parts[1];
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifySignature('RSA-SHA256', Buffer.from(signedContent), publicKey, signature)) {
    throw new Error('OIDC token signature verification failed');
  }

  const amrValues = csvSet(config.mfaAmrValues);
  const acrValues = csvSet(config.mfaAcrValues);
  if (amrValues.size === 0 && acrValues.size === 0) {
    throw new Error('An owner-reviewed OIDC MFA AMR or ACR allowlist is required');
  }
  const mfa = satisfiesMfa(claims, amrValues, acrValues);
  if (!mfa.accepted) throw new Error('OIDC token does not satisfy the configured MFA assurance policy');

  return {
    tokenSha256: sha256(token),
    subjectSha256: sha256(claims.sub),
    issuer: claims.iss,
    audience: config.audience,
    keyId: header.kid,
    expiresAtUtc: new Date(claims.exp * 1000).toISOString(),
    issuedAtUtc: Number.isFinite(claims.iat) ? new Date(claims.iat * 1000).toISOString() : null,
    mfaVerified: true,
    mfaMechanism: mfa.mechanism,
    issuerHost: issuerUrl.host,
    jwksHost: jwksUrl.host,
  };
}

async function assertPrivateDirectory(path) {
  const directory = await stat(path);
  if (!directory.isDirectory()) throw new Error('Evidence parent path must be a directory');
  if (typeof process.getuid === 'function' && directory.uid !== process.getuid()) {
    throw new Error('Evidence parent directory must be owned by the current runner identity');
  }
  if ((directory.mode & 0o022) !== 0) throw new Error('Evidence parent directory must not be group/world writable');
}

async function readPrivateJson(path) {
  const absolutePath = resolve(path);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Evidence input must be a regular non-symlink file');
  if ((info.mode & 0o077) !== 0) throw new Error('Evidence input file permissions must be 0600 or stricter');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Evidence input must be owned by the current runner identity');
  }
  let parsed;
  try { parsed = JSON.parse(await readFile(absolutePath, 'utf8')); }
  catch { throw new Error('Evidence input is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Evidence input must be a JSON object');
  return parsed;
}

async function writeCreateOnlyJson(path, value) {
  const absolutePath = resolve(path);
  if (!path || !path.startsWith('/')) throw new Error('Evidence output path must be absolute');
  await assertPrivateDirectory(dirname(absolutePath));
  let handle;
  try {
    handle = await open(absolutePath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Evidence output already exists; refusing to overwrite');
    throw error;
  } finally { await handle?.close(); }
  await chmod(absolutePath, 0o600);
  return absolutePath;
}

function requireUtc(value, name, nowMs) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(name + ' must be an explicit UTC timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(name + ' is not a valid UTC timestamp');
  }
  if (milliseconds > nowMs) throw new Error(name + ' cannot be in the future');
  return milliseconds;
}

function assertSafeEventReference(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 300 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]+$/.test(value) ||
      /(?:password|secret|credential|token)\s*[:=]/i.test(value)) {
    throw new Error('SCIM_DEPROVISION_EVENT_REFERENCE must be a sanitized opaque reference');
  }
  return value;
}

async function defaultApiRequest(apiOrigin, tenantId, token, fetchImpl) {
  const url = new URL(SCIM_PROBE_PATH, apiOrigin);
  const response = await fetchImpl(url.href, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + token, 'x-tenant-id': tenantId, accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  let payload = null;
  if (response.status === 200) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Staging /auth/me response exceeds the size limit');
    try { payload = JSON.parse(text); } catch { throw new Error('Staging /auth/me did not return JSON'); }
  }
  return { status: response.status, payload };
}

function extractAuthenticatedUser(payload) {
  let current = payload;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if (current.authenticated === true && current.user &&
        typeof current.user.userId === 'string' && typeof current.user.tenantId === 'string') return current.user;
    if (current.data && typeof current.data === 'object') current = current.data;
    else break;
  }
  return null;
}

async function requireAuthorizedProbe(apiRequest, tenantId, token, expectedUserIdHash = null) {
  const result = await apiRequest(tenantId, token);
  if (result.status !== 200) throw new Error('Staging /api/auth/me did not authenticate the baseline/sibling tenant');
  const user = extractAuthenticatedUser(result.payload);
  if (!user || user.tenantId !== tenantId) throw new Error('Staging /api/auth/me did not return the expected verified tenant identity');
  const userIdHash = sha256(user.userId);
  if (expectedUserIdHash && userIdHash !== expectedUserIdHash) {
    throw new Error('Staging /api/auth/me returned a different FactoryOS user identity');
  }
  return { userIdHash };
}

export async function runDeprovisionProbe(input) {
  const now = input.now || (() => Date.now());
  const nowMs = now();
  const candidateSha = input.candidateSha;
  const targetTenantId = input.targetTenantId;
  const siblingTenantId = input.siblingTenantId;
  const phase = input.phase;
  const token = input.token;

  if (!GIT_SHA.test(candidateSha || '')) throw new Error('CANDIDATE_SHA must be a full 40-character commit SHA');
  if (!UUID.test(targetTenantId || '') || !UUID.test(siblingTenantId || '') ||
      targetTenantId.toLowerCase() === siblingTenantId.toLowerCase()) {
    throw new Error('Target and sibling tenant IDs must be different valid UUIDs');
  }
  if (phase !== 'before' && phase !== 'after') throw new Error('PHASE must be before or after');
  if (!input.outputPath || !input.outputPath.startsWith('/')) throw new Error('Evidence output path must be absolute');

  const apiUrl = requireHttpsUrl(input.apiOrigin, 'FACTORYOS_STAGING_API_ORIGIN');
  if (apiUrl.pathname !== '/' || apiUrl.search || apiUrl.hash) {
    throw new Error('FACTORYOS_STAGING_API_ORIGIN must contain only an HTTPS origin');
  }
  const verified = await verifySignedOidcToken(token, input.oidc, {
    now,
    fetchImpl: input.jwksFetchImpl,
  });
  const apiRequest = input.apiRequest || ((tenant, bearer) =>
    defaultApiRequest(apiUrl.origin, tenant, bearer, input.apiFetchImpl || globalThis.fetch));

  if (phase === 'before') {
    const target = await requireAuthorizedProbe(apiRequest, targetTenantId, token);
    await requireAuthorizedProbe(apiRequest, siblingTenantId, token, target.userIdHash);
    const baseline = {
      schema: 'factoryos.as133.oidc-deprovision-baseline/v1',
      candidateSha,
      recordedAtUtc: new Date(nowMs).toISOString(),
      tokenSha256: verified.tokenSha256,
      subjectSha256: verified.subjectSha256,
      issuer: verified.issuer,
      audience: verified.audience,
      keyId: verified.keyId,
      expiresAtUtc: verified.expiresAtUtc,
      mfaVerified: verified.mfaVerified,
      mfaMechanism: verified.mfaMechanism,
      targetTenantSha256: sha256(targetTenantId.toLowerCase()),
      siblingTenantSha256: sha256(siblingTenantId.toLowerCase()),
      factoryOsUserIdSha256: target.userIdHash,
      targetBaseline: 'AUTHENTICATED',
      siblingBaseline: 'AUTHENTICATED',
      rawBearerTokenStored: false,
    };
    await writeCreateOnlyJson(input.outputPath, baseline);
    return { phase, result: 'BASELINE_CAPTURED', tokenSha256: verified.tokenSha256, outputPath: resolve(input.outputPath) };
  }

  const baseline = await readPrivateJson(input.baselinePath);
  if (baseline.schema !== 'factoryos.as133.oidc-deprovision-baseline/v1') throw new Error('Unsupported OIDC deprovision baseline schema');
  if (baseline.candidateSha !== candidateSha || baseline.tokenSha256 !== verified.tokenSha256 ||
      baseline.subjectSha256 !== verified.subjectSha256 || baseline.issuer !== verified.issuer ||
      baseline.audience !== verified.audience || baseline.keyId !== verified.keyId ||
      baseline.targetTenantSha256 !== sha256(targetTenantId.toLowerCase()) ||
      baseline.siblingTenantSha256 !== sha256(siblingTenantId.toLowerCase()) ||
      baseline.rawBearerTokenStored !== false) {
    throw new Error('The post-deprovision probe does not match the original token, candidate or tenant baseline');
  }

  const eventReference = assertSafeEventReference(input.eventReference);
  const eventTimeMs = requireUtc(input.deprovisionedAtUtc, 'SCIM_DEPROVISIONED_AT_UTC', nowMs);
  const baselineTimeMs = Date.parse(baseline.recordedAtUtc);
  if (!Number.isFinite(baselineTimeMs) || eventTimeMs < baselineTimeMs) {
    throw new Error('IdP deprovision event must occur after the authenticated baseline');
  }
  const maxLatencySeconds = Number(input.maxLatencySeconds);
  if (!Number.isInteger(maxLatencySeconds) || maxLatencySeconds < 1 || maxLatencySeconds > 3600) {
    throw new Error('SCIM_MAX_PROPAGATION_SECONDS must be an integer from 1 to 3600');
  }
  if (Date.parse(verified.expiresAtUtc) <= eventTimeMs + maxLatencySeconds * 1000 + 30_000) {
    throw new Error('Original signed token must remain valid beyond the entire deprovision observation window');
  }

  const intervalMs = Number.isInteger(input.pollIntervalMs) ? Math.max(250, Math.min(input.pollIntervalMs, 10_000)) : 2000;
  const sleep = input.sleep || ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let observedAtMs = null;
  while (now() <= eventTimeMs + maxLatencySeconds * 1000) {
    const targetResult = await apiRequest(targetTenantId, token);
    if (targetResult.status === 401) {
      observedAtMs = now();
      break;
    }
    if (targetResult.status !== 200) throw new Error('Target tenant deprovision probe returned an unexpected HTTP status');
    await sleep(Math.min(intervalMs, Math.max(0, eventTimeMs + maxLatencySeconds * 1000 - now())));
  }
  if (!observedAtMs) throw new Error('The original signed token remained authorized in the target tenant beyond the configured propagation limit');

  const sibling = await requireAuthorizedProbe(apiRequest, siblingTenantId, token, baseline.factoryOsUserIdSha256);
  const latencyMs = observedAtMs - eventTimeMs;
  if (latencyMs < 0 || latencyMs > maxLatencySeconds * 1000) throw new Error('Observed deprovision propagation time is outside the approved bound');

  const evidence = {
    schema: 'factoryos.as133.oidc-deprovision-evidence/v1',
    candidateSha,
    observedAtUtc: new Date(observedAtMs).toISOString(),
    tokenSha256: verified.tokenSha256,
    subjectSha256: verified.subjectSha256,
    issuer: verified.issuer,
    audience: verified.audience,
    keyId: verified.keyId,
    tokenExpiresAtUtc: verified.expiresAtUtc,
    mfaVerified: verified.mfaVerified,
    targetTenantSha256: sha256(targetTenantId.toLowerCase()),
    siblingTenantSha256: sha256(siblingTenantId.toLowerCase()),
    factoryOsUserIdSha256: baseline.factoryOsUserIdSha256,
    idpDeprovisionEventReference: eventReference,
    idpDeprovisionedAtUtc: new Date(eventTimeMs).toISOString(),
    maxPropagationSeconds: maxLatencySeconds,
    observedPropagationMilliseconds: latencyMs,
    targetTenantStatus: 'UNAUTHORIZED_401_WITH_ORIGINAL_UNEXPIRED_SIGNED_TOKEN',
    siblingTenantStatus: 'AUTHORIZED_200',
    siblingUserIdentityPreserved: sibling.userIdHash === baseline.factoryOsUserIdSha256,
    rawBearerTokenStored: false,
    globalUserOrSiblingMembershipChanged: false,
  };
  if (!evidence.siblingUserIdentityPreserved) throw new Error('Sibling tenant FactoryOS user identity changed unexpectedly');
  await writeCreateOnlyJson(input.outputPath, evidence);
  return { phase, result: 'DEPROVISION_VERIFIED', observedPropagationMilliseconds: latencyMs, outputPath: resolve(input.outputPath) };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(name + ' is required');
  return value.trim();
}

async function main() {
  const phase = requiredEnv('PHASE');
  const input = {
    phase,
    outputPath: requiredEnv('EVIDENCE_OUTPUT'),
    baselinePath: process.env.BASELINE_EVIDENCE_PATH,
    token: requiredEnv('OIDC_STAGING_BEARER_TOKEN'),
    apiOrigin: requiredEnv('FACTORYOS_STAGING_API_ORIGIN'),
    candidateSha: requiredEnv('CANDIDATE_SHA'),
    targetTenantId: requiredEnv('TARGET_TENANT_ID'),
    siblingTenantId: requiredEnv('SIBLING_TENANT_ID'),
    oidc: {
      issuer: requiredEnv('OIDC_ISSUER'),
      audience: requiredEnv('OIDC_AUDIENCE'),
      jwksUri: requiredEnv('OIDC_JWKS_URI'),
      mfaAmrValues: process.env.OIDC_MFA_AMR_VALUES || '',
      mfaAcrValues: process.env.OIDC_MFA_ACR_VALUES || '',
    },
  };
  if (phase === 'after') {
    input.eventReference = requiredEnv('SCIM_DEPROVISION_EVENT_REFERENCE');
    input.deprovisionedAtUtc = requiredEnv('SCIM_DEPROVISIONED_AT_UTC');
    input.maxLatencySeconds = Number(requiredEnv('SCIM_MAX_PROPAGATION_SECONDS'));
  }
  process.stdout.write(JSON.stringify(await runDeprovisionProbe(input)) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write('OIDC deprovision verification failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
