import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwksClient } from 'jwks-rsa';
import { isUUID } from 'class-validator';
import type { Request } from 'express';

import { DatabaseService } from '../../database/database.service';
import type { AuthUser } from '../auth-user';

interface JwtPayload {
  sub?: string;
  tenant_id?: string;

  iss?: string;
  aud?: string | string[];

  iat?: number;
  exp?: number;
}

interface JwkHeader {
  kid?: string;
}

interface FactoryOsRequestContext {
  requestedTenantId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(
  Strategy,
  'jwt',
) {
  constructor(
    private readonly database: DatabaseService,
    private readonly configService: ConfigService,
  ) {
    const authMode =
      configService.get<string>('AUTH_MODE') || 'dev';

    // ==========================================================
    // PRODUCTION OIDC / JWKS MODE
    // ==========================================================

    if (authMode === 'oidc') {
      const issuer =
        configService.get<string>('OIDC_ISSUER');

      const audience =
        configService.get<string>('OIDC_AUDIENCE');

      const jwksUri =
        configService.get<string>('OIDC_JWKS_URI');

      if (!issuer) {
        throw new Error(
          'OIDC_ISSUER is required when AUTH_MODE=oidc',
        );
      }

      if (!audience) {
        throw new Error(
          'OIDC_AUDIENCE is required when AUTH_MODE=oidc',
        );
      }

      if (!jwksUri) {
        throw new Error(
          'OIDC_JWKS_URI is required when AUTH_MODE=oidc',
        );
      }

      const jwksClient = new JwksClient({
        jwksUri,

        cache: true,
        cacheMaxEntries: 5,
        cacheMaxAge: 10 * 60 * 1000,

        rateLimit: true,
        jwksRequestsPerMinute: 10,
      });

      super({
        jwtFromRequest:
          ExtractJwt.fromAuthHeaderAsBearerToken(),

        ignoreExpiration: false,

        issuer,

        audience,

        algorithms: ['RS256'],

        passReqToCallback: true,

        secretOrKeyProvider: (
          _request,
          rawJwtToken,
          done,
        ) => {
          try {
            const parts =
              rawJwtToken.split('.');

            if (parts.length !== 3) {
              done(
                new Error(
                  'Invalid JWT format',
                ),
              );
              return;
            }

            const encodedHeader = parts[0];

            if (!encodedHeader) {
              done(
                new Error(
                  'JWT header is missing',
                ),
              );
              return;
            }

            let header: JwkHeader;

            try {
              const decodedHeader =
                Buffer.from(
                  encodedHeader,
                  'base64url',
                ).toString('utf8');

              header =
                JSON.parse(
                  decodedHeader,
                ) as JwkHeader;
            } catch {
              done(
                new Error(
                  'Invalid JWT header',
                ),
              );
              return;
            }

            if (!header.kid) {
              done(
                new Error(
                  'JWT key id (kid) is missing',
                ),
              );
              return;
            }

            jwksClient
              .getSigningKey(header.kid)
              .then((signingKey) => {
                done(
                  null,
                  signingKey.getPublicKey(),
                );
              })
              .catch((error: unknown) => {
                done(
                  error instanceof Error
                    ? error
                    : new Error(
                        'Unable to resolve OIDC signing key',
                      ),
                );
              });
          } catch (error) {
            done(
              error instanceof Error
                ? error
                : new Error(
                    'Unable to resolve OIDC signing key',
                  ),
            );
          }
        },
      });

      return;
    }

    // ==========================================================
    // LOCAL DEVELOPMENT MODE
    // ==========================================================

    const secret =
      configService.get<string>('JWT_SECRET');

    if (!secret) {
      throw new Error(
        'JWT_SECRET is required in services/api/.env',
      );
    }

    const issuer =
      configService.get<string>('JWT_ISSUER') ||
      'factoryos-api';

    const audience =
      configService.get<string>('JWT_AUDIENCE') ||
      'factoryos-web';

    super({
      jwtFromRequest:
        ExtractJwt.fromAuthHeaderAsBearerToken(),

      ignoreExpiration: false,

      secretOrKey: secret,

      issuer,

      audience,

      algorithms: ['HS256'],

      passReqToCallback: true,
    });
  }

  // ============================================================
  // JWT VALIDATION
  // ============================================================

  async validate(
    request: FactoryOsRequest,
    payload: JwtPayload,
  ): Promise<AuthUser> {
    const authMode =
      this.configService.get<string>('AUTH_MODE') ||
      'dev';

    // ==========================================================
    // SUBJECT
    // ==========================================================

    /*
     * Production OIDC:
     *
     *   sub = arbitrary external IdP subject
     *
     * Therefore do NOT use UUID validation here.
     */
    if (
      typeof payload.sub !== 'string' ||
      payload.sub.trim().length === 0
    ) {
      throw new UnauthorizedException(
        'Invalid authentication subject',
      );
    }

    /*
     * auth_identities.subject is varchar(255).
     */
    if (payload.sub.length > 255) {
      throw new UnauthorizedException(
        'Authentication subject exceeds maximum length',
      );
    }

    // ==========================================================
    // LOCAL DEVELOPMENT
    // ==========================================================

    /*
     * Existing dev-token flow intentionally keeps
     * UUID user IDs.
     */
    if (authMode !== 'oidc') {
      return this.resolveDevelopmentIdentity(
        payload,
      );
    }

    // ==========================================================
    // PRODUCTION OIDC
    // ==========================================================

    if (
      typeof payload.iss !== 'string' ||
      payload.iss.trim().length === 0
    ) {
      throw new UnauthorizedException(
        'JWT issuer is missing',
      );
    }

    /*
     * Resolve:
     *
     *   issuer + external subject
     *          ↓
     *   auth_identities
     *          ↓
     *   FactoryOS users
     */
    const identityResult =
      await this.database.query<{
        user_id: string;
      }>(
        `
        SELECT
          ai.user_id::text AS user_id

        FROM auth_identities ai

        INNER JOIN users u
          ON u.id = ai.user_id

        WHERE ai.issuer = $1
          AND ai.subject = $2
          AND ai.status = 'ACTIVE'
          AND u.status = 'ACTIVE'

        LIMIT 1
        `,
        [
          payload.iss,
          payload.sub,
        ],
      );

    const identity =
      identityResult.rows[0];

    if (!identity) {
      throw new UnauthorizedException(
        'OIDC identity is not linked to a FactoryOS user',
      );
    }

    // ==========================================================
    // TENANT MEMBERSHIP
    // ==========================================================

    /*
     * Tenant comes from an explicit request selector,
     * not from an arbitrary untrusted identity claim.
     */
    const requestedTenantId =
      request.factoryos?.requestedTenantId ??
      null;

    const membershipResult =
      await this.database.query<{
        membership_id: string;
        tenant_id: string;
      }>(
        `
        SELECT
          m.id::text AS membership_id,
          m.tenant_id::text AS tenant_id

        FROM tenant_memberships m

        INNER JOIN tenants t
          ON t.id = m.tenant_id

        WHERE m.user_id = $1
          AND m.status = 'ACTIVE'
          AND t.status = 'ACTIVE'
          AND (
            $2::uuid IS NULL
            OR m.tenant_id = $2::uuid
          )

        ORDER BY m.created_at ASC
        `,
        [
          identity.user_id,
          requestedTenantId,
        ],
      );

    const memberships =
      membershipResult.rows;

    if (memberships.length === 0) {
      throw new UnauthorizedException(
        'Authenticated user has no active tenant membership',
      );
    }

    /*
     * Multi-tenant users must explicitly select
     * their tenant.
     */
    if (
      memberships.length > 1 &&
      !requestedTenantId
    ) {
      throw new BadRequestException(
        'Tenant context is required for a multi-tenant user',
      );
    }

    const membership =
      memberships[0];

    return {
      userId: identity.user_id,
      tenantId: membership.tenant_id,
      membershipId:
        membership.membership_id,
    };
  }

  // ============================================================
  // DEVELOPMENT IDENTITY RESOLUTION
  // ============================================================

  private async resolveDevelopmentIdentity(
    payload: JwtPayload,
  ): Promise<AuthUser> {
    if (
      typeof payload.sub !== 'string' ||
      !isUUID(payload.sub)
    ) {
      throw new UnauthorizedException(
        'Invalid development authentication subject',
      );
    }

    if (
      typeof payload.tenant_id !== 'string' ||
      !isUUID(payload.tenant_id)
    ) {
      throw new UnauthorizedException(
        'Invalid development authentication tenant claim',
      );
    }

    const result =
      await this.database.query<{
        user_id: string;
        tenant_id: string;
        membership_id: string;
      }>(
        `
        SELECT
          u.id::text AS user_id,
          t.id::text AS tenant_id,
          m.id::text AS membership_id

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
        [
          payload.sub,
          payload.tenant_id,
        ],
      );

    const row = result.rows[0];

    if (!row) {
      throw new UnauthorizedException(
        'Development user is not an active member of the requested tenant',
      );
    }

    return {
      userId: row.user_id,
      tenantId: row.tenant_id,
      membershipId: row.membership_id,
    };
  }
}