import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExternalCertificationManifest } from './wms-provider-evidence-pack.mjs';
import {
  createFactoryOsWebhookSignature,
  readCertificationConfig,
  runProviderCertification,
} from './wms-provider-certification.mjs';

const CONNECTOR_ID = '4b6d2019-a69d-43d1-a9d2-ec97a71e2c49';
const SHIPMENT_ID = '51c58ea7-1207-4ac2-8b68-a4e13883cf81';
const TENANT_ID = '9ba278d1-166b-4bf0-a3bc-5b427a983391';
const FACTORY_ID = 'a3e61b54-3b8a-4c35-bf0b-0c2d58b0534d';
const OBJECT_ID = '7fb5cf7d-c1d3-4b15-9df6-bec7b66f4136';
const SECRET = 'this-is-a-certification-webhook-secret-over-32-bytes';
const PNG_FIXTURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
]);

const baseEnv = {
  FACTORYOS_CERT_ENVIRONMENT: 'staging',
  FACTORYOS_CERT_ALLOW_SIDE_EFFECTS: 'YES',
  FACTORYOS_CERT_API_ORIGIN: 'https://factoryos-staging.example.test',
  FACTORYOS_CERT_CONNECTOR_ID: CONNECTOR_ID,
  FACTORYOS_CERT_SHIPMENT_UNIT_ID: SHIPMENT_ID,
  FACTORYOS_CERT_SCHEMA_VERSION: '1',
  FACTORYOS_CERT_WEBHOOK_SECRET: SECRET,
  FACTORYOS_CERT_BEARER_TOKEN: 'writer-token-never-store',
  FACTORYOS_CERT_READONLY_BEARER_TOKEN: 'reader-token-never-store',
  FACTORYOS_CERT_STORAGE_PROVIDER: 'S3-compatible staging',
  FACTORYOS_CERT_CARRIER_PROVIDER: 'Configured carrier sandbox',
  FACTORYOS_CERT_CARRIER_NAME: 'Acme Logistics',
  FACTORYOS_CERT_TRACKING_REFERENCE: 'ACME-TEST-TRACK-100',
  FACTORYOS_CERT_SITE: 'CERT-SITE-01',
  FACTORYOS_CERT_OPERATOR: 'Certification operator',
  FACTORYOS_CERT_EVIDENCE_PATH: 'provider-cert-test-evidence.json',
};

const connector = {
  id: CONNECTOR_ID,
  source_system: 'WMS_CARRIER',
  status: 'ACTIVE',
  display_name: 'Acme Logistics',
  schema_version: 1,
  allowed_event_types: ['WMS.SHIPMENT_DELIVERY'],
  has_secret_reference: true,
  payload_schema: {
    type: 'object',
    properties: Object.fromEntries([
      'carrier_name', 'tracking_reference', 'event_type', 'event_at',
      'recipient_name', 'proof_type', 'proof_reference', 'proof_sha256', 'signed_at',
    ].map((key) => [key, { type: 'string' }])),
  },
};

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('certification configuration rejects production and unsafe API origins', () => {
  assert.throws(() => readCertificationConfig({
    ...baseEnv,
    FACTORYOS_CERT_ENVIRONMENT: 'production',
  }), /production is blocked/);
  assert.throws(() => readCertificationConfig({
    ...baseEnv,
    FACTORYOS_CERT_API_ORIGIN: 'http://factoryos-staging.example.test',
  }), /HTTPS origin/);
  assert.throws(() => readCertificationConfig({
    ...baseEnv,
    FACTORYOS_CERT_API_ORIGIN: 'https://user:password@factoryos-staging.example.test',
  }), /credential-free HTTPS origin/);
  assert.throws(() => readCertificationConfig({
    ...baseEnv,
    FACTORYOS_CERT_API_ORIGIN: 'https://api.factoryos.example.test',
  }), /hostname must visibly identify staging or sandbox/);
  assert.throws(() => readCertificationConfig({
    ...baseEnv,
    FACTORYOS_CERT_ALLOW_SIDE_EFFECTS: 'NO',
  }), /dedicated dispatched test shipment/);
});

test('webhook signature uses timestamp, event ID, separator, and the exact raw body', () => {
  const raw = Buffer.from('{"payload":{"event_type":"DELIVERED"}}');
  const signature = createFactoryOsWebhookSignature(SECRET, '1792983600', 'cert-event-1', raw);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(
    signature,
    createFactoryOsWebhookSignature(SECRET, '1792983601', 'cert-event-1', raw),
  );
  assert.notEqual(
    signature,
    createFactoryOsWebhookSignature(SECRET, '1792983600', 'cert-event-2', raw),
  );
  assert.notEqual(
    signature,
    createFactoryOsWebhookSignature(SECRET, '1792983600', 'cert-event-1', Buffer.from(raw.toString() + ' ')),
  );
});

test('configured-provider smoke proves storage read-back, authorization, signature and replay contracts without claiming a real carrier call', async () => {
  const requests = [];
  const bodies = [
    connector,
    null, // anonymous upload: denied
    null, // read-only upload: forbidden
    {
      object_id: OBJECT_ID,
      shipment_unit_id: SHIPMENT_ID,
      proof_reference: 'pod/' + TENANT_ID + '/' + FACTORY_ID + '/' + SHIPMENT_ID + '/' + OBJECT_ID,
      proof_sha256: createHash('sha256').update(PNG_FIXTURE).digest('hex'),
      byte_length: PNG_FIXTURE.byteLength,
      content_type: 'image/png',
      verified: true,
    },
    null, // invalid signature: rejected
    { accepted: true, duplicate: false, event_id: 'db-event-1' },
    { accepted: true, duplicate: true, event_id: 'db-event-1' },
    null, // same event ID with a different payload: conflict
  ];
  const statuses = [200, 401, 403, 201, 400, 202, 202, 409];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    const index = requests.length - 1;
    return jsonResponse(statuses[index], bodies[index] ?? {});
  };
  let evidenceSaved;
  let clock = new Date('2026-10-26T03:00:00.000Z');
  const now = () => {
    const value = new Date(clock);
    clock = new Date(clock.getTime() + 1000);
    return value;
  };

  const result = await runProviderCertification({
    env: baseEnv,
    fetcher,
    now,
    uuid: () => '123e4567-e89b-12d3-a456-426614174000',
    writeEvidence: async (path, evidence) => {
      evidenceSaved = { path, evidence };
      return '/private/test/' + path;
    },
  });

  assert.equal(requests.length, 8);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer reader-token-never-store');
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[2].options.headers.Authorization, 'Bearer reader-token-never-store');
  assert.equal(requests[3].options.headers.Authorization, 'Bearer writer-token-never-store');
  assert.equal(requests[3].options.method, 'POST');
  assert.equal(requests[3].url, 'https://factoryos-staging.example.test/api/integrations/wms/shipments/' + SHIPMENT_ID + '/pod-object');

  const firstWebhook = requests[5];
  const replayWebhook = requests[6];
  const conflictWebhook = requests[7];
  assert.equal(firstWebhook.url, 'https://factoryos-staging.example.test/api/integrations/webhooks/' + CONNECTOR_ID);
  const firstEnvelope = JSON.parse(Buffer.from(firstWebhook.options.body).toString());
  assert.match(firstEnvelope.correlation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(Buffer.from(firstWebhook.options.body).toString(), Buffer.from(replayWebhook.options.body).toString());
  assert.notEqual(
    firstWebhook.options.headers['X-FactoryOS-Timestamp'],
    replayWebhook.options.headers['X-FactoryOS-Timestamp'],
  );
  assert.notEqual(
    Buffer.from(firstWebhook.options.body).toString(),
    Buffer.from(conflictWebhook.options.body).toString(),
  );
  assert.equal(result.evidence.evidence.configured_storage_put_get_digest, 'PASS');
  assert.equal(result.evidence.evidence.anonymous_upload_denied, 'PASS');
  assert.equal(result.evidence.evidence.read_only_upload_denied, 'PASS');
  assert.equal(result.evidence.evidence.invalid_signature_rejected, 'PASS');
  assert.equal(result.evidence.evidence.exact_retry_replay, 'PASS');
  assert.equal(result.evidence.evidence.conflicting_replay_rejected, 'PASS');
  assert.equal(result.evidence.evidence.carrier_sandbox_origin, 'NOT_PROVEN');
  assert.equal(result.evidence.evidence.storage_iam_least_privilege_review, 'NOT_VERIFIED_BY_SCRIPT');
  assert.equal(result.evidence.storage.sha256, createHash('sha256').update(PNG_FIXTURE).digest('hex'));
  assert.equal(evidenceSaved.path, 'provider-cert-test-evidence.json');
  assert.equal(result.evidencePath, '/private/test/provider-cert-test-evidence.json');
  const encodedEvidence = JSON.stringify(evidenceSaved.evidence);
  assert.equal(encodedEvidence.includes(SECRET), false);
  assert.equal(encodedEvidence.includes('writer-token-never-store'), false);
  assert.equal(encodedEvidence.includes('reader-token-never-store'), false);
  assert.equal(encodedEvidence.includes('PROVEN_CARRIER'), false);
});


const EXTERNAL_RELEASE_SHA = 'a'.repeat(40);
const evidenceKinds = [
  'carrier-callback',
  'carrier-retry-replay',
  'carrier-conflicting-replay',
  'storage-independent-readback',
  'storage-effective-iam',
  'storage-credential-rotation',
  'owner-signoffs',
];

function evidenceDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createValidExternalEvidence(directory) {
  const attachments = evidenceKinds.map((kind, index) => ({
    kind,
    path: kind + '.json',
    body: JSON.stringify({ kind, fixture: 'redacted-test-evidence-' + index }),
  }));
  for (const attachment of attachments) {
    await writeFile(join(directory, attachment.path), attachment.body, { flag: 'wx', mode: 0o600 });
  }
  const uploadedDigest = evidenceDigest('exact object bytes');
  return {
    schema: 'factoryos.wms.external-certification-evidence/v1',
    environment: 'sandbox',
    release_sha: EXTERNAL_RELEASE_SHA,
    tested_at: '2026-10-26T10:00:00Z',
    carrier: {
      provider_name: 'ExampleCarrier Sandbox',
      account_reference: 'sandbox-account-reference',
      tracking_reference: 'sandbox-tracking-reference',
      callback: {
        origin: 'PROVIDER_NATIVE',
        signature_validation: 'PASS',
        adapter: 'ExampleCarrierNativeWebhookVerifier',
        signature_algorithm: 'ed25519',
        provider_request_id: 'provider-request-123',
        provider_event_id: 'provider-event-123',
        payload_sha256: evidenceDigest('carrier-native-payload'),
        received_at: '2026-10-26T10:00:00Z',
        retry: {
          attempt_count: 2,
          same_provider_event_id: true,
          same_payload_sha256: true,
          initial_attempt_transient_failure: true,
          stored_receipt_reused: true,
          persisted_delivery_event_count: 1,
        },
        conflicting_replay: {
          same_provider_event_id: true,
          payload_sha256_differs: true,
          accepted: false,
          http_status: 409,
          persisted_delivery_event_count: 1,
        },
      },
    },
    storage: {
      provider_name: 'Example S3-compatible staging',
      account_reference: 'storage-account-reference',
      bucket: 'factoryos-pod-staging',
      prefix: 'pod/tenant-1/factory-1/',
      object_key: 'pod/tenant-1/factory-1/shipment-1/proof.png',
      runtime_principal_sha256: evidenceDigest('runtime-principal-fingerprint'),
      policy_sha256: evidenceDigest('effective-policy-export'),
      effective_permissions_review: 'PASS',
      review_items: {
        bucket_policy: { status: 'PASS' },
        permissions_boundary: { status: 'PASS' },
        organization_policy: { status: 'PASS' },
        session_policy: { status: 'PASS' },
        kms_policy: { status: 'NOT_APPLICABLE_WITH_REASON', reason: 'Provider confirms this sandbox bucket uses no customer-managed KMS key.' },
      },
      upload: {
        method: 'FACTORYOS_STORAGE_ADAPTER',
        request_id: 'upload-request-123',
        sha256: uploadedDigest,
        byte_length: 123,
      },
      readback: {
        method: 'DIRECT_PROVIDER_SDK',
        factoryos_api_used: false,
        request_id: 'direct-readback-request-456',
        principal_fingerprint_sha256: evidenceDigest('independent-readback-principal'),
        sha256: uploadedDigest,
        byte_length: 123,
      },
      credential_rotation: {
        rotated_at: '2026-10-26T10:00:00Z',
        old_credential_denied: true,
        new_credential_put_get_pass: true,
        old_credential_fingerprint_sha256: evidenceDigest('old-credential-fingerprint'),
        new_credential_fingerprint_sha256: evidenceDigest('new-credential-fingerprint'),
      },
    },
    evidence_files: attachments.map(({ kind, path, body }) => ({
      kind,
      path,
      sha256: evidenceDigest(body),
    })),
    approvals: [
      { role: 'carrier_integration_owner', identity_reference: 'approval-ref-carrier', decision: 'APPROVED', approved_at: '2026-10-26T10:00:00Z', release_sha: EXTERNAL_RELEASE_SHA },
      { role: 'storage_security_owner', identity_reference: 'approval-ref-storage', decision: 'APPROVED', approved_at: '2026-10-26T10:00:00Z', release_sha: EXTERNAL_RELEASE_SHA },
      { role: 'wms_process_owner', identity_reference: 'approval-ref-wms', decision: 'APPROVED', approved_at: '2026-10-26T10:00:00Z', release_sha: EXTERNAL_RELEASE_SHA },
    ],
  };
}

async function withExternalEvidence(run) {
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-external-cert-'));
  try {
    const manifest = await createValidExternalEvidence(directory);
    await run(directory, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('external evidence-pack gate accepts complete integrity-checked provider evidence bound to exact release', async () => {
  await withExternalEvidence(async (evidenceRoot, manifest) => {
    const report = await validateExternalCertificationManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: EXTERNAL_RELEASE_SHA,
    });
    assert.equal(report.pass, true, JSON.stringify(report.issues));
    assert.equal(report.result, 'PASS_EVIDENCE_BUNDLE_COMPLETE');
    assert.equal(report.evidence_files_checked, 7);
  });
});

test('external evidence-pack gate rejects the synthetic FactoryOS callback smoke as carrier proof', async () => {
  await withExternalEvidence(async (evidenceRoot, manifest) => {
    manifest.carrier.callback.origin = 'SYNTHETIC_FACTORYOS_HMAC';
    manifest.carrier.callback.signature_algorithm = 'FactoryOS HMAC-SHA256';
    const report = await validateExternalCertificationManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: EXTERNAL_RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === 'CARRIER_ORIGIN_NOT_PROVIDER_NATIVE'));
    assert.ok(report.issues.some((issue) => issue.code === 'SYNTHETIC_FACTORYOS_SIGNATURE_NOT_ACCEPTED'));
  });
});

test('external evidence-pack gate rejects API-mediated read-back and object digest mismatch', async () => {
  await withExternalEvidence(async (evidenceRoot, manifest) => {
    manifest.storage.readback.method = 'FACTORYOS_API';
    manifest.storage.readback.factoryos_api_used = true;
    manifest.storage.readback.sha256 = evidenceDigest('different bytes');
    const report = await validateExternalCertificationManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: EXTERNAL_RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === 'READBACK_NOT_DIRECT_TO_PROVIDER'));
    assert.ok(report.issues.some((issue) => issue.code === 'READBACK_MUST_BYPASS_FACTORYOS_API'));
    assert.ok(report.issues.some((issue) => issue.code === 'UPLOAD_READBACK_DIGEST_MISMATCH'));
  });
});

test('external evidence-pack gate verifies local evidence attachment SHA-256 and rejects traversal paths', async () => {
  await withExternalEvidence(async (evidenceRoot, manifest) => {
    manifest.evidence_files[0].path = '../outside.json';
    manifest.evidence_files[1].sha256 = '0'.repeat(64);
    const report = await validateExternalCertificationManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: EXTERNAL_RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === 'UNSAFE_EVIDENCE_PATH'));
    assert.ok(report.issues.some((issue) => issue.code === 'EVIDENCE_FILE_DIGEST_MISMATCH'));
  });
});

test('external evidence-pack gate rejects stale release approvals, failed key rotation and secret-bearing fields', async () => {
  await withExternalEvidence(async (evidenceRoot, manifest) => {
    manifest.approvals[0].release_sha = 'b'.repeat(40);
    manifest.storage.credential_rotation.old_credential_denied = false;
    manifest.private_key = 'must-not-be-present';
    const report = await validateExternalCertificationManifest(manifest, {
      evidenceRoot,
      expectedReleaseSha: EXTERNAL_RELEASE_SHA,
    });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.code === 'APPROVAL_RELEASE_SHA_MISMATCH'));
    assert.ok(report.issues.some((issue) => issue.code === 'CREDENTIAL_ROTATION_NOT_PROVEN'));
    assert.ok(report.issues.some((issue) => issue.code === 'FORBIDDEN_SECRET_FIELD_NAME'));
  });
});
