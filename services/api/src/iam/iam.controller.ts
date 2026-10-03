import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { LinkAuthIdentityDto } from './dto/link-auth-identity.dto';
import { PermissionGuard } from './guards/permission.guard';
import { IamService } from './iam.service';
import { RequireFactoryScope } from './require-factory-scope.decorator';
import { RequirePermission } from './require-permission.decorator';

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

  user?: {
    userId: string;
    tenantId: string;
    membershipId: string;
  };
};

@Controller('iam')
export class IamController {
  constructor(
    private readonly iamService: IamService,
  ) {}

  // ============================================================
  // GET /api/iam/access
  // ============================================================

  @Get('access')
  async getAccess(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Req() request: FactoryOsRequest,
  ) {
    if (!userId || !tenantId) {
      throw new BadRequestException(
        'x-user-id and x-tenant-id headers are required',
      );
    }

    const access =
      await this.iamService.resolveAccess(
        userId,
        tenantId,
      );

    if (request.factoryos) {
      request.factoryos.userId =
        access.user.id;

      request.factoryos.tenantId =
        access.tenant.id;

      request.factoryos.factoryId = null;
    }

    return access;
  }

  // ============================================================
  // GET /api/iam/authorization-test
  // ============================================================

  @Get('authorization-test')
  @UseGuards(PermissionGuard)
  @RequirePermission('iam.access.read')
  authorizationTest() {
    return {
      authorized: true,
      message: 'Permission check passed',
    };
  }

  // ============================================================
  // GET /api/iam/factory-authorization-test
  // ============================================================

  @Get('factory-authorization-test')
  @UseGuards(PermissionGuard)
  @RequirePermission('iam.access.read')
  @RequireFactoryScope()
  factoryAuthorizationTest() {
    return {
      authorized: true,
      message: 'Factory permission check passed',
    };
  }

  // ============================================================
  // GET /api/iam/users
  // ============================================================

  @Get('users')
  @UseGuards(PermissionGuard)
  @RequirePermission('iam.users.read')
  async getUsers(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Query('limit') limit = '50',
  ) {
    if (!userId || !tenantId) {
      throw new BadRequestException(
        'x-user-id and x-tenant-id headers are required',
      );
    }

    return this.iamService.listUsers(
      userId,
      tenantId,
      Number(limit),
    );
  }

  // ============================================================
  // GET /api/iam/roles
  // ============================================================

  @Get('roles')
  @UseGuards(PermissionGuard)
  @RequirePermission('iam.roles.read')
  async getRoles(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
  ) {
    if (!userId || !tenantId) {
      throw new BadRequestException(
        'x-user-id and x-tenant-id headers are required',
      );
    }

    return this.iamService.listRoles(
      userId,
      tenantId,
    );
  }

  // ============================================================
  // GET /api/iam/permissions
  // ============================================================

  @Get('permissions')
  @UseGuards(PermissionGuard)
  @RequirePermission('iam.permissions.read')
  async getPermissions(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
  ) {
    if (!userId || !tenantId) {
      throw new BadRequestException(
        'x-user-id and x-tenant-id headers are required',
      );
    }

    return this.iamService.listPermissions(
      userId,
      tenantId,
    );
  }

  // ============================================================
  // GET /api/iam/factories
  // ============================================================

  @Get('factories')
  @UseGuards(PermissionGuard)
  @RequirePermission('iam.access.read')
  async getFactories(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
  ) {
    if (!userId || !tenantId) {
      throw new BadRequestException(
        'x-user-id and x-tenant-id headers are required',
      );
    }

    return this.iamService.listFactories(
      userId,
      tenantId,
    );
  }

  // ============================================================
  // POST /api/iam/users/auth-identities
  // ============================================================

  @Post('users/auth-identities')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'iam.users.identities.write',
  )
  async linkAuthIdentity(
    @Req() request: FactoryOsRequest,
    @Body() body: LinkAuthIdentityDto,
  ) {
    /*
     * Identity comes from verified JWT context.
     *
     * Do NOT read X-User-Id here.
     */
    const actorUserId =
      request.factoryos?.userId ?? null;

    const tenantId =
      request.factoryos?.tenantId ?? null;

    if (!actorUserId || !tenantId) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    return this.iamService.linkAuthIdentity(
      actorUserId,
      tenantId,
      body.user_id,
      body.issuer,
      body.subject,
    );
  }
}