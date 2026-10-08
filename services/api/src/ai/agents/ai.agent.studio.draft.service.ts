import {
  BadRequestException,
  ConflictException,
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
  randomUUID,
} from 'node:crypto';

import {
  AuditService,
} from '../../audit/audit.service';

import {
  DatabaseService,
} from '../../database/database.service';

import {
  IamService,
} from '../../iam/iam.service';

import type {
  AiAgentStudioDraftRecord,
  AiAgentStudioDraftReviewDecision,
  AiAgentStudioDraftSpec,
  AiAgentStudioDraftStatus,
  AiAgentStudioDraftValidation,
  AiAgentStudioProposedTool,
  CreateAiAgentStudioDraftInput,
  ReviewAiAgentStudioDraftInput,
} from './ai.agent.studio.draft.types';

interface WorkflowDraftRow extends QueryResultRow {
  id: string;
  draft_id: string;
  version: number;
  tenant_id: string;
  factory_id: string;
  source_prompt: string;
  title: string;
  goal: string;
  capability: string;
  typical_output: string;
  authority: string;
  risk_ceiling: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  requested_scopes: string[];
  proposed_tools: AiAgentStudioProposedTool[];
  generated_spec: AiAgentStudioDraftSpec;
  validation: AiAgentStudioDraftValidation;
  status: AiAgentStudioDraftStatus;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
}

@Injectable()
export class AiAgentStudioDraftService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createDraft(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiAgentStudioDraftInput,
  ): Promise<AiAgentStudioDraftRecord> {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.draft.write',
      factoryId,
    );

    const normalized = this.normalizeCreateInput(input);
    const draftId = randomUUID();

    const generated = this.compileDraft(
      normalized.prompt,
      normalized.title,
    );

    const result =
      await this.database.query<WorkflowDraftRow>(
        `
        INSERT INTO workflow_drafts (
          draft_id,
          version,
          tenant_id,
          factory_id,
          source_prompt,
          title,
          goal,
          capability,
          typical_output,
          authority,
          risk_ceiling,
          requested_scopes,
          proposed_tools,
          generated_spec,
          validation,
          status,
          created_by
        )
        VALUES (
          $1,
          1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::text[],
          $12::jsonb,
          $13::jsonb,
          $14::jsonb,
          'DRAFT',
          $15
        )
        RETURNING
          id::text AS id,
          draft_id::text AS draft_id,
          version,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          source_prompt,
          title,
          goal,
          capability,
          typical_output,
          authority,
          risk_ceiling,
          requested_scopes,
          proposed_tools,
          generated_spec,
          validation,
          status,
          review_notes,
          reviewed_by::text AS reviewed_by,
          reviewed_at::text AS reviewed_at,
          created_by::text AS created_by,
          created_at::text AS created_at
        `,
        [
          draftId,
          tenantId,
          factoryId,
          normalized.prompt,
          generated.title,
          generated.goal,
          generated.capability,
          generated.typicalOutput,
          generated.authority,
          generated.riskCeiling,
          generated.requestedScopes,
          JSON.stringify(generated.proposedTools),
          JSON.stringify(generated.generatedSpec),
          JSON.stringify(generated.validation),
          actorUserId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = result.rows[0];

    if (!row) {
      throw new Error(
        'AI_AGENT_STUDIO_DRAFT_INSERT_FAILED',
      );
    }

    const mapped = this.mapRow(row);

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      action: 'DRAFT_CREATE',
      resourceId: mapped.id,
      payload: {
        draftId: mapped.draftId,
        version: mapped.version,
        publicationBlocked: true,
        permissionsGranted:
          mapped.validation.permissionsGranted,
        toolGrantsCreated:
          mapped.validation.toolGrantsCreated,
      },
    });

    return mapped;
  }

  async getLatestDraft(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    draftId: string,
  ): Promise<AiAgentStudioDraftRecord> {
    await this.authorizeRead(
      tenantId,
      factoryId,
      actorUserId,
    );

    this.validateUuid(draftId, 'draftId');

    const result =
      await this.database.query<WorkflowDraftRow>(
        this.selectSql(`
          w.tenant_id = $1
          AND w.factory_id = $2
          AND w.draft_id = $3
        `),
        [
          tenantId,
          factoryId,
          draftId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException(
        'AI workflow draft was not found',
      );
    }

    return this.mapRow(row);
  }

  async listDrafts(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    status?: AiAgentStudioDraftStatus,
  ): Promise<{
    items: AiAgentStudioDraftRecord[];
    count: number;
  }> {
    await this.authorizeRead(
      tenantId,
      factoryId,
      actorUserId,
    );

    if (status !== undefined) {
      this.validateStatus(status);
    }

    const values: unknown[] = [
      tenantId,
      factoryId,
    ];

    const conditions = [
      'w.tenant_id = $1',
      'w.factory_id = $2',
    ];

    if (status) {
      values.push(status);
      conditions.push(
        `w.status = $${values.length}`,
      );
    }

    const result =
      await this.database.query<WorkflowDraftRow>(
        this.selectSql(
          conditions.join('\n          AND '),
          `
            AND w.version = (
              SELECT MAX(w2.version)
              FROM workflow_drafts w2
              WHERE
                w2.tenant_id = w.tenant_id
                AND w2.factory_id = w.factory_id
                AND w2.draft_id = w.draft_id
            )
            ORDER BY w.created_at DESC
            LIMIT 100
          `,
        ),
        values,
        {
          tenantId,
          userId: actorUserId,
        },
      );

    return {
      items: result.rows.map((row) =>
        this.mapRow(row),
      ),
      count: result.rows.length,
    };
  }

  async reviewDraft(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    draftId: string,
    input: ReviewAiAgentStudioDraftInput,
  ): Promise<AiAgentStudioDraftRecord> {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(draftId, 'draftId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.draft.write',
      factoryId,
    );

    const decision =
      this.normalizeReviewInput(input);

    const current =
      await this.getLatestDraft(
        tenantId,
        factoryId,
        actorUserId,
        draftId,
      );

    if (
      current.status !== 'DRAFT'
    ) {
      throw new ConflictException(
        `Only DRAFT versions can be reviewed; current status is ${current.status}`,
      );
    }

    const nextVersion =
      current.version + 1;

    const nextStatus =
      decision.decision === 'APPROVE'
        ? 'READY_FOR_PUBLISH'
        : 'REJECTED';

    /*
     * Important safety boundary:
     * this review operation never creates/updates
     * ai_agent_definitions or ai_agent_tool_grants.
     * It only records another draft-control-plane version.
     */
    const result =
      await this.database.query<WorkflowDraftRow>(
        `
        INSERT INTO workflow_drafts (
          draft_id,
          version,
          tenant_id,
          factory_id,
          source_prompt,
          title,
          goal,
          capability,
          typical_output,
          authority,
          risk_ceiling,
          requested_scopes,
          proposed_tools,
          generated_spec,
          validation,
          status,
          review_notes,
          reviewed_by,
          reviewed_at,
          created_by
        )
        SELECT
          w.draft_id,
          $4,
          w.tenant_id,
          w.factory_id,
          w.source_prompt,
          w.title,
          w.goal,
          w.capability,
          w.typical_output,
          w.authority,
          w.risk_ceiling,
          w.requested_scopes,
          w.proposed_tools,
          w.generated_spec,
          w.validation,
          $5,
          $6,
          $7,
          NOW(),
          w.created_by
        FROM workflow_drafts w
        WHERE
          w.id = $1
          AND w.tenant_id = $2
          AND w.factory_id = $3
        RETURNING
          id::text AS id,
          draft_id::text AS draft_id,
          version,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          source_prompt,
          title,
          goal,
          capability,
          typical_output,
          authority,
          risk_ceiling,
          requested_scopes,
          proposed_tools,
          generated_spec,
          validation,
          status,
          review_notes,
          reviewed_by::text AS reviewed_by,
          reviewed_at::text AS reviewed_at,
          created_by::text AS created_by,
          created_at::text AS created_at
        `,
        [
          current.id,
          tenantId,
          factoryId,
          nextVersion,
          nextStatus,
          decision.notes,
          actorUserId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = result.rows[0];

    if (!row) {
      throw new ConflictException(
        'Unable to create the next workflow draft version',
      );
    }

    const mapped = this.mapRow(row);

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      action:
        decision.decision === 'APPROVE'
          ? 'DRAFT_READY_FOR_PUBLISH'
          : 'DRAFT_REJECT',
      resourceId: mapped.id,
      payload: {
        draftId: mapped.draftId,
        version: mapped.version,
        publicationBlocked:
          mapped.validation.publicationBlocked,
        permissionGrantsCreated: 0,
        toolGrantsCreated: 0,
        nextAction:
          decision.decision === 'APPROVE'
            ? 'CREATE_AGENT_DEFINITION_AND_RUN_SANDBOX'
            : 'REVISE_DRAFT',
      },
    });

    return mapped;
  }

  private compileDraft(
    prompt: string,
    titleOverride: string | null,
  ): {
    title: string;
    goal: string;
    capability: string;
    typicalOutput: string;
    authority: string;
    riskCeiling: AiAgentStudioDraftSpec['riskCeiling'];
    requestedScopes: string[];
    proposedTools: AiAgentStudioProposedTool[];
    generatedSpec: AiAgentStudioDraftSpec;
    validation: AiAgentStudioDraftValidation;
  } {
    const lowered = prompt.toLowerCase();

    const capabilityMap: Array<{
      keywords: string[];
      capability: string;
      typicalOutput: string;
    }> = [
      {
        keywords: [
          'order',
          'sales order',
          'order recovery',
        ],
        capability: 'Order recovery workflow assistance',
        typicalOutput:
          'A reviewable order recovery plan with proposed checks and actions',
      },
      {
        keywords: [
          'procurement',
          'purchase order',
          'supplier',
          'vendor',
        ],
        capability: 'Procurement workflow assistance',
        typicalOutput:
          'A reviewable procurement workflow proposal with supplier and approval checkpoints',
      },
      {
        keywords: [
          'quality',
          'defect',
          'scrap',
          'nonconformance',
        ],
        capability: 'Quality workflow assistance',
        typicalOutput:
          'A reviewable quality investigation and containment workflow',
      },
      {
        keywords: [
          'maintenance',
          'machine',
          'breakdown',
          'work order',
        ],
        capability: 'Maintenance workflow assistance',
        typicalOutput:
          'A reviewable maintenance triage and work-order workflow',
      },
      {
        keywords: [
          'finance',
          'invoice',
          'payment',
          'cost',
        ],
        capability: 'Finance workflow assistance',
        typicalOutput:
          'A reviewable finance workflow with approval checkpoints',
      },
      {
        keywords: [
          'ehs',
          'safety',
          'environment',
          'incident',
        ],
        capability: 'EHS workflow assistance',
        typicalOutput:
          'A reviewable EHS response workflow with escalation checkpoints',
      },
      {
        keywords: [
          'logistics',
          'shipment',
          'dispatch',
          'delivery',
        ],
        capability: 'Logistics workflow assistance',
        typicalOutput:
          'A reviewable logistics recovery workflow with status and escalation checks',
      },
    ];

    const capability =
      capabilityMap.find((entry) =>
        entry.keywords.some((keyword) =>
          lowered.includes(keyword),
        ),
      ) ?? {
        capability:
          'General manufacturing workflow assistance',
        typicalOutput:
          'A reviewable manufacturing workflow specification',
      };

    const requestedTools =
      this.extractRequestedTools(prompt);

    const requestedScopes =
      this.extractRequestedScopes(prompt);

    const riskCeiling =
      this.detectRequestedRiskCeiling(
        lowered,
      );

    const title =
      titleOverride ??
      this.deriveTitle(prompt);

    const agentId =
      `draft-${this.slugify(title).slice(0, 100)}`;

    const generatedSpec: AiAgentStudioDraftSpec = {
      agentId,
      version: '0.1.0-draft',
      name: title,
      goal: prompt,
      capability: capability.capability,
      typicalOutput:
        capability.typicalOutput,
      authority:
        'Draft-only. No permission grant, tool entitlement, token issuance, or live write authority.',
      riskCeiling,
      executionScopes:
        requestedScopes,
      tools:
        requestedTools,
      memory: {},
      policies: {
        reviewRequired: true,
        publicationRequiresCatalogueEntry: true,
        publicationRequiresSandboxSimulation: true,
        publicationRequiresPolicySimulation: true,
        directPermissionGrant: false,
      },
      prompts: {
        sourcePrompt: prompt,
      },
      completionCriteria: {
        humanReview: true,
        publishRequestRequired: true,
      },
    };

    const validation: AiAgentStudioDraftValidation = {
      schemaValid: true,
      permissionsGranted: 0,
      toolGrantsCreated: 0,
      publicationBlocked: true,
      reviewRequired: true,
      reasons: [
        'Natural-language input produces a reviewable draft only',
        'No IAM permission is granted by draft creation',
        'No AI tool grant is created by draft creation',
        'Publication requires a separately governed agent definition, sandbox simulation and policy simulation',
      ],
    };

    if (
      requestedTools.length > 0
    ) {
      validation.reasons.push(
        'Requested tools are references for human review; they are not entitlements',
      );
    }

    return {
      title,
      goal: prompt,
      capability:
        capability.capability,
      typicalOutput:
        capability.typicalOutput,
      authority:
        generatedSpec.authority,
      riskCeiling,
      requestedScopes,
      proposedTools:
        requestedTools,
      generatedSpec,
      validation,
    };
  }

  private extractRequestedTools(
    prompt: string,
  ): AiAgentStudioProposedTool[] {
    const tools: AiAgentStudioProposedTool[] = [];
    const regex =
      /\btool:([A-Za-z0-9._:-]{1,200})(?:@([A-Za-z0-9._:-]{1,100}))?/gi;

    for (const match of prompt.matchAll(regex)) {
      const toolId =
        match[1]?.trim();

      if (!toolId) {
        continue;
      }

      const key =
        `${toolId}@${match[2] ?? ''}`;

      if (
        tools.some(
          (tool) =>
            `${tool.toolId}@${tool.version ?? ''}` === key,
        )
      ) {
        continue;
      }

      tools.push({
        toolId,
        version:
          match[2]?.trim() || null,
        reason:
          'Requested in natural-language draft input',
        requestedOnly: true,
      });
    }

    return tools.slice(0, 50);
  }

  private extractRequestedScopes(
    prompt: string,
  ): string[] {
    const scopes: string[] = [];
    const regex =
      /\bscope:([A-Za-z0-9._:-]{1,200})/gi;

    for (const match of prompt.matchAll(regex)) {
      const scope =
        match[1]?.trim();

      if (
        scope &&
        !scopes.includes(scope)
      ) {
        scopes.push(scope);
      }
    }

    return scopes.slice(0, 100);
  }

  private detectRequestedRiskCeiling(
    loweredPrompt: string,
  ): AiAgentStudioDraftSpec['riskCeiling'] {
    /*
     * Risk inference is deliberately conservative:
     * explicit write/approve/cancel/send language makes the draft
     * L2, but this remains only a proposal. The runtime still
     * requires separately governed catalogue + tool grants.
     */
    if (
      loweredPrompt.includes('approve') ||
      loweredPrompt.includes('cancel') ||
      loweredPrompt.includes('delete') ||
      loweredPrompt.includes('send') ||
      loweredPrompt.includes('write') ||
      loweredPrompt.includes('update') ||
      loweredPrompt.includes('create purchase order')
    ) {
      return 'L2';
    }

    if (
      loweredPrompt.includes('plan') ||
      loweredPrompt.includes('recommend') ||
      loweredPrompt.includes('triage')
    ) {
      return 'L1';
    }

    return 'L0';
  }

  private normalizeCreateInput(
    input: CreateAiAgentStudioDraftInput,
  ): {
    prompt: string;
    title: string | null;
  } {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException(
        'Draft input is required',
      );
    }

    const prompt =
      this.requiredString(
        input.prompt,
        'prompt',
        4000,
      );

    const title =
      input.title === undefined ||
      input.title === null
        ? null
        : this.requiredString(
            input.title,
            'title',
            200,
          );

    return {
      prompt,
      title,
    };
  }

  private normalizeReviewInput(
    input: ReviewAiAgentStudioDraftInput,
  ): {
    decision: AiAgentStudioDraftReviewDecision;
    notes: string | null;
  } {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException(
        'Draft review input is required',
      );
    }

    if (
      input.decision !== 'APPROVE' &&
      input.decision !== 'REJECT'
    ) {
      throw new BadRequestException(
        'decision must be APPROVE or REJECT',
      );
    }

    const notes =
      input.notes === undefined ||
      input.notes === null
        ? null
        : this.requiredString(
            input.notes,
            'notes',
            2000,
          );

    if (
      input.decision === 'REJECT' &&
      !notes
    ) {
      throw new BadRequestException(
        'notes are required when rejecting a draft',
      );
    }

    return {
      decision: input.decision,
      notes,
    };
  }

  private deriveTitle(
    prompt: string,
  ): string {
    const firstSentence =
      prompt.split(/[.!?]\s/)[0]?.trim() ??
      prompt.trim();

    return (
      firstSentence
        .replace(/\s+/g, ' ')
        .slice(0, 200)
        .trim() ||
      'Untitled AI workflow draft'
    );
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(
        /^-+|-+$/g,
        '',
      )
      .slice(0, 100) || 'agent';
  }

  private async authorizeRead(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
  ): Promise<void> {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.draft.read',
      factoryId,
    );
  }

  private validateStatus(
    value: AiAgentStudioDraftStatus,
  ): void {
    if (
      value !== 'DRAFT' &&
      value !== 'READY_FOR_PUBLISH' &&
      value !== 'REJECTED' &&
      value !== 'ARCHIVED'
    ) {
      throw new BadRequestException(
        'Invalid workflow draft status',
      );
    }
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

    const normalized =
      value.trim();

    if (!normalized) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    if (
      normalized.length > maxLength
    ) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private selectSql(
    whereSql: string,
    tailSql = '',
  ): string {
    return `
      SELECT
        w.id::text AS id,
        w.draft_id::text AS draft_id,
        w.version,
        w.tenant_id::text AS tenant_id,
        w.factory_id::text AS factory_id,
        w.source_prompt,
        w.title,
        w.goal,
        w.capability,
        w.typical_output,
        w.authority,
        w.risk_ceiling,
        w.requested_scopes,
        w.proposed_tools,
        w.generated_spec,
        w.validation,
        w.status,
        w.review_notes,
        w.reviewed_by::text AS reviewed_by,
        w.reviewed_at::text AS reviewed_at,
        w.created_by::text AS created_by,
        w.created_at::text AS created_at
      FROM workflow_drafts w
      WHERE ${whereSql}
      ${tailSql}
    `;
  }

  private mapRow(
    row: WorkflowDraftRow,
  ): AiAgentStudioDraftRecord {
    return {
      id: row.id,
      draftId: row.draft_id,
      version: Number(row.version),
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      sourcePrompt: row.source_prompt,
      title: row.title,
      goal: row.goal,
      capability: row.capability,
      typicalOutput: row.typical_output,
      authority: row.authority,
      riskCeiling: row.risk_ceiling,
      requestedScopes:
        row.requested_scopes ?? [],
      proposedTools:
        row.proposed_tools ?? [],
      generatedSpec: row.generated_spec,
      validation: row.validation,
      status: row.status,
      reviewNotes: row.review_notes,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private async safeAudit(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    action: string;
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
        resourceType: 'AI_WORKFLOW_DRAFT',
        resourceId: input.resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // Draft state remains authoritative when audit persistence fails.
    }
  }
}
