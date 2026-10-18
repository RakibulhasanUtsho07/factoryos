import {
  Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req,
  ForbiddenException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  ConvertQuotationDto, CreateExchangeRateDto, CreatePricingRuleDto, CreateQuotationDto,
  ListCommercialRulesDto, ListExchangeRatesDto, ListQuotationsDto, ReviseQuotationDto, TransitionQuotationDto,
} from './dto/quotation.dto';
import { CommercialService } from './commercial.service';

interface RequestContext {
  requestId: string | null; traceId: string | null; userId: string | null;
  tenantId: string | null; factoryId: string | null;
}
type CommercialRequest = Request & { factoryos?: RequestContext };

function context(request: CommercialRequest) {
  const userId = request.factoryos?.userId ?? null;
  const tenantId = request.factoryos?.tenantId ?? null;
  const factoryId = request.factoryos?.factoryId ?? null;
  if (!userId || !tenantId || !factoryId) {
    throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
  }
  return {
    userId, tenantId, factoryId,
    eventContext: {
      requestId: request.factoryos?.requestId ?? null,
      traceId: request.factoryos?.traceId ?? null,
    },
  };
}
function assertFactoryBody(bodyFactoryId: string, authenticatedFactoryId: string) {
  if (bodyFactoryId !== authenticatedFactoryId) {
    throw new ForbiddenException('Body factory_id must match the authenticated factory scope');
  }
}

@Controller('quotations')
export class QuotationsController {
  constructor(private readonly service: CommercialService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.write')
  @RequireFactoryScope()
  async create(
    @Req() req: CommercialRequest,
    @Body() body: CreateQuotationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const ctx = context(req);
    assertFactoryBody(body.factory_id, ctx.factoryId);
    return this.service.createQuotation(ctx.userId, ctx.tenantId, body, idempotencyKey ?? null, ctx.eventContext);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.read')
  @RequireFactoryScope()
  async list(@Req() req: CommercialRequest, @Query() query: ListQuotationsDto) {
    const ctx = context(req);
    return this.service.listQuotations(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Get(':quotationId')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.read')
  @RequireFactoryScope()
  async get(@Req() req: CommercialRequest, @Param('quotationId', new ParseUUIDPipe()) quoteId: string) {
    const ctx = context(req);
    return this.service.getQuotation(ctx.userId, ctx.tenantId, ctx.factoryId, quoteId);
  }

  @Get(':quotationId/revisions')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.read')
  @RequireFactoryScope()
  async revisions(@Req() req: CommercialRequest, @Param('quotationId', new ParseUUIDPipe()) quoteId: string) {
    const ctx = context(req);
    return this.service.listQuotationRevisions(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId);
  }

  @Patch(':quotationId/revise')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.write')
  @RequireFactoryScope()
  async revise(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: ReviseQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.reviseQuotation(ctx.userId, ctx.tenantId, ctx.factoryId, quoteId, body, ctx.eventContext);
  }

  @Post(':quotationId/submit')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.write')
  @RequireFactoryScope()
  async submit(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: TransitionQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.transitionQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,'SUBMIT',
      body.expected_version,body.reason,ctx.eventContext);
  }

  @Post(':quotationId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.approve')
  @RequireFactoryScope()
  async approve(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: TransitionQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.transitionQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,'APPROVE',
      body.expected_version,body.reason,ctx.eventContext);
  }

  @Post(':quotationId/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.approve')
  @RequireFactoryScope()
  async reject(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: TransitionQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.transitionQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,'REJECT',
      body.expected_version,body.reason,ctx.eventContext);
  }

  @Post(':quotationId/send')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.send')
  @RequireFactoryScope()
  async send(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: TransitionQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.transitionQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,'SEND',
      body.expected_version,body.reason,ctx.eventContext);
  }

  @Post(':quotationId/accept')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.accept')
  @RequireFactoryScope()
  async accept(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: TransitionQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.transitionQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,'ACCEPT',
      body.expected_version,body.reason,ctx.eventContext);
  }

  @Post(':quotationId/cancel')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.write')
  @RequireFactoryScope()
  async cancel(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: TransitionQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.transitionQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,'CANCEL',
      body.expected_version,body.reason,ctx.eventContext);
  }

  @Post(':quotationId/convert')
  @UseGuards(PermissionGuard)
  @RequirePermission('quotations.convert')
  @RequireFactoryScope()
  async convert(
    @Req() req: CommercialRequest,
    @Param('quotationId', new ParseUUIDPipe()) quoteId: string,
    @Body() body: ConvertQuotationDto,
  ) {
    const ctx = context(req);
    return this.service.convertAcceptedQuotation(ctx.userId,ctx.tenantId,ctx.factoryId,quoteId,
      body.order_number,body.expected_version,body.reason,ctx.eventContext);
  }
}

@Controller('quotation-rules')
export class CommercialRulesController {
  constructor(private readonly service: CommercialService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('quotation_rules.write')
  @RequireFactoryScope()
  async create(@Req() req: CommercialRequest, @Body() body: CreatePricingRuleDto) {
    const ctx = context(req);
    assertFactoryBody(body.factory_id,ctx.factoryId);
    return this.service.createPricingRule(ctx.userId,ctx.tenantId,body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('quotation_rules.read')
  @RequireFactoryScope()
  async list(@Req() req: CommercialRequest, @Query() query: ListCommercialRulesDto) {
    const ctx = context(req);
    return this.service.listPricingRules(ctx.userId,ctx.tenantId,ctx.factoryId,query);
  }
}

@Controller('exchange-rates')
export class CommercialExchangeRatesController {
  constructor(private readonly service: CommercialService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('exchange_rates.write')
  @RequireFactoryScope()
  async create(@Req() req: CommercialRequest, @Body() body: CreateExchangeRateDto) {
    const ctx = context(req);
    assertFactoryBody(body.factory_id,ctx.factoryId);
    return this.service.createExchangeRate(ctx.userId,ctx.tenantId,body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('exchange_rates.read')
  @RequireFactoryScope()
  async list(@Req() req: CommercialRequest, @Query() query: ListExchangeRatesDto) {
    const ctx = context(req);
    return this.service.listExchangeRates(ctx.userId,ctx.tenantId,ctx.factoryId,query);
  }
}
