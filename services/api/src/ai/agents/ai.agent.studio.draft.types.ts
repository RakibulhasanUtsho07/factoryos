export type AiAgentStudioDraftStatus =
  | 'DRAFT'
  | 'READY_FOR_PUBLISH'
  | 'REJECTED'
  | 'ARCHIVED';

export type AiAgentStudioDraftReviewDecision =
  | 'APPROVE'
  | 'REJECT';

export interface AiAgentStudioProposedTool {
  toolId: string;
  version: string | null;
  reason: string;
  requestedOnly: true;
}

export interface AiAgentStudioDraftValidation {
  schemaValid: boolean;
  permissionsGranted: number;
  toolGrantsCreated: number;
  publicationBlocked: boolean;
  reviewRequired: true;
  reasons: string[];
}

export interface AiAgentStudioDraftSpec {
  agentId: string;
  version: string;
  name: string;
  goal: string;
  capability: string;
  typicalOutput: string;
  authority: string;
  riskCeiling: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  executionScopes: string[];
  tools: AiAgentStudioProposedTool[];
  memory: Record<string, unknown>;
  policies: Record<string, unknown>;
  prompts: Record<string, unknown>;
  completionCriteria: Record<string, unknown>;
}

export interface CreateAiAgentStudioDraftInput {
  prompt: string;
  title?: string | null;
}

export interface ReviewAiAgentStudioDraftInput {
  decision: AiAgentStudioDraftReviewDecision;
  notes?: string | null;
}

export interface AiAgentStudioDraftRecord {
  id: string;
  draftId: string;
  version: number;
  tenantId: string;
  factoryId: string;
  sourcePrompt: string;
  title: string;
  goal: string;
  capability: string;
  typicalOutput: string;
  authority: string;
  riskCeiling: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  requestedScopes: string[];
  proposedTools: AiAgentStudioProposedTool[];
  generatedSpec: AiAgentStudioDraftSpec;
  validation: AiAgentStudioDraftValidation;
  status: AiAgentStudioDraftStatus;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}
