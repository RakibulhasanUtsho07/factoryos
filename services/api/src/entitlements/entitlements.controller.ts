import { jest } from '@jest/globals';

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import {
  IamService,
} from '../iam/iam.service';

import {
  PermissionGuard,
} from '../iam/guards/permission.guard';

import {
  RequirePermission,
} from '../iam/require-permission.decorator';

import {
  CreateEntitlementDto,
} from './dto/create-entitlement.dto';

import {
  ListEntitlementsDto,
} from './dto/list-entitlements.dto';

import {
  CreateFeatureFlagDto,
} from './dto/create-feature-flag.dto';


import {
  EvaluateFeatureFlagDto,
} from './dto/evaluate-feature-flag.dto';

import {
  EntitlementService,
} from './entitlement.service';

import {
  FeatureFlagService,
} from './feature-flag.service';
import { ListFeatureFlagsDto } from './dto/list-feature-flags.dto';

interface FactoryOsRequestContext {
  requestId: string;

  traceId: string;

  requestedUserId:
    | string
    | null;

  requestedTenantId:
    | string
    | null;

  requestedFactoryId:
    | string
    | null;

  /**
   * Verified authentication context.
   *
   * These values come from the authentication boundary
   * and MUST NOT be replaced with request headers.
   */
  userId:
    | string
    | null;

  tenantId:
    | string
    | null;

  factoryId:
    | string
    | null;
}

type FactoryOsRequest =
  Request & {
    factoryos?:
      FactoryOsRequestContext;
  };

@Controller('admin/v1')
export class EntitlementsController {
  constructor(
    private readonly entitlementService:
      EntitlementService,

    private readonly featureFlagService:
      FeatureFlagService,

    private readonly iamService:
      IamService,
  ) {}

  // ============================================================
  // ENTITLEMENTS
  // ============================================================

  // ------------------------------------------------------------
  // GET /api/admin/v1/entitlements
  // ------------------------------------------------------------

  @Get('entitlements')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'entitlements.read',
  )
  async listEntitlements(
    @Req()
    request: FactoryOsRequest,

    @Query()
    query: ListEntitlementsDto,
  ) {
    const {
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    return this.entitlementService.listEntitlements(
      tenantId,

      {
        package:
          query.package,

        featureKey:
          query.feature_key,

        status:
          query.status,

        limit:
          query.limit,

        offset:
          query.offset,
      },
    );
  }

  // ------------------------------------------------------------
  // GET /api/admin/v1/entitlements/:id
  // ------------------------------------------------------------

  @Get(
    'entitlements/:id',
  )
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'entitlements.read',
  )
  async getEntitlement(
    @Req()
    request: FactoryOsRequest,

    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    entitlementId: string,
  ) {
    const {
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    return this.entitlementService.getEntitlement(
      tenantId,

      entitlementId,
    );
  }

  // ------------------------------------------------------------
  // POST /api/admin/v1/entitlements
  // ------------------------------------------------------------

  @Post('entitlements')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'entitlements.write',
  )
  async createEntitlement(
    @Req()
    request: FactoryOsRequest,

    @Body()
    body: CreateEntitlementDto,
  ) {
    const {
      userId,
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    return this.entitlementService.createEntitlement(
      tenantId,

      userId,

      {
        package:
          body.package,

        featureKey:
          body.feature_key,

        limitValue:
          body.limit_value,

        period:
          body.period,

        status:
          body.status,

        effectiveFrom:
          body.effective_from,

        effectiveTo:
          body.effective_to,

        config:
          body.config,
      },
    );
  }

  // ============================================================
  // FEATURE FLAGS
  // ============================================================

  // ------------------------------------------------------------
  // GET /api/admin/v1/feature-flags
  // ------------------------------------------------------------

  @Get('feature-flags')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'feature_flags.read',
  )
  async listFeatureFlags(
    @Req()
    request: FactoryOsRequest,

    @Query()
    query: ListFeatureFlagsDto,
  ) {
    const {
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    return this.featureFlagService.listFeatureFlags(
      tenantId,

      {
        key:
          query.key,

        enabled:
          query.enabled,

        owner:
          query.owner,

        securityCritical:
          query.security_critical,

        limit:
          query.limit,

        offset:
          query.offset,
      },
    );
  }

  // ------------------------------------------------------------
  // GET /api/admin/v1/feature-flags/:id
  // ------------------------------------------------------------

  @Get(
    'feature-flags/:id',
  )
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'feature_flags.read',
  )
  async getFeatureFlag(
    @Req()
    request: FactoryOsRequest,

    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    featureFlagId: string,
  ) {
    const {
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    return this.featureFlagService.getFeatureFlag(
      tenantId,

      featureFlagId,
    );
  }

  // ------------------------------------------------------------
  // POST /api/admin/v1/feature-flags
  // ------------------------------------------------------------

  @Post('feature-flags')
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'feature_flags.write',
  )
  async createFeatureFlag(
    @Req()
    request: FactoryOsRequest,

    @Body()
    body: CreateFeatureFlagDto,
  ) {
    const {
      userId,
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    /*
     * Normal feature-flag writes are authorized by the endpoint
     * permission above.
     *
     * Security-critical changes require a SECOND trusted
     * authorization decision from IAM.
     *
     * We intentionally do not trust:
     *
     *   - X-User-Id
     *   - X-Tenant-Id
     *   - a caller-provided "authorized" boolean
     *
     * The boolean passed into FeatureFlagService is therefore
     * derived only after IAM verifies the authenticated user.
     */
    let securityCriticalChangeAuthorized =
      false;

    if (
      body.security_critical ===
      true
    ) {
      await this.iamService.authorize(
        userId,

        tenantId,

        'feature_flags.security_critical.write',

        null,
      );

      securityCriticalChangeAuthorized =
        true;
    }

    return this.featureFlagService.createFeatureFlag(
      tenantId,

      userId,

      {
        key:
          body.key,

        enabled:
          body.enabled,

        config:
          body.config,

        owner:
          body.owner,

        securityCritical:
          body.security_critical,

        changeReason:
          body.change_reason,

        effectiveFrom:
          body.effective_from,

        expiresAt:
          body.expires_at,
      },

      {
        securityCriticalChangeAuthorized,
      },
    );
  }

  // ------------------------------------------------------------
  // GET /api/admin/v1/feature-flags/:key/evaluate
  // ------------------------------------------------------------

  @Get(
    'feature-flags/:key/evaluate',
  )
  @UseGuards(PermissionGuard)
  @RequirePermission(
    'feature_flags.read',
  )
  async evaluateFeatureFlag(
    @Req()
    request: FactoryOsRequest,

    @Param('key')
    key: string,

    @Query()
    query: EvaluateFeatureFlagDto,
  ) {
    const {
      tenantId,
    } =
      this.getAuthenticatedContext(
        request,
      );

    return this.featureFlagService.resolveFeatureFlag(
      tenantId,

      key,

      query.at,
    );
  }

  // ============================================================
  // AUTHENTICATED REQUEST CONTEXT
  // ============================================================

  private getAuthenticatedContext(
    request: FactoryOsRequest,
  ): {
    userId: string;

    tenantId: string;
  } {
    /*
     * SECURITY BOUNDARY
     *
     * These values must come from the verified JWT context.
     *
     * Never use:
     *
     *   request.headers['x-user-id']
     *   request.headers['x-tenant-id']
     *   request.factoryos.requestedUserId
     *   request.factoryos.requestedTenantId
     */

    const userId =
      request.factoryos?.userId ??
      null;

    const tenantId =
      request.factoryos?.tenantId ??
      null;

    if (
      !userId ||
      !tenantId
    ) {
      throw new UnauthorizedException(
        'Authenticated user context is missing',
      );
    }

    return {
      userId,

      tenantId,
    };
  }
}