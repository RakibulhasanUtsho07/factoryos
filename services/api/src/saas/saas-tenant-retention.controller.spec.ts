import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { SaasTenantRetentionController } from './saas-tenant-retention.controller';
import { SaasTenantRetentionService } from './saas-tenant-retention.service';

const tenant = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const actor = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

describe('SaasTenantRetentionController', () => {
  const service = {
    createPolicy: jest.fn<(...args: unknown[]) => unknown>(),
    listPolicies: jest.fn<(...args: unknown[]) => unknown>(),
    listPoliciesHistory: jest.fn<(...args: unknown[]) => unknown>(),
    createLegalHold: jest.fn<(...args: unknown[]) => unknown>(),
    listLegalHolds: jest.fn<(...args: unknown[]) => unknown>(),
    releaseLegalHold: jest.fn<(...args: unknown[]) => unknown>(),
    createErasureRequest: jest.fn<(...args: unknown[]) => unknown>(),
    listErasureRequests: jest.fn<(...args: unknown[]) => unknown>(),
    reviewErasureRequest: jest.fn<(...args: unknown[]) => unknown>(),
  };
  let controller: SaasTenantRetentionController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SaasTenantRetentionController(service as unknown as SaasTenantRetentionService);
  });

  it('rejects missing verified tenant or actor context before invoking the service', () => {
    expect(() => controller.listPolicies({} as never)).toThrow(UnauthorizedException);
    expect(service.listPolicies).not.toHaveBeenCalled();
  });

  it('uses verified request context rather than tenant or actor values supplied in the body', () => {
    const body = { tenant_id: 'spoofed', actor_user_id: 'spoofed' };
    service.createPolicy.mockReturnValue({ policy: 'created' });
    const response = controller.createPolicy({
      factoryos: { tenantId: tenant, userId: actor },
    } as never, body as never);
    expect(response).toEqual({ policy: 'created' });
    expect(service.createPolicy).toHaveBeenCalledWith(tenant, actor, body);
  });

  it('forwards reviewed legal-hold release through its permissioned service boundary', () => {
    const request = { factoryos: { tenantId: tenant, userId: actor } } as never;
    const body = { expected_version: 3, reason: 'Court release received' };
    service.releaseLegalHold.mockReturnValue({ status: 'RELEASED' });
    expect(controller.releaseLegalHold(request, '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7', body as never))
      .toEqual({ status: 'RELEASED' });
    expect(service.releaseLegalHold).toHaveBeenCalledWith(
      tenant, actor, '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7', body,
    );
  });

  it('forwards an erasure decision with an optimistic version for a distinct service-side review', () => {
    const request = { factoryos: { tenantId: tenant, userId: actor } } as never;
    const body = { decision: 'APPROVE', expected_version: 1, reason: 'Reviewed case' };
    service.reviewErasureRequest.mockReturnValue({ status: 'APPROVED' });
    expect(controller.reviewErasureRequest(request, 'a4f8f4b8-a72b-4d28-b2f2-9b35ac55c1f0', body as never))
      .toEqual({ status: 'APPROVED' });
    expect(service.reviewErasureRequest).toHaveBeenCalledWith(
      tenant, actor, 'a4f8f4b8-a72b-4d28-b2f2-9b35ac55c1f0', body,
    );
  });
});
