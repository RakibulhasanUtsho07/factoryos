import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';

import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  async issueDevToken(
    providedSecret: string | undefined,
    userId: string,
    tenantId: string,
  ) {
    if (
      process.env.NODE_ENV !== 'development' ||
      process.env.DEV_AUTH_ENABLED !== 'true'
    ) {
      throw new NotFoundException();
    }

    if (!isUUID(userId) || !isUUID(tenantId)) {
      throw new UnauthorizedException('Invalid user_id or tenant_id');
    }

    if (!this.verifyDevSecret(providedSecret)) {
      throw new UnauthorizedException('Invalid development auth secret');
    }

    const result = await this.database.query<{
      user_id: string;
      tenant_id: string;
    }>(
      `
      SELECT
        u.id::text AS user_id,
        t.id::text AS tenant_id
      FROM users u
      INNER JOIN tenant_memberships m
        ON m.user_id = u.id
      INNER JOIN tenants t
        ON t.id = m.tenant_id
      WHERE u.id = $1
        AND t.id = $2
        AND u.status = 'ACTIVE'
        AND m.status = 'ACTIVE'
        AND t.status = 'ACTIVE'
      LIMIT 1
      `,
      [userId, tenantId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new UnauthorizedException(
        'User is not an active member of this tenant',
      );
    }

    const accessToken = await this.jwtService.signAsync({
      sub: row.user_id,
      tenant_id: row.tenant_id,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
      user_id: row.user_id,
      tenant_id: row.tenant_id,
    };
  }

  private verifyDevSecret(providedSecret: string | undefined): boolean {
    const expectedSecret = process.env.DEV_AUTH_SECRET || '';

    if (!providedSecret || !expectedSecret) {
      return false;
    }

    const providedBuffer = Buffer.from(providedSecret, 'utf8');
    const expectedBuffer = Buffer.from(expectedSecret, 'utf8');

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  }
}