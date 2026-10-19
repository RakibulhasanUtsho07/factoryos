#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const MAX_DURATION_SECONDS = 600;
const MAX_CONCURRENCY = 50;
const MAX_REQUESTS = 100_000;
const REQUEST_TIMEOUT_MS = 5_000;

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function decimalEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be a finite number between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function validateTarget(rawBase, rawPath) {
  let url;
  try {
    url = new URL(rawBase);
  } catch {
    throw new Error('FACTORYOS_LOAD_BASE_URL must be a valid absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Load target must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Credentials must not be embedded in the target URL');
  }
  if (url.search || url.hash) {
    throw new Error('Base URL must not contain a query string or fragment');
  }
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) {
    throw new Error('FACTORYOS_LOAD_PATH must be an absolute path on the selected origin');
  }

  const hostname = url.hostname.toLowerCase();
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const allowRemote = process.env.FACTORYOS_LOAD_ALLOW_REMOTE === 'true';
  if (!localHostnames.has(hostname) && !allowRemote) {
    throw new Error(
      'Remote targets are disabled by default. Use an isolated staging URL and set FACTORYOS_LOAD_ALLOW_REMOTE=true deliberately.',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Set any base path in FACTORYOS_LOAD_PATH, not FACTORYOS_LOAD_BASE_URL');
  }
  url.pathname = rawPath;
  return { url, remoteAllowed: allowRemote && !localHostnames.has(hostname) };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

async function main() {
  const base = process.env.FACTORYOS_LOAD_BASE_URL;
  if (!base) {
    throw new Error('Set FACTORYOS_LOAD_BASE_URL to an approved local or isolated staging endpoint');
  }
  const path = process.env.FACTORYOS_LOAD_PATH ?? '/health';
  const { url, remoteAllowed } = validateTarget(base, path);
  const durationSeconds = integerEnv('FACTORYOS_LOAD_DURATION_SECONDS', 15, 1, MAX_DURATION_SECONDS);
  const concurrency = integerEnv('FACTORYOS_LOAD_CONCURRENCY', 5, 1, MAX_CONCURRENCY);
  const requestCap = integerEnv('FACTORYOS_LOAD_MAX_REQUESTS', MAX_REQUESTS, concurrency, MAX_REQUESTS);
  const maxErrorRate = decimalEnv('FACTORYOS_LOAD_MAX_ERROR_RATE', 0.01, 0, 1);
  const maxP95Ms = process.env.FACTORYOS_LOAD_MAX_P95_MS === undefined
    ? null
    : decimalEnv('FACTORYOS_LOAD_MAX_P95_MS', 0, 0, 3_600_000);
  const bearer = process.env.FACTORYOS_LOAD_BEARER_TOKEN;
  const requestHeaders = { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' };
  if (bearer) requestHeaders.authorization = 'Bearer ' + bearer;

  const latencies = [];
  const statusCounts = Object.create(null);
  let requestCount = 0;
  let networkErrors = 0;
  let completed = 0;
  const startedAt = performance.now();
  const deadline = startedAt + durationSeconds * 1000;

  async function worker() {
    while (performance.now() < deadline && requestCount < requestCap) {
      // JavaScript runs the increment synchronously before each worker awaits fetch.
      const current = requestCount++;
      if (current >= requestCap) break;
      const requestStarted = performance.now();
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: requestHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        statusCounts[String(status)] = (statusCounts[String(status)] ?? 0) + 1;
        latencies.push(performance.now() - requestStarted);
      } catch (error) {
        networkErrors += 1;
        const label = error && typeof error === 'object' && 'name' in error
          ? String(error.name)
          : 'NetworkError';
        statusCounts['error:' + label] = (statusCounts['error:' + label] ?? 0) + 1;
      } finally {
        completed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
  const sorted = [...latencies].sort((a, b) => a - b);
  const httpFailures = Object.entries(statusCounts)
    .filter(([status]) => /^5\d\d$/.test(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const failed = networkErrors + httpFailures;
  const errorRate = completed === 0 ? 1 : failed / completed;

  const report = {
    target: url.origin + url.pathname,
    targetClass: remoteAllowed ? 'explicitly-authorized-remote' : 'local',
    durationSeconds: Number(wallSeconds.toFixed(3)),
    configuredDurationSeconds: durationSeconds,
    concurrency,
    completedRequests: completed,
    requestsPerSecond: Number((completed / wallSeconds).toFixed(2)),
    networkErrors,
    http5xxResponses: httpFailures,
    errorRate: Number(errorRate.toFixed(5)),
    statusCounts,
    latencyMs: {
      min: sorted.length ? Number(sorted[0].toFixed(2)) : null,
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
    },
    configuredAcceptance: {
      maxErrorRate,
      maxP95Ms,
      note: 'Local smoke results are not a capacity certification or an approved production SLO.',
    },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (completed === 0) throw new Error('No requests completed; smoke run cannot pass');
  if (errorRate > maxErrorRate) {
    throw new Error('Observed HTTP 5xx/network error rate exceeded FACTORYOS_LOAD_MAX_ERROR_RATE');
  }
  if (maxP95Ms !== null && (report.latencyMs.p95 === null || report.latencyMs.p95 > maxP95Ms)) {
    throw new Error('Observed p95 latency exceeded FACTORYOS_LOAD_MAX_P95_MS');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Load smoke failed';
  process.stderr.write('Load smoke failed: ' + message + '\n');
  process.exitCode = 1;
});
