import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { IamService } from './iam.service';

@Controller('iam')
export class IamController {
  constructor(
    private readonly iamService: IamService,
  ) {}

  @Get('access')
  async getAccess(
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Req() request: Request,
  ) {
    if (!userId || !tenantId) {
      throw new BadRequestException(
        'x-user-id and x-tenant-id headers are required',
      );
    }

    const access =
      await this.iamService.resolveAccess(
        userId,
        tenantId,
      );

    if (request.factoryos) {
      request.factoryos.userId = access.user.id;
      request.factoryos.tenantId = access.tenant.id;
    }

    return access;
  }
}