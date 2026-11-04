import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';

import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const TOKEN_PATTERN = /^fos_scim_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;

interface ScimCredentialRow {
  tenant_id: string;
  issuer: string;
  scopes: string[];
}

interface ScimIdentityRow {
  identity_id: string;
  user_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  display_name: string;
  membership_id: string;
  membership_status: string;
  updated_at: Date | string;
}

function parseBearerToken(authorization: string | undefined): {
  token: string;
  tenantId: string;
} {
  if (typeof authorization !== 'string') {
    throw new UnauthorizedException('SCIM bearer authentication required');
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    throw new UnauthorizedException('SCIM bearer authentication required');
  }

  const match = TOKEN_PATTERN.exec(parts[1]);
  if (!match || !isUUID(match[1])) {
    throw new UnauthorizedException('Invalid SCIM bearer credential');
  }

  return { token: parts[1], tenantId: match[1] };
}

function validateDeactivationPatch(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('SCIM PatchOp body must be an object');
  }

  const patch = body as Record<string, unknown>;
  if (!Array.isArray(patch.schemas) || !patch.schemas.includes(SCIM_PATCH_SCHEMA)) {
    throw new BadRequestException('SCIM PatchOp schema is required');
  }
  if (!Array.isArray(patch.Operations) || patch.Operations.length !== 1) {
    throw new BadRequestException('Only one SCIM deactivation operation is supported');
  }

  const operation = patch.Operations[0];
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new BadRequestException('Invalid SCIM PatchOp operation');
  }

  const item = operation as Record<string, unknown>;
  const op = typeof item.op === 'string' ? item.op.toLowerCase() : '';
  const path = typeof item.path === 'string' ? item.path.toLowerCase() : '';
  let activeValue: unknown = item.value;

  if (activeValue && typeof activeValue === 'object' && !Array.isArray(activeValue)) {
    const value = activeValue as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, 'active')) {
      throw new BadRequestException('SCIM deactivation may change only the active attribute');
    }
    activeValue = value.active;
  } else if (path !== 'active') {
    throw new BadRequestException('SCIM deactivation path must be active');
  }

  if (op !== 'replace' || activeValue !== false || (path && path !== 'active')) {
    throw new BadRequestException('Only replace active=false is supported by this SCIM adapter');
  }
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('SCIM identity timestamp is invalid');
  }
  return date.toISOString();
}

@Injectable()
export class ScimService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  async deprovisionUser(
    authorization: string | undefined,
    identityId: string,
    body: unknown,
  ) {
    if (this.configService.get<string>('SCIM_ENABLED') !== 'true') {
      throw new NotFoundException();
    }
    if (!isUUID(identityId)) {
      throw new BadRequestException('SCIM user id must be a UUID');
    }
    validateDeactivationPatch(body);

    const credential = await this.authenticate(authorization);
    return this.database.transaction(
      async (client) => this.applyDeprovision(client, credential, identityId),
      { tenantId: credential.tenant_id },
    );
  }

  private async authenticate(
    authorization: string | undefined,
  ): Promise<ScimCredentialRow> {
    const { token, tenantId } = parseBearerToken(authorization);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

    const result = await this.database.query<ScimCredentialRow>(
      'UPDATE public.scim_provisioning_credentials ' +
      'SET last_used_at = clock_timestamp() ' +
      'WHERE tenant_id = $1::uuid ' +
      'AND token_sha256 = $2 ' +
      "AND status = 'ACTIVE' " +
      'AND expires_at > clock_timestamp() ' +
      'RETURNING tenant_id::text AS tenant_id, issuer, scopes',
      [tenantId, tokenHash],
      { tenantId },
    );

    const credential = result.rows[0];
    if (!credential) {
      throw new UnauthorizedException('Invalid or expired SCIM bearer credential');
    }
    if (!Array.isArray(credential.scopes) || !credential.scopes.includes('Users:write')) {
      throw new ForbiddenException('SCIM credential lacks Users:write scope');
    }
    return credential;
  }

  private async applyDeprovision(
    client: PoolClient,
    credential: ScimCredentialRow,
    identityId: string,
  ) {
    const targetResult = await client.query<ScimIdentityRow>(
      'SELECT ' +
      'ai.id::text AS identity_id, ai.user_id::text AS user_id, ai.issuer, ai.subject, ' +
      'u.email, u.display_name, tm.id::text AS membership_id, tm.status AS membership_status, ' +
      'tm.updated_at ' +
      'FROM public.auth_identities ai ' +
      'INNER JOIN public.users u ON u.id = ai.user_id ' +
      'INNER JOIN public.tenant_memberships tm ON tm.user_id = ai.user_id AND tm.tenant_id = $1::uuid ' +
      'INNER JOIN public.tenants t ON t.id = tm.tenant_id ' +
      "WHERE ai.id = $2::uuid AND ai.issuer = $3 AND ai.status = 'ACTIVE' AND u.status = 'ACTIVE' AND t.status = 'ACTIVE' " +
      'FOR UPDATE OF tm',
      [credential.tenant_id, identityId, credential.issuer],
    );

    const identity = targetResult.rows[0];
    if (!identity) {
      throw new NotFoundException('SCIM user is not linked to an active identity in this tenant');
    }

    let modifiedAt = identity.updated_at;
    let changed = false;
    let auditEventId: string | null = null;

    if (identity.membership_status !== 'REMOVED') {
      const updateResult = await client.query<{ updated_at: Date | string }>(
        "UPDATE public.tenant_memberships " +
        "SET status = 'REMOVED', updated_at = clock_timestamp() " +
        "WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'REMOVED' " +
        'RETURNING updated_at',
        [identity.membership_id, credential.tenant_id],
      );
      if (updateResult.rowCount !== 1 || !updateResult.rows[0]) {
        throw new Error('SCIM tenant membership deprovision update was not committed');
      }
      modifiedAt = updateResult.rows[0].updated_at;
      changed = true;

      auditEventId = await this.auditService.recordWithClient(client, {
        tenantId: credential.tenant_id,
        actorUserId: null,
        eventType: 'AUTH_IDENTITY',
        action: 'SCIM_DEPROVISION',
        resourceType: 'TENANT_MEMBERSHIP',
        resourceId: identity.membership_id,
        dataClass: 'INTERNAL',
        payload: {
          source: 'SCIM',
          issuer: credential.issuer,
          identityId: identity.identity_id,
          membershipId: identity.membership_id,
          previousStatus: identity.membership_status,
          newStatus: 'REMOVED',
          globalUserDisabled: false,
          siblingTenantMembershipsChanged: false,
        },
      });
    }

    return {
      schemas: [SCIM_USER_SCHEMA],
      id: identity.identity_id,
      externalId: identity.subject,
      userName: identity.email || identity.display_name,
      active: false,
      name: { formatted: identity.display_name },
      meta: {
        resourceType: 'User',
        lastModified: asIso(modifiedAt),
      },
      factoryos: {
        tenantScoped: true,
        membershipStatus: 'REMOVED',
        changed,
        auditEventId,
      },
    };
  }
}

export { SCIM_PATCH_SCHEMA, SCIM_USER_SCHEMA, validateDeactivationPatch };
