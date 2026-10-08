import { PolicyEvaluationOutcome } from "../../policy/policy.service";


export type AiAgentStudioPolicySimulationStatus =
  | 'COMPLETED'
  | 'BLOCKED';

export interface AiAgentStudioHistoricalEvent {
  eventKey: string;
  action: string;
  resourceType?: string | null;
  attributes?: Record<string, unknown>;
  effectiveAt: string;
  expectedOutcome?: PolicyEvaluationOutcome;
}

export interface AiAgentStudioPolicySimulationCaseResult {
  eventKey: string;
  action: string;
  resourceType: string | null;
  effectiveAt: string;
  expectedOutcome: PolicyEvaluationOutcome | null;
  actualOutcome: PolicyEvaluationOutcome;
  matchedExpectedOutcome: boolean | null;
  policyId: string | null;
  policyKey: string | null;
  policyVersion: string | null;
  riskClass: string | null;
  approvalRequired: boolean;
  safeDefault: boolean;
  reason: string;
}

export interface AiAgentStudioPolicySimulationResult {
  status: AiAgentStudioPolicySimulationStatus;
  sandboxId: string;
  simulationRunId: string;
  eventCount: number;
  allowedCount: number;
  approvalRequiredCount: number;
  deniedCount: number;
  expectedOutcomeMatches: number;
  expectedOutcomeDriftCount: number;
  allExpectedOutcomesMatched: boolean;
  allCasesNonDenied: boolean;
  recommendation:
    | 'READY_FOR_REVIEW'
    | 'POLICY_DRIFT_DETECTED'
    | 'DENIED_CASES_PRESENT';
  cases: AiAgentStudioPolicySimulationCaseResult[];
}
