import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadGatewayConfig, readSecretFile, readSpoolKey, secretFingerprint, validateBearerToken, validateCertificatePair } from './config.mjs';
import { OtEdgeDurableSpool } from './spool.mjs';
import { ModbusTcpReadDriver, MqttBrokerLoop, OpcUaSessionDriver } from './protocol-drivers.mjs';

const MAX_HTTP_BODY = 16 * 1024;
const ACCEPTED_REPLAY_STATES = new Set(['ON_TIME', 'LATE', 'SEQUENCE_GAP', 'DUPLICATE_REPLAY']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function exactKeys(object, expected) {
  const keys = Object.keys(object).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function tokenMatches(supplied, expected) {
  if (!validateBearerToken(supplied) || !validateBearerToken(expected)) return false;
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

async function requireBearer(request, tokenPath) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const expected = (await readSecretFile(tokenPath, 'gateway bearer token')).toString('utf8').trim();
  return tokenMatches(header.slice(7), expected);
}

async function readBoundedJson(response, maxBytes = 32 * 1024) {
  if (!response.body) throw new Error('ACK_BODY_EMPTY');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('ACK_BODY_TOO_LARGE');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function deliverReplayBatch({ baseUrl, tokenProvider, scope, items, fetchImpl = fetch }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw new Error('REPLAY_BATCH_SIZE_INVALID');
  const base = new URL(baseUrl);
  const localDev = process.env.NODE_ENV !== 'production'
    && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.protocol === 'http:';
  if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')
      || (base.protocol !== 'https:' && !localDev)) {
    throw new Error('OT_API_URL_MUST_BE_A_FIXED_HTTPS_ORIGIN');
  }
  const expected = new Set();
  for (const item of items) {
    const id = item.event?.source_event_id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id) || expected.has(id)) {
      throw new Error('REPLAY_SOURCE_EVENT_ID_INVALID');
    }
    expected.add(id);
  }
  const token = (await tokenProvider()).trim();
  if (!validateBearerToken(token)) throw new Error('OT_API_TOKEN_NOT_CONFIGURED');
  const endpoint = new URL(base.toString());
  endpoint.pathname = '/api/ot/devices/' + encodeURIComponent(scope.device_id) + '/telemetry/batch';
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ events: items.map(({ event }) => event) }),
      signal: AbortSignal.timeout(3500),
    });
  } catch {
    throw new Error('OT_API_DELIVERY_OR_ACK_LOST');
  }
  if (!response.ok) throw new Error('OT_API_REJECTED_TELEMETRY_BATCH');
  let envelope;
  try { envelope = await readBoundedJson(response); } catch { throw new Error('OT_API_ACK_INVALID'); }
  if (envelope?.tenant_id !== scope.tenant_id || envelope?.data?.device_id !== scope.device_id
      || envelope?.data?.received !== items.length || !Array.isArray(envelope?.data?.items)
      || envelope.data.items.length !== items.length) throw new Error('OT_API_ACK_SCOPE_OR_COUNT_MISMATCH');
  const seen = new Set();
  for (const row of envelope.data.items) {
    if (!row || typeof row.source_event_id !== 'string' || !expected.has(row.source_event_id)
        || seen.has(row.source_event_id) || !ACCEPTED_REPLAY_STATES.has(row.status)) {
      throw new Error('OT_API_ACK_EVENT_OR_STATUS_MISMATCH');
    }
    seen.add(row.source_event_id);
  }
  if (seen.size !== expected.size) throw new Error('OT_API_ACK_OMITTED_EVENT');
  return [...seen];
}

export async function replayOnce(spool, config, options = {}) {
  const batch = await spool.readBatch(20, options.now ?? Date.now());
  if (!batch) return { idle: true };
  try {
    await deliverReplayBatch({
      baseUrl: config.api.baseUrl,
      tokenProvider: async () => (await readSecretFile(config.api.tokenFile, 'OT API token')).toString('utf8').trim(),
      scope: batch.scope,
      items: batch.items,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    const removed = await spool.acknowledge(batch.scope, batch.items.map((item) => ({
      source_event_id: item.event.source_event_id,
      fingerprint: item.fingerprint,
    })));
    return { delivered: removed };
  } catch {
    const retry = await spool.defer(batch.scope, batch.items.map((item) => ({
      source_event_id: item.event.source_event_id,
      fingerprint: item.fingerprint,
    })), 'TRANSPORT_OR_ACK_FAILURE');
    return { delivered: 0, deferred: retry.count, blocked: retry.blocked };
  }
}

function resolveModbusProfile(config, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !exactKeys(body, ['schema_version', 'request_id', 'protocol', 'tenant_id', 'factory_id', 'device_id',
        'device_key', 'connection_reference', 'unit_id', 'register_map'])) {
    throw new Error('REQUEST_SCHEMA_INVALID');
  }
  if (body.schema_version !== 1 || body.protocol !== 'MODBUS_TCP'
      || typeof body.request_id !== 'string' || !UUID.test(body.request_id)) throw new Error('REQUEST_ENVELOPE_INVALID');
  for (const key of ['tenant_id', 'factory_id', 'device_id']) {
    if (typeof body[key] !== 'string' || !UUID.test(body[key])) throw new Error('REQUEST_SCOPE_INVALID');
  }
  const profile = config.modbus.find((item) => item.tenant_id === body.tenant_id
    && item.factory_id === body.factory_id && item.device_id === body.device_id
    && item.device_key === body.device_key && item.connection_reference === body.connection_reference);
  if (!profile || body.unit_id !== profile.unit_id) throw new Error('UNREGISTERED_MODBUS_PROFILE');
  if (!Array.isArray(body.register_map) || body.register_map.length < 1 || body.register_map.length > 10) {
    throw new Error('REGISTER_MAP_REQUEST_SIZE_INVALID');
  }
  const registers = body.register_map.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || !exactKeys(item, ['stream_key', 'function_code', 'address', 'quantity'])) {
      throw new Error('REGISTER_REQUEST_SCHEMA_INVALID');
    }
    if (item.function_code !== 3 && item.function_code !== 4) throw new Error('MODBUS_WRITE_FUNCTION_FORBIDDEN');
    const configured = profile.register_map.find((entry) => entry.stream_key === item.stream_key);
    if (!configured || configured.function_code !== item.function_code
        || configured.address !== item.address || configured.quantity !== item.quantity) {
      throw new Error('REGISTER_REQUEST_NOT_IN_APPROVED_MAP');
    }
    return {
      stream_key: configured.stream_key,
      function_code: configured.function_code,
      address: configured.address,
      quantity: configured.quantity,
    };
  });
  if (new Set(registers.map((item) => item.stream_key)).size !== registers.length) throw new Error('DUPLICATE_STREAM_KEY');
  return { profile, registers, requestId: body.request_id };
}

function allSecretPaths(config) {
  return [
    config.security.serverCertFile,
    config.security.serverKeyFile,
    ...(config.mqtt ? [config.mqtt.caFile, config.mqtt.clientCertFile, config.mqtt.clientKeyFile] : []),
    ...config.opcua.flatMap((device) => [device.serverCaFile, device.clientCertFile, device.clientKeyFile]),
  ];
}

class ProtocolSupervisor {
  constructor(config, spool) {
    this.config = config;
    this.spool = spool;
    this.mqtt = null;
    this.opcua = [];
    this.modbus = [];
    this.lastRotationAt = null;
    this.rotationFingerprint = null;
    this.started = false;
    this.lastError = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.#startDrivers();
    this.rotationFingerprint = await secretFingerprint(allSecretPaths(this.config));
  }

  async stop() {
    this.started = false;
    const drivers = [this.mqtt, ...this.opcua, ...this.modbus].filter(Boolean);
    this.mqtt = null;
    this.opcua = [];
    this.modbus = [];
    await Promise.allSettled(drivers.map((driver) => driver.stop()));
  }

  health() {
    const mqttHealth = this.mqtt?.health() ?? null;
    const opcuaHealth = this.opcua.map((driver, index) => ({ device_id: this.config.opcua[index]?.device_id, ...driver.health() }));
    const modbusHealth = this.modbus.map((driver, index) => ({ device_id: this.config.modbus[index]?.device_id, ...driver.health() }));
    const ready = (!mqttHealth || mqttHealth.ready)
      && opcuaHealth.every((driver) => driver.ready)
      && modbusHealth.every((driver) => driver.ready);
    return {
      ready,
      mqtt: mqttHealth,
      opcua: opcuaHealth,
      modbus: modbusHealth,
      lastRotationAt: this.lastRotationAt,
      errorCode: this.lastError,
    };
  }

  async checkRotation(server) {
    if (!this.started) return;
    let next;
    try { next = await secretFingerprint(allSecretPaths(this.config)); }
    catch {
      this.lastError = 'SECRET_ROTATION_FILE_UNAVAILABLE';
      return;
    }
    if (next === this.rotationFingerprint) return;
    try {
      const [cert, key] = await Promise.all([
        readSecretFile(this.config.security.serverCertFile, 'gateway TLS certificate'),
        readSecretFile(this.config.security.serverKeyFile, 'gateway TLS private key'),
      ]);
      validateCertificatePair(cert, key, 'gateway HTTPS');
      server.setSecureContext({ cert, key, ...(this.config.security.clientCaFile ? {
        ca: await readSecretFile(this.config.security.clientCaFile, 'gateway client CA'),
      } : {}) });
      await this.#restartDrivers();
      this.rotationFingerprint = next;
      this.lastRotationAt = new Date().toISOString();
      this.lastError = null;
    } catch {
      this.lastError = 'SECRET_ROTATION_REJECTED';
    }
  }

  async #restartDrivers() {
    await this.#stopDrivers();
    await this.#startDrivers();
  }

  async #stopDrivers() {
    const drivers = [this.mqtt, ...this.opcua, ...this.modbus].filter(Boolean);
    this.mqtt = null;
    this.opcua = [];
    this.modbus = [];
    await Promise.allSettled(drivers.map((driver) => driver.stop()));
  }

  async #startDrivers() {
    if (this.config.mqtt) {
      const driver = new MqttBrokerLoop(this.config.mqtt, this.spool, readSecretFile);
      driver.on('fault', (code) => { this.lastError = code; });
      this.mqtt = driver;
      await driver.start();
    }
    this.opcua = this.config.opcua.map((device) => {
      const driver = new OpcUaSessionDriver(device, this.spool, readSecretFile);
      driver.on('fault', (code) => { this.lastError = code; });
      void driver.start();
      return driver;
    });
    this.modbus = this.config.modbus.map((device) => {
      const driver = new ModbusTcpReadDriver(device, this.spool);
      driver.on('fault', (code) => { this.lastError = code; });
      void driver.start();
      return driver;
    });
  }
}

export async function startGateway(config) {
  const spoolKey = await readSpoolKey(config.security.spoolKeyFile);
  const spool = new OtEdgeDurableSpool(config.spoolFile ?? '/var/lib/factoryos-ot/spool.enc', spoolKey, {
    maxEntries: config.spool?.maxEntries ?? 10000,
    maxPlaintextBytes: config.spool?.maxPlaintextBytes ?? 64 * 1024 * 1024,
  });
  await spool.pendingCount(); // decrypt/recovery validation before declaring the gateway live
  const supervisor = new ProtocolSupervisor(config, spool);
  const [cert, key] = await Promise.all([
    readSecretFile(config.security.serverCertFile, 'gateway TLS certificate'),
    readSecretFile(config.security.serverKeyFile, 'gateway TLS private key'),
  ]);
  validateCertificatePair(cert, key, 'gateway HTTPS');
  const initialApiToken = (await readSecretFile(config.api.tokenFile, 'OT API token')).toString('utf8').trim();
  if (!validateBearerToken(initialApiToken)) throw new Error('OT API token is invalid');
  const initialGatewayToken = (await readSecretFile(config.security.bearerTokenFile, 'gateway bearer token')).toString('utf8').trim();
  if (!validateBearerToken(initialGatewayToken)) throw new Error('gateway bearer token is invalid');
  await supervisor.start();
  const tlsOptions = { cert, key };
  if (config.security.clientCaFile) {
    tlsOptions.ca = await readSecretFile(config.security.clientCaFile, 'gateway client CA');
    tlsOptions.requestCert = true;
    // Health probes still need to finish TLS. Application endpoints enforce the
    // client certificate before processing any protocol read request.
    tlsOptions.rejectUnauthorized = false;
  }
  let httpReady = true;
  let shuttingDown = false;
  const server = https.createServer(tlsOptions, async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://gateway.invalid');
    try {
      if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
        const driverHealth = supervisor.health();
        const ready = httpReady && !shuttingDown && driverHealth.ready;
        const health = {
          status: shuttingDown ? 'stopping' : (ready ? 'ready' : 'not_ready'),
          gateway_id: config.gatewayId,
          protocol_drivers: driverHealth,
          spool: await spool.stats(),
          observed_at: new Date().toISOString(),
        };
        return jsonResponse(response, url.pathname === '/readyz' && !ready ? 503 : 200, health);
      }
      if (request.method !== 'POST' || url.pathname !== '/api/v1/modbus/read') {
        return jsonResponse(response, 404, { error: 'NOT_FOUND' });
      }
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return jsonResponse(response, 415, { error: 'JSON_REQUIRED' });
      }
      if (config.security.clientCaFile && request.socket.authorized !== true) {
        return jsonResponse(response, 401, { error: 'CLIENT_CERTIFICATE_REQUIRED' });
      }
      if (!(await requireBearer(request, config.security.bearerTokenFile))) {
        return jsonResponse(response, 401, { error: 'UNAUTHORIZED' });
      }
      const body = JSON.parse(await readBody(request));
      const resolved = resolveModbusProfile(config, body);
      const driver = supervisor.modbus.find((candidate) => candidate.device.device_id === resolved.profile.device_id);
      if (!driver) return jsonResponse(response, 503, { error: 'MODBUS_DRIVER_NOT_REGISTERED' });
      const results = await driver.read(resolved.registers);
      return jsonResponse(response, 200, {
        schema_version: 1,
        request_id: resolved.requestId,
        results,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REQUEST_FAILED';
      if (code === 'REQUEST_TOO_LARGE') return jsonResponse(response, 413, { error: code });
      if (code === 'UNAUTHORIZED') return jsonResponse(response, 401, { error: code });
      if (code.startsWith('REQUEST_') || code.startsWith('REGISTER_') || code.startsWith('MODBUS_WRITE')
          || code.startsWith('DUPLICATE_') || code.startsWith('UNREGISTERED_')) {
        return jsonResponse(response, 400, { error: code });
      }
      if (code === 'MODBUS_TCP_READ_FAILED') return jsonResponse(response, 502, { error: code });
      return jsonResponse(response, 400, { error: 'INVALID_OT_GATEWAY_REQUEST' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  let replayLoop = false;
  async function replayCycle() {
    if (replayLoop || shuttingDown) return;
    replayLoop = true;
    try { await replayOnce(spool, config); }
    catch { /* durable spool remains the source of truth; health exposes backlog age */ }
    finally { replayLoop = false; }
  }
  const replayTimer = setInterval(() => { void replayCycle(); }, config.replayIntervalMs ?? 1000);
  replayTimer.unref();
  const rotationTimer = setInterval(() => { void supervisor.checkRotation(server); }, config.rotationCheckMs ?? 30000);
  rotationTimer.unref();
  void replayCycle();

  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    httpReady = false;
    clearInterval(replayTimer);
    clearInterval(rotationTimer);
    await supervisor.stop();
    await new Promise((resolve) => server.close(() => resolve()));
    spoolKey.fill(0);
  };
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
  return { server, spool, supervisor, stop };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    const config = await loadGatewayConfig();
    await startGateway(config);
    // Logging is intentionally limited to identifiers/state, never payloads or key material.
    process.stdout.write(JSON.stringify({
      event: 'ot_gateway_started',
      gateway_id: config.gatewayId,
      listen_port: config.listen.port,
    }) + '\n');
  } catch (error) {
    const code = error instanceof Error ? error.message : 'STARTUP_FAILED';
    process.stderr.write(JSON.stringify({ event: 'ot_gateway_startup_failed', code }) + '\n');
    process.exitCode = 1;
  }
}
