#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const matrix = read('docs/srs-v2.1-requirement-evidence-matrix.md');
const audit = read('docs/final-srs-hld-blueprint-traceability-audit.md');
const scenarios = read('docs/srs-v2.1-as-132-141-acceptance-matrix.md');
const workPackages = read('docs/hld-blueprint-work-package-evidence-matrix.md');
const manifest = read('docs/audit-source-baseline-manifest.md');

const scopeReconciliation = read('docs/srs-requirement-scope-reconciliation.md');
const sourceApproval = read('docs/srs-source-of-record-and-approval-register.md');
const closureRegister = JSON.parse(read('docs/srs-p0-p1-evidence-closure-register.json'));
const closureCsv = read('docs/srs-p0-p1-evidence-closure.csv');
const exceptionSourceCsv = read('docs/srs-priority-exception-source-review.csv');
const releaseSnapshot = read('docs/srs-traceability-release-evidence-2026-10-20.md');

function extractRequirementRows(markdown) {
  const start = markdown.indexOf('## 3. Requirement ID register');
  const end = markdown.indexOf('## 4. Final SRS acceptance scenarios', start + 1);
  assert.notEqual(start, -1, 'Requirement matrix section 3 is missing');
  assert.notEqual(end, -1, 'Requirement matrix section 4 is missing');
  const section = markdown.slice(start, end);
  return section.split('\n').map((line) => {
    const match = line.match(/^\| ((?:FR|NFR)-[A-Z0-9]+-\d{2}) \| (P0|P1|P2|REVIEW SOURCE) \|/);
    return match ? { id: match[1], priority: match[2] } : null;
  }).filter(Boolean);
}


function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  assert.equal(quoted, false, 'Evidence closure CSV contains an unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function extractRequirementEvidenceRows(markdown) {
  const start = markdown.indexOf('## 3. Requirement ID register');
  const end = markdown.indexOf('## 4. Final SRS acceptance scenarios', start + 1);
  assert.notEqual(start, -1, 'Requirement matrix section 3 is missing');
  assert.notEqual(end, -1, 'Requirement matrix section 4 is missing');
  return markdown.slice(start, end).split('\n').flatMap((line) => {
    if (!line.startsWith('| FR-') && !line.startsWith('| NFR-')) return [];
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    return [{
      id: cells[0],
      priority: cells[1] ?? '',
      wording: cells[2] ?? '',
      assessment: cells[3] ?? '',
      evidence: cells[4] ?? '',
      gap: cells[5] ?? '',
    }];
  });
}

const requirementRows = extractRequirementRows(matrix);
const uniqueIds = new Set(requirementRows.map((row) => row.id));
assert.equal(requirementRows.length, 899, 'Review the source matrix diff before changing the extracted-ID count');
assert.equal(uniqueIds.size, requirementRows.length, 'Requirement ID rows must be unique');
const priorities = requirementRows.reduce((counts, row) => {
  const key = row.priority === 'REVIEW SOURCE' ? 'review' : row.priority;
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
assert.deepEqual(priorities, { P0: 259, P1: 546, P2: 57, review: 37 }, 'Priority totals differ from the source matrix; reconcile before changing expected counts');
assert.match(matrix, /Extracted distinct FR\/NFR IDs:\*\* 899/);
assert.match(matrix, /P0=259, P1=546, P2=57, priority requiring manual review=37/);
assert.match(matrix, /51 arithmetic delta is not a missing-implementation count/i);

for (let n = 132; n <= 141; n += 1) {
  const id = 'AS-' + n;
  assert.ok(scenarios.includes('**' + id), 'Detailed acceptance matrix is missing ' + id);
  assert.ok(audit.includes(id), 'Master audit is missing ' + id);
}
for (const id of ['NFR-PROD-11', 'NFR-PROD-12', 'NFR-PROD-14', 'NFR-PROD-17', 'NFR-PROD-18']) {
  assert.ok(matrix.includes('| ' + id + ' |'), 'Requirement matrix is missing ' + id);
  assert.ok(audit.includes(id), 'Master audit is missing ' + id);
}
for (const id of ['P0-01', 'P0-02', 'P0-03', ...Array.from({ length: 8 }, (_, i) => 'P1-0' + (i + 1))]) {
  assert.ok(audit.includes('| ' + id + ' |'), 'Master audit is missing gap ' + id);
}
for (let i = 1; i <= 16; i += 1) {
  const id = 'P2-' + String(i).padStart(2, '0');
  assert.ok(audit.includes('| ' + id + ' |'), 'Master audit is missing backlog item ' + id);
}
for (let i = 1; i <= 12; i += 1) {
  const id = 'WP' + String(i).padStart(2, '0');
  assert.ok(workPackages.includes(id), 'HLD/Blueprint matrix is missing ' + id);
}
const sourceHashes = [...manifest.matchAll(/\| [^|]+ \| [^|]+ \| 2026-10-02 \| \d+ \| \x60[^ \x60]+\x60 \| \x60([a-f0-9]{64})\x60 \|/g)].map((match) => match[1]);
assert.equal(sourceHashes.length, 3, 'Source manifest must pin exactly the three inspected baseline documents');
assert.equal(new Set(sourceHashes).size, 3, 'SRS/HLD/Blueprint SHA-256 references must be distinct');
assert.ok(sourceHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));
assert.ok(audit.includes('srs-v2.1-as-132-141-acceptance-matrix.md'), 'Master audit must link the detailed acceptance matrix');
assert.ok(audit.includes('hld-blueprint-work-package-evidence-matrix.md'), 'Master audit must link the HLD/Blueprint evidence matrix');
assert.ok(!audit.includes('| Final branch HEAD |'), 'Historical code/test baseline must not be labelled as the current branch HEAD');


assert.ok(audit.includes('srs-source-of-record-and-approval-register.md'), 'Master audit must link source approval register');
assert.ok(audit.includes('srs-requirement-scope-reconciliation.md'), 'Master audit must link scope reconciliation ledger');
assert.ok(audit.includes('srs-p0-p1-evidence-closure-register.md'), 'Master audit must link evidence closure rules');
assert.ok(audit.includes('srs-p0-p1-evidence-closure-register.json'), 'Master audit must link machine-readable P0/P1 closure rows');
assert.ok(sourceApproval.includes('BLOCKED — source-owner confirmation and controlled approval evidence pending'), 'Source-owner approval must remain visibly blocked until evidenced');
assert.ok(scopeReconciliation.includes('51') && scopeReconciliation.includes('not evidence of 51 missing implementations'), 'Scope ledger must not misclassify the count delta as missing code');

const closureRows = closureRegister.rows;
assert.equal(closureRegister.registerId, 'FOS-TRACE-P0P1-01');
assert.equal(closureRegister.status, 'OPEN_NOT_ACCEPTED');
assert.equal(closureRows.length, 842, 'Review evidence-closure row population before changing count');
const closureIds = closureRows.map((row) => row.requirementId);
assert.equal(new Set(closureIds).size, closureIds.length, 'Closure register requirement IDs must be unique');
const expectedGateIds = requirementRows.filter((row) => ['P0', 'P1', 'REVIEW SOURCE'].includes(row.priority)).map((row) => row.id).sort();
assert.equal(expectedGateIds.length, 842, 'Expected P0/P1 rows plus unresolved-priority rows must stay in release gate');
assert.deepEqual([...closureIds].sort(), expectedGateIds, 'Closure register must match all matrix P0/P1 and REVIEW SOURCE rows exactly');

const closurePriorities = closureRows.reduce((counts, row) => {
  counts[row.sourcePriority] = (counts[row.sourcePriority] ?? 0) + 1;
  return counts;
}, {});
assert.deepEqual(closurePriorities, { P0: 259, P1: 546, 'REVIEW SOURCE': 37 }, 'Closure register priorities differ from the extracted matrix');
const unresolvedMatrixIds = requirementRows.filter((row) => row.priority === 'REVIEW SOURCE').map((row) => row.id).sort();
const scopeReviewRows = scopeReconciliation.split('\n').filter((line) => /^\| (?:FR|NFR)-[A-Z0-9]+-\d{2} \|/.test(line));
const scopeReviewIds = scopeReviewRows.map((line) => line.split('|')[1].trim()).sort();
assert.equal(scopeReviewIds.length, 37, 'Scope ledger must list each of the 37 priority/wording exceptions exactly once');
assert.deepEqual(scopeReviewIds, unresolvedMatrixIds, 'Scope ledger exceptions must exactly match REVIEW SOURCE rows');



const exceptionRows = parseCsv(exceptionSourceCsv);
assert.equal(exceptionRows.length, 38, 'Priority-exception source CSV must contain a header plus 37 rows');
const exceptionHeader = exceptionRows[0];
assert.deepEqual(exceptionHeader, [
  'requirementId', 'literalFindCount', 'sourcePagesWithLiteralOccurrence',
  'observedReferenceContext', 'oneLineNormativeRowSearchMatches',
  'sourceOwnerDisposition', 'sourceOwnerDecisionRef', 'reviewer', 'reviewDate',
], 'Priority exception source CSV columns changed; update validator deliberately');
const exceptionIds = [];
for (const cells of exceptionRows.slice(1)) {
  assert.equal(cells.length, exceptionHeader.length, 'Malformed exception CSV row for ' + cells[0]);
  const row = Object.fromEntries(exceptionHeader.map((key, index) => [key, cells[index]]));
  exceptionIds.push(row.requirementId);
  assert.match(row.requirementId, /^(FR|NFR)-[A-Z0-9]+-\d{2}$/);
  assert.ok(Number(row.literalFindCount) > 0, 'Source exception needs literal occurrence search result: ' + row.requirementId);
  assert.ok(row.sourcePagesWithLiteralOccurrence.trim(), 'Source exception needs source page locations: ' + row.requirementId);
  assert.equal(row.oneLineNormativeRowSearchMatches, '0', 'One-line source-row diagnostic changed for ' + row.requirementId);
  assert.equal(row.sourceOwnerDisposition, 'OPEN_SOURCE_OWNER_REVIEW', 'No source owner disposition may be inferred for ' + row.requirementId);
  assert.ok(row.sourceOwnerDecisionRef === 'PENDING' && row.reviewer === 'PENDING' && row.reviewDate === 'PENDING', 'Owner approval must remain pending until recorded: ' + row.requirementId);
}
assert.equal(new Set(exceptionIds).size, 37, 'Priority exception IDs must be unique');
const sourceExceptionMatrixIds = requirementRows.filter((row) => row.priority === 'REVIEW SOURCE').map((row) => row.id).sort();
assert.deepEqual([...exceptionIds].sort(), sourceExceptionMatrixIds, 'Priority exception source CSV must match all 37 REVIEW SOURCE rows');
assert.ok(releaseSnapshot.includes('0f577f2ee5bbb6605011b221f1e65a1b5a6d548b'), 'Release snapshot must identify the exact audited merge SHA');
assert.ok(releaseSnapshot.includes('39429731792'), 'Release snapshot must link exact-SHA traceability CI');
assert.ok(releaseSnapshot.includes('NOT READY FOR FORMAL TRACEABILITY SIGN-OFF'), 'Release snapshot must keep overall release gate explicit while approvals/evidence are missing');


const closureCsvRows = parseCsv(closureCsv);
assert.equal(closureCsvRows.length, 843, 'Evidence closure CSV must contain a header plus 842 gate rows');
const csvHeader = closureCsvRows[0];
assert.deepEqual(csvHeader, [
  'requirementId', 'sourcePriority', 'sourceWordingExcerpt', 'repositoryAssessment',
  'repositoryEvidenceText', 'acceptanceGapText', 'provisionalOwnerRole',
  'literalRepositoryPaths', 'literalCodePaths', 'literalMigrationPaths',
  'literalTestPaths', 'evidencePointerClass', 'sourcePriorityReview',
  'disposition', 'acceptanceResult', 'directEvidenceClosureRequirement',
], 'Evidence closure CSV columns changed; update the audit validator deliberately');

const sourceEvidenceById = new Map(extractRequirementEvidenceRows(matrix).map((row) => [row.id, row]));
const csvRowsById = new Map();
for (const cells of closureCsvRows.slice(1)) {
  assert.equal(cells.length, csvHeader.length, 'Malformed CSV column count for ' + cells[0]);
  const row = Object.fromEntries(csvHeader.map((key, index) => [key, cells[index]]));
  assert.ok(!csvRowsById.has(row.requirementId), 'Duplicate CSV row ' + row.requirementId);
  csvRowsById.set(row.requirementId, row);
  const source = sourceEvidenceById.get(row.requirementId);
  assert.ok(source, 'CSV requirement is missing from the SRS evidence matrix: ' + row.requirementId);
  assert.equal(row.sourcePriority, source.priority, 'CSV priority differs from source matrix for ' + row.requirementId);
  assert.equal(row.sourceWordingExcerpt, source.wording, 'CSV wording excerpt differs from source matrix for ' + row.requirementId);
  assert.equal(row.repositoryAssessment, source.assessment, 'CSV assessment differs from source matrix for ' + row.requirementId);
  assert.equal(row.repositoryEvidenceText, source.evidence, 'CSV evidence pointer cell differs from source matrix for ' + row.requirementId);
  assert.equal(row.acceptanceGapText, source.gap, 'CSV acceptance gap differs from source matrix for ' + row.requirementId);
  assert.equal(row.disposition, 'OPEN', 'Evidence pointer export may not change disposition: ' + row.requirementId);
  assert.equal(row.acceptanceResult, 'NOT_ACCEPTED', 'Missing acceptance evidence may not be exported as PASS: ' + row.requirementId);
  for (const required of ['DIRECT_CODE_PATH_REQUIRED', 'EXACT_MIGRATION_PATH_OR_APPROVED_NA_REQUIRED', 'DIRECT_TEST_PATH_REQUIRED', 'EXACT_CANDIDATE_SHA_AND_CI_RUN_REQUIRED', 'NAMED_OWNER_AND_INDEPENDENT_REVIEWER_REQUIRED']) {
    assert.ok(row.directEvidenceClosureRequirement.includes(required) ||
      (required === 'DIRECT_CODE_PATH_REQUIRED' && row.directEvidenceClosureRequirement.includes('CODE_PATH_PRESENT_IN_MATRIX')) ||
      (required === 'EXACT_MIGRATION_PATH_OR_APPROVED_NA_REQUIRED' && row.directEvidenceClosureRequirement.includes('MIGRATION_PATH_PRESENT_IN_MATRIX')) ||
      (required === 'DIRECT_TEST_PATH_REQUIRED' && row.directEvidenceClosureRequirement.includes('TEST_PATH_PRESENT_IN_MATRIX')),
      'CSV must record direct-evidence closure requirement ' + required + ' for ' + row.requirementId);
  }
}
assert.deepEqual([...csvRowsById.keys()].sort(), expectedGateIds, 'CSV must have exactly the P0/P1 plus unresolved-priority candidate rows');


const resultStates = new Set(['NOT_ACCEPTED', 'PASS', 'PASS_WITH_APPROVED_EXCEPTION', 'NOT_APPLICABLE_APPROVED']);
const dispositions = new Set(['OPEN', 'ACCEPTED', 'APPROVED_EXCEPTION', 'NOT_APPLICABLE_APPROVED']);
for (const row of closureRows) {
  assert.ok(resultStates.has(row.acceptanceResult), 'Invalid acceptanceResult for ' + row.requirementId);
  assert.ok(dispositions.has(row.disposition), 'Invalid disposition for ' + row.requirementId);
  for (const field of ['directCodeReferences', 'migrationReferences', 'automatedTestReferences', 'ciRunUrls', 'stagingOperationalEvidence']) {
    assert.ok(Array.isArray(row[field]), 'Expected evidence array ' + field + ' for ' + row.requirementId);
  }
  if (row.acceptanceResult === 'PASS') {
    assert.equal(row.disposition, 'ACCEPTED', 'PASS needs ACCEPTED disposition for ' + row.requirementId);
    assert.equal(row.ownerAssignmentStatus, 'ASSIGNED', 'PASS needs a formally assigned owner for ' + row.requirementId);
    assert.ok(typeof row.namedOwner === 'string' && row.namedOwner.trim(), 'PASS needs named owner for ' + row.requirementId);
    assert.ok(typeof row.reviewer === 'string' && row.reviewer.trim(), 'PASS needs reviewer for ' + row.requirementId);
    assert.match(row.acceptedCandidateSha ?? '', /^[a-f0-9]{40}$/, 'PASS needs full candidate SHA for ' + row.requirementId);
    assert.ok(row.sourcePriority !== 'REVIEW SOURCE', 'Resolve source priority before PASS for ' + row.requirementId);
    assert.ok(row.directCodeReferences.length > 0, 'PASS needs direct code evidence for ' + row.requirementId);
    assert.ok(row.migrationReferences.length > 0 || (typeof row.migrationNotApplicableApprovalRef === 'string' && row.migrationNotApplicableApprovalRef.trim()), 'PASS needs migration evidence or approved N/A for ' + row.requirementId);
    assert.ok(row.automatedTestReferences.length > 0, 'PASS needs direct automated-test evidence for ' + row.requirementId);
    assert.ok(row.ciRunUrls.length > 0 && row.ciRunUrls.every((url) => /^https:\/\//.test(url)), 'PASS needs exact CI run URLs for ' + row.requirementId);
  }
  if (row.acceptanceResult === 'PASS_WITH_APPROVED_EXCEPTION') {
    assert.equal(row.disposition, 'APPROVED_EXCEPTION', 'Approved exception result/disposition mismatch for ' + row.requirementId);
    assert.ok(row.exceptionApprovalRef && row.exceptionApprovalRef.trim(), 'Approved exception needs an immutable approval reference for ' + row.requirementId);
    assert.ok(row.namedOwner && row.reviewer && /^[a-f0-9]{40}$/.test(row.acceptedCandidateSha ?? ''), 'Approved exception needs owner, reviewer and candidate SHA for ' + row.requirementId);
  }
  if (row.acceptanceResult === 'NOT_APPLICABLE_APPROVED') {
    assert.equal(row.disposition, 'NOT_APPLICABLE_APPROVED', 'N/A result/disposition mismatch for ' + row.requirementId);
    assert.ok(row.notApplicableApprovalRef && row.notApplicableApprovalRef.trim(), 'N/A disposition needs an owner approval reference for ' + row.requirementId);
    assert.ok(row.namedOwner && row.reviewer, 'N/A disposition needs owner and reviewer for ' + row.requirementId);
  }
}

console.log('SRS/HLD/Blueprint audit consistency passed');
console.log('Evidence closure CSV: ' + csvRowsById.size + ' source-row-aligned records; all remain OPEN / NOT_ACCEPTED');
console.log('Priority source exceptions: ' + (exceptionRows.length - 1) + ' unique rows; owner disposition pending');
console.log('P0/P1 closure tracker: ' + closureRows.length + ' rows (P0=' + closurePriorities.P0 + ', P1=' + closurePriorities.P1 + ', unresolved priority=' + closurePriorities['REVIEW SOURCE'] + ')');
console.log('Requirement IDs: ' + requirementRows.length + ' unique; priorities: P0=' + priorities.P0 + ', P1=' + priorities.P1 + ', P2=' + priorities.P2 + ', review=' + priorities.review);
console.log('Acceptance scenarios: AS-132–AS-141 present');
console.log('HLD/Blueprint work packages: WP01–WP12 present');
console.log('Source hashes: ' + sourceHashes.length + ' SHA-256 values present');
