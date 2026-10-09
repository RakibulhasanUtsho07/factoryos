import {
  BadRequestException,
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
} from '../audit/audit.service';

import {
  DatabaseService,
} from '../database/database.service';

export interface CreateFeatureFlagInput {
  key: string;

  enabled?:
    | boolean;

  config?:
    | Record<
        string,
        unknown
      >;

  owner: string;

  securityCritical?:
    | boolean;

  changeReason?:
    | string
    | null;

  effectiveFrom?:
    | string
    | Date;

  expiresAt?:
    | string
    | Date
    | null;
}

export interface FeatureFlagWriteAuthorization {
  /*
   * This value MUST be derived from a trusted authorization
   * boundary.
   *
   * A future Admin/Policy controller must not derive this from
   * arbitrary request headers.
   */
  securityCriticalChangeAuthorized:
    boolean;
}

export interface ListFeatureFlagsOptions {
  key?:
    | string;

  enabled?:
    | boolean;

  owner?:
    | string;

  securityCritical?:
    | boolean;

  limit?:
    | number;

  offset?:
    | number;
}

interface FeatureFlagRow
  extends QueryResultRow {
  id: string;

  tenant_id: string;

  key: string;

  version: string;

  enabled: boolean;

  config: Record<
    string,
    unknown
  >;

  owner: string;

  security_critical:
    boolean;

  change_reason:
    | string
    | null;

  effective_from: string;

  expires_at:
    | string
    | null;

  created_by:
    | string
    | null;

  created_at: string;
}

@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly database:
      DatabaseService,

    private readonly auditService:
      AuditService,
  ) {}

  // ============================================================
  // CREATE / VERSION
  // ============================================================
  //
  // Feature flags are versioned and immutable.
  //
  // A changed flag is represented by inserting a new version.
  // Existing versions must never be UPDATEd or DELETEd.
  //
  // Security-critical flags additionally require:
  //
  //   1. authenticated actor
  //   2. privileged authorization from the caller
  //   3. non-empty change reason
  // ============================================================

  async createFeatureFlag(
    tenantId: string,

    actorUserId:
      | string
      | null,

    input:
      CreateFeatureFlagInput,

    authorization:
      FeatureFlagWriteAuthorization = {
        securityCriticalChangeAuthorized:
          false,
      },
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

    /*
     * Security-critical flags require both an actual actor and
     * a trusted privileged authorization decision.
     */
    if (
      normalized.securityCritical
    ) {
      if (
        !actorUserId
      ) {
        throw new BadRequestException(
          'Security-critical feature flag changes require an authenticated actor',
        );
      }

      if (
        authorization
          .securityCriticalChangeAuthorized !==
        true
      ) {
        throw new BadRequestException(
          'Privileged authorization is required for security-critical feature flag changes',
        );
      }

      if (
        !normalized.changeReason
      ) {
        throw new BadRequestException(
          'changeReason is required for security-critical feature flag changes',
        );
      }
    }

    const created =
      await this.insertVersionWithRetry(
        tenantId,

        actorUserId,

        normalized,
      );

    /*
     * Change audit happens after the business transaction has
     * committed.
     *
     * Audit failure does not invalidate an already committed
     * configuration change.
     */
    try {
      await this.auditService.record({
        tenantId,

        factoryId:
          null,

        actorUserId,

        eventType:
          'FEATURE_FLAG',

        action:
          'CREATE_VERSION',

        resourceType:
          'FEATURE_FLAG',

        resourceId:
          created.id,

        correlationId:
          null,

        requestId:
          null,

        dataClass:
          'INTERNAL',

        payload: {
          key:
            created.key,

          version:
            created.version,

          enabled:
            created.enabled,

          owner:
            created.owner,

          securityCritical:
            created.security_critical,

          changeReason:
            created.change_reason,

          effectiveFrom:
            created.effective_from,

          expiresAt:
            created.expires_at,

          result:
            'CREATED',
        },
      });
    } catch {
      /*
       * Business configuration has already committed.
       *
       * Do not mask the successful configuration change because
       * audit infrastructure is temporarily unavailable.
       */
    }

    return this.mapRow(
      created,
    );
  }

  // ============================================================
  // GET BY ID
  // ============================================================

  async getFeatureFlag(
    tenantId: string,

    featureFlagId: string,
  ) {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    this.validateUuid(
      featureFlagId,
      'featureFlagId',
    );

    const result =
      await this.database.query<FeatureFlagRow>(
        `
        SELECT
          f.id::text AS id,

          f.tenant_id::text
            AS tenant_id,

          f.key,

          f.version::text
            AS version,

          f.enabled,

          f.config,

          f.owner,

          f.security_critical,

          f.change_reason,

          f.effective_from::text
            AS effective_from,

          f.expires_at::text
            AS expires_at,

          f.created_by::text
            AS created_by,

          f.created_at::text
            AS created_at

        FROM feature_flags f

        WHERE
          f.id = $1

          AND f.tenant_id = $2

        LIMIT 1
        `,

        [
          featureFlagId,

          tenantId,
        ],

        {
          tenantId,
        },
      );

    const row =
      result.rows[0];

    if (
      !row
    ) {
      return null;
    }

    return this.mapRow(
      row,
    );
  }

  // ============================================================
  // RESOLVE FLAG
  // ============================================================
  //
  // This method is the safe runtime evaluation path.
  //
  // Rules:
  //
  //   - tenant-scoped
  //   - key must be active in its effective window
  //   - highest version wins
  //   - expired/future versions are ignored
  //   - any evaluation/database failure returns disabled
  //
  // The final rule is intentional:
  //
  //   evaluation failure => safe default => disabled
  // ============================================================

  async resolveFeatureFlag(
    tenantId: string,

    key: string,

    at:
      | string
      | Date
      | undefined = undefined,
  ): Promise<{
    enabled: boolean;

    flag:
      | ReturnType<
          FeatureFlagService['mapRow']
        >
      | null;

    safeDefault:
      boolean;
  }> {
    this.validateUuid(
      tenantId,
      'tenantId',
    );

    const normalizedKey =
      this.normalizeRequiredString(
        key,

        'key',

        200,
      );

    let effectiveAt:
      | string
      | null;

    try {
      effectiveAt =
        this.normalizeOptionalDate(
          at,

          'at',
        );
    } catch (
      error
    ) {
      /*
       * Invalid caller-provided evaluation time is a request
       * validation error and therefore should not silently become
       * a disabled flag.
       */
      throw error;
    }

    try {
      const result =
        await this.database.query<FeatureFlagRow>(
          `
          SELECT
            f.id::text AS id,

            f.tenant_id::text
              AS tenant_id,

            f.key,

            f.version::text
              AS version,

            f.enabled,

            f.config,

            f.owner,

            f.security_critical,

            f.change_reason,

            f.effective_from::text
              AS effective_from,

            f.expires_at::text
              AS expires_at,

            f.created_by::text
              AS created_by,

            f.created_at::text
              AS created_at

          FROM feature_flags f

          WHERE
            f.tenant_id = $1

            AND f.key = $2

            AND f.effective_from <=
              COALESCE(
                $3::timestamptz,

                now()
              )

            AND (
              f.expires_at IS NULL

              OR f.expires_at >
                COALESCE(
                  $3::timestamptz,

                  now()
                )
            )

          ORDER BY
            f.version DESC

          LIMIT 1
          `,

          [
            tenantId,

            normalizedKey,

            effectiveAt,
          ],

          {
            tenantId,
          },
        );

      const row =
        result.rows[0];

      if (
        !row
      ) {
        return {
          enabled:
            false,

          flag:
            null,

          safeDefault:
            true,
        };
      }

      const flag =
        this.mapRow(
          row,
        );

      return {
        enabled:
          flag.enabled,

        flag,

        safeDefault:
          false,
      };
    } catch {
      /*
       * Blueprint requirement:
       *
       * A capability must have default-safe behaviour when
       * evaluation fails.
       *
       * For feature flags, disabled is the safe default.
       */
      return {
        enabled:
          false,

        flag:
          null,

        safeDefault:
          true,
      };
    }
  }

  // ============================================================
  // LIST
  // ============================================================

  async listFeatureFlags(
    tenantId: string,

    options:
      | ListFeatureFlagsOptions = {},
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
        'f.tenant_id = $1',
      ];

    if (
      options.key !==
      undefined
    ) {
      const normalizedKey =
        this.normalizeRequiredString(
          options.key,

          'key',

          200,
        );

      values.push(
        normalizedKey,
      );

      conditions.push(
        `f.key = $${values.length}`,
      );
    }

    if (
      options.enabled !==
      undefined
    ) {
      if (
        typeof options.enabled !==
        'boolean'
      ) {
        throw new BadRequestException(
          'enabled must be boolean',
        );
      }

      values.push(
        options.enabled,
      );

      conditions.push(
        `f.enabled = $${values.length}`,
      );
    }

    if (
      options.owner !==
      undefined
    ) {
      const normalizedOwner =
        this.normalizeRequiredString(
          options.owner,

          'owner',

          150,
        );

      values.push(
        normalizedOwner,
      );

      conditions.push(
        `f.owner = $${values.length}`,
      );
    }

    if (
      options.securityCritical !==
      undefined
    ) {
      if (
        typeof options.securityCritical !==
        'boolean'
      ) {
        throw new BadRequestException(
          'securityCritical must be boolean',
        );
      }

      values.push(
        options.securityCritical,
      );

      conditions.push(
        `f.security_critical = $${values.length}`,
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
      await this.database.query<FeatureFlagRow>(
        `
        SELECT
          f.id::text AS id,

          f.tenant_id::text
            AS tenant_id,

          f.key,

          f.version::text
            AS version,

          f.enabled,

          f.config,

          f.owner,

          f.security_critical,

          f.change_reason,

          f.effective_from::text
            AS effective_from,

          f.expires_at::text
            AS expires_at,

          f.created_by::text
            AS created_by,

          f.created_at::text
            AS created_at

        FROM feature_flags f

        WHERE
          ${conditions.join(
            '\n          AND ',
          )}

        ORDER BY
          f.key ASC,

          f.version DESC

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
      key: string;

      enabled: boolean;

      config: Record<
        string,
        unknown
      >;

      owner: string;

      securityCritical:
        boolean;

      changeReason:
        | string
        | null;

      effectiveFrom:
        string;

      expiresAt:
        | string
        | null;
    },
  ): Promise<
    FeatureFlagRow
  > {
    const maxAttempts =
      3;

    let lastError:
      | unknown =
      null;

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
             * Calculate the next immutable version while the
             * tenant context is active.
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
                      MAX(f.version),

                      0
                    ) + 1
                  )::text
                    AS next_version

                FROM feature_flags f

                WHERE
                  f.tenant_id = $1

                  AND f.key = $2
                `,

                [
                  tenantId,

                  input.key,
                ],
              );

            const versionRow =
              versionResult
                .rows[0];

            if (
              !versionRow
            ) {
              throw new Error(
                'FEATURE_FLAG_VERSION_CALCULATION_FAILED',
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
                'FEATURE_FLAG_VERSION_IS_INVALID',
              );
            }

            const insertResult =
              await client.query<FeatureFlagRow>(
                `
                INSERT INTO feature_flags (
                  tenant_id,

                  key,

                  version,

                  enabled,

                  config,

                  owner,

                  security_critical,

                  change_reason,

                  effective_from,

                  expires_at,

                  created_by
                )

                VALUES (
                  $1,

                  $2,

                  $3,

                  $4,

                  $5::jsonb,

                  $6,

                  $7,

                  $8,

                  $9::timestamptz,

                  $10::timestamptz,

                  $11
                )

                RETURNING
                  id::text AS id,

                  tenant_id::text
                    AS tenant_id,

                  key,

                  version::text
                    AS version,

                  enabled,

                  config,

                  owner,

                  security_critical,

                  change_reason,

                  effective_from::text
                    AS effective_from,

                  expires_at::text
                    AS expires_at,

                  created_by::text
                    AS created_by,

                  created_at::text
                    AS created_at
                `,

                [
                  tenantId,

                  input.key,

                  version,

                  input.enabled,

                  JSON.stringify(
                    input.config,
                  ),

                  input.owner,

                  input.securityCritical,

                  input.changeReason,

                  input.effectiveFrom,

                  input.expiresAt,

                  actorUserId,
                ],
              );

            const row =
              insertResult.rows[0];

            if (
              !row
            ) {
              throw new Error(
                'FEATURE_FLAG_INSERT_FAILED',
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
         * Two concurrent writers can calculate the same next
         * version. Retry on the PostgreSQL unique violation.
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
        'FEATURE_FLAG_VERSION_INSERT_FAILED',
      )
    );
  }

  // ============================================================
  // INPUT NORMALIZATION
  // ============================================================

  private normalizeCreateInput(
    input:
      CreateFeatureFlagInput,
  ) {
    if (
      !input ||
      typeof input !==
      'object'
    ) {
      throw new BadRequestException(
        'Feature flag input is required',
      );
    }

    const key =
      this.normalizeRequiredString(
        input.key,

        'key',

        200,
      );

    if (
      input.enabled !==
        undefined &&
      typeof input.enabled !==
        'boolean'
    ) {
      throw new BadRequestException(
        'enabled must be boolean',
      );
    }

    const enabled =
      input.enabled ??
      false;

    const owner =
      this.normalizeRequiredString(
        input.owner,

        'owner',

        150,
      );

    const securityCritical =
      input.securityCritical ??
      false;

    if (
      typeof securityCritical !==
      'boolean'
    ) {
      throw new BadRequestException(
        'securityCritical must be boolean',
      );
    }

    let changeReason:
      | string
      | null =
      input.changeReason ??
      null;

    if (
      changeReason !==
      null
    ) {
      changeReason =
        this.normalizeRequiredString(
          changeReason,

          'changeReason',

          2000,
        );
    }

    const effectiveFrom =
      this.normalizeDate(
        input.effectiveFrom,

        'effectiveFrom',

        new Date(),
      );

    const expiresAt =
      input.expiresAt ===
        undefined ||
      input.expiresAt ===
        null
        ? null
        : this.normalizeDate(
            input.expiresAt,

            'expiresAt',
          );

    if (
      expiresAt !==
        null &&
      new Date(
        expiresAt,
      ).getTime() <=
        new Date(
          effectiveFrom,
        ).getTime()
    ) {
      throw new BadRequestException(
        'expiresAt must be later than effectiveFrom',
      );
    }

    /*
     * DB schema already enforces the same invariant for
     * security-critical flags. Enforce it here as well so callers
     * receive a predictable application error.
     */
    if (
      securityCritical &&
      !changeReason
    ) {
      throw new BadRequestException(
        'changeReason is required for security-critical feature flags',
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
      key,

      enabled,

      config,

      owner,

      securityCritical,

      changeReason,

      effectiveFrom,

      expiresAt,
    };
  }

  // ============================================================
  // ROW MAPPING
  // ============================================================

  private mapRow(
    row: FeatureFlagRow,
  ) {
    return {
      id:
        row.id,

      tenantId:
        row.tenant_id,

      key:
        row.key,

      version:
        Number(
          row.version,
        ),

      enabled:
        row.enabled,

      config:
        row.config,

      owner:
        row.owner,

      securityCritical:
        row.security_critical,

      changeReason:
        row.change_reason,

      effectiveFrom:
        row.effective_from,

      expiresAt:
        row.expires_at,

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

    if (
      !normalized
    ) {
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

    if (
      !source
    ) {
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
}