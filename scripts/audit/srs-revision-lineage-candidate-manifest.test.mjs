import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(
  new URL('../../docs/srs-revision-lineage-candidate-manifest-2026-11-04.json', import.meta.url),
  'utf8',
));
const growthLedger = JSON.parse(await readFile(
  new URL('../../docs/srs-v19-growth-delta-occurrence-ledger.json', import.meta.url),
  'utf8',
));

const sourceByFile = new Map(manifest.sourceCandidates.map((source) => [source.fileName, source]));
const scopeByRevision = new Map(manifest.scopeLedger.map((entry) => [entry.revision, entry]));

test('candidate source manifest is explicitly not an approved source-of-record', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.manifestId, 'FOS-SRS-REVISION-LINEAGE-2026-11-04');
  assert.equal(manifest.status, 'CANDIDATE_LINEAGE_AND_SCOPE_ARITHMETIC_ONLY');
  assert.equal(manifest.sourceOfRecord.status, 'BLOCKED_SOURCE_OWNER_APPROVAL_PENDING');
  assert.equal(manifest.sourceOfRecord.controlledDmsPlmReference, null);
  assert.equal(manifest.sourceOfRecord.productOwnerApprovalReference, null);
  assert.equal(manifest.sourceOfRecord.architectureApprovalReference, null);
  assert.equal(manifest.sourceOfRecord.independentlyVerifiedSourceHashes, false);
  assert.equal(manifest.reconciliationBoundary.sourceOwnerApproved, false);
  assert.equal(manifest.reconciliationBoundary.releaseTraceabilityAccepted, false);
  assert.equal(manifest.reconciliationBoundary.activeNormativeOccurrenceLedgerComplete, false);
  assert.equal(manifest.reconciliationBoundary.activeScopeDenominator, 950);
});

test('every located candidate has a byte hash, positive size and format-consistent page metadata', () => {
  assert.equal(manifest.sourceCandidates.length, 17);
  for (const source of manifest.sourceCandidates) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/, source.fileName);
    assert.ok(Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 0, source.fileName);
    assert.ok(['DOCX', 'PDF'].includes(source.format), source.fileName);
    if (source.format === 'PDF') {
      assert.ok(Number.isSafeInteger(source.pageCount) && source.pageCount > 0, source.fileName);
    } else {
      assert.equal(source.pageCount, null, source.fileName);
    }
    assert.ok(source.approvalStatus !== 'APPROVED', source.fileName);
  }
  assert.equal(sourceByFile.size, manifest.sourceCandidates.length);
  assert.equal(sourceByFile.get('FactoryOS_AI_-_SRS_v2_1_FINAL_Product_Ready_Manufacturing_SaaS(2).pdf').sha256,
    'ae3790e0ead5b11f13d4c32c9ab8e944ede7508cbaf0468673e031e48917c959');
});

test('unlocated v1.1/v1.2 predecessors remain missing rather than receiving invented hashes', () => {
  assert.deepEqual(manifest.unavailablePredecessors.map((source) => source.version), ['1.1', '1.2']);
  for (const source of manifest.unavailablePredecessors) {
    assert.equal(source.availability, 'NOT_LOCATED_IN_AVAILABLE_LIBRARY_SEARCH');
    assert.equal(source.sha256, null);
    assert.equal(source.pageCount, null);
    assert.equal(source.approvalStatus, 'UNKNOWN');
  }
});

test('declared cumulative scope arithmetic reconciles without inferring unavailable predecessor deltas', () => {
  const v14 = scopeByRevision.get('1.4');
  assert.equal(v14.startingCumulative, null);
  assert.equal(v14.delta.total, null);
  assert.equal(v14.cumulative, 318);
  assert.equal(v14.arithmeticStatus, 'PARENT_BASELINE_NOT_NUMERICALLY_ENUMERATED');

  const expected = [
    ['1.5_corrected', 318, 92, 410],
    ['1.6', 410, 92, 502],
    ['1.7', 502, 156, 658],
    ['1.8_frontier', 658, 120, 778],
    ['1.9_growth_research', 778, 92, 870],
    ['2.0', 870, 30, 900],
    ['2.1', 900, 50, 950],
  ];
  for (const [revision, start, delta, cumulative] of expected) {
    const entry = scopeByRevision.get(revision);
    assert.ok(entry, revision);
    assert.equal(entry.startingCumulative, start, revision);
    assert.equal(entry.delta.total, delta, revision);
    assert.equal(entry.cumulative, cumulative, revision);
    assert.equal(start + delta, cumulative, revision);
  }
});

test('known functional/non-functional delta components add up where the source states them', () => {
  for (const revision of ['1.5_corrected', '1.6', '1.7', '1.8_frontier', '1.9_growth_research', '2.0', '2.1']) {
    const entry = scopeByRevision.get(revision);
    assert.equal(entry.delta.functional + entry.delta.nonFunctional, entry.delta.total, revision);
  }
  const v19 = scopeByRevision.get('1.9_growth_research');
  assert.equal(v19.delta.functional, 74);
  assert.equal(v19.delta.nonFunctional, 18);
  assert.equal(v19.delta.total, 92);
  assert.deepEqual(v19.priorityDelta, { P0: 37, P1: 55, P2: 0 });
  assert.equal(v19.arithmeticStatus, 'RECONCILES_FROM_SOURCE_LOCATED_CANDIDATE_ROWS');
});

test('priority totals reconcile for the revisions that declare cumulative buckets', () => {
  for (const revision of ['1.5_corrected', '1.6', '1.7', '2.0', '2.1']) {
    const entry = scopeByRevision.get(revision);
    const priority = entry.priorityCumulative;
    assert.equal(priority.P0 + priority.P1 + priority.P2, entry.cumulative, revision);
  }
  for (const revision of ['1.6', '1.7', '1.9_growth_research', '2.0', '2.1']) {
    const entry = scopeByRevision.get(revision);
    const delta = entry.priorityDelta;
    assert.equal(delta.P0 + delta.P1 + delta.P2, entry.delta.total, revision);
  }
  assert.equal(scopeByRevision.get('1.8_frontier').priorityCumulative, null);
  assert.equal(scopeByRevision.get('1.9_growth_research').priorityCumulative, null);
});

test('v1.5 conflicting candidate priority distributions are both preserved', () => {
  const correctedDocx = sourceByFile.get('FactoryOS_AI_-_SRS_v1_5_Enterprise_Manufacturing_SaaS_Corrected.docx');
  const olderDocx = sourceByFile.get('FactoryOS_AI_-_SRS_v1_5_Enterprise_Manufacturing_SaaS.docx');
  assert.deepEqual(correctedDocx.priorityClaim, {
    P0: 109, P1: 252, P2: 49, claimKind: 'CORRECTED_V1_5_COPY',
  });
  assert.deepEqual(olderDocx.priorityClaim, {
    P0: 109, P1: 243, P2: 58, claimKind: 'OLDER_CONFLICTING_COPY',
  });
  assert.equal(109 + 252 + 49, 410);
  assert.equal(109 + 243 + 58, 410);
  assert.ok(manifest.unresolvedConflicts.some((conflict) =>
    conflict.id === 'SRC-V15-PRIORITY-COUNTS' && conflict.severity === 'HIGH'));
});

test('revision-label and PDF metadata conflicts are explicit and fail closed', () => {
  const v19Docx = sourceByFile.get('FactoryOS_AI_-_SRS_v1_9_Client_Business_Growth_Research_Learning_AI.docx');
  const v19Pdf = sourceByFile.get('FactoryOS_AI_-_SRS_v1_9_Client_Business_Growth_Research_Learning_AI.pdf');
  const v20Pdf = sourceByFile.get('FactoryOS_AI_-_SRS_v2_0_Clean_AI_Logic_Consolidated_SRS.pdf');
  assert.equal(v19Docx.internalVersion, '1.8 AI frontier upgrade draft');
  assert.equal(v19Pdf.pdfMetadata.title, 'FactoryOS AI - SRS v1.8 AI Frontier Upgrade Manufacturing SaaS');
  assert.equal(v20Pdf.pdfMetadata.title, 'FactoryOS AI - SRS v1.8 AI Frontier Upgrade Manufacturing SaaS');
  assert.ok(manifest.unresolvedConflicts.some((conflict) => conflict.id === 'SRC-V19-VERSION-METADATA'));
  assert.ok(manifest.unresolvedConflicts.some((conflict) => conflict.id === 'SRC-V20-PDF-METADATA'));
});

test('the manifest does not claim the 950 active occurrence ledger or source-owner acceptance', () => {
  assert.equal(manifest.reconciliationBoundary.scopeArithmeticReconciled, true);
  assert.equal(manifest.reconciliationBoundary.historicalSourceLineageComplete, false);
  assert.equal(manifest.reconciliationBoundary.distinctIdCrosswalkApproved, false);
  assert.equal(manifest.reconciliationBoundary.requirementPriorityDistributionFullyReconciled, false);
  assert.equal(manifest.reconciliationBoundary.priorityExceptionSetMustRemainOpen, true);
  assert.equal(manifest.reconciliationBoundary.reason.includes('v1.1/v1.2'), true);
  assert.equal(Object.hasOwn(manifest, 'approvedActiveOccurrences'), false);
});


test('v1.9 growth/research delta ledger contains 92 source-located unique requirement IDs', () => {
  assert.equal(growthLedger.ledgerId, 'FOS-SRS-V19-GROWTH-DELTA-01');
  assert.equal(growthLedger.sourceArtifactSha256,
    '09f796a867941d4738b07eea5f9169ed2de9351fb7a6111b676bf9342bfbb5a1');
  assert.equal(growthLedger.sourcePdfPageCount, 86);
  assert.deepEqual(growthLedger.scannedPdfPages, [75, 85]);
  assert.equal(growthLedger.rows.length, 92);
  assert.equal(new Set(growthLedger.rows.map((row) => row.requirementId)).size, 92);

  const functional = growthLedger.rows.filter((row) => row.requirementId.startsWith('FR-'));
  const nonFunctional = growthLedger.rows.filter((row) => row.requirementId.startsWith('NFR-'));
  assert.equal(functional.length, 74);
  assert.equal(nonFunctional.length, 18);

  const priorities = growthLedger.rows.reduce((counts, row) => {
    assert.ok(['P0', 'P1', 'P2'].includes(row.priority));
    counts[row.priority] += 1;
    assert.ok(row.pdfPage >= 75 && row.pdfPage <= 85);
    assert.ok(Number.isInteger(row.textLineOnPage) && row.textLineOnPage > 0);
    return counts;
  }, { P0: 0, P1: 0, P2: 0 });
  assert.deepEqual(priorities, { P0: 37, P1: 55, P2: 0 });
  assert.deepEqual(growthLedger.priorityCounts, priorities);
  assert.equal(growthLedger.acceptanceBoundary.includes('Does not establish controlled source-of-record'), true);
});

test('v1.9 growth delta manifest and occurrence ledger remain bound together', () => {
  assert.deepEqual(manifest.growthDeltaOccurrenceLedger, {
    path: 'docs/srs-v19-growth-delta-occurrence-ledger.json',
    sourceArtifactSha256: growthLedger.sourceArtifactSha256,
    occurrenceCount: 92,
    distinctIdCount: 92,
    functionalRows: 74,
    nonFunctionalRows: 18,
    priorityCounts: { P0: 37, P1: 55, P2: 0 },
    candidateSourcePages: [75, 85],
    sourceOwnerApproved: false,
  });
  const v19 = scopeByRevision.get('1.9_growth_research');
  assert.deepEqual(v19.delta, { functional: 74, nonFunctional: 18, total: 92 });
  assert.deepEqual(v19.priorityDelta, { P0: 37, P1: 55, P2: 0 });
  assert.equal(v19.priorityCumulative, null);
});
