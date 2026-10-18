import {
  Body,
  Controller,
  BadRequestException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import {
  CreateFinanceConnectorDto,
  FinanceMarginInputsQueryDto,
  FinanceWorkingCapitalQueryDto,
  FinanceFileImportDto,
  IngestFinanceFactsDto,
  ListFinanceConnectorsDto,
  ListFinanceFactsDto,
  ReviewFinanceReconciliationDto,
  TransitionFinanceConnectorDto,
} from './dto/finance.dto';
import { FinanceService } from './finance.service';

interface FinanceRequestContext {
  requestId: string | null;
  traceId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
type FinanceRequest = Request & { factoryos?: FinanceRequestContext };

function context(request: FinanceRequest) {
  const userId = request.factoryos?.userId ?? null;
  const tenantId = request.factoryos?.tenantId ?? null;
  const factoryId = request.factoryos?.factoryId ?? null;
  if (!userId || !tenantId || !factoryId) {
    throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
  }
  return {
    userId,
    tenantId,
    factoryId,
    eventContext: {
      requestId: request.factoryos?.requestId ?? null,
      traceId: request.factoryos?.traceId ?? null,
    },
  };
}

@Controller('finance/connectors')
export class FinanceConnectorsController {
  constructor(private readonly service: FinanceService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.connectors.write')
  @RequireFactoryScope()
  async create(
    @Req() request: FinanceRequest,
    @Body() body: CreateFinanceConnectorDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = context(request);
    return this.service.createConnector(
      ctx.userId,
      ctx.tenantId,
      ctx.factoryId,
      body,
      key ?? null,
      ctx.eventContext,
    );
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.connectors.read')
  @RequireFactoryScope()
  async list(@Req() request: FinanceRequest, @Query() query: ListFinanceConnectorsDto) {
    const ctx = context(request);
    return this.service.listConnectors(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Get(':connectorId')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.connectors.read')
  @RequireFactoryScope()
  async get(@Req() request: FinanceRequest, @Param('connectorId', new ParseUUIDPipe()) id: string) {
    const ctx = context(request);
    return this.service.getConnector(ctx.userId, ctx.tenantId, ctx.factoryId, id);
  }

  @Post(':connectorId/approve')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.connectors.approve')
  @RequireFactoryScope()
  async approve(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionFinanceConnectorDto,
  ) {
    const ctx = context(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, id, 'APPROVE', body, ctx.eventContext);
  }

  @Post(':connectorId/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.connectors.approve')
  @RequireFactoryScope()
  async reject(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionFinanceConnectorDto,
  ) {
    const ctx = context(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, id, 'REJECT', body, ctx.eventContext);
  }

  @Post(':connectorId/pause')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.connectors.write')
  @RequireFactoryScope()
  async pause(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionFinanceConnectorDto,
  ) {
    const ctx = context(request);
    return this.service.transitionConnector(ctx.userId, ctx.tenantId, ctx.factoryId, id, 'PAUSE', body, ctx.eventContext);
  }

  @Post(':connectorId/file-import/validate')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.ingest')
  @RequireFactoryScope()
  async validateFile(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Body() body: FinanceFileImportDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = context(request);
    return this.service.validateFactsFile(ctx.userId, ctx.tenantId, ctx.factoryId, id, body, key ?? null, ctx.eventContext);
  }

  @Get(':connectorId/file-import/reports')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.read')
  @RequireFactoryScope()
  async listFileValidationReports(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
  ) {
    const ctx = context(request);
    return this.service.listFileImportValidationReports(ctx.userId, ctx.tenantId, ctx.factoryId, id);
  }

  @Get(':connectorId/file-import/reports/:reportId')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.read')
  @RequireFactoryScope()
  async fileValidationReport(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ) {
    const ctx = context(request);
    return this.service.getFileImportValidationReport(ctx.userId, ctx.tenantId, ctx.factoryId, id, reportId);
  }

  @Get(':connectorId/file-imports/receipts')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.read')
  @RequireFactoryScope()
  async listFileImportReceipts(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
  ) {
    const ctx = context(request);
    return this.service.listFileImportReceipts(ctx.userId, ctx.tenantId, ctx.factoryId, id);
  }

  @Get(':connectorId/file-imports/:runId/receipt')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.read')
  @RequireFactoryScope()
  async fileImportReceipt(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ) {
    const ctx = context(request);
    return this.service.getFileImportReceipt(ctx.userId, ctx.tenantId, ctx.factoryId, id, runId);
  }

  @Post(':connectorId/file-import')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.ingest')
  @RequireFactoryScope()
  async importFile(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Body() body: FinanceFileImportDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = context(request);
    return this.service.importFactsFile(ctx.userId, ctx.tenantId, ctx.factoryId, id, body, key ?? null, ctx.eventContext);
  }

  @Post(':connectorId/facts')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.ingest')
  @RequireFactoryScope()
  async ingest(
    @Req() request: FinanceRequest,
    @Param('connectorId', new ParseUUIDPipe()) id: string,
    @Body() body: IngestFinanceFactsDto,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = context(request);
    return this.service.ingestFacts(ctx.userId, ctx.tenantId, ctx.factoryId, id, body, key ?? null, ctx.eventContext);
  }
}

@Controller('finance')
export class FinanceReportingController {
  constructor(private readonly service: FinanceService) {}

  @Get('facts')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.facts.read')
  @RequireFactoryScope()
  async facts(@Req() request: FinanceRequest, @Query() query: ListFinanceFactsDto) {
    const ctx = context(request);
    return this.service.listFacts(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Get('margin/inputs')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.margin.read')
  @RequireFactoryScope()
  async margin(@Req() request: FinanceRequest, @Query() query: FinanceMarginInputsQueryDto) {
    const ctx = context(request);
    return this.service.marginInputs(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Get('working-capital/inputs')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.working_capital.read')
  @RequireFactoryScope()
  async workingCapital(@Req() request: FinanceRequest, @Query() query: FinanceWorkingCapitalQueryDto) {
    const ctx = context(request);
    return this.service.workingCapitalInputs(ctx.userId, ctx.tenantId, ctx.factoryId, query);
  }

  @Get('reconciliations')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.reconciliation.read')
  @RequireFactoryScope()
  async reconciliations(
    @Req() request: FinanceRequest,
    @Query('status') status?: string,
  ) {
    const ctx = context(request);
    if (status && !['OPEN', 'RESOLVED', 'WAIVED'].includes(status)) {
      throw new BadRequestException('Unsupported finance reconciliation status filter');
    }
    return this.service.listReconciliations(
      ctx.userId,
      ctx.tenantId,
      ctx.factoryId,
      status as 'OPEN' | 'RESOLVED' | 'WAIVED' | undefined,
    );
  }

  @Post('reconciliations/:reconciliationId/review')
  @UseGuards(PermissionGuard)
  @RequirePermission('finance.reconciliation.review')
  @RequireFactoryScope()
  async review(
    @Req() request: FinanceRequest,
    @Param('reconciliationId', new ParseUUIDPipe()) id: string,
    @Body() body: ReviewFinanceReconciliationDto,
  ) {
    const ctx = context(request);
    return this.service.reviewReconciliation(ctx.userId, ctx.tenantId, ctx.factoryId, id, body, ctx.eventContext);
  }
}
