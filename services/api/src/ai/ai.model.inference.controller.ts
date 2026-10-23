import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { CreateAiModelInferenceDto } from './dto/create-ai-model-inference.dto';
import { AiOpenAiCompatibleProviderService } from './ai.openai-compatible.provider.service';

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

@Controller('v2/ai/inference')
@UseGuards(PermissionGuard)
@RequireFactoryScope()
export class AiModelInferenceController {
  constructor(
    private readonly modelProvider: AiOpenAiCompatibleProviderService,
  ) {}

  @Post('chat-completions')
  @RequirePermission('ai.decisions.write')
  async chatCompletions(
    @Req() request: FactoryOsRequest,
    @Body() body: CreateAiModelInferenceDto,
  ) {
    const context = request.factoryos;
    if (
      !context?.tenantId ||
      !context.factoryId ||
      !context.userId ||
      !context.requestId
    ) {
      throw new UnauthorizedException(
        'Authenticated tenant/factory/user/request context is required',
      );
    }

    return this.modelProvider.chatCompletion({
      tenantId: context.tenantId,
      factoryId: context.factoryId,
      actorUserId: context.userId,
      requestRef: context.requestId,
      prompt: body.prompt,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    });
  }
}
