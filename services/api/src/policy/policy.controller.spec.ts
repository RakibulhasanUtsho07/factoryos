import { jest } from '@jest/globals';

import { UnauthorizedException } from '@nestjs/common';

import { PolicyController } from './policy.controller';

describe('PolicyController', () => {
  const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
  const policyId = '1f3f8d8b-df0d-4d96-9b8f-3d6572dc9001';
  const riskClassId = '2f3f8d8b-df0d-4d96-9b8f-3d6572dc9002';
  const approvalId = '3f3f8d8b-df0d-4d96-9b8f-3d6572dc9003';

  const request = {
    factoryos: {
      requestId: 'request-001',
      traceId: 'trace-001',
      requestedUserId: 'attacker-user-id',
      requestedTenantId: 'attacker-tenant-id',
      requestedFactoryId: null,
      userId,
      tenantId,
      factoryId: null,
    },
  } as never;

  const policyService = {
    listRiskClasses: jest.fn(),
    getRiskClass: jest.fn(),
    createRiskClass: jest.fn(),
    listPolicies: jest.fn(),
    getPolicy: jest.fn(),
    createPolicy: jest.fn(),
    evaluatePolicy: jest.fn(),
    listApprovals: jest.fn(),
    getApproval: jest.fn(),
    decideApproval: jest.fn(),
  };

  let controller: PolicyController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PolicyController(policyService as never);
  });

  it('uses verified tenant context when evaluating a policy', async () => {
    const result = {
      outcome: 'ALLOWED',
      risk: {
        class: 'L1',
        policyRef: {
          id: policyId,
          key: 'plan.change',
          version: '1',
        },
        approvalRequired: false,
      },
      policy: null,
      safeDefault: false,
      reason: 'POLICY_ALLOW',
    };

    policyService.evaluatePolicy.mockResolvedValue(result);

    await expect(
      controller.evaluatePolicy(request, {
        action: 'plan.change',
        resource_type: 'PLAN',
        attributes: {
          role: 'planner',
        },
        effective_at: '2026-10-06T00:00:00.000Z',
      }),
    ).resolves.toBe(result);

    expect(policyService.evaluatePolicy).toHaveBeenCalledWith(
      tenantId,
      {
        action: 'plan.change',
        resourceType: 'PLAN',
        attributes: {
          role: 'planner',
        },
        effectiveAt: '2026-10-06T00:00:00.000Z',
      },
    );
  });

  it('rejects missing verified authentication context', async () => {
    await expect(
      controller.listPolicies({} as never, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('creates a policy using verified user and tenant context', async () => {
    const result = {
      id: policyId,
      tenantId,
      key: 'plan.change',
      version: '1',
    };

    policyService.createPolicy.mockResolvedValue(result);

    await expect(
      controller.createPolicy(request, {
        key: 'plan.change',
        action: 'plan.change',
        resource_type: 'PLAN',
        effect: 'ALLOW',
        risk_class_id: riskClassId,
        approval_required: false,
        conditions: {
          role: 'planner',
        },
        approval_route: {},
        status: 'ACTIVE',
        priority: 100,
        change_reason: 'Initial policy',
      }),
    ).resolves.toBe(result);

    expect(policyService.createPolicy).toHaveBeenCalledWith(
      tenantId,
      userId,
      {
        key: 'plan.change',
        action: 'plan.change',
        resourceType: 'PLAN',
        effect: 'ALLOW',
        riskClassId,
        approvalRequired: false,
        conditions: {
          role: 'planner',
        },
        approvalRoute: {},
        status: 'ACTIVE',
        priority: 100,
        effectiveFrom: undefined,
        effectiveTo: undefined,
        changeReason: 'Initial policy',
      },
    );
  });

  it('uses verified user context when deciding an approval', async () => {
    const result = {
      id: approvalId,
      tenantId,
      status: 'APPROVED',
    };

    policyService.decideApproval.mockResolvedValue(result);

    await expect(
      controller.decideApproval(request, approvalId, {
        decision: 'APPROVE',
        reason: null,
      }),
    ).resolves.toBe(result);

    expect(policyService.decideApproval).toHaveBeenCalledWith(
      tenantId,
      userId,
      approvalId,
      'APPROVE',
      null,
    );
  });
});
