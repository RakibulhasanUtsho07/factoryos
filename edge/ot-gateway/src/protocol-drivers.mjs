import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import mqtt from 'mqtt';
import ModbusRTU from 'modbus-serial';
import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSubscription,
  MessageSecurityMode,
  OPCUAClient,
  OPCUACertificateManager,
  SecurityPolicy,
  TimestampsToReturn,
  resolveNodeId,
} from 'node-opcua';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortSleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  }
  signal.addEventListener('abort', done, { once: true });
});

function scopeFor(device) {
  return { tenant_id: device.tenant_id, factory_id: device.factory_id, device_id: device.device_id };
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('observed_at is invalid');
  return new Date(value).toISOString();
}

function mqttMessageToEvent(device, topic, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 4096) throw new Error('MQTT payload exceeds the 4 KiB limit');
  const mapping = device.topics.find((entry) => entry.topic === topic);
  if (!mapping) throw new Error('MQTT topic is not on the exact device allow-list');
  let decoded;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('MQTT payload is not valid UTF-8 JSON'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('MQTT payload must be an event object');
  if (decoded.stream_key !== mapping.stream_key) throw new Error('MQTT payload stream_key did not match the registered topic mapping');
  if (typeof decoded.source_event_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(decoded.source_event_id)) {
    throw new Error('MQTT payload must include a stable source_event_id for replay-safe delivery');
  }
  if (typeof decoded.event_type !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,99}$/.test(decoded.event_type)) {
    throw new Error('MQTT event_type is invalid');
  }
  if (!decoded.payload || typeof decoded.payload !== 'object' || Array.isArray(decoded.payload)) {
    throw new Error('MQTT payload must contain a normalized payload object');
  }
  const sourceSequence = decoded.source_sequence ?? null;
  if (sourceSequence !== null && (!Number.isSafeInteger(sourceSequence) || sourceSequence < 1)) {
    throw new Error('MQTT source_sequence must be a safe positive integer');
  }
  return {
    source_event_id: decoded.source_event_id,
    event_type: decoded.event_type,
    stream_key: mapping.stream_key,
    source_sequence: sourceSequence,
    observed_at: validTimestamp(decoded.observed_at),
    payload: decoded.payload,
  };
}

/** Persists each QoS 1 message before invoking MQTT.js's delivery callback (PUBACK). */
export async function persistMqttPacket(spool, devices, packet) {
  const topic = packet?.topic;
  const device = devices.find((candidate) => candidate.topics.some((item) => item.topic === topic));
  if (!device) throw new Error('Received a message on an unregistered MQTT topic');
  const event = mqttMessageToEvent(device, topic, packet.payload);
  const result = await spool.enqueue(scopeFor(device), event);
  return { device_id: device.device_id, source_event_id: event.source_event_id, duplicate: result.duplicate };
}

export class MqttBrokerLoop extends EventEmitter {
  constructor(config, spool, secretReader) {
    super();
    this.config = config;
    this.spool = spool;
    this.secretReader = secretReader;
    this.client = null;
    this.connected = false;
    this.stopping = false;
    this.lastError = null;
    this.pending = new Set();
  }

  async start() {
    this.stopping = false;
    const [ca, cert, key] = await Promise.all([
      this.secretReader(this.config.caFile, 'MQTT CA'),
      this.secretReader(this.config.clientCertFile, 'MQTT client certificate'),
      this.secretReader(this.config.clientKeyFile, 'MQTT client key'),
    ]);
    const client = mqtt.connect(this.config.url, {
      clientId: this.config.clientId,
      protocolVersion: 5,
      clean: false,
      resubscribe: false,
      reconnectPeriod: 1000,
      connectTimeout: 10000,
      keepalive: 30,
      ca,
      cert,
      key,
      rejectUnauthorized: true,
      queueQoSZero: false,
      properties: { sessionExpiryInterval: 86400 },
    });
    this.client = client;
    client.on('connect', () => {
      if (this.stopping) return;
      this.connected = true;
      this.lastError = null;
      const subscriptions = this.config.devices.flatMap((device) => device.topics.map((entry) => ({
        topic: entry.topic,
        qos: 1,
      })));
      client.subscribe(subscriptions, (error, grants) => {
        if (error || !Array.isArray(grants) || grants.length !== subscriptions.length
            || grants.some((grant) => grant.qos !== 1)) {
          this.lastError = 'MQTT_SUBSCRIPTION_REJECTED';
          this.emit('fault', this.lastError);
          client.end(true);
          return;
        }
        this.emit('connected');
      });
    });
    client.on('reconnect', () => { this.connected = false; this.emit('reconnecting'); });
    client.on('offline', () => { this.connected = false; this.emit('offline'); });
    client.on('close', () => { this.connected = false; });
    client.on('error', () => {
      this.connected = false;
      this.lastError = 'MQTT_TRANSPORT_ERROR';
      this.emit('fault', this.lastError);
    });

    // MQTT.js calls handleMessage after parsing PUBLISH and before acknowledging
    // QoS 1. An error withholds PUBACK and forces broker redelivery.
    client.handleMessage = (packet, callback) => {
      const task = persistMqttPacket(this.spool, this.config.devices, packet)
        .then(() => callback())
        .catch(() => {
          this.lastError = 'MQTT_DURABLE_SPOOL_REJECTED';
          this.emit('fault', this.lastError);
          callback(new Error('OT durable spool rejected MQTT delivery'));
        });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    };
  }

  async stop() {
    this.stopping = true;
    this.connected = false;
    const client = this.client;
    this.client = null;
    if (client) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        client.end(true, {}, () => { clearTimeout(timer); resolve(); });
      });
    }
    await Promise.allSettled([...this.pending]);
  }

  health() {
    return { connected: this.connected, ready: this.connected && !this.lastError, errorCode: this.lastError };
  }
}

function opcUaScalar(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) throw new Error('OPC UA value is empty');
  throw new Error('OPC UA value type is not permitted by the normalized telemetry contract');
}

export class OpcUaSessionDriver extends EventEmitter {
  constructor(device, spool, secretReader, options = {}) {
    super();
    this.device = device;
    this.spool = spool;
    this.secretReader = secretReader;
    this.pkiRoot = options.pkiRoot ?? '/var/lib/factoryos-ot/pki/' + device.device_id;
    this.abortController = null;
    this.loopPromise = null;
    this.client = null;
    this.session = null;
    this.subscription = null;
    this.connected = false;
    this.lastError = null;
  }

  async start() {
    if (this.loopPromise) return;
    this.abortController = new AbortController();
    this.loopPromise = this.#run(this.abortController.signal).finally(() => { this.loopPromise = null; });
  }

  async stop() {
    this.abortController?.abort();
    const subscription = this.subscription;
    const session = this.session;
    const client = this.client;
    this.subscription = null;
    this.session = null;
    this.client = null;
    this.connected = false;
    await Promise.allSettled([
      subscription?.terminate?.(),
      session?.close?.(),
      client?.disconnect?.(),
    ].filter(Boolean));
    await this.loopPromise?.catch(() => undefined);
  }

  health() {
    return { connected: this.connected, ready: this.connected && !this.lastError, errorCode: this.lastError };
  }

  async #run(signal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const certificateManager = new OPCUACertificateManager({
          rootFolder: this.pkiRoot,
          automaticallyAcceptUnknownCertificate: false,
        });
        await certificateManager.initialize();
        await certificateManager.trustCertificate(await this.secretReader(this.device.serverCaFile, 'OPC UA server trust certificate'));
        const client = OPCUAClient.create({
          applicationName: 'FactoryOS OT Edge Gateway ' + this.device.device_key,
          connectionStrategy: { initialDelay: 500, maxRetry: 0 },
          securityMode: MessageSecurityMode.SignAndEncrypt,
          securityPolicy: SecurityPolicy.Basic256Sha256,
          certificateFile: this.device.clientCertFile,
          privateKeyFile: this.device.clientKeyFile,
          certificateManager,
          endpoint_must_exist: true,
          requestedSessionTimeout: 30000,
          keepSessionAlive: true,
          defaultSecureTokenLifetime: 60000,
        });
        this.client = client;
        await client.connect(this.device.endpointUrl);
        const session = await client.createSession();
        this.session = session;
        this.connected = true;
        this.lastError = null;
        backoff = 1000;
        this.emit('connected');

        if (this.device.mode === 'subscription' || this.device.mode === 'both') {
          const subscription = ClientSubscription.create(session, {
            requestedPublishingInterval: 1000,
            requestedLifetimeCount: 120,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 10,
          });
          this.subscription = subscription;
          await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
              if (settled) return;
              settled = true;
              subscription.removeListener('started', onStarted);
              subscription.removeListener('internal_error', onError);
              error ? reject(error) : resolve();
            };
            const onStarted = () => finish();
            const onError = () => finish(new Error('OPCUA_SUBSCRIPTION_FAILED'));
            subscription.once('started', onStarted);
            subscription.once('internal_error', onError);
          });
          for (const node of this.device.nodes) {
            const item = ClientMonitoredItem.create(
              subscription,
              { nodeId: resolveNodeId(node.nodeId), attributeId: AttributeIds.Value },
              { samplingInterval: node.samplingIntervalMs, discardOldest: true, queueSize: 100 },
              TimestampsToReturn.Both,
            );
            item.on('changed', (value) => {
              const task = this.#persistNodeValue(node, value).catch(() => {
                this.lastError = 'OPCUA_DURABLE_SPOOL_REJECTED';
                this.emit('fault', this.lastError);
              });
              void task;
            });
          }
        }

        if (this.device.mode === 'poll' || this.device.mode === 'both') {
          while (!signal.aborted && this.session === session) {
            await this.#pollOnce(session);
            await abortSleep(this.device.pollIntervalMs, signal);
          }
        } else {
          // A bounded health read detects dead sessions even when subscription
          // notifications are quiet; connection failures trigger a fresh session.
          while (!signal.aborted && this.session === session) {
            await session.readVariableValue(this.device.nodes[0].nodeId);
            await abortSleep(Math.max(1000, this.device.pollIntervalMs), signal);
          }
        }
      } catch {
        this.connected = false;
        this.lastError = 'OPCUA_SESSION_OR_CERTIFICATE_FAILURE';
        this.emit('fault', this.lastError);
      } finally {
        this.connected = false;
        const subscription = this.subscription;
        const session = this.session;
        const client = this.client;
        this.subscription = null;
        this.session = null;
        this.client = null;
        await Promise.allSettled([
          subscription?.terminate?.(),
          session?.close?.(),
          client?.disconnect?.(),
        ].filter(Boolean));
      }
      if (!signal.aborted) {
        await abortSleep(backoff, signal);
        backoff = Math.min(60000, backoff * 2);
      }
    }
  }

  async #pollOnce(session) {
    for (const node of this.device.nodes) {
      const dataValue = await session.readVariableValue(node.nodeId);
      await this.#persistNodeValue(node, dataValue);
    }
  }

  async #persistNodeValue(node, dataValue) {
    const raw = dataValue?.value?.value;
    const value = opcUaScalar(raw);
    const sourceTimestamp = dataValue?.sourceTimestamp;
    const observedAt = sourceTimestamp instanceof Date && Number.isFinite(sourceTimestamp.getTime())
      ? sourceTimestamp.toISOString() : new Date().toISOString();
    await this.spool.enqueueSample(scopeFor(this.device), {
      event_type: 'TELEMETRY',
      stream_key: node.stream_key,
      observed_at: observedAt,
      payload: { value, status_code: dataValue?.statusCode?.name ?? 'Unknown', protocol: 'OPC_UA' },
    });
  }
}

export class ModbusTcpReadDriver extends EventEmitter {
  constructor(device, spool) {
    super();
    this.device = device;
    this.spool = spool;
    this.abortController = null;
    this.loopPromise = null;
    this.connected = false;
    this.lastError = null;
    this.running = false;
  }

  async read(registers) {
    if (!Array.isArray(registers) || registers.length < 1 || registers.length > 10) {
      throw new Error('Modbus read requests are limited to 1-10 registered streams');
    }
    const mapped = registers.map((requested) => {
      const registered = this.device.register_map.find((item) => item.stream_key === requested.stream_key);
      if (!registered || registered.function_code !== requested.function_code
          || registered.address !== requested.address || registered.quantity !== requested.quantity) {
        throw new Error('Modbus read request does not match the immutable registered register map');
      }
      if (requested.function_code !== 3 && requested.function_code !== 4) throw new Error('Modbus writes are not supported');
      return registered;
    });
    if (new Set(mapped.map((item) => item.stream_key)).size !== mapped.length) throw new Error('duplicate Modbus stream keys are not allowed');
    const client = new ModbusRTU();
    client.setTimeout(this.device.timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        client.connectTCP(this.device.host, { port: this.device.port, timeout: this.device.timeoutMs }, (error) => error ? reject(error) : resolve());
      });
      client.setID(this.device.unit_id);
      this.connected = true;
      const results = [];
      for (const definition of mapped) {
        const response = definition.function_code === 3
          ? await client.readHoldingRegisters(definition.address, definition.quantity)
          : await client.readInputRegisters(definition.address, definition.quantity);
        if (!Array.isArray(response?.data) || response.data.length !== definition.quantity
            || response.data.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)) {
          throw new Error('Modbus server returned a malformed register response');
        }
        results.push({
          stream_key: definition.stream_key,
          registers: response.data,
          observed_at: new Date().toISOString(),
          source_sequence: null,
        });
      }
      this.lastError = null;
      return results;
    } catch {
      this.connected = false;
      this.lastError = 'MODBUS_TCP_READ_FAILED';
      this.emit('fault', this.lastError);
      throw new Error('Modbus TCP read failed; no write operation was attempted');
    } finally {
      await new Promise((resolve) => {
        try { client.close(() => resolve()); } catch { resolve(); }
      });
      this.connected = false;
    }
  }

  async start() {
    if (this.loopPromise) return;
    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.#poll(this.abortController.signal).finally(() => { this.loopPromise = null; });
  }

  async stop() {
    this.running = false;
    this.abortController?.abort();
    await this.loopPromise?.catch(() => undefined);
  }

  health() {
    return { connected: this.connected, ready: this.running && !this.lastError, errorCode: this.lastError };
  }

  async #poll(signal) {
    let backoff = this.device.pollIntervalMs;
    while (!signal.aborted) {
      try {
        const registers = this.device.register_map.map((item) => ({
          stream_key: item.stream_key,
          function_code: item.function_code,
          address: item.address,
          quantity: item.quantity,
        }));
        const values = await this.read(registers);
        for (const value of values) {
          const definition = this.device.register_map.find((item) => item.stream_key === value.stream_key);
          await this.spool.enqueueSample(scopeFor(this.device), {
            event_type: 'TELEMETRY',
            stream_key: value.stream_key,
            observed_at: value.observed_at,
            payload: {
              registers: value.registers,
              function_code: definition.function_code,
              address: definition.address,
              unit_id: this.device.unit_id,
              protocol: 'MODBUS_TCP',
            },
          });
        }
        backoff = this.device.pollIntervalMs;
      } catch {
        this.lastError = 'MODBUS_POLL_OR_SPOOL_FAILURE';
        this.emit('fault', this.lastError);
        backoff = Math.min(60000, Math.max(this.device.pollIntervalMs, backoff * 2));
      }
      await abortSleep(backoff, signal);
    }
  }
}
