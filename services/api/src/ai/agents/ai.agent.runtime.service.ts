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
} from '../tools/ai.tool.types';

import type {
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

    if (step.status === 'SUCCEEDED') {
      return {
        idempotent: true,
        task: this.mapTask(task),
        step: this.mapStep(step),
      };
    }

    this.assertExecutable(task, step);
    await this.assertDependencies(tenantId, factoryId, task, step);

    if (step.agent_id) {
      await this.aiAgentCatalogueService.assertToolEntitled(
        tenantId,
        factoryId,
        step.agent_id,
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

      const { outcome, executionRecordId } =
        await this.executeGovernedTool(
          tenantId,
          factoryId,
          actorUserId,
          actionToken,
          executionKey,
          step.tool_version,
        );

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
            output: outcome.result,
            error: {},
            finishedAt: new Date().toISOString(),
          },
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
            `agent:${task.id}:${step.id}:compensation:${randomUUID()}`,
          token_ttl_seconds: 600,
        },
      );

    const action = authorization.action as Record<string, unknown>;
    if (action.authorizationStatus !== 'AUTHORIZED') {
      throw new ConflictException(
        'Compensation action was not authorized',
      );
    }

    const actionToken = authorization.actionToken;
    if (typeof actionToken !== 'string') {
      throw new ConflictException(
        'Authorized compensation action did not return an action token',
      );
    }

    const compensationStep = {
      ...step,
      tool_id: tool.rollback.toolId,
      tool_version: tool.rollback.toolVersion,
      action_type: tool.rollback.actionType,
      payload: compensationPayload,
    };

    const attemptNumber = await this.nextAttemptNumber(
      tenantId,
      factoryId,
      task.id,
      step.id,
      'COMPENSATION',
    );
    const executionKey =
      `agent:${task.id}:${step.id}:compensation:${attemptNumber}`;

    const { outcome, executionRecordId } =
      await this.executeGovernedTool(
        tenantId,
        factoryId,
        actorUserId,
        actionToken,
        executionKey,
        tool.rollback.toolVersion,
      );

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
      },
    );

    return {
      attempted: true,
      status: outcome.status,
      outcome,
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
    toolVersion: string,
  ) {
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

    return {
      outcome: result.execution,
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
  ): Promise<void> {
    const existing = await this.database.query<{ id: string }>(
      `
      SELECT id::text AS id
      FROM agent_action_attempts
      WHERE
        tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND step_id = $4
        AND attempt_number = $5
        AND attempt_type = $6
      LIMIT 1
      `,
      [
        tenantId,
        factoryId,
        taskId,
        stepId,
        attemptNumber,
        attemptType,
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );

    if (existing.rows[0]) {
      await this.database.query(
        `
        UPDATE agent_action_attempts
        SET
          status = $5,
          execution_record_id = COALESCE($6, execution_record_id),
          error = $7::jsonb,
          finished_at = CASE
            WHEN $5 IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
              THEN NOW()
            ELSE finished_at
          END
        WHERE id = $1 AND tenant_id = $2 AND factory_id = $3
        `,
        [
          existing.rows[0].id,
          tenantId,
          factoryId,
          attemptNumber,
          status,
          executionRecordId ?? null,
          JSON.stringify(error),
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );
      return;
    }

    await this.database.query(
      `
      INSERT INTO agent_action_attempts (
        id,
        tenant_id,
        factory_id,
        task_id,
        step_id,
        attempt_number,
        attempt_type,
        execution_record_id,
        status,
        error,
        finished_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
        CASE
          WHEN $9 IN ('SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')
            THEN NOW()
          ELSE NULL
        END
      )
      `,
      [
        randomUUID(),
        tenantId,
        factoryId,
        taskId,
        stepId,
        attemptNumber,
        attemptType,
        executionRecordId ?? null,
        status,
        JSON.stringify(error),
      ],
      {
        tenantId,
        userId: actorUserId,
      },
    );
  }

  private async nextAttemptNumber(
    tenantId: string,
    factoryId: string,
    taskId: string,
    stepId: string,
    attemptType: 'EXECUTION' | 'COMPENSATION',
  ): Promise<number> {
    const result = await this.database.query<{
      max_number: number | null;
    }>(
      `
      SELECT MAX(attempt_number) AS max_number
      FROM agent_action_attempts
      WHERE tenant_id = $1
        AND factory_id = $2
        AND task_id = $3
        AND step_id = $4
        AND attempt_type = $5
      `,
      [tenantId, factoryId, taskId, stepId, attemptType],
      { tenantId },
    );

    return Number(result.rows[0]?.max_number ?? 0) + 1;
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

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ConflictException(
            `AI agent step execution exceeded timeout of ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
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
