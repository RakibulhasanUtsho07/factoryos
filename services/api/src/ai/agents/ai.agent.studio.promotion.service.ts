import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../database/database.service';
import { IamService } from '../../iam/iam.service';
import { AiAgentCatalogueService } from './ai.agent.catalogue.service';
import type { AiAgentDefinition } from './ai.agent.catalogue.types';
import type {
  AiAgentDeploymentRecord,
  AiAgentPublishRequestRecord,
  AiAgentPromotionResult,
  AiAgentPublicationStage,
  CreateAiAgentPublishRequestInput,
} from './ai.agent.studio.promotion.types';

interface SandboxRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  mode: 'SIMULATION';
  live_write_allowed: false;
  status:
    | 'CREATED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'BLOCKED';
  agent_spec: Record<string, unknown>;
}

interface SimulationRunRow extends QueryResultRow {
  id: string;
  sandbox_id: string;
  status: 'COMPLETED' | 'FAILED' | 'BLOCKED';
  result: Record<string, unknown>;
}

interface PublishRequestRow extends QueryResultRow {
  id: string;
  request_id: string;
  version: string;
  tenant_id: string;
  factory_id: string;
  agent_definition_id: string;
  agent_key: string;
  sandbox_id: string;
  simulation_run_id: string;
  policy_simulation_run_id: string | null;
  target_stage: AiAgentPublicationStage;
  action: AiAgentPublishRequestRecord['action'];
  status: AiAgentPublishRequestRecord['status'];
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

interface DeploymentRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  agent_definition_id: string;
  agent_key: string;
  sandbox_id: string;
  simulation_run_id: string;
  policy_simulation_run_id: string | null;
  stage: AiAgentPublicationStage;
  deployment_version: string;
  status: AiAgentDeploymentRecord['status'];
  previous_deployment_id: string | null;
  rollback_of_deployment_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

@Injectable()
export class AiAgentStudioPromotionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly catalogueService: AiAgentCatalogueService,
    private readonly auditService: AuditService,
  ) {}

  async requestPublication(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    traceId: string,
    input: CreateAiAgentPublishRequestInput,
  ): Promise<AiAgentPublishRequestRecord> {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(traceId, 'traceId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.publish',
      factoryId,
    );

    this.validateUuid(input.agentDefinitionId, 'agentDefinitionId');
    this.validateUuid(input.sandboxId, 'sandboxId');
    this.validateUuid(input.simulationRunId, 'simulationRunId');

    if (input.policySimulationRunId) {
      this.validateUuid(
        input.policySimulationRunId,
        'policySimulationRunId',
      );
    }

    const targetStage = this.normalizeStage(input.targetStage);

    const agent = await this.catalogueService.getAgentDefinition(
      tenantId,
      factoryId,
      actorUserId,
      input.agentDefinitionId,
    );

    const sandbox = await this.getSandbox(
      tenantId,
      factoryId,
      input.sandboxId,
    );

    if (!sandbox) {
      throw new NotFoundException('Agent Studio sandbox not found');
    }

    this.assertSandboxMatchesAgent(agent, sandbox);

    if (
      sandbox.mode !== 'SIMULATION' ||
      sandbox.live_write_allowed !== false ||
      sandbox.status !== 'COMPLETED'
    ) {
      throw new ForbiddenException(
        'Publication requires a completed simulation-only sandbox',
      );
    }

    const simulation = await this.getSimulationRun(
      tenantId,
      factoryId,
      input.sandboxId,
      input.simulationRunId,
    );

    if (!simulation) {
      throw new NotFoundException('Agent Studio simulation run not found');
    }

    if (simulation.status !== 'COMPLETED') {
      throw new ForbiddenException(
        'Publication requires a completed sandbox simulation run',
      );
    }

    let policySimulationRunId: string | null = null;

    if (targetStage === 'PRODUCTION') {
      const policySimulation =
        await this.requireCompletedPolicySimulation(
          tenantId,
          factoryId,
          input.sandboxId,
          input.policySimulationRunId ?? null,
        );
      policySimulationRunId = policySimulation.id;
    }

    const requestId = randomUUID();

    try {
      const request = await this.database.transaction(
        async (client) => {
          const insert = await client.query<PublishRequestRow>(
            `
            INSERT INTO ai_agent_publish_requests (
              request_id,
              version,
              tenant_id,
              factory_id,
              agent_definition_id,
              agent_key,
              sandbox_id,
              simulation_run_id,
              policy_simulation_run_id,
              target_stage,
              action,
              status,
              reason,
              created_by
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUEST','PENDING',$11,$12
            )
            RETURNING
              id::text AS id,
              request_id::text AS request_id,
              version::text AS version,
              tenant_id::text AS tenant_id,
              factory_id::text AS factory_id,
              agent_definition_id::text AS agent_definition_id,
              agent_key,
              sandbox_id::text AS sandbox_id,
              simulation_run_id::text AS simulation_run_id,
              policy_simulation_run_id::text AS policy_simulation_run_id,
              target_stage,
              action,
              status,
              reason,
              created_by::text AS created_by,
              created_at::text AS created_at
            `,
            [
              requestId,
              1,
              tenantId,
              factoryId,
              input.agentDefinitionId,
              agent.agentId,
              input.sandboxId,
              input.simulationRunId,
              policySimulationRunId,
              targetStage,
              this.normalizeReason(input.reason),
              actorUserId,
            ],
          );

          const row = insert.rows[0];
          if (!row) {
            throw new BadRequestException(
              'AI agent publish request insert returned no row',
            );
          }
          return this.mapPublishRequest(row);
        },
        { tenantId, userId: actorUserId },
      );

      await this.safeAudit({
        tenantId,
        factoryId,
        actorUserId,
        traceId,
        action: 'REQUEST_PUBLICATION',
        resourceType: 'AI_AGENT_PUBLISH_REQUEST',
        resourceId: request.id,
        payload: {
          requestId,
          agentDefinitionId: request.agentDefinitionId,
          agentKey: request.agentKey,
          targetStage: request.targetStage,
          sandboxId: request.sandboxId,
          simulationRunId: request.simulationRunId,
          policySimulationRunId: request.policySimulationRunId,
        },
      });

      return request;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'AI agent publication request version conflict',
        );
      }
      throw error;
    }
  }

  async approvePublication(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    traceId: string,
    requestId: string,
  ): Promise<AiAgentPublishRequestRecord> {
    await this.authorizePublicationAction(
      actorUserId,
      tenantId,
      factoryId,
      'ai.agents.publish',
    );
    this.validateUuid(requestId, 'requestId');

    const current = await this.getLatestRequest(
      tenantId,
      factoryId,
      requestId,
    );

    if (!current) {
      throw new NotFoundException('AI agent publish request not found');
    }

    if (current.status !== 'PENDING') {
      throw new ConflictException(
        `Publish request cannot be approved from status ${current.status}`,
      );
    }

    const result = await this.appendRequestState(
      tenantId,
      factoryId,
      actorUserId,
      current,
      'APPROVE',
      'APPROVED',
      null,
    );

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      traceId,
      action: 'APPROVE_PUBLICATION',
      resourceType: 'AI_AGENT_PUBLISH_REQUEST',
      resourceId: result.id,
      payload: { requestId },
    });

    return result;
  }

  async promotePublication(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    traceId: string,
    requestId: string,
  ): Promise<AiAgentPromotionResult> {
    await this.authorizePublicationAction(
      actorUserId,
      tenantId,
      factoryId,
      'ai.agents.promote',
    );
    this.validateUuid(requestId, 'requestId');

    const current = await this.getLatestRequest(
      tenantId,
      factoryId,
      requestId,
    );

    if (!current) {
      throw new NotFoundException('AI agent publish request not found');
    }

    if (current.status !== 'APPROVED') {
      throw new ConflictException(
        `Publish request cannot be promoted from status ${current.status}`,
      );
    }

    const sandbox = await this.getSandbox(
      tenantId,
      factoryId,
      current.sandboxId,
    );
    if (!sandbox || sandbox.status !== 'COMPLETED') {
      throw new ForbiddenException(
        'Promotion requires the source sandbox to remain completed',
      );
    }

    const simulation = await this.getSimulationRun(
      tenantId,
      factoryId,
      current.sandboxId,
      current.simulationRunId,
    );
    if (!simulation || simulation.status !== 'COMPLETED') {
      throw new ForbiddenException(
        'Promotion requires the source simulation run to remain completed',
      );
    }

    if (current.targetStage === 'PRODUCTION') {
      await this.requireCompletedPolicySimulation(
        tenantId,
        factoryId,
        current.sandboxId,
        current.policySimulationRunId,
      );

      const canary = await this.getLatestDeploymentByAgentKey(
        tenantId,
        factoryId,
        current.agentKey,
        'CANARY',
      );

      if (!canary || canary.status !== 'ACTIVE') {
        throw new ConflictException(
          'Production promotion requires an active canary deployment first',
        );
      }

      if (canary.agentDefinitionId !== current.agentDefinitionId) {
        throw new ConflictException(
          'Production promotion requires the same agent version to be active in canary',
        );
      }
    }

    const deployment = await this.createDeployment(
      tenantId,
      factoryId,
      actorUserId,
      current,
      null,
      null,
    );

    const promoted = await this.appendRequestState(
      tenantId,
      factoryId,
      actorUserId,
      current,
      'PROMOTE',
      'PROMOTED',
      `Promoted to ${current.targetStage}`,
    );

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      traceId,
      action: 'PROMOTE_PUBLICATION',
      resourceType: 'AI_AGENT_DEPLOYMENT',
      resourceId: deployment.id,
      payload: {
        requestId,
        stage: deployment.stage,
        agentDefinitionId: deployment.agentDefinitionId,
        agentKey: deployment.agentKey,
      },
    });

    return { request: promoted, deployment };
  }

  async rollbackDeployment(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    traceId: string,
    deploymentId: string,
    reason?: string | null,
  ): Promise<AiAgentDeploymentRecord> {
    await this.authorizePublicationAction(
      actorUserId,
      tenantId,
      factoryId,
      'ai.agents.rollback',
    );
    this.validateUuid(deploymentId, 'deploymentId');

    const current = await this.getDeployment(
      tenantId,
      factoryId,
      deploymentId,
    );
    if (!current) {
      throw new NotFoundException('AI agent deployment not found');
    }
    if (current.status !== 'ACTIVE') {
      throw new ConflictException(
        'Only an active deployment may be rolled back',
      );
    }

    const prior = await this.getPriorDeployment(
      tenantId,
      factoryId,
      current,
    );

    let restored: AiAgentDeploymentRecord;

    if (prior) {
      const pseudoRequest: AiAgentPublishRequestRecord = {
        id: randomUUID(),
        requestId: randomUUID(),
        version: 1,
        tenantId,
        factoryId,
        agentDefinitionId: prior.agentDefinitionId,
        agentKey: prior.agentKey,
        sandboxId: prior.sandboxId,
        simulationRunId: prior.simulationRunId,
        policySimulationRunId: prior.policySimulationRunId,
        targetStage: prior.stage,
        action: 'ROLLBACK',
        status: 'PROMOTED',
        reason: this.normalizeReason(reason) ?? 'Rollback to prior tested deployment',
        createdBy: actorUserId,
        createdAt: new Date().toISOString(),
      };

      restored = await this.createDeployment(
        tenantId,
        factoryId,
        actorUserId,
        pseudoRequest,
        current.id,
        current.id,
      );
    } else {
      restored = await this.createRollbackMarker(
        tenantId,
        factoryId,
        actorUserId,
        current,
        reason,
      );
    }

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      traceId,
      action: 'ROLLBACK_DEPLOYMENT',
      resourceType: 'AI_AGENT_DEPLOYMENT',
      resourceId: restored.id,
      payload: {
        rolledBackDeploymentId: current.id,
        restoredDeploymentId: prior?.id ?? null,
        stage: current.stage,
        agentKey: current.agentKey,
      },
    });

    return restored;
  }

  private async createDeployment(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    request: AiAgentPublishRequestRecord,
    previousDeploymentId: string | null,
    rollbackOfDeploymentId: string | null,
  ): Promise<AiAgentDeploymentRecord> {
    const previous = previousDeploymentId
      ? null
      : await this.getLatestDeploymentByAgentKey(
          tenantId,
          factoryId,
          request.agentKey,
          request.targetStage,
        );

    const deploymentVersion = await this.nextDeploymentVersion(
      tenantId,
      factoryId,
      request.agentKey,
      request.targetStage,
    );

    const resolvedPreviousId =
      previousDeploymentId ?? previous?.id ?? null;

    const result = await this.database.transaction(
      async (client) => {
        const insert = await client.query<DeploymentRow>(
          `
          INSERT INTO ai_agent_deployments (
            tenant_id,
            factory_id,
            agent_definition_id,
            agent_key,
            sandbox_id,
            simulation_run_id,
            policy_simulation_run_id,
            stage,
            deployment_version,
            status,
            previous_deployment_id,
            rollback_of_deployment_id,
            reason,
            created_by
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10,$11,$12,$13
          )
          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id,
            agent_definition_id::text AS agent_definition_id,
            agent_key,
            sandbox_id::text AS sandbox_id,
            simulation_run_id::text AS simulation_run_id,
            policy_simulation_run_id::text AS policy_simulation_run_id,
            stage,
            deployment_version::text AS deployment_version,
            status,
            previous_deployment_id::text AS previous_deployment_id,
            rollback_of_deployment_id::text AS rollback_of_deployment_id,
            reason,
            created_by::text AS created_by,
            created_at::text AS created_at
          `,
          [
            tenantId,
            factoryId,
            request.agentDefinitionId,
            request.agentKey,
            request.sandboxId,
            request.simulationRunId,
            request.policySimulationRunId,
            request.targetStage,
            deploymentVersion,
            resolvedPreviousId,
            rollbackOfDeploymentId,
            request.reason,
            actorUserId,
          ],
        );
        const row = insert.rows[0];
        if (!row) {
          throw new BadRequestException(
            'AI agent deployment insert returned no row',
          );
        }
        return this.mapDeployment(row);
      },
      { tenantId, userId: actorUserId },
    );

    return result;
  }

  private async createRollbackMarker(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    current: AiAgentDeploymentRecord,
    reason?: string | null,
  ): Promise<AiAgentDeploymentRecord> {
    const version = await this.nextDeploymentVersion(
      tenantId,
      factoryId,
      current.agentKey,
      current.stage,
    );

    const result = await this.database.query<DeploymentRow>(
      `
      INSERT INTO ai_agent_deployments (
        tenant_id,
        factory_id,
        agent_definition_id,
        agent_key,
        sandbox_id,
        simulation_run_id,
        policy_simulation_run_id,
        stage,
        deployment_version,
        status,
        previous_deployment_id,
        rollback_of_deployment_id,
        reason,
        created_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,'ROLLED_BACK',$10,$10,$11,$12
      )
      RETURNING
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        agent_definition_id::text AS agent_definition_id,
        agent_key,
        sandbox_id::text AS sandbox_id,
        simulation_run_id::text AS simulation_run_id,
        policy_simulation_run_id::text AS policy_simulation_run_id,
        stage,
        deployment_version::text AS deployment_version,
        status,
        previous_deployment_id::text AS previous_deployment_id,
        rollback_of_deployment_id::text AS rollback_of_deployment_id,
        reason,
        created_by::text AS created_by,
        created_at::text AS created_at
      `,
      [
        tenantId,
        factoryId,
        current.agentDefinitionId,
        current.agentKey,
        current.sandboxId,
        current.simulationRunId,
        current.policySimulationRunId,
        current.stage,
        version,
        current.id,
        this.normalizeReason(reason) ?? 'Rollback with no prior deployment',
        actorUserId,
      ],
      { tenantId, userId: actorUserId },
    );

    const row = result.rows[0];
    if (!row) {
      throw new BadRequestException(
        'AI agent rollback marker insert returned no row',
      );
    }
    return this.mapDeployment(row);
  }

  private async appendRequestState(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    current: AiAgentPublishRequestRecord,
    action: AiAgentPublishRequestRecord['action'],
    status: AiAgentPublishRequestRecord['status'],
    reason: string | null,
  ): Promise<AiAgentPublishRequestRecord> {
    const result = await this.database.query<PublishRequestRow>(
      `
      INSERT INTO ai_agent_publish_requests (
        request_id,
        version,
        tenant_id,
        factory_id,
        agent_definition_id,
        agent_key,
        sandbox_id,
        simulation_run_id,
        policy_simulation_run_id,
        target_stage,
        action,
        status,
        reason,
        created_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
      )
      RETURNING
        id::text AS id,
        request_id::text AS request_id,
        version::text AS version,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        agent_definition_id::text AS agent_definition_id,
        agent_key,
        sandbox_id::text AS sandbox_id,
        simulation_run_id::text AS simulation_run_id,
        policy_simulation_run_id::text AS policy_simulation_run_id,
        target_stage,
        action,
        status,
        reason,
        created_by::text AS created_by,
        created_at::text AS created_at
      `,
      [
        current.requestId,
        current.version + 1,
        tenantId,
        factoryId,
        current.agentDefinitionId,
        current.agentKey,
        current.sandboxId,
        current.simulationRunId,
        current.policySimulationRunId,
        current.targetStage,
        action,
        status,
        reason,
        actorUserId,
      ],
      { tenantId, userId: actorUserId },
    );

    const row = result.rows[0];
    if (!row) {
      throw new BadRequestException(
        'AI agent publish request state insert returned no row',
      );
    }
    return this.mapPublishRequest(row);
  }

  private async getLatestRequest(
    tenantId: string,
    factoryId: string,
    requestId: string,
  ): Promise<AiAgentPublishRequestRecord | null> {
    const result = await this.database.query<PublishRequestRow>(
      `
      SELECT
        id::text AS id,
        request_id::text AS request_id,
        version::text AS version,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        agent_definition_id::text AS agent_definition_id,
        agent_key,
        sandbox_id::text AS sandbox_id,
        simulation_run_id::text AS simulation_run_id,
        policy_simulation_run_id::text AS policy_simulation_run_id,
        target_stage,
        action,
        status,
        reason,
        created_by::text AS created_by,
        created_at::text AS created_at
      FROM ai_agent_publish_requests
      WHERE tenant_id = $1
        AND factory_id = $2
        AND request_id = $3
      ORDER BY version DESC
      LIMIT 1
      `,
      [tenantId, factoryId, requestId],
      { tenantId },
    );
    return result.rows[0]
      ? this.mapPublishRequest(result.rows[0])
      : null;
  }

  private async getSandbox(
    tenantId: string,
    factoryId: string,
    sandboxId: string,
  ): Promise<SandboxRow | null> {
    const result = await this.database.query<SandboxRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        mode,
        live_write_allowed,
        status,
        agent_spec
      FROM agent_sandboxes
      WHERE id = $1
        AND tenant_id = $2
        AND factory_id = $3
      LIMIT 1
      `,
      [sandboxId, tenantId, factoryId],
      { tenantId },
    );
    return result.rows[0] ?? null;
  }

  private async getSimulationRun(
    tenantId: string,
    factoryId: string,
    sandboxId: string,
    simulationRunId: string,
  ): Promise<SimulationRunRow | null> {
    const result = await this.database.query<SimulationRunRow>(
      `
      SELECT
        id::text AS id,
        sandbox_id::text AS sandbox_id,
        status,
        result
      FROM simulation_runs
      WHERE id = $1
        AND tenant_id = $2
        AND factory_id = $3
        AND sandbox_id = $4
      LIMIT 1
      `,
      [simulationRunId, tenantId, factoryId, sandboxId],
      { tenantId },
    );
    return result.rows[0] ?? null;
  }

  private async requireCompletedPolicySimulation(
    tenantId: string,
    factoryId: string,
    sandboxId: string,
    policySimulationRunId: string | null,
  ): Promise<SimulationRunRow> {
    if (!policySimulationRunId) {
      throw new ForbiddenException(
        'Production promotion requires a completed policy simulation run',
      );
    }

    const simulation = await this.getSimulationRun(
      tenantId,
      factoryId,
      sandboxId,
      policySimulationRunId,
    );

    if (!simulation) {
      throw new NotFoundException('Policy simulation run not found');
    }
    if (simulation.status !== 'COMPLETED') {
      throw new ForbiddenException(
        'Production promotion requires a completed policy simulation',
      );
    }
    if (simulation.result.kind !== 'POLICY_SIMULATION') {
      throw new ForbiddenException(
        'Provided simulation run is not an Agent Studio policy simulation',
      );
    }
    if (
      simulation.result.recommendation === 'POLICY_DRIFT_DETECTED' ||
      simulation.result.allCasesNonDenied !== true
    ) {
      throw new ForbiddenException(
        'Policy simulation is not safe for production promotion',
      );
    }

    return simulation;
  }

  private async getLatestDeploymentByAgentKey(
    tenantId: string,
    factoryId: string,
    agentKey: string,
    stage: AiAgentPublicationStage,
  ): Promise<AiAgentDeploymentRecord | null> {
    const result = await this.database.query<DeploymentRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        agent_definition_id::text AS agent_definition_id,
        agent_key,
        sandbox_id::text AS sandbox_id,
        simulation_run_id::text AS simulation_run_id,
        policy_simulation_run_id::text AS policy_simulation_run_id,
        stage,
        deployment_version::text AS deployment_version,
        status,
        previous_deployment_id::text AS previous_deployment_id,
        rollback_of_deployment_id::text AS rollback_of_deployment_id,
        reason,
        created_by::text AS created_by,
        created_at::text AS created_at
      FROM ai_agent_deployments
      WHERE tenant_id = $1
        AND factory_id = $2
        AND agent_key = $3
        AND stage = $4
      ORDER BY deployment_version DESC
      LIMIT 1
      `,
      [tenantId, factoryId, agentKey, stage],
      { tenantId },
    );
    return result.rows[0]
      ? this.mapDeployment(result.rows[0])
      : null;
  }

  private async getDeployment(
    tenantId: string,
    factoryId: string,
    deploymentId: string,
  ): Promise<AiAgentDeploymentRecord | null> {
    const result = await this.database.query<DeploymentRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        agent_definition_id::text AS agent_definition_id,
        agent_key,
        sandbox_id::text AS sandbox_id,
        simulation_run_id::text AS simulation_run_id,
        policy_simulation_run_id::text AS policy_simulation_run_id,
        stage,
        deployment_version::text AS deployment_version,
        status,
        previous_deployment_id::text AS previous_deployment_id,
        rollback_of_deployment_id::text AS rollback_of_deployment_id,
        reason,
        created_by::text AS created_by,
        created_at::text AS created_at
      FROM ai_agent_deployments
      WHERE id = $1
        AND tenant_id = $2
        AND factory_id = $3
      LIMIT 1
      `,
      [deploymentId, tenantId, factoryId],
      { tenantId },
    );
    return result.rows[0]
      ? this.mapDeployment(result.rows[0])
      : null;
  }

  private async getPriorDeployment(
    tenantId: string,
    factoryId: string,
    current: AiAgentDeploymentRecord,
  ): Promise<AiAgentDeploymentRecord | null> {
    if (current.previousDeploymentId) {
      return this.getDeployment(
        tenantId,
        factoryId,
        current.previousDeploymentId,
      );
    }

    const result = await this.database.query<DeploymentRow>(
      `
      SELECT
        id::text AS id,
        tenant_id::text AS tenant_id,
        factory_id::text AS factory_id,
        agent_definition_id::text AS agent_definition_id,
        agent_key,
        sandbox_id::text AS sandbox_id,
        simulation_run_id::text AS simulation_run_id,
        policy_simulation_run_id::text AS policy_simulation_run_id,
        stage,
        deployment_version::text AS deployment_version,
        status,
        previous_deployment_id::text AS previous_deployment_id,
        rollback_of_deployment_id::text AS rollback_of_deployment_id,
        reason,
        created_by::text AS created_by,
        created_at::text AS created_at
      FROM ai_agent_deployments
      WHERE tenant_id = $1
        AND factory_id = $2
        AND agent_key = $3
        AND stage = $4
        AND deployment_version < $5
      ORDER BY deployment_version DESC
      LIMIT 1
      `,
      [
        tenantId,
        factoryId,
        current.agentKey,
        current.stage,
        current.deploymentVersion,
      ],
      { tenantId },
    );
    return result.rows[0]
      ? this.mapDeployment(result.rows[0])
      : null;
  }

  private async nextDeploymentVersion(
    tenantId: string,
    factoryId: string,
    agentKey: string,
    stage: AiAgentPublicationStage,
  ): Promise<number> {
    const result = await this.database.query<{ max_version: string | null }>(
      `
      SELECT MAX(deployment_version)::text AS max_version
      FROM ai_agent_deployments
      WHERE tenant_id = $1
        AND factory_id = $2
        AND agent_key = $3
        AND stage = $4
      `,
      [tenantId, factoryId, agentKey, stage],
      { tenantId },
    );
    return Number(result.rows[0]?.max_version ?? '0') + 1;
  }

  private assertSandboxMatchesAgent(
    agent: AiAgentDefinition,
    sandbox: SandboxRow,
  ): void {
    if (
      sandbox.agent_spec.agentId !== agent.agentId ||
      sandbox.agent_spec.version !== agent.version
    ) {
      throw new ConflictException(
        'Sandbox agent specification does not match the requested catalogue agent version',
      );
    }
  }

  private async authorizePublicationAction(
    actorUserId: string,
    tenantId: string,
    factoryId: string,
    permission: string,
  ): Promise<void> {
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      permission,
      factoryId,
    );
  }

  private normalizeStage(value: unknown): AiAgentPublicationStage {
    if (value !== 'CANARY' && value !== 'PRODUCTION') {
      throw new BadRequestException(
        'targetStage must be CANARY or PRODUCTION',
      );
    }
    return value;
  }

  private normalizeReason(
    value: string | null | undefined,
  ): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    if (normalized.length > 2000) {
      throw new BadRequestException(
        'reason must not exceed 2000 characters',
      );
    }
    return normalized;
  }

  private validateUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !isUUID(value)) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
    return value;
  }

  private mapPublishRequest(
    row: PublishRequestRow,
  ): AiAgentPublishRequestRecord {
    return {
      id: row.id,
      requestId: row.request_id,
      version: Number(row.version),
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      agentDefinitionId: row.agent_definition_id,
      agentKey: row.agent_key,
      sandboxId: row.sandbox_id,
      simulationRunId: row.simulation_run_id,
      policySimulationRunId: row.policy_simulation_run_id,
      targetStage: row.target_stage,
      action: row.action,
      status: row.status,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private mapDeployment(
    row: DeploymentRow,
  ): AiAgentDeploymentRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      agentDefinitionId: row.agent_definition_id,
      agentKey: row.agent_key,
      sandboxId: row.sandbox_id,
      simulationRunId: row.simulation_run_id,
      policySimulationRunId: row.policy_simulation_run_id,
      stage: row.stage,
      deploymentVersion: Number(row.deployment_version),
      status: row.status,
      previousDeploymentId: row.previous_deployment_id,
      rollbackOfDeploymentId: row.rollback_of_deployment_id,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private async safeAudit(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    traceId: string;
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
        eventType: 'AI_AGENT_STUDIO_PUBLICATION',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        correlationId: input.traceId,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Publication state remains authoritative if audit persistence fails.
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
