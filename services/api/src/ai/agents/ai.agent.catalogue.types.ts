import type {
  AiToolRiskClass,
} from '../tools/ai.tool.types';

export type AiAgentCatalogueStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'RETIRED';

export type AiAgentOperationalControlStatus =
  | 'ENABLED'
  | 'PAUSED'
  | 'RESTRICTED';

export interface CreateAiAgentOperationalControlInput {
  status: AiAgentOperationalControlStatus;
  executionScopes?: string[];
  reason: string;
}

export interface AiAgentOperationalControl {
  id: string;
  revision: string;
  tenantId: string;
  factoryId: string;
  agentId: string;
  agentDefinitionId: string;
  status: AiAgentOperationalControlStatus;
  executionScopes: string[];
  reason: string;
  createdBy: string | null;
  createdAt: string;
}

export type AiAgentToolGrantStatus =
  | 'ACTIVE'
  | 'REVOKED';

export interface CreateAiAgentDefinitionInput {
  agentId: string;
  version: string;
  name: string;
  description?: string | null;
  language?: string;
  ownerUserId?: string | null;
  capability: string;
  typicalOutput: string;
  authority: string;
  riskCeiling?: AiToolRiskClass;
  executionScopes?: string[];
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
  language: string;
  ownerUserId: string | null;
  capability: string;
  typicalOutput: string;
  authority: string;
  riskCeiling: AiToolRiskClass;
  executionScopes: string[];
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
