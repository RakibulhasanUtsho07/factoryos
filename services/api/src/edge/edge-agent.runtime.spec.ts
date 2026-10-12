import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { EdgeAgentRuntime } from './edge-agent.runtime.js';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_TOKEN =
  `fos_edge_11111111-1111-4111-8111-111111111111.${DEVICE_ID}.${'A'.repeat(43)}`;
const LOCAL_TOKEN = 'local-spool-token-with-at-least-32-random-bytes';

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return address.port;
}

describe('EdgeAgentRuntime', () => {
  let rootDir: string;
  let cloudServer: Server;
  let runtime: EdgeAgentRuntime | null = null;
  let receivedAuthorization: string | undefined;
  let receivedUrl: string | undefined;
  let receivedBatch: unknown;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'factoryos-edge-agent-'));
    receivedAuthorization = undefined;
    receivedUrl = undefined;
    receivedBatch = undefined;
    cloudServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receivedAuthorization = request.headers.authorization;
        receivedUrl = request.url;
        receivedBatch = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: true }));
      });
    });
    await listen(cloudServer);
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop();
      runtime = null;
    }
    await new Promise<void>((resolve, reject) => {
      cloudServer.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(rootDir, { recursive: true, force: true });
  });

  it('requires local auth, durably queues a batch, uploads it with device auth, then removes it', async () => {
    runtime = new EdgeAgentRuntime({
      spoolDir: rootDir,
      localToken: LOCAL_TOKEN,
      apiBaseUrl: `http://127.0.0.1:${serverPort(cloudServer)}`,
      deviceId: DEVICE_ID,
      deviceToken: DEVICE_TOKEN,
      port: 0,
      pollIntervalMs: 60_000,
      requestTimeoutMs: 2_000,
      autoSync: false,
    });
    await runtime.start();
    const localPort = runtime.listenPort;
    expect(localPort).not.toBeNull();

    const batch = {
      batch_key: 'local-ingress-001',
      observations: [
        {
          event_id: '8b5eac9a-6d7e-4aa1-8d62-d2e8c1d60226',
          signal_key: 'line.speed',
          observed_at: '2026-10-12T01:02:03.000Z',
          source_mode: 'EDGE_OFFLINE',
          quality: 'GOOD',
          payload: { rpm: 900 },
        },
      ],
    };
    const localUrl = `http://127.0.0.1:${localPort}/v1/batches`;

    const unauthorized = await fetch(localUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(localUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LOCAL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(batch),
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({
      batchKey: 'local-ingress-001',
      accepted: true,
    });

    const repeated = await fetch(localUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LOCAL_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(batch),
    });
    expect(repeated.status).toBe(200);

    await expect(runtime.flushOnce()).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      deferred: 0,
    });
    expect(receivedAuthorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(receivedUrl).toBe(`/api/v2/edge/device-ingest/${DEVICE_ID}`);
    expect(receivedBatch).toEqual(batch);

    const health = await fetch(`http://127.0.0.1:${localPort}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      pendingBatches: 0,
      lastSyncAt: expect.any(String),
      lastDeliveryErrorCode: null,
    });
  });

  it('rejects device credentials that are not bound to the configured device', () => {
    expect(() => new EdgeAgentRuntime({
      spoolDir: rootDir,
      localToken: LOCAL_TOKEN,
      apiBaseUrl: 'https://api.factoryos.example',
      deviceId: DEVICE_ID,
      deviceToken: `fos_edge_11111111-1111-4111-8111-111111111111.33333333-3333-4333-8333-333333333333.${'A'.repeat(43)}`,
      port: 8787,
      pollIntervalMs: 5_000,
      requestTimeoutMs: 10_000,
      autoSync: false,
    })).toThrow('valid one-time issued token');
  });
});
