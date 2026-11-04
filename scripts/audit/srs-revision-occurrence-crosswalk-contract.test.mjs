import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../docs/srs-revision-occurrence-crosswalk.manifest.json', import.meta.url), 'utf8'));
const s = manifest.summary;
const exceptions = ["FR-AIG-01","FR-AIG-03","FR-AIG-04","FR-AIG-05","FR-AIG-06","FR-AIG-07","FR-AIG-08","FR-AIG-09","FR-ANL-04","FR-ANL-10","FR-ANL-12","FR-BD-02","FR-BD-10","FR-CHN-01","FR-CHN-03","FR-CHN-05","FR-CMP-01","FR-CMP-03","FR-CMP-04","FR-CST-06","FR-ESG-01","FR-FBR-01","FR-FBR-02","FR-FBR-08","FR-FBR-09","FR-FBR-10","FR-FBR-11","FR-INT-01","FR-INT-03","FR-RMG-01","FR-RMG-02","FR-RMG-06","NFR-COST-01","NFR-DPR-01","NFR-LOC-01","NFR-OFF-01","NFR-SEC-02"].sort();

test('source artifacts and downloadable crosswalk payload are hash-pinned', () => {
  assert.equal(manifest.crosswalk_id, 'FOS-SRS-REVISION-OCCURRENCE-CROSSWALK-01');
  assert.equal(manifest.prepared_date, '2026-11-04');
  assert.equal(manifest.downloadable_payload.filename, 'srs-revision-occurrence-crosswalk.payload.gz.b64');
  assert.equal(manifest.downloadable_payload.committed_to_repository, false);
  assert.equal(manifest.downloadable_payload.included_in_download_archive, true);
  assert.equal(manifest.downloadable_payload.compressed_bytes, 50565);
  assert.equal(manifest.downloadable_payload.compressed_sha256, '5b4249f4123abe969104234baa32d93bca59f40659ab96b8de3609d455c86521');
  assert.equal(manifest.downloadable_payload.uncompressed_bytes, 250933);
  assert.equal(manifest.downloadable_payload.uncompressed_sha256, '9f94cb01de3842df637fb9e01faa72ea11a8ede038a4424a7219737f5b2e19fb');
  assert.deepEqual(manifest.source_hashes, {
    srs_v20_candidate: '8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42',
    srs_v19_growth_delta: '09f796a867941d4738b07eea5f9169ed2de9351fb7a6111b676bf9342bfbb5a1',
    srs_v21_final_candidate: 'ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959',
  });
});

test('v2.0 and v2.1 inherited candidate ID populations reconcile without erasing occurrences', () => {
  assert.equal(s.v20_normative_occurrence_count, 809);
  assert.equal(s.v20_distinct_normative_id_count, 799);
  assert.deepEqual(s.v20_priority_counts, { P0: 225, P1: 527, P2: 57 });
  assert.equal(s.v21_inherited_occurrences, 807);
  assert.equal(s.v21_inherited_distinct_ids, 799);
  assert.equal(s.v20_v21_inherited_id_intersection, 799);
  assert.equal(s.v20_only_ids, 0);
  assert.equal(s.v21_inherited_only_ids, 0);
  assert.deepEqual(s.v20_v21_occurrence_count_delta_ids, [['FR-IOT-09', 2, 1], ['FR-IOT-10', 2, 1]]);
  assert.equal(Object.keys(s.v20_repeated_normative_ids).length, 10);
});

test('all v1.9 and v2.1 delta comparisons pass candidate-level checks', () => {
  assert.equal(s.v19_growth_delta_occurrence_count, 92);
  assert.equal(s.v19_growth_delta_distinct_id_count, 92);
  assert.deepEqual(s.v19_priority_counts, { P0: 37, P1: 55 });
  assert.equal(s.v19_ids_found_in_v20, 92);
  assert.equal(s.v19_ids_found_in_v21_inherited, 92);
  assert.equal(s.v19_priority_comparison_count, 92);
  assert.equal(s.v19_priority_conflict_count, 0);
  assert.equal(s.v21_new_delta_rows, 50);
  assert.equal(s.v21_new_delta_distinct_ids, 50);
  assert.deepEqual(s.v21_new_delta_priority_counts, { P0: 35, P1: 15 });
  assert.equal(s.v21_official_delta_vs_full_pdf_conflict_count, 0);
  assert.equal(s.v21_new_delta_ids_found_in_v20_inherited, 0);
});

test('wording differences and priority differences remain separate dispositions', () => {
  assert.equal(s.v20_v21_priority_conflict_count, 0);
  assert.equal(s.v20_v21_wording_hash_equal_id_count, 754);
  assert.equal(s.v20_v21_wording_hash_different_id_count, 45);
  assert.equal(s.v20_v21_wording_hash_difference_review_ids.length, 45);
  assert.deepEqual([...s.v20_v21_wording_hash_difference_review_ids].sort(), s.v20_v21_wording_hash_difference_review_ids);
});

test('all 37 exceptions match the provisional closure tracker and remain open', () => {
  assert.equal(s.priority_exception_count, 37);
  assert.equal(s.priority_exceptions_in_v20_normative_rows, 0);
  assert.equal(s.priority_exceptions_in_v21_normative_rows, 0);
  assert.equal(s.priority_exceptions_in_v19_delta_rows, 0);
  assert.equal(s.closure_tracker_review_source_ids_equal_exception_register_ids, true);
  assert.deepEqual([...s.closure_tracker_review_source_ids].sort(), exceptions);
  assert.equal(s.provisional_closure_tracker_rows, 842);
  assert.equal(s.provisional_closure_tracker_known_p0_p1_rows, 805);
  assert.equal(s.provisional_closure_tracker_review_source_rows, 37);
});

test('declared 900 + 50 = 950 remains unapproved active-scope arithmetic', () => {
  assert.deepEqual(manifest.declared_scope_claim, {
    inherited_v20: 900,
    v21_delta: 50,
    cumulative: 950,
    cumulative_priority: { P0: 296, P1: 582, P2: 72 },
    status: 'SOURCE_DECLARED_ARITHMETIC_NOT_ROW_LEVEL_ACCEPTANCE',
  });
  assert.equal(s.all_active_scope_and_canonical_classifications_unresolved, true);
  assert.match(manifest.acceptance_boundary, /does not prove 900 active inherited/);
});
