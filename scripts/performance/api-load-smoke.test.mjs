import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const harnessPath = fileURLToPath(new URL('./api-load-smoke.mjs', import.meta.url));
let server;
let origin;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/fail') {
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
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function runHarness(overrides = {}) {
  const env = {
    ...process.env,
    FACTORYOS_LOAD_BASE_URL: origin,
    FACTORYOS_LOAD_PATH: '/health',
    FACTORYOS_LOAD_ALLOW_REMOTE: 'false',
    FACTORYOS_LOAD_DURATION_SECONDS: '2',
    FACTORYOS_LOAD_CONCURRENCY: '2',
    FACTORYOS_LOAD_MAX_REQUESTS: '4',
    FACTORYOS_LOAD_MAX_ERROR_RATE: '0',
    FACTORYOS_LOAD_BEARER_TOKEN: '',
    ...overrides,
  };

  try {
    const result = await execFileAsync(process.execPath, [harnessPath], {
      env,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
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

test('bounded load smoke reports latency, status counts and request cap', async () => {
  const result = await runHarness();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.targetClass, 'local');
  assert.equal(report.completedRequests, 4);
  assert.equal(report.statusCounts['200'], 4);
  assert.equal(report.networkErrors, 0);
  assert.equal(report.http5xxResponses, 0);
  assert.equal(typeof report.latencyMs.p95, 'number');
  assert.equal(report.latencyMs.p99 >= report.latencyMs.p50, true);
});

test('load smoke fails closed for remote targets without explicit approval', async () => {
  const result = await runHarness({
    FACTORYOS_LOAD_BASE_URL: 'https://example.invalid',
    FACTORYOS_LOAD_MAX_REQUESTS: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote targets are disabled by default/);
});

test('configured 5xx error-rate guard fails a failing endpoint', async () => {
  const result = await runHarness({
    FACTORYOS_LOAD_PATH: '/fail',
    FACTORYOS_LOAD_CONCURRENCY: '1',
    FACTORYOS_LOAD_MAX_REQUESTS: '2',
    FACTORYOS_LOAD_MAX_ERROR_RATE: '0',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /error rate exceeded/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.http5xxResponses, 2);
  assert.equal(report.errorRate, 1);
});

test('load smoke rejects credential-bearing URLs without printing credentials', async () => {
  const secret = 'synthetic-password-must-not-leak';
  const result = await runHarness({
    FACTORYOS_LOAD_BASE_URL: 'http://operator:' + secret + '@127.0.0.1',
    FACTORYOS_LOAD_MAX_REQUESTS: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Credentials must not be embedded/);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
});

test('load smoke validates the request path before issuing traffic', async () => {
  const result = await runHarness({
    FACTORYOS_LOAD_PATH: '//outside.example/path',
    FACTORYOS_LOAD_MAX_REQUESTS: '1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an absolute path on the selected origin/);
});
