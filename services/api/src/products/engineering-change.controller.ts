import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateEngineeringChangeDto } from './dto/create-engineering-change.dto';
import { EngineeringChangeReviewDto } from './dto/engineering-change-review.dto';
import { EngineeringChangeService } from './engineering-change.service';

interface EcoContext { requestId:string; traceId:string; userId:string|null; tenantId:string|null; factoryId:string|null; }
type EcoRequest = Request & { factoryos?: EcoContext };

@Controller('products/:productId/engineering-changes')
export class EngineeringChangeController {
  constructor(private readonly service:EngineeringChangeService) {}

  @Get()
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.read') @RequireFactoryScope()
  list(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Query('limit') limit?:string): Promise<unknown> {
    const c=this.context(req); return this.service.list(c.userId,c.tenantId,c.factoryId,productId,limit===undefined?50:Number(limit));
  }

  @Post()
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.write') @RequireFactoryScope()
  create(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Body() dto:CreateEngineeringChangeDto,
    @Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req); return this.service.create(c.userId,c.tenantId,c.factoryId,productId,dto,key??null,c.requestId,c.traceId);
  }

  @Get(':ecoId/affected-orders')
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.read') @RequireFactoryScope()
  affectedOrders(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Param('ecoId',new ParseUUIDPipe()) ecoId:string): Promise<unknown> {
    const c=this.context(req); return this.service.affectedOrders(c.userId,c.tenantId,c.factoryId,productId,ecoId);
  }

  @Get(':ecoId')
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.read') @RequireFactoryScope()
  detail(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Param('ecoId',new ParseUUIDPipe()) ecoId:string): Promise<unknown> {
    const c=this.context(req); return this.service.detail(c.userId,c.tenantId,c.factoryId,productId,ecoId);
  }

  @Post(':ecoId/submit')
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.write') @RequireFactoryScope()
  submit(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Param('ecoId',new ParseUUIDPipe()) ecoId:string,
    @Body() dto:EngineeringChangeReviewDto,@Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req); return this.service.submit(c.userId,c.tenantId,c.factoryId,productId,ecoId,dto,key??null,c.requestId,c.traceId);
  }

  @Post(':ecoId/approve')
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.approve') @RequireFactoryScope()
  approve(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Param('ecoId',new ParseUUIDPipe()) ecoId:string,
    @Body() dto:EngineeringChangeReviewDto,@Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req); return this.service.decide(c.userId,c.tenantId,c.factoryId,productId,ecoId,'APPROVED',dto,key??null,c.requestId,c.traceId);
  }

  @Post(':ecoId/reject')
  @UseGuards(PermissionGuard) @RequirePermission('products.eco.approve') @RequireFactoryScope()
  reject(@Req() req:EcoRequest,@Param('productId',new ParseUUIDPipe()) productId:string,@Param('ecoId',new ParseUUIDPipe()) ecoId:string,
    @Body() dto:EngineeringChangeReviewDto,@Headers('idempotency-key') key?:string): Promise<unknown> {
    const c=this.context(req); return this.service.decide(c.userId,c.tenantId,c.factoryId,productId,ecoId,'REJECTED',dto,key??null,c.requestId,c.traceId);
  }

  private context(req:EcoRequest):{userId:string;tenantId:string;factoryId:string;requestId:string;traceId:string} {
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId) throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
