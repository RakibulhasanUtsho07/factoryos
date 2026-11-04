#!/usr/bin/env node
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const apiRequire = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Client } = apiRequire('pg');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = 'fos_scim_';

export function createScimToken(tenantId, secret = randomBytes(32).toString('base64url')) {
  if (!UUID.test(String(tenantId)) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid SCIM tenant id or secret material');
  return PREFIX + tenantId + '.' + secret;
}
export function hashScimToken(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
export function validatePreviousToken(token, tenantId) {
  if (typeof token !== 'string') return false;
  const prefix = PREFIX + tenantId + '.';
  return token.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length));
}
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(name + ' is required');
  return value.trim();
}
function requireHttpsIssuer(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('SCIM_PROVISIONING_ISSUER must be credential-free HTTPS without query or fragment');
  }
  return value;
}
export async function writePrivateTokenFile(path, value) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('SCIM token output file must use an absolute path');
  }
  const absolute = resolve(path);
  const parent = await lstat(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory() ||
      (typeof process.getuid === 'function' && parent.uid !== process.getuid()) ||
      (parent.mode & 0o077) !== 0) {
    throw new Error('SCIM token output directory must be a real runner-owned directory with mode 0700 or stricter');
  }
  let handle;
  let created = false;
  try {
    handle = await open(absolute, 'wx', 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(absolute, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(absolute).catch(() => undefined);
    if (error?.code === 'EEXIST') throw new Error('SCIM token output file already exists; refusing to overwrite');
    throw error;
  }
  return absolute;
}
async function main() {
  const tenantId = required('SCIM_PROVISIONING_TENANT_ID');
  if (!UUID.test(tenantId)) throw new Error('SCIM_PROVISIONING_TENANT_ID must be a UUID');
  const issuer = requireHttpsIssuer(required('SCIM_PROVISIONING_ISSUER'));
  const connectionString = required('SCIM_PROVISIONING_DATABASE_URL');
  const dsn = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(dsn.protocol) || dsn.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('SCIM_PROVISIONING_DATABASE_URL must use PostgreSQL sslmode=verify-full');
  }
  const outputPath = required('SCIM_PROVISIONING_TOKEN_OUTPUT_FILE');
  const expiresAt = process.env.SCIM_PROVISIONING_EXPIRES_AT_UTC
    ? new Date(process.env.SCIM_PROVISIONING_EXPIRES_AT_UTC)
    : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 60_000 ||
      expiresAt.getTime() > Date.now() + 90 * 24 * 60 * 60 * 1000) {
    throw new Error('SCIM credential expiry must be within the next 90 days');
  }
  const previousToken = process.env.SCIM_PROVISIONING_PREVIOUS_TOKEN;
  if (previousToken && !validatePreviousToken(previousToken, tenantId)) throw new Error('Previous SCIM token must belong to this tenant');

  const token = createScimToken(tenantId);
  const digest = hashScimToken(token);
  const client = new Client({ connectionString });
  let credential;
  let credentialFileCreated = false;
  let commitAttempted = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    // Forced RLS applies to provisioners too; constrain every credential-table
    // read/write to the requested tenant on this transaction's connection.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const tenant = await client.query(
      "SELECT id FROM public.tenants WHERE id = $1::uuid AND status = 'ACTIVE'",
      [tenantId],
    );
    if (tenant.rowCount !== 1) throw new Error('SCIM tenant is missing or inactive');
    if (previousToken) {
      const revoked = await client.query(
        "UPDATE public.scim_provisioning_credentials SET status = 'REVOKED', revoked_at = clock_timestamp() " +
        "WHERE tenant_id = $1::uuid AND token_sha256 = $2 AND status = 'ACTIVE' RETURNING id",
        [tenantId, hashScimToken(previousToken)],
      );
      if (revoked.rowCount !== 1) throw new Error('Previous SCIM credential was not active; rotation aborted');
    }
    const inserted = await client.query(
      "INSERT INTO public.scim_provisioning_credentials " +
      "(tenant_id, issuer, token_sha256, scopes, status, expires_at) " +
      "VALUES ($1::uuid, $2, $3, ARRAY['Users:write']::text[], 'ACTIVE', $4) " +
      'RETURNING id::text AS id, expires_at',
      [tenantId, issuer, digest, expiresAt.toISOString()],
    );
    credential = inserted.rows[0];
    await writePrivateTokenFile(outputPath, {
      schema: 'factoryos.scim-provisioning-credential/v1',
      credential_id: credential.id,
      tenant_id: tenantId,
      issuer,
      expires_at_utc: new Date(credential.expires_at).toISOString(),
      bearer_token: token,
    });
    credentialFileCreated = true;
    // Persist the protected token before committing its hash so a filesystem
    // failure cannot leave an active credential whose raw value is lost.
    commitAttempted = true;
    await client.query('COMMIT');
  } catch (error) {
    if (!commitAttempted) {
      try { await client.query('ROLLBACK'); } catch {}
      if (credentialFileCreated) await unlink(resolve(outputPath)).catch(() => undefined);
    }
    if (commitAttempted) {
      throw new Error('SCIM credential commit outcome is indeterminate; token file retained for database reconciliation');
    }
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'SCIM_CREDENTIAL_PROVISIONING_FAILED';
    throw new Error(code);
  } finally { await client.end().catch(() => undefined); }

  process.stdout.write(JSON.stringify({
    credential_id: credential.id,
    tenant_id: tenantId,
    issuer,
    expires_at_utc: new Date(credential.expires_at).toISOString(),
    token_sha256: digest,
    output_file_created: true,
    previous_credential_revoked: Boolean(previousToken),
    raw_token_printed: false,
  }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write('SCIM credential provisioning failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
