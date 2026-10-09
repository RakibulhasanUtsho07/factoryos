import { jest } from '@jest/globals';

import { BadRequestException } from '@nestjs/common';

import { PolicyService } from './policy.service';

describe('PolicyService', () => {
  const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
  const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
  const riskClassId = '2f3f8d8b-df0d-4d96-9b8f-3d6572dc9002';
  const policyId = '1f3f8d8b-df0d-4d96-9b8f-3d6572dc9001';

  const database = {
    query: jest.fn(),
    transaction: jest.fn(),
  };

  const auditService = {
    record: jest.fn(),
  };

  let service: PolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PolicyService(
      database as never,
      auditService as never,
    );
    auditService.record.mockResolvedValue('audit-001');
  });

  it('creates a new risk-class version', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ next_version: '2' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: riskClassId,
              tenant_id: tenantId,
              code: 'L3',
              name: 'High Risk',
              description: 'High impact',
              version: '2',
              default_approval_required: true,
              status: 'ACTIVE',
              effective_from: '2026-10-06T00:00:00.000Z',
              effective_to: null,
              created_by: userId,
              created_at: '2026-10-06T00:00:00.000Z',
            },
          ],
        }),
    };

    database.transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) =>
        callback(client),
    );

    const result = await service.createRiskClass(
      tenantId,
      userId,
      {
        code: 'L3',
        name: 'High Risk',
        description: 'High impact',
        defaultApprovalRequired: true,
      },
    );

    expect(result.version).toBe('2');
    expect(database.transaction).toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalled();
  });

  it('requires an active risk class before creating a policy', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: riskClassId, status: 'DISABLED' }],
        }),
    };

    database.transaction.mockImplementation(
      async (callback: (client: unknown) => Promise<unknown>) =>
        callback(client),
    );

    await expect(
      service.createPolicy(tenantId, userId, {
        key: 'plan.change',
        action: 'plan.change',
        riskClassId,
        effect: 'ALLOW',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a matching policy with no approval requirement', async () => {
    database.query.mockResolvedValue({
      rows: [
        {
          id: policyId,
          tenant_id: tenantId,
          key: 'plan.read',
          version: '1',
          status: 'ACTIVE',
          priority: 100,
          action: 'plan.read',
          resource_type: null,
          effect: 'ALLOW',
          risk_class_id: riskClassId,
          risk_class_code: 'L0',
          risk_class_name: 'Informational',
          risk_class_version: '1',
          risk_class_default_approval_required: false,
          risk_class_status: 'ACTIVE',
          approval_required: false,
          conditions: {},
          approval_route: {},
          effective_from: '2026-10-06T00:00:00.000Z',
          effective_to: null,
          created_by: userId,
          change_reason: null,
          created_at: '2026-10-06T00:00:00.000Z',
        },
      ],
    });

    const result = await service.evaluatePolicy(tenantId, {
      action: 'plan.read',
      attributes: {},
    });

    expect(result.outcome).toBe('ALLOWED');
    expect(result.safeDefault).toBe(false);
  });

  it('requires approval for a policy whose risk class requires it', async () => {
    database.query.mockResolvedValue({
      rows: [
        {
          id: policyId,
          tenant_id: tenantId,
          key: 'plan.change',
          version: '1',
          status: 'ACTIVE',
          priority: 100,
          action: 'plan.change',
          resource_type: 'PLAN',
          effect: 'ALLOW',
          risk_class_id: riskClassId,
          risk_class_code: 'L3',
          risk_class_name: 'High Risk',
          risk_class_version: '1',
          risk_class_default_approval_required: true,
          risk_class_status: 'ACTIVE',
          approval_required: false,
          conditions: { role: 'planner' },
          approval_route: {},
          effective_from: '2026-10-06T00:00:00.000Z',
          effective_to: null,
          created_by: userId,
          change_reason: null,
          created_at: '2026-10-06T00:00:00.000Z',
        },
      ],
    });

    const result = await service.evaluatePolicy(tenantId, {
      action: 'plan.change',
      resourceType: 'PLAN',
      attributes: {
        role: 'planner',
      },
    });

    expect(result.outcome).toBe('APPROVAL_REQUIRED');
    expect(result.risk.approvalRequired).toBe(true);
  });

  it('fails closed when policy evaluation hits a database error', async () => {
    database.query.mockRejectedValue(
      new Error('database unavailable'),
    );

    const result = await service.evaluatePolicy(tenantId, {
      action: 'plan.change',
    });

    expect(result.outcome).toBe('DENIED');
    expect(result.safeDefault).toBe(true);
    expect(result.reason).toBe('POLICY_EVALUATION_FAILED');
  });
});
