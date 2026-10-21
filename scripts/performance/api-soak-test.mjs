#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const MAX_DURATION_SECONDS = 21_600;
const MAX_CONCURRENCY = 100;
const MAX_REQUESTS = 1_000_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RECOVERY_PROBE_INTERVAL_MS = 250;
const SUCCESS_STREAK_FOR_RECOVERY = 3;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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

async function readJsonFile(path, setting) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(setting + ' must reference a readable JSON file');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(setting + ' must contain valid JSON');
  }
}

function validateBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FACTORYOS_SOAK_BASE_URL must be a valid absolute HTTP(S) URL');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The target must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('Credentials must not be embedded in the target URL');
  if (url.search || url.hash) throw new Error('Base URL must not contain a query string or fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Put route paths in the scenario file, not the base URL');

  const remote = !LOCAL_HOSTS.has(url.hostname.toLowerCase());
  if (remote) {
    if (url.protocol !== 'https:') throw new Error('Remote soak targets must use HTTPS');
    if (process.env.FACTORYOS_SOAK_ALLOW_REMOTE !== 'true'
      || process.env.FACTORYOS_SOAK_ACKNOWLEDGE_NON_PRODUCTION !== 'true') {
      throw new Error('Remote target requires FACTORYOS_SOAK_ALLOW_REMOTE=true and FACTORYOS_SOAK_ACKNOWLEDGE_NON_PRODUCTION=true');
    }
  }
  return { origin: url.origin, url, targetClass: remote ? 'explicitly-authorized-non-production-remote' : 'local' };
}

async function loadTenantTokens() {
  const file = process.env.FACTORYOS_SOAK_TOKENS_FILE;
  if (!file) throw new Error('FACTORYOS_SOAK_TOKENS_FILE must point to a protected JSON file for synthetic tenant tokens');
  const values = await readJsonFile(file, 'FACTORYOS_SOAK_TOKENS_FILE');
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error('The token file must contain at least two synthetic tenant entries');
  }
  const seen = new Set();
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Token entry ' + index + ' must be an object');
    }
    const alias = value.tenant;
    const token = value.token;
    if (typeof alias !== 'string' || !/^synthetic-[a-z0-9_-]{1,32}$/.test(alias)) {
      throw new Error('Token aliases must use the synthetic- prefix and a bounded lowercase name');
    }
    if (seen.has(alias)) throw new Error('Token aliases must be unique');
    if (typeof token !== 'string' || token.length < 20 || /[\r\n]/.test(token)) {
      throw new Error('Each synthetic tenant token must be a non-empty bearer-token string');
    }
    seen.add(alias);
    return { alias, token };
  });
}

async function loadScenarios(origin) {
  const file = process.env.FACTORYOS_SOAK_SCENARIOS_FILE;
  const fallback = [{
    name: 'readiness',
    path: process.env.FACTORYOS_SOAK_PATH || '/api/health/ready',
    weight: 1,
  }];
  const values = file ? await readJsonFile(file, 'FACTORYOS_SOAK_SCENARIOS_FILE') : fallback;
  if (!Array.isArray(values) || values.length < 1 || values.length > 50) {
    throw new Error('The scenario file must contain between 1 and 50 GET-only read scenarios');
  }
  const seen = new Set();
  const scenarios = values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Scenario ' + index + ' must be an object');
    }
    const name = value.name;
    const path = value.path;
    const weight = value.weight === undefined ? 1 : value.weight;
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name) || seen.has(name)) {
      throw new Error('Scenario names must be unique bounded labels');
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || path.includes('\\') || path.includes('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
      throw new Error('Scenario path must be an absolute path on the selected origin, without fragments or external URLs');
    }
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
      throw new Error('Scenario weight must be an integer between 1 and 1000');
    }
    const resolved = new URL(path, origin);
    if (resolved.origin !== origin) throw new Error('Scenario escaped the selected origin');
    seen.add(name);
    return { name, path: resolved.pathname + resolved.search, weight };
  });
  return scenarios;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function summarize(latencies, completed, failed, networkErrors, statusCounts) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    completedRequests: completed,
    failedRequests: failed,
    networkErrors,
    errorRate: completed ? Number((failed / completed).toFixed(5)) : 1,
    statusCounts,
    latencyMs: {
      min: sorted.length ? Number(sorted[0].toFixed(2)) : null,
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
    },
  };
}

async function main() {
  const rawBase = process.env.FACTORYOS_SOAK_BASE_URL;
  if (!rawBase) throw new Error('Set FACTORYOS_SOAK_BASE_URL to an approved local or isolated staging API');
  const target = validateBase(rawBase);
  const candidateSha = process.env.FACTORYOS_SOAK_CANDIDATE_SHA || null;
  if (candidateSha !== null && !/^[a-f0-9]{40}$/i.test(candidateSha)) {
    throw new Error('FACTORYOS_SOAK_CANDIDATE_SHA must be a 40-character Git commit SHA');
  }
  if (target.targetClass !== 'local' && !candidateSha) {
    throw new Error('Remote soak evidence requires FACTORYOS_SOAK_CANDIDATE_SHA');
  }
  const testStartedAtUtc = new Date().toISOString();
  const tenants = await loadTenantTokens();
  const scenarios = await loadScenarios(target.origin);
  const durationSeconds = integerEnv('FACTORYOS_SOAK_DURATION_SECONDS', 60, 1, MAX_DURATION_SECONDS);
  const concurrency = integerEnv('FACTORYOS_SOAK_CONCURRENCY', 10, 1, MAX_CONCURRENCY);
  const requestCap = integerEnv('FACTORYOS_SOAK_MAX_REQUESTS', 100_000, concurrency, MAX_REQUESTS);
  const recoverySeconds = integerEnv('FACTORYOS_SOAK_RECOVERY_SECONDS', 30, 1, 300);
  const maxErrorRate = decimalEnv('FACTORYOS_SOAK_MAX_ERROR_RATE', 0.01, 0, 1);
  const maxP95Ms = process.env.FACTORYOS_SOAK_MAX_P95_MS === undefined
    ? null : decimalEnv('FACTORYOS_SOAK_MAX_P95_MS', 0, 0, 3_600_000);
  const maxP99Ms = process.env.FACTORYOS_SOAK_MAX_P99_MS === undefined
    ? null : decimalEnv('FACTORYOS_SOAK_MAX_P99_MS', 0, 0, 3_600_000);
  const maxRecoverySeconds = decimalEnv('FACTORYOS_SOAK_MAX_RECOVERY_SECONDS', 30, 0, 300);

  const scenarioTotalWeight = scenarios.reduce((total, scenario) => total + scenario.weight, 0);
  const weightedScenarios = [];
  for (const scenario of scenarios) {
    for (let index = 0; index < scenario.weight; index += 1) weightedScenarios.push(scenario);
  }

  let requestIndex = 0;
  let tenantIndex = 0;
  let scenarioIndex = 0;
  let completed = 0;
  let failed = 0;
  let networkErrors = 0;
  const latencies = [];
  const statusCounts = Object.create(null);
  const tenantCounts = Object.fromEntries(tenants.map((tenant) => [tenant.alias, { requests: 0, failures: 0 }]));
  const scenarioCounts = Object.fromEntries(scenarios.map((scenario) => [scenario.name, { requests: 0, failures: 0 }]));
  const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' };

  async function requestOne() {
    const tenant = tenants[tenantIndex % tenants.length];
    tenantIndex += 1;
    const scenario = weightedScenarios[scenarioIndex % scenarioTotalWeight];
    scenarioIndex += 1;
    tenantCounts[tenant.alias].requests += 1;
    scenarioCounts[scenario.name].requests += 1;
    const started = performance.now();
    try {
      const response = await fetch(new URL(scenario.path, target.origin), {
        method: 'GET',
        headers: { ...headers, authorization: 'Bearer ' + tenant.token },
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      latencies.push(performance.now() - started);
      const status = response.status;
      statusCounts[String(status)] = (statusCounts[String(status)] ?? 0) + 1;
      completed += 1;
      if (status < 200 || status >= 300) {
        failed += 1;
        tenantCounts[tenant.alias].failures += 1;
        scenarioCounts[scenario.name].failures += 1;
      }
    } catch (error) {
      networkErrors += 1;
      failed += 1;
      completed += 1;
      tenantCounts[tenant.alias].failures += 1;
      scenarioCounts[scenario.name].failures += 1;
      const label = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'NetworkError';
      statusCounts['network:' + label] = (statusCounts['network:' + label] ?? 0) + 1;
    }
  }

  const startedAt = performance.now();
  const deadline = startedAt + durationSeconds * 1000;
  async function worker() {
    while (performance.now() < deadline) {
      const next = requestIndex++;
      if (next >= requestCap) break;
      await requestOne();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const loadWallSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
  const loadSummary = summarize(latencies, completed, failed, networkErrors, statusCounts);
  const recoveryStartedAt = performance.now();
  const recoveryDeadline = recoveryStartedAt + recoverySeconds * 1000;
  let recoveryCompleted = 0;
  let recoveryFailed = 0;
  let recoveryNetworkErrors = 0;
  let consecutiveSuccesses = 0;
  let timeToRecoverySeconds = null;
  const recoveryLatencies = [];
  const recoveryStatusCounts = Object.create(null);
  while (performance.now() < recoveryDeadline && consecutiveSuccesses < SUCCESS_STREAK_FOR_RECOVERY) {
    const tenant = tenants[tenantIndex % tenants.length];
    tenantIndex += 1;
    const scenario = weightedScenarios[scenarioIndex % scenarioTotalWeight];
    scenarioIndex += 1;
    const started = performance.now();
    try {
      const response = await fetch(new URL(scenario.path, target.origin), {
        method: 'GET',
        headers: { ...headers, authorization: 'Bearer ' + tenant.token },
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      recoveryLatencies.push(performance.now() - started);
      recoveryStatusCounts[String(response.status)] = (recoveryStatusCounts[String(response.status)] ?? 0) + 1;
      recoveryCompleted += 1;
      if (response.status >= 200 && response.status < 300) {
        consecutiveSuccesses += 1;
      } else {
        recoveryFailed += 1;
        consecutiveSuccesses = 0;
      }
    } catch (error) {
      recoveryNetworkErrors += 1;
      recoveryFailed += 1;
      consecutiveSuccesses = 0;
      const label = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'NetworkError';
      recoveryStatusCounts['network:' + label] = (recoveryStatusCounts['network:' + label] ?? 0) + 1;
    }
    if (consecutiveSuccesses === SUCCESS_STREAK_FOR_RECOVERY) {
      timeToRecoverySeconds = Number(((performance.now() - recoveryStartedAt) / 1000).toFixed(3));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_PROBE_INTERVAL_MS));
  }
  const recoveryWallSeconds = Math.max((performance.now() - recoveryStartedAt) / 1000, 0.001);
  const recoverySummary = summarize(recoveryLatencies, recoveryCompleted, recoveryFailed, recoveryNetworkErrors, recoveryStatusCounts);
  const report = {
    schema: 'factoryos.capacity-soak-report/v1',
    candidateSha,
    startedAtUtc: testStartedAtUtc,
    finishedAtUtc: new Date().toISOString(),
    targetOrigin: target.origin,
    targetClass: target.targetClass,
    workload: 'multi-tenant authenticated GET-only scenarios',
    tenantAliases: tenants.map((tenant) => tenant.alias),
    scenarioNames: scenarios.map((scenario) => scenario.name),
    configured: {
      durationSeconds,
      concurrency,
      maxRequests: requestCap,
      recoveryWindowSeconds: recoverySeconds,
      requiredConsecutiveRecoverySuccesses: SUCCESS_STREAK_FOR_RECOVERY,
      maxErrorRate,
      maxP95Ms,
      maxP99Ms,
      maxRecoverySeconds,
      note: 'Threshold values are operator-selected guardrails, not approved FactoryOS SLOs unless the owner register is approved.',
    },
    load: {
      wallSeconds: Number(loadWallSeconds.toFixed(3)),
      requestsPerSecond: Number((completed / loadWallSeconds).toFixed(2)),
      ...loadSummary,
      bySyntheticTenant: tenantCounts,
      byScenario: scenarioCounts,
    },
    saturationRecovery: {
      wallSeconds: Number(recoveryWallSeconds.toFixed(3)),
      ...recoverySummary,
      requiredConsecutiveSuccesses: SUCCESS_STREAK_FOR_RECOVERY,
      observedConsecutiveSuccesses: consecutiveSuccesses,
      recovered: consecutiveSuccesses === SUCCESS_STREAK_FOR_RECOVERY,
      timeToRecoverySeconds,
    },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (completed === 0) throw new Error('No load requests completed; soak results cannot pass');
  if (loadSummary.errorRate > maxErrorRate) throw new Error('Load error rate exceeded FACTORYOS_SOAK_MAX_ERROR_RATE');
  if (maxP95Ms !== null && (loadSummary.latencyMs.p95 === null || loadSummary.latencyMs.p95 > maxP95Ms)) {
    throw new Error('Observed p95 exceeded FACTORYOS_SOAK_MAX_P95_MS');
  }
  if (maxP99Ms !== null && (loadSummary.latencyMs.p99 === null || loadSummary.latencyMs.p99 > maxP99Ms)) {
    throw new Error('Observed p99 exceeded FACTORYOS_SOAK_MAX_P99_MS');
  }
  if (!report.saturationRecovery.recovered || timeToRecoverySeconds === null
    || timeToRecoverySeconds > maxRecoverySeconds) {
    throw new Error('Saturation recovery did not meet FACTORYOS_SOAK_MAX_RECOVERY_SECONDS');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Capacity soak failed';
  process.stderr.write('Capacity soak failed: ' + message + '\n');
  process.exitCode = 1;
});
