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


function extractRequirementEvidenceRows(markdown) {
  const start = markdown.indexOf('## 3. Requirement ID register');
  const end = markdown.indexOf('## 4. Final SRS acceptance scenarios', start + 1);
  assert.notEqual(start, -1, 'Requirement matrix section 3 is missing');
  assert.notEqual(end, -1, 'Requirement matrix section 4 is missing');
  return markdown.slice(start, end).split('\n').flatMap((line) => {
    if (!/^\| (?:FR|NFR)-[A-Z0-9]+-\d{2} \|/.test(line)) return [];
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    return [{
      id: cells[0],
      priority: cells[1],
      wording: cells[2] ?? '',
      assessment: cells[3] ?? '',
      evidence: cells[4] ?? '',
      gap: cells[5] ?? '',
    }];
  });
}

function extractEvidencePaths(value) {
  const matches = value.match(/(?:docs|services|scripts|migrations|\.github)\/[A-Za-z0-9_.*\/-]+/g) ?? [];
  return [...new Set(matches.map((path) => path.replace(/[),.;:`]+$/g, '')))].filter((path) => path.length > 3);
}

const isTestPointer = (path) => /(\.spec\.[cm]?[jt]sx?|\.test\.[cm]?[jt]sx?|\/test\/|\/tests\/|\.contract\.[cm]?[jt]s$)/i.test(path);
const isCodePointer = (path) => (/^services\/api\/src\/|^apps\/web\/src\//.test(path) && !isTestPointer(path));
const isMigrationPointer = (path) => /^migrations\/\d/.test(path);

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
const matrixEvidenceRows = new Map(extractRequirementEvidenceRows(matrix).map((row) => [row.id, row]));
const pointerCoverage = {};
for (const row of closureRows) {
  const source = matrixEvidenceRows.get(row.requirementId);
  assert.ok(source, 'Closure register row is missing from matrix: ' + row.requirementId);
  assert.equal(row.sourcePriority, source.priority, 'Priority differs from matrix for ' + row.requirementId);
  assert.equal(row.matrixAssessment, source.assessment, 'Assessment differs from matrix for ' + row.requirementId);
  assert.equal(row.sourceWordingExcerpt, source.wording, 'Source wording excerpt differs from matrix for ' + row.requirementId);
  assert.equal(row.repositoryEvidenceText, source.evidence, 'Repository-evidence cell differs from matrix for ' + row.requirementId);
  assert.equal(row.acceptanceGapText, source.gap, 'Acceptance-gap text differs from matrix for ' + row.requirementId);

  const pointers = extractEvidencePaths(source.evidence);
  const codePointers = pointers.filter(isCodePointer);
  const testPointers = pointers.filter(isTestPointer);
  const migrationPointers = pointers.filter(isMigrationPointer);
  const pointerClass = codePointers.length && testPointers.length
    ? 'CODE_AND_TEST_POINTERS_PRESENT'
    : testPointers.length
      ? 'TEST_POINTER_PRESENT'
      : codePointers.length
        ? 'CODE_POINTER_PRESENT'
        : pointers.length
          ? 'DOC_OR_FAMILY_POINTER_ONLY'
          : 'NO_REPOSITORY_POINTER';
  assert.deepEqual(row.repositoryEvidencePointerPaths, pointers, 'Repository path pointers differ from matrix for ' + row.requirementId);
  assert.deepEqual(row.exactCodePointersFromMatrix, codePointers, 'Code pointers differ from matrix for ' + row.requirementId);
  assert.deepEqual(row.exactTestPointersFromMatrix, testPointers, 'Test pointers differ from matrix for ' + row.requirementId);
  assert.deepEqual(row.exactMigrationPointersFromMatrix, migrationPointers, 'Migration pointers differ from matrix for ' + row.requirementId);
  assert.equal(row.evidencePointerClass, pointerClass, 'Evidence pointer class differs from matrix for ' + row.requirementId);
  assert.equal(row.evidenceStatus, 'MATRIX_POINTERS_ATTACHED_DIRECT_ACCEPTANCE_STILL_OPEN', 'Matrix pointers must not become implicit acceptance for ' + row.requirementId);
  assert.equal(row.acceptanceResult, 'NOT_ACCEPTED', 'All rows remain open until individually accepted: ' + row.requirementId);
  assert.ok(row.evidenceClosureNeeds.includes('CURRENT_CANDIDATE_CI_RUN'), 'Missing exact-SHA CI closure need for ' + row.requirementId);
  assert.ok(row.evidenceClosureNeeds.includes('NAMED_OWNER_AND_INDEPENDENT_REVIEWER'), 'Missing owner/reviewer closure need for ' + row.requirementId);
  pointerCoverage[pointerClass] = (pointerCoverage[pointerClass] ?? 0) + 1;
}

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
console.log('Matrix evidence pointers: ' + JSON.stringify(pointerCoverage));
console.log('P0/P1 closure tracker: ' + closureRows.length + ' rows (P0=' + closurePriorities.P0 + ', P1=' + closurePriorities.P1 + ', unresolved priority=' + closurePriorities['REVIEW SOURCE'] + ')');
console.log('Requirement IDs: ' + requirementRows.length + ' unique; priorities: P0=' + priorities.P0 + ', P1=' + priorities.P1 + ', P2=' + priorities.P2 + ', review=' + priorities.review);
console.log('Acceptance scenarios: AS-132–AS-141 present');
console.log('HLD/Blueprint work packages: WP01–WP12 present');
console.log('Source hashes: ' + sourceHashes.length + ' SHA-256 values present');
