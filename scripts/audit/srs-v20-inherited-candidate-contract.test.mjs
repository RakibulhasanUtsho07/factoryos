import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(
  new URL('../../docs/srs-v20-inherited-occurrence-candidate-ledger.payload-manifest.json', import.meta.url), 'utf8'));
const payload = manifest.payload_parts.map((part) => readFileSync(
  new URL('../../docs/' + part, import.meta.url), 'utf8').trim()).join('');
const raw = gunzipSync(Buffer.from(payload, 'base64'));
assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.uncompressed_sha256);
assert.equal(raw.length, manifest.uncompressed_bytes);
const ledger = JSON.parse(raw.toString('utf8'));
const rows = ledger.rows;
const kinds = (kind) => rows.filter((row) => row[3] === kind);
const normative = kinds('NORMATIVE_REQUIREMENT_TABLE');
const auxiliary = kinds('AUXILIARY_CATALOGUE_TABLE');
const context = rows.filter((row) => row[3] === 'SCOPE_LEDGER_OR_CROSSWALK_CANDIDATE'
  || row[3] === 'METRIC_OR_DECISION_CROSS_REFERENCE_CANDIDATE');
const priorityCounts = (list) => Object.fromEntries(['P0', 'P1', 'P2'].map((priority) =>
  [priority, list.filter((row) => row[5] === priority).length]));

test('snapshot is byte-integrity protected and source-pinned', () => {
  assert.equal(manifest.encoding, 'gzip+base64');
  assert.equal(manifest.payload_parts.length, 3);
  assert.equal(ledger.source_artifact_sha256,
    '8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42');
  assert.equal(ledger.source_pdf_page_count, 93);
  assert.equal(ledger.ledger_id, 'FOS-SRS-V20-INHERITED-CANDIDATE-01');
});

test('normative candidates stay separate from catalogue and non-normative contexts', () => {
  assert.equal(rows.length, 854);
  assert.equal(normative.length, 809);
  assert.equal(new Set(normative.map((row) => row[4])).size, 799);
  assert.equal(auxiliary.length, 13);
  assert.equal(context.length, 32);
  assert.deepEqual(priorityCounts(normative), { P0: 225, P1: 527, P2: 57 });
  assert.deepEqual(priorityCounts(auxiliary), { P0: 2, P1: 11, P2: 0 });
});

test('reused IDs remain separate occurrences rather than being deduplicated', () => {
  const counts = new Map();
  for (const row of normative) counts.set(row[4], (counts.get(row[4]) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, count]) => count > 1).sort();
  assert.deepEqual(repeated, Array.from({ length: 10 }, (_, i) =>
    ['FR-IOT-' + String(i + 1).padStart(2, '0'), 2]));
});

test('row snapshot fails closed: no active classification or owner approval inferred', () => {
  assert.ok(rows.every((row) => row.length === 7));
  assert.ok(normative.every((row) => typeof row[5] === 'string' && ['P0', 'P1', 'P2'].includes(row[5])));
  assert.ok(rows.every((row) => ['TABLE_ROW_CANDIDATE', 'NON_NORMATIVE_CONTEXT_CANDIDATE'].includes(row[6])));
  assert.equal(ledger.scope_claim.inherited_v20_cumulative_requirements, 900);
  assert.equal(ledger.normative_requirement_table_candidate_count, 809);
  assert.equal(ledger.unresolved_line_candidate_count, 1);
  assert.equal(ledger.acceptance_boundary.includes('does not establish'), true);
  assert.equal(Object.hasOwn(ledger, 'approved_active_occurrences'), false);
});
