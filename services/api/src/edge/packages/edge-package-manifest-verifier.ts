import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const MAX_MANIFEST_ARTIFACTS = 64;
const MAX_ALLOWED_TOOLS = 64;
const DEFAULT_MAX_PACKAGE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;

export type EdgePackageVerificationErrorCode =
  | 'INVALID_MANIFEST'
  | 'UNTRUSTED_SIGNING_KEY'
  | 'REVOKED_SIGNING_KEY'
  | 'INVALID_SIGNATURE'
  | 'WRONG_TARGET_SCOPE'
  | 'PACKAGE_NOT_YET_VALID'
  | 'PACKAGE_EXPIRED'
  | 'TOOL_NOT_ALLOWED'
  | 'ARTIFACT_MISMATCH';

export class EdgePackageVerificationError extends Error {
  constructor(
    readonly code: EdgePackageVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EdgePackageVerificationError';
  }
}

export interface EdgePackageArtifactDescriptor {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface EdgePackageManifestV1 {
  schemaVersion: 1;
  packageId: string;
  version: string;
  tenantId: string;
  factoryId: string;
  issuedAt: string;
  expiresAt: string;
  signingKeyId: string;
  model: {
    modelId: string;
    version: string;
    artifactPath: string;
  };
  policyBundle: {
    version: string;
    artifactPath: string;
  };
  allowedTools: string[];
  artifacts: EdgePackageArtifactDescriptor[];
  rollback: {
    enabled: boolean;
    targetVersion: string | null;
  };
}

export interface EdgePackageTrustedSigningKey {
  publicKeyPem: string;
  status: 'ACTIVE' | 'REVOKED';
}

export interface EdgePackageVerificationPolicy {
  tenantId: string;
  factoryId: string;
  trustedSigningKeys: Readonly<Record<string, EdgePackageTrustedSigningKey>>;
  allowedToolIds: ReadonlySet<string>;
  now?: Date;
  maxClockSkewMs?: number;
  maxPackageLifetimeMs?: number;
  maxTotalArtifactBytes?: number;
}

export interface SignedEdgePackageInput {
  manifest: unknown;
  signature: string;
  /** Already safely unpacked files, keyed by relative POSIX path. */
  artifacts: Readonly<Record<string, Uint8Array>>;
}

export interface VerifiedEdgePackage {
  manifest: EdgePackageManifestV1;
  manifestSha256: string;
  artifactBytes: number;
}

/** Returns the deterministic UTF-8 payload that an Ed25519 signer must sign. */
export function edgePackageSigningPayload(input: unknown): Buffer {
  const manifest = normalizeEdgePackageManifest(input);
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

/**
 * Verify a signed, scope-bound edge package before any install/activation code
 * handles its files. This function never installs or executes package content.
 */
export function verifyEdgePackage(
  input: SignedEdgePackageInput,
  policy: EdgePackageVerificationPolicy,
): VerifiedEdgePackage {
  const manifest = normalizeEdgePackageManifest(input?.manifest);
  const payload = Buffer.from(canonicalJson(manifest), 'utf8');

  const keyRecord = Object.hasOwn(policy.trustedSigningKeys, manifest.signingKeyId)
    ? policy.trustedSigningKeys[manifest.signingKeyId]
    : undefined;
  if (!keyRecord || typeof keyRecord !== 'object') {
    throw new EdgePackageVerificationError(
      'UNTRUSTED_SIGNING_KEY',
      'The edge package signing key is not trusted',
    );
  }
  if (keyRecord.status !== 'ACTIVE') {
    throw new EdgePackageVerificationError(
      'REVOKED_SIGNING_KEY',
      'The edge package signing key is not active',
    );
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(keyRecord.publicKeyPem);
  } catch {
    throw new EdgePackageVerificationError(
      'UNTRUSTED_SIGNING_KEY',
      'The configured edge package public key is invalid',
    );
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new EdgePackageVerificationError(
      'UNTRUSTED_SIGNING_KEY',
      'Edge package signing keys must use Ed25519',
    );
  }

  const signature = decodeSignature(input?.signature);
  if (!verifySignature(null, payload, publicKey, signature)) {
    throw new EdgePackageVerificationError(
      'INVALID_SIGNATURE',
      'The edge package signature does not match its manifest',
    );
  }

  assertUuid(policy.tenantId, 'target tenant');
  assertUuid(policy.factoryId, 'target factory');
  if (manifest.tenantId !== policy.tenantId || manifest.factoryId !== policy.factoryId) {
    throw new EdgePackageVerificationError(
      'WRONG_TARGET_SCOPE',
      'The edge package is not signed for this tenant and factory',
    );
  }

  const now = policy.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new EdgePackageVerificationError('INVALID_MANIFEST', 'The verification clock is invalid');
  }
  const clockSkewMs = policy.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const maxLifetimeMs = policy.maxPackageLifetimeMs ?? DEFAULT_MAX_PACKAGE_LIFETIME_MS;
  const maxTotalBytes = policy.maxTotalArtifactBytes ?? DEFAULT_MAX_TOTAL_ARTIFACT_BYTES;
  if (
    !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 ||
    !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0 ||
    !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0
  ) {
    throw new EdgePackageVerificationError(
      'INVALID_MANIFEST',
      'The edge package verification limits are invalid',
    );
  }

  const issuedAt = parseStrictIsoInstant(manifest.issuedAt, 'issuedAt');
  const expiresAt = parseStrictIsoInstant(manifest.expiresAt, 'expiresAt');
  if (issuedAt > now.getTime() + clockSkewMs) {
    throw new EdgePackageVerificationError(
      'PACKAGE_NOT_YET_VALID',
      'The edge package has not reached its issue time',
    );
  }
  if (expiresAt <= now.getTime()) {
    throw new EdgePackageVerificationError('PACKAGE_EXPIRED', 'The edge package has expired');
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeMs) {
    throw new EdgePackageVerificationError(
      'INVALID_MANIFEST',
      'The edge package validity interval is invalid or too long',
    );
  }

  for (const toolId of manifest.allowedTools) {
    if (!policy.allowedToolIds.has(toolId)) {
      throw new EdgePackageVerificationError(
        'TOOL_NOT_ALLOWED',
        'The edge package requests a tool outside the trusted host allow-list',
      );
    }
  }

  const actualArtifacts = input.artifacts;
  if (!isPlainRecord(actualArtifacts)) {
    throw new EdgePackageVerificationError(
      'ARTIFACT_MISMATCH',
      'The edge package artifact collection is invalid',
    );
  }
  const descriptors = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const suppliedPaths = Object.keys(actualArtifacts);
  if (
    suppliedPaths.length !== descriptors.size ||
    suppliedPaths.some((path) => !descriptors.has(path))
  ) {
    throw new EdgePackageVerificationError(
      'ARTIFACT_MISMATCH',
      'The supplied artifact set does not match the signed manifest',
    );
  }

  let artifactBytes = 0;
  for (const [path, descriptor] of descriptors) {
    const bytes = actualArtifacts[path];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== descriptor.sizeBytes) {
      throw new EdgePackageVerificationError(
        'ARTIFACT_MISMATCH',
        'An edge package artifact has an unexpected size or type',
      );
    }
    artifactBytes += bytes.byteLength;
    if (!Number.isSafeInteger(artifactBytes) || artifactBytes > maxTotalBytes) {
      throw new EdgePackageVerificationError(
        'ARTIFACT_MISMATCH',
        'The edge package exceeds the configured artifact size limit',
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== descriptor.sha256) {
      throw new EdgePackageVerificationError(
        'ARTIFACT_MISMATCH',
        'An edge package artifact hash does not match its signed manifest',
      );
    }
  }

  return {
    manifest,
    manifestSha256: createHash('sha256').update(payload).digest('hex'),
    artifactBytes,
  };
}

function normalizeEdgePackageManifest(input: unknown): EdgePackageManifestV1 {
  if (!isPlainRecord(input)) invalidManifest('Manifest must be a plain JSON object');
  exactKeys(input, [
    'schemaVersion', 'packageId', 'version', 'tenantId', 'factoryId', 'issuedAt',
    'expiresAt', 'signingKeyId', 'model', 'policyBundle', 'allowedTools', 'artifacts', 'rollback',
  ]);
  if (input.schemaVersion !== 1) invalidManifest('Only edge package manifest schema version 1 is supported');

  const packageId = stringValue(input.packageId, 'packageId', PACKAGE_ID_PATTERN);
  const version = stringValue(input.version, 'version', SEMVER_PATTERN);
  const tenantId = stringValue(input.tenantId, 'tenantId', UUID_PATTERN);
  const factoryId = stringValue(input.factoryId, 'factoryId', UUID_PATTERN);
  const issuedAt = stringValue(input.issuedAt, 'issuedAt');
  const expiresAt = stringValue(input.expiresAt, 'expiresAt');
  const signingKeyId = stringValue(input.signingKeyId, 'signingKeyId', TOKEN_PATTERN);

  if (!isPlainRecord(input.model)) invalidManifest('model must be an object');
  exactKeys(input.model, ['modelId', 'version', 'artifactPath']);
  const modelId = stringValue(input.model.modelId, 'model.modelId', TOKEN_PATTERN);
  const modelVersion = stringValue(input.model.version, 'model.version', SEMVER_PATTERN);
  const modelPath = stringValue(input.model.artifactPath, 'model.artifactPath');

  if (!isPlainRecord(input.policyBundle)) invalidManifest('policyBundle must be an object');
  exactKeys(input.policyBundle, ['version', 'artifactPath']);
  const policyVersion = stringValue(input.policyBundle.version, 'policyBundle.version', SEMVER_PATTERN);
  const policyPath = stringValue(input.policyBundle.artifactPath, 'policyBundle.artifactPath');

  if (!Array.isArray(input.allowedTools) || input.allowedTools.length > MAX_ALLOWED_TOOLS) {
    invalidManifest('allowedTools must be an array of at most 64 tool identifiers');
  }
  const allowedTools = input.allowedTools.map((value, index) =>
    stringValue(value, 'allowedTools[' + index + ']', TOKEN_PATTERN),
  );
  if (new Set(allowedTools).size !== allowedTools.length) invalidManifest('allowedTools contains duplicates');

  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > MAX_MANIFEST_ARTIFACTS) {
    invalidManifest('artifacts must contain between 1 and 64 entries');
  }
  const artifacts = input.artifacts.map((value, index) => {
    if (!isPlainRecord(value)) invalidManifest('Artifact descriptor must be an object');
    exactKeys(value, ['path', 'sha256', 'sizeBytes']);
    const path = stringValue(value.path, 'artifacts[' + index + '].path');
    validateRelativeArtifactPath(path);
    const sha256 = stringValue(value.sha256, 'artifacts[' + index + '].sha256', SHA256_PATTERN);
    const sizeBytes = value.sizeBytes;
    if (!Number.isSafeInteger(sizeBytes) || typeof sizeBytes !== 'number' || sizeBytes <= 0) {
      invalidManifest('Artifact sizeBytes must be a positive safe integer');
    }
    return { path, sha256, sizeBytes };
  });
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    invalidManifest('Artifact paths must be unique');
  }
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  if (!artifactPaths.has(modelPath) || !artifactPaths.has(policyPath) || modelPath === policyPath) {
    invalidManifest('Model and policy bundle must reference distinct declared artifacts');
  }

  if (!isPlainRecord(input.rollback)) invalidManifest('rollback must be an object');
  exactKeys(input.rollback, ['enabled', 'targetVersion']);
  if (typeof input.rollback.enabled !== 'boolean') invalidManifest('rollback.enabled must be boolean');
  const targetVersion = input.rollback.targetVersion;
  if (input.rollback.enabled) {
    if (typeof targetVersion !== 'string' || !SEMVER_PATTERN.test(targetVersion) || targetVersion === version) {
      invalidManifest('Enabled rollback requires a different, valid target version');
    }
  } else if (targetVersion !== null) {
    invalidManifest('Disabled rollback must use a null targetVersion');
  }

  return {
    schemaVersion: 1,
    packageId,
    version,
    tenantId,
    factoryId,
    issuedAt,
    expiresAt,
    signingKeyId,
    model: { modelId, version: modelVersion, artifactPath: modelPath },
    policyBundle: { version: policyVersion, artifactPath: policyPath },
    allowedTools,
    artifacts,
    rollback: { enabled: input.rollback.enabled, targetVersion: targetVersion as string | null },
  };
}

function validateRelativeArtifactPath(path: string): void {
  const parts = path.split('/');
  if (
    path.length > 240 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  ) {
    invalidManifest('Artifact paths must be safe relative POSIX paths');
  }
}

function parseStrictIsoInstant(value: string, field: string): number {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) invalidManifest(field + ' must be an ISO-8601 timestamp with an explicit timezone');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0') || '0');
  const zone = match[8];
  if (
    year < 2000 || month < 1 || month > 12 || day < 1 || hour > 23 ||
    minute > 59 || second > 59
  ) invalidManifest(field + ' contains invalid calendar or clock components');

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) invalidManifest(field + ' contains an impossible calendar date');

  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (
      offsetHours > 14 || offsetMinutes > 59 ||
      (offsetHours === 14 && offsetMinutes !== 0)
    ) invalidManifest(field + ' contains an invalid timezone offset');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalidManifest(field + ' is not a valid instant');
  return timestamp;
}

function decodeSignature(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length !== 88 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new EdgePackageVerificationError(
      'INVALID_SIGNATURE',
      'An Ed25519 signature must be canonical base64',
    );
  }
  const signature = Buffer.from(value, 'base64');
  if (signature.byteLength !== 64 || signature.toString('base64') !== value) {
    throw new EdgePackageVerificationError(
      'INVALID_SIGNATURE',
      'An Ed25519 signature must be canonical base64',
    );
  }
  return signature;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidManifest('Manifest contains a non-finite number');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isPlainRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalJson(value[key]),
    ).join(',') + '}';
  }
  invalidManifest('Manifest contains an unsupported value');
}

function stringValue(value: unknown, field: string, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    value.trim() !== value ||
    (pattern !== undefined && !pattern.test(value))
  ) invalidManifest(field + ' is invalid');
  return value;
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new EdgePackageVerificationError('INVALID_MANIFEST', field + ' must be a UUID');
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) invalidManifest('Manifest contains missing or unknown fields');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function invalidManifest(message: string): never {
  throw new EdgePackageVerificationError('INVALID_MANIFEST', message);
}
