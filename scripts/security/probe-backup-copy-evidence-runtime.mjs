#!/usr/bin/env node
import { access, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const fail = (message) => {
  console.error('BLOCKED: ' + message);
  process.exit(1);
};
const rootValue = process.env.FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR;
if (typeof rootValue !== 'string' || !path.posix.isAbsolute(rootValue) || rootValue === '/') {
  fail('FACTORYOS_BACKUP_COPY_EVIDENCE_ROOT_DIR must be a non-root absolute path');
}

const root = await realpath(rootValue).catch(() => fail('evidence root cannot be resolved'));
const rootStat = await stat(root).catch(() => fail('evidence root cannot be stat-ed'));
if (!rootStat.isDirectory()) fail('evidence root is not a directory');

function unescapeMount(value) {
  return value.replace(/\\(040|011|012|134)/g, (_, code) => ({
    '040': ' ', '011': '\t', '012': '\n', '134': '\\',
  })[code]);
}
const mountLines = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n');
const mounts = mountLines.map((line) => {
  const fields = line.split(' ');
  return { point: unescapeMount(fields[4] ?? ''), options: (fields[5] ?? '').split(',') };
}).filter((mount) => mount.point && (root === mount.point || root.startsWith(mount.point.endsWith('/') ? mount.point : mount.point + '/')));
mounts.sort((a, b) => b.point.length - a.point.length);
if (mounts.length === 0) fail('no mountinfo entry covers the evidence root');
if (!mounts[0].options.includes('ro')) fail('deepest covering mount is not read-only');

const status = await readFile('/proc/self/status', 'utf8');
const fields = Object.fromEntries(status.split('\n').filter(Boolean).map((line) => {
  const index = line.indexOf(':');
  return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1).trim()];
}));
if (typeof process.getuid !== 'function' || process.getuid() === 0) fail('API process must not run as root');
const capSysAdmin = 1n << 21n;
for (const key of ['CapEff', 'CapPrm', 'CapBnd', 'CapInh', 'CapAmb']) {
  const value = fields[key];
  if (!value || (BigInt('0x' + value) & capSysAdmin) !== 0n) fail('CAP_SYS_ADMIN must be absent from ' + key);
}
if (fields.NoNewPrivs !== '1') fail('NoNewPrivs must be enabled');

try {
  await access('/var/run/secrets/kubernetes.io/serviceaccount/token');
  fail('Kubernetes ServiceAccount token unexpectedly exists in the API container');
} catch (error) {
  if (error?.code !== 'ENOENT') fail('could not prove that the Kubernetes ServiceAccount token is absent');
}

const probePath = path.join(root, '.factoryos-readonly-probe-' + process.pid + '-' + Date.now());
let handle;
try {
  handle = await open(probePath, 'wx', 0o600);
  await handle.close();
  await (await import('node:fs/promises')).unlink(probePath);
  fail('API identity successfully created a file in the evidence root');
} catch (error) {
  if (handle) await handle.close().catch(() => {});
  if (!['EROFS', 'EACCES'].includes(error?.code)) fail('write probe failed for an unexpected reason: ' + (error?.code ?? error?.message));
}

console.log(JSON.stringify({
  result: 'PASS',
  uid: process.getuid(),
  evidence_root: root,
  covering_mount: mounts[0].point,
  per_mount_option: 'ro',
  api_write_probe: 'DENIED',
  cap_sys_admin: 'ABSENT',
  remount_control: 'CAP_SYS_ADMIN_ABSENT_AND_NO_NEW_PRIVS',
  no_new_privileges: true,
  service_account_token: 'ABSENT',
  checked_at_utc: new Date().toISOString(),
}));
