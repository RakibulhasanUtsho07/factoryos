import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, link, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

function fail(message) {
  console.error('Approved PostgreSQL backup manifest rejected: ' + message);
  process.exit(2);
}

function parseArguments(argv) {
  const allowed = new Set([
    'artifact',
    'output',
    'source-database-identity',
    'backup-created-at-utc',
    'backup-duration-seconds',
    'pg-dump-version',
    'source-server-version',
    'recipient-fingerprint',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail('expected --name value arguments');
    }
    const name = key.slice(2);
    if (!allowed.has(name)) fail('unknown argument: ' + key);
    if (values[name] !== undefined) fail('duplicate argument: ' + key);
    values[name] = argv[index + 1];
    index += 1;
  }
  for (const name of allowed) {
    if (!values[name]?.trim()) fail('missing required --' + name);
  }
  return values;
}

function strictUtcTimestamp(value) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const args = parseArguments(process.argv.slice(2));
const artifactPath = resolve(args.artifact);
const outputPath = resolve(args.output);
if (!args.artifact.startsWith('/') || !args.output.startsWith('/')) {
  fail('--artifact and --output must be absolute paths');
}
if (!artifactPath.endsWith('.dump.gpg')) fail('approved encrypted artifact must end in .dump.gpg');
if (artifactPath === outputPath) fail('manifest output cannot overwrite the backup artifact');
if (typeof args['source-database-identity'] !== 'string'
  || args['source-database-identity'].trim().length < 5
  || args['source-database-identity'].length > 512
  || /[\\r\\n\\0]/.test(args['source-database-identity'])) {
  fail('--source-database-identity must be a bounded single-line source DB identity');
}
if (!strictUtcTimestamp(args['backup-created-at-utc'])) {
  fail('--backup-created-at-utc must be a real UTC RFC3339 timestamp ending in Z');
}
if (!/^(0|[1-9]\\d*)$/.test(args['backup-duration-seconds'])
  || !Number.isSafeInteger(Number(args['backup-duration-seconds']))) {
  fail('--backup-duration-seconds must be a non-negative safe integer');
}
for (const name of ['pg-dump-version', 'source-server-version']) {
  if (args[name].trim().length > 256 || /[\\r\\n\\0]/.test(args[name])) {
    fail('--' + name + ' must be a bounded single-line version string');
  }
}
const recipientFingerprint = args['recipient-fingerprint'].replaceAll(' ', '').toUpperCase();
if (!/^[A-F0-9]{40}([A-F0-9]{24})?$/.test(recipientFingerprint)) {
  fail('--recipient-fingerprint must be the full 40- or 64-character GPG encryption key fingerprint');
}

const artifactStat = await lstat(artifactPath).catch(() => fail('approved encrypted artifact is missing or unreadable'));
if (!artifactStat.isFile() || artifactStat.isSymbolicLink() || artifactStat.size <= 0) {
  fail('approved encrypted artifact must be a non-empty regular file, not a symlink');
}
if ((artifactStat.mode & 0o022) !== 0) fail('approved encrypted artifact must not be group/world writable');

const outputDirectory = dirname(outputPath);
const outputDirectoryStat = await lstat(outputDirectory).catch(() => fail('manifest output directory is missing'));
if (!outputDirectoryStat.isDirectory() || outputDirectoryStat.isSymbolicLink()) {
  fail('manifest output directory must be an existing directory, not a symlink');
}
const manifestStat = await lstat(outputPath).catch(() => null);
if (manifestStat) fail('manifest output already exists; refusing to overwrite signed-backup provenance');

const manifest = {
  schema: 'factoryos.approved-postgresql-backup/v1',
  artifactFileName: basename(artifactPath),
  artifactSizeBytes: artifactStat.size,
  artifactSha256: await sha256File(artifactPath).catch(() => fail('could not compute approved artifact SHA-256')),
  sourceDatabaseIdentity: args['source-database-identity'].trim(),
  backupCreatedAtUtc: args['backup-created-at-utc'],
  backupDurationSeconds: Number(args['backup-duration-seconds']),
  backupTool: 'pg_dump',
  pgDumpVersion: args['pg-dump-version'].trim(),
  sourceServerVersion: args['source-server-version'].trim(),
  encryption: 'GPG',
  recipientFingerprint,
};

const serialized = JSON.stringify(manifest, null, 2) + '\\n';
const temporaryOutput = outputPath + '.partial-' + process.pid;
await writeFile(temporaryOutput, serialized, { flag: 'wx', mode: 0o600 })
  .catch(() => fail('could not create temporary signed-backup manifest'));
try {
  await link(temporaryOutput, outputPath).catch((error) => {
    fail(error.code === 'EEXIST' ? 'manifest output already exists; refusing to overwrite it' : 'could not publish signed-backup manifest');
  });
} finally {
  await unlink(temporaryOutput).catch(() => undefined);
}
console.log('approved_backup_manifest=' + outputPath);
console.log('approved_backup_artifact_sha256=' + manifest.artifactSha256);
console.log('approved_backup_manifest_sha256=' + createHash('sha256').update(serialized).digest('hex'));
