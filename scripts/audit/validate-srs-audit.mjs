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

console.log('SRS/HLD/Blueprint audit consistency passed');
console.log('Requirement IDs: ' + requirementRows.length + ' unique; priorities: P0=' + priorities.P0 + ', P1=' + priorities.P1 + ', P2=' + priorities.P2 + ', review=' + priorities.review);
console.log('Acceptance scenarios: AS-132–AS-141 present');
console.log('HLD/Blueprint work packages: WP01–WP12 present');
console.log('Source hashes: ' + sourceHashes.length + ' SHA-256 values present');
