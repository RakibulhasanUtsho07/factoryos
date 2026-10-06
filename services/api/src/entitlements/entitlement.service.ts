import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';

import {
  isUUID,
} from 'class-validator';

import type {
  PoolClient,
  QueryResultRow,
} from 'pg';

import {
  AuditService,
} from '../audit/audit.service';

import {
  DatabaseService,
} from '../database/database.service';

export type EntitlementStatus =
  | 'ACTIVE'
  | 'DISABLED'
  | 'EXPIRED';

export interface CreateEntitlementInput {
  package: string;

  featureKey: string;

  limitValue?:
    | number
    | null;

  period?:
    | string
    | null;

  status?:
    | EntitlementStatus;

  effectiveFrom?:
    | string
    | Date;

  effectiveTo?:
    | string
    | Date
    | null;

  config?:
    | Record<
        string,
        unknown
      >;
}

export interface ListEntitlementsOptions {
  package?:
    | string;

  featureKey?:
    | string;

  status?:
    | EntitlementStatus;

  limit?:
    | number;

  offset?:
    | number;
}

interface EntitlementRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  package: string;

  feature_key: string;

  limit_value:
    | string
    | null;

  period:
    | string
    | null;

  version: string;

  status:
    EntitlementStatus;

  effective_from: string;

  effective_to:
    | string
    | null;

  config: Record<
    string,
    unknown
  >;

  created_by:
    | string
    | null;

  created_at: string;
}

/*
 * IMPORTANT:
 *
 * This MUST remain a named export because:
 *
 *   import { EntitlementService }
 *     from './entitlement.service';
 *
 * is used by both the module and unit tests.
 */
@Injectable()
export class EntitlementService {
  constructor(
    private readonly database:
      DatabaseService,

    private readonly auditService:
      AuditService,
  ) {}

  // ============================================================
  // CREATE / VERSION
  // ============================================================

  async createEntitlement(
    tenantId: string,

    actorUserId:
      | string
      | null,

    input: CreateEntitlementInput,
  ) {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    this.validateOptionalUuid(
      actorUserId,
      'actorUserId',
    );

    const normalized =
      this.normalizeCreateInput(
        input,
      );

    const created =
      await this.insertVersionWithRetry(
        tenantId,

        actorUserId,

        normalized,
      );

    /*
     * Audit is intentionally performed after the business
     * transaction commits.
     *
     * Audit failure must not turn a successful entitlement
     * write into a failed business operation.
     */
    try {
      await this.auditService.record({
        tenantId,

        factoryId:
          null,

        actorUserId,

        eventType:
          'ENTITLEMENT',

        action:
          'CREATE_VERSION',

        resourceType:
          'ENTITLEMENT',

        resourceId:
          created.id,

        correlationId:
          null,

        requestId:
          null,

        dataClass:
          'INTERNAL',

        payload: {
          package:
            created.package,

          featureKey:
            created.feature_key,

          version:
            created.version,

          status:
            created.status,

          limitValue:
            created.limit_value,

          period:
            created.period,

          effectiveFrom:
            created.effective_from,

          effectiveTo:
            created.effective_to,

          result:
            'CREATED',
        },
      });
    } catch {
      /*
       * Do not hide a successful business write because
       * the audit infrastructure is unavailable.
       */
    }

    return this.mapRow(
      created,
    );
  }

  // ============================================================
  // GET BY ID
  // ============================================================

  async getEntitlement(
    tenantId: string,

    entitlementId: string,
  ) {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    this.validateUuid(
      entitlementId,
      'entitlementId',
    );

    const result =
      await this.database.query<EntitlementRow>(
        `
        SELECT
          e.id::text AS id,

          e.tenant_id::text
            AS tenant_id,

          e.package,

          e.feature_key,

          e.limit_value::text
            AS limit_value,

          e.period,

          e.version::text
            AS version,

          e.status,

          e.effective_from::text
            AS effective_from,

          e.effective_to::text
            AS effective_to,

          e.config,

          e.created_by::text
            AS created_by,

          e.created_at::text
            AS created_at

        FROM entitlements e

        WHERE
          e.id = $1

          AND e.tenant_id = $2

        LIMIT 1
        `,

        [
          entitlementId,

          tenantId,
        ],

        {
          tenantId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapRow(
      row,
    );
  }

  // ============================================================
  // RESOLVE EFFECTIVE ENTITLEMENT
  // ============================================================

  async resolveEntitlement(
    tenantId: string,

    packageName: string,

    featureKey: string,

    at:
      | string
      | Date
      | undefined = undefined,
  ) {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    const normalizedPackage =
      this.normalizeRequiredString(
        packageName,

        'package',

        100,
      );

    const normalizedFeatureKey =
      this.normalizeRequiredString(
        featureKey,

        'featureKey',

        150,
      );

    const effectiveAt =
      this.normalizeOptionalDate(
        at,

        'at',
      );

    const result =
      await this.database.query<EntitlementRow>(
        `
        SELECT
          e.id::text AS id,

          e.tenant_id::text
            AS tenant_id,

          e.package,

          e.feature_key,

          e.limit_value::text
            AS limit_value,

          e.period,

          e.version::text
            AS version,

          e.status,

          e.effective_from::text
            AS effective_from,

          e.effective_to::text
            AS effective_to,

          e.config,

          e.created_by::text
            AS created_by,

          e.created_at::text
            AS created_at

        FROM entitlements e

        WHERE
          e.tenant_id = $1

          AND e.package = $2

          AND e.feature_key = $3

          AND e.status = 'ACTIVE'

          AND e.effective_from <=
            COALESCE(
              $4::timestamptz,

              now()
            )

          AND (
            e.effective_to IS NULL

            OR e.effective_to >
              COALESCE(
                $4::timestamptz,

                now()
              )
          )

        ORDER BY
          e.version DESC

        LIMIT 1
        `,

        [
          tenantId,

          normalizedPackage,

          normalizedFeatureKey,

          effectiveAt,
        ],

        {
          tenantId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      return null;
    }

    return this.mapRow(
      row,
    );
  }

  // ============================================================
  // LIST
  // ============================================================

  async listEntitlements(
    tenantId: string,

    options:
      | ListEntitlementsOptions = {},
  ) {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    const limit =
      this.normalizeLimit(
        options.limit,
      );

    const offset =
      this.normalizeOffset(
        options.offset,
      );

    const values:
      unknown[] = [
        tenantId,
      ];

    const conditions:
      string[] = [
        'e.tenant_id = $1',
      ];

    if (
      options.package !==
      undefined
    ) {
      const normalizedPackage =
        this.normalizeRequiredString(
          options.package,

          'package',

          100,
        );

      values.push(
        normalizedPackage,
      );

      conditions.push(
        `e.package = $${values.length}`,
      );
    }

    if (
      options.featureKey !==
      undefined
    ) {
      const normalizedFeatureKey =
        this.normalizeRequiredString(
          options.featureKey,

          'featureKey',

          150,
        );

      values.push(
        normalizedFeatureKey,
      );

      conditions.push(
        `e.feature_key = $${values.length}`,
      );
    }

    if (
      options.status !==
      undefined
    ) {
      this.validateStatus(
        options.status,
      );

      values.push(
        options.status,
      );

      conditions.push(
        `e.status = $${values.length}`,
      );
    }

    values.push(
      limit,

      offset,
    );

    const limitIndex =
      values.length - 1;

    const offsetIndex =
      values.length;

    const result =
      await this.database.query<EntitlementRow>(
        `
        SELECT
          e.id::text AS id,

          e.tenant_id::text
            AS tenant_id,

          e.package,

          e.feature_key,

          e.limit_value::text
            AS limit_value,

          e.period,

          e.version::text
            AS version,

          e.status,

          e.effective_from::text
            AS effective_from,

          e.effective_to::text
            AS effective_to,

          e.config,

          e.created_by::text
            AS created_by,

          e.created_at::text
            AS created_at

        FROM entitlements e

        WHERE
          ${conditions.join(
            '\n          AND ',
          )}

        ORDER BY
          e.package ASC,

          e.feature_key ASC,

          e.version DESC

        LIMIT $${limitIndex}

        OFFSET $${offsetIndex}
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
            row,
          ) =>
            this.mapRow(
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
  // INSERT VERSION WITH CONCURRENCY RETRY
  // ============================================================

  private async insertVersionWithRetry(
    tenantId: string,

    actorUserId:
      | string
      | null,

    input: {
      package: string;

      featureKey: string;

      limitValue:
        | number
        | null;

      period:
        | string
        | null;

      status:
        EntitlementStatus;

      effectiveFrom:
        string;

      effectiveTo:
        | string
        | null;

      config:
        Record<
          string,
          unknown
        >;
    },
  ): Promise<
    EntitlementRow
  > {
    const maxAttempts =
      3;

    let lastError:
      | unknown = null;

    for (
      let attempt = 1;

      attempt <=
        maxAttempts;

      attempt += 1
    ) {
      try {
        return await this.database.transaction(
          {
            tenantId,

            userId:
              actorUserId,
          },

          async (
            client,
          ) => {
            /*
             * Calculate the next version inside the same
             * transaction that performs the INSERT.
             */
            const versionResult =
              await client.query<{
                next_version:
                  string;
              }>(
                `
                SELECT
                  (
                    COALESCE(
                      MAX(e.version),

                      0
                    ) + 1
                  )::text
                    AS next_version

                FROM entitlements e

                WHERE
                  e.tenant_id = $1

                  AND e.package = $2

                  AND e.feature_key = $3
                `,

                [
                  tenantId,

                  input.package,

                  input.featureKey,
                ],
              );

            const versionRow =
              versionResult
                .rows[0];

            if (
              !versionRow
            ) {
              throw new Error(
                'ENTITLEMENT_VERSION_CALCULATION_FAILED',
              );
            }

            const version =
              Number(
                versionRow.next_version,
              );

            if (
              !Number.isInteger(
                version,
              ) ||
              version < 1
            ) {
              throw new Error(
                'ENTITLEMENT_VERSION_IS_INVALID',
              );
            }

            const insertResult =
              await client.query<EntitlementRow>(
                `
                INSERT INTO entitlements (
                  tenant_id,

                  package,

                  feature_key,

                  limit_value,

                  period,

                  version,

                  status,

                  effective_from,

                  effective_to,

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

                  $8::timestamptz,

                  $9::timestamptz,

                  $10::jsonb,

                  $11
                )

                RETURNING
                  id::text AS id,

                  tenant_id::text
                    AS tenant_id,

                  package,

                  feature_key,

                  limit_value::text
                    AS limit_value,

                  period,

                  version::text
                    AS version,

                  status,

                  effective_from::text
                    AS effective_from,

                  effective_to::text
                    AS effective_to,

                  config,

                  created_by::text
                    AS created_by,

                  created_at::text
                    AS created_at
                `,

                [
                  tenantId,

                  input.package,

                  input.featureKey,

                  input.limitValue,

                  input.period,

                  version,

                  input.status,

                  input.effectiveFrom,

                  input.effectiveTo,

                  JSON.stringify(
                    input.config,
                  ),

                  actorUserId,
                ],
              );

            const row =
              insertResult.rows[0];

            if (!row) {
              throw new Error(
                'ENTITLEMENT_INSERT_FAILED',
              );
            }

            return row;
          },
        );
      } catch (
        error
      ) {
        lastError =
          error;

        /*
         * PostgreSQL unique violation:
         *
         *   23505
         *
         * Retry from a fresh transaction.
         */
        if (
          !this.isPostgresUniqueViolation(
            error,
          )
        ) {
          throw error;
        }

        if (
          attempt ===
          maxAttempts
        ) {
          throw error;
        }
      }
    }

    throw (
      lastError ??
      new Error(
        'ENTITLEMENT_VERSION_INSERT_FAILED',
      )
    );
  }

  // ============================================================
  // INPUT NORMALIZATION
  // ============================================================

  private normalizeCreateInput(
    input:
      CreateEntitlementInput,
  ) {
    if (
      !input ||
      typeof input !==
      'object'
    ) {
      throw new BadRequestException(
        'Entitlement input is required',
      );
    }

    const packageName =
      this.normalizeRequiredString(
        input.package,

        'package',

        100,
      );

    const featureKey =
      this.normalizeRequiredString(
        input.featureKey,

        'featureKey',

        150,
      );

    let limitValue:
      | number
      | null =
      input.limitValue ??
      null;

    if (
      limitValue !==
      null
    ) {
      if (
        typeof limitValue !==
          'number' ||
        !Number.isFinite(
          limitValue,
        )
      ) {
        throw new BadRequestException(
          'limitValue must be a finite number or null',
        );
      }

      if (
        limitValue < 0
      ) {
        throw new BadRequestException(
          'limitValue must be greater than or equal to zero',
        );
      }
    }

    let period:
      | string
      | null =
      input.period ??
      null;

    if (
      period !==
      null
    ) {
      period =
        this.normalizeRequiredString(
          period,

          'period',

          50,
        );
    }

    const status =
      input.status ??
      'ACTIVE';

    this.validateStatus(
      status,
    );

    const effectiveFrom =
      this.normalizeDate(
        input.effectiveFrom,

        'effectiveFrom',

        new Date(),
      );

    const effectiveTo =
      input.effectiveTo ===
        null ||
      input.effectiveTo ===
        undefined
        ? null
        : this.normalizeDate(
            input.effectiveTo,

            'effectiveTo',
          );

    if (
      effectiveTo !==
        null &&
      new Date(
        effectiveTo,
      ).getTime() <=
        new Date(
          effectiveFrom,
        ).getTime()
    ) {
      throw new BadRequestException(
        'effectiveTo must be later than effectiveFrom',
      );
    }

    const config =
      input.config ??
      {};

    if (
      !this.isPlainObject(
        config,
      )
    ) {
      throw new BadRequestException(
        'config must be a JSON object',
      );
    }

    return {
      package:
        packageName,

      featureKey,

      limitValue,

      period,

      status,

      effectiveFrom,

      effectiveTo,

      config,
    };
  }

  // ============================================================
  // ROW MAPPING
  // ============================================================

  private mapRow(
    row: EntitlementRow,
  ) {
    return {
      id:
        row.id,

      tenantId:
        row.tenant_id,

      package:
        row.package,

      featureKey:
        row.feature_key,

      limitValue:
        row.limit_value ===
          null
          ? null
          : Number(
              row.limit_value,
            ),

      period:
        row.period,

      version:
        Number(
          row.version,
        ),

      status:
        row.status,

      effectiveFrom:
        row.effective_from,

      effectiveTo:
        row.effective_to,

      config:
        row.config,

      createdBy:
        row.created_by,

      createdAt:
        row.created_at,
    };
  }

  // ============================================================
  // VALIDATION HELPERS
  // ============================================================

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

  private validateOptionalUuid(
    value:
      | string
      | null
      | undefined,

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

  private normalizeRequiredString(
    value: unknown,

    field: string,

    maxLength: number,
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

  private validateStatus(
    status: unknown,
  ): asserts status is EntitlementStatus {
    if (
      status !== 'ACTIVE' &&
      status !== 'DISABLED' &&
      status !== 'EXPIRED'
    ) {
      throw new BadRequestException(
        'status must be ACTIVE, DISABLED, or EXPIRED',
      );
    }
  }

  private normalizeDate(
    value:
      | string
      | Date
      | undefined,

    field: string,

    fallback?:
      | Date,
  ): string {
    const source =
      value ??
      fallback;

    if (!source) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    const date =
      source instanceof Date
        ? new Date(
            source.getTime(),
          )
        : new Date(
            source,
          );

    if (
      Number.isNaN(
        date.getTime(),
      )
    ) {
      throw new BadRequestException(
        `${field} must be a valid date`,
      );
    }

    return date.toISOString();
  }

  private normalizeOptionalDate(
    value:
      | string
      | Date
      | undefined,

    field: string,
  ): string | null {
    if (
      value ===
      undefined
    ) {
      return null;
    }

    return this.normalizeDate(
      value,

      field,
    );
  }

  private normalizeLimit(
    value:
      | number
      | undefined,
  ): number {
    if (
      value ===
      undefined
    ) {
      return 50;
    }

    if (
      !Number.isInteger(
        value,
      ) ||
      value < 1
    ) {
      throw new BadRequestException(
        'limit must be a positive integer',
      );
    }

    return Math.min(
      value,

      100,
    );
  }

  private normalizeOffset(
    value:
      | number
      | undefined,
  ): number {
    if (
      value ===
      undefined
    ) {
      return 0;
    }

    if (
      !Number.isInteger(
        value,
      ) ||
      value < 0
    ) {
      throw new BadRequestException(
        'offset must be a non-negative integer',
      );
    }

    return value;
  }

  private isPlainObject(
    value: unknown,
  ): value is Record<
    string,
    unknown
  > {
    if (
      typeof value !==
        'object' ||
      value === null ||
      Array.isArray(
        value,
      )
    ) {
      return false;
    }

    const prototype =
      Object.getPrototypeOf(
        value,
      );

    return (
      prototype ===
        Object.prototype ||
      prototype ===
        null
    );
  }

  private isPostgresUniqueViolation(
    error: unknown,
  ): boolean {
    return (
      typeof error ===
        'object' &&
      error !== null &&
      'code' in error &&
      (
        error as {
          code?: string;
        }
      ).code ===
        '23505'
    );
  }

  // ============================================================
  // TEST / INTERNAL QUERY HELPER
  // ============================================================

  private async executeInTransaction<T>(
    tenantId: string,

    actorUserId:
      | string
      | null,

    callback: (
      client: PoolClient,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      {
        tenantId,

        userId:
          actorUserId,
      },

      callback,
    );
  }
}