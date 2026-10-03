import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

interface AccessRow extends QueryResultRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  tenant_status: string;
  tenant_timezone: string;
  tenant_locale: string;

  user_id: string;
  user_email: string | null;
  display_name: string;
  user_status: string;

  membership_id: string;
  membership_status: string;

  factory_id: string | null;
  factory_code: string | null;
  factory_name: string | null;

  role_id: string | null;
  role_code: string | null;
  role_name: string | null;
  role_is_system: boolean | null;

  permission_id: string | null;
  permission_code: string | null;
  permission_description: string | null;
}

@Injectable()
export class IamService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  // ============================================================
  // RESOLVE ACCESS
  // ============================================================

  async resolveAccess(
    userId: string,
    tenantId: string,
  ) {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');

    const result =
      await this.database.query<AccessRow>(
        `
        SELECT
          t.id AS tenant_id,
          t.slug AS tenant_slug,
          t.name AS tenant_name,
          t.status AS tenant_status,
          t.timezone AS tenant_timezone,
          t.default_locale AS tenant_locale,

          u.id AS user_id,
          u.email AS user_email,
          u.display_name,
          u.status AS user_status,

          tm.id AS membership_id,
          tm.status AS membership_status,

          ur.factory_id,
          f.code AS factory_code,
          f.name AS factory_name,

          r.id AS role_id,
          r.code AS role_code,
          r.name AS role_name,
          r.is_system AS role_is_system,

          p.id AS permission_id,
          p.code AS permission_code,
          p.description AS permission_description

        FROM users u

        INNER JOIN tenant_memberships tm
          ON tm.user_id = u.id
         AND tm.tenant_id = $2
         AND tm.status = 'ACTIVE'

        INNER JOIN tenants t
          ON t.id = tm.tenant_id
         AND t.status = 'ACTIVE'

        LEFT JOIN user_roles ur
          ON ur.membership_id = tm.id

        LEFT JOIN factories f
          ON f.id = ur.factory_id
         AND f.tenant_id = tm.tenant_id

        LEFT JOIN roles r
          ON r.id = ur.role_id
         AND r.tenant_id = tm.tenant_id

        LEFT JOIN role_permissions rp
          ON rp.role_id = r.id

        LEFT JOIN permissions p
          ON p.id = rp.permission_id

        WHERE u.id = $1
          AND u.status = 'ACTIVE'

        ORDER BY
          r.code NULLS LAST,
          p.code NULLS LAST
        `,
        [userId, tenantId],
      );

    if (result.rows.length === 0) {
      throw new NotFoundException(
        'Active user membership not found for this tenant',
      );
    }

    const rows = result.rows;
    const first = rows[0];

    const factories = this.uniqueBy(
      rows
        .filter((row) => row.factory_id)
        .map((row) => ({
          id: row.factory_id,
          code: row.factory_code,
          name: row.factory_name,
        })),
      (item) => item.id as string,
    );

    const roles = this.uniqueBy(
      rows
        .filter((row) => row.role_id)
        .map((row) => ({
          id: row.role_id,
          code: row.role_code,
          name: row.role_name,
          isSystem: row.role_is_system,
        })),
      (item) => item.id as string,
    );

    const permissions = this.uniqueBy(
      rows
        .filter((row) => row.permission_id)
        .map((row) => ({
          id: row.permission_id,
          code: row.permission_code,
          description: row.permission_description,
        })),
      (item) => item.id as string,
    );

    return {
      user: {
        id: first.user_id,
        email: first.user_email,
        displayName: first.display_name,
        status: first.user_status,
      },

      tenant: {
        id: first.tenant_id,
        slug: first.tenant_slug,
        name: first.tenant_name,
        status: first.tenant_status,
        timezone: first.tenant_timezone,
        defaultLocale: first.tenant_locale,
      },

      membership: {
        id: first.membership_id,
        status: first.membership_status,
      },

      factories,
      roles,
      permissions,
    };
  }

  // ============================================================
  // AUTHORIZE
  // ============================================================

  async authorize(
    userId: string,
    tenantId: string,
    permissionCode: string,
    factoryId: string | null = null,
  ): Promise<void> {
    this.validateUuid(userId, 'userId');
    this.validateUuid(tenantId, 'tenantId');

    if (factoryId) {
      this.validateUuid(factoryId, 'factoryId');
    }

    const result =
      await this.database.query(
        `
        SELECT 1
        FROM users u

        INNER JOIN tenant_memberships tm
          ON tm.user_id = u.id
         AND tm.tenant_id = $2
         AND tm.status = 'ACTIVE'

        INNER JOIN tenants t
          ON t.id = tm.tenant_id
         AND t.status = 'ACTIVE'

        INNER JOIN user_roles ur
          ON ur.membership_id = tm.id

        INNER JOIN roles r
          ON r.id = ur.role_id
         AND r.tenant_id = tm.tenant_id

        INNER JOIN role_permissions rp
          ON rp.role_id = r.id

        INNER JOIN permissions p
          ON p.id = rp.permission_id
         AND p.code = $3

        LEFT JOIN factories f
          ON f.id = ur.factory_id
         AND f.tenant_id = tm.tenant_id

        WHERE u.id = $1
          AND u.status = 'ACTIVE'

          AND (
            $4::uuid IS NULL

            OR (
              f.id = $4::uuid
              AND f.status = 'ACTIVE'
              AND f.tenant_id = tm.tenant_id
            )

            OR ur.factory_id IS NULL
          )

        LIMIT 1
        `,
        [
          userId,
          tenantId,
          permissionCode,
          factoryId,
        ],
      );

    if (result.rows.length === 0) {
      throw new ForbiddenException(
        factoryId
          ? `Missing permission or factory scope: ${permissionCode}`
          : `Missing permission: ${permissionCode}`,
      );
    }
  }

  // ============================================================
  // LIST USERS
  // ============================================================

  async listUsers(
    userId: string,
    tenantId: string,
    requestedLimit = 50,
  ) {
    await this.authorize(
      userId,
      tenantId,
      'iam.users.read',
      null,
    );

    const numericLimit =
      Number(requestedLimit);

    const limit = Math.min(
      Math.max(
        Number.isFinite(numericLimit)
          ? numericLimit
          : 50,
        1,
      ),
      100,
    );

    const result =
      await this.database.query(
        `
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.status,
          u.created_at,
          u.updated_at
        FROM users u

        INNER JOIN tenant_memberships tm
          ON tm.user_id = u.id

        WHERE tm.tenant_id = $1
          AND tm.status = 'ACTIVE'

        ORDER BY u.created_at ASC

        LIMIT $2
        `,
        [
          tenantId,
          limit,
        ],
      );

    return {
      items: result.rows,
      limit,
      count: result.rows.length,
    };
  }

  // ============================================================
  // LIST ROLES
  // ============================================================

  async listRoles(
    userId: string,
    tenantId: string,
  ) {
    await this.authorize(
      userId,
      tenantId,
      'iam.roles.read',
      null,
    );

    const result =
      await this.database.query(
        `
        SELECT
          id,
          code,
          name,
          description,
          is_system,
          created_at,
          updated_at,
          version

        FROM roles

        WHERE tenant_id = $1

        ORDER BY code
        `,
        [tenantId],
      );

    return {
      items: result.rows,
      count: result.rows.length,
    };
  }

  // ============================================================
  // LIST PERMISSIONS
  // ============================================================

  async listPermissions(
    userId: string,
    tenantId: string,
  ) {
    await this.authorize(
      userId,
      tenantId,
      'iam.permissions.read',
      null,
    );

    const result =
      await this.database.query(
        `
        SELECT
          id,
          code,
          description,
          created_at

        FROM permissions

        ORDER BY code
        `,
      );

    return {
      items: result.rows,
      count: result.rows.length,
    };
  }

  // ============================================================
  // LIST FACTORIES
  // ============================================================

  async listFactories(
    userId: string,
    tenantId: string,
  ) {
    await this.authorize(
      userId,
      tenantId,
      'iam.access.read',
      null,
    );

    const result =
      await this.database.query(
        `
        SELECT
          id,
          code,
          name,
          status,
          timezone,
          created_at,
          updated_at,
          version

        FROM factories

        WHERE tenant_id = $1

        ORDER BY code
        `,
        [tenantId],
      );

    return {
      items: result.rows,
      count: result.rows.length,
    };
  }

  // ============================================================
  // LINK EXTERNAL AUTH IDENTITY
  // ============================================================

  async linkAuthIdentity(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
    issuer: string,
    subject: string,
  ) {
    /*
     * ----------------------------------------------------------
     * Validate UUID inputs
     * ----------------------------------------------------------
     */

    this.validateUuid(
      actorUserId,
      'actorUserId',
    );

    this.validateUuid(
      tenantId,
      'tenantId',
    );

    this.validateUuid(
      targetUserId,
      'targetUserId',
    );

    /*
     * ----------------------------------------------------------
     * Normalize and validate external identity
     * ----------------------------------------------------------
     */

    const normalizedIssuer =
      issuer?.trim();

    const normalizedSubject =
      subject?.trim();

    if (!normalizedIssuer) {
      throw new BadRequestException(
        'issuer is required',
      );
    }

    if (!normalizedSubject) {
      throw new BadRequestException(
        'subject is required',
      );
    }

    if (normalizedIssuer.length > 500) {
      throw new BadRequestException(
        'issuer must not exceed 500 characters',
      );
    }

    if (normalizedSubject.length > 255) {
      throw new BadRequestException(
        'subject must not exceed 255 characters',
      );
    }

    /*
     * ----------------------------------------------------------
     * Actor permission
     * ----------------------------------------------------------
     */

    await this.authorize(
      actorUserId,
      tenantId,
      'iam.users.identities.write',
      null,
    );

    /*
     * ----------------------------------------------------------
     * Verify target user belongs to this tenant
     * ----------------------------------------------------------
     */

    const targetResult =
      await this.database.query<{
        user_id: string;
        membership_id: string;
      }>(
        `
        SELECT
          u.id::text AS user_id,
          tm.id::text AS membership_id

        FROM users u

        INNER JOIN tenant_memberships tm
          ON tm.user_id = u.id

        INNER JOIN tenants t
          ON t.id = tm.tenant_id

        WHERE u.id = $1
          AND tm.tenant_id = $2
          AND u.status = 'ACTIVE'
          AND tm.status = 'ACTIVE'
          AND t.status = 'ACTIVE'

        LIMIT 1
        `,
        [
          targetUserId,
          tenantId,
        ],
      );

    const target =
      targetResult.rows[0];

    if (!target) {
      throw new ForbiddenException(
        'Target user is not an active member of this tenant',
      );
    }

    /*
     * ----------------------------------------------------------
     * Check whether issuer + subject is already linked
     * ----------------------------------------------------------
     */

    const existingIdentity =
      await this.database.query<{
        id: string;
        user_id: string;
      }>(
        `
        SELECT
          ai.id::text AS id,
          ai.user_id::text AS user_id

        FROM auth_identities ai

        WHERE ai.issuer = $1
          AND ai.subject = $2

        LIMIT 1
        `,
        [
          normalizedIssuer,
          normalizedSubject,
        ],
      );

    const existing =
      existingIdentity.rows[0];

    if (existing) {
      if (
        existing.user_id === targetUserId
      ) {
        throw new ConflictException(
          'This external authentication identity is already linked to this user',
        );
      }

      throw new ConflictException(
        'This external authentication identity is already linked to another user',
      );
    }

    /*
     * ----------------------------------------------------------
     * Insert identity
     * ----------------------------------------------------------
     */

    let inserted: {
      id: string;
      user_id: string;
      issuer: string;
      subject: string;
      status: string;
      created_at: string;
    };

    try {
      const insertResult =
        await this.database.query<{
          id: string;
          user_id: string;
          issuer: string;
          subject: string;
          status: string;
          created_at: string;
        }>(
          `
          INSERT INTO auth_identities (
            user_id,
            issuer,
            subject,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            'ACTIVE'
          )

          RETURNING
            id::text AS id,
            user_id::text AS user_id,
            issuer,
            subject,
            status,
            created_at::text AS created_at
          `,
          [
            targetUserId,
            normalizedIssuer,
            normalizedSubject,
          ],
        );

      const row =
        insertResult.rows[0];

      if (!row) {
        throw new BadRequestException(
          'Failed to create authentication identity',
        );
      }

      inserted = row;
    } catch (error) {
      /*
       * PostgreSQL unique constraint:
       *
       * uq_auth_identity_issuer_subject
       */
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code ===
          '23505'
      ) {
        throw new ConflictException(
          'This external authentication identity is already linked',
        );
      }

      throw error;
    }

    /*
     * ----------------------------------------------------------
     * Audit identity-link action
     * ----------------------------------------------------------
     */

    try {
      await this.auditService.record({
        tenantId,

        factoryId: null,

        actorUserId,

        eventType: 'AUTH_IDENTITY',

        action: 'LINK',

        resourceType: 'USER_AUTH_IDENTITY',

        resourceId: inserted.id,

        correlationId: null,

        requestId: null,

        dataClass: 'INTERNAL',

        payload: {
          targetUserId: inserted.user_id,
          issuer: inserted.issuer,
          subject: inserted.subject,
          result: 'LINK',
        },
      });
    } catch {
      /*
       * Identity linking succeeded.
       *
       * Audit failure must not convert a successful
       * identity-link operation into an application failure.
       */
    }

    /*
     * ----------------------------------------------------------
     * Response
     * ----------------------------------------------------------
     */

    return {
      id: inserted.id,
      user_id: inserted.user_id,
      issuer: inserted.issuer,
      subject: inserted.subject,
      status: inserted.status,
      created_at: inserted.created_at,
    };
  }

  // ============================================================
  // UUID VALIDATION
  // ============================================================

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

  // ============================================================
  // UNIQUE ARRAY HELPER
  // ============================================================

  private uniqueBy<T>(
    items: T[],
    keyFn: (item: T) => string,
  ): T[] {
    const map =
      new Map<string, T>();

    for (const item of items) {
      const key = keyFn(item);

      if (!map.has(key)) {
        map.set(key, item);
      }
    }

    return Array.from(
      map.values(),
    );
  }
}