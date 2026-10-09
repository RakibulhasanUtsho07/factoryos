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
} from '../audit/audit.service';

import {
  CbbService,
} from '../cbb/cbb.service';

import {
  DatabaseService,
} from '../database/database.service';

import {
  IamService,
} from '../iam/iam.service';

import {
  PolicyService,
} from '../policy/policy.service';

import {
  CreateAiDecisionDto,
} from './dto/create-ai-decision.dto';

import {
  ResolveAiContextDto,
} from './dto/resolve-ai-context.dto';

import {
  VerifyAiDecisionDto,
} from './dto/verify-ai-decision.dto';

import {
  AuthorizeAiActionDto,
} from './dto/authorize-ai-action.dto';

import {
  ExecuteAiActionDto,
} from './dto/execute-ai-action.dto';

import {
  CreateAiOutcomeDto,
} from './dto/create-ai-outcome.dto';

import {
  CreateAiLearningSignalDto,
} from './dto/create-ai-learning-signal.dto';

import {
  CreateAiReleaseDto,
} from './dto/create-ai-release.dto';

import {
  AiToolGatewayService,
} from './tools/ai.tool.gateway.service';

import {
  AiToolRegistryService,
} from './tools/ai.tool.registry.service';

import type {
  AiToolActionContext,
  AiToolRiskClass,
} from './tools/ai.tool.types';

interface DecisionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  request_id: string;
  trace_id: string;
  actor_id: string;
  objective: string;
  reasoning_mode: string;
  context_version: string | null;
  risk_class: string | null;
  output_state: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ContextRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  context_version: string;
  sources: unknown[];
  permissions: unknown[];
  freshness: Record<string, unknown>;
  evidence_states: unknown[];
  package_hash: string;
  created_at: string;
}

interface EvidenceRow extends QueryResultRow {
  id: string;
  source_type: string;
  source_ref: string;
  source_timestamp: string;
  evidence_grade: string;
  confidence: number | string | null;
  state: string;
  content_hash: string | null;
  visibility: string;
}

interface ConflictRow extends QueryResultRow {
  id: string;
  subject_type: string;
  subject_id: string;
  status: string;
  description: string | null;
}

interface ActionIntentRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  action_type: string;
  tool_id: string | null;
  tool_version: string | null;
  target: Record<string, unknown>;
  resource_type: string | null;
  resource_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  risk_class: string | null;
  authorization_status: 'DENIED' | 'APPROVAL_REQUIRED' | 'AUTHORIZED';
  authorization: Record<string, unknown>;
  approval_id: string | null;
  action_token_hash: string | null;
  token_expires_at: string | null;
  idempotency_key: string | null;
  created_by: string;
  created_at: string;
}

interface ExecutionRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  action_intent_id: string;
  execution_key: string;
  executor_type: string;
  tool_version: string;
  inputs_hash: string;
  result: Record<string, unknown>;
  error: Record<string, unknown>;
  status: 'SUCCEEDED' | 'FAILED';
  started_at: string;
  finished_at: string | null;
}

interface OutcomeRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  decision_id: string;
  action_intent_id: string | null;
  execution_record_id: string | null;
  expected_metric: Record<string, unknown>;
  actual_metric: Record<string, unknown>;
  outcome_window: Record<string, unknown>;
  causal_notes: string | null;
  status: 'EXPECTED' | 'PARTIAL' | 'OBSERVED' | 'FAILED';
  created_by: string;
  created_at: string;
}

interface LearningSignalRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  source_decision_id: string;
  source_outcome_id: string | null;
  source_execution_id: string | null;
  signal_type: string;
  label: string;
  confidence: number | string;
  tenant_scope: string;
  payload: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

interface ReleaseRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  source_decision_id: string | null;
  artifact_type: string;
  artifact_key: string;
  version: string;
  tests: Record<string, unknown>;
  approval_id: string;
  rollback_ref: string | null;
  status: 'PROMOTED' | 'ROLLED_BACK';
  effective_at: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

interface AiContextSnapshot {
  sources: unknown[];
  permissions: string[];
  freshness: Record<string, unknown>;
  evidenceStates: string[];
  contextVersion: string;
  packageHash: string;
}

@Injectable()
export class AiRuntimeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
    private readonly iamService: IamService,
    private readonly policyService: PolicyService,
    private readonly cbbService: CbbService,
    private readonly aiToolRegistry: AiToolRegistryService,
    private readonly aiToolGateway: AiToolGatewayService,
  ) {}

  // ============================================================
  // DECISION ENVELOPE
  // ============================================================

  async createDecision(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    requestId: string,
    traceId: string,
    input: CreateAiDecisionDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(requestId, 'requestId');
    this.validateUuid(traceId, 'traceId');

    const objective = this.requiredString(
      input.objective,
      'objective',
      500,
    );

    const reasoningMode = this.requiredString(
      input.reasoning_mode,
      'reasoning_mode',
      100,
    );

    const outputState = this.requiredString(
      input.output_state,
      'output_state',
      50,
    );

    const contextVersion =
      this.optionalString(
        input.context_version,
        'context_version',
        100,
      );

    const riskClass =
      this.optionalString(
        input.risk_class,
        'risk_class',
        20,
      );

    const metadata =
      input.metadata ?? {};

    const result =
      await this.database.transaction(
        async (client) => {
          const existingResult =
            await client.query<DecisionRow>(
              this.decisionSelectSql(
                `
                d.tenant_id = $1
                AND d.factory_id = $2
                AND d.trace_id = $3
                `,
              ),
              [
                tenantId,
                factoryId,
                traceId,
              ],
            );

          const existing =
            existingResult.rows[0];

          if (existing) {
            return {
              row: existing,
              idempotent: true,
            };
          }

          try {
            const insertedResult =
              await client.query<DecisionRow>(
                `
                INSERT INTO ai_decision_envelopes (
                  id,
                  tenant_id,
                  factory_id,
                  request_id,
                  trace_id,
                  actor_id,
                  objective,
                  reasoning_mode,
                  context_version,
                  risk_class,
                  output_state,
                  metadata
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
                  $12
                )

                RETURNING
                  id::text AS id,
                  tenant_id::text AS tenant_id,
                  factory_id::text AS factory_id,
                  request_id::text AS request_id,
                  trace_id::text AS trace_id,
                  actor_id::text AS actor_id,
                  objective,
                  reasoning_mode,
                  context_version,
                  risk_class,
                  output_state,
                  metadata,
                  created_at::text AS created_at,
                  updated_at::text AS updated_at
                `,
                [
                  randomUUID(),
                  tenantId,
                  factoryId,
                  requestId,
                  traceId,
                  actorUserId,
                  objective,
                  reasoningMode,
                  contextVersion,
                  riskClass,
                  outputState,
                  metadata,
                ],
              );

            const row =
              insertedResult.rows[0];

            if (!row) {
              throw new Error(
                'AI_DECISION_INSERT_FAILED',
              );
            }

            return {
              row,
              idempotent: false,
            };
          } catch (error) {
            if (
              this.isUniqueViolation(error)
            ) {
              const retryResult =
                await client.query<DecisionRow>(
                  this.decisionSelectSql(
                    `
                    d.tenant_id = $1
                    AND d.factory_id = $2
                    AND d.trace_id = $3
                    `,
                  ),
                  [
                    tenantId,
                    factoryId,
                    traceId,
                  ],
                );

              const row =
                retryResult.rows[0];

              if (row) {
                return {
                  row,
                  idempotent: true,
                };
              }
            }

            throw error;
          }
        },
        {
          tenantId,
          userId: actorUserId,
        },
      );

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_DECISION',
      action:
        result.idempotent
          ? 'READ_IDEMPOTENT'
          : 'CREATE',
      resourceType:
        'AI_DECISION_ENVELOPE',
      resourceId: result.row.id,
      payload: {
        traceId: result.row.trace_id,
        requestId: result.row.request_id,
        reasoningMode:
          result.row.reasoning_mode,
        outputState:
          result.row.output_state,
      },
    });

    return {
      idempotent:
        result.idempotent,
      decision:
        this.mapDecision(result.row),
    };
  }

  // ============================================================
  // CONTEXT RESOLUTION
  // ============================================================

  async resolveContext(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: ResolveAiContextDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(
      input.decision_id,
      'decision_id',
    );

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.business.read',
      factoryId,
    );

    const decision =
      await this.getDecision(
        tenantId,
        factoryId,
        input.decision_id,
      );

    if (!decision) {
      throw new NotFoundException(
        'AI decision envelope was not found for this factory',
      );
    }

    const allowedStates =
      this.normalizeEvidenceStates(
        input.requested_evidence_states,
      );

    const cbbModel =
      await this.cbbService.getBusinessModel(
        tenantId,
        factoryId,
      );

    if (!cbbModel) {
      throw new ConflictException(
        'Factory business model is not available for AI context resolution',
      );
    }

    const evidenceResult =
      await this.database.query<EvidenceRow>(
        `
        SELECT
          e.id::text AS id,
          e.source_type,
          e.source_ref,
          e.source_timestamp::text AS source_timestamp,
          e.evidence_grade,
          e.confidence,
          e.state,
          e.content_hash,
          e.visibility

        FROM business_evidence e

        WHERE
          e.tenant_id = $1
          AND e.factory_id = $2
          AND e.state = ANY($3::text[])

        ORDER BY
          e.source_timestamp DESC,
          e.created_at DESC

        LIMIT 100
        `,
        [
          tenantId,
          factoryId,
          allowedStates,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const latestEvidenceAt =
      evidenceResult.rows[0]
        ?.source_timestamp ??
      null;

    const freshness =
      this.buildFreshness(
        latestEvidenceAt,
      );

    const sources: unknown[] = [
      {
        type: 'CBB_BUSINESS_MODEL',
        versionId:
          cbbModel.currentVersion.id,
        version:
          cbbModel.currentVersion.version,
        graphHash:
          cbbModel.currentVersion.graphHash,
        readinessScore:
          cbbModel.currentVersion.readinessScore,
        counts:
          cbbModel.counts,
      },
      ...evidenceResult.rows.map(
        (row) => ({
          type: 'BUSINESS_EVIDENCE',
          id: row.id,
          sourceType:
            row.source_type,
          sourceRef:
            row.source_ref,
          sourceTimestamp:
            row.source_timestamp,
          evidenceGrade:
            row.evidence_grade,
          confidence:
            this.normalizeNullableNumber(
              row.confidence,
            ),
          state: row.state,
          contentHash:
            row.content_hash,
          visibility:
            row.visibility,
        }),
      ),
    ];

    const contextVersion =
      `cbb-${cbbModel.currentVersion.version}`;

    const packageInput: AiContextSnapshot = {
      sources,
      permissions: [
        'ai.context.read',
        'ai.business.read',
      ],
      freshness,
      evidenceStates:
        allowedStates,
      contextVersion,
      packageHash: '',
    };

    packageInput.packageHash =
      this.computeHash({
        decisionId:
          decision.id,
        contextVersion,
        sources,
        permissions:
          packageInput.permissions,
        freshness,
        evidenceStates:
          allowedStates,
      });

    const insertResult =
      await this.database.query<ContextRow>(
        `
        INSERT INTO ai_context_packages (
          id,
          tenant_id,
          factory_id,
          decision_id,
          context_version,
          sources,
          permissions,
          freshness,
          evidence_states,
          package_hash
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
          $10
        )

        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          context_version,
          sources,
          permissions,
          freshness,
          evidence_states,
          package_hash,
          created_at::text AS created_at
        `,
        [
          randomUUID(),
          tenantId,
          factoryId,
          decision.id,
          contextVersion,
          JSON.stringify(sources),
          JSON.stringify(
            packageInput.permissions,
          ),
          JSON.stringify(freshness),
          JSON.stringify(
            allowedStates,
          ),
          packageInput.packageHash,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = insertResult.rows[0];

    if (!row) {
      throw new Error(
        'AI_CONTEXT_PACKAGE_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_CONTEXT',
      action: 'RESOLVE',
      resourceType:
        'AI_CONTEXT_PACKAGE',
      resourceId: row.id,
      payload: {
        decisionId:
          row.decision_id,
        contextVersion:
          row.context_version,
        packageHash:
          row.package_hash,
        evidenceStates:
          row.evidence_states,
      },
    });

    return {
      contextPackage:
        this.mapContext(row),
    };
  }

  // ============================================================
  // VERIFICATION
  // ============================================================

  async verifyDecision(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: VerifyAiDecisionDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(
      input.decision_id,
      'decision_id',
    );

    const decision =
      await this.getDecision(
        tenantId,
        factoryId,
        input.decision_id,
      );

    if (!decision) {
      throw new NotFoundException(
        'AI decision envelope was not found for this factory',
      );
    }

    let context: ContextRow | null = null;

    if (input.context_package_id) {
      this.validateUuid(
        input.context_package_id,
        'context_package_id',
      );

      context =
        await this.getContextPackage(
          tenantId,
          factoryId,
          input.context_package_id,
        );

      if (
        context &&
        context.decision_id !==
          decision.id
      ) {
        throw new ConflictException(
          'AI context package belongs to a different decision envelope',
        );
      }
    } else {
      context =
        await this.getLatestContextPackage(
          tenantId,
          factoryId,
          input.decision_id,
        );
    }

    if (!context) {
      throw new ConflictException(
        'AI decision has no resolved context package to verify',
      );
    }

    const evidenceCount =
      context.sources.filter(
        (source) =>
          this.isObject(source) &&
          source.type ===
            'BUSINESS_EVIDENCE',
      ).length;

    const contextScopeCheck = {
      name: 'CONTEXT_SCOPE',
      status: 'PASS',
      detail:
        'Context package is linked to the verified tenant and factory scope',
    };

    const evidenceCoverageCheck = {
      name: 'EVIDENCE_COVERAGE',
      status:
        evidenceCount > 0
          ? 'PASS'
          : 'FAIL',
      evidenceCount,
      detail:
        evidenceCount > 0
          ? 'At least one authorized business-evidence source is present'
          : 'No authorized business-evidence source is present',
    };

    const contradictionsResult =
      await this.database.query<ConflictRow>(
        `
        SELECT
          c.id::text AS id,
          c.subject_type,
          c.subject_id::text AS subject_id,
          c.status,
          c.description

        FROM business_conflicts c

        WHERE
          c.tenant_id = $1
          AND c.factory_id = $2
          AND c.status = 'OPEN'

        ORDER BY
          c.created_at DESC

        LIMIT 20
        `,
        [
          tenantId,
          factoryId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const contradictions =
      contradictionsResult.rows.map(
        (row) => ({
          id: row.id,
          subjectType:
            row.subject_type,
          subjectId:
            row.subject_id,
          status: row.status,
          description:
            row.description,
        }),
      );

    const contradictionCheck = {
      name: 'CONTRADICTIONS',
      status:
        contradictions.length === 0
          ? 'PASS'
          : 'FAIL',
      count:
        contradictions.length,
    };

    const calcValidation = {
      status: 'NOT_RUN',
      detail:
        'No deterministic domain calculation input was supplied to Wave 1 verification',
    };

    let policyChecks: Record<
      string,
      unknown
    > = {
      status: 'NOT_RUN',
    };

    if (input.policy_action) {
      const evaluation =
        await this.policyService.evaluatePolicy(
          tenantId,
          {
            action:
              input.policy_action,
            resourceType:
              input.resource_type ??
              null,
            attributes:
              input.policy_attributes ??
              {},
          },
        );

      policyChecks = {
        status:
          evaluation.outcome ===
          'ALLOWED'
            ? 'PASS'
            : evaluation.outcome ===
                'APPROVAL_REQUIRED'
              ? 'REVIEW_REQUIRED'
              : 'FAIL',
        outcome:
          evaluation.outcome,
        safeDefault:
          evaluation.safeDefault,
        reason:
          evaluation.reason,
        risk:
          evaluation.risk,
      };
    }

    const policyBlocks =
      policyChecks.status ===
      'FAIL';

    const policyRequiresReview =
      policyChecks.status ===
      'REVIEW_REQUIRED';

    const evidenceBlocks =
      evidenceCoverageCheck.status ===
      'FAIL';

    const contradictionBlocks =
      contradictionCheck.status ===
      'FAIL';

    const status =
      evidenceBlocks ||
      contradictionBlocks ||
      policyBlocks
        ? 'BLOCKED'
        : policyRequiresReview
          ? 'REVIEW_REQUIRED'
          : 'PASSED';

    const insertResult =
      await this.database.query<{
        id: string;
        status: 'PASSED' | 'BLOCKED' | 'REVIEW_REQUIRED';
        created_at: string;
      }>(
        `
        INSERT INTO ai_verification_runs (
          id,
          tenant_id,
          factory_id,
          decision_id,
          context_package_id,
          checks,
          contradictions,
          calc_validation,
          policy_checks,
          reviewer_result,
          status
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
          $11
        )

        RETURNING
          id::text AS id,
          status,
          created_at::text AS created_at
        `,
        [
          randomUUID(),
          tenantId,
          factoryId,
          decision.id,
          context.id,
          JSON.stringify([
            contextScopeCheck,
            evidenceCoverageCheck,
            contradictionCheck,
          ]),
          JSON.stringify(
            contradictions,
          ),
          JSON.stringify(
            calcValidation,
          ),
          JSON.stringify(
            policyChecks,
          ),
          JSON.stringify({
            status: 'NOT_RUN',
          }),
          status,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row =
      insertResult.rows[0];

    if (!row) {
      throw new Error(
        'AI_VERIFICATION_RUN_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_VERIFICATION',
      action: 'RUN',
      resourceType:
        'AI_VERIFICATION_RUN',
      resourceId: row.id,
      payload: {
        decisionId:
          decision.id,
        contextPackageId:
          context.id,
        status:
          row.status,
      },
    });

    return {
      verification: {
        id: row.id,
        decisionId:
          decision.id,
        contextPackageId:
          context.id,
        status: row.status,
        checks: [
          contextScopeCheck,
          evidenceCoverageCheck,
          contradictionCheck,
        ],
        contradictions,
        calcValidation,
        policyChecks,
        reviewerResult: {
          status: 'NOT_RUN',
        },
        createdAt:
          row.created_at,
      },
    };
  }

  // ============================================================
  // GOVERNED ACTION AUTHORIZATION
  // ============================================================

  async authorizeAction(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: AuthorizeAiActionDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.actions.authorize',
      factoryId,
    );

    const decisionId = this.requiredUuid(
      input.decision_id,
      'decision_id',
    );

    const decision = await this.getDecision(
      tenantId,
      factoryId,
      decisionId,
    );

    if (!decision) {
      throw new NotFoundException(
        'AI decision envelope was not found for this factory',
      );
    }

    const actionType = this.requiredString(
      input.action_type,
      'action_type',
      200,
    );
    const toolVersion = this.requiredString(
      input.tool_version,
      'tool_version',
      100,
    );
    const target = this.normalizeObject(
      input.target,
      'target',
    );
    const payload = this.normalizeObject(
      input.payload,
      'payload',
    );
    const resourceType = this.optionalString(
      input.resource_type,
      'resource_type',
      150,
    );
    const resourceId = this.optionalString(
      input.resource_id,
      'resource_id',
      255,
    );
    const idempotencyKey = this.optionalString(
      input.idempotency_key,
      'idempotency_key',
      255,
    );
    const payloadHash = this.computeHash(payload);

    if (idempotencyKey) {
      const existing =
        await this.getActionIntentByIdempotencyKey(
          tenantId,
          factoryId,
          idempotencyKey,
        );

      if (existing) {
        if (
          existing.decision_id !== decisionId ||
          existing.action_type !== actionType ||
          existing.tool_id !== actionType ||
          existing.tool_version !== toolVersion ||
          existing.resource_type !== resourceType ||
          existing.resource_id !== resourceId ||
          existing.payload_hash !== payloadHash
        ) {
          throw new ConflictException(
            'idempotency_key is already bound to a different AI action request',
          );
        }

        return {
          idempotent: true,
          action: this.mapActionIntent(existing, false),
          actionToken: null,
        };
      }
    }
    const registeredTool =
      await this.aiToolRegistry.getTool(
        tenantId,
        factoryId,
        actionType,
        toolVersion,
      );

    const evaluation =
      await this.policyService.evaluatePolicy(
        tenantId,
        {
          action: actionType,
          resourceType,
          attributes:
            input.policy_attributes ??
            {},
        },
      );

    if (
      evaluation.risk.class !==
      registeredTool.riskClass
    ) {
      throw new ConflictException(
        'AI action risk class does not match the registered tool risk class',
      );
    }

    let authorizationStatus:
      | 'DENIED'
      | 'APPROVAL_REQUIRED'
      | 'AUTHORIZED' = 'DENIED';
    let approvalId: string | null = null;
    let authorization: Record<string, unknown> = {
      outcome: evaluation.outcome,
      reason: evaluation.reason,
      safeDefault: evaluation.safeDefault,
      policy: evaluation.risk.policyRef,
      approvalRequired:
        evaluation.risk.approvalRequired,
    };

    if (evaluation.outcome === 'DENIED') {
      authorizationStatus = 'DENIED';
    } else if (
      evaluation.outcome === 'APPROVAL_REQUIRED'
    ) {
      if (!evaluation.policy) {
        throw new ConflictException(
          'Approval-required policy evaluation has no policy reference',
        );
      }

      if (input.approval_id) {
        this.validateUuid(
          input.approval_id,
          'approval_id',
        );

        const approval = await this.getApprovalForScope(
          tenantId,
          input.approval_id,
        );

        if (!approval) {
          throw new NotFoundException(
            'AI action approval was not found for this tenant',
          );
        }

        if (
          approval.policy_id !==
          evaluation.risk.policyRef?.id
        ) {
          throw new ConflictException(
            'AI action approval is bound to a different policy',
          );
        }

        if (approval.action !== actionType) {
          throw new ConflictException(
            'AI action approval action does not match the requested action',
          );
        }

        if (
          approval.resource_type &&
          approval.resource_type !== resourceType
        ) {
          throw new ConflictException(
            'AI action approval resource type does not match the requested action',
          );
        }

        if (
          approval.resource_id &&
          approval.resource_id !== resourceId
        ) {
          throw new ConflictException(
            'AI action approval resource id does not match the requested action',
          );
        }

        if (approval.status !== 'APPROVED') {
          authorizationStatus = 'APPROVAL_REQUIRED';
          approvalId = approval.id;
          authorization = {
            ...authorization,
            approvalId,
            approvalStatus: approval.status,
          };
        } else if (
          approval.expires_at &&
          new Date(approval.expires_at).getTime() <=
            Date.now()
        ) {
          throw new ConflictException(
            'AI action approval has expired',
          );
        } else {
          authorizationStatus = 'AUTHORIZED';
          approvalId = approval.id;
          authorization = {
            ...authorization,
            approvalId,
            approvalStatus: approval.status,
          };
        }
      } else {
        const approval =
          await this.policyService.createApproval(
            tenantId,
            actorUserId,
            {
              policyId:
                evaluation.risk.policyRef!.id,
              riskClassId:
                evaluation.policy.riskClass?.id ?? null,
              idempotencyKey:
                idempotencyKey
                  ? `ai-action-approval:${idempotencyKey}`
                  : null,
              action: actionType,
              resourceType,
              resourceId,
              metadata: {
                decisionId,
                actionPayloadHash: payloadHash,
                target,
              },
            },
          );

        authorizationStatus = 'APPROVAL_REQUIRED';
        approvalId = approval.id;
        authorization = {
          ...authorization,
          approvalId,
          approvalStatus: approval.status,
        };
      }
    } else {
      authorizationStatus = 'AUTHORIZED';
    }

    let actionToken: string | null = null;
    let actionTokenHash: string | null = null;
    let tokenExpiresAt: string | null = null;

    if (authorizationStatus === 'AUTHORIZED') {
      actionToken = randomUUID();
      actionTokenHash = this.computeHash(actionToken);

      const ttl =
        input.token_ttl_seconds === undefined
          ? 600
          : Math.trunc(
              input.token_ttl_seconds,
            );

      if (ttl < 30 || ttl > 3600) {
        throw new BadRequestException(
          'token_ttl_seconds must be between 30 and 3600 seconds',
        );
      }

      tokenExpiresAt = new Date(
        Date.now() + ttl * 1000,
      ).toISOString();
    }

    const result =
      await this.database.query<ActionIntentRow>(
        `
        INSERT INTO ai_action_intents (
          id,
          tenant_id,
          factory_id,
          decision_id,
          action_type,
          tool_id,
          tool_version,
          target,
          resource_type,
          resource_id,
          payload,
          payload_hash,
          risk_class,
          authorization_status,
          "authorization",
          approval_id,
          action_token_hash,
          token_expires_at,
          idempotency_key,
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
          $8::jsonb,
          $9,
          $10,
          $11::jsonb,
          $12,
          $13,
          $14,
          $15::jsonb,
          $16,
          $17,
          $18,
          $19,
          $20
        )
        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          action_type,
          tool_id,
          tool_version,
          target,
          resource_type,
          resource_id,
          payload,
          payload_hash,
          risk_class,
          authorization_status,
          "authorization",
          approval_id::text AS approval_id,
          action_token_hash,
          token_expires_at::text AS token_expires_at,
          idempotency_key,
          created_by::text AS created_by,
          created_at::text AS created_at
        `,
        [
          randomUUID(),
          tenantId,
          factoryId,
          decisionId,
          actionType,
          actionType,
          toolVersion,
          JSON.stringify(target),
          resourceType,
          resourceId,
          JSON.stringify(payload),
          payloadHash,
          evaluation.risk.class,
          authorizationStatus,
          JSON.stringify(authorization),
          approvalId,
          actionTokenHash,
          tokenExpiresAt,
          idempotencyKey,
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
        'AI_ACTION_INTENT_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_ACTION',
      action: 'AUTHORIZE',
      resourceType: 'AI_ACTION_INTENT',
      resourceId: row.id,
      payload: {
        decisionId,
        actionType,
        status: row.authorization_status,
        riskClass: row.risk_class,
        approvalId: row.approval_id,
        payloadHash,
      },
    });

    return {
      idempotent: false,
      action: this.mapActionIntent(
        row,
        false,
      ),
      actionToken,
    };
  }

  // ============================================================
  // GOVERNED ACTION EXECUTION
  // ============================================================

  async executeAction(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: ExecuteAiActionDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.actions.execute',
      factoryId,
    );

    const actionToken = this.requiredString(
      input.action_token,
      'action_token',
      255,
    );
    const executionKey = this.requiredString(
      input.execution_key,
      'execution_key',
      255,
    );
    const toolVersion = this.requiredString(
      input.tool_version,
      'tool_version',
      100,
    );
    const tokenHash = this.computeHash(
      actionToken,
    );

    const action =
      await this.getActionIntentByTokenHash(
        tenantId,
        factoryId,
        tokenHash,
      );

    if (!action) {
      throw new NotFoundException(
        'AI action token was not found for this factory',
      );
    }

    if (
      action.authorization_status !==
      'AUTHORIZED'
    ) {
      throw new ConflictException(
        'AI action intent is not authorized for execution',
      );
    }

    if (
      !action.token_expires_at ||
      new Date(action.token_expires_at).getTime() <=
        Date.now()
    ) {
      throw new ConflictException(
        'AI action token has expired',
      );
    }

    if (
      !action.tool_id ||
      !action.tool_version
    ) {
      throw new ConflictException(
        'AI action intent is not bound to a registered tool version',
      );
    }

    if (
      action.tool_id !== action.action_type ||
      toolVersion !== action.tool_version
    ) {
      throw new ConflictException(
        'Requested tool version does not match the authorization-bound tool version',
      );
    }

    const existing =
      await this.getExecutionByActionIntent(
        tenantId,
        factoryId,
        action.id,
      );

    if (existing) {
      return {
        idempotent: true,
        execution:
          this.mapExecution(existing),
      };
    }

    const executionKeyExisting =
      await this.getExecutionByKey(
        tenantId,
        factoryId,
        executionKey,
      );

    if (
      executionKeyExisting &&
      executionKeyExisting.action_intent_id !==
        action.id
    ) {
      throw new ConflictException(
        'execution_key is already bound to a different AI action',
      );
    }

    // The client-provided executor_type is deliberately not trusted as an
    // execution identity. This request is handled by the governed gateway.
    const gatewayAction: AiToolActionContext = {
      tenantId,
      factoryId,
      actorUserId,
      actionIntentId: action.id,
      decisionId: action.decision_id,
      toolId: action.tool_id,
      toolVersion: action.tool_version,
      actionType: action.action_type,
      target: action.target,
      resourceType: action.resource_type,
      resourceId: action.resource_id,
      payload: action.payload,
      payloadHash: action.payload_hash,
      riskClass: action.risk_class as AiToolRiskClass,
      authorizationStatus: action.authorization_status,
      approvalId: action.approval_id,
      actionTokenHash: action.action_token_hash,
      tokenExpiresAt: action.token_expires_at,
      idempotencyKey: action.idempotency_key,
      executorType: 'AI_TOOL_GATEWAY',
      actionToken,
    };

    const gatewayOutcome =
      await this.aiToolGateway.execute(
        gatewayAction,
      );

    const executorType = gatewayOutcome.executorType;
    const inputsHash = gatewayOutcome.inputsHash;
    const status = gatewayOutcome.status;
    const result = gatewayOutcome.result;
    const error = gatewayOutcome.error;

    const insertResult =
      await this.database.query<ExecutionRow>(
        `
        INSERT INTO ai_execution_records (
          id,
          tenant_id,
          factory_id,
          decision_id,
          action_intent_id,
          execution_key,
          executor_type,
          tool_version,
          inputs_hash,
          result,
          error,
          status,
          finished_at
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
          $10::jsonb,
          $11::jsonb,
          $12,
          NOW()
        )
        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          action_intent_id::text AS action_intent_id,
          execution_key,
          executor_type,
          tool_version,
          inputs_hash,
          result,
          error,
          status,
          started_at::text AS started_at,
          finished_at::text AS finished_at
        `,
        [
          randomUUID(),
          tenantId,
          factoryId,
          action.decision_id,
          action.id,
          executionKey,
          executorType,
          gatewayOutcome.toolVersion,
          inputsHash,
          JSON.stringify(result),
          JSON.stringify(error),
          status,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = insertResult.rows[0];

    if (!row) {
      throw new Error(
        'AI_EXECUTION_RECORD_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_ACTION',
      action: 'EXECUTE',
      resourceType: 'AI_EXECUTION_RECORD',
      resourceId: row.id,
      payload: {
        decisionId: row.decision_id,
        actionIntentId:
          row.action_intent_id,
        executionKey: row.execution_key,
        toolVersion: row.tool_version,
        status: row.status,
        inputsHash: row.inputs_hash,
      },
    });

    return {
      idempotent: false,
      execution: this.mapExecution(row),
    };
  }

  // ============================================================
  // OUTCOME CAPTURE
  // ============================================================

  async createOutcome(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiOutcomeDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(input.decision_id, 'decision_id');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.outcomes.write',
      factoryId,
    );

    const decision = await this.getDecision(
      tenantId,
      factoryId,
      input.decision_id,
    );

    if (!decision) {
      throw new NotFoundException(
        'AI decision envelope was not found for this factory',
      );
    }

    let actionIntentId = input.action_intent_id ?? null;
    let executionRecordId =
      input.execution_record_id ?? null;

    if (actionIntentId) {
      this.validateUuid(
        actionIntentId,
        'action_intent_id',
      );
      const action =
        await this.getActionIntentById(
          tenantId,
          factoryId,
          actionIntentId,
        );
      if (!action) {
        throw new NotFoundException(
          'AI action intent was not found for this factory',
        );
      }
      if (action.decision_id !== decision.id) {
        throw new ConflictException(
          'AI action intent belongs to a different decision envelope',
        );
      }
    }

    if (executionRecordId) {
      this.validateUuid(
        executionRecordId,
        'execution_record_id',
      );
      const execution =
        await this.getExecutionById(
          tenantId,
          factoryId,
          executionRecordId,
        );
      if (!execution) {
        throw new NotFoundException(
          'AI execution record was not found for this factory',
        );
      }
      if (execution.decision_id !== decision.id) {
        throw new ConflictException(
          'AI execution record belongs to a different decision envelope',
        );
      }
      if (
        actionIntentId &&
        execution.action_intent_id !==
          actionIntentId
      ) {
        throw new ConflictException(
          'AI execution record does not belong to the requested action intent',
        );
      }
      if (!actionIntentId) {
        actionIntentId =
          execution.action_intent_id;
      }
    }

    const expectedMetric =
      this.normalizeObject(
        input.expected_metric,
        'expected_metric',
      );
    const actualMetric =
      input.actual_metric === null ||
      input.actual_metric === undefined
        ? {}
        : this.normalizeObject(
            input.actual_metric,
            'actual_metric',
          );
    const outcomeWindow =
      this.normalizeObject(
        input.outcome_window,
        'outcome_window',
      );
    const status = this.normalizeOutcomeStatus(
      input.status ??
        (Object.keys(actualMetric).length > 0
          ? 'OBSERVED'
          : 'EXPECTED'),
    );
    const causalNotes =
      input.causal_notes === null ||
      input.causal_notes === undefined
        ? null
        : input.causal_notes.trim();

    if (
      causalNotes &&
      causalNotes.length > 4000
    ) {
      throw new BadRequestException(
        'causal_notes must not exceed 4000 characters',
      );
    }

    const result =
      await this.database.query<OutcomeRow>(
        `
        INSERT INTO ai_outcome_links (
          id,
          tenant_id,
          factory_id,
          decision_id,
          action_intent_id,
          execution_record_id,
          expected_metric,
          actual_metric,
          outcome_window,
          causal_notes,
          status,
          created_by
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7::jsonb,
          $8::jsonb,
          $9::jsonb,
          $10,
          $11,
          $12
        )
        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          action_intent_id::text AS action_intent_id,
          execution_record_id::text AS execution_record_id,
          expected_metric,
          actual_metric,
          outcome_window,
          causal_notes,
          status,
          created_by::text AS created_by,
          created_at::text AS created_at
        `,
        [
          randomUUID(),
          tenantId,
          factoryId,
          decision.id,
          actionIntentId,
          executionRecordId,
          JSON.stringify(expectedMetric),
          JSON.stringify(actualMetric),
          JSON.stringify(outcomeWindow),
          causalNotes,
          status,
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
        'AI_OUTCOME_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_OUTCOME',
      action: 'CREATE',
      resourceType: 'AI_OUTCOME_LINK',
      resourceId: row.id,
      payload: {
        decisionId: row.decision_id,
        actionIntentId:
          row.action_intent_id,
        executionRecordId:
          row.execution_record_id,
        status: row.status,
      },
    });

    return {
      outcome: this.mapOutcome(row),
    };
  }

  // ============================================================
  // LEARNING SIGNAL
  // ============================================================

  async createLearningSignal(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiLearningSignalDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(
      input.source_decision_id,
      'source_decision_id',
    );

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.learning.write',
      factoryId,
    );

    const decision = await this.getDecision(
      tenantId,
      factoryId,
      input.source_decision_id,
    );

    if (!decision) {
      throw new NotFoundException(
        'AI decision envelope was not found for this factory',
      );
    }

    let sourceOutcomeId =
      input.source_outcome_id ?? null;
    let sourceExecutionId =
      input.source_execution_id ?? null;

    if (sourceOutcomeId) {
      this.validateUuid(
        sourceOutcomeId,
        'source_outcome_id',
      );
      const outcome =
        await this.getOutcomeById(
          tenantId,
          factoryId,
          sourceOutcomeId,
        );
      if (!outcome) {
        throw new NotFoundException(
          'AI outcome link was not found for this factory',
        );
      }
      if (outcome.decision_id !== decision.id) {
        throw new ConflictException(
          'AI outcome belongs to a different decision envelope',
        );
      }
    }

    if (sourceExecutionId) {
      this.validateUuid(
        sourceExecutionId,
        'source_execution_id',
      );
      const execution =
        await this.getExecutionById(
          tenantId,
          factoryId,
          sourceExecutionId,
        );
      if (!execution) {
        throw new NotFoundException(
          'AI execution record was not found for this factory',
        );
      }
      if (execution.decision_id !== decision.id) {
        throw new ConflictException(
          'AI execution record belongs to a different decision envelope',
        );
      }
    }

    const signalType = this.requiredString(
      input.signal_type,
      'signal_type',
      100,
    );
    const label = this.requiredString(
      input.label,
      'label',
      200,
    );
    const confidence = Number(
      input.confidence,
    );
    if (
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new BadRequestException(
        'confidence must be between 0 and 1',
      );
    }
    const tenantScope =
      this.normalizeLearningScope(
        input.tenant_scope ?? 'TENANT',
      );
    const payload = this.normalizeObject(
      input.payload,
      'payload',
    );

    const result =
      await this.database.query<LearningSignalRow>(
        `
        INSERT INTO ai_learning_signals (
          id,
          tenant_id,
          factory_id,
          source_decision_id,
          source_outcome_id,
          source_execution_id,
          signal_type,
          label,
          confidence,
          tenant_scope,
          payload,
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
          $11::jsonb,
          $12
        )
        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          source_decision_id::text AS source_decision_id,
          source_outcome_id::text AS source_outcome_id,
          source_execution_id::text AS source_execution_id,
          signal_type,
          label,
          confidence,
          tenant_scope,
          payload,
          created_by::text AS created_by,
          created_at::text AS created_at
        `,
        [
          randomUUID(),
          tenantId,
          factoryId,
          decision.id,
          sourceOutcomeId,
          sourceExecutionId,
          signalType,
          label,
          confidence,
          tenantScope,
          JSON.stringify(payload),
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
        'AI_LEARNING_SIGNAL_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_LEARNING',
      action: 'CREATE_SIGNAL',
      resourceType: 'AI_LEARNING_SIGNAL',
      resourceId: row.id,
      payload: {
        sourceDecisionId:
          row.source_decision_id,
        sourceOutcomeId:
          row.source_outcome_id,
        sourceExecutionId:
          row.source_execution_id,
        signalType:
          row.signal_type,
        label: row.label,
        confidence:
          this.normalizeNullableNumber(
            row.confidence,
          ),
        tenantScope:
          row.tenant_scope,
      },
    });

    return {
      learningSignal:
        this.mapLearningSignal(row),
    };
  }

  // ============================================================
  // RELEASE GATE
  // ============================================================

  async createRelease(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: CreateAiReleaseDto,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(
      input.approval_id,
      'approval_id',
    );

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.release.write',
      factoryId,
    );

    const approval =
      await this.getApprovalForScope(
        tenantId,
        input.approval_id,
      );

    if (!approval) {
      throw new NotFoundException(
        'AI release approval was not found for this tenant',
      );
    }

    if (approval.status !== 'APPROVED') {
      throw new ConflictException(
        'AI release requires an approved approval request',
      );
    }

    if (
      approval.expires_at &&
      new Date(approval.expires_at).getTime() <=
        Date.now()
    ) {
      throw new ConflictException(
        'AI release approval has expired',
      );
    }

    const artifactType = this.requiredString(
      input.artifact_type,
      'artifact_type',
      100,
    );
    const artifactKey = this.requiredString(
      input.artifact_key,
      'artifact_key',
      200,
    );
    const version = this.requiredString(
      input.version,
      'version',
      100,
    );
    const tests = this.normalizeObject(
      input.tests,
      'tests',
    );
    const passed = tests.passed === true;

    if (!passed) {
      throw new ConflictException(
        'AI release gate requires tests.passed=true',
      );
    }

    const rollbackRef = this.optionalString(
      input.rollback_ref,
      'rollback_ref',
      255,
    );
    const metadata = this.normalizeObject(
      input.metadata ?? {},
      'metadata',
    );
    const effectiveAt =
      input.effective_at ??
      new Date().toISOString();
    const sourceDecisionId =
      input.decision_id ?? null;

    if (sourceDecisionId) {
      this.validateUuid(
        sourceDecisionId,
        'decision_id',
      );

      const sourceDecision =
        await this.getDecision(
          tenantId,
          factoryId,
          sourceDecisionId,
        );

      if (!sourceDecision) {
        throw new NotFoundException(
          'AI release source decision was not found for this factory',
        );
      }
    }

    const existingRelease =
      await this.getReleaseByArtifactVersion(
        tenantId,
        factoryId,
        artifactType,
        artifactKey,
        version,
      );

    if (existingRelease) {
      return {
        release: this.mapRelease(existingRelease),
        idempotent: true,
      };
    }

    const releaseMetadata = {
      ...metadata,
      ...(sourceDecisionId
        ? { decisionId: sourceDecisionId }
        : {}),
    };

    let result: {
      rows: ReleaseRow[];
    };

    try {
      result =
        await this.database.query<ReleaseRow>(
          `
          INSERT INTO ai_release_records (
            id,
            tenant_id,
            factory_id,
            source_decision_id,
            artifact_type,
            artifact_key,
            version,
            tests,
            approval_id,
            rollback_ref,
            status,
            effective_at,
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
            $7,
            $8::jsonb,
            $9,
            $10,
            'PROMOTED',
            $11::timestamptz,
            $12::jsonb,
            $13
          )
          RETURNING
            id::text AS id,
            tenant_id::text AS tenant_id,
            factory_id::text AS factory_id,
            source_decision_id::text AS source_decision_id,
            artifact_type,
            artifact_key,
            version,
            tests,
            approval_id::text AS approval_id,
            rollback_ref,
            status,
            effective_at::text AS effective_at,
            metadata,
            created_by::text AS created_by,
            created_at::text AS created_at
          `,
          [
            randomUUID(),
            tenantId,
            factoryId,
            sourceDecisionId,
            artifactType,
            artifactKey,
            version,
            JSON.stringify(tests),
            input.approval_id,
            rollbackRef,
            effectiveAt,
            JSON.stringify(releaseMetadata),
            actorUserId,
          ],
          {
            tenantId,
            userId: actorUserId,
          },
        );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const concurrent =
          await this.getReleaseByArtifactVersion(
            tenantId,
            factoryId,
            artifactType,
            artifactKey,
            version,
          );
        if (concurrent) {
          return {
            release: this.mapRelease(concurrent),
            idempotent: true,
          };
        }
      }
      throw error;
    }

    const row = result.rows[0];

    if (!row) {
      throw new Error(
        'AI_RELEASE_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_RELEASE',
      action: 'PROMOTE',
      resourceType: 'AI_RELEASE_RECORD',
      resourceId: row.id,
      payload: {
        artifactType:
          row.artifact_type,
        artifactKey:
          row.artifact_key,
        version: row.version,
        approvalId:
          row.approval_id,
        status: row.status,
        effectiveAt:
          row.effective_at,
      },
    });

    return {
      idempotent: false,
      release: this.mapRelease(row),
    };
  }

  // ============================================================
  // MATERIAL DECISION REPLAY
  // ============================================================

  async replayDecision(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    traceId: string,
  ) {
    this.validateScope(tenantId, factoryId);
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(traceId, 'traceId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.replay.read',
      factoryId,
    );

    const decisionResult =
      await this.database.query<DecisionRow>(
        this.decisionSelectSql(
          `
          d.tenant_id = $1
          AND d.factory_id = $2
          AND d.trace_id = $3
          `,
        ),
        [tenantId, factoryId, traceId],
        { tenantId },
      );

    const decision =
      decisionResult.rows[0];

    if (!decision) {
      throw new NotFoundException(
        'AI decision envelope was not found for this trace',
      );
    }

    const contextResult =
      await this.database.query<ContextRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          context_version,
          sources,
          permissions,
          freshness,
          evidence_states,
          package_hash,
          created_at::text AS created_at
        FROM ai_context_packages
        WHERE tenant_id = $1
          AND factory_id = $2
          AND decision_id = $3
        ORDER BY created_at DESC
        `,
        [tenantId, factoryId, decision.id],
        { tenantId },
      );

    const verificationResult =
      await this.database.query<{
        id: string;
        status: string;
        checks: unknown[];
        contradictions: unknown[];
        calc_validation: Record<string, unknown>;
        policy_checks: Record<string, unknown>;
        reviewer_result: Record<string, unknown>;
        context_package_id: string;
        created_at: string;
      }>(
        `
        SELECT
          id::text AS id,
          status,
          checks,
          contradictions,
          calc_validation,
          policy_checks,
          reviewer_result,
          context_package_id::text AS context_package_id,
          created_at::text AS created_at
        FROM ai_verification_runs
        WHERE tenant_id = $1
          AND factory_id = $2
          AND decision_id = $3
        ORDER BY created_at DESC
        `,
        [tenantId, factoryId, decision.id],
        { tenantId },
      );

    const actionResult =
      await this.database.query<ActionIntentRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          action_type,
          tool_id,
          tool_version,
          target,
          resource_type,
          resource_id,
          payload,
          payload_hash,
          risk_class,
          authorization_status,
          "authorization",
          approval_id::text AS approval_id,
          action_token_hash,
          token_expires_at::text AS token_expires_at,
          idempotency_key,
          created_by::text AS created_by,
          created_at::text AS created_at
        FROM ai_action_intents
        WHERE tenant_id = $1
          AND factory_id = $2
          AND decision_id = $3
        ORDER BY created_at ASC
        `,
        [tenantId, factoryId, decision.id],
        { tenantId },
      );

    const executionResult =
      await this.database.query<ExecutionRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          action_intent_id::text AS action_intent_id,
          execution_key,
          executor_type,
          tool_version,
          inputs_hash,
          result,
          error,
          status,
          started_at::text AS started_at,
          finished_at::text AS finished_at
        FROM ai_execution_records
        WHERE tenant_id = $1
          AND factory_id = $2
          AND decision_id = $3
        ORDER BY started_at ASC
        `,
        [tenantId, factoryId, decision.id],
        { tenantId },
      );

    const outcomeResult =
      await this.database.query<OutcomeRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          decision_id::text AS decision_id,
          action_intent_id::text AS action_intent_id,
          execution_record_id::text AS execution_record_id,
          expected_metric,
          actual_metric,
          outcome_window,
          causal_notes,
          status,
          created_by::text AS created_by,
          created_at::text AS created_at
        FROM ai_outcome_links
        WHERE tenant_id = $1
          AND factory_id = $2
          AND decision_id = $3
        ORDER BY created_at ASC
        `,
        [tenantId, factoryId, decision.id],
        { tenantId },
      );

    const learningResult =
      await this.database.query<LearningSignalRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          source_decision_id::text AS source_decision_id,
          source_outcome_id::text AS source_outcome_id,
          source_execution_id::text AS source_execution_id,
          signal_type,
          label,
          confidence,
          tenant_scope,
          payload,
          created_by::text AS created_by,
          created_at::text AS created_at
        FROM ai_learning_signals
        WHERE tenant_id = $1
          AND factory_id = $2
          AND source_decision_id = $3
        ORDER BY created_at ASC
        `,
        [tenantId, factoryId, decision.id],
        { tenantId },
      );

    const releaseResult =
      await this.database.query<ReleaseRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          artifact_type,
          artifact_key,
          version,
          tests,
          approval_id::text AS approval_id,
          rollback_ref,
          status,
          effective_at::text AS effective_at,
          metadata,
          created_by::text AS created_by,
          created_at::text AS created_at
        FROM ai_release_records
        WHERE tenant_id = $1
          AND factory_id = $2
          AND (
            source_decision_id = $3
            OR metadata @> jsonb_build_object('decisionId', $3::text)
            OR metadata @> jsonb_build_object('traceId', $4::text)
          )
        ORDER BY created_at ASC
        `,
        [tenantId, factoryId, decision.id, traceId],
        { tenantId },
      );

    const replay = {
      traceId,
      decision: this.mapDecision(decision),
      contexts: contextResult.rows.map(
        (row) => this.mapContext(row),
      ),
      verifications:
        verificationResult.rows.map(
          (row) => ({
            id: row.id,
            status: row.status,
            checks: row.checks,
            contradictions:
              row.contradictions,
            calcValidation:
              row.calc_validation,
            policyChecks:
              row.policy_checks,
            reviewerResult:
              row.reviewer_result,
            contextPackageId:
              row.context_package_id,
            createdAt: row.created_at,
          }),
        ),
      actions: actionResult.rows.map(
        (row) =>
          this.mapActionIntent(
            row,
            false,
          ),
      ),
      executions:
        executionResult.rows.map(
          (row) =>
            this.mapExecution(row),
        ),
      outcomes:
        outcomeResult.rows.map(
          (row) =>
            this.mapOutcome(row),
        ),
      learningSignals:
        learningResult.rows.map(
          (row) =>
            this.mapLearningSignal(row),
        ),
      releases:
        releaseResult.rows.map(
          (row) => this.mapRelease(row),
        ),
    };

    const replayHash =
      this.computeHash(replay);

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'AI_REPLAY',
      action: 'READ',
      resourceType: 'AI_DECISION_ENVELOPE',
      resourceId: decision.id,
      payload: {
        traceId,
        replayHash,
      },
    });

    return {
      replayHash,
      replay,
    };
  }

  // ============================================================
  // PRIVATE: DECISION LOOKUPS
  // ============================================================

  private async getDecision(
    tenantId: string,
    factoryId: string,
    decisionId: string,
  ): Promise<DecisionRow | null> {
    const result =
      await this.database.query<DecisionRow>(
        this.decisionSelectSql(
          `
          d.id = $1
          AND d.tenant_id = $2
          AND d.factory_id = $3
          `,
        ),
        [
          decisionId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    return result.rows[0] ?? null;
  }

  private async getContextPackage(
    tenantId: string,
    factoryId: string,
    contextPackageId: string,
  ): Promise<ContextRow | null> {
    const result =
      await this.database.query<ContextRow>(
        `
        SELECT
          c.id::text AS id,
          c.tenant_id::text AS tenant_id,
          c.factory_id::text AS factory_id,
          c.decision_id::text AS decision_id,
          c.context_version,
          c.sources,
          c.permissions,
          c.freshness,
          c.evidence_states,
          c.package_hash,
          c.created_at::text AS created_at

        FROM ai_context_packages c

        WHERE
          c.id = $1
          AND c.tenant_id = $2
          AND c.factory_id = $3

        LIMIT 1
        `,
        [
          contextPackageId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    return result.rows[0] ?? null;
  }

  private async getLatestContextPackage(
    tenantId: string,
    factoryId: string,
    decisionId: string,
  ): Promise<ContextRow | null> {
    const result =
      await this.database.query<ContextRow>(
        `
        SELECT
          c.id::text AS id,
          c.tenant_id::text AS tenant_id,
          c.factory_id::text AS factory_id,
          c.decision_id::text AS decision_id,
          c.context_version,
          c.sources,
          c.permissions,
          c.freshness,
          c.evidence_states,
          c.package_hash,
          c.created_at::text AS created_at

        FROM ai_context_packages c

        WHERE
          c.decision_id = $1
          AND c.tenant_id = $2
          AND c.factory_id = $3

        ORDER BY
          c.created_at DESC

        LIMIT 1
        `,
        [
          decisionId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    return result.rows[0] ?? null;
  }

  private decisionSelectSql(
    where: string,
  ): string {
    return `
      SELECT
        d.id::text AS id,
        d.tenant_id::text AS tenant_id,
        d.factory_id::text AS factory_id,
        d.request_id::text AS request_id,
        d.trace_id::text AS trace_id,
        d.actor_id::text AS actor_id,
        d.objective,
        d.reasoning_mode,
        d.context_version,
        d.risk_class,
        d.output_state,
        d.metadata,
        d.created_at::text AS created_at,
        d.updated_at::text AS updated_at

      FROM ai_decision_envelopes d

      WHERE ${where}

      LIMIT 1
    `;
  }

  // ============================================================
  // PRIVATE: MAPPERS
  // ============================================================

  private mapDecision(
    row: DecisionRow,
  ) {
    return {
      id: row.id,
      tenantId:
        row.tenant_id,
      factoryId:
        row.factory_id,
      requestId:
        row.request_id,
      traceId:
        row.trace_id,
      actorId:
        row.actor_id,
      objective:
        row.objective,
      reasoningMode:
        row.reasoning_mode,
      contextVersion:
        row.context_version,
      riskClass:
        row.risk_class,
      outputState:
        row.output_state,
      metadata:
        row.metadata,
      createdAt:
        row.created_at,
      updatedAt:
        row.updated_at,
    };
  }

  private mapContext(
    row: ContextRow,
  ) {
    return {
      id: row.id,
      tenantId:
        row.tenant_id,
      factoryId:
        row.factory_id,
      decisionId:
        row.decision_id,
      contextVersion:
        row.context_version,
      sources:
        row.sources,
      permissions:
        row.permissions,
      freshness:
        row.freshness,
      evidenceStates:
        row.evidence_states,
      packageHash:
        row.package_hash,
      createdAt:
        row.created_at,
    };
  }

  private async getActionIntentByIdempotencyKey(
    tenantId: string,
    factoryId: string,
    idempotencyKey: string,
  ): Promise<ActionIntentRow | null> {
    const result =
      await this.database.query<ActionIntentRow>(
        this.actionIntentSelectSql(
          `
          a.tenant_id = $1
          AND a.factory_id = $2
          AND a.idempotency_key = $3
          `,
        ),
        [tenantId, factoryId, idempotencyKey],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private async getActionIntentByTokenHash(
    tenantId: string,
    factoryId: string,
    tokenHash: string,
  ): Promise<ActionIntentRow | null> {
    const result =
      await this.database.query<ActionIntentRow>(
        this.actionIntentSelectSql(
          `
          a.tenant_id = $1
          AND a.factory_id = $2
          AND a.action_token_hash = $3
          `,
        ),
        [tenantId, factoryId, tokenHash],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private async getActionIntentById(
    tenantId: string,
    factoryId: string,
    actionIntentId: string,
  ): Promise<ActionIntentRow | null> {
    const result =
      await this.database.query<ActionIntentRow>(
        this.actionIntentSelectSql(
          `
          a.tenant_id = $1
          AND a.factory_id = $2
          AND a.id = $3
          `,
        ),
        [tenantId, factoryId, actionIntentId],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private actionIntentSelectSql(
    where: string,
  ): string {
    return `
      SELECT
        a.id::text AS id,
        a.tenant_id::text AS tenant_id,
        a.factory_id::text AS factory_id,
        a.decision_id::text AS decision_id,
        a.action_type,
        a.tool_id,
        a.tool_version,
        a.target,
        a.resource_type,
        a.resource_id,
        a.payload,
        a.payload_hash,
        a.risk_class,
        a.authorization_status,
        a."authorization",
        a.approval_id::text AS approval_id,
        a.action_token_hash,
        a.token_expires_at::text AS token_expires_at,
        a.idempotency_key,
        a.created_by::text AS created_by,
        a.created_at::text AS created_at
      FROM ai_action_intents a
      WHERE ${where}
      LIMIT 1
    `;
  }

  private async getExecutionByActionIntent(
    tenantId: string,
    factoryId: string,
    actionIntentId: string,
  ): Promise<ExecutionRow | null> {
    const result =
      await this.database.query<ExecutionRow>(
        this.executionSelectSql(
          `
          e.tenant_id = $1
          AND e.factory_id = $2
          AND e.action_intent_id = $3
          `,
        ),
        [tenantId, factoryId, actionIntentId],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private async getExecutionByKey(
    tenantId: string,
    factoryId: string,
    executionKey: string,
  ): Promise<ExecutionRow | null> {
    const result =
      await this.database.query<ExecutionRow>(
        this.executionSelectSql(
          `
          e.tenant_id = $1
          AND e.factory_id = $2
          AND e.execution_key = $3
          `,
        ),
        [tenantId, factoryId, executionKey],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private async getExecutionById(
    tenantId: string,
    factoryId: string,
    executionId: string,
  ): Promise<ExecutionRow | null> {
    const result =
      await this.database.query<ExecutionRow>(
        this.executionSelectSql(
          `
          e.tenant_id = $1
          AND e.factory_id = $2
          AND e.id = $3
          `,
        ),
        [tenantId, factoryId, executionId],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private executionSelectSql(
    where: string,
  ): string {
    return `
      SELECT
        e.id::text AS id,
        e.tenant_id::text AS tenant_id,
        e.factory_id::text AS factory_id,
        e.decision_id::text AS decision_id,
        e.action_intent_id::text AS action_intent_id,
        e.execution_key,
        e.executor_type,
        e.tool_version,
        e.inputs_hash,
        e.result,
        e.error,
        e.status,
        e.started_at::text AS started_at,
        e.finished_at::text AS finished_at
      FROM ai_execution_records e
      WHERE ${where}
      LIMIT 1
    `;
  }

  private async getOutcomeById(
    tenantId: string,
    factoryId: string,
    outcomeId: string,
  ): Promise<OutcomeRow | null> {
    const result =
      await this.database.query<OutcomeRow>(
        this.outcomeSelectSql(
          `
          o.tenant_id = $1
          AND o.factory_id = $2
          AND o.id = $3
          `,
        ),
        [tenantId, factoryId, outcomeId],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private outcomeSelectSql(
    where: string,
  ): string {
    return `
      SELECT
        o.id::text AS id,
        o.tenant_id::text AS tenant_id,
        o.factory_id::text AS factory_id,
        o.decision_id::text AS decision_id,
        o.action_intent_id::text AS action_intent_id,
        o.execution_record_id::text AS execution_record_id,
        o.expected_metric,
        o.actual_metric,
        o.outcome_window,
        o.causal_notes,
        o.status,
        o.created_by::text AS created_by,
        o.created_at::text AS created_at
      FROM ai_outcome_links o
      WHERE ${where}
      LIMIT 1
    `;
  }

  private async getApprovalForScope(
    tenantId: string,
    approvalId: string,
  ) {
    const result =
      await this.database.query<{
        id: string;
        tenant_id: string;
        policy_id: string;
        risk_class_id: string | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        status: string;
        expires_at: string | null;
      }>(
        `
        SELECT
          a.id::text AS id,
          a.tenant_id::text AS tenant_id,
          a.policy_id::text AS policy_id,
          a.risk_class_id::text AS risk_class_id,
          a.action,
          a.resource_type,
          a.resource_id,
          a.status,
          a.expires_at::text AS expires_at
        FROM approvals a
        WHERE a.id = $1
          AND a.tenant_id = $2
        LIMIT 1
        `,
        [approvalId, tenantId],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private async getReleaseByArtifactVersion(
    tenantId: string,
    factoryId: string,
    artifactType: string,
    artifactKey: string,
    version: string,
  ): Promise<ReleaseRow | null> {
    const result =
      await this.database.query<ReleaseRow>(
        `
        SELECT
          r.id::text AS id,
          r.tenant_id::text AS tenant_id,
          r.factory_id::text AS factory_id,
          r.source_decision_id::text AS source_decision_id,
          r.artifact_type,
          r.artifact_key,
          r.version,
          r.tests,
          r.approval_id::text AS approval_id,
          r.rollback_ref,
          r.status,
          r.effective_at::text AS effective_at,
          r.metadata,
          r.created_by::text AS created_by,
          r.created_at::text AS created_at
        FROM ai_release_records r
        WHERE r.tenant_id = $1
          AND r.factory_id = $2
          AND r.artifact_type = $3
          AND r.artifact_key = $4
          AND r.version = $5
        LIMIT 1
        `,
        [
          tenantId,
          factoryId,
          artifactType,
          artifactKey,
          version,
        ],
        { tenantId },
      );
    return result.rows[0] ?? null;
  }

  private requiredUuid(
    value: unknown,
    field: string,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${field} is required`,
      );
    }
    this.validateUuid(value, field);
    return value;
  }

  private normalizeObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> {
    if (
      value === null ||
      value === undefined ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      throw new BadRequestException(
        `${field} must be an object`,
      );
    }
    return value as Record<string, unknown>;
  }

  private normalizeOutcomeStatus(
    value: string,
  ): 'EXPECTED' | 'PARTIAL' | 'OBSERVED' | 'FAILED' {
    const normalized = value
      .trim()
      .toUpperCase();
    if (
      normalized !== 'EXPECTED' &&
      normalized !== 'PARTIAL' &&
      normalized !== 'OBSERVED' &&
      normalized !== 'FAILED'
    ) {
      throw new BadRequestException(
        `Unsupported AI outcome status: ${value}`,
      );
    }
    return normalized;
  }

  private normalizeLearningScope(
    value: string,
  ): 'TENANT' | 'FACTORY' | 'GLOBAL_CANDIDATE' {
    const normalized = value
      .trim()
      .toUpperCase();
    if (
      normalized !== 'TENANT' &&
      normalized !== 'FACTORY' &&
      normalized !== 'GLOBAL_CANDIDATE'
    ) {
      throw new BadRequestException(
        `Unsupported AI learning tenant scope: ${value}`,
      );
    }
    return normalized;
  }

  private mapActionIntent(
    row: ActionIntentRow,
    includeToken: boolean,
  ) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      decisionId: row.decision_id,
      actionType: row.action_type,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      target: row.target,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      payload: row.payload,
      payloadHash: row.payload_hash,
      riskClass: row.risk_class,
      authorizationStatus:
        row.authorization_status,
      authorization:
        row.authorization,
      approvalId: row.approval_id,
      tokenExpiresAt:
        row.token_expires_at,
      idempotencyKey:
        row.idempotency_key,
      createdBy: row.created_by,
      createdAt: row.created_at,
      ...(includeToken
        ? {
            actionToken: null,
          }
        : {}),
    };
  }

  private mapExecution(
    row: ExecutionRow,
  ) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      decisionId: row.decision_id,
      actionIntentId:
        row.action_intent_id,
      executionKey:
        row.execution_key,
      executorType:
        row.executor_type,
      toolVersion:
        row.tool_version,
      inputsHash:
        row.inputs_hash,
      result: row.result,
      error: row.error,
      status: row.status,
      startedAt:
        row.started_at,
      finishedAt:
        row.finished_at,
    };
  }

  private mapOutcome(
    row: OutcomeRow,
  ) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      decisionId: row.decision_id,
      actionIntentId:
        row.action_intent_id,
      executionRecordId:
        row.execution_record_id,
      expectedMetric:
        row.expected_metric,
      actualMetric:
        row.actual_metric,
      outcomeWindow:
        row.outcome_window,
      causalNotes:
        row.causal_notes,
      status: row.status,
      createdBy:
        row.created_by,
      createdAt:
        row.created_at,
    };
  }

  private mapLearningSignal(
    row: LearningSignalRow,
  ) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      sourceDecisionId:
        row.source_decision_id,
      sourceOutcomeId:
        row.source_outcome_id,
      sourceExecutionId:
        row.source_execution_id,
      signalType:
        row.signal_type,
      label: row.label,
      confidence:
        this.normalizeNullableNumber(
          row.confidence,
        ),
      tenantScope:
        row.tenant_scope,
      payload: row.payload,
      createdBy:
        row.created_by,
      createdAt:
        row.created_at,
    };
  }

  private mapRelease(
    row: ReleaseRow,
  ) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      factoryId: row.factory_id,
      sourceDecisionId:
        row.source_decision_id,
      artifactType:
        row.artifact_type,
      artifactKey:
        row.artifact_key,
      version: row.version,
      tests: row.tests,
      approvalId:
        row.approval_id,
      rollbackRef:
        row.rollback_ref,
      status: row.status,
      effectiveAt:
        row.effective_at,
      metadata: row.metadata,
      createdBy:
        row.created_by,
      createdAt:
        row.created_at,
    };
  }

  // ============================================================
  // PRIVATE: NORMALIZATION
  // ============================================================

  private normalizeEvidenceStates(
    requested: string[] | undefined,
  ): string[] {
    const states =
      requested && requested.length > 0
        ? requested
        : [
            'VERIFIED',
            'INFERRED',
          ];

    const normalized = states.map(
      (value) => value.trim().toUpperCase(),
    );

    for (const value of normalized) {
      if (
        value !== 'VERIFIED' &&
        value !== 'INFERRED'
      ) {
        throw new BadRequestException(
          'requested_evidence_states must contain only VERIFIED or INFERRED',
        );
      }
    }

    return Array.from(
      new Set(normalized),
    );
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

  private optionalString(
    value: string | null | undefined,
    field: string,
    maxLength: number,
  ): string | null {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    return this.requiredString(
      value,
      field,
      maxLength,
    );
  }

  private validateScope(
    tenantId: string,
    factoryId: string,
  ): void {
    this.validateUuid(
      tenantId,
      'tenantId',
    );
    this.validateUuid(
      factoryId,
      'factoryId',
    );
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

  private normalizeNullableNumber(
    value:
      | number
      | string
      | null
      | undefined,
  ): number | null {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    const number = Number(value);

    return Number.isFinite(number)
      ? number
      : null;
  }

  private buildFreshness(
    latestEvidenceAt: string | null,
  ): Record<string, unknown> {
    if (!latestEvidenceAt) {
      return {
        latestEvidenceTimestamp: null,
        sourceCount: 0,
        status: 'NO_EVIDENCE',
      };
    }

    const timestamp =
      new Date(latestEvidenceAt);

    if (Number.isNaN(timestamp.getTime())) {
      return {
        latestEvidenceTimestamp:
          latestEvidenceAt,
        sourceCount: 0,
        status: 'UNKNOWN',
      };
    }

    const ageSeconds =
      Math.max(
        0,
        Math.floor(
          (Date.now() -
            timestamp.getTime()) /
            1000,
        ),
      );

    return {
      latestEvidenceTimestamp:
        latestEvidenceAt,
      ageSeconds,
      status: 'AVAILABLE',
    };
  }

  private computeHash(
    value: unknown,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          this.canonicalize(value),
        ),
        'utf8',
      )
      .digest('hex');
  }

  private canonicalize(
    value: unknown,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item) =>
        this.canonicalize(item),
      );
    }

    if (
      value !== null &&
      typeof value === 'object'
    ) {
      const object =
        value as Record<
          string,
          unknown
        >;

      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [
            key,
            this.canonicalize(
              object[key],
            ),
          ]),
      );
    }

    return value;
  }

  private isObject(
    value: unknown,
  ): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }

  private isUniqueViolation(
    error: unknown,
  ): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (
        error as { code?: string }
      ).code === '23505'
    );
  }

  // ============================================================
  // PRIVATE: AUDIT
  // ============================================================

  private async recordAuditSafely(
    input: {
      tenantId: string;
      factoryId: string;
      actorUserId: string;
      eventType: string;
      action: string;
      resourceType: string;
      resourceId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.auditService.record({
        tenantId:
          input.tenantId,
        factoryId:
          input.factoryId,
        actorUserId:
          input.actorUserId,
        eventType:
          input.eventType,
        action:
          input.action,
        resourceType:
          input.resourceType,
        resourceId:
          input.resourceId,
        dataClass: 'INTERNAL',
        payload:
          input.payload,
      });
    } catch {
      // AI runtime state has already committed.
    }
  }
}
