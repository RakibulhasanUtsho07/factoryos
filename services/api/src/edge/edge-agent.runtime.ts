import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { DurableEdgeSpool, EdgeSpoolError } from './spool/durable-edge-spool.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN_PATTERN =
  /^fos_edge_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;
const DEFAULT_MAX_PENDING_BYTES = 512 * 1024 * 1024;

export interface EdgeAgentRuntimeConfig {
  spoolDir: string;
  localToken: string;
  apiBaseUrl: string;
  deviceId: string;
  deviceToken: string;
  port: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  maxPendingBytes?: number;
  autoSync?: boolean;
  agentVersion?: string;
  healthReportIntervalMs?: number;
  modelVersions?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  driftSignals?: Array<Record<string, unknown>>;
}

export interface EdgeAgentHealth {
  status: 'ok';
  pendingBatches: number;
  pendingBytes: number;
  oldestPendingAt: string | null;
  lastSyncAt: string | null;
  lastDeliveryErrorCode: string | null;
  agentVersion: string;
  lastHealthReportAt: string | null;
  lastHealthErrorCode: string | null;
}

export interface EdgeAgentFlushResult {
  attempted: number;
  delivered: number;
  deferred: number;
}

class RequestTooLargeError extends Error {}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
    } else if (!tooLarge) {
      chunks.push(chunk);
    }
  }
  if (tooLarge) throw new RequestTooLargeError('Request body is too large');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function getBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

export class EdgeAgentRuntime {
  private readonly spool: DurableEdgeSpool;
  private readonly apiBaseUrl: URL;
  private readonly expectedLocalToken: Buffer;
  private server: Server | null = null;
  private workerPromise: Promise<void> | null = null;
  private stopping = false;
  private started = false;
  private lastSyncAt: string | null = null;
  private lastHealthAttemptAt = 0;
  private lastHealthReportAt: string | null = null;
  private lastHealthErrorCode: string | null = null;
  private lastDeliveryErrorCode: string | null = null;

  constructor(private readonly config: EdgeAgentRuntimeConfig) {
    if (!UUID_PATTERN.test(config.deviceId)) {
      throw new Error('EDGE_DEVICE_ID must be a UUID');
    }
    const deviceToken = DEVICE_TOKEN_PATTERN.exec(config.deviceToken);
    if (!deviceToken || deviceToken[2].toLowerCase() !== config.deviceId.toLowerCase()) {
      throw new Error('EDGE_DEVICE_TOKEN must be a valid one-time issued token for EDGE_DEVICE_ID');
    }
    if (Buffer.byteLength(config.localToken, 'utf8') < 32) {
      throw new Error('EDGE_AGENT_LOCAL_TOKEN must contain at least 32 bytes of random material');
    }
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
      throw new Error('EDGE_AGENT_PORT must be an integer between 0 and 65535');
    }
    if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 250) {
      throw new Error('EDGE_SYNC_POLL_INTERVAL_MS must be an integer of at least 250');
    }
    if (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 500 ||
        config.requestTimeoutMs > 60_000) {
      throw new Error('EDGE_SYNC_TIMEOUT_MS must be between 500 and 60000');
    }
    const agentVersion = config.agentVersion ?? '1.0.0';
    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(agentVersion)) {
      throw new Error('EDGE_AGENT_VERSION is invalid');
    }
    const healthReportIntervalMs = config.healthReportIntervalMs ?? 30_000;
    if (!Number.isInteger(healthReportIntervalMs) || healthReportIntervalMs < 10_000 ||
        healthReportIntervalMs > 3_600_000) {
      throw new Error('EDGE_HEALTH_REPORT_INTERVAL_MS must be between 10000 and 3600000');
    }

    this.apiBaseUrl = new URL(config.apiBaseUrl);
    if (
      this.apiBaseUrl.username ||
      this.apiBaseUrl.password ||
      this.apiBaseUrl.search ||
      this.apiBaseUrl.hash ||
      this.apiBaseUrl.pathname !== '/' ||
      (this.apiBaseUrl.protocol !== 'https:' &&
        !(this.apiBaseUrl.protocol === 'http:' && isLoopback(this.apiBaseUrl.hostname)))
    ) {
      throw new Error('EDGE_API_BASE_URL must be an HTTPS origin (HTTP is allowed only for loopback tests)');
    }

    this.expectedLocalToken = Buffer.from(config.localToken, 'utf8');
    this.spool = new DurableEdgeSpool(config.spoolDir, {
      maxPendingBytes: config.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
    });
  }

  get listenPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.spool.initialize();
    try {
      this.lastSyncAt = (await this.spool.status()).lastSuccessfulSyncAt;
      this.server = createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            sendJson(response, 500, { error: 'EDGE_AGENT_INTERNAL_ERROR' });
          } else {
            response.destroy();
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const server = this.server;
        if (!server) return reject(new Error('Edge agent server was not created'));
        let onListening: () => void = () => undefined;
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.config.port, '127.0.0.1');
      });
      this.started = true;
      this.stopping = false;
      if (this.config.autoSync !== false) {
        this.workerPromise = this.runWorker();
      }
    } catch (error) {
      this.server?.close(() => undefined);
      this.server = null;
      await this.spool.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (this.workerPromise) {
      await this.workerPromise;
      this.workerPromise = null;
    }
    await this.spool.close();
    this.started = false;
  }

  async reportHealthOnce(): Promise<boolean> {
    this.lastHealthAttemptAt = Date.now();
    try {
      const spoolStatus = await this.spool.status();
      const reportTime = new Date().toISOString();
      const maxPendingBytes = this.config.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
      const highWatermark = spoolStatus.pendingBatches >= 9_000 ||
        spoolStatus.pendingBytes >= Math.floor(maxPendingBytes * 0.9);
      const report = {
        health_event_id: randomUUID(),
        reported_at: reportTime,
        agent_version: this.config.agentVersion ?? '1.0.0',
        runtime_status: highWatermark ? 'DEGRADED' : 'HEALTHY',
        pending_batches: spoolStatus.pendingBatches,
        pending_bytes: spoolStatus.pendingBytes,
        last_successful_sync_at: this.lastSyncAt,
        model_versions: this.config.modelVersions ?? {},
        drift_signals: this.config.driftSignals ?? [],
        capabilities: this.config.capabilities ?? {
          runtime: 'node',
          os: process.platform,
          architecture: process.arch,
        },
      };
      const url = new URL(
        `/api/v2/edge/device-health/${encodeURIComponent(this.config.deviceId)}`,
        this.apiBaseUrl,
      );
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.deviceToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        this.lastHealthErrorCode = `HTTP_${response.status}`;
        return false;
      }
      this.lastHealthReportAt = reportTime;
      this.lastHealthErrorCode = null;
      return true;
    } catch (error) {
      this.lastHealthErrorCode =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'REQUEST_TIMEOUT'
          : 'NETWORK_ERROR';
      return false;
    }
  }

  async flushOnce(): Promise<EdgeAgentFlushResult> {
    const ready = await this.spool.listReady(10);
    let attempted = 0;
    let delivered = 0;
    let deferred = 0;

    for (const queued of ready) {
      attempted += 1;
      const batchKey = queued.batch.batch_key;
      try {
        const url = new URL(
          `/api/v2/edge/device-ingest/${encodeURIComponent(this.config.deviceId)}`,
          this.apiBaseUrl,
        );
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.deviceToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(queued.batch),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
          redirect: 'error',
        });
        // Do not retain unconsumed response streams in this long-running edge process.
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) {
          const failureCode = `HTTP_${response.status}`;
          await this.spool.recordFailure(batchKey, failureCode);
          this.lastDeliveryErrorCode = failureCode;
          deferred += 1;
          // A credential, scope, or availability error applies to later batches too.
          break;
        }

        const successfulSyncAt = new Date().toISOString();
        await this.spool.markSuccessfulSync(successfulSyncAt);
        await this.spool.acknowledge(batchKey);
        this.lastSyncAt = successfulSyncAt;
        this.lastDeliveryErrorCode = null;
        delivered += 1;
      } catch (error) {
        const failureCode =
          error instanceof Error && error.name === 'TimeoutError'
            ? 'REQUEST_TIMEOUT'
            : 'NETWORK_ERROR';
        await this.spool.recordFailure(batchKey, failureCode);
        this.lastDeliveryErrorCode = failureCode;
        deferred += 1;
        break;
      }
    }
    return { attempted, delivered, deferred };
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      const status = await this.spool.status();
      const health: EdgeAgentHealth = {
        status: 'ok',
        ...status,
        lastSyncAt: this.lastSyncAt,
        lastDeliveryErrorCode: this.lastDeliveryErrorCode,
        agentVersion: this.config.agentVersion ?? '1.0.0',
        lastHealthReportAt: this.lastHealthReportAt,
        lastHealthErrorCode: this.lastHealthErrorCode,
      };
      sendJson(response, 200, health);
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/batches') {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }
    if (!this.authorizeLocalRequest(request)) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    let input: unknown;
    try {
      input = await readJsonBody(request, 64 * 1024);
    } catch (error) {
      sendJson(response, error instanceof RequestTooLargeError ? 413 : 400, {
        error: error instanceof RequestTooLargeError ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
      });
      return;
    }

    try {
      const queued = await this.spool.enqueue(input);
      sendJson(response, queued.idempotent ? 200 : 202, {
        batchKey: queued.batchKey,
        idempotent: queued.idempotent,
        accepted: true,
      });
    } catch (error) {
      if (!(error instanceof EdgeSpoolError)) {
        sendJson(response, 500, { error: 'SPOOL_INTERNAL_ERROR' });
        return;
      }
      const statusByCode: Record<string, number> = {
        INVALID_BATCH: 400,
        BATCH_CONFLICT: 409,
        CAPACITY_EXCEEDED: 507,
        SPOOL_LOCKED: 423,
        SPOOL_CORRUPT: 500,
        SPOOL_NOT_INITIALIZED: 500,
      };
      sendJson(response, statusByCode[error.code] ?? 500, { error: error.code });
    }
  }

  private authorizeLocalRequest(request: IncomingMessage): boolean {
    const suppliedValue = getBearerToken(request);
    if (!suppliedValue) return false;
    const supplied = Buffer.from(suppliedValue, 'utf8');
    return supplied.length === this.expectedLocalToken.length &&
      timingSafeEqual(supplied, this.expectedLocalToken);
  }

  private async runWorker(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.flushOnce();
      } catch {
        this.lastDeliveryErrorCode = 'SPOOL_ERROR';
      }
      const healthInterval = this.config.healthReportIntervalMs ?? 30_000;
      if (!this.stopping && Date.now() - this.lastHealthAttemptAt >= healthInterval) {
        await this.reportHealthOnce();
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }
}
