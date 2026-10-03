import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isUUID,
} from 'class-validator';
import {
  QueryResultRow,
} from 'pg';

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
  ) {}

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

  private uniqueBy<T>(
    items: T[],
    keyFn: (item: T) => string,
  ): T[] {
    const map = new Map<string, T>();

    for (const item of items) {
      const key = keyFn(item);

      if (!map.has(key)) {
        map.set(key, item);
      }
    }

    return Array.from(map.values());
  }
}