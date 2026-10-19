import { evaluateGrowthGovernanceReadiness } from './growth-governance';

const validatedAssumption = {
  id: 'assumption-1',
  statement: 'Baseline scrap rate is representative',
  blocks_decision: true,
  latest_decision: 'VALIDATED',
  evidence_refs: ['quality-report:2026-09'],
};
const passedConstraints = ['CAPACITY', 'QUALITY', 'CASH', 'DELIVERY'].map(dimension => ({
  id: dimension.toLowerCase(),
  dimension,
  applicability: 'NOT_APPLICABLE',
  limit_operator: null,
  threshold_value: null,
  observed_value: null,
  unit: null,
  source_evidence_ref: null,
  rationale: 'Reviewed with the operations owner; not material to this opportunity.',
}));

describe('growth opportunity governance readiness', () => {
  it('blocks decisions when decision ownership is missing', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 1,
      decision_owner_assigned: false,
      assumptions: [validatedAssumption],
      constraints: passedConstraints,
      evidence_gaps: [],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('DECISION_OWNER_UNASSIGNED');
  });

  it('requires assumption validation and evidence, not just prose', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 1,
      decision_owner_assigned: true,
      assumptions: [{ ...validatedAssumption, latest_decision: null, evidence_refs: [] }],
      constraints: passedConstraints,
      evidence_gaps: [],
    });
    expect(result.blockers).toContain('ASSUMPTION_NOT_VALIDATED:assumption-1');
  });

  it('requires explicit applicability decisions for all four core constraints', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 1,
      decision_owner_assigned: true,
      assumptions: [],
      constraints: [],
      evidence_gaps: [],
    });
    expect(result.blockers).toEqual(expect.arrayContaining([
      'CONSTRAINT_UNASSESSED:CAPACITY',
      'CONSTRAINT_UNASSESSED:QUALITY',
      'CONSTRAINT_UNASSESSED:CASH',
      'CONSTRAINT_UNASSESSED:DELIVERY',
    ]));
  });

  it('blocks an applicable constraint if its source snapshot is incomplete', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 1,
      decision_owner_assigned: true,
      assumptions: [],
      constraints: [
        ...passedConstraints.filter(item => item.dimension !== 'CASH'),
        { ...passedConstraints[2], applicability: 'APPLICABLE', rationale: 'Cash floor',
          limit_operator: 'MIN', threshold_value: 1000, observed_value: 1200, unit: null, source_evidence_ref: null },
      ],
      evidence_gaps: [],
    });
    expect(result.blockers).toContain('CONSTRAINT_EVIDENCE_MISSING:CASH');
  });

  it('requires a resolved evidence gap to include a traceable reference', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 1,
      decision_owner_assigned: true,
      assumptions: [validatedAssumption],
      constraints: passedConstraints,
      evidence_gaps: [{
        id: 'gap-1', question: 'Is the new channel viable?', impact: 'HIGH',
        blocks_decision: true, latest_decision: 'RESOLVED', evidence_refs: [],
      }],
    });
    expect(result.blockers).toContain('BLOCKING_EVIDENCE_GAP_OPEN:gap-1');
  });

  it('accepts a reasoned reviewer waiver only when it cites attached evidence', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 2,
      decision_owner_assigned: true,
      assumptions: [{ ...validatedAssumption, latest_decision: 'WAIVED', evidence_refs: ['risk-review:waiver-17'] }],
      constraints: passedConstraints,
      evidence_gaps: [],
    });
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('does not treat a refuted blocking assumption as validated', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 2,
      decision_owner_assigned: true,
      assumptions: [{ ...validatedAssumption, latest_decision: 'REFUTED', evidence_refs: ['quality-report:baseline'] }],
      constraints: passedConstraints,
      evidence_gaps: [],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('ASSUMPTION_NOT_VALIDATED:assumption-1');
  });

  it('returns ready only when ownership, assumptions, constraints and gaps are complete', () => {
    const result = evaluateGrowthGovernanceReadiness({
      evidence_count: 2,
      decision_owner_assigned: true,
      assumptions: [validatedAssumption],
      constraints: passedConstraints,
      evidence_gaps: [{
        id: 'gap-1', question: 'What is the delivery lead time?', impact: 'MEDIUM',
        blocks_decision: true, latest_decision: 'RESOLVED', evidence_refs: ['delivery-report:sep'],
      }],
    });
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.status).toBe('READY');
  });
});
