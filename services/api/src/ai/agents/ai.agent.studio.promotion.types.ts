export type AiAgentPublicationStage =
  | 'CANARY'
  | 'PRODUCTION';

export type AiAgentPublishRequestAction =
  | 'REQUEST'
  | 'APPROVE'
  | 'REJECT'
  | 'PROMOTE'
  | 'ROLLBACK';

export type AiAgentPublishRequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'PROMOTED'
  | 'ROLLED_BACK';

export type AiAgentDeploymentStatus =
  | 'ACTIVE'
  | 'ROLLED_BACK';

export interface CreateAiAgentPublishRequestInput {
  agentDefinitionId: string;
  sandboxId: string;
  simulationRunId: string;
  policySimulationRunId?: string | null;
  targetStage: AiAgentPublicationStage;
  reason?: string | null;
}

export interface AiAgentPublishRequestRecord {
  id: string;
  requestId: string;
  version: number;
  tenantId: string;
  factoryId: string;
  agentDefinitionId: string;
  agentKey: string;
  sandboxId: string;
  simulationRunId: string;
  policySimulationRunId: string | null;
  targetStage: AiAgentPublicationStage;
  action: AiAgentPublishRequestAction;
  status: AiAgentPublishRequestStatus;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AiAgentDeploymentRecord {
  id: string;
  tenantId: string;
  factoryId: string;
  agentDefinitionId: string;
  agentKey: string;
  sandboxId: string;
  simulationRunId: string;
  policySimulationRunId: string | null;
  stage: AiAgentPublicationStage;
  deploymentVersion: number;
  status: AiAgentDeploymentStatus;
  previousDeploymentId: string | null;
  rollbackOfDeploymentId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AiAgentPromotionResult {
  request: AiAgentPublishRequestRecord;
  deployment: AiAgentDeploymentRecord;
}
