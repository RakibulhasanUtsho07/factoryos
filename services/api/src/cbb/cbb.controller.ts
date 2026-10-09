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
    const {
      tenantId,
      factoryId,
    } =
      this.getAuthenticatedFactoryContext(
        request,
      );

    return this.cbbChangeService.listChangeProposals(
      tenantId,
      factoryId,
      {
        status:
          query.status,

        targetType:
          query.target_type,

        limit:
          query.limit,

        offset:
          query.offset,
      },
    );
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
