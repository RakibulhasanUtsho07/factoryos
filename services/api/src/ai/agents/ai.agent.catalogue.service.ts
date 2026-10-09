import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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
  AiAgentCatalogueStatus,
  AiAgentDefinition,
  AiAgentToolEntitlement,
  AiAgentToolGrant,
  AiAgentToolGrantStatus,
  CreateAiAgentDefinitionInput,
  CreateAiAgentToolGrantInput,
} from './ai.agent.catalogue.types';

interface AgentDefinitionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  agent_id: string;
  version: string;
  name: string;
  description: string | null;
  capability: string;
  typical_output: string;
  authority: string;
  risk_ceiling: AiToolRiskClass;
  execution_scopes: string[];
  status: AiAgentCatalogueStatus;
  max_steps: number;
  max_retries: number;
  max_tool_calls: number;
  timeout_ms: number;
  config: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentToolGrantRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  agent_definition_id: string;
  tool_id: string;
  tool_version: string;
  version: string;
  status: AiAgentToolGrantStatus;
  effective_from: string;
  expires_at: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
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
export class AiAgentCatalogueService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
    private readonly toolRegistry: AiToolRegistryService,
  ) {}

  async createAgentDefinition(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiAgentDefinitionInput,
  ): Promise<AiAgentDefinition> {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.write',
      factoryId,
    );

    const normalized = this.normalizeAgentDefinition(input);

    try {
      const result =
        await this.database.query<AgentDefinitionRow>(
          `
          INSERT INTO ai_agent_definitions (
            tenant_id,
            factory_id,
            agent_id,
            version,
            name,
            description,
            capability,
            typical_output,
            authority,
            risk_ceiling,
            execution_scopes,
            status,
            max_steps,
            max_retries,
            max_tool_calls,
            timeout_ms,
            config,
            created_by
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18
          )
          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id,
            agent_id,
            version,
            name,
            description,
            capability,
            typical_output,
            authority,
            risk_ceiling,
            execution_scopes,
            status,
            max_steps,
            max_retries,
            max_tool_calls,
            timeout_ms,
            config,
            created_by::text AS created_by,
            created_at::text AS created_at,
            updated_at::text AS updated_at
          `,
          [
            tenantId,
            factoryId,
            normalized.agentId,
            normalized.version,
            normalized.name,
            normalized.description,
            normalized.capability,
            normalized.typicalOutput,
            normalized.authority,
            normalized.riskCeiling,
            normalized.executionScopes,
            normalized.status,
            normalized.maxSteps,
            normalized.maxRetries,
            normalized.maxToolCalls,
            normalized.timeoutMs,
            JSON.stringify(normalized.config),
            actorUserId,
          ],
          {
            tenantId,
            userId: actorUserId,
          },
        );

      const row = result.rows[0];
      if (!row) {
        throw new BadRequestException(
          'AI agent definition insert returned no row',
        );
      }

      const mapped = this.mapAgentDefinition(row);

      await this.safeAudit({
        tenantId,
        factoryId,
        actorUserId,
        action: 'CREATE_VERSION',
        resourceType: 'AI_AGENT_DEFINITION',
        resourceId: mapped.id,
        payload: {
          agentId: mapped.agentId,
          version: mapped.version,
          status: mapped.status,
          riskCeiling: mapped.riskCeiling,
          executionScopes: mapped.executionScopes,
          result: 'CREATED',
        },
      });

      return mapped;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          `AI agent definition already exists: ${normalized.agentId}@${normalized.version}`,
        );
      }
      throw error;
    }
  }

  async getAgentDefinition(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    definitionId: string,
  ): Promise<AiAgentDefinition> {
    await this.authorizeRead(
      actorUserId,
      tenantId,
      factoryId,
    );

    this.validateUuid(
      definitionId,
      'definitionId',
    );

    const result =
      await this.database.query<AgentDefinitionRow>(
        `
        SELECT
          d.id::text AS id,
          d.tenant_id::text AS tenant_id,
          d.factory_id::text AS factory_id,
          d.agent_id,
          d.version,
          d.name,
          d.description,
          d.capability,
          d.typical_output,
          d.authority,
          d.risk_ceiling,
          d.execution_scopes,
          d.status,
          d.max_steps,
          d.max_retries,
          d.max_tool_calls,
          d.timeout_ms,
          d.config,
          d.created_by::text AS created_by,
          d.created_at::text AS created_at,
          d.updated_at::text AS updated_at
        FROM ai_agent_definitions d
        WHERE
          d.id = $1
          AND d.tenant_id = $2
          AND d.factory_id = $3
        LIMIT 1
        `,
        [
          definitionId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException(
        'AI agent definition not found',
      );
    }

    return this.mapAgentDefinition(row);
  }

  async listAgentDefinitions(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    options: {
      status?: AiAgentCatalogueStatus;
      agentId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{
    items: AiAgentDefinition[];
    limit: number;
    offset: number;
    count: number;
  }> {
    await this.authorizeRead(
      actorUserId,
      tenantId,
      factoryId,
    );

    const limit = this.normalizeLimit(options.limit);
    const offset = this.normalizeOffset(options.offset);

    const values: unknown[] = [
      tenantId,
      factoryId,
    ];

    const conditions = [
      'd.tenant_id = $1',
      'd.factory_id = $2',
    ];

    if (options.status !== undefined) {
      this.validateStatus(options.status);
      values.push(options.status);
      conditions.push(`d.status = $${values.length}`);
    }

    if (options.agentId !== undefined) {
      const agentId = this.requiredString(
        options.agentId,
        'agentId',
        200,
      );
      values.push(agentId);
      conditions.push(`d.agent_id = $${values.length}`);
    }

    values.push(limit, offset);

    const limitIndex = values.length - 1;
    const offsetIndex = values.length;

    const result =
      await this.database.query<AgentDefinitionRow>(
        `
        SELECT
          d.id::text AS id,
          d.tenant_id::text AS tenant_id,
          d.factory_id::text AS factory_id,
          d.agent_id,
          d.version,
          d.name,
          d.description,
          d.capability,
          d.typical_output,
          d.authority,
          d.risk_ceiling,
          d.execution_scopes,
          d.status,
          d.max_steps,
          d.max_retries,
          d.max_tool_calls,
          d.timeout_ms,
          d.config,
          d.created_by::text AS created_by,
          d.created_at::text AS created_at,
          d.updated_at::text AS updated_at
        FROM ai_agent_definitions d
        WHERE
          ${conditions.join('\n          AND ')}
        ORDER BY
          d.agent_id ASC,
          d.version DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
        `,
        values,
        {
          tenantId,
          userId: actorUserId,
        },
      );

    return {
      items: result.rows.map(
        (row) => this.mapAgentDefinition(row),
      ),
      limit,
      offset,
      count: result.rows.length,
    };
  }

  async getActiveAgentByKey(
    tenantId: string,
    factoryId: string,
    agentId: string,
    actorUserId?: string | null,
  ): Promise<AiAgentDefinition> {
    if (actorUserId) {
      await this.authorizeRead(
        actorUserId,
        tenantId,
        factoryId,
      );
    }

    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');

    const normalizedAgentId = this.requiredString(
      agentId,
      'agentId',
      200,
    );

    const result =
      await this.database.query<AgentDefinitionRow>(
        `
        SELECT
          d.id::text AS id,
          d.tenant_id::text AS tenant_id,
          d.factory_id::text AS factory_id,
          d.agent_id,
          d.version,
          d.name,
          d.description,
          d.capability,
          d.typical_output,
          d.authority,
          d.risk_ceiling,
          d.execution_scopes,
          d.status,
          d.max_steps,
          d.max_retries,
          d.max_tool_calls,
          d.timeout_ms,
          d.config,
          d.created_by::text AS created_by,
          d.created_at::text AS created_at,
          d.updated_at::text AS updated_at
        FROM ai_agent_definitions d
        WHERE
          d.tenant_id = $1
          AND d.factory_id = $2
          AND d.agent_id = $3
          AND d.status = 'ACTIVE'
        ORDER BY
          d.created_at DESC,
          d.id DESC
        LIMIT 1
        `,
        [
          tenantId,
          factoryId,
          normalizedAgentId,
        ],
        {
          tenantId,
          userId: actorUserId ?? undefined,
        },
      );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException(
        `Active AI agent is not configured: ${normalizedAgentId}`,
      );
    }

    return this.mapAgentDefinition(row);
  }

  async grantTool(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiAgentToolGrantInput,
  ): Promise<AiAgentToolGrant> {
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.write',
      factoryId,
    );

    this.validateUuid(
      tenantId,
      'tenantId',
    );
    this.validateUuid(
      factoryId,
      'factoryId',
    );
    this.validateUuid(
      actorUserId,
      'actorUserId',
    );
    this.validateUuid(
      input.agentDefinitionId,
      'agentDefinitionId',
    );

    const agent = await this.getAgentDefinition(
      tenantId,
      factoryId,
      actorUserId,
      input.agentDefinitionId,
    );

    if (agent.status === 'RETIRED') {
      throw new ConflictException(
        'Cannot grant a tool to a retired AI agent definition',
      );
    }

    const toolId = this.requiredString(
      input.toolId,
      'toolId',
      200,
    );
    const toolVersion = this.requiredString(
      input.toolVersion,
      'toolVersion',
      100,
    );

    const latestGrantResult =
      await this.database.query<AgentToolGrantRow>(
        `
        SELECT
          g.id::text AS id,
          g.tenant_id::text AS tenant_id,
          g.factory_id::text AS factory_id,
          g.agent_definition_id::text AS agent_definition_id,
          g.tool_id,
          g.tool_version,
          g.version::text AS version,
          g.status,
          g.effective_from::text AS effective_from,
          g.expires_at::text AS expires_at,
          g.metadata,
          g.created_by::text AS created_by,
          g.created_at::text AS created_at
        FROM ai_agent_tool_grants g
        WHERE
          g.tenant_id = $1
          AND g.factory_id = $2
          AND g.agent_definition_id = $3
          AND g.tool_id = $4
          AND g.tool_version = $5
        ORDER BY
          g.version DESC
        LIMIT 1
        `,
        [
          tenantId,
          factoryId,
          input.agentDefinitionId,
          toolId,
          toolVersion,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const latestGrant = latestGrantResult.rows[0];
    if (
      latestGrant &&
      latestGrant.status === 'ACTIVE' &&
      (
        latestGrant.expires_at === null ||
        new Date(latestGrant.expires_at).getTime() >
          Date.now()
      ) &&
      new Date(latestGrant.effective_from).getTime() <=
        Date.now()
    ) {
      throw new ConflictException(
        `Active grant already exists: ${toolId}@${toolVersion}`,
      );
    }

    const tool: AiToolDefinition =
      await this.toolRegistry.getTool(
        tenantId,
        factoryId,
        toolId,
        toolVersion,
      );

    this.assertToolRiskWithinAgentCeiling(
      agent,
      tool,
    );
    this.assertToolScopesWithinAgentExecutionScopes(
      agent,
      tool,
    );

    const normalizedEffectiveFrom =
      this.normalizeDate(
        input.effectiveFrom,
        'effectiveFrom',
        new Date(),
      );

    const normalizedExpiresAt =
      input.expiresAt === null ||
      input.expiresAt === undefined
        ? null
        : this.normalizeDate(
            input.expiresAt,
            'expiresAt',
          );

    if (
      normalizedExpiresAt !== null &&
      new Date(normalizedExpiresAt).getTime() <=
        new Date(normalizedEffectiveFrom).getTime()
    ) {
      throw new BadRequestException(
        'expiresAt must be later than effectiveFrom',
      );
    }

    const nextVersion =
      await this.resolveNextGrantVersion(
        tenantId,
        factoryId,
        input.agentDefinitionId,
        tool.toolId,
        tool.version,
        actorUserId,
      );

    try {
      const result =
        await this.database.query<AgentToolGrantRow>(
          `
          INSERT INTO ai_agent_tool_grants (
            tenant_id,
            factory_id,
            agent_definition_id,
            tool_id,
            tool_version,
            version,
            status,
            effective_from,
            expires_at,
            metadata,
            created_by
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'ACTIVE',
            $7,
            $8,
            $9,
            $10
          )
          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id,
            agent_definition_id::text AS agent_definition_id,
            tool_id,
            tool_version,
            version::text AS version,
            status,
            effective_from::text AS effective_from,
            expires_at::text AS expires_at,
            metadata,
            created_by::text AS created_by,
            created_at::text AS created_at
          `,
          [
            tenantId,
            factoryId,
            input.agentDefinitionId,
            tool.toolId,
            tool.version,
            nextVersion,
            normalizedEffectiveFrom,
            normalizedExpiresAt,
            JSON.stringify(
              input.metadata ?? {},
            ),
            actorUserId,
          ],
          {
            tenantId,
            userId: actorUserId,
          },
        );

      const row = result.rows[0];
      if (!row) {
        throw new BadRequestException(
          'AI agent tool grant insert returned no row',
        );
      }

      const mapped = this.mapGrant(row);

      await this.safeAudit({
        tenantId,
        factoryId,
        actorUserId,
        action: 'GRANT_TOOL',
        resourceType: 'AI_AGENT_TOOL_GRANT',
        resourceId: mapped.id,
        payload: {
          agentDefinitionId: mapped.agentDefinitionId,
          toolId: mapped.toolId,
          toolVersion: mapped.toolVersion,
          version: mapped.version,
          result: 'ACTIVE',
        },
      });

      return mapped;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          `Active grant already exists: ${tool.toolId}@${tool.version}`,
        );
      }
      throw error;
    }
  }

  async revokeToolGrant(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    grantId: string,
  ): Promise<AiAgentToolGrant> {
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.write',
      factoryId,
    );

    this.validateUuid(
      tenantId,
      'tenantId',
    );
    this.validateUuid(
      factoryId,
      'factoryId',
    );
    this.validateUuid(
      actorUserId,
      'actorUserId',
    );
    this.validateUuid(
      grantId,
      'grantId',
    );

    const active =
      await this.database.query<AgentToolGrantRow>(
        `
        SELECT
          g.id::text AS id,
          g.tenant_id::text AS tenant_id,
          g.factory_id::text AS factory_id,
          g.agent_definition_id::text AS agent_definition_id,
          g.tool_id,
          g.tool_version,
          g.version::text AS version,
          g.status,
          g.effective_from::text AS effective_from,
          g.expires_at::text AS expires_at,
          g.metadata,
          g.created_by::text AS created_by,
          g.created_at::text AS created_at
        FROM ai_agent_tool_grants g
        WHERE
          g.id = $1
          AND g.tenant_id = $2
          AND g.factory_id = $3
        ORDER BY
          g.version DESC
        LIMIT 1
        `,
        [
          grantId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const current = active.rows[0];
    if (!current || current.status !== 'ACTIVE') {
      throw new NotFoundException(
        'Active AI agent tool grant not found',
      );
    }

    const nextVersion =
      await this.resolveNextGrantVersion(
        tenantId,
        factoryId,
        current.agent_definition_id,
        current.tool_id,
        current.tool_version,
        actorUserId,
      );

    const effectiveFrom = new Date();

    const result =
      await this.database.query<AgentToolGrantRow>(
        `
        INSERT INTO ai_agent_tool_grants (
          tenant_id,
          factory_id,
          agent_definition_id,
          tool_id,
          tool_version,
          version,
          status,
          effective_from,
          expires_at,
          metadata,
          created_by
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'REVOKED',
          $7,
          $8,
          $9,
          $10
        )
        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          agent_definition_id::text AS agent_definition_id,
          tool_id,
          tool_version,
          version::text AS version,
          status,
          effective_from::text AS effective_from,
          expires_at::text AS expires_at,
          metadata,
          created_by::text AS created_by,
          created_at::text AS created_at
        `,
        [
          tenantId,
          factoryId,
          current.agent_definition_id,
          current.tool_id,
          current.tool_version,
          nextVersion,
          effectiveFrom.toISOString(),
          null,
          JSON.stringify({
            ...current.metadata,
            revokedGrantId: current.id,
            reason: 'EXPLICIT_REVOKE',
          }),
          actorUserId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = result.rows[0];
    if (!row) {
      throw new BadRequestException(
        'AI agent tool revoke insert returned no row',
      );
    }

    const mapped = this.mapGrant(row);

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      action: 'REVOKE_TOOL',
      resourceType: 'AI_AGENT_TOOL_GRANT',
      resourceId: mapped.id,
      payload: {
        revokedGrantId: current.id,
        agentDefinitionId: mapped.agentDefinitionId,
        toolId: mapped.toolId,
        toolVersion: mapped.toolVersion,
        version: mapped.version,
        result: 'REVOKED',
      },
    });

    return mapped;
  }

  async assertToolEntitled(
    tenantId: string,
    factoryId: string,
    agentId: string,
    toolId: string,
    toolVersion: string,
  ): Promise<AiAgentToolEntitlement> {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');

    const normalizedAgentId = this.requiredString(
      agentId,
      'agentId',
      200,
    );
    const normalizedToolId = this.requiredString(
      toolId,
      'toolId',
      200,
    );
    const normalizedToolVersion = this.requiredString(
      toolVersion,
      'toolVersion',
      100,
    );

    const agent =
      await this.getActiveAgentByKey(
        tenantId,
        factoryId,
        normalizedAgentId,
      );

    const tool =
      await this.toolRegistry.getTool(
        tenantId,
        factoryId,
        normalizedToolId,
        normalizedToolVersion,
      );

    this.assertToolRiskWithinAgentCeiling(
      agent,
      tool,
    );
    this.assertToolScopesWithinAgentExecutionScopes(
      agent,
      tool,
    );

    const result =
      await this.database.query<AgentToolGrantRow>(
        `
        SELECT
          g.id::text AS id,
          g.tenant_id::text AS tenant_id,
          g.factory_id::text AS factory_id,
          g.agent_definition_id::text AS agent_definition_id,
          g.tool_id,
          g.tool_version,
          g.version::text AS version,
          g.status,
          g.effective_from::text AS effective_from,
          g.expires_at::text AS expires_at,
          g.metadata,
          g.created_by::text AS created_by,
          g.created_at::text AS created_at
        FROM ai_agent_tool_grants g
        WHERE
          g.tenant_id = $1
          AND g.factory_id = $2
          AND g.agent_definition_id = $3
          AND g.tool_id = $4
          AND g.tool_version = $5
        ORDER BY
          g.version DESC
        LIMIT 1
        `,
        [
          tenantId,
          factoryId,
          agent.id,
          tool.toolId,
          tool.version,
        ],
        {
          tenantId,
        },
      );

    const grantRow = result.rows[0];
    if (
      !grantRow ||
      grantRow.status !== 'ACTIVE' ||
      new Date(grantRow.effective_from).getTime() >
        Date.now() ||
      (
        grantRow.expires_at !== null &&
        new Date(grantRow.expires_at).getTime() <=
          Date.now()
      )
    ) {
      throw new ForbiddenException(
        `AI agent tool is not entitled: ${normalizedAgentId} -> ${normalizedToolId}@${normalizedToolVersion}`,
      );
    }

    return {
      agent,
      grant: this.mapGrant(grantRow),
    };
  }

  private async resolveNextGrantVersion(
    tenantId: string,
    factoryId: string,
    agentDefinitionId: string,
    toolId: string,
    toolVersion: string,
    actorUserId: string,
  ): Promise<number> {
    const result =
      await this.database.query<{
        next_version: string;
      }>(
        `
        SELECT
          COALESCE(
            MAX(version),
            0
          ) + 1 AS next_version
        FROM ai_agent_tool_grants
        WHERE
          tenant_id = $1
          AND factory_id = $2
          AND agent_definition_id = $3
          AND tool_id = $4
          AND tool_version = $5
        `,
        [
          tenantId,
          factoryId,
          agentDefinitionId,
          toolId,
          toolVersion,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const raw = result.rows[0]?.next_version ?? '1';
    const nextVersion = Number(raw);

    if (
      !Number.isInteger(nextVersion) ||
      nextVersion < 1
    ) {
      throw new BadRequestException(
        'Failed to resolve AI agent tool grant version',
      );
    }

    return nextVersion;
  }

  private async authorizeRead(
    actorUserId: string,
    tenantId: string,
    factoryId: string,
  ): Promise<void> {
    this.validateUuid(
      actorUserId,
      'actorUserId',
    );
    this.validateUuid(
      tenantId,
      'tenantId',
    );
    this.validateUuid(
      factoryId,
      'factoryId',
    );

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.read',
      factoryId,
    );
  }

  private normalizeAgentDefinition(
    input: CreateAiAgentDefinitionInput,
  ) {
    if (
      !input ||
      typeof input !== 'object'
    ) {
      throw new BadRequestException(
        'AI agent definition input is required',
      );
    }

    const riskCeiling =
      input.riskCeiling ??
      'L0';

    if (!(riskCeiling in RISK_ORDER)) {
      throw new BadRequestException(
        'riskCeiling must be one of L0, L1, L2, L3, L4',
      );
    }

    const status =
      input.status ??
      'DRAFT';

    this.validateStatus(status);

    const executionScopes =
      this.normalizeExecutionScopes(
        input.executionScopes,
      );

    return {
      agentId: this.requiredString(
        input.agentId,
        'agentId',
        200,
      ),
      version: this.requiredString(
        input.version,
        'version',
        100,
      ),
      name: this.requiredString(
        input.name,
        'name',
        200,
      ),
      description:
        input.description === null ||
        input.description === undefined
          ? null
          : this.requiredString(
              input.description,
              'description',
              2000,
            ),
      capability: this.requiredString(
        input.capability,
        'capability',
        500,
      ),
      typicalOutput: this.requiredString(
        input.typicalOutput,
        'typicalOutput',
        500,
      ),
      authority: this.requiredString(
        input.authority,
        'authority',
        500,
      ),
      riskCeiling,
      executionScopes,
      status,
      maxSteps: this.normalizeBound(
        input.maxSteps,
        20,
        1,
        100,
        'maxSteps',
      ),
      maxRetries: this.normalizeBound(
        input.maxRetries,
        3,
        0,
        20,
        'maxRetries',
      ),
      maxToolCalls: this.normalizeBound(
        input.maxToolCalls,
        20,
        1,
        200,
        'maxToolCalls',
      ),
      timeoutMs: this.normalizeBound(
        input.timeoutMs,
        60000,
        100,
        3600000,
        'timeoutMs',
      ),
      config:
        input.config ??
        {},
    };
  }

  private assertToolRiskWithinAgentCeiling(
    agent: AiAgentDefinition,
    tool: AiToolDefinition,
  ): void {
    const agentRisk =
      RISK_ORDER[agent.riskCeiling];

    const toolRisk =
      RISK_ORDER[tool.riskClass];

    if (toolRisk > agentRisk) {
      throw new ForbiddenException(
        `AI tool risk ${tool.riskClass} exceeds agent risk ceiling ${agent.riskCeiling}`,
      );
    }
  }

  private assertToolScopesWithinAgentExecutionScopes(
    agent: AiAgentDefinition,
    tool: AiToolDefinition,
  ): void {
    const allowedScopes = new Set(
      Array.isArray(agent.executionScopes)
        ? agent.executionScopes
        : [],
    );

    const requiredScopes =
      Array.isArray(tool.requiredScopes)
        ? tool.requiredScopes
        : [];

    const missingScopes = requiredScopes.filter(
      (scope) => !allowedScopes.has(scope),
    );

    if (missingScopes.length > 0) {
      throw new ForbiddenException(
        `AI agent execution scopes do not permit tool ${tool.toolId}@${tool.version}; missing scopes: ${missingScopes.join(', ')}`,
      );
    }
  }

  private mapAgentDefinition(
    row: AgentDefinitionRow,
  ): AiAgentDefinition {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      agentId: row.agent_id,
      version: row.version,
      name: row.name,
      description: row.description,
      capability: row.capability,
      typicalOutput: row.typical_output,
      authority: row.authority,
      riskCeiling: row.risk_ceiling,
      executionScopes: Array.isArray(row.execution_scopes)
        ? [...row.execution_scopes]
        : [],
      status: row.status,
      maxSteps: row.max_steps,
      maxRetries: row.max_retries,
      maxToolCalls: row.max_tool_calls,
      timeoutMs: row.timeout_ms,
      config: row.config ?? {},
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapGrant(
    row: AgentToolGrantRow,
  ): AiAgentToolGrant {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      agentDefinitionId: row.agent_definition_id,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      version: Number(row.version),
      status: row.status,
      effectiveFrom: row.effective_from,
      expiresAt: row.expires_at,
      metadata: row.metadata ?? {},
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private validateStatus(
    status: AiAgentCatalogueStatus,
  ): void {
    if (
      ![
        'DRAFT',
        'ACTIVE',
        'PAUSED',
        'RETIRED',
      ].includes(status)
    ) {
      throw new BadRequestException(
        `Invalid AI agent catalogue status: ${status}`,
      );
    }
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

  private validateUuid(
    value: string,
    field: string,
  ): void {
    if (!isUUID(value)) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  private normalizeExecutionScopes(
    value: unknown,
  ): string[] {
    if (
      value === undefined ||
      value === null
    ) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException(
        'executionScopes must be an array',
      );
    }

    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const [index, rawScope] of value.entries()) {
      if (typeof rawScope !== 'string') {
        throw new BadRequestException(
          `executionScopes[${index}] must be a string`,
        );
      }

      const scope = rawScope.trim();

      if (!scope) {
        throw new BadRequestException(
          `executionScopes[${index}] must not be empty`,
        );
      }

      if (scope.length > 200) {
        throw new BadRequestException(
          `executionScopes[${index}] must not exceed 200 characters`,
        );
      }

      if (!seen.has(scope)) {
        seen.add(scope);
        normalized.push(scope);
      }
    }

    if (normalized.length > 100) {
      throw new BadRequestException(
        'executionScopes must contain at most 100 unique scopes',
      );
    }

    return normalized;
  }

  private normalizeBound(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
    field: string,
  ): number {
    const normalized =
      value === undefined
        ? fallback
        : value;

    if (
      !Number.isInteger(normalized) ||
      normalized < min ||
      normalized > max
    ) {
      throw new BadRequestException(
        `${field} must be an integer between ${min} and ${max}`,
      );
    }

    return normalized;
  }

  private normalizeLimit(
    value?: number,
  ): number {
    return this.normalizeBound(
      value,
      50,
      1,
      100,
      'limit',
    );
  }

  private normalizeOffset(
    value?: number,
  ): number {
    return this.normalizeBound(
      value,
      0,
      0,
      100000,
      'offset',
    );
  }

  private normalizeDate(
    value: string | Date | undefined,
    field: string,
    fallback?: Date,
  ): string {
    const date =
      value === undefined
        ? fallback
        : value instanceof Date
          ? value
          : new Date(value);

    if (
      !date ||
      Number.isNaN(
        date.getTime(),
      )
    ) {
      throw new BadRequestException(
        `${field} must be a valid ISO date`,
      );
    }

    return date.toISOString();
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
        eventType: 'AI_AGENT_CATALOGUE',
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Do not hide a successful catalogue mutation.
    }
  }

  private isUniqueViolation(
    error: unknown,
  ): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
