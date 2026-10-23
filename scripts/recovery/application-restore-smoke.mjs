import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

function fail(message) {
  console.error('recovery API smoke failed: ' + message);
  process.exitCode = 1;
}

function safeApiStartupDiagnostics(stdout, stderr) {
  // Startup failures can originate in Nest, pg or a native dependency. Keep
  // only the bounded output tail and redact connection strings and common
  // credential forms before exposing any diagnostic in CI logs.
  const candidates = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => /error|exception|unknown|cannot|dependenc|AuditService|IamService|moduleRef|Nest|stack/i.test(line))
    .slice(-16);
  return candidates.map((line) => line
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/https?:\/\/[^\s'"]+/gi, '[REDACTED_URL]')
    .replace(/Bearer\s+[^\s'"]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|secret|token|credential|api[_-]?key|authorization|connectionstring|dsn)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 400));
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('could not allocate a local API smoke port');
  }
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForResponse(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'not reached';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('candidate API exited before readiness was reached');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
      lastStatus = String(response.status);
      if (response.ok) return response;
    } catch (error) {
      lastStatus = error instanceof Error ? error.name : 'network error';
    }
    await delay(400);
  }
  throw new Error('candidate API readiness timeout; last HTTP/network result: ' + lastStatus);
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const databaseUrl = process.env.FACTORYOS_DR_APPLICATION_DATABASE_URL;
const expectedIdentity = process.env.FACTORYOS_DR_EXPECTED_DATABASE_IDENTITY;
if (!databaseUrl) fail('FACTORYOS_DR_APPLICATION_DATABASE_URL is missing (must be a secret pointing at the restored target)');
if (!expectedIdentity) fail('FACTORYOS_DR_EXPECTED_DATABASE_IDENTITY is missing');
if (process.exitCode) process.exit(process.exitCode);

const apiEntry = join(repositoryRoot, 'services/api/dist/main.js');
if (!existsSync(apiEntry)) fail('candidate API build is missing; run the candidate API build first');
if (process.exitCode) process.exit(process.exitCode);

const client = new Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
});
let child;
let stdoutTail = '';
let stderrTail = '';
try {
  await client.connect();
  const identityResult = await client.query(
    "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local') AS identity",
  );
  const actualIdentity = identityResult.rows[0]?.identity;
  if (actualIdentity !== expectedIdentity) {
    throw new Error('application database URL resolves to a different database identity than the independently verified restore service');
  }
  await client.end();

  const port = await findFreePort();
  const childEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    DEV_AUTH_ENABLED: 'false',
    DEV_AUTH_SECRET: randomBytes(32).toString('base64url'),
    JWT_SECRET: randomBytes(32).toString('base64url'),
    PORT: String(port),
    OUTBOX_DISPATCHER_ENABLED: 'false',
    SWAGGER_ENABLED: 'false',
  };
  child = spawn(process.execPath, [apiEntry], {
    cwd: repositoryRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdoutTail = (stdoutTail + chunk.toString()).slice(-12_000); });
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-12_000); });

  const base = 'http://127.0.0.1:' + port + '/api/health';
  const live = await waitForResponse(base + '/live', child);
  const liveEnvelope = await live.json();
  const liveBody = liveEnvelope?.data ?? liveEnvelope;
  if (liveBody?.status !== 'ok' || liveBody?.service !== 'factoryos-api') {
    throw new Error('candidate API liveness response failed the contract');
  }
  const ready = await waitForResponse(base + '/ready', child);
  const readyEnvelope = await ready.json();
  const readyBody = readyEnvelope?.data ?? readyEnvelope;
  if (readyBody?.status !== 'ok' || readyBody?.database !== 'ok' || readyBody?.service !== 'factoryos-api') {
    throw new Error('candidate API readiness did not confirm the restored database is queryable');
  }
  console.log('RECOVERY_API_DATABASE_IDENTITY=PASS');
  console.log('RECOVERY_API_LIVENESS=PASS');
  console.log('RECOVERY_API_READINESS=PASS');
  console.log('RECOVERY_APPLICATION_SMOKE=PASS');
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown failure';
  // Deliberately avoid logging the database URL, raw request data or application logs.
  console.error(message);
  if (child && (stdoutTail || stderrTail)) {
    const safeDiagnostics = safeApiStartupDiagnostics(stdoutTail, stderrTail);
    if (safeDiagnostics.length) {
      console.error('candidate API sanitized startup diagnostics:');
      for (const line of safeDiagnostics) console.error(line);
    } else {
      console.error('candidate API emitted startup output without a recognized safe error signature; full logs are intentionally suppressed');
    }
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      delay(3_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
