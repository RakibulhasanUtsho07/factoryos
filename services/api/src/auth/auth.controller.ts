import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { DevTokenDto } from './dto/dev-token.dto';

interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    tenantId: string;
    membershipId: string;
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('dev-token')
  async devToken(
    @Headers('x-dev-auth-secret') devAuthSecret: string | undefined,
    @Body() body: DevTokenDto,
  ) {
    return this.authService.issueDevToken(
      devAuthSecret,
      body.user_id,
      body.tenant_id,
    );
  }

  @Get('me')
  async me(@Req() request: AuthenticatedRequest) {
    return {
      authenticated: true,
      user: request.user ?? null,
    };
  }
}