import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STREAM = /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/;
const SECRET_ROOTS = ['/run/secrets/', '/etc/factoryos/secrets/'];

function ensure(condition, message) {
  if (!condition) throw new Error('OT gateway configuration: ' + message);
}

function exactTopic(topic) {
  return typeof topic === 'string' && topic.length >= 1 && topic.length <= 256
    && /^[A-Za-z0-9_./:-]+$/.test(topic) && !topic.includes('..')
    && !topic.startsWith('$SYS/') && !topic.includes('+') && !topic.includes('#');
}

function endpointKey(protocol, hostname, port) {
  return protocol + '://' + hostname.toLowerCase() + ':' + String(port);
}

function configuredEndpoint(urlString, protocol, production) {
  let url;
  try { url = new URL(urlString); } catch { throw new Error('invalid ' + protocol + ' endpoint URL'); }
  ensure(!url.username && !url.password && !url.search && !url.hash, protocol + ' endpoint must not contain credentials/query/fragment');
  if (protocol === 'mqtts') ensure(url.protocol === 'mqtts:', 'MQTT broker must use mqtts in this gateway');
  if (protocol === 'mqtt') {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    ensure(!production && loopback && url.protocol === 'mqtt:', 'plaintext MQTT is allowed only on loopback in development');
  }
  if (protocol === 'opc.tcp') ensure(url.protocol === 'opc.tcp:', 'OPC UA endpoint must use opc.tcp');
  if (protocol === 'https') {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    ensure(url.protocol === 'https:' || (!production && loopback && url.protocol === 'http:'), 'API replay requires HTTPS outside loopback development');
  }
  const defaultPort = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : protocol === 'opc.tcp' ? 4840 : protocol === 'https' ? 443 : undefined;
  return endpointKey(protocol, url.hostname, Number(url.port || defaultPort));
}

function validateApprovedTarget(key, approved) {
  ensure(approved.includes(key), 'target ' + key + ' is not present in approvedTargets');
}

function validatePath(path, label, production) {
  ensure(typeof path === 'string' && path.length > 0 && path.length <= 512, label + ' path is required');
  ensure(path.startsWith('/'), label + ' path must be absolute');
  const normalized = resolve(path);
  if (production) {
    ensure(SECRET_ROOTS.some((root) => normalized.startsWith(root)), label + ' must be mounted under /run/secrets or /etc/factoryos/secrets');
  }
  return normalized;
}

function validateRegisterMap(map, label) {
  ensure(Array.isArray(map) && map.length >= 1 && map.length <= 20, label + ' must contain 1-20 registers');
  const keys = new Set();
  for (const item of map) {
    ensure(item && typeof item === 'object' && !Array.isArray(item), label + ' entry must be an object');
    ensure(typeof item.stream_key === 'string' && STREAM.test(item.stream_key), label + ' stream_key is invalid');
    ensure(!keys.has(item.stream_key), label + ' stream_key values must be unique');
    keys.add(item.stream_key);
    ensure(item.function_code === 3 || item.function_code === 4, 'gateway only allows Modbus read function 3/4');
    ensure(Number.isInteger(item.address) && item.address >= 0 && item.address <= 65535, 'Modbus address is invalid');
    ensure(Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 125, 'Modbus quantity is invalid');
    ensure(item.address + item.quantity <= 65536, 'Modbus range overflows');
  }
}

export function validateGatewayConfig(config, env = process.env) {
  const production = env.NODE_ENV === 'production';
  ensure(config && typeof config === 'object' && !Array.isArray(config), 'root must be an object');
  ensure(typeof config.gatewayId === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(config.gatewayId), 'gatewayId is invalid');
  ensure(config.listen && typeof config.listen === 'object', 'listen section is required');
  ensure(Number.isInteger(config.listen.port) && config.listen.port >= 1024 && config.listen.port <= 65535, 'listen.port must be 1024-65535');
  ensure(config.security && typeof config.security === 'object', 'security section is required');
  for (const field of ['serverCertFile', 'serverKeyFile', 'bearerTokenFile', 'spoolKeyFile']) {
    config.security[field] = validatePath(config.security[field], 'security.' + field, production);
  }
  if (config.security.clientCaFile) config.security.clientCaFile = validatePath(config.security.clientCaFile, 'security.clientCaFile', production);
  ensure(config.api && typeof config.api === 'object', 'api section is required');
  config.api.tokenFile = validatePath(config.api.tokenFile, 'api.tokenFile', production);
  const apiTarget = configuredEndpoint(config.api.baseUrl, 'https', production);
  const apiUrl = new URL(config.api.baseUrl);
  ensure(apiUrl.pathname === '' || apiUrl.pathname === '/', 'api.baseUrl must be an origin without a path');
  ensure(Array.isArray(config.security.approvedTargets), 'security.approvedTargets allow-list is required');
  for (const target of config.security.approvedTargets) ensure(typeof target === 'string' && target.length <= 300, 'approved target entry is invalid');

  config.opcua ??= [];
  config.mqtt ??= null;
  config.modbus ??= [];
  ensure(Array.isArray(config.opcua) && config.opcua.length <= 100, 'opcua must be an array of at most 100 profiles');
  ensure(Array.isArray(config.modbus) && config.modbus.length <= 100, 'modbus must be an array of at most 100 profiles');

  const registered = new Set();
  const checkIdentity = (device, protocol) => {
    ensure(device && typeof device === 'object' && !Array.isArray(device), protocol + ' profile must be an object');
    for (const key of ['tenant_id', 'factory_id', 'device_id']) ensure(typeof device[key] === 'string' && UUID.test(device[key]), protocol + ' profile ' + key + ' must be a UUID');
    ensure(typeof device.device_key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(device.device_key), protocol + ' device_key is invalid');
    ensure(typeof device.connection_reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(device.connection_reference), protocol + ' connection_reference must be an opaque identifier');
    const scopeKey = [device.tenant_id, device.factory_id, device.device_id, device.connection_reference].join(':');
    ensure(!registered.has(scopeKey), 'duplicate device identity/connection profile');
    registered.add(scopeKey);
  };

  if (config.mqtt) {
    const brokerTarget = configuredEndpoint(config.mqtt.url, config.mqtt.url.startsWith('mqtts:') ? 'mqtts' : 'mqtt', production);
    validateApprovedTarget(brokerTarget, config.security.approvedTargets);
    ensure(typeof config.mqtt.clientId === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(config.mqtt.clientId), 'MQTT clientId is invalid');
    config.mqtt.caFile = validatePath(config.mqtt.caFile, 'mqtt.caFile', production);
    config.mqtt.clientCertFile = validatePath(config.mqtt.clientCertFile, 'mqtt.clientCertFile', production);
    config.mqtt.clientKeyFile = validatePath(config.mqtt.clientKeyFile, 'mqtt.clientKeyFile', production);
    ensure(Array.isArray(config.mqtt.devices) && config.mqtt.devices.length <= 1000, 'MQTT devices must be an array');
    for (const device of config.mqtt.devices) {
      checkIdentity(device, 'MQTT');
      ensure(Array.isArray(device.topics) && device.topics.length >= 1 && device.topics.length <= 20, 'MQTT topics must contain 1-20 exact subscriptions');
      const topics = new Set();
      for (const item of device.topics) {
        ensure(item && exactTopic(item.topic), 'MQTT wildcard/system topics are forbidden');
        ensure(typeof item.stream_key === 'string' && STREAM.test(item.stream_key), 'MQTT stream_key is invalid');
        ensure(item.qos === 1, 'MQTT QoS 1 is required to permit durable acknowledgement');
        ensure(!topics.has(item.topic), 'duplicate exact MQTT topic');
        topics.add(item.topic);
      }
    }
  }

  for (const device of config.opcua) {
    checkIdentity(device, 'OPC UA');
    const target = configuredEndpoint(device.endpointUrl, 'opc.tcp', production);
    validateApprovedTarget(target, config.security.approvedTargets);
    ensure(device.securityMode === 'SignAndEncrypt' && device.securityPolicy === 'Basic256Sha256', 'OPC UA must use SignAndEncrypt with Basic256Sha256');
    device.clientCertFile = validatePath(device.clientCertFile, 'OPC UA clientCertFile', production);
    device.clientKeyFile = validatePath(device.clientKeyFile, 'OPC UA clientKeyFile', production);
    device.serverCaFile = validatePath(device.serverCaFile, 'OPC UA serverCaFile', production);
    ensure(['subscription', 'poll', 'both'].includes(device.mode), 'OPC UA mode must be subscription, poll or both');
    ensure(Number.isInteger(device.pollIntervalMs) && device.pollIntervalMs >= 250 && device.pollIntervalMs <= 60000, 'OPC UA pollIntervalMs must be 250-60000');
    ensure(Array.isArray(device.nodes) && device.nodes.length >= 1 && device.nodes.length <= 200, 'OPC UA nodes must contain 1-200 definitions');
    const seen = new Set();
    for (const node of device.nodes) {
      ensure(node && typeof node.nodeId === 'string' && node.nodeId.length <= 512 && /^ns=\d+;[isgb]=/.test(node.nodeId), 'OPC UA nodeId must be an explicit namespace-qualified NodeId');
      ensure(typeof node.stream_key === 'string' && STREAM.test(node.stream_key), 'OPC UA stream_key is invalid');
      ensure(!seen.has(node.stream_key), 'OPC UA stream_key values must be unique');
      seen.add(node.stream_key);
      node.samplingIntervalMs ??= device.pollIntervalMs;
      ensure(Number.isInteger(node.samplingIntervalMs) && node.samplingIntervalMs >= 100 && node.samplingIntervalMs <= 60000, 'OPC UA samplingIntervalMs must be 100-60000');
    }
  }

  for (const device of config.modbus) {
    checkIdentity(device, 'Modbus');
    ensure(typeof device.host === 'string' && device.host.length <= 253 && !/[\s/\\]/.test(device.host), 'Modbus target host is invalid');
    ensure(Number.isInteger(device.port) && device.port >= 1 && device.port <= 65535, 'Modbus target port is invalid');
    const target = endpointKey('modbus.tcp', device.host, device.port);
    validateApprovedTarget(target, config.security.approvedTargets);
    ensure(Number.isInteger(device.unit_id) && device.unit_id >= 1 && device.unit_id <= 247, 'Modbus unit_id must be 1-247');
    ensure(Number.isInteger(device.pollIntervalMs) && device.pollIntervalMs >= 500 && device.pollIntervalMs <= 60000, 'Modbus pollIntervalMs must be 500-60000');
    ensure(Number.isInteger(device.timeoutMs) && device.timeoutMs >= 100 && device.timeoutMs <= 5000, 'Modbus timeoutMs must be 100-5000');
    validateRegisterMap(device.register_map, 'Modbus register_map');
  }

  ensure(config.security.approvedTargets.includes(apiTarget) || apiTarget.startsWith('https://localhost:')
    || apiTarget.startsWith('https://127.0.0.1:'), 'API target must appear in approvedTargets');
  return config;
}

export async function loadGatewayConfig(path = process.env.FACTORYOS_OT_GATEWAY_CONFIG ?? '/etc/factoryos/gateway.json') {
  const resolved = resolve(path);
  const raw = await readFile(resolved, 'utf8');
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('OT gateway configuration must be valid JSON'); }
  return validateGatewayConfig(config);
}

export async function readSecretFile(path, label = 'secret') {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(label + ' must be an absolute secret-file path');
  const resolved = resolve(path);
  if (process.env.NODE_ENV === 'production' && !SECRET_ROOTS.some((root) => resolved.startsWith(root))) {
    throw new Error(label + ' is not mounted under the approved secret directory');
  }
  const fileStat = await stat(resolved);
  if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > 1024 * 1024) throw new Error(label + ' file must be a non-empty file no larger than 1 MiB');
  return readFile(resolved);
}

export async function readSpoolKey(path) {
  const raw = (await readSecretFile(path, 'spool key')).toString('utf8').trim();
  let key;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else if (/^(?:base64:)?[A-Za-z0-9+/]{43}=?$/.test(raw)) key = Buffer.from(raw.replace(/^base64:/, ''), 'base64');
  else throw new Error('spool key file must contain exactly 32 bytes as 64 hex digits or base64');
  if (key.length !== 32) throw new Error('spool key must decode to 32 bytes');
  return key;
}

export async function secretFingerprint(paths) {
  const hash = createHash('sha256');
  for (const path of paths.filter(Boolean)) {
    hash.update(path);
    hash.update(await readSecretFile(path, 'rotation-tracked secret'));
  }
  return hash.digest('hex');
}

export function validateBearerToken(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 8192
    && !/[\r\n]/.test(token);
}

export function isLoopbackAddress(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || (isIP(host) === 6 && host.toLowerCase() === '::1');
}
