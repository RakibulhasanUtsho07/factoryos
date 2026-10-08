import type {
  AiToolRiskClass,
} from '../tools/ai.tool.types';

export type AiAgentStudioSandboxStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED';

export interface AiAgentStudioToolSpec {
  toolId: string;
  version: string;
  actionType: string;
}

export interface AiAgentStudioPlanStep {
  stepKey: string;
  toolId: string;
  toolVersion: string;
  actionType: string;
  input: Record<string, unknown>;
}

export interface AiAgentStudioSpec {
  agentId: string;
  version: string;
  goal: string;
  riskCeiling: AiToolRiskClass;
  executionScopes: string[];
  tools: AiAgentStudioToolSpec[];
  memory?: Record<string, unknown>;
  policies?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  completionCriteria?: Record<string, unknown>;
}

export interface CreateAiAgentStudioSandboxInput {
  name: string;
  traceId: string;
  agentSpec: AiAgentStudioSpec;
  inputSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  plan: AiAgentStudioPlanStep[];
  simulatedToolResponses: Record<string, unknown>;
}

export interface AiAgentStudioSandboxRecord {
  id: string;
  tenantId: string;
  factoryId: string;
  name: string;
  mode: 'SIMULATION';
  agentSpec: AiAgentStudioSpec;
  inputSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  networkAccess: 'NONE';
  credentialsAccess: 'NONE';
  liveWriteAllowed: false;
  status: AiAgentStudioSandboxStatus;
  createdBy: string | null;
  traceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAgentStudioSimulationRun {
  id: string;
  sandboxId: string;
  parentRunId: string | null;
  status: 'COMPLETED' | 'FAILED' | 'BLOCKED';
  plan: AiAgentStudioPlanStep[];
  simulatedToolResponses: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  result: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  createdBy: string | null;
  traceId: string | null;
  createdAt: string;
}
