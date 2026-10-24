import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const MAX_ARTIFACTS = 64;
const MAX_ALLOWED_TOOLS = 64;
const DEFAULT_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export class EdgePackageRuntimeVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EdgePackageRuntimeVerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EdgePackageRuntimeVerificationError(code, message);
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail('INVALID_MANIFEST', 'The signed package manifest contains missing or unknown fields');
  }
}

function stringValue(value, field, pattern) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value.trim() !== value || (pattern && !pattern.test(value))) {
    fail('INVALID_MANIFEST', 'The signed package manifest field ' + field + ' is invalid');
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_MANIFEST', 'Manifest contains a non-finite number');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isPlainRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  fail('INVALID_MANIFEST', 'Manifest contains an unsupported value');
}

function normalizeManifest(input) {
  if (!isPlainRecord(input)) fail('INVALID_MANIFEST', 'Manifest must be a plain JSON object');
  exactKeys(input, [
    'schemaVersion', 'packageId', 'version', 'tenantId', 'factoryId', 'issuedAt',
    'expiresAt', 'signingKeyId', 'model', 'policyBundle', 'allowedTools', 'artifacts', 'rollback',
  ]);
  if (input.schemaVersion !== 1) fail('INVALID_MANIFEST', 'Only edge package manifest schema version 1 is supported');

  const packageId = stringValue(input.packageId, 'packageId', PACKAGE_ID);
  const version = stringValue(input.version, 'version', SEMVER);
  const tenantId = stringValue(input.tenantId, 'tenantId', UUID);
  const factoryId = stringValue(input.factoryId, 'factoryId', UUID);
  const issuedAt = stringValue(input.issuedAt, 'issuedAt');
  const expiresAt = stringValue(input.expiresAt, 'expiresAt');
  const signingKeyId = stringValue(input.signingKeyId, 'signingKeyId', TOKEN);

  if (!isPlainRecord(input.model)) fail('INVALID_MANIFEST', 'model must be an object');
  exactKeys(input.model, ['modelId', 'version', 'artifactPath']);
  const model = {
    modelId: stringValue(input.model.modelId, 'model.modelId', TOKEN),
    version: stringValue(input.model.version, 'model.version', SEMVER),
    artifactPath: stringValue(input.model.artifactPath, 'model.artifactPath'),
  };

  if (!isPlainRecord(input.policyBundle)) fail('INVALID_MANIFEST', 'policyBundle must be an object');
  exactKeys(input.policyBundle, ['version', 'artifactPath']);
  const policyBundle = {
    version: stringValue(input.policyBundle.version, 'policyBundle.version', SEMVER),
    artifactPath: stringValue(input.policyBundle.artifactPath, 'policyBundle.artifactPath'),
  };

  if (!Array.isArray(input.allowedTools) || input.allowedTools.length > MAX_ALLOWED_TOOLS) {
    fail('INVALID_MANIFEST', 'allowedTools must contain at most 64 tool identifiers');
  }
  const allowedTools = input.allowedTools.map((value, index) => stringValue(value, 'allowedTools[' + index + ']', TOKEN));
  if (new Set(allowedTools).size !== allowedTools.length) fail('INVALID_MANIFEST', 'allowedTools contains duplicates');

  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > MAX_ARTIFACTS) {
    fail('INVALID_MANIFEST', 'artifacts must contain between 1 and 64 entries');
  }
  const artifacts = input.artifacts.map((value, index) => {
    if (!isPlainRecord(value)) fail('INVALID_MANIFEST', 'Artifact descriptor must be an object');
    exactKeys(value, ['path', 'sha256', 'sizeBytes']);
    const path = stringValue(value.path, 'artifacts[' + index + '].path');
    validateArtifactPath(path);
    const sha256 = stringValue(value.sha256, 'artifacts[' + index + '].sha256', SHA256);
    if (typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) {
      fail('INVALID_MANIFEST', 'Artifact sizeBytes must be a positive safe integer');
    }
    return { path, sha256, sizeBytes: value.sizeBytes };
  });
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) {
    fail('INVALID_MANIFEST', 'Artifact paths must be unique');
  }
  const paths = new Set(artifacts.map((entry) => entry.path));
  if (!paths.has(model.artifactPath) || !paths.has(policyBundle.artifactPath) || model.artifactPath === policyBundle.artifactPath) {
    fail('INVALID_MANIFEST', 'Model and policy bundle must reference distinct declared artifacts');
  }

  if (!isPlainRecord(input.rollback)) fail('INVALID_MANIFEST', 'rollback must be an object');
  exactKeys(input.rollback, ['enabled', 'targetVersion']);
  if (typeof input.rollback.enabled !== 'boolean') fail('INVALID_MANIFEST', 'rollback.enabled must be boolean');
  const targetVersion = input.rollback.targetVersion;
  if (input.rollback.enabled) {
    if (typeof targetVersion !== 'string' || !SEMVER.test(targetVersion) || targetVersion === version) {
      fail('INVALID_MANIFEST', 'Enabled rollback requires a different valid target version');
    }
  } else if (targetVersion !== null) {
    fail('INVALID_MANIFEST', 'Disabled rollback must use null targetVersion');
  }

  return {
    schemaVersion: 1, packageId, version, tenantId, factoryId, issuedAt, expiresAt, signingKeyId,
    model, policyBundle, allowedTools, artifacts,
    rollback: { enabled: input.rollback.enabled, targetVersion },
  };
}

function validateArtifactPath(path) {
  const parts = path.split('/');
  if (path.length > 240 || path.startsWith('/') || path.includes('\\') || path.includes(':')
    || !/^[A-Za-z0-9._/-]+$/.test(path)
    || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('INVALID_MANIFEST', 'Artifact paths must be safe relative POSIX paths');
  }
}

function parseStrictIsoInstant(value, field) {
  const match = ISO_INSTANT.exec(value);
  if (!match) fail('INVALID_MANIFEST', field + ' must be an ISO-8601 timestamp with an explicit timezone');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0') || '0');
  const zone = match[8];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    fail('INVALID_MANIFEST', field + ' contains invalid calendar or clock components');
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond) {
    fail('INVALID_MANIFEST', field + ' contains an impossible calendar date');
  }
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      fail('INVALID_MANIFEST', field + ' contains an invalid timezone offset');
    }
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail('INVALID_MANIFEST', field + ' is not a valid instant');
  return timestamp;
}

function decodeSignature(value) {
  if (typeof value !== 'string' || value.length !== 88 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail('INVALID_SIGNATURE', 'An Ed25519 signature must be canonical base64');
  }
  const signature = Buffer.from(value, 'base64');
  if (signature.byteLength !== 64 || signature.toString('base64') !== value) {
    fail('INVALID_SIGNATURE', 'An Ed25519 signature must be canonical base64');
  }
  return signature;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Canonical manifest payload shared with the API's edge-package manifest contract. */
export function edgePackageRuntimeSigningPayload(manifest) {
  return Buffer.from(canonicalJson(normalizeManifest(manifest)), 'utf8');
}

/**
 * Verify the exact signed Edge package and artifact bytes using the active signer
 * from the successful cloud control snapshot. The returned byte copies are safe to
 * pass to a trusted host loader; this function does not load native code itself.
 */
export function verifySynchronizedEdgePackage(input, authorization, policy = {}) {
  if (!isPlainRecord(input) || !isPlainRecord(authorization)) {
    fail('INVALID_PACKAGE_INPUT', 'A package input and synchronized authorization are required');
  }
  const manifest = normalizeManifest(input.manifest);
  const payload = Buffer.from(canonicalJson(manifest), 'utf8');
  const keyInfo = authorization.signingKey;
  if (!isPlainRecord(keyInfo) || keyInfo.keyId !== manifest.signingKeyId || keyInfo.status !== 'ACTIVE'
    || typeof keyInfo.publicKeyPem !== 'string' || typeof keyInfo.fingerprintSha256 !== 'string'
    || !SHA256.test(keyInfo.fingerprintSha256)) {
    fail('SIGNING_KEY_NOT_TRUSTED', 'The manifest signer is not the active synchronized public key');
  }

  let publicKey;
  try { publicKey = createPublicKey(keyInfo.publicKeyPem); }
  catch { fail('SIGNING_KEY_NOT_TRUSTED', 'The synchronized public signing key is invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('SIGNING_KEY_NOT_TRUSTED', 'Only Ed25519 release signers are accepted');
  }
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (fingerprint !== keyInfo.fingerprintSha256) fail('SIGNING_KEY_NOT_TRUSTED', 'Synchronized signer fingerprint mismatch');

  const signature = decodeSignature(input.signature);
  if (!verifySignature(null, payload, publicKey, signature)) {
    fail('INVALID_SIGNATURE', 'The package signature does not match the canonical manifest');
  }

  if (manifest.packageId !== authorization.packageId || manifest.version !== authorization.packageVersion
    || manifest.tenantId !== authorization.tenantId || manifest.factoryId !== authorization.factoryId
    || authorization.control?.status !== 'ACTIVE') {
    fail('PACKAGE_SCOPE_MISMATCH', 'The signed package scope does not match current synchronized authorization');
  }

  const now = policy.now === undefined ? new Date() : policy.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('INVALID_POLICY', 'The verification clock is invalid');
  const maxClockSkewMs = policy.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const maxPackageLifetimeMs = policy.maxPackageLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const maxTotalArtifactBytes = policy.maxTotalArtifactBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0
    || !Number.isSafeInteger(maxPackageLifetimeMs) || maxPackageLifetimeMs <= 0
    || !Number.isSafeInteger(maxTotalArtifactBytes) || maxTotalArtifactBytes <= 0) {
    fail('INVALID_POLICY', 'The package verification limits are invalid');
  }
  const issuedAt = parseStrictIsoInstant(manifest.issuedAt, 'issuedAt');
  const expiresAt = parseStrictIsoInstant(manifest.expiresAt, 'expiresAt');
  if (issuedAt > now.getTime() + maxClockSkewMs) fail('PACKAGE_NOT_YET_VALID', 'The package has not reached its issue time');
  if (expiresAt <= now.getTime()) fail('PACKAGE_EXPIRED', 'The package has expired');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxPackageLifetimeMs) {
    fail('INVALID_MANIFEST', 'The package validity interval is invalid or too long');
  }

  if (!(policy.allowedToolIds instanceof Set) && typeof policy.allowedToolIds?.has !== 'function') {
    fail('INVALID_POLICY', 'A host-controlled tool allow-list is required');
  }
  for (const toolId of manifest.allowedTools) {
    if (!policy.allowedToolIds.has(toolId)) fail('TOOL_NOT_ALLOWED', 'The package requests a tool outside the host allow-list');
  }

  if (!isPlainRecord(input.artifacts)) fail('ARTIFACT_MISMATCH', 'The supplied artifact collection must be a plain object');
  const descriptors = new Map(manifest.artifacts.map((entry) => [entry.path, entry]));
  const suppliedPaths = Object.keys(input.artifacts);
  if (suppliedPaths.length !== descriptors.size || suppliedPaths.some((path) => !descriptors.has(path))) {
    fail('ARTIFACT_MISMATCH', 'The supplied files do not exactly match the signed artifact set');
  }

  let total = 0;
  const copies = Object.create(null);
  for (const [path, descriptor] of descriptors) {
    const value = input.artifacts[path];
    if (!(value instanceof Uint8Array)) fail('ARTIFACT_MISMATCH', 'Every supplied artifact must be a byte array');
    const bytes = Buffer.from(value);
    if (bytes.byteLength !== descriptor.sizeBytes) fail('ARTIFACT_MISMATCH', 'An artifact size does not match its manifest descriptor');
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > maxTotalArtifactBytes) fail('ARTIFACT_MISMATCH', 'The package exceeds the configured total artifact limit');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== descriptor.sha256) fail('ARTIFACT_MISMATCH', 'An artifact hash does not match the signed manifest');
    copies[path] = bytes;
  }

  return {
    manifest: deepFreeze(manifest),
    manifestSha256: createHash('sha256').update(payload).digest('hex'),
    artifactBytes: total,
    artifacts: copies,
  };
}
