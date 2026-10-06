import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type {
  Request,
} from 'express';

import {
  PermissionGuard,
} from '../iam/guards/permission.guard';

import {
  RequireFactoryScope,
} from '../iam/require-factory-scope.decorator';

import {
  RequirePermission,
} from '../iam/require-permission.decorator';

import {
  CbbService,
} from './cbb.service';

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

@Controller(
  'v1/business-model',
)
export class CbbController {
  constructor(
    private readonly cbbService:
      CbbService,
  ) {}

  // ============================================================
  // GET /api/v1/business-model
  // ============================================================

  @Get()
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.read',
  )
  @RequireFactoryScope()
  async getBusinessModel(
    @Req()
    request: FactoryOsRequest,
  ) {
    const {
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.cbbService.getBusinessModel(
      tenantId,
      factoryId,
    );
  }

  // ============================================================
  // GET /api/v1/business-model/map
  // ============================================================

  @Get('map')
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.read',
  )
  @RequireFactoryScope()
  async getBusinessMap(
    @Req()
    request: FactoryOsRequest,
  ) {
    const {
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.cbbService.getBusinessMap(
      tenantId,
      factoryId,
    );
  }

  // ============================================================
  // GET /api/v1/business-model/processes
  // ============================================================

  @Get('processes')
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.read',
  )
  @RequireFactoryScope()
  async listProcesses(
    @Req()
    request: FactoryOsRequest,
  ) {
    const {
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.cbbService.listProcesses(
      tenantId,
      factoryId,
    );
  }

  // ============================================================
  // GET /api/v1/business-model/processes/:id
  // ============================================================

  @Get(
    'processes/:id',
  )
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.read',
  )
  @RequireFactoryScope()
  async getProcess(
    @Req()
    request: FactoryOsRequest,

    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    processId: string,
  ) {
    const {
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.cbbService.getProcess(
      tenantId,
      factoryId,
      processId,
    );
  }

  // ============================================================
  // AUTHENTICATED FACTORY CONTEXT
  // ============================================================

  private getAuthenticatedFactoryContext(
    request: FactoryOsRequest,
  ): {
    userId: string;
    tenantId: string;
    factoryId: string;
  } {
    const userId =
      request.factoryos?.userId ??
      null;

    const tenantId =
      request.factoryos?.tenantId ??
      null;

    const factoryId =
      request.factoryos?.factoryId ??
      null;

    if (
      !userId ||
      !tenantId ||
      !factoryId
    ) {
      throw new UnauthorizedException(
        'Authenticated factory context is missing',
      );
    }

    return {
      userId,
      tenantId,
      factoryId,
    };
  }
}