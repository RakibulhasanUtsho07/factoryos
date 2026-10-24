import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  HIL_CASE_IDS,
  PRECONDITION_KEYS,
  SIMULATOR_CASE_IDS,
  validateCommissioningEvidence,
  verifyCommissioningArtifactReferences,
} from '../scripts/validate-commissioning-evidence.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templatePath = join(root, 'deploy', 'commissioning-evidence.template.json');
const validatorPath = join(root, 'scripts', 'validate-commissioning-evidence.mjs');

async function loadTemplate() {
  return JSON.parse(await readFile(templatePath, 'utf8'));
}

async function writeEvidenceArtifacts(record, root) {
  const targets = [
    ...(record.simulator_tests ?? []).map((item) => ({ item, refKey: 'artifact_ref', hashKey: 'artifact_sha256' })),
    ...(record.hil_tests ?? []).map((item) => ({ item, refKey: 'artifact_ref', hashKey: 'artifact_sha256' })),
    ...Object.values(record.signoffs ?? {}).map((item) => ({ item, refKey: 'signature_artifact_ref', hashKey: 'signature_artifact_sha256' })),
  ];
  for (const { item, refKey, hashKey } of targets) {
    if (!item?.[refKey]) continue;
    const target = join(root, item[refKey]);
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.from(`test evidence bytes for ${item[refKey]}\\n`);
    await writeFile(target, bytes);
    item[hashKey] = createHash('sha256').update(bytes).digest('hex');
  }
}

function validPassingEvidence(template) {
  const record = structuredClone(template);
  record.identity = {
    change_ticket_id: 'CHG-OT-2026-1042',
    factory_site_line: 'Factory A / Line 2',
    gateway_asset_id: 'OT-GW-002',
    gateway_serial: 'GW-SERIAL-002',
    gateway_image_digest: 'sha256:' + 'a'.repeat(64),
    gateway_config_sha256: 'b'.repeat(64),
    api_build_sha: 'c'.repeat(40),
    device_model_firmware: 'Approved meter/controller model and firmware rev 4.2',
    operator_name: 'Authorized OT Operator',
    release_approver_name: 'Release Approver',
    security_approver_name: 'Security Approver',
    test_started_at: '2026-10-24T09:00:00Z',
    test_ended_at: '2026-10-24T10:00:00Z',
    maintenance_window_approved: true,
    rollback_stop_work_contact: 'Control-room contact via approved runbook'
  };
  record.preconditions = Object.fromEntries(PRECONDITION_KEYS.map((key) => [key, true]));
  record.simulator_tests = SIMULATOR_CASE_IDS.map((case_id) => ({
    case_id, title: case_id, result: 'PASS', artifact_ref: `evidence/simulator/${case_id}.json`,
    artifact_sha256: 'd'.repeat(64), notes: ''
  }));
  record.hil_tests = HIL_CASE_IDS.map((case_id) => ({
    case_id, title: case_id, result: 'PASS', artifact_ref: `evidence/hil/${case_id}.json`,
    artifact_sha256: 'd'.repeat(64), notes: ''
  }));
  record.reconciliation = {
    events_generated: 25,
    events_durably_spooled: 25,
    events_acknowledged: 25,
    duplicate_replay_outcomes: 2,
    unresolved_sequence_gaps: 0,
    pending_spool_entries: 0,
    blocked_spool_entries: 0,
    unresolved_alarm_ids: []
  };
  record.signoffs = {
    ot_operator: {
      name: 'Authorized OT Operator',
      signature_artifact_ref: 'evidence/signatures/operator-signed-record.pdf',
      signature_artifact_sha256: 'e'.repeat(64),
      signed_at: '2026-10-24T10:10:00Z'
    },
    release_approver: {
      name: 'Release Approver',
      signature_artifact_ref: 'evidence/signatures/release-approver-signed-record.pdf',
      signature_artifact_sha256: 'e'.repeat(64),
      signed_at: '2026-10-24T10:12:00Z'
    },
    security_approver: {
      name: 'Security Approver',
      signature_artifact_ref: 'evidence/signatures/security-approver-signed-record.pdf',
      signature_artifact_sha256: 'e'.repeat(64),
      signed_at: '2026-10-24T10:14:00Z'
    }
  };
  record.decision = 'PASS';
  record.decision_reason = 'All required cases passed and the event ledger reconciled.';
  record.conditions = [];
  return record;
}

test('blank JSON template is structurally valid but not accepted for release', async () => {
  const template = await loadTemplate();
  assert.deepEqual(validateCommissioningEvidence(template), []);
  const run = spawnSync(process.execPath, [validatorPath, templatePath], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /release acceptance requires decision PASS/);
});

test('complete simulator and HIL evidence with all sign-offs can pass acceptance validation', async () => {
  const template = await loadTemplate();
  assert.deepEqual(validateCommissioningEvidence(validPassingEvidence(template)), []);
});

test('PASS is rejected when any required HIL test is not run or lacks an artifact', async () => {
  const template = await loadTemplate();
  const evidence = validPassingEvidence(template);
  evidence.hil_tests[0].result = 'NOT_RUN';
  evidence.hil_tests[0].artifact_ref = '';
  const errors = validateCommissioningEvidence(evidence);
  assert.ok(errors.some((error) => error.includes('hil_tests case opcua_secure_subscription to have result PASS')));
});

test('duplicate or missing required case IDs are rejected', async () => {
  const template = await loadTemplate();
  const evidence = validPassingEvidence(template);
  evidence.simulator_tests[1].case_id = evidence.simulator_tests[0].case_id;
  const errors = validateCommissioningEvidence(evidence);
  assert.ok(errors.some((error) => error.includes('duplicate case_id wrong_spool_key')));
  assert.ok(errors.some((error) => error.includes('missing case_id mismatched_tls_pair')));
});

test('PASS is rejected when immutable build identity, preconditions, or artifact references are invalid', async () => {
  const template = await loadTemplate();
  const evidence = validPassingEvidence(template);
  evidence.identity.gateway_image_digest = 'latest';
  evidence.preconditions.plc_write_paths_disabled = false;
  evidence.simulator_tests[0].artifact_ref = 'TODO';
  const errors = validateCommissioningEvidence(evidence);
  assert.ok(errors.some((error) => error.includes('immutable sha256')));
  assert.ok(errors.some((error) => error.includes('every commissioning precondition')));
  assert.ok(errors.some((error) => error.includes('artifact_ref')));
});

test('event reconciliation contradictions are rejected even before a PASS decision', async () => {
  const evidence = await loadTemplate();
  evidence.reconciliation.events_generated = 1;
  evidence.reconciliation.events_durably_spooled = 2;
  evidence.reconciliation.events_acknowledged = 3;
  const errors = validateCommissioningEvidence(evidence);
  assert.ok(errors.some((error) => error.includes('cannot exceed events_generated')));
  assert.ok(errors.some((error) => error.includes('cannot exceed events_durably_spooled')));
});

test('CONDITIONAL and FAIL decisions require an explicit reason', async () => {
  const evidence = await loadTemplate();
  evidence.decision = 'FAIL';
  assert.ok(validateCommissioningEvidence(evidence).some((error) => error.includes('decision_reason is required')));
  evidence.decision = 'CONDITIONAL';
  assert.ok(validateCommissioningEvidence(evidence).some((error) => error.includes('at least one explicit condition')));
});

test('CLI can validate a draft explicitly without reporting it as release acceptance', async () => {
  const template = await loadTemplate();
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-commissioning-'));
  try {
    const file = join(directory, 'draft.json');
    await writeFile(file, JSON.stringify(template), 'utf8');
    const run = spawnSync(process.execPath, [validatorPath, '--allow-incomplete', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /not release acceptance/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact verifier requires every referenced file to exist and match its SHA-256', async (t) => {
  const evidence = validPassingEvidence(await loadTemplate());
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-evidence-root-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeEvidenceArtifacts(evidence, directory);
  assert.deepEqual(await verifyCommissioningArtifactReferences(evidence, directory), []);

  evidence.simulator_tests[0].artifact_sha256 = '0'.repeat(64);
  const mismatch = await verifyCommissioningArtifactReferences(evidence, directory);
  assert.ok(mismatch.some((error) => error.includes('SHA-256 does not match')));

  evidence.simulator_tests[0].artifact_sha256 = 'd'.repeat(64);
  await rm(join(directory, evidence.hil_tests[0].artifact_ref));
  const missing = await verifyCommissioningArtifactReferences(evidence, directory);
  assert.ok(missing.some((error) => error.includes('artifact is missing')));
});

test('artifact verifier rejects traversal and symbolic links', async (t) => {
  const evidence = validPassingEvidence(await loadTemplate());
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-evidence-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'factoryos-evidence-outside-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeEvidenceArtifacts(evidence, directory);
  evidence.simulator_tests[0].artifact_ref = '../outside.json';
  evidence.simulator_tests[0].artifact_sha256 = 'd'.repeat(64);
  let errors = await verifyCommissioningArtifactReferences(evidence, directory);
  assert.ok(errors.some((error) => error.includes('unsafe artifact_ref')));

  const escapeFile = join(outside, 'escape.json');
  await writeFile(escapeFile, 'outside evidence');
  const link = join(directory, 'evidence', 'simulator', 'linked.json');
  await (await import('node:fs/promises')).symlink(escapeFile, link);
  evidence.simulator_tests[0].artifact_ref = 'evidence/simulator/linked.json';
  errors = await verifyCommissioningArtifactReferences(evidence, directory);
  assert.ok(errors.some((error) => error.includes('symlink')));
});

test('PASS CLI requires an artifact root and verifies evidence bytes before acceptance', async (t) => {
  const evidence = validPassingEvidence(await loadTemplate());
  const directory = await mkdtemp(join(tmpdir(), 'factoryos-evidence-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeEvidenceArtifacts(evidence, directory);
  const file = join(directory, 'record.json');
  await writeFile(file, JSON.stringify(evidence), 'utf8');

  const withoutRoot = spawnSync(process.execPath, [validatorPath, file], { encoding: 'utf8' });
  assert.equal(withoutRoot.status, 1);
  assert.match(withoutRoot.stderr, /requires --artifact-root/);

  const verified = spawnSync(process.execPath, [validatorPath, '--artifact-root', directory, file], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /artifact existence and SHA-256 integrity checks/i);
});
