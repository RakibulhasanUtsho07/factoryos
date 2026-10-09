import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';

import type { AuthUser } from '../auth-user';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;

  /*
   * Original request-level values.
   *
   * These can come from temporary development headers.
   * They MUST NOT be overwritten by the authenticated identity.
   */
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;

  /*
   * Verified authentication context.
   *
   * These values come from the validated JWT.
   */
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;

  /*
   * Passport attaches the authenticated user here.
   */
  user?: AuthUser;
};

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    /*
     * Public endpoints bypass JWT authentication.
     *
     * Example:
     *   GET /api/health
     *   POST /api/auth/dev-token
     */
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [
        context.getHandler(),
        context.getClass(),
      ],
    );

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest<TUser = AuthUser>(
    err: unknown,
    user: TUser | false | null | undefined,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    /*
     * Authentication must fail closed.
     *
     * No user = no authenticated request.
     */
    if (err || !user) {
      const message =
        info &&
        typeof info === 'object' &&
        'message' in info &&
        typeof (info as { message?: unknown }).message === 'string'
          ? (info as { message: string }).message
          : 'Authentication required';

      throw (
        err ||
        new UnauthorizedException(message)
      );
    }

    const request =
      context
        .switchToHttp()
        .getRequest<FactoryOsRequest>();

    const authUser =
      user as unknown as AuthUser;

    /*
     * Passport also exposes the authenticated user
     * through request.user.
     */
    request.user = authUser;

    if (request.factoryos) {
      /*
       * SECURITY BOUNDARY
       *
       * These two fields are populated ONLY from
       * the verified JWT identity.
       */
      request.factoryos.userId =
        authUser.userId;

      request.factoryos.tenantId =
        authUser.tenantId;

      /*
       * Do NOT modify:
       *
       * requestedUserId
       * requestedTenantId
       * requestedFactoryId
       *
       * They represent the original incoming request.
       *
       * Keeping them intact allows PermissionGuard
       * to detect tenant/user spoofing attempts.
       */

      /*
       * Authentication does NOT decide factory scope.
       *
       * Factory authorization is handled later by
       * PermissionGuard + IamService.
       *
       * Therefore factoryId remains unchanged here.
       */
    }

    return authUser as TUser;
  }
}