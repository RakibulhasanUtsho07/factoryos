import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(
  new URL('../../docs/srs-revision-occurrence-crosswalk.manifest.json', import.meta.url), 'utf8'));
const encoded = manifest.payload_parts.map((part) => readFileSync(
  new URL('../../docs/' + part, import.meta.url), 'utf8').trim()).join('');
const compressed = Buffer.from(encoded, 'base64');
assert.equal(compressed.length, manifest.compressed_bytes);
assert.equal(createHash('sha256').update(compressed).digest('hex'), manifest.compressed_sha256);
const raw = gunzipSync(compressed);
assert.equal(raw.length, manifest.uncompressed_bytes);
assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.uncompressed_sha256);
const crosswalk = JSON.parse(raw.toString('utf8'));
const rows = crosswalk.rows;
const rowById = new Map(rows.map((row) => [row[0], row]));
const count = (predicate) => rows.filter(predicate).length;

test('compressed crosswalk payload is byte-integrity protected and source pinned', () => {
  assert.equal(manifest.crosswalk_id, 'FOS-SRS-REVISION-OCCURRENCE-CROSSWALK-01');
  assert.equal(manifest.row_count, 886);
  assert.equal(rows.length, 886);
  assert.equal(crosswalk.crosswalk_id, manifest.crosswalk_id);
  assert.deepEqual(manifest.source_hashes, {
    srs_v20_candidate: '8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42',
    srs_v19_growth_delta: '09f796a867941d4738b07eea5f9169ed2de9351fb7a6111b676bf9342bfbb5a1',
    srs_v21_final_candidate: 'ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959',
  });
});

test('v2.0 inherited and v2.1 inherited ID sets match without collapsing occurrences', () => {
  assert.equal(crosswalk.summary.v20_normative_occurrence_count, 809);
  assert.equal(crosswalk.summary.v20_distinct_normative_id_count, 799);
  assert.equal(crosswalk.summary.v21_inherited_occurrences, 807);
  assert.equal(crosswalk.summary.v21_inherited_distinct_ids, 799);
  assert.equal(crosswalk.summary.v20_v21_inherited_id_intersection, 799);
  assert.equal(crosswalk.summary.v20_only_ids, 0);
  assert.equal(crosswalk.summary.v21_inherited_only_ids, 0);
  assert.equal(count((row) => row[1].length > 0 && row[3].length > 0), 799);
  assert.deepEqual(crosswalk.summary.v20_v21_occurrence_count_delta_ids, [
    ['FR-IOT-09', 2, 1],
    ['FR-IOT-10', 2, 1],
  ]);
  for (let i = 1; i <= 10; i++) {
    assert.equal(crosswalk.summary.v20_repeated_normative_ids['FR-IOT-' + String(i).padStart(2, '0')], 2);
  }
});

test('v1.9 growth delta has 92/92 inherited ID and priority matches', () => {
  assert.equal(crosswalk.summary.v19_growth_delta_occurrence_count, 92);
  assert.equal(crosswalk.summary.v19_growth_delta_distinct_id_count, 92);
  assert.deepEqual(crosswalk.summary.v19_priority_counts, { P0: 37, P1: 55 });
  assert.equal(crosswalk.summary.v19_ids_found_in_v20, 92);
  assert.equal(crosswalk.summary.v19_ids_found_in_v21_inherited, 92);
  assert.equal(crosswalk.summary.v19_priority_comparison_count, 92);
  assert.equal(crosswalk.summary.v19_priority_conflict_count, 0);
  for (const row of rows.filter((item) => item[2].length > 0)) {
    assert.equal(row[1].length > 0, true);
    assert.equal(row[3].length > 0, true);
    assert.equal(row[6], 'PRIORITY_MATCH');
    assert.equal(row[2].length, 1);
  }
});

test('official v2.1 delta agrees with the full-PDF candidate rows', () => {
  assert.equal(crosswalk.summary.v21_new_delta_rows, 50);
  assert.equal(crosswalk.summary.v21_new_delta_distinct_ids, 50);
  assert.deepEqual(crosswalk.summary.v21_new_delta_priority_counts, { P0: 35, P1: 15 });
  assert.equal(crosswalk.summary.v21_official_delta_vs_full_pdf_conflict_count, 0);
  assert.equal(crosswalk.summary.v21_new_delta_ids_found_in_v20_inherited, 0);
  const delta = rows.filter((row) => row[4].length > 0);
  assert.equal(delta.length, 50);
  assert.ok(delta.every((row) => row[1].length === 0 && row[2].length === 0));
});

test('wording hash differences remain a review queue, not inferred changes', () => {
  assert.equal(crosswalk.summary.v20_v21_priority_conflict_count, 0);
  assert.equal(crosswalk.summary.v20_v21_wording_hash_equal_id_count, 754);
  assert.equal(crosswalk.summary.v20_v21_wording_hash_different_id_count, 45);
  assert.equal(crosswalk.summary.v20_v21_wording_hash_equal_id_count
    + crosswalk.summary.v20_v21_wording_hash_different_id_count, 799);
  for (const rid of crosswalk.summary.v20_v21_wording_hash_difference_review_ids) {
    assert.equal(rowById.get(rid)[7], 'HASH_DIFFERENCE_REVIEW_REQUIRED');
  }
});

test('the 37 exceptions match the closure review subset and remain owner-open', () => {
  const exceptions = rows.filter((row) => row[8] === true);
  assert.equal(exceptions.length, 37);
  assert.equal(crosswalk.summary.priority_exception_count, 37);
  assert.equal(crosswalk.summary.priority_exceptions_in_v20_normative_rows, 0);
  assert.equal(crosswalk.summary.priority_exceptions_in_v21_normative_rows, 0);
  assert.equal(crosswalk.summary.priority_exceptions_in_v19_delta_rows, 0);
  assert.deepEqual(crosswalk.summary.priority_exception_machine_assessment_counts, {
    CROSS_REFERENCE_CANDIDATE: 31,
    HISTORY_REFERENCE_CANDIDATE: 3,
    KPI_REFERENCE_CANDIDATE: 3,
  });
  assert.equal(crosswalk.summary.closure_tracker_review_source_ids_equal_exception_register_ids, true);
  assert.equal(crosswalk.summary.provisional_closure_tracker_rows, 842);
  assert.equal(crosswalk.summary.provisional_closure_tracker_known_p0_p1_rows, 805);
  assert.equal(crosswalk.summary.provisional_closure_tracker_review_source_rows, 37);
  for (const row of exceptions) {
    assert.deepEqual(row.slice(1, 5), [[], [], [], []]);
    assert.equal(row[10], 'OPEN_SOURCE_OWNER_REVIEW');
  }
});

test('declared scope arithmetic is preserved as a claim, not an accepted active ledger', () => {
  assert.deepEqual(crosswalk.declared_scope_claim, {
    inherited_v20: 900,
    v21_delta: 50,
    cumulative: 950,
    cumulative_priority: { P0: 296, P1: 582, P2: 72 },
    status: 'SOURCE_DECLARED_ARITHMETIC_NOT_ROW_LEVEL_ACCEPTANCE',
  });
  assert.equal(crosswalk.summary.all_active_scope_and_canonical_classifications_unresolved, true);
  assert.match(crosswalk.acceptance_boundary, /does not prove 900 active inherited/);
  assert.ok(rows.every((row) => row.length === 12));
});
