import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

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
  AiToolRegistryService,
} from '../tools/ai.tool.registry.service';

import type {
  AiToolDefinition,
  AiToolRiskClass,
} from '../tools/ai.tool.types';

import type {
  AiAgentStudioPlanStep,
  AiAgentStudioSimulationRun,
  AiAgentStudioSandboxStatus,
  AiAgentStudioSpec,
  AiAgentStudioToolSpec,
  CreateAiAgentStudioSandboxInput,
  AiAgentStudioSandboxRecord,
} from './ai.agent.studio.types';

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
  status: AiAgentStudioSandboxStatus;
  created_by: string | null;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SimulationRunRow extends QueryResultRow {
  id: string;
  sandbox_id: string;
  parent_run_id: string | null;
  status: 'COMPLETED' | 'FAILED' | 'BLOCKED';
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
export class AiAgentStudioService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly toolRegistry: AiToolRegistryService,
  ) {}

  async createSandbox(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiAgentStudioSandboxInput,
  ): Promise<{
    sandbox: AiAgentStudioSandboxRecord;
    simulation: AiAgentStudioSimulationRun;
  }> {
    this.requiredUuid(tenantId, 'tenantId');
    this.requiredUuid(factoryId, 'factoryId');
    this.requiredUuid(actorUserId, 'actorUserId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.write',
      factoryId,
    );

    const normalized = this.normalizeInput(input);

    const toolsByReference = new Map<string, AiToolDefinition>();

    for (const toolSpec of normalized.agentSpec.tools) {
      const tool = await this.toolRegistry.getTool(
        tenantId,
        factoryId,
        toolSpec.toolId,
        toolSpec.version,
      );

      this.assertSandboxToolAllowed(
        normalized.agentSpec,
        toolSpec,
        tool,
      );

      toolsByReference.set(
        `${toolSpec.toolId}@${toolSpec.version}`,
        tool,
      );
    }

    for (const step of normalized.plan) {
      const reference =
        `${step.toolId}@${step.toolVersion}`;

      const tool = toolsByReference.get(reference);

      if (!tool) {
        throw new ForbiddenException(
          `Sandbox plan uses a tool that is not declared in the agent spec: ${reference}`,
        );
      }

      if (step.actionType !== toolSpecActionType(
        normalized.agentSpec.tools,
        step.toolId,
        step.toolVersion,
      )) {
        throw new BadRequestException(
          `Sandbox plan action type does not match the declared tool spec: ${reference}`,
        );
      }
    }

    const simulatedToolResponses =
      normalized.simulatedToolResponses ?? {};

    const observations = normalized.plan.map(
      (step, index) => {
        const reference =
          `${step.toolId}@${step.toolVersion}`;

        const simulated =
          simulatedToolResponses[reference];

        return {
          stepIndex: index,
          stepKey: step.stepKey,
          toolId: step.toolId,
          toolVersion: step.toolVersion,
          actionType: step.actionType,
          simulated: true,
          liveExecution: false,
          responseProvided:
            simulated !== undefined,
        };
      },
    );

    const missingResponses = observations
      .filter((item) => !item.responseProvided)
      .map((item) =>
        `${String(item.toolId)}@${String(item.toolVersion)}`,
      );

    const result = {
      outcome:
        missingResponses.length === 0
          ? 'SIMULATION_COMPLETE'
          : 'SIMULATION_INCOMPLETE',
      liveExecution: false,
      liveWriteBlocked: true,
      networkAccess: 'NONE',
      credentialsAccess: 'NONE',
      expectedToolCalls: normalized.plan.map(
        (step) => ({
          stepKey: step.stepKey,
          toolId: step.toolId,
          toolVersion: step.toolVersion,
          actionType: step.actionType,
        }),
      ),
      missingSimulatedResponses:
        missingResponses,
    };

    const status: 'COMPLETED' | 'BLOCKED' =
      missingResponses.length === 0
        ? 'COMPLETED'
        : 'BLOCKED';

    const persisted = await this.database.transaction(
      async (client) => {
        const sandboxResult =
          await client.query<SandboxRow>(
            `
            INSERT INTO agent_sandboxes (
              tenant_id,
              factory_id,
              name,
              mode,
              agent_spec,
              input_snapshot,
              policy_snapshot,
              network_access,
              credentials_access,
              live_write_allowed,
              status,
              created_by,
              trace_id
            )
            VALUES (
              $1,
              $2,
              $3,
              'SIMULATION',
              $4::jsonb,
              $5::jsonb,
              $6::jsonb,
              'NONE',
              'NONE',
              FALSE,
              $9,
              $7,
              $8
            )
            RETURNING
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
            `,
            [
              tenantId,
              factoryId,
              normalized.name,
              JSON.stringify(normalized.agentSpec),
              JSON.stringify(normalized.inputSnapshot),
              JSON.stringify(normalized.policySnapshot),
              actorUserId,
              normalized.traceId,
              status,
            ],
          );

        const sandbox =
          sandboxResult.rows[0];

        if (!sandbox) {
          throw new Error(
            'AI_AGENT_SANDBOX_INSERT_FAILED',
          );
        }

        const simulationResult =
          await client.query<SimulationRunRow>(
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
              NULL,
              'SIMULATION',
              $4,
              $5::jsonb,
              $6::jsonb,
              $7::jsonb,
              $8::jsonb,
              NOW(),
              $9,
              $10
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
              tenantId,
              factoryId,
              sandbox.id,
              status,
              JSON.stringify(normalized.plan),
              JSON.stringify(
                normalized.simulatedToolResponses,
              ),
              JSON.stringify(observations),
              JSON.stringify(result),
              actorUserId,
              normalized.traceId,
            ],
          );

        const simulation =
          simulationResult.rows[0];

        if (!simulation) {
          throw new Error(
            'AI_AGENT_SIMULATION_RUN_INSERT_FAILED',
          );
        }

        return {
          sandbox,
          simulation,
        };
      },
      {
        tenantId,
        userId: actorUserId,
      },
    );

    const mappedSandbox =
      this.mapSandbox(persisted.sandbox);

    const mappedSimulation =
      this.mapSimulation(persisted.simulation);

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      action: 'SANDBOX_CREATE',
      resourceType: 'AI_AGENT_SANDBOX',
      resourceId: mappedSandbox.id,
      payload: {
        simulationRunId: mappedSimulation.id,
        status,
        liveExecution: false,
        liveWriteBlocked: true,
        toolCount: normalized.agentSpec.tools.length,
        stepCount: normalized.plan.length,
      },
    });

    return {
      sandbox: mappedSandbox,
      simulation: mappedSimulation,
    };
  }

  private normalizeInput(
    input: CreateAiAgentStudioSandboxInput,
  ) {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException(
        'Agent sandbox input is required',
      );
    }

    const name = this.requiredString(
      input.name,
      'name',
      200,
    );

    const traceId = this.requiredUuid(
      input.traceId,
      'traceId',
    );

    const agentSpec = input.agentSpec;

    if (!agentSpec || typeof agentSpec !== 'object') {
      throw new BadRequestException(
        'agentSpec is required',
      );
    }

    const riskCeiling =
      agentSpec.riskCeiling;

    if (!(riskCeiling in RISK_ORDER)) {
      throw new BadRequestException(
        'agentSpec.riskCeiling must be one of L0, L1, L2, L3, L4',
      );
    }

    const executionScopes =
      this.normalizeStrings(
        agentSpec.executionScopes,
        'agentSpec.executionScopes',
        100,
        200,
      );

    const tools =
      Array.isArray(agentSpec.tools)
        ? agentSpec.tools.map(
            (tool) =>
              this.normalizeToolSpec(tool),
          )
        : [];

    if (tools.length === 0) {
      throw new BadRequestException(
        'agentSpec.tools must contain at least one tool',
      );
    }

    const plan =
      Array.isArray(input.plan)
        ? input.plan.map(
            (step) =>
              this.normalizePlanStep(step),
          )
        : [];

    if (plan.length === 0) {
      throw new BadRequestException(
        'plan must contain at least one step',
      );
    }

    if (
      plan.length >
      100
    ) {
      throw new BadRequestException(
        'plan must contain at most 100 steps',
      );
    }

    return {
      name,
      traceId,
      agentSpec: {
        agentId: this.requiredString(
          agentSpec.agentId,
          'agentSpec.agentId',
          200,
        ),
        version: this.requiredString(
          agentSpec.version,
          'agentSpec.version',
          100,
        ),
        goal: this.requiredString(
          agentSpec.goal,
          'agentSpec.goal',
          2000,
        ),
        riskCeiling,
        executionScopes,
        tools,
        memory: this.normalizeObject(
          agentSpec.memory,
          'agentSpec.memory',
        ),
        policies: this.normalizeObject(
          agentSpec.policies,
          'agentSpec.policies',
        ),
        prompts: this.normalizeObject(
          agentSpec.prompts,
          'agentSpec.prompts',
        ),
        completionCriteria:
          this.normalizeObject(
            agentSpec.completionCriteria,
            'agentSpec.completionCriteria',
          ),
      } satisfies AiAgentStudioSpec,
      inputSnapshot:
        this.normalizeObject(
          input.inputSnapshot,
          'inputSnapshot',
        ),
      policySnapshot:
        this.normalizeObject(
          input.policySnapshot,
          'policySnapshot',
        ),
      plan,
      simulatedToolResponses:
        this.normalizeObject(
          input.simulatedToolResponses,
          'simulatedToolResponses',
        ),
    };
  }

  private normalizeToolSpec(
    value: AiAgentStudioToolSpec,
  ): AiAgentStudioToolSpec {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException(
        'agentSpec.tools must contain objects',
      );
    }

    return {
      toolId: this.requiredString(
        value.toolId,
        'tool.toolId',
        200,
      ),
      version: this.requiredString(
        value.version,
        'tool.version',
        100,
      ),
      actionType: this.requiredString(
        value.actionType,
        'tool.actionType',
        200,
      ),
    };
  }

  private normalizePlanStep(
    value: AiAgentStudioPlanStep,
  ): AiAgentStudioPlanStep {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException(
        'plan must contain objects',
      );
    }

    return {
      stepKey: this.requiredString(
        value.stepKey,
        'plan.stepKey',
        200,
      ),
      toolId: this.requiredString(
        value.toolId,
        'plan.toolId',
        200,
      ),
      toolVersion: this.requiredString(
        value.toolVersion,
        'plan.toolVersion',
        100,
      ),
      actionType: this.requiredString(
        value.actionType,
        'plan.actionType',
        200,
      ),
      input: this.normalizeObject(
        value.input,
        'plan.input',
      ) ?? {},
    };
  }

  private assertSandboxToolAllowed(
    agentSpec: AiAgentStudioSpec,
    toolSpec: AiAgentStudioToolSpec,
    tool: AiToolDefinition,
  ): void {
    const agentRisk =
      RISK_ORDER[agentSpec.riskCeiling];

    const toolRisk =
      RISK_ORDER[tool.riskClass];

    if (toolRisk > agentRisk) {
      throw new ForbiddenException(
        `Sandbox tool risk ${tool.riskClass} exceeds agent risk ceiling ${agentSpec.riskCeiling}`,
      );
    }

    const allowedScopes =
      new Set(agentSpec.executionScopes);

    const missingScopes =
      tool.requiredScopes.filter(
        (scope) =>
          !allowedScopes.has(scope),
      );

    if (missingScopes.length > 0) {
      throw new ForbiddenException(
        `Sandbox agent execution scopes do not permit ${tool.toolId}@${tool.version}; missing scopes: ${missingScopes.join(', ')}`,
      );
    }

    if (tool.writeCapable) {
      throw new ForbiddenException(
        `Live write-capable tool is prohibited in sandbox simulation: ${toolSpec.toolId}@${toolSpec.version}`,
      );
    }

    if (tool.approvalMode !== 'none' && tool.approvalMode !== 'NONE') {
      throw new ForbiddenException(
        `Approval-bound live tool is prohibited in sandbox simulation: ${toolSpec.toolId}@${toolSpec.version}`,
      );
    }
  }

  private normalizeStrings(
    value: string[],
    field: string,
    maxItems: number,
    maxLength: number,
  ): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(
        `${field} must be an array`,
      );
    }

    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const [index, raw] of value.entries()) {
      if (typeof raw !== 'string') {
        throw new BadRequestException(
          `${field}[${index}] must be a string`,
        );
      }

      const item = raw.trim();

      if (!item) {
        throw new BadRequestException(
          `${field}[${index}] must not be empty`,
        );
      }

      if (item.length > maxLength) {
        throw new BadRequestException(
          `${field}[${index}] must not exceed ${maxLength} characters`,
        );
      }

      if (!seen.has(item)) {
        seen.add(item);
        normalized.push(item);
      }
    }

    if (normalized.length > maxItems) {
      throw new BadRequestException(
        `${field} must contain at most ${maxItems} unique items`,
      );
    }

    return normalized;
  }

  private normalizeObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> | undefined {
    if (value === undefined || value === null) {
      return {};
    }

    if (
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      throw new BadRequestException(
        `${field} must be an object`,
      );
    }

    return value as Record<string, unknown>;
  }

  private requiredUuid(
    value: unknown,
    field: string,
  ): string {
    if (typeof value !== 'string' || !isUUID(value)) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }

    return value;
  }

  private requiredString(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    const normalized = value.trim();

    if (!normalized) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private mapSandbox(
    row: SandboxRow,
  ): AiAgentStudioSandboxRecord {
    return {
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
    };
  }

  private mapSimulation(
    row: SimulationRunRow,
  ): AiAgentStudioSimulationRun {
    return {
      id: row.id,
      sandboxId: row.sandbox_id,
      parentRunId: row.parent_run_id,
      status: row.status,
      plan: row.plan,
      simulatedToolResponses:
        row.simulated_tool_responses,
      observations: row.observations,
      result: row.result,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      createdBy: row.created_by,
      traceId: row.trace_id,
      createdAt: row.created_at,
    };
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
        eventType: 'AI_AGENT_STUDIO',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Sandbox state stays authoritative if audit persistence fails.
    }
  }
}

function toolSpecActionType(
  tools: AiAgentStudioToolSpec[],
  toolId: string,
  version: string,
): string {
  const match = tools.find(
    (tool) =>
      tool.toolId === toolId &&
      tool.version === version,
  );

  if (!match) {
    throw new BadRequestException(
      `Sandbox plan tool is not declared: ${toolId}@${version}`,
    );
  }

  return match.actionType;
}
