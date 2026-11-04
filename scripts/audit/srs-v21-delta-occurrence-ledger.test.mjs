import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ledger = JSON.parse(await readFile(
  new URL('../../docs/srs-v21-delta-occurrence-ledger.json', import.meta.url),
  'utf8',
));

test('SRS v2.1 delta ledger contains exactly 50 source-located rows', () => {
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.ledgerId, 'FOS-SRS-V21-DELTA-01');
  assert.equal(ledger.sourceArtifactSha256, 'ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959');
  assert.equal(ledger.expectedDeltaRows, 50);
  assert.equal(ledger.extractedRows, 50);
  assert.equal(ledger.rows.length, 50);
  assert.deepEqual(ledger.priorityCounts, { P0: 35, P1: 15, P2: 0 });
});

test('SRS delta IDs are complete, ordered and unique', () => {
  const expected = [
    ...Array.from({ length: 32 }, (_, i) => `FR-PROD-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 18 }, (_, i) => `NFR-PROD-${String(i + 1).padStart(2, '0')}`),
  ];
  assert.deepEqual(ledger.rows.map((row) => row[0]), expected);
  assert.equal(new Set(ledger.rows.map((row) => row[0])).size, 50);
});

test('every source occurrence has a valid locator, priority and wording digest', () => {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const [id, priority, page, table, row, wordingSha256] of ledger.rows) {
    assert.match(id, /^(FR|NFR)-PROD-\d{2}$/);
    assert.ok(['P0', 'P1', 'P2'].includes(priority));
    counts[priority] += 1;
    assert.ok(page >= 96 && page <= 99);
    assert.ok(Number.isInteger(table) && table > 0);
    assert.ok(Number.isInteger(row) && row > 1);
    assert.match(wordingSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(counts, ledger.priorityCounts);
});

test('ledger states its approval boundary without manufacturing acceptance', () => {
  assert.match(ledger.approvalBoundary, /approval remains pending|approval.*pending/i);
  assert.match(ledger.approvalBoundary, /no.*acceptance/i);
});
