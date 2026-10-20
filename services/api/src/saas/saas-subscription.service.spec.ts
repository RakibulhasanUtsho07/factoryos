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

  it('blocks premium AI execution when explicit subscription-required mode has no subscription', async () => {
    database.query.mockResolvedValueOnce({ rows: [{
      enforcement_mode: 'SUBSCRIPTION_REQUIRED',
      status: null,
      trial_ends_at: null,
      current_period_start: null,
      current_period_end: null,
    }] });
    await expect(service.assertAiCapabilityAvailable(tenantId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reports legacy compatibility as an explicit default before tenant migration', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });
    const result = await service.getEntitlementEnforcementMode(tenantId, actorUserId);
    expect(result).toMatchObject({
      tenantId,
      mode: 'LEGACY_COMPATIBLE',
      version: 0,
      source: 'IMPLICIT_LEGACY_DEFAULT',
      requiresSubscription: false,
    });
    expect(iam.authorize).toHaveBeenCalledWith(actorUserId, tenantId, 'saas.entitlement_modes.read');
  });

  it('allows an administrator to explicitly record the legacy mode without blocking the tenant', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenantId }] }) // tenant row lock
      .mockResolvedValueOnce({ rows: [] }) // idempotency replay
      .mockResolvedValueOnce({ rows: [] }) // no prior mode
      .mockResolvedValueOnce({ rows: [{
        id: 'mode-legacy-1', tenant_id: tenantId, version: '1',
        mode: 'LEGACY_COMPATIBLE', reason: 'Customer onboarding is not yet complete',
        effective_at: '2026-10-20T08:00:00.000Z',
        idempotency_key: 'record-legacy-mode',
        request_hash: 'a'.repeat(64), changed_by: actorUserId,
        created_at: '2026-10-20T08:00:00.000Z',
      }] });
    const result = await service.setEntitlementEnforcementMode(tenantId, actorUserId, {
      mode: 'LEGACY_COMPATIBLE',
      expected_version: 0,
      reason: 'Customer onboarding is not yet complete',
      idempotency_key: 'record-legacy-mode',
    } as never);
    expect(result).toMatchObject({
      tenantId,
      mode: 'LEGACY_COMPATIBLE',
      version: 1,
      source: 'EXPLICIT',
      requiresSubscription: false,
    });
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ENTITLEMENT_ENFORCEMENT_MODE_CHANGED',
      resourceId: 'mode-legacy-1',
    }));
  });

  it('requires an active subscription or unexpired trial before migrating a tenant to subscription-required mode', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenantId }] }) // tenant row lock
      .mockResolvedValueOnce({ rows: [] }) // idempotency replay
      .mockResolvedValueOnce({ rows: [] }) // no explicit mode yet
      .mockResolvedValueOnce({ rows: [] }); // no eligible subscription
    await expect(service.setEntitlementEnforcementMode(tenantId, actorUserId, {
      mode: 'SUBSCRIPTION_REQUIRED',
      expected_version: 0,
      reason: 'Migrate tenant after subscription onboarding',
      idempotency_key: 'require-subscription-no-plan',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records an immutable versioned mode migration after verifying subscription eligibility', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenantId }] }) // tenant row lock
      .mockResolvedValueOnce({ rows: [] }) // idempotency replay
      .mockResolvedValueOnce({ rows: [] }) // no prior mode
      .mockResolvedValueOnce({ rows: [{ id: subscriptionId }] }) // eligible active subscription
      .mockResolvedValueOnce({ rows: [{
        id: 'mode-row-1', tenant_id: tenantId, version: '1',
        mode: 'SUBSCRIPTION_REQUIRED', reason: 'Onboarding completed',
        effective_at: '2026-10-20T08:00:00.000Z',
        idempotency_key: 'require-subscription-ready',
        request_hash: 'a'.repeat(64), changed_by: actorUserId,
        created_at: '2026-10-20T08:00:00.000Z',
      }] });
    const result = await service.setEntitlementEnforcementMode(tenantId, actorUserId, {
      mode: 'SUBSCRIPTION_REQUIRED',
      expected_version: 0,
      reason: 'Onboarding completed',
      idempotency_key: 'require-subscription-ready',
    } as never);
    expect(result).toMatchObject({
      tenantId,
      mode: 'SUBSCRIPTION_REQUIRED',
      version: 1,
      source: 'EXPLICIT',
      requiresSubscription: true,
      replayed: false,
    });
    expect(clientQuery).toHaveBeenCalledTimes(5);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ENTITLEMENT_ENFORCEMENT_MODE_CHANGED',
      resourceId: 'mode-row-1',
    }));
  });

  it('refuses to downgrade a tenant after subscription enforcement is enabled', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: tenantId }] }) // tenant row lock
      .mockResolvedValueOnce({ rows: [] }) // idempotency replay
      .mockResolvedValueOnce({ rows: [{
        id: 'mode-row-1', tenant_id: tenantId, version: '1',
        mode: 'SUBSCRIPTION_REQUIRED', reason: 'Migrate',
        effective_at: '2026-10-20T08:00:00.000Z',
        idempotency_key: 'require-subscription-ready',
        request_hash: 'a'.repeat(64), changed_by: actorUserId,
        created_at: '2026-10-20T08:00:00.000Z',
      }] });
    await expect(service.setEntitlementEnforcementMode(tenantId, actorUserId, {
      mode: 'LEGACY_COMPATIBLE',
      expected_version: 1,
      reason: 'Undo migration',
      idempotency_key: 'undo-entitlement-migration',
    } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(audit.record).not.toHaveBeenCalled();
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
