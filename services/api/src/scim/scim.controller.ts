import {
  Body,
  Controller,
  Header,
  Headers,
  Param,
  Patch,
} from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { SkipApiResponse } from '../common/decorators/skip-api-response.decorator';
import { ScimService } from './scim.service';

@Public()
@SkipApiResponse()
@Controller('scim/v2/Users')
export class ScimUsersController {
  constructor(private readonly scimService: ScimService) {}

  @Patch(':id')
  @Header('Content-Type', 'application/scim+json')
  async patchUser(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.scimService.deprovisionUser(authorization, id, body);
  }
}
