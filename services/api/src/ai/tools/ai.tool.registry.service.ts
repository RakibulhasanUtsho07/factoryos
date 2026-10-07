import {
  BadRequestException,
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
  DatabaseService,
} from '../../database/database.service';

import type {
  AiToolApprovalModeValue,
  AiToolDefinition,
  AiToolJsonSchema,
  AiToolRegistryStatus,
  AiToolRiskClass,
  AiToolRollbackDefinition,
} from './ai.tool.types';

interface AiToolRegistryRow
  extends QueryResultRow {
  id:
    string;

  tenant_id:
    | string
    | null;

  factory_id:
    | string
    | null;

  tool_id:
    string;

  version:
    string;

  input_schema:
    AiToolJsonSchema;

  output_schema:
    AiToolJsonSchema;

  risk_class:
    AiToolRiskClass;

  required_scopes:
    string[];

  approval_mode:
    AiToolApprovalModeValue;

  write_capable:
    boolean;

  idempotency_required:
    boolean;

  timeout_ms:
    number;

  audit_mode:
    'REDACTED';

  rollback:
    AiToolRollbackDefinition;

  status:
    AiToolRegistryStatus;

  metadata:
    Record<string, unknown>;

  created_by:
    | string
    | null;

  created_at:
    string;

  updated_at:
    string;
}

/* ============================================================
 * APPROVAL HELPER
 * ============================================================ */

/**
 * Returns true when the registered tool requires an
 * approval binding before Tool Gateway execution.
 *
 * NONE / none are the only non-approval modes.
 */
export function aiToolRequiresApproval(
  mode:
    AiToolApprovalModeValue,
): boolean {
  return (
    mode !== 'NONE' &&
    mode !== 'none'
  );
}

/* ============================================================
 * TOOL REGISTRY SERVICE
 * ============================================================ */

@Injectable()
export class AiToolRegistryService {
  constructor(
    private readonly database:
      DatabaseService,
  ) {}

  /* ==========================================================
   * PUBLIC: GET ACTIVE TOOL
   * ========================================================== */

  async getTool(
    tenantId:
      string,
    factoryId:
      string,
    toolId:
      string,
    version:
      string,
  ): Promise<AiToolDefinition> {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    this.validateUuid(
      factoryId,
      'factoryId',
    );

    const normalizedToolId =
      this.requiredString(
        toolId,
        'toolId',
        200,
      );

    const normalizedVersion =
      this.requiredString(
        version,
        'version',
        100,
      );

    const result =
      await this.database.query<AiToolRegistryRow>(
        `
        SELECT
          t.id::text AS id,
          t.tenant_id::text AS tenant_id,
          t.factory_id::text AS factory_id,
          t.tool_id,
          t.version,
          t.input_schema,
          t.output_schema,
          t.risk_class,
          t.required_scopes,
          t.approval_mode,
          t.write_capable,
          t.idempotency_required,
          t.timeout_ms,
          t.audit_mode,
          t.rollback,
          t.status,
          t.metadata,
          t.created_by::text AS created_by,
          t.created_at::text AS created_at,
          t.updated_at::text AS updated_at

        FROM ai_tool_registry t

        WHERE
          t.status = 'ACTIVE'

          AND t.tool_id = $1

          AND t.version = $2

          AND (
            t.tenant_id IS NULL
            OR t.tenant_id = $3
          )

          AND (
            t.factory_id IS NULL
            OR t.factory_id = $4
          )

        ORDER BY
          CASE
            WHEN
              t.tenant_id = $3
              AND t.factory_id = $4
            THEN 1

            WHEN
              t.tenant_id = $3
              AND t.factory_id IS NULL
            THEN 2

            WHEN
              t.tenant_id IS NULL
              AND t.factory_id IS NULL
            THEN 3

            ELSE 4
          END

        LIMIT 1
        `,
        [
          normalizedToolId,
          normalizedVersion,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      throw new NotFoundException(
        `AI tool is not registered: ${normalizedToolId}@${normalizedVersion}`,
      );
    }

    const tool =
      this.mapRow(row);

    this.validateDefinition(
      tool,
    );

    return tool;
  }

  /* ==========================================================
   * PRIVATE: MAP ROW
   * ========================================================== */

  private mapRow(
    row:
      AiToolRegistryRow,
  ): AiToolDefinition {
    return {
      id:
        row.id,

      tenantId:
        row.tenant_id,

      factoryId:
        row.factory_id,

      toolId:
        row.tool_id,

      version:
        row.version,

      inputSchema:
        row.input_schema,

      outputSchema:
        row.output_schema,

      riskClass:
        row.risk_class,

      requiredScopes:
        row.required_scopes ??
        [],

      approvalMode:
        row.approval_mode,

      writeCapable:
        row.write_capable,

      idempotencyRequired:
        row.idempotency_required,

      timeoutMs:
        row.timeout_ms,

      auditMode:
        row.audit_mode,

      rollback:
        row.rollback,

      status:
        row.status,

      metadata:
        row.metadata ??
        {},

      createdBy:
        row.created_by,

      createdAt:
        row.created_at,

      updatedAt:
        row.updated_at,
    };
  }

  /* ==========================================================
   * PRIVATE: DEFINITION VALIDATION
   * ========================================================== */

  private validateDefinition(
    tool:
      AiToolDefinition,
  ): void {
    if (
      tool.status !==
      'ACTIVE'
    ) {
      throw new NotFoundException(
        `AI tool is not active: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      tool.writeCapable &&
      !tool.idempotencyRequired
    ) {
      throw new BadRequestException(
        `AI write-capable tool must require idempotency: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      tool.writeCapable &&
      tool.rollback.type ===
        'NONE'
    ) {
      throw new BadRequestException(
        `AI write-capable tool must define rollback: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      !Number.isInteger(
        tool.timeoutMs,
      ) ||
      tool.timeoutMs < 100 ||
      tool.timeoutMs > 60000
    ) {
      throw new BadRequestException(
        `AI tool timeout is outside the supported bounded range: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      !this.isObject(
        tool.inputSchema,
      )
    ) {
      throw new BadRequestException(
        `AI tool input schema must be a JSON Schema object: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      !this.isObject(
        tool.outputSchema,
      )
    ) {
      throw new BadRequestException(
        `AI tool output schema must be a JSON Schema object: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      !Array.isArray(
        tool.requiredScopes,
      )
    ) {
      throw new BadRequestException(
        `AI tool required scopes must be an array: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      tool.requiredScopes.some(
        (scope) =>
          typeof scope !==
            'string' ||
          scope.trim().length === 0,
      )
    ) {
      throw new BadRequestException(
        `AI tool required scopes must contain only non-empty strings: ${tool.toolId}@${tool.version}`,
      );
    }

    if (
      !tool.rollback ||
      !this.isObject(
        tool.rollback,
      )
    ) {
      throw new BadRequestException(
        `AI tool rollback definition is invalid: ${tool.toolId}@${tool.version}`,
      );
    }
  }

  /* ==========================================================
   * PRIVATE: STRING
   * ========================================================== */

  private requiredString(
    value:
      unknown,
    field:
      string,
    maxLength:
      number,
  ): string {
    if (
      typeof value !==
      'string'
    ) {
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
      normalized.length >
      maxLength
    ) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }

    return normalized;
  }

  /* ==========================================================
   * PRIVATE: UUID
   * ========================================================== */

  private validateUuid(
    value:
      string,
    field:
      string,
  ): void {
    if (
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  /* ==========================================================
   * PRIVATE: OBJECT
   * ========================================================== */

  private isObject(
    value:
      unknown,
  ): value is Record<
    string,
    unknown
  > {
    return (
      typeof value ===
        'object' &&
      value !== null &&
      !Array.isArray(
        value,
      )
    );
  }
}