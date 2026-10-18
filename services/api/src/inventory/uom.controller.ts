import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  ConvertUomQuantityDto, CreateUomConversionDto, CreateUomUnitDto, ReviewUomConversionDto,
} from './dto/uom.dto';
import { UnitOfMeasureService } from './uom.service';

interface UomRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type UomRequest = Request & { factoryos?: UomRequestContext };

@Controller('inventory/uom')
export class UnitOfMeasureController {
  constructor(private readonly uomService: UnitOfMeasureService) {}

  @Post('units')
  @UseGuards(PermissionGuard)
  @RequirePermission('uom.write')
  @RequireFactoryScope()
  async createUnit(@Req() request: UomRequest, @Body() body: CreateUomUnitDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.uomService.createUnit(
      c.userId, c.tenantId, c.factoryId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get('units')
  @UseGuards(PermissionGuard)
  @RequirePermission('uom.read')
  @RequireFactoryScope()
  async listUnits(@Req() request: UomRequest, @Query('search') search?: string,
    @Query('dimension_code') dimensionCode?: string, @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.uomService.listUnits(c.userId, c.tenantId, c.factoryId, {
      search, dimensionCode, limit: rawLimit === undefined ? undefined : Number(rawLimit),
    });
  }

  @Post('conversions')
  @UseGuards(PermissionGuard)
  @RequirePermission('uom.write')
  @RequireFactoryScope()
  async createConversion(@Req() request: UomRequest, @Body() body: CreateUomConversionDto,
    @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.uomService.createConversion(
      c.userId, c.tenantId, c.factoryId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Get('conversions')
  @UseGuards(PermissionGuard)
  @RequirePermission('uom.read')
  @RequireFactoryScope()
  async listConversions(@Req() request: UomRequest, @Query('status') status?: string,
    @Query('dimension_code') dimensionCode?: string, @Query('limit') rawLimit?: string) {
    const c = this.requireContext(request);
    return this.uomService.listConversions(c.userId, c.tenantId, c.factoryId, {
      status, dimensionCode, limit: rawLimit === undefined ? undefined : Number(rawLimit),
    });
  }

  @Post('conversions/:ruleId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('uom.approve')
  @RequireFactoryScope()
  async reviewConversion(@Req() request: UomRequest, @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @Body() body: ReviewUomConversionDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const c = this.requireContext(request);
    return this.uomService.reviewConversion(
      c.userId, c.tenantId, c.factoryId, ruleId, body, idempotencyKey ?? null, c.requestId, c.traceId,
    );
  }

  @Post('convert')
  @UseGuards(PermissionGuard)
  @RequirePermission('uom.read')
  @RequireFactoryScope()
  async convert(@Req() request: UomRequest, @Body() body: ConvertUomQuantityDto) {
    const c = this.requireContext(request);
    return this.uomService.convert(c.userId, c.tenantId, c.factoryId, body);
  }

  private requireContext(request: UomRequest) {
    const userId = request.factoryos?.userId ?? null;
    const tenantId = request.factoryos?.tenantId ?? null;
    const factoryId = request.factoryos?.factoryId ?? null;
    if (!userId || !tenantId || !factoryId) {
      throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    }
    return {
      userId, tenantId, factoryId,
      requestId: request.factoryos?.requestId ?? null,
      traceId: request.factoryos?.traceId ?? null,
    };
  }
}
