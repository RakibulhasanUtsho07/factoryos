import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  createHash,
  randomUUID,
} from 'node:crypto';

import {
  isUUID,
} from 'class-validator';

import type {
  QueryResultRow,
} from 'pg';

import {
  AuditService,
} from '../../audit/audit.service';

import {
  DatabaseService,
} from '../../database/database.service';

import {
  IamService,
} from '../../iam/iam.service';

import {
  AiRuntimeService,
} from '../ai.runtime.service';

import {
  AiAgentCatalogueService,
} from './ai.agent.catalogue.service';

import {
  AiToolRegistryService,
} from '../tools/ai.tool.registry.service';

import type {
  AiAgentState,
  AiToolExecutionOutcome,
} from '../tools/ai.tool.types';

import type {
  AiAgentExecutionEvidence,
  AiAgentHandoffRecord,
  AiAgentTask,
  AiAgentTaskStep,
  AiAgentStepDefinition,
  AiAgentStepExecutionResult,
  CreateAiAgentHandoffInput,
  CreateAiAgentTaskInput,
} from './ai.agent.types';

interface AgentTaskRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  parent_trace_id: string;
  actor_user_id: string;
  goal: string;
  state: AiAgentState;
  max_steps: number;
  max_retries: number;
  max_tool_calls: number;
  timeout_ms: number;
  deadline_at: string;
  retry_count: number;
  tool_call_count: number;
  completed_step_count: number;
  current_step_id: string | null;
  context_version: string | null;
  plan_version: string | null;
  context_hash: string | null;
  cancel_requested_at: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AgentTaskStepRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  task_id: string;
  step_key: string;
  step_index: number;
  agent_id: string | null;
  capability: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  tool_id: string;
  tool_version: string;
  action_type: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  resource_type: string | null;
  resource_id: string | null;
  risk_class: string | null;
  timeout_ms: number;
  retry_limit: number;
  authority_level: string;
  depends_on: unknown[];
  status: AiAgentTaskStep['status'];
  retry_count: number;
  authorization_attempt: number;
  action_intent_id: string | null;
  approval_id: string | null;
  execution_record_id: string | null;
  execution_evidence: Record<string, unknown>;
  output: Record<string, unknown>;
  error: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AgentHandoffRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  source_agent_id: string;
  target_agent_id: string;
  purpose: string;
  allowed_data_classes: string[];
  permitted_tools: string[];
  expires_at: string;
  parent_trace_id: string;
  expected_artifact: Record<string, unknown> | null;
  handoff_hash: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_LIMITS = {
  maxSteps: 20,
  maxRetries: 3,
  maxToolCalls: 20,
  timeoutMs: 60_000,
};

const MAX_LIMITS = {
  maxSteps: 100,
  maxRetries: 20,
  maxToolCalls: 200,
  timeoutMs: 3_600_000,
};

const TRANSITIONS: Record<AiAgentState, readonly AiAgentState[]> = {
  CREATED: ['CONTEXT_READY', 'BLOCKED', 'CANCELLED'],
  CONTEXT_READY: ['PLAN_READY', 'BLOCKED', 'CANCELLED'],
  PLAN_READY: [
    'AWAITING_AUTH',
    'AWAITING_APPROVAL',
    'EXECUTING',
    'BLOCKED',
    'CANCELLED',
  ],
  AWAITING_AUTH: [
    'AWAITING_APPROVAL',
    'EXECUTING',
    'BLOCKED',
    'CANCELLED',
  ],
  AWAITING_APPROVAL: ['EXECUTING', 'BLOCKED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  COMPLETED: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
};

@Injectable()
export class AiAgentRuntimeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
    private readonly iamService: IamService,
    private readonly aiRuntimeService: AiRuntimeService,
    private readonly aiAgentCatalogueService: AiAgentCatalogueService,
    private readonly toolRegistry: AiToolRegistryService,
  ) {}

  async createTask(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiAgentTaskInput,
  ): Promise<{ idempotent: boolean; task: AiAgentTask }> {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.actions.authorize',
      factoryId,
    );

    const decisionId = this.requiredUuid(input.decisionId, 'decisionId');
    const parentTraceId = this.requiredUuid(
      input.parentTraceId,
      'parentTraceId',
    );
    const goal = this.requiredString(input.goal, 'goal', 1000);

    if (!Array.isArray(input.steps) || input.steps.length === 0) {
      throw new BadRequestException(
        'steps must contain at least one governed task step',
      );
    }

    const limits = this.normalizeLimits(input.limits);

    if (input.steps.length > limits.maxSteps) {
      throw new BadRequestException('steps exceed maxSteps');
    }

    const deadlineAt = this.resolveDeadline(
      input.deadlineAt,
      limits.timeoutMs,
    );

    const idempotencyKey = this.optionalString(
      input.idempotencyKey,
      'idempotencyKey',
      255,
    );

    const contextVersion = this.optionalString(
      input.contextVersion,
      'contextVersion',
      100,
    );
    const planVersion = this.optionalString(
      input.planVersion,
      'planVersion',
      100,
    );
    const contextHash = this.optionalString(
      input.contextHash,
      'contextHash',
      128,
    );

    for (let index = 0; index < input.steps.length; index += 1) {
      this.validateStepDefinition(input.steps[index]!, index);
    }

    const requestHash = this.computeTaskRequestHash({
      tenantId,
      factoryId,
      actorUserId,
      input,
      decisionId,
      parentTraceId,
      goal,
      limits,
      deadlineAt,
      contextVersion,
      planVersion,
      contextHash,
    });

    if (idempotencyKey) {
      const existing = await this.getTaskByIdempotencyKey(
        tenantId,
        factoryId,
        idempotencyKey,
      );

      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ConflictException(
            'The idempotency key was already used for a different or unverifiable AI agent task request',
          );
        }

        return {
          idempotent: true,
          task: this.mapTask(existing),
        };
      }
    }

    let result: AgentTaskRow;

    try {
      result = await this.database.transaction(
        async (client) => {
          const taskId = randomUUID();

          const inserted = await client.query<AgentTaskRow>(
            `
            INSERT INTO agent_tasks (
              id,
              tenant_id,
              factory_id,
              decision_id,
              parent_trace_id,
              actor_user_id,
              goal,
              max_steps,
              max_retries,
              max_tool_calls,
              timeout_ms,
              deadline_at,
              context_version,
              plan_version,
              context_hash,
              idempotency_key,
              request_hash
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17
            )
            RETURNING ${this.taskSelectColumns()}
            `,
            [
              taskId,
              tenantId,
              factoryId,
              decisionId,
              parentTraceId,
              actorUserId,
              goal,
              limits.maxSteps,
              limits.maxRetries,
              limits.maxToolCalls,
              limits.timeoutMs,
              deadlineAt,
              contextVersion,
              planVersion,
              contextHash,
              idempotencyKey,
              requestHash,
            ],
          );

          const task = inserted.rows[0];

          if (!task) {
            throw new Error('AI_AGENT_TASK_INSERT_FAILED');
          }

          for (let index = 0; index < input.steps.length; index += 1) {
            const step = input.steps[index]!;

            await client.query(
              `
              INSERT INTO agent_task_steps (
                id,
                tenant_id,
                factory_id,
                task_id,
                step_key,
                step_index,
                agent_id,
                capability,
                input_schema,
                output_schema,
                tool_id,
                tool_version,
                action_type,
                target,
                payload,
                resource_type,
                resource_id,
                risk_class,
                timeout_ms,
                retry_limit,
                authority_level,
                depends_on
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9::jsonb, $10::jsonb, $11, $12, $13,
                $14::jsonb, $15::jsonb, $16, $17, $18,
                $19, $20, $21, $22::jsonb
              )
              `,
              [
                randomUUID(),
                tenantId,
                factoryId,
                task.id,
                step.stepKey.trim(),
                index,
                step.agentId ?? null,
                step.capability.trim(),
                JSON.stringify(step.inputSchema ?? {}),
                JSON.stringify(step.outputSchema ?? {}),
                step.toolId.trim(),
                step.toolVersion.trim(),
                step.actionType.trim(),
                JSON.stringify(step.target ?? {}),
                JSON.stringify(step.payload ?? {}),
                step.resourceType ?? null,
                step.resourceId ?? null,
                step.riskClass ?? null,
                step.timeoutMs ?? 1000,
                step.retryLimit ?? 0,
                step.authorityLevel?.trim() ?? 'TASK_SCOPED',
                JSON.stringify(step.dependsOn ?? []),
              ],
            );
          }

          return task;
        },
        {
          tenantId,
          userId: actorUserId,
        },
      );


    } catch (error: unknown) {
      const databaseError =
        error && typeof error === 'object'
          ? (error as { code?: unknown; constraint?: unknown })
          : null;

      if (
        !idempotencyKey ||
        databaseError?.code !== '23505' ||
        databaseError?.constraint !== 'uq_agent_tasks_tenant_idempotency'
      ) {
        throw error;
      }

      // Another API instance may have inserted the same key after the
      // initial lookup. Replay only after validating its stored fingerprint.
      const concurrentTask = await this.getTaskByIdempotencyKey(
        tenantId,
        factoryId,
        idempotencyKey,
      );

      if (!concurrentTask || concurrentTask.request_hash !== requestHash) {
        throw new ConflictException(
          'The idempotency key was concurrently claimed for a different or unverifiable AI agent task request',
        );
      }

      return {
        idempotent: true,
        task: this.mapTask(concurrentTask),
      };
    }

    await this.audit(
      tenantId,
      factoryId,
      actorUserId,
      'AI_AGENT_TASK',
      'CREATE',
      'AGENT_TASK',
      result.id,
      parentTraceId,
      {
        decisionId,
        state: result.state,
        stepCount: input.steps.length,
        limits,
      },
    );

    return {
      idempotent: false,
      task: this.mapTask(result),
    };
  }

  async getTask(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(taskId, 'taskId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.business.read',
      factoryId,
    );

    const task = await this.requireTask(tenantId, factoryId, taskId);
    const steps = await this.getTaskSteps(tenantId, factoryId, taskId);

    return {
      task: this.mapTask(task),
      steps: steps.map((row) => this.mapStep(row)),
    };
  }

  async transitionState(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    expectedState: AiAgentState,
    nextState: AiAgentState,
    reason?: string | null,
  ): Promise<AiAgentTask> {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(taskId, 'taskId');

    if (!TRANSITIONS[expectedState].includes(nextState)) {
      throw new ConflictException(
        `Invalid AI agent state transition: ${expectedState} -> ${nextState}`,
      );
    }

    const task = await this.requireTask(tenantId, factoryId, taskId);

    if (task.state !== expectedState) {
      throw new ConflictException(
        `AI agent task is in ${task.state}, expected ${expectedState}`,
      );
    }

    const updated = await this.database.query<AgentTaskRow>(
      `
      UPDATE agent_tasks
      SET
        state = $4,
        failure_reason = COALESCE($5, failure_reason),
        version = version + 1
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND state = $6
        AND version = $7
      RETURNING ${this.taskSelectColumns()}
      `,
      [
        taskId,
        tenantId,
        factoryId,
        nextState,
        reason ?? null,
        expectedState,
        task.version,
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    const row = updated.rows[0];

    if (!row) {
      throw new ConflictException(
        'AI agent state transition lost an optimistic-concurrency race',
      );
    }

    await this.audit(
      tenantId,
      factoryId,
      actorUserId,
      'AI_AGENT_STATE',
      'TRANSITION',
      'AGENT_TASK',
      taskId,
      row.parent_trace_id,
      {
        from: expectedState,
        to: nextState,
        reason: reason ?? null,
        version: row.version,
      },
    );

    return this.mapTask(row);
  }

  async executeStep(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    stepId: string,
  ): Promise<AiAgentStepExecutionResult> {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.requiredUuid(taskId, 'taskId');
    this.requiredUuid(stepId, 'stepId');

    let task = await this.requireTask(tenantId, factoryId, taskId);
    let step = await this.requireStep(
      tenantId,
      factoryId,
      taskId,
      stepId,
    );
    // Preserve the original binding across step-state row refreshes.
    const boundAgentId = step.agent_id;

    if (step.status === 'SUCCEEDED') {
      return {
        idempotent: true,
        task: this.mapTask(task),
        step: this.mapStep(step),
      };
    }

    this.assertExecutable(task, step);
    await this.assertDependencies(tenantId, factoryId, task, step);

    if (boundAgentId) {
      await this.aiAgentCatalogueService.assertToolEntitled(
        tenantId,
        factoryId,
        boundAgentId,
        step.tool_id,
        step.tool_version,
      );
    }

    if (task.state === 'PLAN_READY') {
      await this.transitionState(
        tenantId,
        factoryId,
        actorUserId,
        task.id,
        'PLAN_READY',
        'AWAITING_AUTH',
      );
      task = await this.requireTask(tenantId, factoryId, task.id);
    }

    const authorizationAttempt =
      step.authorization_attempt + 1;
    const authorizationIdempotencyKey =
      `agent:${task.id}:${step.id}:auth:${authorizationAttempt}`;

    const stepClaim = await this.database.query(
      `
      UPDATE agent_task_steps
      SET
        authorization_attempt = $4,
        version = version + 1
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND status = $5
        AND version = $6
      `,
      [
        step.id,
        tenantId,
        factoryId,
        authorizationAttempt,
        step.status,
        step.version,
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    if (stepClaim.rowCount !== 1) {
      throw new ConflictException(
        'AI agent task step was changed or claimed by another execution request',
      );
    }

    try {
      const authorization =
        await this.aiRuntimeService.authorizeAction(
          tenantId,
          factoryId,
          actorUserId,
          {
            decision_id: task.decision_id,
            action_type: step.action_type,
            tool_version: step.tool_version,
            target: step.target,
            resource_type: step.resource_type,
            resource_id: step.resource_id,
            payload: step.payload,
            approval_id: step.approval_id,
            idempotency_key: authorizationIdempotencyKey,
            token_ttl_seconds: Math.min(
              3600,
              Math.max(30, Math.ceil(step.timeout_ms / 1000)),
            ),
          },
        );

      const action = authorization.action as Record<string, unknown>;
      const authStatus = action.authorizationStatus;

      if (authStatus === 'DENIED') {
        return this.blockStep(
          tenantId,
          factoryId,
          actorUserId,
          task.id,
          step.id,
          'AI_AGENT_AUTHORIZATION_DENIED',
          'AI action authorization was denied by policy',
        );
      }

      if (authStatus === 'APPROVAL_REQUIRED' || authStatus === 'AUTHORIZED') {
        this.assertAuthorizationMatchesStep(
          action,
          tenantId,
          factoryId,
          task.decision_id,
          step,
        );
      }

      if (authStatus === 'APPROVAL_REQUIRED') {
        const waitingTask = await this.updateTaskStateRaw(
          tenantId,
          factoryId,
          actorUserId,
          task.id,
          'AWAITING_APPROVAL',
          {
            currentStepId: step.id,
          },
        );

        const waitingStep = await this.updateStep(
          tenantId,
          factoryId,
          actorUserId,
          step.id,
          {
            status: 'AWAITING_APPROVAL',
            approvalId:
              typeof action.approvalId === 'string'
                ? action.approvalId
                : null,
            actionIntentId:
              typeof action.id === 'string'
                ? action.id
                : null,
          },
        );

        return {
          idempotent: false,
          task: this.mapTask(waitingTask),
          step: this.mapStep(waitingStep),
          waitingForApproval: true,
        };
      }

      if (authStatus !== 'AUTHORIZED') {
        throw new ConflictException(
          'AI action authorization returned an unsupported state',
        );
      }

      const actionToken = authorization.actionToken;

      if (typeof actionToken !== 'string' || actionToken.length === 0) {
        throw new ConflictException(
          'Authorized AI action did not return a short-lived action token',
        );
      }

      if (task.state === 'AWAITING_AUTH') {
        await this.transitionState(
          tenantId,
          factoryId,
          actorUserId,
          task.id,
          'AWAITING_AUTH',
          'EXECUTING',
        );
        task = await this.requireTask(tenantId, factoryId, task.id);
      } else if (task.state === 'AWAITING_APPROVAL') {
        await this.transitionState(
          tenantId,
          factoryId,
          actorUserId,
          task.id,
          'AWAITING_APPROVAL',
          'EXECUTING',
        );
        task = await this.requireTask(tenantId, factoryId, task.id);
      }

      await this.claimToolCall(
        tenantId,
        factoryId,
        actorUserId,
        task,
        step.id,
      );

      const attemptNumber = step.retry_count + 1;
      const executionKey = `agent:${task.id}:${step.id}:${attemptNumber}`;

      step = await this.updateStep(
        tenantId,
        factoryId,
        actorUserId,
        step.id,
        {
          status: 'RUNNING',
          actionIntentId:
            typeof action.id === 'string' ? action.id : null,
          approvalId:
            typeof action.approvalId === 'string'
              ? action.approvalId
              : null,
          startedAt: step.started_at ?? new Date().toISOString(),
          error: {},
        },
      );

      await this.recordAttempt(
        tenantId,
        factoryId,
        actorUserId,
        task.id,
        step.id,
        attemptNumber,
        'EXECUTION',
        'STARTED',
      );

      if (boundAgentId) {
        // Operational controls can change while action authorization runs.
        // Re-check immediately before crossing the side-effect boundary.
        await this.aiAgentCatalogueService.assertToolEntitled(
          tenantId,
          factoryId,
          boundAgentId,
          step.tool_id,
          step.tool_version,
        );
      }

      const { outcome, executionRecordId } =
        await this.executeGovernedTool(
          tenantId,
          factoryId,
          actorUserId,
          actionToken,
          executionKey,
          step.tool_id,
          step.tool_version,
          {
            decisionId: task.decision_id,
            actionIntentId: action.id as string,
            inputsHash: action.payloadHash as string,
          },
        );
      const executionEvidence = this.buildExecutionEvidence({
        task,
        step,
        actionIntentId: action.id as string,
        executionRecordId,
        executionKey,
        outcome,
      });

      if (outcome.status === 'SUCCEEDED') {
        await this.recordAttempt(
          tenantId,
          factoryId,
          actorUserId,
          task.id,
          step.id,
          attemptNumber,
          'EXECUTION',
          'SUCCEEDED',
          {},
          executionRecordId,
        );

        const succeededStep = await this.updateStep(
          tenantId,
          factoryId,
          actorUserId,
          step.id,
          {
            status: 'SUCCEEDED',
            executionRecordId,
            executionEvidence,
            output: outcome.result,
            error: {},
            finishedAt: new Date().toISOString(),
          },
        );

        await this.audit(
          tenantId,
          factoryId,
          actorUserId,
          'AI_AGENT_STEP_EXECUTION',
          'SUCCEEDED',
          'AGENT_TASK_STEP',
          step.id,
          task.parent_trace_id,
          { executionEvidence: { ...executionEvidence } },
        );

        const completedCount =
          await this.countCompletedSteps(
            tenantId,
            factoryId,
            task.id,
          );

        const totalCount =
          await this.countSteps(
            tenantId,
            factoryId,
            task.id,
          );

        task = await this.updateTaskStateRaw(
          tenantId,
          factoryId,
          actorUserId,
          task.id,
          completedCount === totalCount
            ? 'VERIFYING'
            : 'EXECUTING',
          {
            completedStepCount: completedCount,
            currentStepId:
              completedCount === totalCount
                ? null
                : step.id,
            clearCurrentStep:
              completedCount === totalCount,
          },
        );

        return {
          idempotent: false,
          task: this.mapTask(task),
          step: this.mapStep(succeededStep),
          gatewayOutcome: outcome,
        };
      }

      const failure =
        outcome.error ?? {
          code: 'AI_TOOL_EXECUTION_FAILED',
          message: 'AI Tool Gateway returned a failed execution result',
        };

      await this.recordAttempt(
        tenantId,
        factoryId,
        actorUserId,
        task.id,
        step.id,
        attemptNumber,
        'EXECUTION',
        'FAILED',
        failure,
        executionRecordId,
      );

      return this.applyFailure(
        tenantId,
        factoryId,
        actorUserId,
        task,
        step,
        failure,
        executionRecordId,
        executionEvidence,
      );
    } catch (error) {
      const failure = {
        code: 'AI_AGENT_EXECUTION_FAILURE',
        message: this.errorMessage(error),
      };

      await this.failTask(
        tenantId,
        factoryId,
        actorUserId,
        task.id,
        failure.code,
        failure.message,
        step.id,
      );

      throw error;
    }
  }

  async resumeTaskStep(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    stepId: string,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    const task = await this.requireTask(tenantId, factoryId, taskId);
    if (task.state !== 'AWAITING_APPROVAL') {
      throw new ConflictException(
        'Only an approval-pending task can be resumed through this path',
      );
    }

    const step = await this.requireStep(
      tenantId,
      factoryId,
      taskId,
      stepId,
    );

    if (step.status !== 'AWAITING_APPROVAL') {
      throw new ConflictException(
        'AI agent task step is not awaiting approval',
      );
    }

    return this.executeStep(
      tenantId,
      factoryId,
      actorUserId,
      taskId,
      stepId,
    );
  }

  async verifyTask(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
  ): Promise<AiAgentTask> {
    this.validateScope(tenantId, factoryId, actorUserId);
    const task = await this.requireTask(tenantId, factoryId, taskId);

    if (task.state !== 'VERIFYING') {
      throw new ConflictException(
        `AI agent task must be VERIFYING before completion; current state is ${task.state}`,
      );
    }

    this.assertNotCancelled(this.mapTask(task));
    this.assertDeadline(this.mapTask(task));

    const steps = await this.getTaskSteps(
      tenantId,
      factoryId,
      taskId,
    );

    if (
      steps.length === 0 ||
      steps.some((step) => step.status !== 'SUCCEEDED')
    ) {
      await this.failTask(
        tenantId,
        factoryId,
        actorUserId,
        task.id,
        'AI_AGENT_VERIFICATION_FAILED',
        'Not every task step completed successfully',
      );

      throw new ConflictException(
        'AI agent task verification failed because not all steps succeeded',
      );
    }

    const completed = await this.updateTaskStateRaw(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      'COMPLETED',
      {
        completedStepCount: steps.length,
        currentStepId: null,
        clearCurrentStep: true,
        failureCode: null,
        failureReason: null,
        clearFailure: true,
      },
    );

    return this.mapTask(completed);
  }

  async cancelTask(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    reason = 'AI agent task cancelled by actor',
  ): Promise<AiAgentTask> {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.actions.authorize',
      factoryId,
    );

    const task = await this.requireTask(tenantId, factoryId, taskId);

    if (task.state === 'CANCELLED') {
      return this.mapTask(task);
    }

    if (this.isTerminal(task.state)) {
      throw new ConflictException(
        `AI agent task cannot be cancelled from terminal state ${task.state}`,
      );
    }

    const result = await this.database.query<AgentTaskRow>(
      `
      UPDATE agent_tasks
      SET
        state = 'CANCELLED',
        cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
        failure_code = 'AI_AGENT_CANCELLED',
        failure_reason = $4,
        version = version + 1
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND state NOT IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')
      RETURNING ${this.taskSelectColumns()}
      `,
      [task.id, tenantId, factoryId, this.requiredString(reason, 'reason', 2000)],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    const row = result.rows[0];
    if (!row) {
      throw new ConflictException(
        'AI agent cancellation lost a concurrency race',
      );
    }

    await this.database.query(
      `
      UPDATE agent_task_steps
      SET
        status = 'CANCELLED',
        finished_at = NOW(),
        version = version + 1
      WHERE
        tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND status IN ('PENDING', 'AWAITING_APPROVAL')
      `,
      [tenantId, factoryId, task.id],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    await this.audit(
      tenantId,
      factoryId,
      actorUserId,
      'AI_AGENT_TASK',
      'CANCEL',
      'AGENT_TASK',
      task.id,
      row.parent_trace_id,
      { reason },
    );

    return this.mapTask(row);
  }

  async createHandoff(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiAgentHandoffInput,
  ): Promise<AiAgentHandoffRecord> {
    this.validateScope(tenantId, factoryId, actorUserId);

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.actions.authorize',
      factoryId,
    );

    const sourceAgentId = this.requiredString(
      input.sourceAgentId,
      'sourceAgentId',
      200,
    );
    const targetAgentId = this.requiredString(
      input.targetAgentId,
      'targetAgentId',
      200,
    );
    const purpose = this.requiredString(input.purpose, 'purpose', 1000);
    const allowedDataClasses = this.normalizeStrings(
      input.allowedDataClasses,
      'allowedDataClasses',
    );
    const permittedTools = this.normalizePermittedTools(input.permittedTools);
    const expiresAt = this.futureTimestamp(input.expiresAt, 'expiresAt');
    const parentTraceId = this.requiredUuid(
      input.parentTraceId,
      'parentTraceId',
    );
    const expectedArtifact = input.expectedArtifact ?? null;

    if (
      expectedArtifact !== null &&
      !this.isObject(expectedArtifact)
    ) {
      throw new BadRequestException(
        'expectedArtifact must be an object or null',
      );
    }

    await this.assertHandoffToolEntitlements(
      tenantId,
      factoryId,
      sourceAgentId,
      permittedTools,
    );

    const handoffHash = this.computeHash({
      tenantId,
      factoryId,
      sourceAgentId,
      targetAgentId,
      purpose,
      allowedDataClasses,
      permittedTools,
      expiresAt,
      parentTraceId,
      expectedArtifact,
    });

    const result = await this.database.query<AgentHandoffRow>(
      `
      INSERT INTO agent_handoffs (
        tenant_id,
        factory_id,
        source_agent_id,
        target_agent_id,
        purpose,
        allowed_data_classes,
        permitted_tools,
        expires_at,
        parent_trace_id,
        expected_artifact,
        handoff_hash
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11
      )
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_agent_id,
        target_agent_id,
        purpose,
        allowed_data_classes,
        permitted_tools,
        expires_at::text AS expires_at,
        parent_trace_id::text AS parent_trace_id,
        expected_artifact,
        handoff_hash,
        status,
        accepted_by::text AS accepted_by,
        accepted_at::text AS accepted_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      `,
      [
        tenantId,
        factoryId,
        sourceAgentId,
        targetAgentId,
        purpose,
        allowedDataClasses,
        permittedTools,
        expiresAt,
        parentTraceId,
        JSON.stringify(expectedArtifact),
        handoffHash,
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('AI_AGENT_HANDOFF_INSERT_FAILED');
    }

    await this.audit(
      tenantId,
      factoryId,
      actorUserId,
      'AI_AGENT_HANDOFF',
      'CREATE',
      'AGENT_HANDOFF',
      row.id,
      row.parent_trace_id,
      {
        sourceAgentId,
        targetAgentId,
        permittedTools,
        expiresAt,
        handoffHash,
      },
    );

    return this.mapHandoff(row);
  }

  async acceptHandoff(
    tenantId: string,
    factoryId: string,
    receivingUserId: string,
    handoffId: string,
  ): Promise<AiAgentHandoffRecord> {
    this.validateScope(tenantId, factoryId, receivingUserId);
    this.requiredUuid(handoffId, 'handoffId');

    const handoff = await this.getHandoff(
      tenantId,
      factoryId,
      handoffId,
    );

    if (!handoff) {
      throw new NotFoundException(
        'AI agent handoff was not found for this factory',
      );
    }

    if (handoff.status !== 'PENDING') {
      throw new ConflictException(
        `AI agent handoff is not pending: ${handoff.status}`,
      );
    }

    const expiry = new Date(handoff.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      await this.database.query(
        `
        UPDATE agent_handoffs
        SET status = 'EXPIRED'
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        `,
        [handoffId, tenantId, factoryId],
        {
          tenantId,
          userId: receivingUserId,
        },
      );

      throw new ConflictException('AI agent handoff has expired');
    }

    // Handoff does not transfer sender authority. The receiving agent
    // must independently hold a current entitlement for every permitted tool.
    await this.assertHandoffToolEntitlements(
      tenantId,
      factoryId,
      handoff.targetAgentId,
      handoff.permittedTools,
    );

    for (const reference of handoff.permittedTools) {
      const { toolId, version } = this.parseToolReference(reference);
      const tool = await this.toolRegistry.getTool(
        tenantId,
        factoryId,
        toolId,
        version,
      );

      for (const permission of tool.requiredScopes) {
        await this.iamService.authorize(
          receivingUserId,
          tenantId,
          permission,
          factoryId,
        );
      }
    }

    const result = await this.database.query<AgentHandoffRow>(
      `
      UPDATE agent_handoffs
      SET
        status = 'ACCEPTED',
        accepted_by = $4,
        accepted_at = NOW()
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND status = 'PENDING'
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_agent_id,
        target_agent_id,
        purpose,
        allowed_data_classes,
        permitted_tools,
        expires_at::text AS expires_at,
        parent_trace_id::text AS parent_trace_id,
        expected_artifact,
        handoff_hash,
        status,
        accepted_by::text AS accepted_by,
        accepted_at::text AS accepted_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      `,
      [handoffId, tenantId, factoryId, receivingUserId],
      {
        tenantId,
        userId: receivingUserId,
      },
    );

    const row = result.rows[0];
    if (!row) {
      throw new ConflictException(
        'AI agent handoff acceptance lost a concurrency race',
      );
    }

    await this.audit(
      tenantId,
      factoryId,
      receivingUserId,
      'AI_AGENT_HANDOFF',
      'ACCEPT',
      'AGENT_HANDOFF',
      row.id,
      row.parent_trace_id,
      {
        senderAuthorityInherited: false,
        receiverUserId: receivingUserId,
      },
    );

    return this.mapHandoff(row);
  }

  async compensateStep(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    stepId: string,
    compensationPayload: Record<string, unknown>,
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);

    const task = await this.requireTask(tenantId, factoryId, taskId);
    const step = await this.requireStep(
      tenantId,
      factoryId,
      taskId,
      stepId,
    );

    if (step.status !== 'SUCCEEDED') {
      throw new ConflictException(
        'Only a successfully executed step can be compensated',
      );
    }

    const tool = await this.toolRegistry.getTool(
      tenantId,
      factoryId,
      step.tool_id,
      step.tool_version,
    );

    if (tool.rollback.type === 'NONE') {
      return {
        attempted: false,
        status: 'NOT_SUPPORTED',
        task: this.mapTask(task),
        step: this.mapStep(step),
      };
    }

    if (
      !tool.rollback.toolId ||
      !tool.rollback.toolVersion ||
      !tool.rollback.actionType
    ) {
      throw new ConflictException(
        'Registered rollback contract is incomplete; compensation is fail-closed',
      );
    }

    if (tool.rollback.actionType !== tool.rollback.toolId) {
      throw new ConflictException(
        'Registered rollback action type must equal its tool id; compensation is fail-closed',
      );
    }

    if (step.agent_id) {
      await this.aiAgentCatalogueService.assertToolEntitled(
        tenantId,
        factoryId,
        step.agent_id,
        tool.rollback.toolId,
        tool.rollback.toolVersion,
      );
    }

    // Keep authorization and durable execution on the same stable retry key.
    // A new key per request could mint a second action intent for one recovery
    // attempt, obscuring whether an earlier compensation already ran.
    const attemptNumber = await this.nextAttemptNumber(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      step.id,
      'COMPENSATION',
      tool.rollback.toolVersion,
    );
    const executionKey =
      `agent:${task.id}:${step.id}:compensation:${attemptNumber}`;

    const authorization =
      await this.aiRuntimeService.authorizeAction(
        tenantId,
        factoryId,
        actorUserId,
        {
          decision_id: task.decision_id,
          action_type: tool.rollback.actionType,
          tool_version: tool.rollback.toolVersion,
          target: step.target,
          resource_type: step.resource_type,
          resource_id: step.resource_id,
          payload: compensationPayload,
          idempotency_key:
            executionKey,
          token_ttl_seconds: 600,
        },
      );

    const action = authorization.action as Record<string, unknown>;
    if (action.authorizationStatus !== 'AUTHORIZED') {
      throw new ConflictException(
        'Compensation action was not authorized',
      );
    }
    this.assertAuthorizationMatchesCompensation(
      action,
      tenantId,
      factoryId,
      task.decision_id,
      {
        toolId: tool.rollback.toolId,
        toolVersion: tool.rollback.toolVersion,
        actionType: tool.rollback.actionType,
      },
      step,
      compensationPayload,
    );

    const actionToken = authorization.actionToken;
    if (typeof actionToken !== 'string') {
      throw new ConflictException(
        'Authorized compensation action did not return an action token',
      );
    }

    if (step.agent_id) {
      // A pause/restriction may arrive during compensation authorization.
      await this.aiAgentCatalogueService.assertToolEntitled(
        tenantId,
        factoryId,
        step.agent_id,
        tool.rollback.toolId,
        tool.rollback.toolVersion,
      );
    }

    // Persist STARTED before the execution boundary. If the process or network
    // fails after the tool may have run, the next request must not mint a new
    // compensation key until the related durable execution claim is reconciled.
    await this.recordAttempt(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      step.id,
      attemptNumber,
      'COMPENSATION',
      'STARTED',
      {},
      undefined,
      action.id as string,
    );

    const { outcome, executionRecordId } =
      await this.executeGovernedTool(
        tenantId,
        factoryId,
        actorUserId,
        actionToken,
        executionKey,
        tool.rollback.toolId,
        tool.rollback.toolVersion,
        {
          decisionId: task.decision_id,
          actionIntentId: action.id as string,
          inputsHash: action.payloadHash as string,
        },
      );
    const compensationEvidence = this.buildExecutionEvidence({
      task,
      step,
      actionIntentId: action.id as string,
      executionRecordId,
      executionKey,
      outcome,
      toolId: tool.rollback.toolId,
      executionKind: 'COMPENSATION',
      sourceExecutionRecordId: step.execution_record_id,
      attemptNumber,
    });

    await this.recordAttempt(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      step.id,
      attemptNumber,
      'COMPENSATION',
      outcome.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      outcome.error,
      executionRecordId,
      action.id as string,
    );

    await this.audit(
      tenantId,
      factoryId,
      actorUserId,
      'AI_AGENT_COMPENSATION',
      outcome.status,
      'AGENT_TASK_STEP',
      step.id,
      task.parent_trace_id,
      {
        rollbackType: tool.rollback.type,
        rollbackToolId: tool.rollback.toolId,
        rollbackVersion: tool.rollback.toolVersion,
        rollbackActionType: tool.rollback.actionType,
        compensationEvidence,
      },
    );

    return {
      attempted: true,
      status: outcome.status,
      outcome,
      executionEvidence: compensationEvidence,
    };
  }

  private async applyFailure(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    task: AgentTaskRow,
    step: AgentTaskStepRow,
    error: Record<string, unknown>,
    executionRecordId?: string,
    executionEvidence?: AiAgentExecutionEvidence,
  ): Promise<AiAgentStepExecutionResult> {
    const canRetry =
      step.retry_count < step.retry_limit &&
      task.retry_count < task.max_retries &&
      !task.cancel_requested_at;

    if (canRetry) {
      const newRetryCount = step.retry_count + 1;
      await this.database.query(
        `
        UPDATE agent_task_steps
        SET
          status = 'PENDING',
          retry_count = $4,
          execution_record_id = COALESCE($5, execution_record_id),
          error = $6::jsonb,
          execution_evidence = COALESCE($7::jsonb, execution_evidence),
          finished_at = NOW(),
          version = version + 1
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        `,
        [
          step.id,
          tenantId,
          factoryId,
          newRetryCount,
          executionRecordId ?? null,
          JSON.stringify(error),
          executionEvidence ? JSON.stringify(executionEvidence) : null,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

      const taskResult = await this.database.query<AgentTaskRow>(
        `
        UPDATE agent_tasks
        SET
          state = 'EXECUTING',
          retry_count = retry_count + 1,
          failure_code = NULL,
          failure_reason = NULL,
          version = version + 1
        WHERE
          id = $1
          AND tenant_id = $2
          AND factory_id = $3
          AND state IN ('EXECUTING', 'AWAITING_AUTH')
          AND retry_count < max_retries
        RETURNING ${this.taskSelectColumns()}
        `,
        [task.id, tenantId, factoryId],
        {
          tenantId,
          userId: actorUserId,
        },
      );

      const retryTask = taskResult.rows[0];
      if (retryTask) {
        const retryStep = await this.requireStep(
          tenantId,
          factoryId,
          task.id,
          step.id,
        );

        await this.audit(
          tenantId,
          factoryId,
          actorUserId,
          'AI_AGENT_STEP',
          'RETRY',
          'AGENT_TASK_STEP',
          step.id,
          retryTask.parent_trace_id,
          {
            retryCount: retryStep.retry_count,
            error,
            executionEvidence: executionEvidence ?? null,
          },
        );

        return {
          idempotent: false,
          task: this.mapTask(retryTask),
          step: this.mapStep(retryStep),
          error,
        };
      }
    }

    return this.failTask(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      'AI_AGENT_RETRY_LIMIT_EXCEEDED',
      this.errorMessageFromRecord(error),
      step.id,
      executionEvidence,
    );
  }

  private async failTask(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    code: string,
    reason: string,
    stepId?: string,
    executionEvidence?: AiAgentExecutionEvidence,
  ): Promise<AiAgentStepExecutionResult> {
    const task = await this.requireTask(tenantId, factoryId, taskId);

    const updated = await this.updateTaskStateRaw(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      'FAILED',
      {
        failureCode: code,
        failureReason: reason,
      },
    );

    let step: AgentTaskStepRow | null = null;
    if (stepId) {
      step = await this.requireStep(
        tenantId,
        factoryId,
        task.id,
        stepId,
      );
    } else {
      const rows = await this.getTaskSteps(
        tenantId,
        factoryId,
        task.id,
      );
      step = rows[0] ?? null;
    }

    await this.audit(
      tenantId,
      factoryId,
      actorUserId,
      'AI_AGENT_TASK',
      'FAIL',
      'AGENT_TASK',
      task.id,
      updated.parent_trace_id,
      {
        code,
        reason,
        stepId: stepId ?? null,
        executionEvidence: executionEvidence ?? null,
      },
    );

    if (stepId) {
      await this.updateStep(
        tenantId,
        factoryId,
        actorUserId,
        stepId,
        {
          status: 'FAILED',
          error: {
            code,
            message: reason,
          },
          executionEvidence,
          finishedAt: new Date().toISOString(),
        },
      );
    }

    const finalStep =
      (stepId
        ? await this.requireStep(
            tenantId,
            factoryId,
            task.id,
            stepId,
          )
        : step) ??
      (() => {
        throw new ConflictException(reason);
      })();

    return {
      idempotent: false,
      task: this.mapTask(updated),
      step: this.mapStep(finalStep),
      error: {
        code,
        message: reason,
      },
    };
  }

  private async blockStep(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    stepId: string,
    code: string,
    reason: string,
  ): Promise<AiAgentStepExecutionResult> {
    const task = await this.requireTask(tenantId, factoryId, taskId);
    const updatedTask = await this.updateTaskStateRaw(
      tenantId,
      factoryId,
      actorUserId,
      task.id,
      'BLOCKED',
      {
        failureCode: code,
        failureReason: reason,
        currentStepId: stepId,
      },
    );

    const updatedStep = await this.updateStep(
      tenantId,
      factoryId,
      actorUserId,
      stepId,
      {
        status: 'BLOCKED',
        error: {
          code,
          message: reason,
        },
        finishedAt: new Date().toISOString(),
      },
    );

    return {
      idempotent: false,
      task: this.mapTask(updatedTask),
      step: this.mapStep(updatedStep),
      error: {
        code,
        message: reason,
      },
    };
  }

  private async executeGovernedTool(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    actionToken: string,
    executionKey: string,
    toolId: string,
    toolVersion: string,
    expectedBinding: {
      decisionId: string;
      actionIntentId: string;
      inputsHash: string;
    },
  ): Promise<{
    outcome: AiToolExecutionOutcome;
    executionRecordId: string;
  }> {
    // Resolve the immutable tool contract before side effects. The central
    // runtime remains responsible for claims, execution persistence and audit.
    const tool = await this.toolRegistry.getTool(
      tenantId,
      factoryId,
      toolId,
      toolVersion,
    );

    const result = await this.aiRuntimeService.executeAgentAction(
      tenantId,
      factoryId,
      actorUserId,
      {
        action_token: actionToken,
        execution_key: executionKey,
        tool_version: toolVersion,
      },
    );
    const execution = result.execution;
    const executionBindingMatches =
      typeof execution.id === 'string' &&
      execution.id.length > 0 &&
      execution.decisionId === expectedBinding.decisionId &&
      execution.actionIntentId === expectedBinding.actionIntentId &&
      execution.executionKey === executionKey &&
      execution.toolVersion === toolVersion &&
      execution.inputsHash === expectedBinding.inputsHash &&
      execution.executorType === 'AGENT_RUNTIME' &&
      (execution.status === 'SUCCEEDED' || execution.status === 'FAILED');

    if (!executionBindingMatches) {
      throw new ConflictException(
        'AI execution record does not match the bound agent action',
      );
    }

    return {
      outcome: {
        ...result.execution,
        tool,
      },
      executionRecordId: result.execution.id,
    };
  }

  private async claimToolCall(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    task: AgentTaskRow,
    stepId: string,
  ): Promise<void> {
    const result = await this.database.query(
      `
      UPDATE agent_tasks
      SET
        tool_call_count = tool_call_count + 1,
        current_step_id = $4,
        version = version + 1
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND state = 'EXECUTING'
        AND cancel_requested_at IS NULL
        AND tool_call_count < max_tool_calls
      `,
      [task.id, tenantId, factoryId, stepId],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    if (result.rowCount !== 1) {
      throw new ConflictException(
        'AI agent maximum-tool-call budget exceeded or task was cancelled before Tool Gateway execution',
      );
    }
  }

  private async recordAttempt(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    stepId: string,
    attemptNumber: number,
    attemptType: 'EXECUTION' | 'COMPENSATION',
    status: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED',
    error: Record<string, unknown> = {},
    executionRecordId?: string,
    actionIntentId?: string,
  ): Promise<void> {
    // One statement makes the attempt identity safe under concurrent retries.
    // A late STARTED event must not reopen a terminal attempt, and conflicting
    // terminal outcomes or execution-record bindings require reconciliation.
    const result = await this.database.query<{ id: string }>(
      `
      INSERT INTO agent_action_attempts AS attempt_row (
        id, tenant_id, factory_id, task_id, step_id, attempt_number,
        attempt_type, action_intent_id, execution_record_id, status, error, finished_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        CASE
          WHEN $10 IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
            THEN NOW()
          ELSE NULL
        END
      )
      ON CONFLICT (task_id, step_id, attempt_number, attempt_type)
      DO UPDATE SET
        status = CASE
          WHEN attempt_row.status IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
            THEN attempt_row.status
          ELSE EXCLUDED.status
        END,
        action_intent_id = COALESCE(
          attempt_row.action_intent_id,
          EXCLUDED.action_intent_id
        ),
        execution_record_id = COALESCE(
          attempt_row.execution_record_id,
          EXCLUDED.execution_record_id
        ),
        error = CASE
          WHEN attempt_row.status IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
            THEN attempt_row.error
          ELSE EXCLUDED.error
        END,
        finished_at = CASE
          WHEN attempt_row.status IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
            THEN attempt_row.finished_at
          WHEN EXCLUDED.status IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
            THEN NOW()
          ELSE attempt_row.finished_at
        END
      WHERE
        attempt_row.tenant_id = EXCLUDED.tenant_id
        AND attempt_row.factory_id = EXCLUDED.factory_id
        AND (
          attempt_row.execution_record_id IS NULL
          OR EXCLUDED.execution_record_id IS NULL
          OR attempt_row.execution_record_id = EXCLUDED.execution_record_id
        )
        AND (
          attempt_row.action_intent_id IS NULL
          OR EXCLUDED.action_intent_id IS NULL
          OR attempt_row.action_intent_id = EXCLUDED.action_intent_id
        )
        AND (
          attempt_row.status NOT IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
          OR EXCLUDED.status = 'STARTED'
          OR EXCLUDED.status = attempt_row.status
        )
      RETURNING id::text AS id
      `,
      [
        randomUUID(),
        tenantId,
        factoryId,
        taskId,
        stepId,
        attemptNumber,
        attemptType,
        actionIntentId ?? null,
        executionRecordId ?? null,
        status,
        JSON.stringify(error),
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    if (!result.rows[0]) {
      throw new ConflictException(
        'Agent action attempt is bound to a conflicting scope, execution record, or terminal outcome',
      );
    }
  }

  private async nextAttemptNumber(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    stepId: string,
    attemptType: 'EXECUTION' | 'COMPENSATION',
    expectedToolVersion?: string,
  ): Promise<number> {
    const result = await this.database.query<{
      attempt_number: number;
      status: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';
      action_intent_id: string | null;
    }>(
      `
      SELECT
        attempt_number,
        status,
        action_intent_id::text AS action_intent_id
      FROM agent_action_attempts
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND step_id = $4
        AND attempt_type = $5
      ORDER BY attempt_number DESC, created_at DESC
      LIMIT 1
      `,
      [tenantId, factoryId, taskId, stepId, attemptType],
      { tenantId, userId: actorUserId },
    );

    const latest = result.rows[0];
    if (attemptType !== 'COMPENSATION' || !latest) {
      return Number(latest?.attempt_number ?? 0) + 1;
    }

    if (latest.status === 'SUCCEEDED') {
      throw new ConflictException(
        'A compensation attempt already succeeded; duplicate compensation is blocked',
      );
    }

    if (latest.status !== 'STARTED') {
      return latest.attempt_number + 1;
    }

    if (!latest.action_intent_id) {
      throw new ConflictException(
        'A previous compensation attempt has no action-intent binding; manual investigation is required',
      );
    }

    const claimResult = await this.database.query<{
      claim_status: 'CLAIMED' | 'COMPLETED' | 'FAILED';
      execution_key: string;
      tool_version: string;
      inputs_hash: string;
      execution_record_id: string | null;
      execution_record_status: 'SUCCEEDED' | 'FAILED' | null;
      record_execution_key: string | null;
      record_tool_version: string | null;
      record_inputs_hash: string | null;
      reconciliation_decision: 'CONFIRMED_COMPLETED' | 'CONFIRMED_FAILED' | null;
    }>(
      `
      SELECT
        c.status AS claim_status,
        c.execution_key,
        c.tool_version,
        c.inputs_hash,
        e.id::text AS execution_record_id,
        e.status AS execution_record_status,
        e.execution_key AS record_execution_key,
        e.tool_version AS record_tool_version,
        e.inputs_hash AS record_inputs_hash,
        r.decision AS reconciliation_decision
      FROM ai_execution_claims c
      LEFT JOIN ai_execution_records e
        ON e.tenant_id = c.tenant_id
       AND e.factory_id = c.factory_id
       AND e.action_intent_id = c.action_intent_id
      LEFT JOIN ai_execution_claim_reconciliations r
        ON r.tenant_id = c.tenant_id
       AND r.factory_id = c.factory_id
       AND r.claim_id = c.id
      WHERE c.tenant_id = $1
        AND c.factory_id = $2
        AND c.action_intent_id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, latest.action_intent_id],
      { tenantId, userId: actorUserId },
    );

    const claim = claimResult.rows[0];
    const expectedExecutionKey =
      `agent:${taskId}:${stepId}:compensation:${latest.attempt_number}`;
    if (
      !claim ||
      claim.execution_key !== expectedExecutionKey ||
      (expectedToolVersion !== undefined && claim.tool_version !== expectedToolVersion)
    ) {
      throw new ConflictException(
        'A previous compensation attempt has an unresolved or mismatched AI execution claim; manual investigation is required',
      );
    }

    const hasExecutionRecord = claim.execution_record_id !== null;
    const executionRecordBindingMatches =
      !hasExecutionRecord ||
      (
        claim.record_execution_key === claim.execution_key &&
        claim.record_tool_version === claim.tool_version &&
        claim.record_inputs_hash === claim.inputs_hash
      );
    if (!executionRecordBindingMatches) {
      throw new ConflictException(
        'The reconciled compensation execution record does not match its durable claim; manual investigation is required',
      );
    }

    if (claim.claim_status === 'CLAIMED') {
      throw new ConflictException(
        'A previous compensation attempt is unresolved; reconcile its AI execution claim before retrying',
      );
    }

    if (claim.claim_status === 'COMPLETED') {
      const completionIsConfirmed =
        (hasExecutionRecord && claim.execution_record_status === 'SUCCEEDED') ||
        (!hasExecutionRecord &&
          claim.reconciliation_decision === 'CONFIRMED_COMPLETED');
      if (!completionIsConfirmed) {
        throw new ConflictException(
          'The prior compensation claim is marked completed without matching completion evidence; manual investigation is required',
        );
      }

      await this.recordAttempt(
        tenantId,
        factoryId,
        actorUserId,
        taskId,
        stepId,
        latest.attempt_number,
        'COMPENSATION',
        'SUCCEEDED',
        {},
        claim.execution_record_id ?? undefined,
        latest.action_intent_id,
      );
      throw new ConflictException(
        'The previous compensation attempt is confirmed completed; duplicate compensation is blocked',
      );
    }

    // A terminally FAILED claim is not replayed with its old execution key.
    // Persist that known terminal state, then the caller's explicit new request
    // may allocate a fresh attempt key.
    if (
      hasExecutionRecord &&
      claim.execution_record_status !== 'FAILED'
    ) {
      throw new ConflictException(
        'The failed compensation claim conflicts with its execution record; manual investigation is required',
      );
    }

    await this.recordAttempt(
      tenantId,
      factoryId,
      actorUserId,
      taskId,
      stepId,
      latest.attempt_number,
      'COMPENSATION',
      'FAILED',
      {
        code: 'AI_EXECUTION_CLAIM_FAILED',
        reconciliationDecision: claim.reconciliation_decision,
      },
      claim.execution_record_id ?? undefined,
      latest.action_intent_id,
    );

    return latest.attempt_number + 1;
  }

  private async updateTaskStateRaw(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    taskId: string,
    state: AiAgentState,
    fields: {
      currentStepId?: string | null;
      clearCurrentStep?: boolean;
      completedStepCount?: number;
      failureCode?: string | null;
      failureReason?: string | null;
      clearFailure?: boolean;
    } = {},
  ): Promise<AgentTaskRow> {
    const result = await this.database.query<AgentTaskRow>(
      `
      UPDATE agent_tasks
      SET
        state = $4,
        current_step_id = CASE
          WHEN $5::boolean THEN NULL
          ELSE COALESCE($6, current_step_id)
        END,
        completed_step_count = COALESCE($7, completed_step_count),
        failure_code = CASE
          WHEN $8::boolean THEN NULL
          WHEN $9::text IS NULL THEN failure_code
          ELSE $9
        END,
        failure_reason = CASE
          WHEN $8::boolean THEN NULL
          WHEN $10::text IS NULL THEN failure_reason
          ELSE $10
        END,
        version = version + 1
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
      RETURNING ${this.taskSelectColumns()}
      `,
      [
        taskId,
        tenantId,
        factoryId,
        state,
        fields.clearCurrentStep ?? false,
        fields.currentStepId ?? null,
        fields.completedStepCount ?? null,
        fields.clearFailure ?? false,
        fields.failureCode ?? null,
        fields.failureReason ?? null,
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    const row = result.rows[0];
    if (!row) {
      throw new ConflictException(
        'AI agent task state update failed',
      );
    }

    return row;
  }

  private buildExecutionEvidence(input: {
    task: AgentTaskRow;
    step: AgentTaskStepRow;
    actionIntentId: string;
    executionRecordId: string;
    executionKey: string;
    outcome: AiToolExecutionOutcome;
    toolId?: string;
    executionKind?: AiAgentExecutionEvidence['executionKind'];
    sourceExecutionRecordId?: string | null;
    attemptNumber?: number;
  }): AiAgentExecutionEvidence {
    return {
      schemaVersion: 1,
      executionKind: input.executionKind ?? 'STEP',
      taskId: input.task.id,
      stepId: input.step.id,
      decisionId: input.task.decision_id,
      parentTraceId: input.task.parent_trace_id,
      actionIntentId: input.actionIntentId,
      executionRecordId: input.executionRecordId,
      executionKey: input.executionKey,
      toolId: input.toolId ?? input.step.tool_id,
      toolVersion: input.outcome.toolVersion,
      executorType: input.outcome.executorType,
      inputsHash: input.outcome.inputsHash,
      outcomeStatus: input.outcome.status,
      outcomeHash: this.computeHash({
        status: input.outcome.status,
        result: input.outcome.result,
        error: input.outcome.error,
      }),
      ...(input.executionKind === 'COMPENSATION'
        ? {
            sourceExecutionRecordId: input.sourceExecutionRecordId ?? null,
            attemptNumber: input.attemptNumber,
          }
        : {}),
    };
  }

  private assertAuthorizationMatchesCompensation(
    action: Record<string, unknown>,
    tenantId: string,
    factoryId: string,
    decisionId: string,
    rollback: { toolId: string; toolVersion: string; actionType: string },
    step: AgentTaskStepRow,
    payload: Record<string, unknown>,
  ): void {
    const actionPayloadMatches =
      action.payload !== null &&
      typeof action.payload === 'object' &&
      !Array.isArray(action.payload) &&
      this.computeHash(action.payload) === this.computeHash(payload);
    const targetMatches =
      action.target !== null &&
      typeof action.target === 'object' &&
      !Array.isArray(action.target) &&
      this.computeHash(action.target) === this.computeHash(step.target);

    const bindingMatches =
      typeof action.id === 'string' &&
      action.id.length > 0 &&
      action.tenantId === tenantId &&
      action.factoryId === factoryId &&
      action.decisionId === decisionId &&
      action.actionType === rollback.actionType &&
      action.toolId === rollback.toolId &&
      action.toolVersion === rollback.toolVersion &&
      (action.resourceType ?? null) === (step.resource_type ?? null) &&
      (action.resourceId ?? null) === (step.resource_id ?? null) &&
      actionPayloadMatches &&
      targetMatches &&
      action.payloadHash === this.computeHash(payload);

    if (!bindingMatches) {
      throw new ConflictException(
        'Compensation authorization does not match the registered rollback contract',
      );
    }
  }

  private assertAuthorizationMatchesStep(
    action: Record<string, unknown>,
    tenantId: string,
    factoryId: string,
    decisionId: string,
    step: AgentTaskStepRow,
  ): void {
    const payloadMatches =
      action.payload !== null &&
      typeof action.payload === 'object' &&
      !Array.isArray(action.payload) &&
      this.computeHash(action.payload) === this.computeHash(step.payload);
    const targetMatches =
      action.target !== null &&
      typeof action.target === 'object' &&
      !Array.isArray(action.target) &&
      this.computeHash(action.target) === this.computeHash(step.target);

    const bindingMatches =
      typeof action.id === 'string' &&
      action.id.length > 0 &&
      action.tenantId === tenantId &&
      action.factoryId === factoryId &&
      action.decisionId === decisionId &&
      action.actionType === step.action_type &&
      action.toolId === step.tool_id &&
      action.toolVersion === step.tool_version &&
      (action.resourceType ?? null) === (step.resource_type ?? null) &&
      (action.resourceId ?? null) === (step.resource_id ?? null) &&
      payloadMatches &&
      targetMatches &&
      action.payloadHash === this.computeHash(step.payload) &&
      (step.risk_class === null || action.riskClass === step.risk_class);

    if (!bindingMatches) {
      throw new ConflictException(
        'AI action authorization does not match the bound agent task step',
      );
    }
  }

  private async updateStep(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    stepId: string,
    fields: {
      status?: AiAgentTaskStep['status'];
      actionIntentId?: string | null;
      approvalId?: string | null;
      executionRecordId?: string | null;
      executionEvidence?: AiAgentExecutionEvidence;
      output?: Record<string, unknown>;
      error?: Record<string, unknown>;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): Promise<AgentTaskStepRow> {
    const result = await this.database.query<AgentTaskStepRow>(
      `
      UPDATE agent_task_steps
      SET
        status = COALESCE($4, status),
        action_intent_id = COALESCE($5, action_intent_id),
        approval_id = COALESCE($6, approval_id),
        execution_record_id = COALESCE($7, execution_record_id),
        output = COALESCE($8::jsonb, output),
        error = COALESCE($9::jsonb, error),
        started_at = COALESCE($10, started_at),
        finished_at = COALESCE($11, finished_at),
        execution_evidence = COALESCE($12::jsonb, execution_evidence),
        version = version + 1
      WHERE
        id = $1
        AND tenant_id = $2
        AND factory_id = $3
      RETURNING ${this.taskStepSelectColumns()}
      `,
      [
        stepId,
        tenantId,
        factoryId,
        fields.status ?? null,
        fields.actionIntentId ?? null,
        fields.approvalId ?? null,
        fields.executionRecordId ?? null,
        fields.output ? JSON.stringify(fields.output) : null,
        fields.error ? JSON.stringify(fields.error) : null,
        fields.startedAt ?? null,
        fields.finishedAt ?? null,
        fields.executionEvidence ? JSON.stringify(fields.executionEvidence) : null,
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException(
        'AI agent task step was not found for this factory',
      );
    }

    return row;
  }

  private async assertDependencies(
    tenantId: string,
    factoryId: string,
    task: AgentTaskRow,
    step: AgentTaskStepRow,
  ): Promise<void> {
    const dependencies = step.depends_on.map(String);
    if (dependencies.length === 0) {
      return;
    }

    const result = await this.database.query<{
      step_key: string;
      status: string;
    }>(
      `
      SELECT step_key, status
      FROM agent_task_steps
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND step_key = ANY($4::text[])
      `,
      [tenantId, factoryId, task.id, dependencies],
      { tenantId },
    );

    const statuses = new Map(
      result.rows.map((row) => [row.step_key, row.status]),
    );

    for (const dependency of dependencies) {
      if (statuses.get(dependency) !== 'SUCCEEDED') {
        throw new ConflictException(
          `AI agent step dependency is not complete: ${dependency}`,
        );
      }
    }
  }

  private assertExecutable(
    task: AgentTaskRow,
    step: AgentTaskStepRow,
  ): void {
    this.assertNotCancelled(this.mapTask(task));
    this.assertDeadline(this.mapTask(task));

    if (
      ![
        'PLAN_READY',
        'AWAITING_AUTH',
        'AWAITING_APPROVAL',
        'EXECUTING',
      ].includes(task.state)
    ) {
      throw new ConflictException(
        `AI agent task cannot execute a step from state ${task.state}`,
      );
    }

    if (step.status === 'CANCELLED') {
      throw new ConflictException('AI agent task step is cancelled');
    }

    if (task.completed_step_count >= task.max_steps) {
      throw new ConflictException(
        'AI agent maximum-step budget has been exceeded',
      );
    }

    if (task.tool_call_count >= task.max_tool_calls) {
      throw new ConflictException(
        'AI agent maximum-tool-call budget has been exceeded',
      );
    }
  }

  private assertNotCancelled(task: AiAgentTask): void {
    if (task.cancelRequestedAt || task.state === 'CANCELLED') {
      throw new ConflictException('AI agent task is cancelled');
    }
  }

  private assertDeadline(task: AiAgentTask): void {
    if (new Date(task.deadlineAt).getTime() <= Date.now()) {
      throw new ConflictException(
        'AI agent task deadline has been exceeded',
      );
    }
  }

  private async countCompletedSteps(
    tenantId: string,
    factoryId: string,
    taskId: string,
  ): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM agent_task_steps
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND status = 'SUCCEEDED'
      `,
      [tenantId, factoryId, taskId],
      { tenantId },
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  private async countSteps(
    tenantId: string,
    factoryId: string,
    taskId: string,
  ): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM agent_task_steps
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
      `,
      [tenantId, factoryId, taskId],
      { tenantId },
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  private async requireTask(
    tenantId: string,
    factoryId: string,
    taskId: string,
  ): Promise<AgentTaskRow> {
    const task = await this.getTaskById(
      tenantId,
      factoryId,
      taskId,
    );

    if (!task) {
      throw new NotFoundException(
        'AI agent task was not found for this factory',
      );
    }

    return task;
  }

  private async getTaskById(
    tenantId: string,
    factoryId: string,
    taskId: string,
  ): Promise<AgentTaskRow | null> {
    const result = await this.database.query<AgentTaskRow>(
      `
      SELECT ${this.taskSelectColumns()}
      FROM agent_tasks
      WHERE tenant_id = $1
        AND factory_id = $2
        AND id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, taskId],
      { tenantId },
    );

    return result.rows[0] ?? null;
  }

  private async getTaskByIdempotencyKey(
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<AgentTaskRow | null> {
    const result = await this.database.query<AgentTaskRow>(
      `
      SELECT ${this.taskSelectColumns()}
      FROM agent_tasks
      WHERE tenant_id = $1
        AND factory_id = $2
        AND idempotency_key = $3
      LIMIT 1
      `,
      [tenantId, factoryId, idempotencyKey],
      { tenantId },
    );

    return result.rows[0] ?? null;
  }

  private async requireStep(
    tenantId: string,
    factoryId: string,
    taskId: string,
    stepId: string,
  ): Promise<AgentTaskStepRow> {
    const result = await this.database.query<AgentTaskStepRow>(
      `
      SELECT ${this.taskStepSelectColumns()}
      FROM agent_task_steps
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND id = $4
      LIMIT 1
      `,
      [tenantId, factoryId, taskId, stepId],
      { tenantId },
    );

    const step = result.rows[0];
    if (!step) {
      throw new NotFoundException(
        'AI agent task step was not found for this factory',
      );
    }

    return step;
  }

  private async getTaskSteps(
    tenantId: string,
    factoryId: string,
    taskId: string,
  ): Promise<AgentTaskStepRow[]> {
    const result = await this.database.query<AgentTaskStepRow>(
      `
      SELECT ${this.taskStepSelectColumns()}
      FROM agent_task_steps
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
      ORDER BY step_index ASC
      `,
      [tenantId, factoryId, taskId],
      { tenantId },
    );

    return result.rows;
  }

  private async getHandoff(
    tenantId: string,
    factoryId: string,
    handoffId: string,
  ): Promise<AiAgentHandoffRecord | null> {
    const result = await this.database.query<AgentHandoffRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        source_agent_id,
        target_agent_id,
        purpose,
        allowed_data_classes,
        permitted_tools,
        expires_at::text AS expires_at,
        parent_trace_id::text AS parent_trace_id,
        expected_artifact,
        handoff_hash,
        status,
        accepted_by::text AS accepted_by,
        accepted_at::text AS accepted_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM agent_handoffs
      WHERE tenant_id = $1
        AND factory_id = $2
        AND id = $3
      LIMIT 1
      `,
      [tenantId, factoryId, handoffId],
      { tenantId },
    );

    return result.rows[0]
      ? this.mapHandoff(result.rows[0])
      : null;
  }

  private async assertHandoffToolEntitlements(
    tenantId: string,
    factoryId: string,
    agentId: string,
    permittedTools: string[],
  ): Promise<void> {
    const normalizedAgentId = this.requiredString(
      agentId,
      'agentId',
      200,
    );

    for (const reference of permittedTools) {
      const { toolId, version } =
        this.parseToolReference(reference);

      await this.aiAgentCatalogueService.assertToolEntitled(
        tenantId,
        factoryId,
        normalizedAgentId,
        toolId,
        version,
      );
    }
  }

  private computeTaskRequestHash(args: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    input: CreateAiAgentTaskInput;
    decisionId: string;
    parentTraceId: string;
    goal: string;
    limits: {
      maxSteps: number;
      maxRetries: number;
      maxToolCalls: number;
      timeoutMs: number;
    };
    deadlineAt: string;
    contextVersion: string | null;
    planVersion: string | null;
    contextHash: string | null;
  }): string {
    const {
      tenantId,
      factoryId,
      actorUserId,
      input,
      decisionId,
      parentTraceId,
      goal,
      limits,
      deadlineAt,
      contextVersion,
      planVersion,
      contextHash,
    } = args;

    return this.computeHash({
      tenantId,
      factoryId,
      actorUserId,
      decisionId,
      parentTraceId,
      goal,
      limits,
      // Do not fingerprint the generated deadline when callers omit it:
      // otherwise an identical retry would hash differently on every attempt.
      requestedDeadlineAt: input.deadlineAt ? deadlineAt : null,
      contextVersion,
      planVersion,
      contextHash,
      steps: input.steps.map((step, index) => ({
        stepKey: step.stepKey.trim(),
        stepIndex: index,
        agentId: step.agentId ?? null,
        capability: step.capability.trim(),
        inputSchema: step.inputSchema ?? {},
        outputSchema: step.outputSchema ?? {},
        toolId: step.toolId.trim(),
        toolVersion: step.toolVersion.trim(),
        actionType: step.actionType.trim(),
        target: step.target ?? {},
        payload: step.payload ?? {},
        resourceType: step.resourceType ?? null,
        resourceId: step.resourceId ?? null,
        riskClass: step.riskClass ?? null,
        timeoutMs: step.timeoutMs ?? 1000,
        retryLimit: step.retryLimit ?? 0,
        authorityLevel: step.authorityLevel?.trim() ?? 'TASK_SCOPED',
        dependsOn: step.dependsOn ?? [],
      })),
    });
  }

  private validateStepDefinition(
    step: AiAgentStepDefinition,
    index: number,
  ): void {
    for (const [field, value] of [
      ['stepKey', step.stepKey],
      ['capability', step.capability],
      ['toolId', step.toolId],
      ['toolVersion', step.toolVersion],
      ['actionType', step.actionType],
    ] as const) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestException(
          `steps[${index}].${field} is required`,
        );
      }
    }

    if (step.actionType.trim() !== step.toolId.trim()) {
      throw new BadRequestException(
        `steps[${index}].actionType must equal steps[${index}].toolId for Tool Gateway execution`,
      );
    }

    if (
      step.target !== undefined &&
      !this.isObject(step.target)
    ) {
      throw new BadRequestException(
        `steps[${index}].target must be an object`,
      );
    }

    if (
      step.payload !== undefined &&
      !this.isObject(step.payload)
    ) {
      throw new BadRequestException(
        `steps[${index}].payload must be an object`,
      );
    }

    if (
      step.inputSchema !== undefined &&
      !this.isObject(step.inputSchema)
    ) {
      throw new BadRequestException(
        `steps[${index}].inputSchema must be an object`,
      );
    }

    if (
      step.outputSchema !== undefined &&
      !this.isObject(step.outputSchema)
    ) {
      throw new BadRequestException(
        `steps[${index}].outputSchema must be an object`,
      );
    }

    if (
      step.timeoutMs !== undefined &&
      (!Number.isInteger(step.timeoutMs) ||
        step.timeoutMs < 100 ||
        step.timeoutMs > 60_000)
    ) {
      throw new BadRequestException(
        `steps[${index}].timeoutMs is outside the bounded range`,
      );
    }

    if (
      step.retryLimit !== undefined &&
      (!Number.isInteger(step.retryLimit) ||
        step.retryLimit < 0 ||
        step.retryLimit > MAX_LIMITS.maxRetries)
    ) {
      throw new BadRequestException(
        `steps[${index}].retryLimit is outside the bounded range`,
      );
    }
  }

  private normalizeLimits(
    input?: Partial<{
      maxSteps: number;
      maxRetries: number;
      maxToolCalls: number;
      timeoutMs: number;
    }>,
  ) {
    const limits = {
      maxSteps: input?.maxSteps ?? DEFAULT_LIMITS.maxSteps,
      maxRetries: input?.maxRetries ?? DEFAULT_LIMITS.maxRetries,
      maxToolCalls:
        input?.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
      timeoutMs: input?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    };

    if (
      !Number.isInteger(limits.maxSteps) ||
      limits.maxSteps < 1 ||
      limits.maxSteps > MAX_LIMITS.maxSteps
    ) {
      throw new BadRequestException(
        'maxSteps is outside the bounded range',
      );
    }

    if (
      !Number.isInteger(limits.maxRetries) ||
      limits.maxRetries < 0 ||
      limits.maxRetries > MAX_LIMITS.maxRetries
    ) {
      throw new BadRequestException(
        'maxRetries is outside the bounded range',
      );
    }

    if (
      !Number.isInteger(limits.maxToolCalls) ||
      limits.maxToolCalls < 1 ||
      limits.maxToolCalls > MAX_LIMITS.maxToolCalls
    ) {
      throw new BadRequestException(
        'maxToolCalls is outside the bounded range',
      );
    }

    if (
      !Number.isInteger(limits.timeoutMs) ||
      limits.timeoutMs < 100 ||
      limits.timeoutMs > MAX_LIMITS.timeoutMs
    ) {
      throw new BadRequestException(
        'timeoutMs is outside the bounded range',
      );
    }

    return limits;
  }

  private resolveDeadline(
    deadlineAt: string | null | undefined,
    timeoutMs: number,
  ): string {
    if (deadlineAt) {
      const normalized = this.futureTimestamp(
        deadlineAt,
        'deadlineAt',
      );
      if (
        new Date(normalized).getTime() >
        Date.now() + timeoutMs
      ) {
        throw new BadRequestException(
          'deadlineAt cannot exceed the configured task timeout window',
        );
      }
      return normalized;
    }

    return new Date(Date.now() + timeoutMs).toISOString();
  }

  private futureTimestamp(
    value: string,
    field: string,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new BadRequestException(
        `${field} must be a valid timestamp`,
      );
    }

    if (date.getTime() <= Date.now()) {
      throw new ConflictException(`${field} has already expired`);
    }

    return date.toISOString();
  }

  private normalizeStrings(
    values: string[],
    field: string,
  ): string[] {
    if (!Array.isArray(values)) {
      throw new BadRequestException(`${field} must be an array`);
    }

    return Array.from(
      new Set(
        values.map((value) => {
          if (
            typeof value !== 'string' ||
            value.trim().length === 0
          ) {
            throw new BadRequestException(
              `${field} must contain only non-empty strings`,
            );
          }
          return value.trim();
        }),
      ),
    );
  }

  private normalizePermittedTools(
    values: string[],
  ): string[] {
    const normalized = this.normalizeStrings(values, 'permittedTools');
    if (normalized.length === 0) {
      throw new BadRequestException(
        'permittedTools must contain at least one TOOL_ID@VERSION entry',
      );
    }

    for (const reference of normalized) {
      this.parseToolReference(reference);
    }

    return normalized;
  }

  private parseToolReference(value: string): {
    toolId: string;
    version: string;
  } {
    const index = value.lastIndexOf('@');
    if (index <= 0 || index === value.length - 1) {
      throw new BadRequestException(
        `permitted tool must use TOOL_ID@VERSION format: ${value}`,
      );
    }

    return {
      toolId: value.slice(0, index).trim(),
      version: value.slice(index + 1).trim(),
    };
  }

  private mapTask(row: AgentTaskRow): AiAgentTask {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      decisionId: row.decision_id,
      parentTraceId: row.parent_trace_id,
      actorUserId: row.actor_user_id,
      goal: row.goal,
      state: row.state,
      maxSteps: row.max_steps,
      maxRetries: row.max_retries,
      maxToolCalls: row.max_tool_calls,
      timeoutMs: row.timeout_ms,
      deadlineAt: row.deadline_at,
      retryCount: row.retry_count,
      toolCallCount: row.tool_call_count,
      completedStepCount: row.completed_step_count,
      currentStepId: row.current_step_id,
      contextVersion: row.context_version,
      planVersion: row.plan_version,
      contextHash: row.context_hash,
      cancelRequestedAt: row.cancel_requested_at,
      failureCode: row.failure_code,
      failureReason: row.failure_reason,
      idempotencyKey: row.idempotency_key,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapStep(row: AgentTaskStepRow): AiAgentTaskStep {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      taskId: row.task_id,
      stepKey: row.step_key,
      stepIndex: row.step_index,
      agentId: row.agent_id,
      capability: row.capability,
      inputSchema: row.input_schema,
      outputSchema: row.output_schema,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      actionType: row.action_type,
      target: row.target,
      payload: row.payload,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      riskClass: row.risk_class,
      timeoutMs: row.timeout_ms,
      retryLimit: row.retry_limit,
      authorityLevel: row.authority_level,
      dependsOn: row.depends_on.map(String),
      status: row.status,
      retryCount: row.retry_count,
      authorizationAttempt: row.authorization_attempt,
      actionIntentId: row.action_intent_id,
      approvalId: row.approval_id,
      executionRecordId: row.execution_record_id,
      executionEvidence:
        row.execution_evidence && Object.keys(row.execution_evidence).length > 0
          ? row.execution_evidence as unknown as AiAgentExecutionEvidence
          : null,
      output: row.output,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapHandoff(row: AgentHandoffRow): AiAgentHandoffRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      sourceAgentId: row.source_agent_id,
      targetAgentId: row.target_agent_id,
      purpose: row.purpose,
      allowedDataClasses: row.allowed_data_classes,
      permittedTools: row.permitted_tools,
      expiresAt: row.expires_at,
      parentTraceId: row.parent_trace_id,
      expectedArtifact: row.expected_artifact,
      handoffHash: row.handoff_hash,
      status: row.status,
      acceptedBy: row.accepted_by,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private taskSelectColumns(): string {
    return `
      id::text AS id,
      tenant_id::text AS tenant_id,
      factory_id::text AS factory_id,
      decision_id::text AS decision_id,
      parent_trace_id::text AS parent_trace_id,
      actor_user_id::text AS actor_user_id,
      goal,
      state,
      max_steps,
      max_retries,
      max_tool_calls,
      timeout_ms,
      deadline_at::text AS deadline_at,
      retry_count,
      tool_call_count,
      completed_step_count,
      current_step_id::text AS current_step_id,
      context_version,
      plan_version,
      context_hash,
      cancel_requested_at::text AS cancel_requested_at,
      failure_code,
      failure_reason,
      idempotency_key,
      request_hash,
      version,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    `;
  }

  private taskStepSelectColumns(): string {
    return `
      id::text AS id,
      tenant_id::text AS tenant_id,
      factory_id::text AS factory_id,
      task_id::text AS task_id,
      step_key,
      step_index,
      agent_id,
      capability,
      input_schema,
      output_schema,
      tool_id,
      tool_version,
      action_type,
      target,
      payload,
      resource_type,
      resource_id,
      risk_class,
      timeout_ms,
      retry_limit,
      authority_level,
      depends_on,
      status,
      retry_count,
      authorization_attempt,
      action_intent_id::text AS action_intent_id,
      approval_id::text AS approval_id,
      execution_record_id::text AS execution_record_id,
      execution_evidence,
      output,
      error,
      started_at::text AS started_at,
      finished_at::text AS finished_at,
      version,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    `;
  }

  private validateScope(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
  ): void {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  private requiredUuid(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }
    this.validateUuid(value, field);
    return value;
  }

  private requiredString(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    const normalized = value.trim();
    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }
    return normalized;
  }

  private optionalString(
    value: string | null | undefined,
    field: string,
    maxLength: number,
  ): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return this.requiredString(value, field, maxLength);
  }

  private requireObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> {
    if (!this.isObject(value)) {
      throw new BadRequestException(`${field} must be an object`);
    }
    return value;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }

  private computeHash(value: unknown): string {
    return createHash('sha256')
      .update(
        JSON.stringify(this.canonicalize(value)),
        'utf8',
      )
      .digest('hex');
  }

  private canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalize(item));
    }

    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, this.canonicalize(object[key])]),
      );
    }

    return value;
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (this.isObject(error) && typeof error.message === 'string') {
      return error.message;
    }

    return 'AI agent operation failed';
  }

  private errorMessageFromRecord(
    error: Record<string, unknown>,
  ): string {
    return typeof error.message === 'string'
      ? error.message
      : JSON.stringify(error);
  }

  private isTerminal(state: AiAgentState): boolean {
    return (
      state === 'COMPLETED' ||
      state === 'BLOCKED' ||
      state === 'FAILED' ||
      state === 'CANCELLED'
    );
  }

  private async audit(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    eventType: string,
    action: string,
    resourceType: string,
    resourceId: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditService.record({
        tenantId,
        factoryId,
        actorUserId,
        eventType,
        action,
        resourceType,
        resourceId,
        correlationId,
        dataClass: 'INTERNAL',
        payload,
      });
    } catch {
      // Task state remains authoritative if audit persistence fails.
    }
  }
}
