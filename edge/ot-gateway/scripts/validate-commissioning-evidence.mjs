import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRECONDITION_KEYS = Object.freeze([
  'network_diagram_attached',
  'egress_acl_reviewed',
  'mqtt_identity_and_topic_acl_verified',
  'opcua_trust_and_encryption_verified',
  'modbus_unit_and_register_map_reviewed',
  'service_identity_scope_verified',
  'plc_write_paths_disabled',
]);

export const SIMULATOR_CASE_IDS = Object.freeze([
  'wrong_spool_key',
  'mismatched_tls_pair',
  'crash_during_enqueue',
  'broker_puback_lost',
  'mqtt_unavailable_reconnect',
  'api_ack_lost_after_commit',
  'duplicate_id_changed_content',
  'sequence_gap_preserved',
  'modbus_timeout',
  'wrong_unit_or_malformed_response',
  'credential_rotation',
  'disk_full_or_queue_capacity',
  'cross_tenant_scope_mismatch',
]);

export const HIL_CASE_IDS = Object.freeze([
  'opcua_secure_subscription',
  'opcua_reconnect',
  'mqtt_broker_restart',
  'modbus_approved_registers',
  'read_only_verification',
  'api_outage_restore',
  'gateway_power_loss_restart',
  'operator_stop_rollback_drill',
]);

const IDENTITY_FIELDS = Object.freeze([
  'change_ticket_id',
  'factory_site_line',
  'gateway_asset_id',
  'gateway_serial',
  'gateway_image_digest',
  'gateway_source_commit',
  'gateway_release_receipt_ref',
  'gateway_release_receipt_sha256',
  'gateway_config_sha256',
  'api_build_sha',
  'device_model_firmware',
  'operator_name',
  'release_approver_name',
  'security_approver_name',
  'test_started_at',
  'test_ended_at',
  'rollback_stop_work_contact',
]);

const OT_GATEWAY_REPOSITORY = 'RakibulhasanUtsho07/factoryos';
const OT_GATEWAY_IMAGE = 'ghcr.io/rakibulhasanutsho07/factoryos/ot-edge-gateway';
const OT_GATEWAY_SIGNING_WORKFLOW = 'https://github.com/RakibulhasanUtsho07/factoryos/.github/workflows/ot-gateway-release.yml@refs/heads/main';

const COUNTER_FIELDS = Object.freeze([
  'events_generated',
  'events_durably_spooled',
  'events_acknowledged',
  'duplicate_replay_outcomes',
  'unresolved_sequence_gaps',
  'pending_spool_entries',
  'blocked_spool_entries',
]);

const SIGNOFFS = Object.freeze([
  ['ot_operator', 'operator_name'],
  ['release_approver', 'release_approver_name'],
  ['security_approver', 'security_approver_name'],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim() === ''
    || /\b(?:todo|tbd|placeholder|replace[-_ ]?me|example\.invalid)\b|\[[^\]]*\]|<[^>]*>/i.test(value);
}

function validEvidenceReference(value) {
  return typeof value === 'string' && !isPlaceholder(value);
}

function validTimestamp(value) {
  return typeof value === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateCaseList(value, path, expectedIds, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return new Map();
  }

  const expected = new Set(expectedIds);
  const found = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const rowPath = `${path}[${index}]`;
    if (!isObject(item)) {
      errors.push(`${rowPath} must be an object`);
      continue;
    }
    if (typeof item.case_id !== 'string' || !expected.has(item.case_id)) {
      errors.push(`${rowPath}.case_id is unknown`);
      continue;
    }
    if (found.has(item.case_id)) {
      errors.push(`${path} contains duplicate case_id ${item.case_id}`);
      continue;
    }
    found.set(item.case_id, item);
    if (!['PASS', 'FAIL', 'NOT_RUN'].includes(item.result)) {
      errors.push(`${rowPath}.result must be PASS, FAIL or NOT_RUN`);
    }
    if (typeof item.artifact_ref !== 'string') {
      errors.push(`${rowPath}.artifact_ref must be a string`);
    } else if (item.result !== 'NOT_RUN' && !validEvidenceReference(item.artifact_ref)) {
      errors.push(`${rowPath}.artifact_ref is required for a completed test`);
    }
    if (typeof item.artifact_sha256 !== 'string') {
      errors.push(`${rowPath}.artifact_sha256 must be a string`);
    } else if (item.result !== 'NOT_RUN' && !/^[a-f0-9]{64}$/i.test(item.artifact_sha256)) {
      errors.push(`${rowPath}.artifact_sha256 must be a 64-hex SHA-256 for a completed test`);
    }
    if (item.notes !== undefined && typeof item.notes !== 'string') {
      errors.push(`${rowPath}.notes must be a string when provided`);
    }
  }

  for (const id of expectedIds) {
    if (!found.has(id)) errors.push(`${path} is missing case_id ${id}`);
  }
  return found;
}

/**
 * Validate structure and evidence-completeness rules. This does not authenticate
 * referenced artifacts, signatures, operators, images, or real-world hardware.
 * Returns an empty array when the record is structurally valid.
 */
export function validateCommissioningEvidence(evidence) {
  const errors = [];
  if (!isObject(evidence)) return ['root must be a JSON object'];
  if (evidence.schema_version !== 1) errors.push('schema_version must equal 1');

  const identity = evidence.identity;
  if (!isObject(identity)) {
    errors.push('identity must be an object');
  } else {
    for (const field of IDENTITY_FIELDS) {
      if (typeof identity[field] !== 'string') errors.push(`identity.${field} must be a string`);
    }
    if (typeof identity.maintenance_window_approved !== 'boolean') {
      errors.push('identity.maintenance_window_approved must be a boolean');
    }
  }

  const preconditions = evidence.preconditions;
  if (!isObject(preconditions)) {
    errors.push('preconditions must be an object');
  } else {
    for (const key of PRECONDITION_KEYS) {
      if (typeof preconditions[key] !== 'boolean') errors.push(`preconditions.${key} must be a boolean`);
    }
  }

  const simulator = validateCaseList(evidence.simulator_tests, 'simulator_tests', SIMULATOR_CASE_IDS, errors);
  const hil = validateCaseList(evidence.hil_tests, 'hil_tests', HIL_CASE_IDS, errors);

  const reconciliation = evidence.reconciliation;
  if (!isObject(reconciliation)) {
    errors.push('reconciliation must be an object');
  } else {
    for (const field of COUNTER_FIELDS) {
      if (!Number.isSafeInteger(reconciliation[field]) || reconciliation[field] < 0) {
        errors.push(`reconciliation.${field} must be a non-negative safe integer`);
      }
    }
    if (!Array.isArray(reconciliation.unresolved_alarm_ids)
        || reconciliation.unresolved_alarm_ids.some((id) => typeof id !== 'string' || !id.trim())) {
      errors.push('reconciliation.unresolved_alarm_ids must be an array of non-empty strings');
    }
    if (Number.isSafeInteger(reconciliation.events_durably_spooled)
        && Number.isSafeInteger(reconciliation.events_generated)
        && reconciliation.events_durably_spooled > reconciliation.events_generated) {
      errors.push('reconciliation.events_durably_spooled cannot exceed events_generated');
    }
    if (Number.isSafeInteger(reconciliation.events_acknowledged)
        && Number.isSafeInteger(reconciliation.events_durably_spooled)
        && reconciliation.events_acknowledged > reconciliation.events_durably_spooled) {
      errors.push('reconciliation.events_acknowledged cannot exceed events_durably_spooled');
    }
  }

  if (!isObject(evidence.signoffs)) {
    errors.push('signoffs must be an object');
  } else {
    for (const [role] of SIGNOFFS) {
      const signoff = evidence.signoffs[role];
      if (!isObject(signoff)) {
        errors.push(`signoffs.${role} must be an object`);
        continue;
      }
      for (const field of ['name', 'signature_artifact_ref', 'signature_artifact_sha256', 'signed_at']) {
        if (typeof signoff[field] !== 'string') {
          errors.push(`signoffs.${role}.${field} must be a string`);
        }
      }
      if (typeof signoff.signature_artifact_sha256 === 'string'
          && signoff.signature_artifact_sha256 !== ''
          && !/^[a-f0-9]{64}$/i.test(signoff.signature_artifact_sha256)) {
        errors.push(`signoffs.${role}.signature_artifact_sha256 must be a 64-hex SHA-256`);
      }
    }
  }

  if (!['IN_PROGRESS', 'FAIL', 'CONDITIONAL', 'PASS'].includes(evidence.decision)) {
    errors.push('decision must be IN_PROGRESS, FAIL, CONDITIONAL or PASS');
  }
  if (typeof evidence.decision_reason !== 'string') errors.push('decision_reason must be a string');
  if (!Array.isArray(evidence.conditions)
      || evidence.conditions.some((condition) => typeof condition !== 'string')) {
    errors.push('conditions must be an array of strings');
  }

  if (evidence.decision === 'FAIL' && isPlaceholder(evidence.decision_reason)) {
    errors.push('decision_reason is required for a FAIL decision');
  }
  if (evidence.decision === 'CONDITIONAL') {
    if (isPlaceholder(evidence.decision_reason)) errors.push('decision_reason is required for a CONDITIONAL decision');
    if (!Array.isArray(evidence.conditions)
        || evidence.conditions.length === 0
        || evidence.conditions.some((condition) => isPlaceholder(condition))) {
      errors.push('CONDITIONAL decision requires at least one explicit condition');
    }
  }

  if (evidence.decision === 'PASS') {
    if (!isObject(identity)) {
      errors.push('PASS requires complete identity metadata');
    } else {
      for (const field of IDENTITY_FIELDS) {
        if (isPlaceholder(identity[field])) errors.push(`PASS requires identity.${field}`);
      }
      if (identity.maintenance_window_approved !== true) {
        errors.push('PASS requires identity.maintenance_window_approved = true');
      }
      if (!/^sha256:[a-f0-9]{64}$/i.test(identity.gateway_image_digest ?? '')) {
        errors.push('PASS requires an immutable sha256:<64-hex> gateway_image_digest');
      }
      if (!/^[a-f0-9]{40}$/i.test(identity.gateway_source_commit ?? '')) {
        errors.push('PASS requires a 40-hex gateway_source_commit from the signed release receipt');
      }
      if (!validEvidenceReference(identity.gateway_release_receipt_ref)) {
        errors.push('PASS requires identity.gateway_release_receipt_ref');
      }
      if (!/^[a-f0-9]{64}$/i.test(identity.gateway_release_receipt_sha256 ?? '')) {
        errors.push('PASS requires a 64-hex gateway_release_receipt_sha256');
      }
      if (!/^[a-f0-9]{64}$/i.test(identity.gateway_config_sha256 ?? '')) {
        errors.push('PASS requires a 64-hex gateway_config_sha256');
      }
      if (!/^[a-f0-9]{40}$/i.test(identity.api_build_sha ?? '')) {
        errors.push('PASS requires a 40-hex api_build_sha');
      }
      if (!validTimestamp(identity.test_started_at) || !validTimestamp(identity.test_ended_at)) {
        errors.push('PASS requires ISO-8601 test timestamps with an explicit timezone');
      } else if (Date.parse(identity.test_ended_at) <= Date.parse(identity.test_started_at)) {
        errors.push('PASS requires test_ended_at to be later than test_started_at');
      }
    }

    if (!isObject(preconditions) || PRECONDITION_KEYS.some((key) => preconditions[key] !== true)) {
      errors.push('PASS requires every commissioning precondition to be true');
    }

    for (const [path, ids, rows] of [
      ['simulator_tests', SIMULATOR_CASE_IDS, simulator],
      ['hil_tests', HIL_CASE_IDS, hil],
    ]) {
      for (const id of ids) {
        const row = rows.get(id);
        if (!row || row.result !== 'PASS') {
          errors.push(`PASS requires ${path} case ${id} to have result PASS`);
        } else if (!validEvidenceReference(row.artifact_ref)) {
          errors.push(`PASS requires an artifact_ref for ${path} case ${id}`);
        }
        if (row && !/^[a-f0-9]{64}$/i.test(row.artifact_sha256 ?? '')) {
          errors.push(`PASS requires a SHA-256 artifact_sha256 for ${path} case ${id}`);
        }
      }
    }

    if (isObject(reconciliation)) {
      if (reconciliation.events_generated !== reconciliation.events_durably_spooled
          || reconciliation.events_durably_spooled !== reconciliation.events_acknowledged) {
        errors.push('PASS requires generated, durably spooled and API-acknowledged event counts to reconcile exactly');
      }
      if (reconciliation.unresolved_sequence_gaps !== 0) {
        errors.push('PASS requires reconciliation.unresolved_sequence_gaps = 0');
      }
      if (reconciliation.pending_spool_entries !== 0 || reconciliation.blocked_spool_entries !== 0) {
        errors.push('PASS requires zero pending and blocked spool entries');
      }
      if (Array.isArray(reconciliation.unresolved_alarm_ids) && reconciliation.unresolved_alarm_ids.length > 0) {
        errors.push('PASS requires no unresolved alarm IDs');
      }
    }

    if (!isObject(evidence.signoffs)) {
      errors.push('PASS requires all three authorized signoffs');
    } else {
      for (const [role, identityField] of SIGNOFFS) {
        const signoff = evidence.signoffs[role];
        if (!isObject(signoff)) continue;
        if (isPlaceholder(signoff.name) || signoff.name !== identity?.[identityField]) {
          errors.push(`PASS requires signoffs.${role}.name to match identity.${identityField}`);
        }
        if (!validEvidenceReference(signoff.signature_artifact_ref)) {
          errors.push(`PASS requires signoffs.${role}.signature_artifact_ref`);
        }
        if (!/^[a-f0-9]{64}$/i.test(signoff.signature_artifact_sha256 ?? '')) {
          errors.push(`PASS requires signoffs.${role}.signature_artifact_sha256`);
        }
        if (!validTimestamp(signoff.signed_at)) {
          errors.push(`PASS requires signoffs.${role}.signed_at with an explicit timezone`);
        }
      }
    }

    if (Array.isArray(evidence.conditions) && evidence.conditions.length > 0) {
      errors.push('PASS cannot contain outstanding conditions');
    }
  }

  return [...new Set(errors)];
}


function isSafeRelativeArtifactReference(reference) {
  if (typeof reference !== 'string' || isPlaceholder(reference)
      || isAbsolute(reference) || /^[a-z]:/i.test(reference) || reference.includes('\\')) return false;
  const segments = reference.split('/');
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Verify local artifact bytes; this does not authenticate a signer or prove a test occurred. */
export async function verifyCommissioningArtifactReferences(evidence, artifactRoot) {
  const errors = [];
  let root;
  try {
    root = await realpath(resolve(artifactRoot));
    if (!(await lstat(root)).isDirectory()) return ['artifact root must be a directory'];
  } catch {
    return ['artifact root is missing or unreadable'];
  }

  const entries = [];
  for (const path of ['simulator_tests', 'hil_tests']) {
    if (!Array.isArray(evidence?.[path])) continue;
    for (const item of evidence[path]) {
      if (!isObject(item) || item.result === 'NOT_RUN') continue;
      entries.push({ label: `${path} case ${String(item.case_id)}`, reference: item.artifact_ref, sha256: item.artifact_sha256 });
    }
  }
  for (const [role] of SIGNOFFS) {
    const signoff = evidence?.signoffs?.[role];
    if (isObject(signoff)) entries.push({
      label: `signoffs.${role}`,
      reference: signoff.signature_artifact_ref,
      sha256: signoff.signature_artifact_sha256,
    });
  }
  if (isObject(evidence?.identity)) entries.push({
    label: 'identity.gateway_release_receipt',
    reference: evidence.identity.gateway_release_receipt_ref,
    sha256: evidence.identity.gateway_release_receipt_sha256,
    kind: 'otGatewayReleaseReceipt',
  });

  for (const entry of entries) {
    if (!isSafeRelativeArtifactReference(entry.reference)) {
      errors.push(`${entry.label} has an unsafe artifact_ref; use a relative path inside --artifact-root`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '')) {
      errors.push(`${entry.label} requires a 64-hex SHA-256 digest`);
      continue;
    }
    const candidate = resolve(root, ...entry.reference.split('/'));
    const fromRoot = relative(root, candidate);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
      errors.push(`${entry.label} artifact path escapes --artifact-root`);
      continue;
    }
    try {
      let current = root;
      const segments = entry.reference.split('/');
      let targetStat;
      for (let index = 0; index < segments.length; index += 1) {
        current = join(current, segments[index]);
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error('symlink');
        if (index < segments.length - 1 && !stat.isDirectory()) throw new Error('not-directory');
        targetStat = stat;
      }
      if (!targetStat?.isFile()) {
        errors.push(`${entry.label} artifact is not a regular file`);
        continue;
      }
      const resolvedTarget = await realpath(candidate);
      const realFromRoot = relative(root, resolvedTarget);
      if (!realFromRoot || realFromRoot === '..' || realFromRoot.startsWith('..' + sep) || isAbsolute(realFromRoot)) {
        errors.push(`${entry.label} artifact path escapes --artifact-root`);
        continue;
      }
      const bytes = await readFile(resolvedTarget);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
        errors.push(`${entry.label} artifact SHA-256 does not match recorded digest`);
        continue;
      }
      if (entry.kind === 'otGatewayReleaseReceipt') {
        let receipt;
        try { receipt = JSON.parse(bytes.toString('utf8')); }
        catch {
          errors.push('gateway release receipt is not valid JSON');
          continue;
        }
        const expectedKeys = ['image', 'provenanceAttested', 'repository', 'signatureVerified', 'signingWorkflow', 'sourceCommit'];
        const actualKeys = isObject(receipt) ? Object.keys(receipt).sort() : [];
        const expectedImage = `${OT_GATEWAY_IMAGE}@${evidence.identity.gateway_image_digest}`;
        const validReceipt = isObject(receipt)
          && actualKeys.length === expectedKeys.length
          && expectedKeys.every((key) => actualKeys.includes(key))
          && receipt.repository === OT_GATEWAY_REPOSITORY
          && typeof receipt.sourceCommit === 'string'
          && receipt.sourceCommit.toLowerCase() === evidence.identity.gateway_source_commit.toLowerCase()
          && receipt.image === expectedImage
          && receipt.signatureVerified === true
          && receipt.provenanceAttested === true
          && receipt.signingWorkflow === OT_GATEWAY_SIGNING_WORKFLOW;
        if (!validReceipt) {
          errors.push('gateway release receipt does not bind to the expected repository, source commit, image digest and trusted main signing workflow');
        }
      }
    } catch {
      errors.push(`${entry.label} artifact is missing, unreadable or traverses a symlink`);
    }
  }
  return [...new Set(errors)];
}

async function main() {
  const args = process.argv.slice(2);
  let allowIncomplete = false;
  let artifactRoot = null;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--allow-incomplete') {
      allowIncomplete = true;
    } else if (arg === '--artifact-root') {
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
        process.stderr.write('Option --artifact-root requires a directory path\n');
        process.exitCode = 2;
        return;
      }
      artifactRoot = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exitCode = 2;
      return;
    } else {
      positional.push(arg);
    }
  }
  const file = positional[0];
  if (!file || positional.length !== 1) {
    process.stderr.write('Usage: node scripts/validate-commissioning-evidence.mjs [--allow-incomplete] [--artifact-root <directory>] <record.json>\n');
    process.exitCode = 2;
    return;
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(file), 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse/read error';
    process.stderr.write(`Evidence file could not be read as JSON: ${reason}\n`);
    process.exitCode = 2;
    return;
  }

  const errors = validateCommissioningEvidence(evidence);
  if (!allowIncomplete && evidence?.decision !== 'PASS') {
    errors.push('release acceptance requires decision PASS (use --allow-incomplete only for draft review)');
  }
  if (!allowIncomplete && evidence?.decision === 'PASS' && !artifactRoot) {
    errors.push('release acceptance requires --artifact-root <directory> to verify referenced artifact bytes');
  }
  if (!allowIncomplete && evidence?.decision === 'PASS' && artifactRoot) {
    errors.push(...await verifyCommissioningArtifactReferences(evidence, artifactRoot));
  }
  if (errors.length > 0) {
    process.stderr.write('Commissioning evidence rejected:\n' + [...new Set(errors)].map((error) => `- ${error}`).join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  if (evidence.decision === 'PASS') {
    process.stdout.write('Commissioning evidence passed structural, artifact existence and SHA-256 integrity checks. Signer authenticity and real-world commissioning still require independent verification.\n');
  } else {
    process.stdout.write(`Draft commissioning evidence structure is valid; decision is ${evidence.decision}. This is not release acceptance.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
