import { randomBytes, createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';

import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { IamService } from '../iam/iam.service';
import { IssueEdgeDeviceCredentialDto } from './dto/issue-edge-device-credential.dto';

export interface AuthenticatedEdgeCredential {
  credentialId: string;
  tenantId: string;
  factoryId: string;
  deviceId: string;
}

interface CredentialRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  device_id: string;
  token_hint: string;
  status: 'ACTIVE' | 'REVOKED';
  expires_at: string;
  created_at?: string;
  revoked_at?: string | null;
}

const TOKEN_PATTERN =
  /^fos_edge_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;

@Injectable()
export class EdgeDeviceCredentialService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async issueCredential(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    deviceId: string,
    input: IssueEdgeDeviceCredentialDto = {},
    auditContext: { requestId?: string | null; correlationId?: string | null } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(deviceId, 'deviceId');
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.devices.credentials.manage',
      factoryId,
    );

    const validForDays = input.valid_for_days ?? 90;
    if (!Number.isInteger(validForDays) || validForDays < 1 || validForDays > 366) {
      throw new BadRequestException('valid_for_days must be an integer between 1 and 366');
    }

    const secret = randomBytes(32).toString('base64url');
    const token = `fos_edge_${tenantId.toLowerCase()}.${deviceId.toLowerCase()}.${secret}`;
    const tokenHash = this.hashToken(token);
    const tokenHint = secret.slice(-8);
    const expiresAt = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000).toISOString();

    const result = await this.database.transaction(
      async (client: PoolClient) => {
        const selectedDevice = await client.query<{ id: string; status: string }>(
          `
          SELECT id::text AS id, status
          FROM edge_devices
          WHERE tenant_id = $1 AND factory_id = $2 AND id = $3
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId],
        );
        const device = selectedDevice.rows[0];
        if (!device) throw new NotFoundException('Edge device not found');
        if (device.status !== 'ACTIVE') {
          throw new ConflictException('Credentials can only be issued to an active device');
        }

        const previous = await client.query<{ id: string }>(
          `
          SELECT id::text AS id
          FROM edge_device_credentials
          WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3 AND status = 'ACTIVE'
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId],
        );

        if (previous.rows.length > 0) {
          await client.query(
            `
            UPDATE edge_device_credentials
            SET status = 'REVOKED', revoked_at = NOW()
            WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3 AND status = 'ACTIVE'
            `,
            [tenantId, factoryId, deviceId],
          );
        }

        const created = await client.query<CredentialRow>(
          `
          INSERT INTO edge_device_credentials (
            tenant_id, factory_id, device_id, token_hash, token_hint,
            status, expires_at, issued_by
          )
          VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)
          RETURNING id::text AS id, tenant_id::text AS tenant_id,
                    factory_id::text AS factory_id, device_id::text AS device_id,
                    token_hint, status, expires_at::text AS expires_at,
                    created_at::text AS created_at
          `,
          [tenantId, factoryId, deviceId, tokenHash, tokenHint, expiresAt, actorUserId],
        );
        const credential = created.rows[0];
        if (!credential) throw new Error('EDGE_DEVICE_CREDENTIAL_INSERT_FAILED');

        await client.query(
          `
          INSERT INTO edge_device_credential_events (
            tenant_id, factory_id, device_id, credential_id, event_type, actor_user_id, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          `,
          [
            tenantId,
            factoryId,
            deviceId,
            credential.id,
            previous.rows.length > 0 ? 'ROTATED' : 'ISSUED',
            actorUserId,
            JSON.stringify({
              validForDays,
              tokenHint,
              previousCredentialIds: previous.rows.map((row) => row.id),
            }),
          ],
        );

        return {
          credential,
          previousCredentialCount: previous.rows.length,
        };
      },
      { tenantId, userId: actorUserId },
    );

    await this.recordAuditSafely({
      tenantId,
      factoryId,
      actorUserId,
      eventType: 'EDGE_DEVICE_CREDENTIAL',
      action: result.previousCredentialCount > 0 ? 'ROTATE' : 'ISSUE',
      resourceType: 'EDGE_DEVICE_CREDENTIAL',
      resourceId: result.credential.id,
      ...auditContext,
      payload: {
        deviceId,
        validForDays,
        tokenHint,
        expiresAt: result.credential.expires_at,
        previousCredentialCount: result.previousCredentialCount,
      },
    });

    return {
      credential: {
        id: result.credential.id,
        deviceId,
        status: result.credential.status,
        token,
        tokenHint,
        expiresAt: result.credential.expires_at,
      },
      previousCredentialCount: result.previousCredentialCount,
      secretReturnedOnce: true,
    };
  }

  async revokeCredential(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    deviceId: string,
    credentialId: string,
    auditContext: { requestId?: string | null; correlationId?: string | null } = {},
  ) {
    this.validateScope(tenantId, factoryId, actorUserId);
    this.validateUuid(deviceId, 'deviceId');
    this.validateUuid(credentialId, 'credentialId');
    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'edge.devices.credentials.manage',
      factoryId,
    );

    const result = await this.database.transaction(
      async (client: PoolClient) => {
        const selected = await client.query<CredentialRow>(
          `
          SELECT id::text AS id, tenant_id::text AS tenant_id,
                 factory_id::text AS factory_id, device_id::text AS device_id,
                 token_hint, status, expires_at::text AS expires_at,
                 created_at::text AS created_at, revoked_at::text AS revoked_at
          FROM edge_device_credentials
          WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3 AND id = $4
          FOR UPDATE
          `,
          [tenantId, factoryId, deviceId, credentialId],
        );
        const credential = selected.rows[0];
        if (!credential) throw new NotFoundException('Edge device credential not found');
        if (credential.status === 'REVOKED') {
          return { idempotent: true as const, credential };
        }

        await client.query(
          `
          UPDATE edge_device_credentials SET status = 'REVOKED', revoked_at = NOW()
          WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3 AND id = $4
          `,
          [tenantId, factoryId, deviceId, credentialId],
        );
        await client.query(
          `
          INSERT INTO edge_device_credential_events (
            tenant_id, factory_id, device_id, credential_id, event_type, actor_user_id, metadata
          )
          VALUES ($1, $2, $3, $4, 'REVOKED', $5, '{}'::jsonb)
          `,
          [tenantId, factoryId, deviceId, credentialId, actorUserId],
        );
        return { idempotent: false as const, credential };
      },
      { tenantId, userId: actorUserId },
    );

    if (!result.idempotent) {
      await this.recordAuditSafely({
        tenantId,
        factoryId,
        actorUserId,
        eventType: 'EDGE_DEVICE_CREDENTIAL',
        action: 'REVOKE',
        resourceType: 'EDGE_DEVICE_CREDENTIAL',
        resourceId: credentialId,
        ...auditContext,
        payload: { deviceId, tokenHint: result.credential.token_hint },
      });
    }

    return {
      idempotent: result.idempotent,
      credential: {
        id: result.credential.id,
        deviceId,
        status: 'REVOKED' as const,
        revokedAt: result.credential.revoked_at ?? null,
      },
    };
  }

  async authenticateDeviceToken(
    authorizationHeader: string | undefined,
    requestedDeviceId: string,
  ): Promise<AuthenticatedEdgeCredential> {
    this.validateUuid(requestedDeviceId, 'deviceId');
    const match = /^Bearer (\S+)$/i.exec(authorizationHeader?.trim() ?? '');
    if (!match?.[1]) {
      throw new UnauthorizedException('A device bearer credential is required');
    }

    const token = match[1];
    const tokenMatch = TOKEN_PATTERN.exec(token);
    if (!tokenMatch?.[1] || !tokenMatch[2]) {
      throw new UnauthorizedException('Device credential is invalid');
    }
    const tenantId = tokenMatch[1].toLowerCase();
    const tokenDeviceId = tokenMatch[2].toLowerCase();
    if (!isUUID(tenantId) || !isUUID(tokenDeviceId) || tokenDeviceId !== requestedDeviceId.toLowerCase()) {
      throw new UnauthorizedException('Device credential scope does not match the requested device');
    }

    const tokenHash = this.hashToken(token);
    const result = await this.database.query<CredentialRow>(
      `
      SELECT c.id::text AS id, c.tenant_id::text AS tenant_id,
             c.factory_id::text AS factory_id, c.device_id::text AS device_id,
             c.token_hint, c.status, c.expires_at::text AS expires_at,
             c.created_at::text AS created_at
      FROM edge_device_credentials c
      JOIN edge_devices d
        ON d.id = c.device_id AND d.tenant_id = c.tenant_id AND d.factory_id = c.factory_id
      WHERE c.tenant_id = $1 AND c.device_id = $2 AND c.token_hash = $3
        AND c.status = 'ACTIVE' AND c.expires_at > NOW()
        AND d.status = 'ACTIVE'
      LIMIT 1
      `,
      [tenantId, tokenDeviceId, tokenHash],
      { tenantId, userId: null },
    );
    const credential = result.rows[0];
    if (!credential) {
      throw new UnauthorizedException('Device credential is invalid, expired, revoked, or paused');
    }

    await this.database.query(
      `
      UPDATE edge_device_credentials
      SET last_used_at = NOW()
      WHERE tenant_id = $1 AND factory_id = $2 AND device_id = $3
        AND id = $4 AND status = 'ACTIVE' AND expires_at > NOW()
      `,
      [tenantId, credential.factory_id, credential.device_id, credential.id],
      { tenantId, userId: null },
    );

    return {
      credentialId: credential.id,
      tenantId: credential.tenant_id,
      factoryId: credential.factory_id,
      deviceId: credential.device_id,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private validateScope(tenantId: string, factoryId: string, actorUserId: string) {
    this.validateUuid(tenantId, 'tenantId');
    this.validateUuid(factoryId, 'factoryId');
    this.validateUuid(actorUserId, 'actorUserId');
  }

  private validateUuid(value: string, field: string): void {
    if (!isUUID(value)) throw new BadRequestException(`${field} must be a valid UUID`);
  }

  private async recordAuditSafely(input: AuditEventInput): Promise<void> {
    try {
      await this.auditService.record(input);
    } catch {
      // Never log or persist the raw device bearer token.
    }
  }
}
