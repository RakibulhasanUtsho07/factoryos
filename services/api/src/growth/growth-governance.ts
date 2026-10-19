export const REQUIRED_GROWTH_CONSTRAINT_DIMENSIONS = ['CAPACITY', 'QUALITY', 'CASH', 'DELIVERY'] as const;

export interface GrowthGovernanceAssumptionSnapshot {
  id: string;
  statement: string;
  blocks_decision: boolean;
  latest_decision: string | null;
  evidence_refs: unknown;
}

export interface GrowthGovernanceConstraintSnapshot {
  id: string;
  dimension: string;
  applicability: string;
  limit_operator: string | null;
  threshold_value: number | string | null;
  observed_value: number | string | null;
  unit: string | null;
  source_evidence_ref: string | null;
  rationale: string;
}

export interface GrowthGovernanceEvidenceGapSnapshot {
  id: string;
  question: string;
  impact: string;
  blocks_decision: boolean;
  latest_decision: string | null;
  evidence_refs: unknown;
}

export interface GrowthGovernanceReadinessInput {
  evidence_count: number;
  decision_owner_assigned: boolean;
  assumptions: GrowthGovernanceAssumptionSnapshot[];
  constraints: GrowthGovernanceConstraintSnapshot[];
  evidence_gaps: GrowthGovernanceEvidenceGapSnapshot[];
}

export interface GrowthGovernanceReadiness {
  ready: boolean;
  status: 'READY' | 'BLOCKED';
  blockers: string[];
  missing_evidence: Array<{ code: string; subject_id?: string; detail: string }>;
}

function hasEvidenceRefs(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim().length > 0);
}

/**
 * Conservative, deterministic readiness assessment. This reports missing
 * governance inputs; it is not a probability, forecast, or substitute for review.
 */
export function evaluateGrowthGovernanceReadiness(
  input: GrowthGovernanceReadinessInput,
): GrowthGovernanceReadiness {
  const blockers: string[] = [];
  const missingEvidence: GrowthGovernanceReadiness['missing_evidence'] = [];
  const block = (code: string, detail: string, subject_id?: string) => {
    blockers.push(code + (subject_id ? ':' + subject_id : ''));
    missingEvidence.push({ code, subject_id, detail });
  };

  if (input.evidence_count < 1) {
    block('OPPORTUNITY_EVIDENCE_MISSING', 'Attach at least one scoped, reviewable evidence item.');
  }
  if (!input.decision_owner_assigned) {
    block('DECISION_OWNER_UNASSIGNED', 'Assign a named active DECISION_OWNER who is not the opportunity creator.');
  }

  for (const assumption of input.assumptions) {
    if (!assumption.blocks_decision) continue;
    if (!['VALIDATED', 'WAIVED'].includes(assumption.latest_decision ?? '') || !hasEvidenceRefs(assumption.evidence_refs)) {
      block(
        'ASSUMPTION_NOT_VALIDATED',
        'Record a VALIDATED decision, or an explicit reviewer WAIVED decision, with evidence attached to this opportunity.',
        assumption.id,
      );
    }
  }

  for (const dimension of REQUIRED_GROWTH_CONSTRAINT_DIMENSIONS) {
    const constraint = input.constraints.find(item => item.dimension === dimension);
    if (!constraint || constraint.applicability === 'UNKNOWN') {
      block('CONSTRAINT_UNASSESSED', 'Record whether ' + dimension.toLowerCase() + ' applies and why.', dimension);
      continue;
    }
    if (constraint.applicability === 'NOT_APPLICABLE') {
      if (constraint.rationale.trim().length < 10) {
        block('CONSTRAINT_RATIONALE_MISSING', 'Explain why ' + dimension.toLowerCase() + ' is not applicable.', dimension);
      }
      continue;
    }
    const complete = ['MAX', 'MIN', 'EQUALS'].includes(constraint.limit_operator ?? '')
      && constraint.threshold_value !== null && constraint.threshold_value !== undefined
      && constraint.observed_value !== null && constraint.observed_value !== undefined
      && Boolean(constraint.unit?.trim())
      && Boolean(constraint.source_evidence_ref?.trim());
    if (constraint.applicability !== 'APPLICABLE' || !complete) {
      block('CONSTRAINT_EVIDENCE_MISSING', 'Record a sourced limit, observed value, unit and source vintage.', dimension);
    }
  }

  for (const gap of input.evidence_gaps) {
    if (!gap.blocks_decision) continue;
    if (!['RESOLVED', 'WAIVED'].includes(gap.latest_decision ?? '')
      || (gap.latest_decision === 'RESOLVED' && !hasEvidenceRefs(gap.evidence_refs))) {
      block(
        'BLOCKING_EVIDENCE_GAP_OPEN',
        'Resolve the gap with attached evidence or record a reviewer-approved, reasoned waiver.',
        gap.id,
      );
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  return {
    ready: uniqueBlockers.length === 0,
    status: uniqueBlockers.length === 0 ? 'READY' : 'BLOCKED',
    blockers: uniqueBlockers,
    missing_evidence: missingEvidence,
  };
}
