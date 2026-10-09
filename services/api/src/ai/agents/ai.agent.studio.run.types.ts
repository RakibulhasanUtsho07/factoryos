import type {
  AiAgentStudioPlanStep,
  AiAgentStudioSandboxRecord,
  AiAgentStudioSimulationRun,
  AiAgentStudioSpec,
} from './ai.agent.studio.types';

export type AiAgentStudioRunKind =
  | 'ORIGINAL'
  | 'REPLAY'
  | 'BRANCH';

export interface AiAgentStudioExpectedToolCall {
  stepIndex: number;
  stepKey: string;
  toolId: string;
  toolVersion: string;
  actionType: string;
  riskClass: string;
  requiredScopes: string[];
  writeCapable: boolean;
  approvalMode: string;
  rollbackType: string;
  dataAccessScopes: string[];
  sideEffect: 'NONE' | 'WRITE';
  approvalPoint: boolean;
  input: Record<string, unknown>;
}

export interface AiAgentStudioPlanReview {
  agentId: string;
  agentVersion: string;
  riskCeiling: string;
  executionScopes: string[];
  expectedToolCalls: AiAgentStudioExpectedToolCall[];
  totalSteps: number;
  totalToolCalls: number;
  hasSideEffects: boolean;
  approvalPoints: number[];
}

export interface AiAgentStudioRunRecord {
  simulation: AiAgentStudioSimulationRun;
  sandbox: AiAgentStudioSandboxRecord;
  runKind: AiAgentStudioRunKind;
  planReview: AiAgentStudioPlanReview;
}

export interface AiAgentStudioStepInspection {
  sandboxId: string;
  simulationRunId: string;
  stepIndex: number;
  step: AiAgentStudioPlanStep;
  observation: Record<string, unknown> | null;
  simulatedResponse: unknown;
  expectedToolCall: AiAgentStudioExpectedToolCall;
}

export interface AiAgentStudioPlanDiff {
  index: number;
  left: AiAgentStudioPlanStep | null;
  right: AiAgentStudioPlanStep | null;
  change: 'ADDED' | 'REMOVED' | 'CHANGED';
}

export interface AiAgentStudioRunComparison {
  sandboxId: string;
  leftRunId: string;
  rightRunId: string;
  samePlan: boolean;
  leftStepCount: number;
  rightStepCount: number;
  changedStepCount: number;
  differences: AiAgentStudioPlanDiff[];
  leftOutcome: Record<string, unknown>;
  rightOutcome: Record<string, unknown>;
}

export interface AiAgentStudioRunScope {
  sandbox: AiAgentStudioSandboxRecord;
  agentSpec: AiAgentStudioSpec;
}
