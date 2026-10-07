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
