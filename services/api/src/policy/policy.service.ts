import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUUID } from 'class-validator';

import type { QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

export type RiskClassStatus =
  | 'ACTIVE'
  | 'DISABLED'
  | 'EXPIRED';

export type PolicyStatus =
  | 'ACTIVE'
  | 'DISABLED'
  | 'EXPIRED';

export type PolicyEffect =
  | 'ALLOW'
  | 'DENY';

export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export type PolicyEvaluationOutcome =
  | 'ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'DENIED';

export interface CreateRiskClassInput {
  code: string;
  name: string;
  description?: string | null;
  defaultApprovalRequired?: boolean;
  status?: RiskClassStatus;
  effectiveFrom?: string | Date;
  effectiveTo?: string | Date | null;
}

export interface ListRiskClassesOptions {
  code?: string;
  status?: RiskClassStatus;
  limit?: number;
  offset?: number;
}

export interface CreatePolicyInput {
  key: string;
  action: string;
  resourceType?: string | null;
  effect?: PolicyEffect;
  riskClassId?: string | null;
  approvalRequired?: boolean;
  conditions?: Record<string, unknown>;
  approvalRoute?: Record<string, unknown>;
  status?: PolicyStatus;
  priority?: number;
  effectiveFrom?: string | Date;
  effectiveTo?: string | Date | null;
  changeReason?: string | null;
}

export interface ListPoliciesOptions {
  key?: string;
  action?: string;
  effect?: PolicyEffect;
  status?: PolicyStatus;
  limit?: number;
  offset?: number;
}

export interface EvaluatePolicyInput {
  action: string;
  resourceType?: string | null;
  attributes?: Record<string, unknown>;
  effectiveAt?: string | Date;
}

export interface ListApprovalsOptions {
  status?: ApprovalStatus;
  action?: string;
  limit?: number;
  offset?: number;
}

export interface CreateApprovalInput {
  policyId: string;
  riskClassId?: string | null;
  idempotencyKey?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: string | Date | null;
}

interface RiskClassRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  version: string;
  default_approval_required: boolean;
  status: RiskClassStatus;
  effective_from: string;
  effective_to: string | null;
  created_by: string | null;
  created_at: string;
}

interface PolicyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  key: string;
  version: string;
  status: PolicyStatus;
  priority: number;
  action: string;
  resource_type: string | null;
  effect: PolicyEffect;
  risk_class_id: string | null;
  risk_class_code: string | null;
  risk_class_name: string | null;
  risk_class_version: string | null;
  risk_class_default_approval_required: boolean | null;
  risk_class_status: RiskClassStatus | null;
  approval_required: boolean;
  conditions: Record<string, unknown>;
  approval_route: Record<string, unknown>;
  effective_from: string;
  effective_to: string | null;
  created_by: string | null;
  change_reason: string | null;
  created_at: string;
}

interface ApprovalRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  policy_id: string;
  risk_class_id: string | null;
  idempotency_key: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  requested_by: string;
  status: ApprovalStatus;
  metadata: Record<string, unknown>;
  requested_at: string;
  expires_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
}

@Injectable()
export class PolicyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  // ============================================================
  // RISK CLASSES
  // ============================================================

  async createRiskClass(
    tenantId: string,
    actorUserId: string | null,
    input: CreateRiskClassInput,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateOptionalUuid(actorUserId, 'actorUserId');

    const normalized = this.normalizeCreateRiskClassInput(input);

    const created =
      await this.insertRiskClassVersionWithRetry(
        tenantId,
        actorUserId,
        normalized,
      );

    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType: 'RISK_CLASS',
      action: 'CREATE_VERSION',
      resourceType: 'RISK_CLASS',
      resourceId: created.id,
      payload: {
        code: created.code,
        version: created.version,
        status: created.status,
        defaultApprovalRequired:
          created.default_approval_required,
        effectiveFrom: created.effective_from,
        effectiveTo: created.effective_to,
        result: 'CREATED',
      },
    });

    return this.mapRiskClassRow(created);
  }

  async getRiskClass(
    tenantId: string,
    riskClassId: string,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(riskClassId, 'riskClassId');

    const result =
      await this.database.query<RiskClassRow>(
        `
        SELECT
          r.id::text AS id,
          r.tenant_id::text AS tenant_id,
          r.code,
          r.name,
          r.description,
          r.version::text AS version,
          r.default_approval_required,
          r.status,
          r.effective_from::text AS effective_from,
          r.effective_to::text AS effective_to,
          r.created_by::text AS created_by,
          r.created_at::text AS created_at
        FROM risk_classes r
        WHERE
          r.id = $1
          AND r.tenant_id = $2
        LIMIT 1
        `,
        [riskClassId, tenantId],
        { tenantId },
      );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapRiskClassRow(row);
  }

  async listRiskClasses(
    tenantId: string,
    options: ListRiskClassesOptions = {},
  ) {
    this.validateUuid(tenantId, 'tenantId');

    const limit = this.normalizeLimit(options.limit);
    const offset = this.normalizeOffset(options.offset);

    const values: unknown[] = [tenantId];
    const conditions = ['r.tenant_id = $1'];

    if (options.code !== undefined) {
      const code = this.normalizeRequiredString(
        options.code,
        'code',
        20,
      );

      values.push(code);
      conditions.push(
        `r.code = $${values.length}`,
      );
    }

    if (options.status !== undefined) {
      const status = this.normalizeRiskClassStatus(
        options.status,
      );

      values.push(status);
      conditions.push(
        `r.status = $${values.length}`,
      );
    }

    values.push(limit, offset);

    const result =
      await this.database.query<RiskClassRow>(
        `
        SELECT
          r.id::text AS id,
          r.tenant_id::text AS tenant_id,
          r.code,
          r.name,
          r.description,
          r.version::text AS version,
          r.default_approval_required,
          r.status,
          r.effective_from::text AS effective_from,
          r.effective_to::text AS effective_to,
          r.created_by::text AS created_by,
          r.created_at::text AS created_at
        FROM risk_classes r
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY
          r.code ASC,
          r.version DESC
        LIMIT $${values.length - 1}
        OFFSET $${values.length}
        `,
        values,
        { tenantId },
      );

    return {
      items: result.rows.map((row) =>
        this.mapRiskClassRow(row),
      ),
      limit,
      offset,
      count: result.rows.length,
    };
  }

  // ============================================================
  // POLICIES
  // ============================================================

  async createPolicy(
    tenantId: string,
    actorUserId: string | null,
    input: CreatePolicyInput,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateOptionalUuid(actorUserId, 'actorUserId');

    const normalized = this.normalizeCreatePolicyInput(input);

    const created =
      await this.insertPolicyVersionWithRetry(
        tenantId,
        actorUserId,
        normalized,
      );

    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType: 'POLICY',
      action: 'CREATE_VERSION',
      resourceType: 'POLICY',
      resourceId: created.id,
      payload: {
        key: created.key,
        version: created.version,
        action: created.action,
        effect: created.effect,
        riskClassId: created.risk_class_id,
        approvalRequired: created.approval_required,
        priority: created.priority,
        status: created.status,
        changeReason: created.change_reason,
        effectiveFrom: created.effective_from,
        effectiveTo: created.effective_to,
        result: 'CREATED',
      },
    });

    return this.getPolicy(tenantId, created.id);
  }

  async getPolicy(
    tenantId: string,
    policyId: string,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(policyId, 'policyId');

    const result =
      await this.database.query<PolicyRow>(
        this.policySelectSql(`
          p.id = $1
          AND p.tenant_id = $2
        `),
        [policyId, tenantId],
        { tenantId },
      );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapPolicyRow(row);
  }

  async listPolicies(
    tenantId: string,
    options: ListPoliciesOptions = {},
  ) {
    this.validateUuid(tenantId, 'tenantId');

    const limit = this.normalizeLimit(options.limit);
    const offset = this.normalizeOffset(options.offset);

    const values: unknown[] = [tenantId];
    const conditions = ['p.tenant_id = $1'];

    if (options.key !== undefined) {
      const key = this.normalizeRequiredString(
        options.key,
        'key',
        200,
      );

      values.push(key);
      conditions.push(
        `p.key = $${values.length}`,
      );
    }

    if (options.action !== undefined) {
      const action = this.normalizeRequiredString(
        options.action,
        'action',
        200,
      );

      values.push(action);
      conditions.push(
        `p.action = $${values.length}`,
      );
    }

    if (options.effect !== undefined) {
      const effect = this.normalizePolicyEffect(
        options.effect,
      );

      values.push(effect);
      conditions.push(
        `p.effect = $${values.length}`,
      );
    }

    if (options.status !== undefined) {
      const status = this.normalizePolicyStatus(
        options.status,
      );

      values.push(status);
      conditions.push(
        `p.status = $${values.length}`,
      );
    }

    values.push(limit, offset);

    const sql = this.policySelectSql(
      `
          ${conditions.join('\n          AND ')}
        `,
      `
        ORDER BY
          p.key ASC,
          p.version DESC
        LIMIT $${values.length - 1}
        OFFSET $${values.length}
      `,
    );

    const result =
      await this.database.query<PolicyRow>(
        sql,
        values,
        { tenantId },
      );

    return {
      items: result.rows.map((row) =>
        this.mapPolicyRow(row),
      ),
      limit,
      offset,
      count: result.rows.length,
    };
  }

  // ============================================================
  // POLICY EVALUATION
  // ============================================================
  //
  // Evaluation is deterministic and fail-closed:
  //
  //   no matching policy => DENIED
  //   matching ALLOW without active risk class => DENIED
  //   matching ALLOW with approval => APPROVAL_REQUIRED
  //   matching ALLOW without approval => ALLOWED
  //   database/evaluation failure => DENIED + safeDefault
  //
  // Conditions use JSONB containment. A policy condition object
  // is treated as a required subset of the caller's attributes.
  // Example:
  //   policy.conditions = { "role": "planner" }
  //   attributes = { "role": "planner", "factory": "F1" }
  // ============================================================

  async evaluatePolicy(
    tenantId: string,
    input: EvaluatePolicyInput,
  ): Promise<{
    outcome: PolicyEvaluationOutcome;
    risk: {
      class: string | null;
      policyRef: {
        id: string;
        key: string;
        version: string;
      } | null;
      approvalRequired: boolean;
    };
    policy: ReturnType<PolicyService['mapPolicyRow']> | null;
    safeDefault: boolean;
    reason: string;
  }> {
    this.validateUuid(tenantId, 'tenantId');

    const action = this.normalizeRequiredString(
      input.action,
      'action',
      200,
    );

    const resourceType =
      input.resourceType === null ||
      input.resourceType === undefined
        ? null
        : this.normalizeRequiredString(
            input.resourceType,
            'resourceType',
            150,
          );

    const attributes =
      input.attributes === undefined
        ? {}
        : this.normalizeObject(
            input.attributes,
            'attributes',
          );

    const effectiveAt =
      input.effectiveAt === undefined
        ? null
        : this.normalizeDate(
            input.effectiveAt,
            'effectiveAt',
          );

    try {
      const result =
        await this.database.query<PolicyRow>(
          `
          SELECT
            p.id::text AS id,
            p.tenant_id::text AS tenant_id,
            p.key,
            p.version::text AS version,
            p.status,
            p.priority,
            p.action,
            p.resource_type,
            p.effect,
            p.risk_class_id::text AS risk_class_id,
            rc.code AS risk_class_code,
            rc.name AS risk_class_name,
            rc.version::text AS risk_class_version,
            rc.default_approval_required
              AS risk_class_default_approval_required,
            rc.status AS risk_class_status,
            p.approval_required,
            p.conditions,
            p.approval_route,
            p.effective_from::text AS effective_from,
            p.effective_to::text AS effective_to,
            p.created_by::text AS created_by,
            p.change_reason,
            p.created_at::text AS created_at
          FROM policies p
          LEFT JOIN risk_classes rc
            ON rc.id = p.risk_class_id
           AND rc.tenant_id = p.tenant_id
           AND rc.status = 'ACTIVE'
           AND rc.effective_from <=
             COALESCE($4::timestamptz, now())
           AND (
             rc.effective_to IS NULL
             OR rc.effective_to >
               COALESCE($4::timestamptz, now())
           )
          WHERE
            p.tenant_id = $1
            AND p.status = 'ACTIVE'
            AND p.action = $2
            AND (
              p.resource_type IS NULL
              OR p.resource_type = $3
            )
            AND p.effective_from <=
              COALESCE($4::timestamptz, now())
            AND (
              p.effective_to IS NULL
              OR p.effective_to >
                COALESCE($4::timestamptz, now())
            )
            AND $5::jsonb @> p.conditions
          ORDER BY
            p.priority DESC,
            p.version DESC,
            p.effective_from DESC
          LIMIT 1
          `,
          [
            tenantId,
            action,
            resourceType,
            effectiveAt,
            JSON.stringify(attributes),
          ],
          { tenantId },
        );

      const row = result.rows[0];

      if (!row) {
        return {
          outcome: 'DENIED',
          risk: {
            class: null,
            policyRef: null,
            approvalRequired: false,
          },
          policy: null,
          safeDefault: true,
          reason: 'NO_MATCHING_POLICY',
        };
      }

      const policy = this.mapPolicyRow(row);
      const policyRef = {
        id: policy.id,
        key: policy.key,
        version: policy.version,
      };

      if (policy.effect === 'DENY') {
        return {
          outcome: 'DENIED',
          risk: {
            class: policy.riskClass?.code ?? null,
            policyRef,
            approvalRequired: false,
          },
          policy,
          safeDefault: false,
          reason: 'POLICY_DENY',
        };
      }

      if (!policy.riskClass) {
        return {
          outcome: 'DENIED',
          risk: {
            class: null,
            policyRef,
            approvalRequired: true,
          },
          policy,
          safeDefault: true,
          reason: 'RISK_CLASSIFICATION_MISSING',
        };
      }

      const approvalRequired =
        policy.approvalRequired ||
        policy.riskClass.defaultApprovalRequired;

      if (approvalRequired) {
        return {
          outcome: 'APPROVAL_REQUIRED',
          risk: {
            class: policy.riskClass.code,
            policyRef,
            approvalRequired: true,
          },
          policy,
          safeDefault: false,
          reason: 'HUMAN_APPROVAL_REQUIRED',
        };
      }

      return {
        outcome: 'ALLOWED',
        risk: {
          class: policy.riskClass.code,
          policyRef,
          approvalRequired: false,
        },
        policy,
        safeDefault: false,
        reason: 'POLICY_ALLOW',
      };
    } catch {
      return {
        outcome: 'DENIED',
        risk: {
          class: null,
          policyRef: null,
          approvalRequired: false,
        },
        policy: null,
        safeDefault: true,
        reason: 'POLICY_EVALUATION_FAILED',
      };
    }
  }

  // ============================================================
  // APPROVALS
  // ============================================================

  /**
   * Internal approval creation boundary.
   *
   * This method is intentionally exported by PolicyModule rather
   * than exposed as a public user-facing POST /approvals endpoint.
   * The AI/workflow runtime can call it after a policy evaluation
   * returns APPROVAL_REQUIRED.
   */
  async createApproval(
    tenantId: string,
    requestedBy: string,
    input: CreateApprovalInput,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(requestedBy, 'requestedBy');

    const normalized = this.normalizeCreateApprovalInput(input);

    try {
      const created =
        await this.database.transaction(
          async (client) => {
            const existingResult =
              normalized.idempotencyKey
                ? await client.query<ApprovalRow>(
                    this.approvalSelectSql(`
                      a.tenant_id = $1
                      AND a.idempotency_key = $2
                    `),
                    [
                      tenantId,
                      normalized.idempotencyKey,
                    ],
                  )
                : { rows: [] as ApprovalRow[] };

            const existing = existingResult.rows[0];

            if (existing) {
              return existing;
            }

            const policyResult =
              await client.query<{
                id: string;
                action: string;
                resource_type: string | null;
                effect: PolicyEffect;
                risk_class_id: string | null;
                risk_class_status: RiskClassStatus | null;
                risk_class_approval_required: boolean | null;
                policy_approval_required: boolean;
                status: PolicyStatus;
              }>(
                `
                SELECT
                  p.id::text AS id,
                  p.action,
                  p.resource_type,
                  p.effect,
                  p.risk_class_id::text AS risk_class_id,
                  rc.status AS risk_class_status,
                  rc.default_approval_required
                    AS risk_class_approval_required,
                  p.approval_required
                    AS policy_approval_required,
                  p.status
                FROM policies p
                LEFT JOIN risk_classes rc
                  ON rc.id = p.risk_class_id
                 AND rc.tenant_id = p.tenant_id
                WHERE
                  p.id = $1
                  AND p.tenant_id = $2
                LIMIT 1
                `,
                [normalized.policyId, tenantId],
              );

            const policy = policyResult.rows[0];

            if (!policy) {
              throw new NotFoundException(
                'Policy not found for this tenant',
              );
            }

            if (policy.status !== 'ACTIVE') {
              throw new BadRequestException(
                'Approval can only be requested for an active policy',
              );
            }

            if (policy.effect !== 'ALLOW') {
              throw new BadRequestException(
                'Approval cannot be requested for a DENY policy',
              );
            }

            if (!policy.risk_class_id) {
              throw new BadRequestException(
                'Approval requires a configured risk class',
              );
            }

            if (policy.risk_class_status !== 'ACTIVE') {
              throw new BadRequestException(
                'Approval requires an active risk class',
              );
            }

            if (
              !policy.policy_approval_required &&
              !policy.risk_class_approval_required
            ) {
              throw new BadRequestException(
                'The evaluated policy does not require approval',
              );
            }

            if (
              normalized.riskClassId &&
              normalized.riskClassId !== policy.risk_class_id
            ) {
              throw new BadRequestException(
                'riskClassId does not match the policy risk class',
              );
            }

            if (normalized.action !== policy.action) {
              throw new BadRequestException(
                'Approval action does not match the policy action',
              );
            }

            if (
              policy.resource_type &&
              normalized.resourceType !== policy.resource_type
            ) {
              throw new BadRequestException(
                'Approval resourceType does not match the policy resource type',
              );
            }

            const result =
              await client.query<ApprovalRow>(
                `
                INSERT INTO approvals (
                  tenant_id,
                  policy_id,
                  risk_class_id,
                  idempotency_key,
                  action,
                  resource_type,
                  resource_id,
                  requested_by,
                  status,
                  metadata,
                  expires_at
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
                  'PENDING',
                  $9::jsonb,
                  $10
                )
                RETURNING
                  id::text AS id,
                  tenant_id::text AS tenant_id,
                  policy_id::text AS policy_id,
                  risk_class_id::text AS risk_class_id,
                  idempotency_key,
                  action,
                  resource_type,
                  resource_id,
                  requested_by::text AS requested_by,
                  status,
                  metadata,
                  requested_at::text AS requested_at,
                  expires_at::text AS expires_at,
                  decided_by::text AS decided_by,
                  decided_at::text AS decided_at,
                  decision_reason
                `,
                [
                  tenantId,
                  policy.id,
                  policy.risk_class_id,
                  normalized.idempotencyKey,
                  normalized.action,
                  normalized.resourceType,
                  normalized.resourceId,
                  requestedBy,
                  JSON.stringify(normalized.metadata),
                  normalized.expiresAt,
                ],
              );

            const row = result.rows[0];

            if (!row) {
              throw new Error('APPROVAL_INSERT_FAILED');
            }

            return row;
          },
          {
            tenantId,
            userId: requestedBy,
          },
        );

      await this.recordAuditSafely({
        tenantId,
        actorUserId: requestedBy,
        eventType: 'APPROVAL',
        action: 'CREATE',
        resourceType: 'APPROVAL',
        resourceId: created.id,
        payload: {
          policyId: created.policy_id,
          riskClassId: created.risk_class_id,
          action: created.action,
          resourceType: created.resource_type,
          resourceId: created.resource_id,
          requestedBy: created.requested_by,
          status: created.status,
          idempotencyKey: created.idempotency_key,
          requestedAt: created.requested_at,
          expiresAt: created.expires_at,
          result: 'CREATED_OR_REUSED',
        },
      });

      return this.mapApprovalRow(created);
    } catch (error) {
      if (
        this.isPostgresUniqueViolation(error) &&
        normalized.idempotencyKey
      ) {
        const existing =
          await this.getApprovalByIdempotencyKey(
            tenantId,
            normalized.idempotencyKey,
          );

        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  async getApproval(
    tenantId: string,
    approvalId: string,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(approvalId, 'approvalId');

    const result =
      await this.database.query<ApprovalRow>(
        this.approvalSelectSql(`
          a.id = $1
          AND a.tenant_id = $2
        `),
        [approvalId, tenantId],
        { tenantId },
      );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapApprovalRow(row);
  }

  async listApprovals(
    tenantId: string,
    options: ListApprovalsOptions = {},
  ) {
    this.validateUuid(tenantId, 'tenantId');

    const limit = this.normalizeLimit(options.limit);
    const offset = this.normalizeOffset(options.offset);

    const values: unknown[] = [tenantId];
    const conditions = ['a.tenant_id = $1'];

    if (options.status !== undefined) {
      const status = this.normalizeApprovalStatus(
        options.status,
      );

      values.push(status);
      conditions.push(
        `a.status = $${values.length}`,
      );
    }

    if (options.action !== undefined) {
      const action = this.normalizeRequiredString(
        options.action,
        'action',
        200,
      );

      values.push(action);
      conditions.push(
        `a.action = $${values.length}`,
      );
    }

    values.push(limit, offset);

    const result =
      await this.database.query<ApprovalRow>(
        this.approvalSelectSql(
          `
          ${conditions.join('\n          AND ')}
        `,
          `
        ORDER BY
          a.requested_at DESC
        LIMIT $${values.length - 1}
        OFFSET $${values.length}
        `,
        ),
        values,
        { tenantId },
      );

    return {
      items: result.rows.map((row) =>
        this.mapApprovalRow(row),
      ),
      limit,
      offset,
      count: result.rows.length,
    };
  }

  async decideApproval(
    tenantId: string,
    actorUserId: string,
    approvalId: string,
    decision: 'APPROVE' | 'REJECT',
    reason?: string | null,
  ) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(actorUserId, 'actorUserId');
    this.validateUuid(approvalId, 'approvalId');

    if (
      decision !== 'APPROVE' &&
      decision !== 'REJECT'
    ) {
      throw new BadRequestException(
        'decision must be APPROVE or REJECT',
      );
    }

    const normalizedReason =
      reason === null || reason === undefined
        ? null
        : reason.trim();

    if (
      normalizedReason &&
      normalizedReason.length > 2000
    ) {
      throw new BadRequestException(
        'reason must not exceed 2000 characters',
      );
    }

    if (
      decision === 'REJECT' &&
      !normalizedReason
    ) {
      throw new BadRequestException(
        'reason is required when rejecting an approval',
      );
    }

    const status =
      decision === 'APPROVE'
        ? 'APPROVED'
        : 'REJECTED';

    const result =
      await this.database.query<ApprovalRow>(
        `
        UPDATE approvals
        SET
          status = $1,
          decided_by = $2,
          decided_at = NOW(),
          decision_reason = $3
        WHERE
          id = $4
          AND tenant_id = $5
          AND status = 'PENDING'
          AND (
            expires_at IS NULL
            OR expires_at > NOW()
          )
        RETURNING
          id::text AS id,
          tenant_id::text AS tenant_id,
          policy_id::text AS policy_id,
          risk_class_id::text AS risk_class_id,
          idempotency_key,
          action,
          resource_type,
          resource_id,
          requested_by::text AS requested_by,
          status,
          metadata,
          requested_at::text AS requested_at,
          expires_at::text AS expires_at,
          decided_by::text AS decided_by,
          decided_at::text AS decided_at,
          decision_reason
        `,
        [
          status,
          actorUserId,
          normalizedReason,
          approvalId,
          tenantId,
        ],
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const row = result.rows[0];

    if (!row) {
      const existing = await this.getApproval(
        tenantId,
        approvalId,
      );

      if (!existing) {
        throw new NotFoundException(
          'Approval not found for this tenant',
        );
      }

      if (
        existing.status === 'PENDING' &&
        existing.expiresAt &&
        new Date(existing.expiresAt).getTime() <=
          Date.now()
      ) {
        throw new ConflictException(
          'Approval has expired',
        );
      }

      throw new ConflictException(
        `Approval is already ${existing.status.toLowerCase()}`,
      );
    }

    await this.recordAuditSafely({
      tenantId,
      actorUserId,
      eventType: 'APPROVAL',
      action: decision,
      resourceType: 'APPROVAL',
      resourceId: row.id,
      payload: {
        policyId: row.policy_id,
        riskClassId: row.risk_class_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        requestedBy: row.requested_by,
        status: row.status,
        decidedBy: row.decided_by,
        decidedAt: row.decided_at,
        decisionReason: row.decision_reason,
        result: decision,
      },
    });

    return this.mapApprovalRow(row);
  }

  // ============================================================
  // PRIVATE: VERSIONED RISK CLASS WRITE
  // ============================================================

  private async insertRiskClassVersionWithRetry(
    tenantId: string,
    actorUserId: string | null,
    input: {
      code: string;
      name: string;
      description: string | null;
      defaultApprovalRequired: boolean;
      status: RiskClassStatus;
      effectiveFrom: string;
      effectiveTo: string | null;
    },
  ): Promise<RiskClassRow> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(
          async (client) => {
            const versionResult =
              await client.query<{ next_version: string }>(
                `
                SELECT
                  (COALESCE(MAX(version), 0) + 1)::text
                    AS next_version
                FROM risk_classes
                WHERE
                  tenant_id = $1
                  AND code = $2
                `,
                [tenantId, input.code],
              );

            const nextVersion =
              versionResult.rows[0]?.next_version ?? '1';

            const result =
              await client.query<RiskClassRow>(
                `
                INSERT INTO risk_classes (
                  tenant_id,
                  code,
                  name,
                  description,
                  version,
                  default_approval_required,
                  status,
                  effective_from,
                  effective_to,
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
                  $10
                )
                RETURNING
                  id::text AS id,
                  tenant_id::text AS tenant_id,
                  code,
                  name,
                  description,
                  version::text AS version,
                  default_approval_required,
                  status,
                  effective_from::text AS effective_from,
                  effective_to::text AS effective_to,
                  created_by::text AS created_by,
                  created_at::text AS created_at
                `,
                [
                  tenantId,
                  input.code,
                  input.name,
                  input.description,
                  nextVersion,
                  input.defaultApprovalRequired,
                  input.status,
                  input.effectiveFrom,
                  input.effectiveTo,
                  actorUserId,
                ],
              );

            const row = result.rows[0];

            if (!row) {
              throw new Error(
                'RISK_CLASS_INSERT_FAILED',
              );
            }

            return row;
          },
          {
            tenantId,
            userId: actorUserId,
          },
        );
      } catch (error) {
        if (
          this.isPostgresUniqueViolation(error) &&
          attempt < 2
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Unable to allocate a risk-class version',
    );
  }

  // ============================================================
  // PRIVATE: VERSIONED POLICY WRITE
  // ============================================================

  private async insertPolicyVersionWithRetry(
    tenantId: string,
    actorUserId: string | null,
    input: {
      key: string;
      action: string;
      resourceType: string | null;
      effect: PolicyEffect;
      riskClassId: string | null;
      approvalRequired: boolean;
      conditions: Record<string, unknown>;
      approvalRoute: Record<string, unknown>;
      status: PolicyStatus;
      priority: number;
      effectiveFrom: string;
      effectiveTo: string | null;
      changeReason: string | null;
    },
  ): Promise<PolicyRow> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(
          async (client) => {
            if (input.riskClassId) {
              const riskResult =
                await client.query<{
                  id: string;
                  status: RiskClassStatus;
                }>(
                  `
                  SELECT
                    id::text AS id,
                    status
                  FROM risk_classes
                  WHERE
                    id = $1
                    AND tenant_id = $2
                  LIMIT 1
                  `,
                  [input.riskClassId, tenantId],
                );

              const riskClass = riskResult.rows[0];

              if (!riskClass) {
                throw new NotFoundException(
                  'Risk class not found for this tenant',
                );
              }

              if (riskClass.status !== 'ACTIVE') {
                throw new BadRequestException(
                  'Policy risk class must be ACTIVE',
                );
              }
            }

            const versionResult =
              await client.query<{ next_version: string }>(
                `
                SELECT
                  (COALESCE(MAX(version), 0) + 1)::text
                    AS next_version
                FROM policies
                WHERE
                  tenant_id = $1
                  AND key = $2
                `,
                [tenantId, input.key],
              );

            const nextVersion =
              versionResult.rows[0]?.next_version ?? '1';

            const result =
              await client.query<PolicyRow>(
                `
                INSERT INTO policies (
                  tenant_id,
                  key,
                  version,
                  status,
                  priority,
                  action,
                  resource_type,
                  effect,
                  risk_class_id,
                  approval_required,
                  conditions,
                  approval_route,
                  effective_from,
                  effective_to,
                  created_by,
                  change_reason
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
                  $12::jsonb,
                  $13,
                  $14,
                  $15,
                  $16
                )
                RETURNING
                  id::text AS id,
                  tenant_id::text AS tenant_id,
                  key,
                  version::text AS version,
                  status,
                  priority,
                  action,
                  resource_type,
                  effect,
                  risk_class_id::text AS risk_class_id,
                  NULL::text AS risk_class_code,
                  NULL::text AS risk_class_name,
                  NULL::text AS risk_class_version,
                  NULL::boolean
                    AS risk_class_default_approval_required,
                  NULL::varchar
                    AS risk_class_status,
                  approval_required,
                  conditions,
                  approval_route,
                  effective_from::text AS effective_from,
                  effective_to::text AS effective_to,
                  created_by::text AS created_by,
                  change_reason,
                  created_at::text AS created_at
                `,
                [
                  tenantId,
                  input.key,
                  nextVersion,
                  input.status,
                  input.priority,
                  input.action,
                  input.resourceType,
                  input.effect,
                  input.riskClassId,
                  input.approvalRequired,
                  JSON.stringify(input.conditions),
                  JSON.stringify(input.approvalRoute),
                  input.effectiveFrom,
                  input.effectiveTo,
                  actorUserId,
                  input.changeReason,
                ],
              );

            const row = result.rows[0];

            if (!row) {
              throw new Error('POLICY_INSERT_FAILED');
            }

            return row;
          },
          {
            tenantId,
            userId: actorUserId,
          },
        );
      } catch (error) {
        if (
          this.isPostgresUniqueViolation(error) &&
          attempt < 2
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Unable to allocate a policy version',
    );
  }

  // ============================================================
  // PRIVATE: SQL BUILDERS
  // ============================================================

  private policySelectSql(
    whereSql: string,
    tailSql = '',
  ): string {
    return `
      SELECT
        p.id::text AS id,
        p.tenant_id::text AS tenant_id,
        p.key,
        p.version::text AS version,
        p.status,
        p.priority,
        p.action,
        p.resource_type,
        p.effect,
        p.risk_class_id::text AS risk_class_id,
        rc.code AS risk_class_code,
        rc.name AS risk_class_name,
        rc.version::text AS risk_class_version,
        rc.default_approval_required
          AS risk_class_default_approval_required,
        rc.status AS risk_class_status,
        p.approval_required,
        p.conditions,
        p.approval_route,
        p.effective_from::text AS effective_from,
        p.effective_to::text AS effective_to,
        p.created_by::text AS created_by,
        p.change_reason,
        p.created_at::text AS created_at
      FROM policies p
      LEFT JOIN risk_classes rc
        ON rc.id = p.risk_class_id
       AND rc.tenant_id = p.tenant_id
      WHERE ${whereSql}
      ${tailSql}
    `;
  }

  private approvalSelectSql(
    whereSql: string,
    tailSql = '',
  ): string {
    return `
      SELECT
        a.id::text AS id,
        a.tenant_id::text AS tenant_id,
        a.policy_id::text AS policy_id,
        a.risk_class_id::text AS risk_class_id,
        a.idempotency_key,
        a.action,
        a.resource_type,
        a.resource_id,
        a.requested_by::text AS requested_by,
        a.status,
        a.metadata,
        a.requested_at::text AS requested_at,
        a.expires_at::text AS expires_at,
        a.decided_by::text AS decided_by,
        a.decided_at::text AS decided_at,
        a.decision_reason
      FROM approvals a
      WHERE ${whereSql}
      ${tailSql}
    `;
  }

  // ============================================================
  // PRIVATE: MAPPERS
  // ============================================================

  private mapRiskClassRow(row: RiskClassRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      code: row.code,
      name: row.name,
      description: row.description,
      version: row.version,
      defaultApprovalRequired:
        row.default_approval_required,
      status: row.status,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private mapPolicyRow(row: PolicyRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      key: row.key,
      version: row.version,
      status: row.status,
      priority: row.priority,
      action: row.action,
      resourceType: row.resource_type,
      effect: row.effect,
      riskClass: row.risk_class_id
        ? {
            id: row.risk_class_id,
            code: row.risk_class_code,
            name: row.risk_class_name,
            version: row.risk_class_version,
            defaultApprovalRequired:
              row.risk_class_default_approval_required,
            status: row.risk_class_status,
          }
        : null,
      approvalRequired: row.approval_required,
      conditions: row.conditions,
      approvalRoute: row.approval_route,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      createdBy: row.created_by,
      changeReason: row.change_reason,
      createdAt: row.created_at,
    };
  }

  private mapApprovalRow(row: ApprovalRow) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      policyId: row.policy_id,
      riskClassId: row.risk_class_id,
      idempotencyKey: row.idempotency_key,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      requestedBy: row.requested_by,
      status: row.status,
      metadata: row.metadata,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decisionReason: row.decision_reason,
    };
  }

  // ============================================================
  // PRIVATE: INPUT NORMALIZATION
  // ============================================================

  private normalizeCreateRiskClassInput(
    input: CreateRiskClassInput,
  ) {
    const code = this.normalizeRequiredString(
      input.code,
      'code',
      20,
    );

    const name = this.normalizeRequiredString(
      input.name,
      'name',
      150,
    );

    const description =
      input.description === null ||
      input.description === undefined
        ? null
        : input.description.trim();

    if (
      description &&
      description.length > 2000
    ) {
      throw new BadRequestException(
        'description must not exceed 2000 characters',
      );
    }

    const effectiveFrom = this.normalizeDate(
      input.effectiveFrom,
      'effectiveFrom',
      new Date(),
    );

    const effectiveTo =
      input.effectiveTo === null ||
      input.effectiveTo === undefined
        ? null
        : this.normalizeDate(
            input.effectiveTo,
            'effectiveTo',
          );

    this.validateEffectiveWindow(
      effectiveFrom,
      effectiveTo,
    );

    return {
      code,
      name,
      description,
      defaultApprovalRequired:
        input.defaultApprovalRequired ?? false,
      status: this.normalizeRiskClassStatus(
        input.status ?? 'ACTIVE',
      ),
      effectiveFrom,
      effectiveTo,
    };
  }

  private normalizeCreatePolicyInput(
    input: CreatePolicyInput,
  ) {
    const key = this.normalizeRequiredString(
      input.key,
      'key',
      200,
    );

    const action = this.normalizeRequiredString(
      input.action,
      'action',
      200,
    );

    const resourceType =
      input.resourceType === null ||
      input.resourceType === undefined
        ? null
        : this.normalizeRequiredString(
            input.resourceType,
            'resourceType',
            150,
          );

    const riskClassId =
      input.riskClassId === null ||
      input.riskClassId === undefined
        ? null
        : input.riskClassId;

    this.validateOptionalUuid(
      riskClassId,
      'riskClassId',
    );

    const conditions =
      input.conditions === undefined
        ? {}
        : this.normalizeObject(
            input.conditions,
            'conditions',
          );

    const approvalRoute =
      input.approvalRoute === undefined
        ? {}
        : this.normalizeObject(
            input.approvalRoute,
            'approvalRoute',
          );

    const effectiveFrom = this.normalizeDate(
      input.effectiveFrom,
      'effectiveFrom',
      new Date(),
    );

    const effectiveTo =
      input.effectiveTo === null ||
      input.effectiveTo === undefined
        ? null
        : this.normalizeDate(
            input.effectiveTo,
            'effectiveTo',
          );

    this.validateEffectiveWindow(
      effectiveFrom,
      effectiveTo,
    );

    const changeReason =
      input.changeReason === null ||
      input.changeReason === undefined
        ? null
        : input.changeReason.trim();

    if (
      changeReason &&
      changeReason.length > 2000
    ) {
      throw new BadRequestException(
        'changeReason must not exceed 2000 characters',
      );
    }

    const priority = input.priority ?? 100;

    if (
      !Number.isInteger(priority) ||
      priority < 0
    ) {
      throw new BadRequestException(
        'priority must be a non-negative integer',
      );
    }

    return {
      key,
      action,
      resourceType,
      effect: this.normalizePolicyEffect(
        input.effect ?? 'DENY',
      ),
      riskClassId,
      approvalRequired:
        input.approvalRequired ?? false,
      conditions,
      approvalRoute,
      status: this.normalizePolicyStatus(
        input.status ?? 'ACTIVE',
      ),
      priority,
      effectiveFrom,
      effectiveTo,
      changeReason,
    };
  }

  private normalizeCreateApprovalInput(
    input: CreateApprovalInput,
  ) {
    this.validateUuid(
      input.policyId,
      'policyId',
    );

    const riskClassId =
      input.riskClassId === null ||
      input.riskClassId === undefined
        ? null
        : input.riskClassId;

    this.validateOptionalUuid(
      riskClassId,
      'riskClassId',
    );

    const action = this.normalizeRequiredString(
      input.action,
      'action',
      200,
    );

    const resourceType =
      input.resourceType === null ||
      input.resourceType === undefined
        ? null
        : this.normalizeRequiredString(
            input.resourceType,
            'resourceType',
            150,
          );

    const resourceId =
      input.resourceId === null ||
      input.resourceId === undefined
        ? null
        : this.normalizeRequiredString(
            input.resourceId,
            'resourceId',
            255,
          );

    const normalizedIdempotencyKey =
      input.idempotencyKey === null ||
      input.idempotencyKey === undefined
        ? null
        : input.idempotencyKey.trim();

    const idempotencyKey =
      normalizedIdempotencyKey || null;

    if (
      idempotencyKey &&
      idempotencyKey.length > 255
    ) {
      throw new BadRequestException(
        'idempotencyKey must not exceed 255 characters',
      );
    }

    const metadata =
      input.metadata === undefined
        ? {}
        : this.normalizeObject(
            input.metadata,
            'metadata',
          );

    const expiresAt =
      input.expiresAt === null ||
      input.expiresAt === undefined
        ? null
        : this.normalizeDate(
            input.expiresAt,
            'expiresAt',
          );

    return {
      policyId: input.policyId,
      riskClassId,
      idempotencyKey,
      action,
      resourceType,
      resourceId,
      metadata,
      expiresAt,
    };
  }

  private normalizeRiskClassStatus(
    status: string,
  ): RiskClassStatus {
    if (
      status !== 'ACTIVE' &&
      status !== 'DISABLED' &&
      status !== 'EXPIRED'
    ) {
      throw new BadRequestException(
        'Invalid risk class status',
      );
    }

    return status;
  }

  private normalizePolicyStatus(
    status: string,
  ): PolicyStatus {
    if (
      status !== 'ACTIVE' &&
      status !== 'DISABLED' &&
      status !== 'EXPIRED'
    ) {
      throw new BadRequestException(
        'Invalid policy status',
      );
    }

    return status;
  }

  private normalizePolicyEffect(
    effect: string,
  ): PolicyEffect {
    if (
      effect !== 'ALLOW' &&
      effect !== 'DENY'
    ) {
      throw new BadRequestException(
        'Invalid policy effect',
      );
    }

    return effect;
  }

  private normalizeApprovalStatus(
    status: string,
  ): ApprovalStatus {
    if (
      status !== 'PENDING' &&
      status !== 'APPROVED' &&
      status !== 'REJECTED' &&
      status !== 'CANCELLED' &&
      status !== 'EXPIRED'
    ) {
      throw new BadRequestException(
        'Invalid approval status',
      );
    }

    return status;
  }

  private normalizeRequiredString(
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

  private normalizeDate(
    value: string | Date | undefined,
    field: string,
    fallback?: Date,
  ): string {
    const source = value ?? fallback;

    if (!source) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    const date =
      source instanceof Date
        ? new Date(source.getTime())
        : new Date(source);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${field} must be a valid date`,
      );
    }

    return date.toISOString();
  }

  private normalizeObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> {
    if (!this.isPlainObject(value)) {
      throw new BadRequestException(
        `${field} must be an object`,
      );
    }

    return value;
  }

  private normalizeLimit(
    value: number | undefined,
  ): number {
    if (value === undefined) {
      return 50;
    }

    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException(
        'limit must be a positive integer',
      );
    }

    return Math.min(value, 100);
  }

  private normalizeOffset(
    value: number | undefined,
  ): number {
    if (value === undefined) {
      return 0;
    }

    if (!Number.isInteger(value) || value < 0) {
      throw new BadRequestException(
        'offset must be a non-negative integer',
      );
    }

    return value;
  }

  private validateEffectiveWindow(
    effectiveFrom: string,
    effectiveTo: string | null,
  ): void {
    if (
      effectiveTo &&
      new Date(effectiveTo).getTime() <=
        new Date(effectiveFrom).getTime()
    ) {
      throw new BadRequestException(
        'effectiveTo must be later than effectiveFrom',
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

  private validateOptionalUuid(
    value: string | null | undefined,
    field: string,
  ): void {
    if (
      value !== null &&
      value !== undefined &&
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  private isPlainObject(
    value: unknown,
  ): value is Record<string, unknown> {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return (
      prototype === Object.prototype ||
      prototype === null
    );
  }

  private isPostgresUniqueViolation(
    error: unknown,
  ): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (
        error as {
          code?: string;
        }
      ).code === '23505'
    );
  }

  // ============================================================
  // PRIVATE: APPROVAL LOOKUP / AUDIT
  // ============================================================

  private async getApprovalByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ) {
    const result =
      await this.database.query<ApprovalRow>(
        this.approvalSelectSql(`
          a.tenant_id = $1
          AND a.idempotency_key = $2
        `),
        [tenantId, idempotencyKey],
        { tenantId },
      );

    const row = result.rows[0];

    return row
      ? this.mapApprovalRow(row)
      : null;
  }

  private async recordAuditSafely(params: {
    tenantId: string;
    actorUserId: string | null;
    eventType: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: params.tenantId,
        factoryId: null,
        actorUserId: params.actorUserId,
        eventType: params.eventType,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: params.payload,
      });
    } catch {
      // Business state has already committed.
    }
  }
}
