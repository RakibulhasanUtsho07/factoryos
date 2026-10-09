import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AuditService } from '../../audit/audit.service';
import { IamService } from '../iam.service';
import {
  REQUIRED_PERMISSION_KEY,
} from '../require-permission.decorator';
import {
  REQUIRED_FACTORY_SCOPE_KEY,
} from '../require-factory-scope.decorator';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;

  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;

  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission =
      this.reflector.getAllAndOverride<string | undefined>(
        REQUIRED_PERMISSION_KEY,
        [context.getHandler(), context.getClass()],
      );

    /*
     * If endpoint does not require a permission,
     * this guard has nothing to enforce.
     */
    if (!requiredPermission) {
      return true;
    }

    const factoryScoped =
      this.reflector.getAllAndOverride<boolean | undefined>(
        REQUIRED_FACTORY_SCOPE_KEY,
        [context.getHandler(), context.getClass()],
      ) === true;

    const request = context
      .switchToHttp()
      .getRequest<FactoryOsRequest>();

    const requestContext = request.factoryos;

    if (!requestContext) {
      throw new UnauthorizedException(
        'Request context is not initialized',
      );
    }

    /*
     * IMPORTANT:
     * userId and tenantId must come from the verified JWT
     * authentication boundary.
     *
     * Do NOT use requestedUserId / X-User-Id for authorization.
     */
    const userId = requestContext.userId;
    const tenantId = requestContext.tenantId;

    if (!userId) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    if (!tenantId) {
      throw new UnauthorizedException(
        'Authenticated tenant context is missing',
      );
    }

    /*
     * Tenant anti-spoofing check.
     *
     * requestedTenantId represents the temporary request header.
     * Authenticated tenantId represents the verified JWT identity.
     *
     * They must never disagree.
     */
    const requestedTenantId = requestContext.requestedTenantId;

    if (
      requestedTenantId &&
      requestedTenantId !== tenantId
    ) {
      await this.recordAuthorizationAudit({
        request,
        tenantId,
        userId,
        factoryId: requestContext.requestedFactoryId,
        permission: requiredPermission,
        factoryScoped,
        action: 'DENY',
        reason: 'Requested tenant does not match authenticated tenant',
      });

      throw new ForbiddenException(
        'Requested tenant does not match authenticated tenant',
      );
    }

    /*
     * Factory is a request-level scope.
     *
     * IAM will verify whether the authenticated user
     * actually has permission for this factory.
     */
    const factoryId = factoryScoped
      ? requestContext.requestedFactoryId
      : null;

    if (factoryScoped && !factoryId) {
      await this.recordAuthorizationAudit({
        request,
        tenantId,
        userId,
        factoryId: null,
        permission: requiredPermission,
        factoryScoped,
        action: 'DENY',
        reason: 'Factory scope is required',
      });

      throw new UnauthorizedException(
        'Factory scope is required',
      );
    }

    try {
      /*
       * Final authorization decision comes from IAM.
       *
       * IAM checks:
       * - active user
       * - active tenant membership
       * - tenant role
       * - permission
       * - factory scope
       */
      await this.iamService.authorize(
        userId,
        tenantId,
        requiredPermission,
        factoryId,
      );

      /*
       * Store verified authorization context for downstream handlers.
       */
      requestContext.factoryId = factoryId;

      await this.recordAuthorizationAudit({
        request,
        tenantId,
        userId,
        factoryId,
        permission: requiredPermission,
        factoryScoped,
        action: 'ALLOW',
      });

      return true;
    } catch (error) {
      /*
       * Preserve the existing IAM exception behavior.
       *
       * Audit failure must NEVER hide the original authorization error.
       */
      const reason =
        error instanceof Error
          ? error.message
          : 'Authorization denied';

      await this.recordAuthorizationAudit({
        request,
        tenantId,
        userId,
        factoryId,
        permission: requiredPermission,
        factoryScoped,
        action: 'DENY',
        reason,
      });

      throw error;
    }
  }

  private async recordAuthorizationAudit(params: {
    request: FactoryOsRequest;
    tenantId: string;
    userId: string;
    factoryId: string | null;
    permission: string;
    factoryScoped: boolean;
    action: 'ALLOW' | 'DENY';
    reason?: string;
  }): Promise<void> {
    const {
      request,
      tenantId,
      userId,
      factoryId,
      permission,
      factoryScoped,
      action,
      reason,
    } = params;

    const context = request.factoryos;

    if (!context) {
      return;
    }

    try {
      await this.auditService.record({
        tenantId,
        factoryId,
        actorUserId: userId,

        eventType: 'AUTHORIZATION',
        action,

        resourceType: 'PERMISSION',
        resourceId: null,

        correlationId: context.traceId,
        requestId: context.requestId,

        dataClass: 'INTERNAL',

        payload: {
          permission,
          factoryScoped,
          result: action,
          ...(reason ? { reason } : {}),
        },
      });
    } catch {
      /*
       * Audit infrastructure must be fail-safe from the
       * authorization caller's perspective.
       *
       * We intentionally do not throw here.
       */
    }
  }
}