#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const PNG_FIXTURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Required certification setting is missing: ' + name);
  }
  return value.trim();
}

function validVisibleAscii(value, name, maxLength) {
  if (value.length < 1 || value.length > maxLength || !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(name + ' must contain 1 to ' + maxLength + ' visible ASCII characters');
  }
  return value;
}

export function readCertificationConfig(env = process.env) {
  const environment = required(env, 'FACTORYOS_CERT_ENVIRONMENT').toLowerCase();
  if (!['sandbox', 'staging'].includes(environment)) {
    throw new Error('Certification must target an explicitly named sandbox or staging environment; production is blocked');
  }
  if (required(env, 'FACTORYOS_CERT_ALLOW_SIDE_EFFECTS') !== 'YES') {
    throw new Error('Set FACTORYOS_CERT_ALLOW_SIDE_EFFECTS=YES only after selecting a dedicated dispatched test shipment');
  }

  let apiOrigin;
  try {
    apiOrigin = new URL(required(env, 'FACTORYOS_CERT_API_ORIGIN'));
  } catch {
    throw new Error('FACTORYOS_CERT_API_ORIGIN must be a valid HTTPS origin');
  }
  if (apiOrigin.protocol !== 'https:' || apiOrigin.username || apiOrigin.password ||
      apiOrigin.search || apiOrigin.hash || apiOrigin.pathname !== '/') {
    throw new Error('FACTORYOS_CERT_API_ORIGIN must be a credential-free HTTPS origin with no path, query, or fragment');
  }
  // Fail closed on ambiguous hostnames: the non-production label alone is
  // operator-supplied and must not be able to relabel a production hostname.
  if (!/(^|[.-])(staging|sandbox)([.-]|$)/i.test(apiOrigin.hostname)) {
    throw new Error('FACTORYOS_CERT_API_ORIGIN hostname must visibly identify staging or sandbox');
  }

  const connectorId = required(env, 'FACTORYOS_CERT_CONNECTOR_ID');
  const shipmentUnitId = required(env, 'FACTORYOS_CERT_SHIPMENT_UNIT_ID');
  if (!UUID.test(connectorId) || !UUID.test(shipmentUnitId)) {
    throw new Error('FACTORYOS_CERT_CONNECTOR_ID and FACTORYOS_CERT_SHIPMENT_UNIT_ID must be UUIDs');
  }
  const webhookSecret = required(env, 'FACTORYOS_CERT_WEBHOOK_SECRET');
  if (Buffer.byteLength(webhookSecret, 'utf8') < 32 || /[\r\n]/.test(webhookSecret)) {
    throw new Error('FACTORYOS_CERT_WEBHOOK_SECRET must be a single-line secret of at least 32 bytes');
  }

  const schemaVersionRaw = env.FACTORYOS_CERT_SCHEMA_VERSION?.trim() || '1';
  const schemaVersion = Number(schemaVersionRaw);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('FACTORYOS_CERT_SCHEMA_VERSION must be a positive integer');
  }

  return {
    environment,
    apiOrigin: apiOrigin.origin,
    connectorId: connectorId.toLowerCase(),
    shipmentUnitId: shipmentUnitId.toLowerCase(),
    schemaVersion,
    webhookSecret,
    writerToken: required(env, 'FACTORYOS_CERT_BEARER_TOKEN'),
    readOnlyToken: required(env, 'FACTORYOS_CERT_READONLY_BEARER_TOKEN'),
    storageProvider: validVisibleAscii(required(env, 'FACTORYOS_CERT_STORAGE_PROVIDER'), 'FACTORYOS_CERT_STORAGE_PROVIDER', 100),
    carrierProvider: validVisibleAscii(required(env, 'FACTORYOS_CERT_CARRIER_PROVIDER'), 'FACTORYOS_CERT_CARRIER_PROVIDER', 100),
    carrierName: validVisibleAscii(required(env, 'FACTORYOS_CERT_CARRIER_NAME'), 'FACTORYOS_CERT_CARRIER_NAME', 255).trim(),
    trackingReference: validVisibleAscii(required(env, 'FACTORYOS_CERT_TRACKING_REFERENCE'), 'FACTORYOS_CERT_TRACKING_REFERENCE', 255).trim(),
    site: validVisibleAscii(required(env, 'FACTORYOS_CERT_SITE'), 'FACTORYOS_CERT_SITE', 100),
    operator: validVisibleAscii(required(env, 'FACTORYOS_CERT_OPERATOR'), 'FACTORYOS_CERT_OPERATOR', 100),
    evidencePath: env.FACTORYOS_CERT_EVIDENCE_PATH?.trim() || '',
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createFactoryOsWebhookSignature(secret, timestamp, eventId, rawBody) {
  return 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + eventId + '.')
    .update(rawBody)
    .digest('hex');
}

function urlFor(apiOrigin, route) {
  return new URL(route, apiOrigin).toString();
}

function createUploadForm() {
  const form = new FormData();
  form.append('file', new Blob([PNG_FIXTURE], { type: 'image/png' }), 'factoryos-provider-cert.png');
  return form;
}

async function readJson(response, stage) {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error(stage + ' returned a non-JSON response (HTTP ' + response.status + ')');
  }
}

function expectStatus(response, expected, stage) {
  if (!expected.includes(response.status)) {
    throw new Error(stage + ' returned unexpected HTTP ' + response.status + '; expected ' + expected.join(' or '));
  }
}

async function postUpload(fetcher, url, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetcher(url, {
    method: 'POST',
    headers,
    body: createUploadForm(),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
}

function assertConnector(connector, config) {
  if (String(connector.id ?? '').toLowerCase() !== config.connectorId) {
    throw new Error('Connector detail returned a different connector ID');
  }
  if (connector.source_system !== 'WMS_CARRIER') {
    throw new Error('Selected connector source_system must be WMS_CARRIER');
  }
  if (connector.status !== 'ACTIVE') {
    throw new Error('Selected carrier connector must be ACTIVE before certification');
  }
  if (String(connector.display_name ?? '').trim().toLowerCase() !== config.carrierName.toLowerCase()) {
    throw new Error('FACTORYOS_CERT_CARRIER_NAME must match the connector display_name');
  }
  if (Number(connector.schema_version) !== config.schemaVersion) {
    throw new Error('FACTORYOS_CERT_SCHEMA_VERSION does not match the registered connector schema_version');
  }
  if (!Array.isArray(connector.allowed_event_types) ||
      !connector.allowed_event_types.includes('WMS.SHIPMENT_DELIVERY')) {
    throw new Error('Selected connector must allow WMS.SHIPMENT_DELIVERY');
  }
  const schema = connector.payload_schema;
  if (!schema || schema.type !== 'object' || !schema.properties ||
      !['carrier_name', 'tracking_reference', 'event_type', 'event_at',
        'recipient_name', 'proof_type', 'proof_reference', 'proof_sha256', 'signed_at']
        .every((field) => Object.hasOwn(schema.properties, field))) {
    throw new Error('Registered connector payload schema is missing required carrier/POD properties');
  }
}

function validateUpload(upload, config) {
  if (upload.verified !== true) {
    throw new Error('POD upload endpoint did not report verified=true');
  }
  if (upload.shipment_unit_id?.toLowerCase() !== config.shipmentUnitId) {
    throw new Error('POD upload response does not match the selected shipment');
  }
  if (upload.content_type !== 'image/png' || upload.byte_length !== PNG_FIXTURE.byteLength) {
    throw new Error('POD upload response content type or byte length differs from the certification fixture');
  }
  const expectedDigest = sha256(PNG_FIXTURE);
  if (typeof upload.proof_sha256 !== 'string' ||
      upload.proof_sha256 !== expectedDigest ||
      !HEX_SHA256.test(upload.proof_sha256)) {
    throw new Error('POD storage read-back SHA-256 differs from the exact uploaded bytes');
  }
  const parts = typeof upload.proof_reference === 'string' ? upload.proof_reference.split('/') : [];
  if (parts.length !== 5 || parts[0] !== 'pod' ||
      parts[3]?.toLowerCase() !== config.shipmentUnitId || !parts[4]) {
    throw new Error('POD upload returned an unexpected tenant/factory/shipment object-key shape');
  }
  return { proofReference: upload.proof_reference, proofSha256: upload.proof_sha256, byteLength: upload.byte_length };
}

function buildEnvelope(config, upload, now, uuid) {
  const eventAt = now();
  const signedAt = new Date(eventAt.getTime() - 1000);
  return {
    event_type: 'WMS.SHIPMENT_DELIVERY',
    schema_version: config.schemaVersion,
    correlation_id: uuid(),
    payload: {
      carrier_name: config.carrierName,
      tracking_reference: config.trackingReference,
      event_type: 'DELIVERED',
      event_at: eventAt.toISOString(),
      recipient_name: 'FactoryOS sandbox certification',
      proof_type: 'PHOTO',
      proof_reference: upload.proofReference,
      proof_sha256: upload.proofSha256,
      signed_at: signedAt.toISOString(),
    },
  };
}

async function postSignedEnvelope(fetcher, config, envelope, eventId, now) {
  const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
  const timestamp = String(Math.floor(now().getTime() / 1000));
  const signature = createFactoryOsWebhookSignature(config.webhookSecret, timestamp, eventId, rawBody);
  const response = await fetcher(
    urlFor(config.apiOrigin, '/api/integrations/webhooks/' + config.connectorId),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-FactoryOS-Timestamp': timestamp,
        'X-FactoryOS-Event-Id': eventId,
        'X-FactoryOS-Signature': signature,
      },
      body: rawBody,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
  );
  return { response, rawBody, timestamp };
}

async function defaultWriteEvidence(filePath, evidence) {
  const fullPath = resolve(filePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return fullPath;
}

/**
 * Exercises the configured FactoryOS storage adapter through its authenticated API,
 * then probes the FactoryOS webhook receiver with a synthetic, correctly signed
 * carrier envelope. It does not call a carrier's provider API or prove that a
 * real carrier sandbox sent this event.
 */
export async function runProviderCertification({
  env = process.env,
  fetcher = globalThis.fetch,
  now = () => new Date(),
  uuid = () => randomUUID(),
  writeEvidence = defaultWriteEvidence,
} = {}) {
  const config = readCertificationConfig(env);
  const startedAt = now().toISOString();
  const baseEvidence = {
    schema: 'factoryos.wms.provider-certification/v1',
    run_type: 'CONFIGURED_STORAGE_AND_WEBHOOK_RECEIVER_SMOKE',
    environment: config.environment,
    started_at: startedAt,
    site: config.site,
    operator: config.operator,
    providers: {
      storage: config.storageProvider,
      carrier: config.carrierProvider,
    },
    credentials_recorded: false,
    secret_values_recorded: false,
    evidence: {
      connector_configuration: 'NOT_RUN',
      anonymous_upload_denied: 'NOT_RUN',
      read_only_upload_denied: 'NOT_RUN',
      configured_storage_put_get_digest: 'NOT_RUN',
      invalid_signature_rejected: 'NOT_RUN',
      signed_callback_receiver: 'NOT_RUN',
      exact_retry_replay: 'NOT_RUN',
      conflicting_replay_rejected: 'NOT_RUN',
      carrier_sandbox_origin: 'NOT_PROVEN',
      storage_iam_least_privilege_review: 'NOT_VERIFIED_BY_SCRIPT',
    },
  };

  const connectorResponse = await fetcher(
    urlFor(config.apiOrigin, '/api/integrations/connectors/' + config.connectorId),
    {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + config.readOnlyToken },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    },
  );
  expectStatus(connectorResponse, [200], 'Connector configuration probe (read-only token must have integrations.connectors.read)');
  const connector = await readJson(connectorResponse, 'Connector configuration probe');
  assertConnector(connector, config);
  baseEvidence.evidence.connector_configuration = 'PASS';
  baseEvidence.connector = {
    id: config.connectorId,
    source_system: connector.source_system,
    status: connector.status,
    schema_version: Number(connector.schema_version),
    allowed_event_types: connector.allowed_event_types,
    secret_reference_present: connector.has_secret_reference === true,
  };

  const uploadUrl = urlFor(
    config.apiOrigin,
    '/api/integrations/wms/shipments/' + config.shipmentUnitId + '/pod-object',
  );
  const anonymousResponse = await postUpload(fetcher, uploadUrl, '');
  expectStatus(anonymousResponse, [401, 403], 'Unauthenticated POD upload authorization probe');
  baseEvidence.evidence.anonymous_upload_denied = 'PASS';
  baseEvidence.authorization_probes = { unauthenticated_upload_http_status: anonymousResponse.status };

  const readOnlyResponse = await postUpload(fetcher, uploadUrl, config.readOnlyToken);
  expectStatus(readOnlyResponse, [403], 'Read-only user POD upload authorization probe');
  baseEvidence.evidence.read_only_upload_denied = 'PASS';
  baseEvidence.authorization_probes.read_only_upload_http_status = readOnlyResponse.status;

  const uploadResponse = await postUpload(fetcher, uploadUrl, config.writerToken);
  expectStatus(uploadResponse, [200, 201], 'Authenticated POD upload using configured storage');
  const uploadBody = await readJson(uploadResponse, 'POD upload');
  const uploadEvidence = validateUpload(uploadBody, config);
  baseEvidence.evidence.configured_storage_put_get_digest = 'PASS';
  baseEvidence.storage = {
    provider_declared_by_operator: config.storageProvider,
    operation: 'API_SIGNED_PUT_PLUS_INDEPENDENT_GET_SHA256',
    object_key: uploadEvidence.proofReference,
    byte_length: uploadEvidence.byteLength,
    sha256: uploadEvidence.proofSha256,
    api_reported_verified: true,
    bucket_listing_permission_checked: false,
    delete_permission_checked: false,
  };

  const envelope = buildEnvelope(config, uploadEvidence, now, uuid);
  const eventId = 'wms-cert-' + uuid().replace(/-/g, '');
  const invalidSignatureBody = Buffer.from(JSON.stringify(envelope), 'utf8');
  const invalidTimestamp = String(Math.floor(now().getTime() / 1000));
  const invalidSignatureResponse = await fetcher(
    urlFor(config.apiOrigin, '/api/integrations/webhooks/' + config.connectorId),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-FactoryOS-Timestamp': invalidTimestamp,
        'X-FactoryOS-Event-Id': eventId + '-invalid-signature',
        'X-FactoryOS-Signature': 'sha256=' + '0'.repeat(64),
      },
      body: invalidSignatureBody,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
  );
  expectStatus(invalidSignatureResponse, [400], 'Invalid webhook signature probe');
  baseEvidence.evidence.invalid_signature_rejected = 'PASS';

  const first = await postSignedEnvelope(fetcher, config, envelope, eventId, now);
  expectStatus(first.response, [202], 'Signed carrier webhook receiver probe');
  const firstBody = await readJson(first.response, 'Signed carrier webhook receiver probe');
  if (firstBody.accepted !== true || firstBody.duplicate !== false || typeof firstBody.event_id !== 'string') {
    throw new Error('Initial signed webhook was not accepted as a new delivery event');
  }
  baseEvidence.evidence.signed_callback_receiver = 'PASS_SYNTHETIC_FACTORYOS_HMAC';
  baseEvidence.receiver = {
    event_id: eventId,
    receipt_event_id: firstBody.event_id,
    first_status: first.response.status,
    payload_sha256: sha256(first.rawBody),
  };

  const replay = await postSignedEnvelope(fetcher, config, envelope, eventId, now);
  expectStatus(replay.response, [202], 'Exact signed webhook replay');
  const replayBody = await readJson(replay.response, 'Exact signed webhook replay');
  if (replayBody.accepted !== true || replayBody.duplicate !== true ||
      replayBody.event_id !== firstBody.event_id) {
    throw new Error('Exact replay did not return the original accepted receipt/event ID');
  }
  baseEvidence.evidence.exact_retry_replay = 'PASS';
  baseEvidence.receiver.replay_status = replay.response.status;
  baseEvidence.receiver.replay_returned_original_event_id = true;

  const conflictingEnvelope = structuredClone(envelope);
  const conflictTime = new Date(new Date(envelope.payload.event_at).getTime() + 2000);
  conflictingEnvelope.payload.event_at = conflictTime.toISOString();
  conflictingEnvelope.payload.signed_at = new Date(conflictTime.getTime() - 1000).toISOString();
  const conflict = await postSignedEnvelope(fetcher, config, conflictingEnvelope, eventId, now);
  expectStatus(conflict.response, [409], 'Conflicting signed webhook replay');
  baseEvidence.evidence.conflicting_replay_rejected = 'PASS';
  baseEvidence.receiver.conflicting_replay_status = conflict.response.status;
  baseEvidence.receiver.conflicting_replay_created_reconciliation_evidence = true;

  const completedAt = now().toISOString();
  const evidencePath = config.evidencePath ||
    resolve('artifacts', 'wms-provider-certification-' + completedAt.replace(/[:.]/g, '-') + '.json');
  const evidence = {
    ...baseEvidence,
    completed_at: completedAt,
    result: 'PASS_FOR_CONFIGURED_STORAGE_AND_FACTORYOS_RECEIVER_CONTRACT_ONLY',
    explicit_limitations: [
      'The receiver callback in this automated run was synthesized and signed with the configured FactoryOS HMAC secret; it is not evidence that the named carrier sandbox sent a callback.',
      'Carrier-specific API credentials, provider-console delivery IDs, external callback signature semantics, retries from the carrier platform, and signed provider acceptance remain NOT_PROVEN.',
      'Storage bucket listing and delete permissions are not probed; attach an independently reviewed provider IAM policy showing only the required object-prefix PUT/GET scope.',
      'This run creates a POD upload, a DELIVERED test event, and a conflicting-replay reconciliation record. Only use a dedicated sandbox/staging dispatched shipment and never production data.',
    ],
  };
  const writtenPath = await writeEvidence(evidencePath, evidence);
  return { evidence, evidencePath: writtenPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProviderCertification()
    .then(({ evidence, evidencePath }) => {
      console.log('Provider certification smoke evidence written: ' + evidencePath);
      console.log('Configured storage PUT/GET SHA-256: ' + evidence.evidence.configured_storage_put_get_digest);
      console.log('FactoryOS signed callback/replay receiver contract: PASS');
      console.log('External carrier sandbox certification: NOT PROVEN (provider-originated evidence still required)');
    })
    .catch((error) => {
      console.error('WMS provider certification failed: ' + (error instanceof Error ? error.message : 'unknown error'));
      process.exitCode = 1;
    });
}
