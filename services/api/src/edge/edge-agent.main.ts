import { homedir } from 'node:os';
import { join } from 'node:path';

import { EdgeAgentRuntime } from './edge-agent.runtime.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside the safe integer range`);
  return value;
}

async function startEdgeAgent(): Promise<void> {
  const runtime = new EdgeAgentRuntime({
    spoolDir: process.env.EDGE_SPOOL_DIR?.trim() ||
      join(homedir(), '.factoryos-edge', 'spool'),
    localToken: requiredEnvironment('EDGE_AGENT_LOCAL_TOKEN'),
    apiBaseUrl: requiredEnvironment('EDGE_API_BASE_URL'),
    deviceId: requiredEnvironment('EDGE_DEVICE_ID'),
    deviceToken: requiredEnvironment('EDGE_DEVICE_TOKEN'),
    port: integerEnvironment('EDGE_AGENT_PORT', 8787),
    pollIntervalMs: integerEnvironment('EDGE_SYNC_POLL_INTERVAL_MS', 5_000),
    requestTimeoutMs: integerEnvironment('EDGE_SYNC_TIMEOUT_MS', 10_000),
    maxPendingBytes: integerEnvironment('EDGE_SPOOL_MAX_BYTES', 512 * 1024 * 1024),
  });

  await runtime.start();
  console.info(`[factoryos-edge-agent] listening on 127.0.0.1:${runtime.listenPort}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[factoryos-edge-agent] received ${signal}; draining and closing`);
    void runtime.stop().then(
      () => {
        console.info('[factoryos-edge-agent] stopped');
      },
      () => {
        console.error('[factoryos-edge-agent] shutdown failed');
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void startEdgeAgent().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup failure';
  console.error(`[factoryos-edge-agent] startup failed: ${message}`);
  process.exitCode = 1;
});
