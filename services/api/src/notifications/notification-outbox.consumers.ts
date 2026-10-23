import { Injectable } from '@nestjs/common';
import type { OutboxEvent } from '../outbox/outbox-event.contract';
import type { OutboxConsumer } from '../outbox/outbox.consumer';
import { NotificationInboxService } from './notification-inbox.service';

@Injectable()
export class UtilityThresholdNotificationConsumer implements OutboxConsumer {
  readonly consumerName='utility-threshold-notification-inbox-v1';
  readonly eventType='UTILITIES.THRESHOLD_ALERT_RAISED';
  constructor(private readonly inbox:NotificationInboxService){}
  consume(event:OutboxEvent){return this.inbox.enqueueUtilityThreshold(event);}
}

@Injectable()
export class EhsLifecycleNotificationConsumer implements OutboxConsumer {
  readonly consumerName='ehs-lifecycle-notification-inbox-v1';
  readonly eventType='EHS.LIFECYCLE_CHANGED';
  constructor(private readonly inbox:NotificationInboxService){}
  consume(event:OutboxEvent){return this.inbox.enqueueEhsLifecycle(event);}
}
