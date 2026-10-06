import { IamController } from './iam.controller';

describe('IamController identity authority', () => {
  const iamService = {
    resolveAccess: jest.fn(),
    listUsers: jest.fn(),
    listRoles: jest.fn(),
    listPermissions: jest.fn(),
    listFactories: jest.fn(),
    linkAuthIdentity: jest.fn(),
  };

  const controller = new IamController(iamService as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves access from verified request context, never from request headers', async () => {
    iamService.resolveAccess.mockResolvedValue({ ok: true });

    const request = {
      headers: {
        'x-user-id': 'attacker-user',
        'x-tenant-id': 'attacker-tenant',
      },
      factoryos: {
        requestId: 'request-1',
        traceId: 'trace-1',
        requestedUserId: 'attacker-user',
        requestedTenantId: 'attacker-tenant',
        requestedFactoryId: null,
        userId: 'verified-user',
        tenantId: 'verified-tenant',
        factoryId: null,
      },
    };

    await controller.getAccess(request as never);

    expect(iamService.resolveAccess).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
    );
  });

  it('rejects a missing verified identity even when spoofable headers are present', async () => {
    const request = {
      headers: {
        'x-user-id': 'attacker-user',
        'x-tenant-id': 'attacker-tenant',
      },
      factoryos: {
        requestId: 'request-1',
        traceId: 'trace-1',
        requestedUserId: 'attacker-user',
        requestedTenantId: 'attacker-tenant',
        requestedFactoryId: null,
        userId: null,
        tenantId: null,
        factoryId: null,
      },
    };

    await expect(
      controller.getAccess(request as never),
    ).rejects.toThrow('Authenticated user context is missing');

    expect(iamService.resolveAccess).not.toHaveBeenCalled();
  });

  it('uses verified identity for user listing', async () => {
    iamService.listUsers.mockResolvedValue({ items: [] });

    const request = {
      factoryos: {
        userId: 'verified-user',
        tenantId: 'verified-tenant',
      },
    };

    await controller.getUsers(request as never, '25');

    expect(iamService.listUsers).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
      25,
    );
  });

  it('uses verified identity for role, permission, and factory listings', async () => {
    iamService.listRoles.mockResolvedValue({ items: [] });
    iamService.listPermissions.mockResolvedValue({ items: [] });
    iamService.listFactories.mockResolvedValue({ items: [] });

    const request = {
      factoryos: {
        userId: 'verified-user',
        tenantId: 'verified-tenant',
      },
    };

    await controller.getRoles(request as never);
    await controller.getPermissions(request as never);
    await controller.getFactories(request as never);

    expect(iamService.listRoles).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
    );
    expect(iamService.listPermissions).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
    );
    expect(iamService.listFactories).toHaveBeenCalledWith(
      'verified-user',
      'verified-tenant',
    );
  });
});
