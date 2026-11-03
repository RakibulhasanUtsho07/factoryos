import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message) {
  console.error('Approved PostgreSQL backup rejected: ' + message);
  process.exit(2);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail('expected --name value arguments');
    }
    const name = key.slice(2);
    if (values[name] !== undefined) fail('duplicate argument: ' + key);
    values[name] = argv[index + 1];
    index += 1;
  }
  const allowed = new Set([
    'artifact', 'manifest', 'signature', 'signer-fingerprint',
    'source-database-identity', 'recipient-fingerprint', 'incident-cutoff-utc', 'output',
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) fail('unknown argument: --' + name);
  }
  for (const name of allowed) {
    if (!values[name]?.trim()) fail('missing required --' + name);
  }
  return values;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertProtectedRegularFile(path, label) {
  const metadata = await lstat(path).catch(() => fail(label + ' is missing or unreadable'));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(label + ' must be a regular file, not a symlink');
  if ((metadata.mode & 0o022) !== 0) fail(label + ' must not be group/world writable');
  return metadata;
}

function utcEpochSeconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

const args = parseArguments(process.argv.slice(2));
const artifactPath = resolve(args.artifact);
const manifestPath = resolve(args.manifest);
const signaturePath = resolve(args.signature);
const outputPath = resolve(args.output);
const expectedSigner = args['signer-fingerprint'].replaceAll(' ', '').toUpperCase();
if (!/^[A-F0-9]{40}([A-F0-9]{24})?$/.test(expectedSigner)) {
  fail('--signer-fingerprint must be a 40- or 64-character pinned OpenPGP fingerprint');
}
if (!args['source-database-identity'].trim()) fail('--source-database-identity cannot be empty');
const expectedRecipient = args['recipient-fingerprint'].replaceAll(' ', '').toUpperCase();
if (!/^[A-F0-9]{40}([A-F0-9]{24})?$/.test(expectedRecipient)) fail('--recipient-fingerprint must be a 40- or 64-character GPG key fingerprint');
const incidentEpoch = utcEpochSeconds(args['incident-cutoff-utc']);
if (incidentEpoch === null) fail('--incident-cutoff-utc must be a valid UTC RFC3339 timestamp ending in Z');

await assertProtectedRegularFile(artifactPath, 'approved encrypted backup artifact');
await assertProtectedRegularFile(manifestPath, 'approved backup manifest');
await assertProtectedRegularFile(signaturePath, 'approved backup manifest signature');

const manifestBytes = await readFile(manifestPath).catch(() => fail('approved backup manifest could not be read'));
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'));
} catch {
  fail('approved backup manifest is not valid JSON');
}

if (manifest.schema !== 'factoryos.approved-postgresql-backup/v1') fail('unsupported approved backup manifest schema');
if (manifest.artifactFileName !== basename(artifactPath)) fail('approved manifest does not identify the selected backup artifact filename');
if (manifest.sourceDatabaseIdentity !== args['source-database-identity']) fail('approved backup source database identity does not match the connected source');
if (manifest.backupTool !== 'pg_dump') fail('approved manifest must identify pg_dump as the backup tool');
if (typeof manifest.pgDumpVersion !== 'string' || !manifest.pgDumpVersion.trim()) fail('approved manifest is missing the source pg_dump version');
if (typeof manifest.sourceServerVersion !== 'string' || !manifest.sourceServerVersion.trim()) fail('approved manifest is missing the source PostgreSQL server version');
if (manifest.encryption !== 'GPG') fail('approved backup must declare GPG encryption');
if (typeof manifest.recipientFingerprint !== 'string' || !/^[A-Fa-f0-9]{40}([A-Fa-f0-9]{24})?$/.test(manifest.recipientFingerprint)) {
  fail('approved manifest is missing a valid OpenPGP encryption recipient fingerprint');
}
if (manifest.recipientFingerprint.toUpperCase() !== expectedRecipient) fail('approved backup encryption recipient does not match the recovery runner private key fingerprint');
const backupCreatedEpoch = utcEpochSeconds(manifest.backupCreatedAtUtc);
if (backupCreatedEpoch === null) fail('approved backup creation time must be UTC RFC3339');
if (backupCreatedEpoch > incidentEpoch) fail('selected backup was created after the incident cutoff and cannot represent the recovery point');

const artifactSha256 = await sha256File(artifactPath).catch(() => fail('could not compute the approved backup artifact SHA-256'));
if (!/^[a-f0-9]{64}$/.test(manifest.artifactSha256 ?? '') || manifest.artifactSha256 !== artifactSha256) {
  fail('approved backup artifact SHA-256 does not match its signed manifest');
}

const verification = spawnSync('gpg', [
  '--batch',
  '--status-fd', '1',
  '--verify', signaturePath, manifestPath,
], {
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
});
if (verification.error || verification.status !== 0) fail('detached OpenPGP signature verification failed');
const validSignatures = (verification.stdout ?? '').split(/\r?\n/)
  .filter((line) => line.startsWith('[GNUPG:] VALIDSIG '));
if (validSignatures.length !== 1) fail('GPG must report exactly one VALIDSIG record for the backup manifest');
const signatureFields = validSignatures[0].trim().split(/\s+/);
const signerFingerprints = [signatureFields[2], signatureFields.at(-1)]
  .filter((value) => typeof value === 'string' && /^[A-Fa-f0-9]{40}([A-Fa-f0-9]{24})?$/.test(value))
  .map((value) => value.toUpperCase());
if (!signerFingerprints.includes(expectedSigner)) fail('backup manifest signer does not match the pinned independent backup-controller fingerprint');

const approval = {
  schema: 'factoryos.approved-postgresql-backup-verification/v1',
  artifactPath,
  artifactFileName: basename(artifactPath),
  artifactSha256,
  manifestPath,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  signaturePath,
  signatureSha256: await sha256File(signaturePath),
  signerFingerprint: expectedSigner,
  sourceDatabaseIdentity: manifest.sourceDatabaseIdentity,
  backupCreatedAtUtc: manifest.backupCreatedAtUtc,
  backupTool: manifest.backupTool,
  pgDumpVersion: manifest.pgDumpVersion,
  sourceServerVersion: manifest.sourceServerVersion,
  encryption: manifest.encryption,
  recipientFingerprint: manifest.recipientFingerprint.toUpperCase(),
  incidentCutoffUtc: args['incident-cutoff-utc'],
  verifiedAtUtc: new Date().toISOString(),
  signatureStatus: 'VALID_PINNED_SIGNER',
};

await writeFile(outputPath, JSON.stringify(approval, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  .catch((error) => fail(error.code === 'EEXIST' ? 'backup verification receipt already exists; refusing to overwrite it' : 'could not write protected backup verification receipt'));
console.log('approved_backup_artifact_sha256=' + artifactSha256);
console.log('approved_backup_manifest_sha256=' + approval.manifestSha256);
console.log('approved_backup_signer=' + expectedSigner);
