import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { PermissionGuard } from '../../iam/guards/permission.guard';
import { RequireFactoryScope } from '../../iam/require-factory-scope.decorator';
import { RequirePermission } from '../../iam/require-permission.decorator';
import { AiArtifactProvenanceService } from './ai.artifact.provenance.service';
import {
  ArtifactReasonDto,
  CreateAiArtifactSourceDto,
  RegisterAiArtifactDto,
} from './dto/ai-artifact-provenance.dto';

interface FactoryOsRequestContext {
  requestId: string;
  traceId: string;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}

type FactoryOsRequest = Request & {
  factoryos?: FactoryOsRequestContext;
};

@Controller('v2/ai/artifacts')
@UseGuards(PermissionGuard)
@RequireFactoryScope()
export class AiArtifactProvenanceController {
  constructor(
    private readonly provenanceService: AiArtifactProvenanceService,
  ) {}

  @Post('sources')
  @RequirePermission('ai.agents.publish')
  async createSource(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiArtifactSourceDto,
  ) {
    const context = this.getContext(request);
    return this.provenanceService.createTrustedSource(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.requestId,
      {
        sourceKey: body.source_key,
        label: body.label,
        publicKeyPem: body.public_key_pem,
        validUntil: body.valid_until,
      },
    );
  }

  @Post('sources/:sourceId/approve')
  @RequirePermission('ai.agents.publish')
  async approveSource(
    @Req() request: FactoryOsRequest,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() body: ArtifactReasonDto,
  ) {
    const context = this.getContext(request);
    return this.provenanceService.approveTrustedSource(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.requestId,
      sourceId,
      body.reason,
    );
  }

  @Post('sources/:sourceId/revoke')
  @RequirePermission('ai.agents.publish')
  async revokeSource(
    @Req() request: FactoryOsRequest,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() body: ArtifactReasonDto,
  ) {
    const context = this.getContext(request);
    return this.provenanceService.revokeTrustedSource(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.requestId,
      sourceId,
      body.reason,
    );
  }

  @Post()
  @RequirePermission('ai.agents.publish')
  async registerArtifact(
    @Req() request: FactoryOsRequest,
    @Body() body: RegisterAiArtifactDto,
  ) {
    const context = this.getContext(request);
    return this.provenanceService.registerArtifact(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.requestId,
      {
        artifactType: body.artifact_type,
        artifactKey: body.artifact_key,
        version: body.version,
        sha256: body.sha256,
        sourceId: body.source_id,
        expiresAt: body.expires_at,
        signatureBase64: body.signature_base64,
      },
    );
  }

  @Post(':artifactId/revoke')
  @RequirePermission('ai.agents.publish')
  async revokeArtifact(
    @Req() request: FactoryOsRequest,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Body() body: ArtifactReasonDto,
  ) {
    const context = this.getContext(request);
    return this.provenanceService.revokeArtifact(
      context.tenantId,
      context.factoryId,
      context.userId,
      context.requestId,
      artifactId,
      body.reason,
    );
  }

  private getContext(request: FactoryOsRequest) {
    const context = request.factoryos;
    if (
      !context?.tenantId ||
      !context.factoryId ||
      !context.userId ||
      !context.requestId
    ) {
      throw new UnauthorizedException('Authenticated tenant/factory/user context is required');
    }
    return {
      tenantId: context.tenantId,
      factoryId: context.factoryId,
      userId: context.userId,
      requestId: context.requestId,
    };
  }
}
