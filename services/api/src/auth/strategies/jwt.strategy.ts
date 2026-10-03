import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwksClient } from 'jwks-rsa';
import { isUUID } from 'class-validator';

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

    /*
     * ============================================================
     * PRODUCTION OIDC / JWKS MODE
     * ============================================================
     */
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
        /*
         * Bearer token:
         *
         * Authorization: Bearer <JWT>
         */
        jwtFromRequest:
          ExtractJwt.fromAuthHeaderAsBearerToken(),

        /*
         * Passport will reject expired tokens.
         */
        ignoreExpiration: false,

        /*
         * Token issuer must match IdP issuer.
         */
        issuer,

        /*
         * Token audience must match FactoryOS API client.
         */
        audience,

        /*
         * Production OIDC tokens are expected
         * to use asymmetric RSA signatures.
         */
        algorithms: ['RS256'],

        /*
         * IMPORTANT:
         * We dynamically resolve the public signing key
         * using JWT header.kid from the IdP JWKS endpoint.
         */
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
                new Error('Invalid JWT format'),
              );
              return;
            }

            const encodedHeader = parts[0];

            if (!encodedHeader) {
              done(
                new Error('JWT header is missing'),
              );
              return;
            }

            const decodedHeader =
              Buffer.from(
                encodedHeader,
                'base64url',
              ).toString('utf8');

            let header: JwkHeader;

            try {
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

            const kid = header.kid;

            if (!kid) {
              done(
                new Error(
                  'JWT key id (kid) is missing',
                ),
              );
              return;
            }

            jwksClient
              .getSigningKey(kid)
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

    /*
     * ============================================================
     * LOCAL DEVELOPMENT MODE
     * ============================================================
     */

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
      /*
       * Local development also uses:
       *
       * Authorization: Bearer <JWT>
       */
      jwtFromRequest:
        ExtractJwt.fromAuthHeaderAsBearerToken(),

      /*
       * Reject expired tokens.
       */
      ignoreExpiration: false,

      /*
       * Development token signing secret.
       */
      secretOrKey: secret,

      /*
       * Token issuer.
       */
      issuer,

      /*
       * Token audience.
       */
      audience,

      /*
       * Local dev-token uses HS256.
       */
      algorithms: ['HS256'],
    });
  }

  /*
   * ============================================================
   * JWT VALIDATION
   * ============================================================
   *
   * This runs AFTER cryptographic JWT validation.
   *
   * It verifies:
   *
   * 1. sub is a valid FactoryOS user UUID
   * 2. tenant_id is a valid tenant UUID
   * 3. user is ACTIVE
   * 4. membership is ACTIVE
   * 5. tenant is ACTIVE
   */
  async validate(
    payload: JwtPayload,
  ): Promise<AuthUser> {
    /*
     * ----------------------------------------------------------
     * Validate authenticated subject
     * ----------------------------------------------------------
     */
    if (
      typeof payload.sub !== 'string' ||
      !isUUID(payload.sub)
    ) {
      throw new UnauthorizedException(
        'Invalid authentication subject',
      );
    }

    /*
     * ----------------------------------------------------------
     * Validate tenant claim
     * ----------------------------------------------------------
     */
    if (
      typeof payload.tenant_id !== 'string' ||
      !isUUID(payload.tenant_id)
    ) {
      throw new UnauthorizedException(
        'Invalid authentication tenant claim',
      );
    }

    /*
     * ----------------------------------------------------------
     * Resolve active FactoryOS membership
     * ----------------------------------------------------------
     */
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
        'User is not an active member of the requested tenant',
      );
    }

    /*
     * ----------------------------------------------------------
     * Return verified FactoryOS authentication context
     * ----------------------------------------------------------
     */
    return {
      userId: row.user_id,
      tenantId: row.tenant_id,
      membershipId: row.membership_id,
    };
  }
}