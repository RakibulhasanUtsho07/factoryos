import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const harnessPath = fileURLToPath(new URL('./api-soak-test.mjs', import.meta.url));
let server;
let origin;
let tempDir;
const observedAuth = new Set();

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'factoryos-soak-contract-'));
  const tenantTokens = [
    { tenant: 'synthetic-tenant-a', token: 'synthetic-token-secret-for-tenant-a' },
    { tenant: 'synthetic-tenant-b', token: 'synthetic-token-secret-for-tenant-b' },
  ];
  await writeFile(join(tempDir, 'tokens.json'), JSON.stringify(tenantTokens), { mode: 0o600 });
  await writeFile(join(tempDir, 'scenarios.json'), JSON.stringify([
    { name: 'orders-read', path: '/orders?limit=5', weight: 3 },
    { name: 'inventory-read', path: '/inventory', weight: 1 },
  ]), { mode: 0o600 });
  server = createServer((request, response) => {
    const authorization = request.headers.authorization || '';
    observedAuth.add(authorization);
    if (request.url?.startsWith('/fail')) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('synthetic failure');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function runHarness(overrides = {}) {
  const env = {
    ...process.env,
    FACTORYOS_SOAK_BASE_URL: origin,
    FACTORYOS_SOAK_TOKENS_FILE: join(tempDir, 'tokens.json'),
    FACTORYOS_SOAK_SCENARIOS_FILE: join(tempDir, 'scenarios.json'),
    FACTORYOS_SOAK_ALLOW_REMOTE: 'false',
    FACTORYOS_SOAK_ACKNOWLEDGE_NON_PRODUCTION: 'false',
    FACTORYOS_SOAK_DURATION_SECONDS: '1',
    FACTORYOS_SOAK_CONCURRENCY: '2',
    FACTORYOS_SOAK_MAX_REQUESTS: '4',
    FACTORYOS_SOAK_RECOVERY_SECONDS: '3',
    FACTORYOS_SOAK_MAX_RECOVERY_SECONDS: '3',
    FACTORYOS_SOAK_MAX_ERROR_RATE: '0',
    ...overrides,
  };
  try {
    const result = await execFileAsync(process.execPath, [harnessPath], {
      env, timeout: 12_000, maxBuffer: 128 * 1024,
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message ?? error),
    };
  }
}

test('multi-tenant soak records per-tenant/per-scenario throughput and recovery', async () => {
  observedAuth.clear();
  const result = await runHarness();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'factoryos.capacity-soak-report/v1');
  assert.equal(report.workload, 'multi-tenant authenticated GET-only scenarios');
  assert.ok(report.load.completedRequests > 0);
  assert.equal(report.load.errorRate, 0);
  assert.equal(report.saturationRecovery.recovered, true);
  assert.equal(report.saturationRecovery.observedConsecutiveSuccesses, 3);
  assert.ok(report.saturationRecovery.timeToRecoverySeconds >= 0);
  assert.equal(report.tenantAliases.length, 2);
  assert.ok(report.load.bySyntheticTenant['synthetic-tenant-a'].requests > 0);
  assert.ok(report.load.bySyntheticTenant['synthetic-tenant-b'].requests > 0);
  assert.equal(report.load.byScenario['orders-read'].requests + report.load.byScenario['inventory-read'].requests, report.load.completedRequests);
  assert.equal(observedAuth.has('Bearer synthetic-token-secret-for-tenant-a'), true);
  assert.equal(observedAuth.has('Bearer synthetic-token-secret-for-tenant-b'), true);
  assert.equal(result.stdout.includes('synthetic-token-secret-for-tenant-a'), false);
  assert.equal(result.stdout.includes('synthetic-token-secret-for-tenant-b'), false);
  assert.equal(report.targetOrigin, origin);
});

test('remote target requires explicit non-production approval and HTTPS', async () => {
  const result = await runHarness({
    FACTORYOS_SOAK_BASE_URL: 'https://example.invalid',
    FACTORYOS_SOAK_ALLOW_REMOTE: 'false',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote target requires/);
  assert.equal(result.stdout.includes('example.invalid'), false);
});

test('soak rejects credential-bearing URLs without exposing the credential', async () => {
  const secret = 'operator-password-must-not-leak';
  const result = await runHarness({
    FACTORYOS_SOAK_BASE_URL: 'http://operator:' + secret + '@127.0.0.1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Credentials must not be embedded/);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
});

test('soak fails when non-2xx error rate exceeds the selected guardrail', async () => {
  const result = await runHarness({
    FACTORYOS_SOAK_SCENARIOS_FILE: '',
    FACTORYOS_SOAK_PATH: '/fail',
    FACTORYOS_SOAK_MAX_REQUESTS: '2',
    FACTORYOS_SOAK_CONCURRENCY: '1',
    FACTORYOS_SOAK_MAX_ERROR_RATE: '0',
    FACTORYOS_SOAK_RECOVERY_SECONDS: '1',
    FACTORYOS_SOAK_MAX_RECOVERY_SECONDS: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Load error rate exceeded/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.load.failedRequests, 2);
  assert.equal(report.load.errorRate, 1);
  assert.equal(report.saturationRecovery.recovered, false);
});

test('soak enforces an owner-selected minimum throughput', async () => {
  const result = await runHarness({
    FACTORYOS_SOAK_MAX_REQUESTS: '4',
    FACTORYOS_SOAK_CONCURRENCY: '2',
    FACTORYOS_SOAK_MIN_RPS: '1000000',
    FACTORYOS_SOAK_RECOVERY_SECONDS: '1',
    FACTORYOS_SOAK_MAX_RECOVERY_SECONDS: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Observed throughput was below FACTORYOS_SOAK_MIN_RPS/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configured.minRps, 1000000);
  assert.ok(report.load.requestsPerSecond < 1000000);
});

test('soak refuses invalid or external scenario paths before issuing traffic', async () => {
  await writeFile(join(tempDir, 'invalid-scenarios.json'), JSON.stringify([
    { name: 'escape', path: '//example.invalid/', weight: 1 },
  ]), { mode: 0o600 });
  const result = await runHarness({
    FACTORYOS_SOAK_SCENARIOS_FILE: join(tempDir, 'invalid-scenarios.json'),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Scenario path must be an absolute path/);
  assert.equal(result.stdout.includes('synthetic-token-secret-for-tenant-a'), false);
});
