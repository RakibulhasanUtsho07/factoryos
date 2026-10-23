import { jest } from '@jest/globals';
import { DatabaseService } from '../database/database.service';
import { NotificationInboxService } from './notification-inbox.service';
import type { OutboxEvent } from '../outbox/outbox-event.contract';

const USER='921382b8-e83f-43ab-a576-e3db6a06b70c';
const TENANT='faaab63d-c447-46ce-950d-deebdd7f5f30';
const FACTORY='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const EVENT='70e1db4f-dc2e-4cab-a3ec-13cc4c744d27';
const ALERT='7ae1db4f-dc2e-4cab-a3ec-13cc4c744d28';
const POLICY='7ae1db4f-dc2e-4cab-a3ec-13cc4c744d29';
const context={userId:USER,tenantId:TENANT,factoryId:FACTORY,requestId:null,traceId:null};

describe('NotificationInboxService outbox integration',()=>{
  let service:NotificationInboxService;
  const dbClient={query:jest.fn()};
  const database={transaction:jest.fn(),query:jest.fn()};

  beforeEach(()=>{
    jest.clearAllMocks();
    database.transaction.mockImplementation((async (callback:(client:typeof dbClient)=>Promise<unknown>)=>callback(dbClient)) as never);
    service=new NotificationInboxService(database as unknown as DatabaseService);
  });

  it('queues source-linked utility threshold notifications idempotently',async()=>{
    dbClient.query.mockResolvedValueOnce({rows:[{user_id:USER}]} as never)
      .mockResolvedValueOnce({rowCount:1} as never);
    const event:OutboxEvent={
      id:EVENT,tenantId:TENANT,factoryId:FACTORY,aggregateType:'UTILITY_THRESHOLD_ALERT',aggregateId:ALERT,
      eventType:'UTILITIES.THRESHOLD_ALERT_RAISED',eventVersion:1,correlationId:EVENT,
      payload:{alert_id:ALERT,policy_id:POLICY,metric:'CONSUMPTION',observed_value:20,threshold:10,unit_code:'kWh',severity:'HIGH'},
    };
    const result=await service.enqueueUtilityThreshold(event);
    expect(result).toEqual({recipients:1,created:1,replayed:false});
    expect(dbClient.query).toHaveBeenCalledTimes(2);
    expect(String(dbClient.query.mock.calls[1][0])).toContain('ON CONFLICT(tenant_id,factory_id,recipient_user_id,source_event_id) DO NOTHING');
    expect(dbClient.query.mock.calls[1][1]).toContain(EVENT);
  });

  it('does not create duplicate inbox rows when the same outbox event is replayed',async()=>{
    dbClient.query.mockResolvedValueOnce({rows:[{user_id:USER}]} as never)
      .mockResolvedValueOnce({rowCount:0} as never);
    const event:OutboxEvent={
      id:EVENT,tenantId:TENANT,factoryId:FACTORY,aggregateType:'UTILITY_THRESHOLD_ALERT',aggregateId:ALERT,
      eventType:'UTILITIES.THRESHOLD_ALERT_RAISED',eventVersion:1,
      payload:{alert_id:ALERT,policy_id:POLICY,metric:'COST',observed_value:200,threshold:100,unit_code:'BDT',severity:'CRITICAL'},
    };
    await expect(service.enqueueUtilityThreshold(event)).resolves.toEqual({recipients:1,created:0,replayed:true});
  });

  it('resolves EHS lifecycle events to active accountable owners and managers',async()=>{
    dbClient.query.mockResolvedValueOnce({rows:[{user_id:USER}]} as never)
      .mockResolvedValueOnce({rowCount:1} as never);
    const event:OutboxEvent={
      id:EVENT,tenantId:TENANT,factoryId:FACTORY,aggregateType:'EHS_EMERGENCY_DRILL',aggregateId:ALERT,
      eventType:'EHS.LIFECYCLE_CHANGED',eventVersion:1,
      payload:{entity_type:'EMERGENCY_DRILL',entity_id:ALERT,action:'COMPLETED',version:3,payload:{status:'COMPLETED'}},
    };
    await expect(service.enqueueEhsLifecycle(event)).resolves.toEqual({recipients:1,created:1,replayed:false});
    expect(String(dbClient.query.mock.calls[0][0])).toContain('owner_user_id');
    expect(String(dbClient.query.mock.calls[0][0])).toContain('r.code IN (\'ORG_ADMIN\',\'FACTORY_MANAGER\',\'EHS_MANAGER\')');
  });

  it('fails closed on tenantless or factory-less operational events',async()=>{
    const event:OutboxEvent={
      id:EVENT,tenantId:TENANT,factoryId:null,aggregateType:'EHS_EMERGENCY_DRILL',aggregateId:ALERT,
      eventType:'EHS.LIFECYCLE_CHANGED',eventVersion:1,payload:{entity_type:'EMERGENCY_DRILL',entity_id:ALERT,action:'CREATED',version:1},
    };
    await expect(service.enqueueEhsLifecycle(event)).rejects.toThrow('valid tenant, factory and source event identifiers');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('scopes inbox reads to the authenticated recipient and validates page size',async()=>{
    database.query.mockResolvedValueOnce({rows:[]} as never);
    await expect(service.listInbox(context,50,'UNREAD')).resolves.toEqual({items:[]});
    expect(database.query.mock.calls[0][1]).toEqual([TENANT,FACTORY,USER,'UNREAD',50]);
    await expect(service.listInbox(context,201)).rejects.toThrow('limit must be between 1 and 200');
  });
});
