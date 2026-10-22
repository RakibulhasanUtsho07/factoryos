import { Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, UnauthorizedException, Body, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../iam/guards/permission.guard';
import { RequireFactoryScope } from '../iam/require-factory-scope.decorator';
import { RequirePermission } from '../iam/require-permission.decorator';
import { AcknowledgeOperationalNotificationDto } from './notifications.dto';
import { NotificationInboxService } from './notification-inbox.service';
import type { NotificationContext } from './notification-inbox.service';

interface NotificationRequestContext {
  requestId?:string|null;traceId?:string|null;userId:string|null;tenantId:string|null;factoryId:string|null;
}
type NotificationRequest=Request&{factoryos?:NotificationRequestContext};

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service:NotificationInboxService){}

  @Get('inbox')
  @UseGuards(PermissionGuard)
  @RequirePermission('notifications.inbox.read')
  @RequireFactoryScope()
  listInbox(@Req() req:NotificationRequest,@Query('limit') limit?:string,@Query('status') status?:string){
    return this.service.listInbox(this.context(req),limit===undefined?undefined:Number(limit),status);
  }

  @Post(':notificationId/acknowledge')
  @UseGuards(PermissionGuard)
  @RequirePermission('notifications.inbox.manage')
  @RequireFactoryScope()
  acknowledge(@Req() req:NotificationRequest,@Param('notificationId',new ParseUUIDPipe()) id:string,@Body() dto:AcknowledgeOperationalNotificationDto){
    return this.service.acknowledge(this.context(req),id,dto);
  }

  private context(req:NotificationRequest):NotificationContext{
    const c=req.factoryos;
    if(!c?.userId||!c.tenantId||!c.factoryId)throw new UnauthorizedException('Authenticated user, tenant and factory context are required');
    return {userId:c.userId,tenantId:c.tenantId,factoryId:c.factoryId,requestId:c.requestId,traceId:c.traceId};
  }
}
