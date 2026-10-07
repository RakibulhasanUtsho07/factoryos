import type {
  AiToolRiskClass,
} from '../tools/ai.tool.types';

export type AiAgentCatalogueStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'RETIRED';

export type AiAgentToolGrantStatus =
  | 'ACTIVE'
  | 'REVOKED';

export interface CreateAiAgentDefinitionInput {
  agentId: string;
  version: string;
  name: string;
  description?: string | null;
  capability: string;
  typicalOutput: string;
  authority: string;
  riskCeiling?: AiToolRiskClass;
  status?: AiAgentCatalogueStatus;
  maxSteps?: number;
  maxRetries?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  config?: Record<string, unknown>;
}

export interface AiAgentDefinition {
  id: string;
  tenantId: string;
  factoryId: string;
  agentId: string;
  version: string;
  name: string;
  description: string | null;
  capability: string;
  typicalOutput: string;
  authority: string;
  riskCeiling: AiToolRiskClass;
  status: AiAgentCatalogueStatus;
  maxSteps: number;
  maxRetries: number;
  maxToolCalls: number;
  timeoutMs: number;
  config: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAiAgentToolGrantInput {
  agentDefinitionId: string;
  toolId: string;
  toolVersion: string;
  effectiveFrom?: string | Date;
  expiresAt?: string | Date | null;
  metadata?: Record<string, unknown>;
}

export interface AiAgentToolGrant {
  id: string;
  tenantId: string;
  factoryId: string;
  agentDefinitionId: string;
  toolId: string;
  toolVersion: string;
  version: number;
  status: AiAgentToolGrantStatus;
  effectiveFrom: string;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}

export interface AiAgentToolEntitlement {
  agent: AiAgentDefinition;
  grant: AiAgentToolGrant;
}
