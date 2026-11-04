import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ledger = JSON.parse(readFileSync(
  new URL('../../docs/srs-v20-inherited-occurrence-candidate-ledger.payload-manifest.json', import.meta.url), 'utf8'));

test('candidate census is source-pinned and full row output is not misrepresented as checked in', () => {
  assert.equal(ledger.ledger_id, 'FOS-SRS-V20-INHERITED-CANDIDATE-01');
  assert.equal(ledger.source_artifact_sha256, '8f905b3cd7dfb8b5fff3df98ba5496427b844de6a592c619ac7ab002db7fec42');
  assert.equal(ledger.source_pdf_page_count, 93);
  assert.equal(ledger.row_level_output_committed, false);
  assert.match(ledger.row_level_output_policy, /regenerated with the extractor/);
});

test('normative rows and non-normative contexts remain separate populations', () => {
  assert.equal(ledger.candidate_occurrence_count, 854);
  assert.equal(ledger.distinct_id_candidate_count, 812);
  assert.equal(ledger.normative_requirement_table_candidate_count, 809);
  assert.equal(ledger.normative_distinct_id_candidate_count, 799);
  assert.deepEqual(ledger.normative_priority_counts, { P0: 225, P1: 527, P2: 57 });
  assert.equal(ledger.auxiliary_catalogue_candidate_count, 13);
  assert.deepEqual(ledger.auxiliary_catalogue_priority_counts, { P0: 2, P1: 11, P2: 0 });
  assert.equal(ledger.non_normative_context_candidate_count, 32);
  assert.equal(ledger.table_kind_candidate_counts.SCOPE_LEDGER_OR_CROSSWALK_CANDIDATE, 30);
  assert.equal(ledger.table_kind_candidate_counts.METRIC_OR_DECISION_CROSS_REFERENCE_CANDIDATE, 2);
});

test('reused IDs remain separate and the page-six wording cross-reference is not an orphan', () => {
  assert.equal(Object.keys(ledger.repeated_normative_id_candidates).length, 10);
  for (let i = 1; i <= 10; i++) {
    assert.equal(ledger.repeated_normative_id_candidates['FR-IOT-' + String(i).padStart(2, '0')], 2);
  }
  assert.equal(ledger.unresolved_line_candidate_count, 0);
  assert.equal(ledger.parser_false_positive_review.token, 'FR-AIG-03');
  assert.equal(ledger.parser_false_positive_review.context_requirement_id, 'FR-CBB-19');
  assert.equal(ledger.parser_false_positive_review.status, 'COVERED_BY_SYNTHETIC_REGRESSION');
});

test('§140 scope figures are kept separate and do not close the owner gate', () => {
  assert.equal(ledger.inherited_scope_claim.requirements, 900);
  assert.deepEqual(ledger.inherited_scope_claim.priorities, { P0: 261, P1: 567, P2: 72 });
  assert.equal(ledger.inherited_scope_claim.status, 'SOURCE_DECLARED_ARITHMETIC_NOT_ROW_LEVEL_RECONCILIATION');
  assert.equal(ledger.acceptance_boundary.includes('does not establish'), true);
});
