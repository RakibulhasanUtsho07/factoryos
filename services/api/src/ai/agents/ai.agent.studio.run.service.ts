import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../database/database.service';
import { IamService } from '../../iam/iam.service';
import { AiToolRegistryService } from '../tools/ai.tool.registry.service';
import type {
  AiToolDefinition,
  AiToolRiskClass,
} from '../tools/ai.tool.types';
import type {
  AiAgentStudioPlanStep,
  AiAgentStudioSandboxRecord,
  AiAgentStudioSimulationRun,
  AiAgentStudioSpec,
  AiAgentStudioToolSpec,
} from './ai.agent.studio.types';
import type {
  AiAgentStudioExpectedToolCall,
  AiAgentStudioPlanReview,
  AiAgentStudioRunComparison,
  AiAgentStudioRunKind,
  AiAgentStudioRunRecord,
  AiAgentStudioStepInspection,
} from './ai.agent.studio.run.types';

interface SandboxRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  name: string;
  mode: 'SIMULATION';
  agent_spec: AiAgentStudioSpec;
  input_snapshot: Record<string, unknown>;
  policy_snapshot: Record<string, unknown>;
  network_access: 'NONE';
  credentials_access: 'NONE';
  live_write_allowed: false;
  status: AiAgentStudioSandboxRecord['status'];
  created_by: string | null;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SimulationRunRow extends QueryResultRow {
  id: string;
  sandbox_id: string;
  parent_run_id: string | null;
  status: AiAgentStudioSimulationRun['status'];
  plan: AiAgentStudioPlanStep[];
  simulated_tool_responses: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  result: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  created_by: string | null;
  trace_id: string | null;
  created_at: string;
}

const RISK_ORDER: Record<AiToolRiskClass, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

@Injectable()
export class AiAgentStudioRunService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly toolRegistry: AiToolRegistryService,
  ) {}

  async getRun(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sandboxId: string,
    runId: string,
  ): Promise<AiAgentStudioRunRecord> {
    await this.authorizeRead(actorUserId, tenantId, factoryId);
    this.validateUuid(sandboxId, 'sandboxId');
    this.validateUuid(runId, 'runId');

    const scope = await this.loadSandboxScope(
      tenantId,
      factoryId,
      sandboxId,
    );
    const simulation = await this.loadRun(
      tenantId,
      factoryId,
      sandboxId,
      runId,
    );
    const planReview = await this.buildPlanReview(
      scope.agentSpec,
      simulation.plan,
      tenantId,
      factoryId,
    );

    return {
      sandbox: scope.sandbox,
      simulation,
      runKind: this.resolveRunKind(simulation.result),
      planReview,
    };
  }

  async inspectStep(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sandboxId: string,
    runId: string,
    stepIndex: number,
  ): Promise<AiAgentStudioStepInspection> {
    await this.authorizeRead(actorUserId, tenantId, factoryId);
    this.validateUuid(sandboxId, 'sandboxId');
    this.validateUuid(runId, 'runId');
    this.validateStepIndex(stepIndex, 'stepIndex');

    const scope = await this.loadSandboxScope(
      tenantId,
      factoryId,
      sandboxId,
    );
    const simulation = await this.loadRun(
      tenantId,
      factoryId,
      sandboxId,
      runId,
    );
    const step = simulation.plan[stepIndex];

    if (!step) {
      throw new NotFoundException(
        `Simulation step not found: ${stepIndex}`,
      );
    }

    const planReview = await this.buildPlanReview(
      scope.agentSpec,
      simulation.plan,
      tenantId,
      factoryId,
    );
    const expectedToolCall = planReview.expectedToolCalls[stepIndex];
    const observation = simulation.observations.find(
      (item) => Number(item.stepIndex) === stepIndex,
    ) ?? null;
    const reference = `${step.toolId}@${step.toolVersion}`;

    return {
      sandboxId,
      simulationRunId: runId,
      stepIndex,
      step,
      observation,
      simulatedResponse:
        simulation.simulatedToolResponses[reference],
      expectedToolCall,
    };
  }

  async replayRun(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sandboxId: string,
    sourceRunId: string,
    fromStepIndex = 0,
    toStepIndex?: number,
  ): Promise<AiAgentStudioRunRecord> {
    await this.authorizeWrite(actorUserId, tenantId, factoryId);
    this.validateUuid(sandboxId, 'sandboxId');
    this.validateUuid(sourceRunId, 'sourceRunId');
    this.validateStepIndex(fromStepIndex, 'fromStepIndex');

    const scope = await this.loadSandboxScope(
      tenantId,
      factoryId,
      sandboxId,
    );
    const source = await this.loadRun(
      tenantId,
      factoryId,
      sandboxId,
      sourceRunId,
    );

    const endIndex =
      toStepIndex === undefined
        ? source.plan.length - 1
        : toStepIndex;

    this.validateStepIndex(endIndex, 'toStepIndex');

    if (fromStepIndex > endIndex) {
      throw new BadRequestException(
        'fromStepIndex must be less than or equal to toStepIndex',
      );
    }

    if (endIndex >= source.plan.length) {
      throw new BadRequestException(
        `toStepIndex ${endIndex} exceeds source plan length ${source.plan.length}`,
      );
    }

    const plan = source.plan.slice(fromStepIndex, endIndex + 1);
    const simulatedToolResponses = this.pickResponses(
      plan,
      source.simulatedToolResponses,
    );
    const planReview = await this.buildPlanReview(
      scope.agentSpec,
      plan,
      tenantId,
      factoryId,
    );
    const observations = source.observations
      .filter((item) => {
        const index = Number(item.stepIndex);
        return index >= fromStepIndex && index <= endIndex;
      })
      .map((item, index) => ({
        ...item,
        stepIndex: index,
        replayedFromRunId: sourceRunId,
      }));
    const missingResponses = this.missingResponses(
      plan,
      simulatedToolResponses,
    );
    const status: AiAgentStudioSimulationRun['status'] =
      missingResponses.length === 0 ? 'COMPLETED' : 'BLOCKED';
    const result = {
      outcome:
        missingResponses.length === 0
          ? 'REPLAY_COMPLETE'
          : 'REPLAY_INCOMPLETE',
      runKind: 'REPLAY' satisfies AiAgentStudioRunKind,
      parentRunId: sourceRunId,
      replayRange: {
        fromStepIndex,
        toStepIndex: endIndex,
      },
      expectedToolCalls: planReview.expectedToolCalls,
      missingSimulatedResponses: missingResponses,
      liveExecution: false,
      liveWriteBlocked: true,
      networkAccess: 'NONE',
      credentialsAccess: 'NONE',
    } satisfies Record<string, unknown>;

    const simulation = await this.insertChildRun({
      tenantId,
      factoryId,
      sandboxId,
      parentRunId: sourceRunId,
      status,
      plan,
      simulatedToolResponses,
      observations,
      result,
      actorUserId,
      traceId: source.traceId ?? scope.sandbox.traceId,
    });

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      action: 'SIMULATION_REPLAY',
      resourceType: 'AI_AGENT_SIMULATION_RUN',
      resourceId: simulation.id,
      payload: {
        parentRunId: sourceRunId,
        fromStepIndex,
        toStepIndex: endIndex,
        status,
      },
    });

    return {
      sandbox: scope.sandbox,
      simulation,
      runKind: 'REPLAY',
      planReview,
    };
  }

  async branchRun(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sandboxId: string,
    sourceRunId: string,
    branchFromStepIndex: number,
    plan: AiAgentStudioPlanStep[],
    simulatedToolResponses: Record<string, unknown>,
  ): Promise<AiAgentStudioRunRecord> {
    await this.authorizeWrite(actorUserId, tenantId, factoryId);
    this.validateUuid(sandboxId, 'sandboxId');
    this.validateUuid(sourceRunId, 'sourceRunId');
    this.validateStepIndex(
      branchFromStepIndex,
      'branchFromStepIndex',
    );

    const scope = await this.loadSandboxScope(
      tenantId,
      factoryId,
      sandboxId,
    );
    const source = await this.loadRun(
      tenantId,
      factoryId,
      sandboxId,
      sourceRunId,
    );

    if (branchFromStepIndex >= source.plan.length) {
      throw new BadRequestException(
        `branchFromStepIndex ${branchFromStepIndex} exceeds source plan length ${source.plan.length}`,
      );
    }

    if (!Array.isArray(plan) || plan.length === 0) {
      throw new BadRequestException(
        'Branch plan must contain at least one step',
      );
    }

    if (plan.length > 100) {
      throw new BadRequestException(
        'Branch plan must contain at most 100 steps',
      );
    }

    const normalizedPlan = plan.map((step, index) =>
      this.normalizePlanStep(step, `plan[${index}]`),
    );
    const normalizedResponses = this.normalizeObject(
      simulatedToolResponses,
      'simulatedToolResponses',
    );
    const planReview = await this.buildPlanReview(
      scope.agentSpec,
      normalizedPlan,
      tenantId,
      factoryId,
    );
    const missingResponses = this.missingResponses(
      normalizedPlan,
      normalizedResponses,
    );
    const status: AiAgentStudioSimulationRun['status'] =
      missingResponses.length === 0 ? 'COMPLETED' : 'BLOCKED';
    const observations = normalizedPlan.map((step, index) => {
      const reference = `${step.toolId}@${step.toolVersion}`;
      return {
        stepIndex: index,
        stepKey: step.stepKey,
        toolId: step.toolId,
        toolVersion: step.toolVersion,
        actionType: step.actionType,
        simulated: true,
        liveExecution: false,
        responseProvided: normalizedResponses[reference] !== undefined,
        branchedFromRunId: sourceRunId,
        branchFromStepIndex,
      };
    });
    const result = {
      outcome:
        missingResponses.length === 0
          ? 'BRANCH_COMPLETE'
          : 'BRANCH_INCOMPLETE',
      runKind: 'BRANCH' satisfies AiAgentStudioRunKind,
      parentRunId: sourceRunId,
      branchFromStepIndex,
      expectedToolCalls: planReview.expectedToolCalls,
      missingSimulatedResponses: missingResponses,
      liveExecution: false,
      liveWriteBlocked: true,
      networkAccess: 'NONE',
      credentialsAccess: 'NONE',
    } satisfies Record<string, unknown>;

    const simulation = await this.insertChildRun({
      tenantId,
      factoryId,
      sandboxId,
      parentRunId: sourceRunId,
      status,
      plan: normalizedPlan,
      simulatedToolResponses: normalizedResponses,
      observations,
      result,
      actorUserId,
      traceId: source.traceId ?? scope.sandbox.traceId,
    });

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      action: 'SIMULATION_BRANCH',
      resourceType: 'AI_AGENT_SIMULATION_RUN',
      resourceId: simulation.id,
      payload: {
        parentRunId: sourceRunId,
        branchFromStepIndex,
        status,
        planStepCount: normalizedPlan.length,
      },
    });

    return {
      sandbox: scope.sandbox,
      simulation,
      runKind: 'BRANCH',
      planReview,
    };
  }

  async compareRuns(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sandboxId: string,
    leftRunId: string,
    rightRunId: string,
  ): Promise<AiAgentStudioRunComparison> {
    await this.authorizeRead(actorUserId, tenantId, factoryId);
    this.validateUuid(sandboxId, 'sandboxId');
    this.validateUuid(leftRunId, 'leftRunId');
    this.validateUuid(rightRunId, 'rightRunId');

    if (leftRunId === rightRunId) {
      throw new BadRequestException(
        'leftRunId and rightRunId must be different',
      );
    }

    const [left, right] = await Promise.all([
      this.loadRun(
        tenantId,
        factoryId,
        sandboxId,
        leftRunId,
      ),
      this.loadRun(
        tenantId,
        factoryId,
        sandboxId,
        rightRunId,
      ),
    ]);

    const maxLength = Math.max(
      left.plan.length,
      right.plan.length,
    );
    const differences = [];

    for (let index = 0; index < maxLength; index += 1) {
      const leftStep = left.plan[index] ?? null;
      const rightStep = right.plan[index] ?? null;

      if (!leftStep && rightStep) {
        differences.push({
          index,
          left: null,
          right: rightStep,
          change: 'ADDED' as const,
        });
        continue;
      }

      if (leftStep && !rightStep) {
        differences.push({
          index,
          left: leftStep,
          right: null,
          change: 'REMOVED' as const,
        });
        continue;
      }

      if (
        JSON.stringify(leftStep) !==
        JSON.stringify(rightStep)
      ) {
        differences.push({
          index,
          left: leftStep,
          right: rightStep,
          change: 'CHANGED' as const,
        });
      }
    }

    return {
      sandboxId,
      leftRunId,
      rightRunId,
      samePlan: differences.length === 0,
      leftStepCount: left.plan.length,
      rightStepCount: right.plan.length,
      changedStepCount: differences.length,
      differences,
      leftOutcome: left.result,
      rightOutcome: right.result,
    };
  }

  private async authorizeRead(
    actorUserId: string,
    tenantId: string,
    factoryId: string,
  ): Promise<void> {
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.read',
      factoryId,
    );
  }

  private async authorizeWrite(
    actorUserId: string,
    tenantId: string,
    factoryId: string,
  ): Promise<void> {
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.write',
      factoryId,
    );
  }

  private async loadSandboxScope(
    tenantId: string,
    factoryId: string,
    sandboxId: string,
  ): Promise<{ sandbox: AiAgentStudioSandboxRecord; agentSpec: AiAgentStudioSpec }> {
    const result = await this.database.query<SandboxRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        name,
        mode,
        agent_spec,
        input_snapshot,
        policy_snapshot,
        network_access,
        credentials_access,
        live_write_allowed,
        status,
        created_by::text AS created_by,
        trace_id::text AS trace_id,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM agent_sandboxes
      WHERE id = $1
        AND tenant_id = $2
        AND factory_id = $3
      LIMIT 1
      `,
      [sandboxId, tenantId, factoryId],
      { tenantId },
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException(
        `Agent Studio sandbox not found: ${sandboxId}`,
      );
    }

    if (
      row.mode !== 'SIMULATION' ||
      row.network_access !== 'NONE' ||
      row.credentials_access !== 'NONE' ||
      row.live_write_allowed !== false
    ) {
      throw new ForbiddenException(
        'Sandbox safety invariant is not satisfied',
      );
    }

    return {
      sandbox: {
        id: row.id,
        tenantId: row.tenant_id,
        factoryId: row.factory_id,
        name: row.name,
        mode: row.mode,
        agentSpec: row.agent_spec,
        inputSnapshot: row.input_snapshot,
        policySnapshot: row.policy_snapshot,
        networkAccess: row.network_access,
        credentialsAccess: row.credentials_access,
        liveWriteAllowed: false,
        status: row.status,
        createdBy: row.created_by,
        traceId: row.trace_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      agentSpec: row.agent_spec,
    };
  }

  private async loadRun(
    tenantId: string,
    factoryId: string,
    sandboxId: string,
    runId: string,
  ): Promise<AiAgentStudioSimulationRun> {
    const result = await this.database.query<SimulationRunRow>(
      `
      SELECT
        id::text AS id,
        sandbox_id::text AS sandbox_id,
        parent_run_id::text AS parent_run_id,
        status,
        plan,
        simulated_tool_responses,
        observations,
        result,
        started_at::text AS started_at,
        finished_at::text AS finished_at,
        created_by::text AS created_by,
        trace_id::text AS trace_id,
        created_at::text AS created_at
      FROM simulation_runs
      WHERE id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND sandbox_id = $4
      LIMIT 1
      `,
      [runId, tenantId, factoryId, sandboxId],
      { tenantId },
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException(
        `Simulation run not found: ${runId}`,
      );
    }

    return this.mapSimulation(row);
  }

  private async buildPlanReview(
    agentSpec: AiAgentStudioSpec,
    plan: AiAgentStudioPlanStep[],
    tenantId: string,
    factoryId: string,
  ): Promise<AiAgentStudioPlanReview> {
    const expectedToolCalls: AiAgentStudioExpectedToolCall[] = [];

    for (const [stepIndex, step] of plan.entries()) {
      const tool = await this.resolveAndValidatePlanTool(
        agentSpec,
        step,
        tenantId,
        factoryId,
      );

      expectedToolCalls.push({
        stepIndex,
        stepKey: step.stepKey,
        toolId: step.toolId,
        toolVersion: step.toolVersion,
        actionType: step.actionType,
        riskClass: tool.riskClass,
        requiredScopes: [...tool.requiredScopes],
        writeCapable: tool.writeCapable,
        approvalMode: String(tool.approvalMode),
        rollbackType: tool.rollback.type,
        dataAccessScopes: [...tool.requiredScopes],
        sideEffect: tool.writeCapable ? 'WRITE' : 'NONE',
        approvalPoint:
          String(tool.approvalMode).toUpperCase() !== 'NONE',
        input: step.input,
      });
    }

    return {
      agentId: agentSpec.agentId,
      agentVersion: agentSpec.version,
      riskCeiling: agentSpec.riskCeiling,
      executionScopes: [...agentSpec.executionScopes],
      expectedToolCalls,
      totalSteps: plan.length,
      totalToolCalls: plan.length,
      hasSideEffects: expectedToolCalls.some(
        (item) => item.sideEffect !== 'NONE',
      ),
      approvalPoints: expectedToolCalls
        .filter((item) => item.approvalPoint)
        .map((item) => item.stepIndex),
    };
  }

  private async resolveAndValidatePlanTool(
    agentSpec: AiAgentStudioSpec,
    step: AiAgentStudioPlanStep,
    tenantId: string,
    factoryId: string,
  ): Promise<AiToolDefinition> {
    const declared = agentSpec.tools.find(
      (item) =>
        item.toolId === step.toolId &&
        item.version === step.toolVersion,
    );

    if (!declared) {
      throw new ForbiddenException(
        `Sandbox plan uses a tool that is not declared in the agent spec: ${step.toolId}@${step.toolVersion}`,
      );
    }

    if (declared.actionType !== step.actionType) {
      throw new BadRequestException(
        `Sandbox plan action type does not match the declared tool spec: ${step.toolId}@${step.toolVersion}`,
      );
    }

    const tool = await this.toolRegistry.getTool(
      tenantId,
      factoryId,
      step.toolId,
      step.toolVersion,
    );

    const agentRisk = RISK_ORDER[agentSpec.riskCeiling];
    const toolRisk = RISK_ORDER[tool.riskClass];

    if (toolRisk > agentRisk) {
      throw new ForbiddenException(
        `Sandbox tool risk ${tool.riskClass} exceeds agent risk ceiling ${agentSpec.riskCeiling}`,
      );
    }

    const allowedScopes = new Set(agentSpec.executionScopes);
    const missingScopes = tool.requiredScopes.filter(
      (scope) => !allowedScopes.has(scope),
    );

    if (missingScopes.length > 0) {
      throw new ForbiddenException(
        `Sandbox agent execution scopes do not permit ${tool.toolId}@${tool.version}; missing scopes: ${missingScopes.join(', ')}`,
      );
    }

    if (tool.writeCapable) {
      throw new ForbiddenException(
        `Live write-capable tool is prohibited in sandbox simulation: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      String(tool.approvalMode).toUpperCase() !== 'NONE'
    ) {
      throw new ForbiddenException(
        `Approval-bound live tool is prohibited in sandbox simulation: ${tool.toolId}@${tool.version}`,
      );
    }

    return tool;
  }

  private async insertChildRun(input: {
    tenantId: string;
    factoryId: string;
    sandboxId: string;
    parentRunId: string;
    status: AiAgentStudioSimulationRun['status'];
    plan: AiAgentStudioPlanStep[];
    simulatedToolResponses: Record<string, unknown>;
    observations: Array<Record<string, unknown>>;
    result: Record<string, unknown>;
    actorUserId: string;
    traceId: string | null;
  }): Promise<AiAgentStudioSimulationRun> {
    return this.database.transaction(
      async (client) => {
        const result = await client.query<SimulationRunRow>(
          `
          INSERT INTO simulation_runs (
            tenant_id,
            factory_id,
            sandbox_id,
            parent_run_id,
            mode,
            status,
            plan,
            simulated_tool_responses,
            observations,
            result,
            finished_at,
            created_by,
            trace_id
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'SIMULATION',
            $5,
            $6::jsonb,
            $7::jsonb,
            $8::jsonb,
            $9::jsonb,
            NOW(),
            $10,
            $11
          )
          RETURNING
            id::text AS id,
            sandbox_id::text AS sandbox_id,
            parent_run_id::text AS parent_run_id,
            status,
            plan,
            simulated_tool_responses,
            observations,
            result,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            created_by::text AS created_by,
            trace_id::text AS trace_id,
            created_at::text AS created_at
          `,
          [
            input.tenantId,
            input.factoryId,
            input.sandboxId,
            input.parentRunId,
            input.status,
            JSON.stringify(input.plan),
            JSON.stringify(input.simulatedToolResponses),
            JSON.stringify(input.observations),
            JSON.stringify(input.result),
            input.actorUserId,
            input.traceId,
          ],
        );

        const row = result.rows[0];

        if (!row) {
          throw new BadRequestException(
            'AI agent simulation child run insert returned no row',
          );
        }

        return this.mapSimulation(row);
      },
      {
        tenantId: input.tenantId,
        userId: input.actorUserId,
      },
    );
  }

  private mapSimulation(row: SimulationRunRow): AiAgentStudioSimulationRun {
    return {
      id: row.id,
      sandboxId: row.sandbox_id,
      parentRunId: row.parent_run_id,
      status: row.status,
      plan: row.plan,
      simulatedToolResponses: row.simulated_tool_responses,
      observations: row.observations,
      result: row.result,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdBy: row.created_by,
      traceId: row.trace_id,
      createdAt: row.created_at,
    };
  }

  private resolveRunKind(
    result: Record<string, unknown>,
  ): AiAgentStudioRunKind {
    const runKind = result.runKind;

    if (
      runKind === 'REPLAY' ||
      runKind === 'BRANCH'
    ) {
      return runKind;
    }

    return 'ORIGINAL';
  }

  private pickResponses(
    plan: AiAgentStudioPlanStep[],
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const picked: Record<string, unknown> = {};

    for (const step of plan) {
      const reference = `${step.toolId}@${step.toolVersion}`;
      if (source[reference] !== undefined) {
        picked[reference] = source[reference];
      }
    }

    return picked;
  }

  private missingResponses(
    plan: AiAgentStudioPlanStep[],
    responses: Record<string, unknown>,
  ): string[] {
    return plan
      .map((step) => `${step.toolId}@${step.toolVersion}`)
      .filter((reference) => responses[reference] === undefined);
  }

  private normalizePlanStep(
    value: AiAgentStudioPlanStep,
    field: string,
  ): AiAgentStudioPlanStep {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException(`${field} must be an object`);
    }

    return {
      stepKey: this.requiredString(value.stepKey, `${field}.stepKey`, 200),
      toolId: this.requiredString(value.toolId, `${field}.toolId`, 200),
      toolVersion: this.requiredString(
        value.toolVersion,
        `${field}.toolVersion`,
        100,
      ),
      actionType: this.requiredString(
        value.actionType,
        `${field}.actionType`,
        200,
      ),
      input: this.normalizeObject(value.input, `${field}.input`) ?? {},
    };
  }

  private normalizeObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an object`);
    }

    return value as Record<string, unknown>;
  }

  private requiredString(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim();

    if (!normalized) {
      throw new BadRequestException(`${field} is required`);
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private validateStepIndex(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 99) {
      throw new BadRequestException(
        `${field} must be an integer between 0 and 99`,
      );
    }
  }

  private async safeAudit(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.actorUserId,
        eventType: 'AI_AGENT_STUDIO_RUN',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Simulation state remains authoritative when audit persistence fails.
    }
  }
}
