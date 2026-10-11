import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SaasSubscriptionService } from './saas-subscription.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actorUserId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const subscriptionId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

describe('SaasSubscriptionService', () => {
  const clientQuery = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
  const database = {
    query: jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
    transaction: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const iam = { authorize: jest.fn<(...args: unknown[]) => Promise<void>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  let service: SaasSubscriptionService;

  beforeEach(() => {
    jest.resetAllMocks();
    iam.authorize.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
    database.transaction.mockImplementation(async (...args: unknown[]) => {
      const callback = args[1] as (client: unknown) => Promise<unknown>;
      return callback({ query: clientQuery } as never);
    });
    service = new SaasSubscriptionService(database as never, iam as never, audit as never);
  });

  it('allows a tenant with no subscription record in documented legacy compatibility mode', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.assertAiCapabilityAvailable(tenantId)).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.query.mock.calls[0]?.[1]).toEqual([tenantId]);
  });

  it('fails closed for a suspended subscription at the runtime AI boundary', async () => {
    database.query.mockResolvedValueOnce({ rows: [{
      status: 'SUSPENDED',
      trial_ends_at: null,
      current_period_start: '2026-10-01T00:00:00.000Z',
      current_period_end: '2026-11-01T00:00:00.000Z',
    }] });
    await expect(service.assertAiCapabilityAvailable(tenantId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks a trial after the stored trial end even if the lifecycle worker has not marked it expired', async () => {
    database.query.mockResolvedValueOnce({ rows: [{
      status: 'TRIAL',
      trial_ends_at: '2020-01-01T00:00:00.000Z',
      current_period_start: null,
      current_period_end: null,
    }] });
    await expect(service.assertAiCapabilityAvailable(tenantId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks an active subscription outside the current billing window', async () => {
    database.query.mockResolvedValueOnce({ rows: [{
      status: 'ACTIVE',
      trial_ends_at: null,
      current_period_start: '2020-01-01T00:00:00.000Z',
      current_period_end: '2020-02-01T00:00:00.000Z',
    }] });
    await expect(service.assertAiCapabilityAvailable(tenantId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires a non-empty verified tenant and actor UUID before touching IAM or storage', async () => {
    await expect(service.listPlans('spoofed-tenant', actorUserId)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed plan tier ranks before opening a transaction', async () => {
    await expect(service.createPlan(tenantId, actorUserId, {
      plan_code: 'STARTER', display_name: 'Starter', tier_rank: 0, idempotency_key: 'plan-rank-invalid',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).toHaveBeenCalledWith(actorUserId, tenantId, 'saas.subscription_plans.write');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when IAM rejects the request to create a plan', async () => {
    iam.authorize.mockRejectedValueOnce(new ForbiddenException('permission denied'));
    await expect(service.createPlan(tenantId, actorUserId, {
      plan_code: 'STARTER', display_name: 'Starter', tier_rank: 1, idempotency_key: 'plan-write-denied',
    } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('requires complete billing-period bounds to activate a trial', async () => {
    await expect(service.transition(tenantId, actorUserId, subscriptionId, {
      action: 'ACTIVATE', expected_version: 1, idempotency_key: 'activate-without-period',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(iam.authorize).toHaveBeenCalledWith(actorUserId, tenantId, 'saas.subscriptions.write');
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('does not accept future-dated state transitions without a scheduler', async () => {
    await expect(service.transition(tenantId, actorUserId, subscriptionId, {
      action: 'SUSPEND', expected_version: 1,
      effective_at: '2999-01-01T00:00:00.000Z', idempotency_key: 'suspend-in-future',
    } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key that was committed for a different request', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [{
      id: 'event-1', tenant_id: tenantId, subscription_id: subscriptionId,
      subscription_version: '1', event_type: 'TRIAL_STARTED', from_status: null, to_status: 'TRIAL',
      prior_plan_code: null, prior_plan_version: null, plan_code: 'STARTER', plan_version: '1',
      effective_at: '2026-10-01T00:00:00.000Z', reason: null,
      idempotency_key: 'reused-key', request_hash: '0'.repeat(64),
      actor_user_id: actorUserId, created_at: '2026-10-01T00:00:00.000Z',
    }] });
    await expect(service.startTrial(tenantId, actorUserId, {
      plan_code: 'STARTER', trial_ends_at: '2999-01-01T00:00:00.000Z', idempotency_key: 'reused-key',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects stale optimistic versions before changing subscription state', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [{
      id: subscriptionId, tenant_id: tenantId, plan_code: 'STARTER', plan_version: 1,
      status: 'ACTIVE', version: '2', started_at: '2026-10-01T00:00:00.000Z',
      trial_ends_at: '2026-10-08T00:00:00.000Z', current_period_start: '2026-10-01T00:00:00.000Z',
      current_period_end: '2026-11-01T00:00:00.000Z', suspended_at: null, terminated_at: null,
      last_transition_at: '2026-10-01T00:00:00.000Z', created_by: actorUserId, updated_by: actorUserId,
      created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      tier_rank: 1, display_name: 'Starter', deployment_profile: 'SHARED_SAAS',
    }] });
    await expect(service.transition(tenantId, actorUserId, subscriptionId, {
      action: 'SUSPEND', expected_version: 1, idempotency_key: 'stale-version',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });

  it('refuses to activate a trial after its expiry boundary', async () => {
    clientQuery.mockResolvedValueOnce({ rows: [{ id: tenantId }] });
    clientQuery.mockResolvedValueOnce({ rows: [] });
    clientQuery.mockResolvedValueOnce({ rows: [{
      id: subscriptionId, tenant_id: tenantId, plan_code: 'STARTER', plan_version: 1,
      status: 'TRIAL', version: '1', started_at: '2026-10-01T00:00:00.000Z',
      trial_ends_at: '2026-10-02T00:00:00.000Z', current_period_start: null,
      current_period_end: null, suspended_at: null, terminated_at: null,
      last_transition_at: '2026-10-01T00:00:00.000Z', created_by: actorUserId, updated_by: actorUserId,
      created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      tier_rank: 1, display_name: 'Starter', deployment_profile: 'SHARED_SAAS',
    }] });
    await expect(service.transition(tenantId, actorUserId, subscriptionId, {
      action: 'ACTIVATE', expected_version: 1,
      period_start: '2026-10-11T00:00:00.000Z', period_end: '2026-11-11T00:00:00.000Z',
      idempotency_key: 'activate-expired-trial',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
  });
});
