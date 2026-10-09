import type {
  AiAgentHandoff,
  AiAgentState,
  AiToolActionContext,
  AiToolExecutionOutcome,
} from '../tools/ai.tool.types';

/* ============================================================
 * TASK LIMITS
 * ============================================================ */

export interface AiAgentTaskLimits {
  maxSteps: number;
  maxRetries: number;
  maxToolCalls: number;
  timeoutMs: number;
}

/* ============================================================
 * STEP DEFINITION
 * ============================================================ */

export interface AiAgentStepDefinition {
  stepKey: string;
  capability: string;

  agentId?: string | null;

  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;

  toolId: string;
  toolVersion: string;
  actionType: string;

  target?: Record<string, unknown>;
  payload?: Record<string, unknown>;

  resourceType?: string | null;
  resourceId?: string | null;

  riskClass?: string | null;

  timeoutMs?: number;
  retryLimit?: number;

  authorityLevel?: string;

  dependsOn?: string[];
}

/* ============================================================
 * TASK INPUT
 * ============================================================ */

export interface CreateAiAgentTaskInput {
  decisionId: string;
  parentTraceId: string;
  goal: string;

  limits?: Partial<AiAgentTaskLimits>;

  deadlineAt?: string | null;
  contextVersion?: string | null;
  planVersion?: string | null;
  contextHash?: string | null;

  idempotencyKey?: string | null;

  steps: AiAgentStepDefinition[];
}

/* ============================================================
 * TASK RECORD
 * ============================================================ */

export interface AiAgentTask {
  id: string;

  tenantId: string;
  factoryId: string;

  decisionId: string;
  parentTraceId: string;
  actorUserId: string;

  goal: string;
  state: AiAgentState;

  maxSteps: number;
  maxRetries: number;
  maxToolCalls: number;
  timeoutMs: number;
  deadlineAt: string;

  retryCount: number;
  toolCallCount: number;
  completedStepCount: number;

  currentStepId: string | null;

  contextVersion: string | null;
  planVersion: string | null;
  contextHash: string | null;

  cancelRequestedAt: string | null;

  failureCode: string | null;
  failureReason: string | null;

  idempotencyKey: string | null;

  version: number;

  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * STEP RECORD
 * ============================================================ */

export type AiAgentStepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export interface AiAgentTaskStep {
  id: string;

  tenantId: string;
  factoryId: string;
  taskId: string;

  stepKey: string;
  stepIndex: number;

  agentId: string | null;
  capability: string;

  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;

  toolId: string;
  toolVersion: string;
  actionType: string;

  target: Record<string, unknown>;
  payload: Record<string, unknown>;

  resourceType: string | null;
  resourceId: string | null;

  riskClass: string | null;

  timeoutMs: number;
  retryLimit: number;
  authorityLevel: string;

  dependsOn: string[];

  status: AiAgentStepStatus;

  retryCount: number;
  authorizationAttempt: number;

  actionIntentId: string | null;
  approvalId: string | null;
  executionRecordId: string | null;

  output: Record<string, unknown>;
  error: Record<string, unknown>;

  startedAt: string | null;
  finishedAt: string | null;

  version: number;

  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * STEP EXECUTION RESULT
 * ============================================================ */

export interface AiAgentStepExecutionResult {
  idempotent: boolean;
  task: AiAgentTask;
  step: AiAgentTaskStep;

  gatewayOutcome?: AiToolExecutionOutcome;
  waitingForApproval?: boolean;

  error?: Record<string, unknown>;
}

/* ============================================================
 * HANDOFF
 * ============================================================ */

export interface CreateAiAgentHandoffInput {
  sourceAgentId: string;
  targetAgentId: string;

  purpose: string;

  allowedDataClasses: string[];
  permittedTools: string[];

  expiresAt: string;

  parentTraceId: string;

  expectedArtifact?: Record<string, unknown> | null;
}

export interface AiAgentHandoffRecord
  extends AiAgentHandoff {
  sourceAgentId: string;
  targetAgentId: string;

  handoffHash: string;

  status:
    | 'PENDING'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'EXPIRED';

  acceptedBy: string | null;
  acceptedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/* ============================================================
 * GATEWAY ACTION
 * ============================================================ */

export type AiAgentGatewayAction = AiToolActionContext;

/* ============================================================
 * HANDOFF HASH INPUT
 * ============================================================ */

export interface AiAgentHandoffHashInput {
  tenantId: string;
  factoryId: string;

  sourceAgentId: string;
  targetAgentId: string;

  purpose: string;

  allowedDataClasses: string[];
  permittedTools: string[];

  expiresAt: string;
  parentTraceId: string;

  expectedArtifact:
    | Record<string, unknown>
    | null;
}
