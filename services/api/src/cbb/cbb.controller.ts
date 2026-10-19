import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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

import {
  CreateBusinessChangeDto,
} from './dto/create-business-change.dto';

import {
  CreateBusinessFeedbackDto,
} from './dto/create-business-feedback.dto';

import {
  DecideBusinessChangeDto,
} from './dto/decide-business-change.dto';

import {
  ListBusinessChangesDto,
} from './dto/list-business-changes.dto';
import { CbbChangeService } from './cbb.change.service';
import { CbbEvidenceService } from './cbb.evidence.service';
import { CbbGovernanceService } from './cbb.governance.service';
import {
  CreateCbbImpactLinkDto,
  CreateCbbTerminologyAliasDto,
  DecideCbbStalenessDto,
  DecideCbbTerminologyAliasDto,
  GrantCbbAccessDto,
  ImpactTraceQueryDto,
  ResolveCbbTerminologyQueryDto,
  RollbackCbbVersionDto,
  ScanCbbStalenessDto,
} from './dto/cbb-governance.dto';
import {
  CreateCbbEvidenceDto,
  LinkCbbEvidenceDto,
  ListCbbEvidenceQueryDto,
  ListCbbConflictsQueryDto,
  DecideCbbConflictDto,
} from './dto/cbb-evidence.dto';

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

    private readonly cbbChangeService:
      CbbChangeService,

    private readonly cbbEvidenceService:
      CbbEvidenceService,

    private readonly cbbGovernanceService:
      CbbGovernanceService,
  ) {}

  // ============================================================
  // BUSINESS MODEL READS
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
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    if (!(await this.cbbGovernanceService.canReadActiveBlueprint(tenantId, factoryId, userId))) {
      return null;
    }
    return this.cbbService.getBusinessModel(tenantId, factoryId);
  }

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
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    const map = await this.cbbService.getBusinessMap(tenantId, factoryId);
    return this.cbbGovernanceService.filterBusinessMap(tenantId, factoryId, userId, map);
  }

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
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    const result = await this.cbbService.listProcesses(tenantId, factoryId);
    return this.cbbGovernanceService.filterProcessResult(tenantId, factoryId, userId, result);
  }

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
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    const result = await this.cbbService.getProcess(tenantId, factoryId, processId);
    return this.cbbGovernanceService.filterProcessResult(tenantId, factoryId, userId, result);
  }

  // ============================================================
  // CHANGE PROPOSALS
  // ============================================================

  @Post('changes')
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.review',
  )
  @RequireFactoryScope()
  async createChange(
    @Req()
    request: FactoryOsRequest,

    @Body()
    body: CreateBusinessChangeDto,
  ) {
    const {
      userId,
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );
    await this.cbbGovernanceService.assertTargetWriteAccess(
      { tenantId, factoryId, userId },
      body.target_type,
      body.target_id ?? null,
    );

    return this.cbbChangeService.createChangeProposal(
      tenantId,
      factoryId,
      userId,
      {
        targetType:
          body.target_type,

        targetId:
          body.target_id ??
          null,

        proposalType:
          body.proposal_type,

        proposedState:
          body.proposed_state ??
          null,

        proposedPayload:
          body.proposed_payload ??
          {},

        reason:
          body.reason ??
          null,
      },
    );
  }

  @Get('changes')
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.review',
  )
  @RequireFactoryScope()
  async listChanges(
    @Req()
    request: FactoryOsRequest,

    @Query()
    query: ListBusinessChangesDto,
  ) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    const result = await this.cbbChangeService.listChangeProposals(
      tenantId,
      factoryId,
      {
        status: query.status,
        targetType: query.target_type,
        limit: query.limit,
        offset: query.offset,
      },
    );
    return this.cbbGovernanceService.filterChangeProposalResult(tenantId, factoryId, userId, result);
  }

  @Post(
    'changes/:id/approve',
  )
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.review',
  )
  @RequireFactoryScope()
  async approveChange(
    @Req()
    request: FactoryOsRequest,

    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    proposalId: string,

    @Body()
    body: DecideBusinessChangeDto,
  ) {
    const {
      userId,
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );
    await this.cbbGovernanceService.assertProposalWriteAccess({ tenantId, factoryId, userId }, proposalId);

    return this.cbbChangeService.approveChangeProposal(
      tenantId,
      factoryId,
      userId,
      proposalId,
      body?.reason ??
        null,
    );
  }

  @Post(
    'changes/:id/reject',
  )
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.review',
  )
  @RequireFactoryScope()
  async rejectChange(
    @Req()
    request: FactoryOsRequest,

    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    proposalId: string,

    @Body()
    body: DecideBusinessChangeDto,
  ) {
    const {
      userId,
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );
    await this.cbbGovernanceService.assertProposalWriteAccess({ tenantId, factoryId, userId }, proposalId);

    return this.cbbChangeService.rejectChangeProposal(
      tenantId,
      factoryId,
      userId,
      proposalId,
      body?.reason ??
        null,
    );
  }


  // ============================================================
  // SOURCE EVIDENCE, VERSION HISTORY AND CONFLICT REVIEW
  // ============================================================

  @Get('versions')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listVersions(@Req() request: FactoryOsRequest) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    if (!(await this.cbbGovernanceService.canReadActiveBlueprint(tenantId, factoryId, userId))) return [];
    return this.cbbEvidenceService.listBlueprintVersions(tenantId, factoryId);
  }

  @Get('versions/:versionId/map')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async getVersionMap(
    @Req() request: FactoryOsRequest,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
  ) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    const map = await this.cbbService.getBusinessMap(tenantId, factoryId, versionId);
    return this.cbbGovernanceService.filterBusinessMap(tenantId, factoryId, userId, map);
  }

  @Post('evidence')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async createEvidence(@Req() request: FactoryOsRequest, @Body() body: CreateCbbEvidenceDto) {
    const context = this.getAuthenticatedFactoryContext(request);
    return this.cbbEvidenceService.createEvidence(context, body);
  }

  @Get('evidence')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listEvidence(@Req() request: FactoryOsRequest, @Query() query: ListCbbEvidenceQueryDto) {
    const { tenantId, factoryId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbEvidenceService.listEvidence(tenantId, factoryId, {
      sourceType: query.source_type,
      state: query.state,
      sourceKey: query.source_key,
      targetType: query.target_type,
      targetId: query.target_id,
      limit: query.limit,
      offset: query.offset,
      visibility: 'INTERNAL',
    });
  }

  @Get('evidence/restricted')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async listRestrictedEvidence(@Req() request: FactoryOsRequest, @Query() query: ListCbbEvidenceQueryDto) {
    const { tenantId, factoryId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbEvidenceService.listEvidence(tenantId, factoryId, {
      sourceType: query.source_type,
      state: query.state,
      sourceKey: query.source_key,
      targetType: query.target_type,
      targetId: query.target_id,
      limit: query.limit,
      offset: query.offset,
      visibility: 'RESTRICTED',
    });
  }

  @Get('evidence/:evidenceId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async getEvidenceHistory(
    @Req() request: FactoryOsRequest,
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
  ) {
    const { tenantId, factoryId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbEvidenceService.getEvidenceHistory(tenantId, factoryId, evidenceId, 'INTERNAL');
  }

  @Get('evidence/restricted/:evidenceId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async getRestrictedEvidenceHistory(
    @Req() request: FactoryOsRequest,
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
  ) {
    const { tenantId, factoryId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbEvidenceService.getEvidenceHistory(tenantId, factoryId, evidenceId, 'RESTRICTED');
  }

  @Post('evidence/:evidenceId/links')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async linkEvidence(
    @Req() request: FactoryOsRequest,
    @Param('evidenceId', new ParseUUIDPipe()) evidenceId: string,
    @Body() body: LinkCbbEvidenceDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    await this.cbbGovernanceService.assertTargetWriteAccess(context, body.target_type, body.target_id);
    return this.cbbEvidenceService.createEvidenceLink(context, evidenceId, body);
  }

  @Get('conflicts')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listConflicts(@Req() request: FactoryOsRequest, @Query() query: ListCbbConflictsQueryDto) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    const result = await this.cbbEvidenceService.listConflicts(tenantId, factoryId, {
      status: query.status,
      subjectType: query.subject_type,
      limit: query.limit,
      offset: query.offset,
    });
    return this.cbbGovernanceService.filterConflictResult(tenantId, factoryId, userId, result);
  }

  @Get('conflicts/:conflictId/history')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async getConflictHistory(
    @Req() request: FactoryOsRequest,
    @Param('conflictId', new ParseUUIDPipe()) conflictId: string,
  ) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    await this.cbbGovernanceService.assertConflictReadAccess(tenantId, factoryId, userId, conflictId);
    return this.cbbEvidenceService.getConflictHistory(tenantId, factoryId, conflictId);
  }

  @Post('conflicts/:conflictId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async decideConflict(
    @Req() request: FactoryOsRequest,
    @Param('conflictId', new ParseUUIDPipe()) conflictId: string,
    @Body() body: DecideCbbConflictDto,
  ) {
    const context = this.getAuthenticatedFactoryContext(request);
    await this.cbbGovernanceService.assertConflictWriteAccess(context, conflictId);
    return this.cbbEvidenceService.decideConflict(context, conflictId, body);
  }

  // ============================================================
  // CBB ACCESS, STALENESS, TERMINOLOGY, IMPACT AND ROLLBACK
  // ============================================================

  @Get('access')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listCbbAccess(@Req() request: FactoryOsRequest) {
    const { tenantId, factoryId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbGovernanceService.listAccess(tenantId, factoryId);
  }

  @Post('access')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async grantCbbAccess(@Req() request: FactoryOsRequest, @Body() body: GrantCbbAccessDto) {
    return this.cbbGovernanceService.grantAccess(this.getAuthenticatedFactoryContext(request), body);
  }

  @Delete('access/:aclId')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async revokeCbbAccess(
    @Req() request: FactoryOsRequest,
    @Param('aclId', new ParseUUIDPipe()) aclId: string,
  ) {
    return this.cbbGovernanceService.revokeAccess(this.getAuthenticatedFactoryContext(request), aclId);
  }

  @Get('staleness')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listCbbStaleness(@Req() request: FactoryOsRequest) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbGovernanceService.listStaleness(tenantId, factoryId, userId);
  }

  @Post('staleness/scan')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async scanCbbStaleness(@Req() request: FactoryOsRequest, @Body() body: ScanCbbStalenessDto) {
    return this.cbbGovernanceService.scanStaleness(this.getAuthenticatedFactoryContext(request), body.threshold_days);
  }

  @Post('staleness/:reviewId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async decideCbbStaleness(
    @Req() request: FactoryOsRequest,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @Body() body: DecideCbbStalenessDto,
  ) {
    return this.cbbGovernanceService.decideStaleness(this.getAuthenticatedFactoryContext(request), reviewId, body);
  }

  @Get('terminology')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listCbbTerminology(@Req() request: FactoryOsRequest, @Query('search') search?: string) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbGovernanceService.listTerminology(tenantId, factoryId, userId, search);
  }

  @Get('terminology/resolve')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async resolveCbbTerminology(@Req() request: FactoryOsRequest, @Query() query: ResolveCbbTerminologyQueryDto) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbGovernanceService.resolveTerminology(
      tenantId, factoryId, userId, query.term, query.source_system, query.language_code,
    );
  }

  @Post('terminology/aliases')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async createCbbTerminologyAlias(@Req() request: FactoryOsRequest, @Body() body: CreateCbbTerminologyAliasDto) {
    return this.cbbGovernanceService.createTerminologyAlias(this.getAuthenticatedFactoryContext(request), body);
  }

  @Post('terminology/aliases/:aliasId/decision')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async decideCbbTerminologyAlias(
    @Req() request: FactoryOsRequest,
    @Param('aliasId', new ParseUUIDPipe()) aliasId: string,
    @Body() body: DecideCbbTerminologyAliasDto,
  ) {
    return this.cbbGovernanceService.decideTerminologyAlias(this.getAuthenticatedFactoryContext(request), aliasId, body);
  }

  @Post('impact-links')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async createCbbImpactLink(@Req() request: FactoryOsRequest, @Body() body: CreateCbbImpactLinkDto) {
    return this.cbbGovernanceService.addImpactLink(this.getAuthenticatedFactoryContext(request), body);
  }

  @Get('impact/:targetType/:targetId')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async getCbbImpactTrace(
    @Req() request: FactoryOsRequest,
    @Param('targetType') targetType: string,
    @Param('targetId', new ParseUUIDPipe()) targetId: string,
    @Query() query: ImpactTraceQueryDto,
  ) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbGovernanceService.getImpactTrace(
      tenantId, factoryId, userId, targetType as 'BLUEPRINT' | 'ENTITY' | 'RELATION' | 'PROCESS' | 'PROCESS_STEP' | 'RULE' | 'TERM' | 'EXCEPTION',
      targetId, query.depth ?? 3,
    );
  }

  @Post('versions/rollback')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.review')
  @RequireFactoryScope()
  async rollbackCbbVersion(@Req() request: FactoryOsRequest, @Body() body: RollbackCbbVersionDto) {
    return this.cbbGovernanceService.rollbackToVersion(this.getAuthenticatedFactoryContext(request), body);
  }

  @Get('rollback-history')
  @UseGuards(PermissionGuard)
  @RequirePermission('ai.business.read')
  @RequireFactoryScope()
  async listCbbRollbackHistory(@Req() request: FactoryOsRequest) {
    const { tenantId, factoryId, userId } = this.getAuthenticatedFactoryContext(request);
    return this.cbbGovernanceService.listRollbackEvents(tenantId, factoryId, userId);
  }

  // ============================================================
  // FEEDBACK
  // ============================================================

  @Post('feedback')
  @UseGuards(
    PermissionGuard,
  )
  @RequirePermission(
    'ai.business.feedback',
  )
  @RequireFactoryScope()
  async createFeedback(
    @Req()
    request: FactoryOsRequest,

    @Body()
    body: CreateBusinessFeedbackDto,
  ) {
    const {
      userId,
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.cbbChangeService.createFeedback(
      tenantId,
      factoryId,
      userId,
      {
        subjectType:
          body.subject_type,

        subjectId:
          body.subject_id,

        feedbackType:
          body.feedback_type,

        payload:
          body.payload_json ??
          {},
      },
    );
  }

  // ============================================================
  // VERIFIED FACTORY CONTEXT
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
