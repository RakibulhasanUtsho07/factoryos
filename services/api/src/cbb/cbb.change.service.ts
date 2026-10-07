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
  PoolClient,
  QueryResultRow,
} from 'pg';
import { BusinessChangeState, BusinessChangeTargetType } from './dto/create-business-change.dto';
import { BusinessChangeStatus } from './dto/list-business-changes.dto';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';




interface ChangeProposalRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  blueprint_id: string;

  target_type:
    BusinessChangeTargetType;

  target_id:
    | string
    | null;

  proposal_type: string;

  proposed_state:
    | BusinessChangeState
    | null;

  proposed_payload:
    Record<string, unknown>;

  status:
    BusinessChangeStatus;

  reason:
    | string
    | null;

  requested_by:
    | string
    | null;

  decided_by:
    | string
    | null;

  requested_at: string;

  decided_at:
    | string
    | null;

  decision_reason:
    | string
    | null;
}

interface BlueprintScopeRow
  extends QueryResultRow {
  id: string;

  current_version_id:
    string;
}

interface FeedbackRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  factory_id: string;

  subject_type: string;

  subject_id: string;

  feedback_type: string;

  payload_json:
    Record<string, unknown>;

  created_by:
    | string
    | null;

  created_at: string;
}

@Injectable()
export class CbbChangeService {
  constructor(
    private readonly database:
      DatabaseService,

    private readonly auditService:
      AuditService,
  ) {}

  // ============================================================
  // CREATE CHANGE PROPOSAL
  // ============================================================

  async createChangeProposal(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: {
      targetType:
        BusinessChangeTargetType;

      targetId:
        | string
        | null;

      proposalType: string;

      proposedState:
        | BusinessChangeState
        | null;

      proposedPayload:
        Record<string, unknown>;

      reason:
        | string
        | null;
    },
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    this.validateUuid(
      actorUserId,
      'actorUserId',
    );

    const normalized =
      this.normalizeCreateInput(
        input,
      );

    const created =
      await this.database.transaction<
        ChangeProposalRow
      >(
        async (
          client: PoolClient,
        ) => {
          const blueprintResult =
            await client.query<BlueprintScopeRow>(
              `
              SELECT
                b.id::text AS id,

                b.current_version_id::text
                  AS current_version_id

              FROM business_blueprints b

              WHERE
                b.tenant_id = $1

                AND b.factory_id = $2

                AND b.status = 'ACTIVE'

              LIMIT 1
              `,
              [
                tenantId,
                factoryId,
              ],
            );

          const blueprint =
            blueprintResult.rows[0];

          if (!blueprint) {
            throw new NotFoundException(
              'Business blueprint not found for this factory',
            );
          }

          if (
            !blueprint.current_version_id
          ) {
            throw new ConflictException(
              'Business blueprint has no current version',
            );
          }

          await this.validateTarget(
            client,
            tenantId,
            factoryId,
            blueprint.current_version_id,
            normalized.targetType,
            normalized.targetId,
          );

          const result =
            await client.query<ChangeProposalRow>(
              `
              INSERT INTO business_change_proposals (
                tenant_id,
                factory_id,
                blueprint_id,
                target_type,
                target_id,
                proposal_type,
                proposed_state,
                proposed_payload,
                status,
                reason,
                requested_by
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
                'PENDING',
                $9,
                $10
              )

              RETURNING
                id::text AS id,

                tenant_id::text
                  AS tenant_id,

                factory_id::text
                  AS factory_id,

                blueprint_id::text
                  AS blueprint_id,

                target_type,

                target_id::text
                  AS target_id,

                proposal_type,

                proposed_state,

                proposed_payload,

                status,

                reason,

                requested_by::text
                  AS requested_by,

                decided_by::text
                  AS decided_by,

                requested_at::text
                  AS requested_at,

                decided_at::text
                  AS decided_at,

                decision_reason
              `,
              [
                tenantId,
                factoryId,
                blueprint.id,
                normalized.targetType,
                normalized.targetId,
                normalized.proposalType,
                normalized.proposedState,
                JSON.stringify(
                  normalized.proposedPayload,
                ),
                normalized.reason,
                actorUserId,
              ],
            );

          const row =
            result.rows[0];

          if (!row) {
            throw new Error(
              'BUSINESS_CHANGE_PROPOSAL_INSERT_FAILED',
            );
          }

          return row;
        },
        {
          tenantId,
          userId:
            actorUserId,
        },
      );

    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType:
        'BUSINESS_MODEL_CHANGE',
      action:
        'CREATE_PROPOSAL',
      resourceType:
        'BUSINESS_CHANGE_PROPOSAL',
      resourceId:
        created.id,
      payload: {
        factoryId:
          created.factory_id,

        blueprintId:
          created.blueprint_id,

        targetType:
          created.target_type,

        targetId:
          created.target_id,

        proposalType:
          created.proposal_type,

        proposedState:
          created.proposed_state,

        status:
          created.status,

        reason:
          created.reason,

        result:
          'CREATED',
      },
    });

    return this.mapChangeProposal(
      created,
    );
  }

  // ============================================================
  // LIST CHANGE PROPOSALS
  // ============================================================

  async listChangeProposals(
    tenantId: string,
    factoryId: string,
    options: {
      status?:
        BusinessChangeStatus;

      targetType?:
        BusinessChangeTargetType;

      limit?:
        number;

      offset?:
        number;
    } = {},
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    const limit =
      this.normalizeLimit(
        options.limit,
      );

    const offset =
      this.normalizeOffset(
        options.offset,
      );

    const values: unknown[] = [
      tenantId,
      factoryId,
    ];

    const conditions = [
      'cp.tenant_id = $1',
      'cp.factory_id = $2',
    ];

    if (
      options.status !==
      undefined
    ) {
      const status =
        this.normalizeStatus(
          options.status,
        );

      values.push(
        status,
      );

      conditions.push(
        `cp.status = $${values.length}`,
      );
    }

    if (
      options.targetType !==
      undefined
    ) {
      const targetType =
        this.normalizeTargetType(
          options.targetType,
        );

      values.push(
        targetType,
      );

      conditions.push(
        `cp.target_type = $${values.length}`,
      );
    }

    const limitParameter =
      values.length + 1;

    const offsetParameter =
      values.length + 2;

    values.push(
      limit,
      offset,
    );

    const result =
      await this.database.query<ChangeProposalRow>(
        `
        SELECT
          cp.id::text AS id,

          cp.tenant_id::text
            AS tenant_id,

          cp.factory_id::text
            AS factory_id,

          cp.blueprint_id::text
            AS blueprint_id,

          cp.target_type,

          cp.target_id::text
            AS target_id,

          cp.proposal_type,

          cp.proposed_state,

          cp.proposed_payload,

          cp.status,

          cp.reason,

          cp.requested_by::text
            AS requested_by,

          cp.decided_by::text
            AS decided_by,

          cp.requested_at::text
            AS requested_at,

          cp.decided_at::text
            AS decided_at,

          cp.decision_reason

        FROM business_change_proposals cp

        WHERE
          ${conditions.join(
            '\n          AND ',
          )}

        ORDER BY
          CASE
            WHEN cp.status = 'PENDING'
              THEN 0
            ELSE 1
          END,

          cp.requested_at DESC

        LIMIT $${limitParameter}

        OFFSET $${offsetParameter}
        `,
        values,
        {
          tenantId,
        },
      );

    return {
      items:
        result.rows.map(
          (
            row: ChangeProposalRow,
          ) =>
            this.mapChangeProposal(
              row,
            ),
        ),

      limit,

      offset,

      count:
        result.rows.length,
    };
  }

  // ============================================================
  // APPROVE
  // ============================================================

  async approveChangeProposal(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    proposalId: string,
    reason?:
      | string
      | null,
  ) {
    return this.decideChangeProposal(
      tenantId,
      factoryId,
      actorUserId,
      proposalId,
      'APPROVED',
      reason,
    );
  }

  // ============================================================
  // REJECT
  // ============================================================

  async rejectChangeProposal(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    proposalId: string,
    reason:
      | string
      | null,
  ) {
    return this.decideChangeProposal(
      tenantId,
      factoryId,
      actorUserId,
      proposalId,
      'REJECTED',
      reason,
    );
  }

  // ============================================================
  // FEEDBACK
  // ============================================================

  async createFeedback(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    input: {
      subjectType: string;

      subjectId: string;

      feedbackType: string;

      payload:
        Record<string, unknown>;
    },
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    this.validateUuid(
      actorUserId,
      'actorUserId',
    );

    this.validateUuid(
      input.subjectId,
      'subjectId',
    );

    const subjectType =
      this.normalizeSubjectType(
        input.subjectType,
      );

    const feedbackType =
      this.normalizeRequiredString(
        input.feedbackType,
        'feedbackType',
        100,
      );

    const payload =
      this.normalizeObject(
        input.payload,
        'payload',
      );

    const result =
      await this.database.query<FeedbackRow>(
        `
        INSERT INTO business_feedback (
          tenant_id,
          factory_id,
          subject_type,
          subject_id,
          feedback_type,
          payload_json,
          created_by
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7
        )

        RETURNING
          id::text AS id,

          tenant_id::text
            AS tenant_id,

          factory_id::text
            AS factory_id,

          subject_type,

          subject_id::text
            AS subject_id,

          feedback_type,

          payload_json,

          created_by::text
            AS created_by,

          created_at::text
            AS created_at
        `,
        [
          tenantId,
          factoryId,
          subjectType,
          input.subjectId,
          feedbackType,
          JSON.stringify(
            payload,
          ),
          actorUserId,
        ],
        {
          tenantId,
          userId:
            actorUserId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      throw new Error(
        'BUSINESS_FEEDBACK_INSERT_FAILED',
      );
    }

    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType:
        'BUSINESS_MODEL_FEEDBACK',
      action:
        'CREATE',
      resourceType:
        'BUSINESS_FEEDBACK',
      resourceId:
        row.id,
      payload: {
        factoryId:
          row.factory_id,

        subjectType:
          row.subject_type,

        subjectId:
          row.subject_id,

        feedbackType:
          row.feedback_type,

        result:
          'CREATED',
      },
    });

    return {
      id:
        row.id,

      tenantId:
        row.tenant_id,

      factoryId:
        row.factory_id,

      subjectType:
        row.subject_type,

      subjectId:
        row.subject_id,

      feedbackType:
        row.feedback_type,

      payload:
        row.payload_json,

      createdBy:
        row.created_by,

      createdAt:
        row.created_at,
    };
  }

  // ============================================================
  // DECISION CORE
  // ============================================================

  private async decideChangeProposal(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    proposalId: string,
    status:
      | 'APPROVED'
      | 'REJECTED',
    reason?:
      | string
      | null,
  ) {
    this.validateScope(
      tenantId,
      factoryId,
    );

    this.validateUuid(
      actorUserId,
      'actorUserId',
    );

    this.validateUuid(
      proposalId,
      'proposalId',
    );

    const normalizedReason =
      reason === null ||
      reason === undefined
        ? null
        : reason.trim();

    if (
      normalizedReason &&
      normalizedReason.length >
        2000
    ) {
      throw new BadRequestException(
        'reason must not exceed 2000 characters',
      );
    }

    if (
      status === 'REJECTED' &&
      !normalizedReason
    ) {
      throw new BadRequestException(
        'reason is required when rejecting a change proposal',
      );
    }

    const result =
      await this.database.query<ChangeProposalRow>(
        `
        UPDATE business_change_proposals

        SET
          status = $1,

          decided_by = $2,

          decided_at = NOW(),

          decision_reason = $3

        WHERE
          id = $4

          AND tenant_id = $5

          AND factory_id = $6

          AND status = 'PENDING'

        RETURNING
          id::text AS id,

          tenant_id::text
            AS tenant_id,

          factory_id::text
            AS factory_id,

          blueprint_id::text
            AS blueprint_id,

          target_type,

          target_id::text
            AS target_id,

          proposal_type,

          proposed_state,

          proposed_payload,

          status,

          reason,

          requested_by::text
            AS requested_by,

          decided_by::text
            AS decided_by,

          requested_at::text
            AS requested_at,

          decided_at::text
            AS decided_at,

          decision_reason
        `,
        [
          status,
          actorUserId,
          normalizedReason,
          proposalId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
          userId:
            actorUserId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      const existing =
        await this.getChangeProposalById(
          tenantId,
          factoryId,
          proposalId,
        );

      if (!existing) {
        throw new NotFoundException(
          'Business change proposal not found for this factory',
        );
      }

      throw new ConflictException(
        `Business change proposal is already ${existing.status.toLowerCase()}`,
      );
    }

    /*
     * IMPORTANT:
     *
     * Approval changes workflow state only.
     *
     * Immutable CBB graph/version rows are NOT modified here.
     *
     * A later promotion slice will create a new immutable
     * blueprint version.
     */
    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType:
        'BUSINESS_MODEL_CHANGE',
      action:
        status === 'APPROVED'
          ? 'APPROVE_PROPOSAL'
          : 'REJECT_PROPOSAL',
      resourceType:
        'BUSINESS_CHANGE_PROPOSAL',
      resourceId:
        row.id,
      payload: {
        factoryId:
          row.factory_id,

        blueprintId:
          row.blueprint_id,

        targetType:
          row.target_type,

        targetId:
          row.target_id,

        proposalType:
          row.proposal_type,

        status:
          row.status,

        requestedBy:
          row.requested_by,

        decidedBy:
          row.decided_by,

        decisionReason:
          row.decision_reason,

        result:
          status,
      },
    });

    return this.mapChangeProposal(
      row,
    );
  }

  // ============================================================
  // TARGET VALIDATION
  // ============================================================

  private async validateTarget(
    client: PoolClient,
    tenantId: string,
    factoryId: string,
    versionId: string,
    targetType:
      BusinessChangeTargetType,
    targetId:
      | string
      | null,
  ): Promise<void> {
    /*
     * NULL target_id is valid for a proposal that creates a new
     * business-model object.
     */
    if (!targetId) {
      return;
    }

    let exists =
      false;

    switch (
      targetType
    ) {
      case 'BLUEPRINT': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_blueprints

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'ENTITY': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_entities

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'RELATION': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_relations

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'PROCESS': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_processes

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'PROCESS_STEP': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_process_steps

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'RULE': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_rules

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'TERM': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_terms

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }

      case 'EXCEPTION': {
        const result =
          await client.query<{ id: string }>(
            `
            SELECT
              id::text AS id

            FROM business_exceptions

            WHERE
              id = $1

              AND tenant_id = $2

              AND factory_id = $3

              AND blueprint_version_id = $4

            LIMIT 1
            `,
            [
              targetId,
              tenantId,
              factoryId,
              versionId,
            ],
          );

        exists =
          result.rows.length >
          0;

        break;
      }
    }

    if (!exists) {
      throw new NotFoundException(
        `${targetType} target was not found in the current factory business model`,
      );
    }
  }

  // ============================================================
  // SINGLE LOOKUP
  // ============================================================

  private async getChangeProposalById(
    tenantId: string,
    factoryId: string,
    proposalId: string,
  ) {
    const result =
      await this.database.query<ChangeProposalRow>(
        `
        SELECT
          cp.id::text AS id,

          cp.tenant_id::text
            AS tenant_id,

          cp.factory_id::text
            AS factory_id,

          cp.blueprint_id::text
            AS blueprint_id,

          cp.target_type,

          cp.target_id::text
            AS target_id,

          cp.proposal_type,

          cp.proposed_state,

          cp.proposed_payload,

          cp.status,

          cp.reason,

          cp.requested_by::text
            AS requested_by,

          cp.decided_by::text
            AS decided_by,

          cp.requested_at::text
            AS requested_at,

          cp.decided_at::text
            AS decided_at,

          cp.decision_reason

        FROM business_change_proposals cp

        WHERE
          cp.id = $1

          AND cp.tenant_id = $2

          AND cp.factory_id = $3

        LIMIT 1
        `,
        [
          proposalId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    const row =
      result.rows[0];

    return row
      ? this.mapChangeProposal(
          row,
        )
      : null;
  }

  // ============================================================
  // MAPPER
  // ============================================================

  private mapChangeProposal(
    row: ChangeProposalRow,
  ) {
    return {
      id:
        row.id,

      tenantId:
        row.tenant_id,

      factoryId:
        row.factory_id,

      blueprintId:
        row.blueprint_id,

      targetType:
        row.target_type,

      targetId:
        row.target_id,

      proposalType:
        row.proposal_type,

      proposedState:
        row.proposed_state,

      proposedPayload:
        row.proposed_payload,

      status:
        row.status,

      reason:
        row.reason,

      requestedBy:
        row.requested_by,

      decidedBy:
        row.decided_by,

      requestedAt:
        row.requested_at,

      decidedAt:
        row.decided_at,

      decisionReason:
        row.decision_reason,
    };
  }

  // ============================================================
  // NORMALIZE CREATE INPUT
  // ============================================================

  private normalizeCreateInput(
    input: {
      targetType:
        BusinessChangeTargetType;

      targetId:
        | string
        | null;

      proposalType: string;

      proposedState:
        | BusinessChangeState
        | null;

      proposedPayload:
        Record<string, unknown>;

      reason:
        | string
        | null;
    },
  ) {
    const targetType =
      this.normalizeTargetType(
        input.targetType,
      );

    const targetId =
      input.targetId === null ||
      input.targetId === undefined
        ? null
        : input.targetId;

    if (targetId) {
      this.validateUuid(
        targetId,
        'targetId',
      );
    }

    const proposalType =
      this.normalizeRequiredString(
        input.proposalType,
        'proposalType',
        100,
      );

    const proposedState =
      input.proposedState === null ||
      input.proposedState === undefined
        ? null
        : this.normalizeState(
            input.proposedState,
          );

    const proposedPayload =
      this.normalizeObject(
        input.proposedPayload,
        'proposedPayload',
      );

    const reason =
      input.reason === null ||
      input.reason === undefined
        ? null
        : input.reason.trim();

    if (
      reason &&
      reason.length >
        2000
    ) {
      throw new BadRequestException(
        'reason must not exceed 2000 characters',
      );
    }

    return {
      targetType,
      targetId,
      proposalType,
      proposedState,
      proposedPayload,
      reason,
    };
  }

  // ============================================================
  // NORMALIZERS
  // ============================================================

  private normalizeTargetType(
    value: string,
  ): BusinessChangeTargetType {
    const normalized =
      value.trim().toUpperCase();

    const allowed = [
      'BLUEPRINT',
      'ENTITY',
      'RELATION',
      'PROCESS',
      'PROCESS_STEP',
      'RULE',
      'TERM',
      'EXCEPTION',
    ];

    if (
      !allowed.includes(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `Unsupported business change target type: ${value}`,
      );
    }

    return normalized as BusinessChangeTargetType;
  }

  private normalizeSubjectType(
    value: string,
  ): string {
    const normalized =
      value.trim().toUpperCase();

    const allowed = [
      'BLUEPRINT',
      'ENTITY',
      'RELATION',
      'PROCESS',
      'PROCESS_STEP',
      'RULE',
      'TERM',
      'EXCEPTION',
      'CHANGE_PROPOSAL',
      'CONFLICT',
      'EVIDENCE',
    ];

    if (
      !allowed.includes(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `Unsupported business feedback subject type: ${value}`,
      );
    }

    return normalized;
  }

  private normalizeStatus(
    value: string,
  ): BusinessChangeStatus {
    const normalized =
      value.trim().toUpperCase();

    const allowed = [
      'PENDING',
      'APPROVED',
      'REJECTED',
      'CANCELLED',
    ];

    if (
      !allowed.includes(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `Unsupported business change status: ${value}`,
      );
    }

    return normalized as BusinessChangeStatus;
  }

  private normalizeState(
    value: string,
  ): BusinessChangeState {
    const normalized =
      value.trim().toUpperCase();

    const allowed = [
      'VERIFIED',
      'INFERRED',
      'PROPOSED',
      'CONFLICTING',
      'STALE',
    ];

    if (
      !allowed.includes(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `Unsupported business change state: ${value}`,
      );
    }

    return normalized as BusinessChangeState;
  }

  private normalizeRequiredString(
    value: string,
    field: string,
    maxLength: number,
  ): string {
    const normalized =
      value.trim();

    if (!normalized) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    if (
      normalized.length >
      maxLength
    ) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private normalizeObject(
    value:
      | Record<string, unknown>
      | undefined,
    field: string,
  ): Record<string, unknown> {
    if (
      value === undefined ||
      value === null
    ) {
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

    return value;
  }

  private normalizeLimit(
    value?: number,
  ): number {
    if (
      value === undefined ||
      Number.isNaN(value)
    ) {
      return 50;
    }

    return Math.min(
      Math.max(
        Math.trunc(value),
        1,
      ),
      100,
    );
  }

  private normalizeOffset(
    value?: number,
  ): number {
    if (
      value === undefined ||
      Number.isNaN(value)
    ) {
      return 0;
    }

    return Math.max(
      Math.trunc(value),
      0,
    );
  }

  // ============================================================
  // UUID
  // ============================================================

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
    if (
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  // ============================================================
  // AUDIT
  // ============================================================

  private async recordAuditSafely(
    input: {
      tenantId: string;

      actorUserId:
        | string
        | null;

      eventType: string;

      action: string;

      resourceType: string;

      resourceId: string;

      payload:
        Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.auditService.record({
        tenantId:
          input.tenantId,

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

        dataClass:
          'INTERNAL',

        payload:
          input.payload,
      });
    } catch {
      /*
       * Audit failure must not replace a successful workflow
       * transition with an unrelated audit/database error.
       */
    }
  }
}