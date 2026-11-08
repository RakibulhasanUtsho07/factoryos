import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  assert.equal(quoted, false, 'CSV must not contain an unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseObjects(input, expectedHeader) {
  const rows = parseCsv(input);
  assert.deepEqual(rows[0], expectedHeader);
  return rows.slice(1).map((cells) => {
    assert.equal(cells.length, expectedHeader.length, 'CSV row column count must match its header');
    return Object.fromEntries(expectedHeader.map((key, index) => [key, cells[index]]));
  });
}

function parsePageTable(markdown) {
  const result = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((value) => value.trim());
    if (!/^(FR|NFR)-[A-Z0-9]+-\d{2}$/.test(cells[0] ?? '')) continue;
    assert.equal(cells.length, 4, 'Page-review table rows must keep four columns');
    assert.ok(!result.has(cells[0]), 'Duplicate page-review ID: ' + cells[0]);
    result.set(cells[0], {
      pages: cells[1],
      context: cells[2],
      assessment: cells[3],
    });
  }
  return result;
}

const EXPECTED_IDS = [
  'FR-AIG-01', 'FR-AIG-03', 'FR-AIG-04', 'FR-AIG-05', 'FR-AIG-06',
  'FR-AIG-07', 'FR-AIG-08', 'FR-AIG-09', 'FR-ANL-04', 'FR-ANL-10',
  'FR-ANL-12', 'FR-BD-02', 'FR-BD-10', 'FR-CHN-01', 'FR-CHN-03',
  'FR-CHN-05', 'FR-CMP-01', 'FR-CMP-03', 'FR-CMP-04', 'FR-CST-06',
  'FR-ESG-01', 'FR-FBR-01', 'FR-FBR-02', 'FR-FBR-08', 'FR-FBR-09',
  'FR-FBR-10', 'FR-FBR-11', 'FR-INT-01', 'FR-INT-03', 'FR-RMG-01',
  'FR-RMG-02', 'FR-RMG-06', 'NFR-COST-01', 'NFR-DPR-01', 'NFR-LOC-01',
  'NFR-OFF-01', 'NFR-SEC-02',
];

const SOURCE_HEADER = [
  'requirementId', 'literalFindCount', 'sourcePagesWithLiteralOccurrence',
  'observedReferenceContext', 'oneLineNormativeRowSearchMatches',
  'sourceOwnerDisposition', 'sourceOwnerDecisionRef', 'reviewer', 'reviewDate',
];
const DECISION_HEADER = [
  'requirementId', 'machineAssessmentCandidate', 'literalFindCount',
  'sourcePagesWithLiteralOccurrence', 'observedReferenceContext',
  'oneLineNormativeRowSearchMatches', 'sourceOwnerDisposition',
  'canonicalRequirementId', 'canonicalSourceDocumentReference',
  'canonicalSourceRevision', 'canonicalSourceSection', 'canonicalSourcePdfPage',
  'canonicalSourceTableIndex', 'canonicalSourceRowIndex',
  'canonicalNormativeWording', 'sourcePriority', 'decisionRationale',
  'sourceOwnerDecisionRef', 'reviewer', 'reviewDate',
];

const [sourceCsv, decisionCsv, pageReview, priorReview] = await Promise.all([
  read('docs/srs-priority-exception-source-review.csv'),
  read('docs/srs-priority-exception-owner-decision-register.csv'),
  read('docs/srs-priority-exception-source-review-2026-11-04.md'),
  read('docs/srs-priority-exception-source-review.md'),
]);
const sourceRows = parseObjects(sourceCsv, SOURCE_HEADER);
const decisionRows = parseObjects(decisionCsv, DECISION_HEADER);
const pageById = parsePageTable(pageReview);
const sourceById = new Map(sourceRows.map((row) => [row.requirementId, row]));
const decisionById = new Map(decisionRows.map((row) => [row.requirementId, row]));

const machineAssessments = new Set([
  'HISTORY_REFERENCE_CANDIDATE',
  'CROSS_REFERENCE_CANDIDATE',
  'KPI_REFERENCE_CANDIDATE',
]);
const finalDispositions = new Set([
  'CANONICAL_REQUIREMENT_ROW',
  'CROSS_REFERENCE_ONLY',
  'SUPERSEDED_OR_MERGED',
  'SOURCE_EXTRACTION_DEFECT',
  'EXCLUDED_WITH_APPROVAL',
]);
const sourceEvidenceFields = [
  'canonicalRequirementId', 'canonicalSourceDocumentReference',
  'canonicalSourceRevision', 'canonicalSourceSection', 'canonicalSourcePdfPage',
  'canonicalNormativeWording', 'sourcePriority',
];
const normativeRowFields = ['canonicalSourceTableIndex', 'canonicalSourceRowIndex'];
const approvalFields = ['decisionRationale', 'sourceOwnerDecisionRef', 'reviewer', 'reviewDate'];

function requireText(value, field, id) {
  assert.equal(typeof value, 'string');
  assert.ok(value.trim().length > 0, field + ' is required for ' + id);
  assert.ok(!/^(pending|tbd|n\/a|unknown)$/i.test(value.trim()),
    field + ' must be a real source-owner value for ' + id);
}

function validateDisposition(row) {
  const id = row.requirementId;
  if (row.sourceOwnerDisposition === 'OPEN_SOURCE_OWNER_REVIEW') {
    for (const field of [...sourceEvidenceFields, ...normativeRowFields, ...approvalFields]) {
      assert.equal(row[field], '', 'Open row must not imply ' + field + ': ' + id);
    }
    return;
  }

  assert.ok(finalDispositions.has(row.sourceOwnerDisposition),
    'Unsupported source-owner disposition for ' + id);
  for (const field of approvalFields) requireText(row[field], field, id);
  assert.match(row.reviewDate, /^\d{4}-\d{2}-\d{2}$/,
    'reviewDate must be an ISO calendar date for ' + id);
  const parsedDate = new Date(row.reviewDate + 'T00:00:00.000Z');
  assert.equal(Number.isFinite(parsedDate.getTime()), true, 'reviewDate must be valid for ' + id);
  assert.equal(parsedDate.toISOString().slice(0, 10), row.reviewDate,
    'reviewDate must be a real date for ' + id);

  if (row.sourceOwnerDisposition !== 'EXCLUDED_WITH_APPROVAL') {
    for (const field of sourceEvidenceFields) requireText(row[field], field, id);
    assert.match(row.canonicalRequirementId, /^(FR|NFR)-[A-Z0-9]+-\d{2}$/,
      'canonicalRequirementId must identify a canonical requirement for ' + id);
    assert.ok(['P0', 'P1', 'P2'].includes(row.sourcePriority),
      'sourcePriority must be P0/P1/P2 for ' + id);
    assert.match(row.canonicalSourcePdfPage, /^\d+$/,
      'canonical source PDF page is required for ' + id);
    const page = Number(row.canonicalSourcePdfPage);
    assert.ok(page >= 1 && page <= 10000, 'canonical source page is outside bounds for ' + id);
    if (['CANONICAL_REQUIREMENT_ROW', 'SOURCE_EXTRACTION_DEFECT'].includes(row.sourceOwnerDisposition)) {
      for (const field of normativeRowFields) requireText(row[field], field, id);
      for (const field of normativeRowFields) {
        assert.match(row[field], /^\d+$/, field + ' must be a positive table row/index for ' + id);
        assert.ok(Number(row[field]) >= 1, field + ' must be >= 1 for ' + id);
      }
    }
  }
}

test('decision register has exactly the 37 known exception IDs once each', () => {
  assert.equal(sourceRows.length, 37);
  assert.equal(decisionRows.length, 37);
  assert.deepEqual(sourceRows.map((row) => row.requirementId), EXPECTED_IDS);
  assert.deepEqual(decisionRows.map((row) => row.requirementId), EXPECTED_IDS);
  assert.equal(sourceById.size, 37);
  assert.equal(decisionById.size, 37);
});

test('each page-context candidate reconciles to the original literal-search evidence', () => {
  assert.equal(pageById.size, 37);
  for (const id of EXPECTED_IDS) {
    const source = sourceById.get(id);
    const decision = decisionById.get(id);
    const page = pageById.get(id);
    assert.ok(source && decision && page, 'Missing evidence for ' + id);
    assert.equal(decision.literalFindCount, source.literalFindCount, 'Literal count drift for ' + id);
    assert.equal(decision.sourcePagesWithLiteralOccurrence, source.sourcePagesWithLiteralOccurrence,
      'Literal page list drift for ' + id);
    assert.equal(decision.observedReferenceContext, source.observedReferenceContext,
      'Diagnostic context drift for ' + id);
    assert.equal(decision.oneLineNormativeRowSearchMatches, source.oneLineNormativeRowSearchMatches,
      'One-line diagnostic drift for ' + id);
    assert.equal(decision.machineAssessmentCandidate, page.assessment,
      'Page-review candidate assessment drift for ' + id);

    const sourcePages = [...new Set(source.sourcePagesWithLiteralOccurrence.split(';').map((value) => Number(value.trim())))].sort((a, b) => a - b);
    const reviewPages = [...new Set(page.pages.split(',').map((value) => Number(value.trim())))].sort((a, b) => a - b);
    assert.deepEqual(sourcePages, reviewPages, 'Page locator mismatch for ' + id);
    assert.ok(sourcePages.every((value) => Number.isInteger(value) && value >= 1 && value <= 103),
      'Page locator outside the 103-page artifact for ' + id);
  }
});

test('machine assessments stay explicitly provisional and never become owner dispositions', () => {
  assert.match(pageReview, /not Product\/Requirements approval/i);
  assert.match(pageReview, /not sufficient to say the IDs are excluded from the 900 inherited v2\.0 scope/i);
  assert.match(priorReview, /Product\/Requirements source-owner disposition required/i);
  for (const row of decisionRows) {
    assert.ok(machineAssessments.has(row.machineAssessmentCandidate),
      'Unexpected machine candidate label for ' + row.requirementId);
    assert.ok(row.machineAssessmentCandidate.endsWith('_CANDIDATE'));
  }
});

test('current decision register keeps all 37 source-owner dispositions open', () => {
  for (const row of decisionRows) {
    assert.equal(row.sourceOwnerDisposition, 'OPEN_SOURCE_OWNER_REVIEW', row.requirementId);
    assert.equal(row.oneLineNormativeRowSearchMatches, '0', row.requirementId);
    validateDisposition(row);
  }
});

test('a completed canonical decision requires source locator, wording, priority and reviewer evidence', () => {
  const valid = {
    ...decisionRows[0],
    sourceOwnerDisposition: 'CANONICAL_REQUIREMENT_ROW',
    canonicalRequirementId: 'FR-AIG-01',
    canonicalSourceDocumentReference: 'DMS:FOS-SRS-002',
    canonicalSourceRevision: 'v2.0-approved',
    canonicalSourceSection: '6.2',
    canonicalSourcePdfPage: '42',
    canonicalSourceTableIndex: '1',
    canonicalSourceRowIndex: '3',
    canonicalNormativeWording: 'Example normative SHALL wording.',
    sourcePriority: 'P1',
    decisionRationale: 'Source-owner verified canonical row.',
    sourceOwnerDecisionRef: 'REQ-DECISION-2026-001',
    reviewer: 'Requirements Lead',
    reviewDate: '2026-11-04',
  };
  assert.doesNotThrow(() => validateDisposition(valid));
  assert.throws(() => validateDisposition({ ...valid, canonicalNormativeWording: '' }),
    /canonicalNormativeWording is required/);
  assert.throws(() => validateDisposition({ ...valid, sourceOwnerDecisionRef: '' }),
    /sourceOwnerDecisionRef is required/);
  assert.throws(() => validateDisposition({ ...valid, sourcePriority: 'REVIEW SOURCE' }),
    /sourcePriority must be P0\/P1\/P2/);
});

test('approved exclusion requires a rationale, immutable decision reference and reviewer', () => {
  const valid = {
    ...decisionRows[0],
    sourceOwnerDisposition: 'EXCLUDED_WITH_APPROVAL',
    decisionRationale: 'Approved exclusion under the controlled change decision.',
    sourceOwnerDecisionRef: 'REQ-DECISION-2026-002',
    reviewer: 'Product Owner',
    reviewDate: '2026-11-04',
  };
  assert.doesNotThrow(() => validateDisposition(valid));
  assert.throws(() => validateDisposition({ ...valid, reviewer: '' }), /reviewer is required/);
  assert.throws(() => validateDisposition({ ...valid, reviewDate: '2026-02-30' }), /real date/);
});

console.log('SRS priority-exception owner decision register contract passed');
