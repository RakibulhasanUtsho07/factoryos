import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query,
  Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateProductAlternateDto } from './dto/create-product-alternate.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductVersionDto } from './dto/create-product-version.dto';
import { CreateWorkCentreDto } from './dto/create-work-centre.dto';
import { ExpectedVersionDto } from './dto/expected-version.dto';
import { ReplaceProductBomDto } from './dto/replace-product-bom.dto';
import { ReplaceProductRoutingDto } from './dto/replace-product-routing.dto';
import { ProductDefinitionsService } from './products.service';

interface ProductRequestContext {
  requestId:string; traceId:string; userId:string|null; tenantId:string|null; factoryId:string|null;
}
type ProductRequest=Request & {factoryos?:ProductRequestContext};

@Controller('products')
export class ProductsController {
  constructor(private readonly service:ProductDefinitionsService) {}

  @Get()
  @UseGuards(PermissionGuard) @RequirePermission('products.master.read') @RequireFactoryScope()
  list(@Req() req:ProductRequest,@Query('limit') limit?:string) {
    const c=this.context(req); return this.service.listProducts(c.userId,c.tenantId,c.factoryId,limit===undefined?50:Number(limit));
  }

  @Post()
  @UseGuards(PermissionGuard) @RequirePermission('products.master.write') @RequireFactoryScope()
  create(@Req() req:ProductRequest,@Body() dto:CreateProductDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.createProduct(c.userId,c.tenantId,c.factoryId,dto,key??null,c.requestId,c.traceId);
  }

  @Get('work-centres')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.read') @RequireFactoryScope()
  listWorkCentres(@Req() req:ProductRequest,@Query('limit') limit?:string) {
    const c=this.context(req); return this.service.listWorkCentres(c.userId,c.tenantId,c.factoryId,limit===undefined?50:Number(limit));
  }

  @Post('work-centres')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.write') @RequireFactoryScope()
  createWorkCentre(@Req() req:ProductRequest,@Body() dto:CreateWorkCentreDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.createWorkCentre(c.userId,c.tenantId,c.factoryId,dto,key??null,c.requestId,c.traceId);
  }

  @Get(':productId/versions')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.read') @RequireFactoryScope()
  listVersions(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string) {
    const c=this.context(req); return this.service.listVersions(c.userId,c.tenantId,c.factoryId,productId);
  }

  @Post(':productId/versions')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.write') @RequireFactoryScope()
  createVersion(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Body() dto:CreateProductVersionDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.createVersion(c.userId,c.tenantId,c.factoryId,productId,dto,key??null,c.requestId,c.traceId);
  }

  @Get(':productId/versions/:versionId')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.read') @RequireFactoryScope()
  detail(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string) {
    const c=this.context(req); return this.service.getVersionDetail(c.userId,c.tenantId,c.factoryId,productId,versionId);
  }

  @Put(':productId/versions/:versionId/bom')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.write') @RequireFactoryScope()
  replaceBom(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string,@Body() dto:ReplaceProductBomDto) {
    const c=this.context(req); return this.service.replaceBom(c.userId,c.tenantId,c.factoryId,productId,versionId,dto,c.requestId,c.traceId);
  }

  @Put(':productId/versions/:versionId/routing')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.write') @RequireFactoryScope()
  replaceRouting(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string,@Body() dto:ReplaceProductRoutingDto) {
    const c=this.context(req); return this.service.replaceRouting(c.userId,c.tenantId,c.factoryId,productId,versionId,dto,c.requestId,c.traceId);
  }

  @Post(':productId/versions/:versionId/bom-lines/:lineId/alternates')
  @UseGuards(PermissionGuard) @RequirePermission('products.master.write') @RequireFactoryScope()
  createAlternate(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string,@Param('lineId',new ParseUUIDPipe()) lineId:string,
    @Body() dto:CreateProductAlternateDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.createAlternate(c.userId,c.tenantId,c.factoryId,productId,versionId,lineId,dto,key??null,c.requestId,c.traceId);
  }

  @Post(':productId/versions/:versionId/alternates/:alternateId/approve')
  @UseGuards(PermissionGuard) @RequirePermission('products.alternate.approve') @RequireFactoryScope()
  approveAlternate(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string,@Param('alternateId',new ParseUUIDPipe()) alternateId:string,
    @Body() dto:ExpectedVersionDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.approveAlternate(c.userId,c.tenantId,c.factoryId,productId,versionId,alternateId,dto,key??null,c.requestId,c.traceId);
  }

  @Post(':productId/versions/:versionId/approve')
  @UseGuards(PermissionGuard) @RequirePermission('products.version.approve') @RequireFactoryScope()
  approveVersion(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string,@Body() dto:ExpectedVersionDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.approveVersion(c.userId,c.tenantId,c.factoryId,productId,versionId,dto,key??null,c.requestId,c.traceId);
  }

  @Post(':productId/versions/:versionId/retire')
  @UseGuards(PermissionGuard) @RequirePermission('products.version.approve') @RequireFactoryScope()
  retireVersion(@Req() req:ProductRequest,@Param('productId',new ParseUUIDPipe()) productId:string,
    @Param('versionId',new ParseUUIDPipe()) versionId:string,@Body() dto:ExpectedVersionDto,@Headers('idempotency-key') key?:string) {
    const c=this.context(req); return this.service.retireVersion(c.userId,c.tenantId,c.factoryId,productId,versionId,dto,key??null,c.requestId,c.traceId);
  }

  private context(req:ProductRequest):{userId:string;tenantId:string;factoryId:string;requestId:string;traceId:string} {
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId) throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
