import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IamService } from '../iam.service';
import { REQUIRED_PERMISSION_KEY } from '../require-permission.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly iamService: IamService,
  ) {}

  async canActivate(
    context: ExecutionContext,
  ): Promise<boolean> {
    const requiredPermission =
      this.reflector.getAllAndOverride<string>(
        REQUIRED_PERMISSION_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    if (!requiredPermission) {
      return true;
    }

    const request =
      context.switchToHttp().getRequest<Request>();

    const userId =
      request.header('x-user-id')?.trim();

    const tenantId =
      request.header('x-tenant-id')?.trim();

    if (!userId || !tenantId) {
      throw new UnauthorizedException(
        'Authenticated user and tenant context are required',
      );
    }

    const access =
      await this.iamService.resolveAccess(
        userId,
        tenantId,
      );

    const hasPermission =
      access.permissions.some(
        (permission) =>
          permission.code === requiredPermission,
      );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Missing permission: ${requiredPermission}`,
      );
    }

    if (request.factoryos) {
      request.factoryos.userId = access.user.id;
      request.factoryos.tenantId = access.tenant.id;
    }

    return true;
  }
}