import { jest } from '@jest/globals';

import { IamController } from './iam.controller';

describe('IamController identity authority', () => {
  /**
   * ----------------------------------------------------------
   * Typed mocks
   * ----------------------------------------------------------
   *
   * Using typed implementations prevents Jest ESM mocks from
   * inferring mockResolvedValue() as `never`.
   */

  const iamService = {
    resolveAccess: jest.fn(
      async () => ({
        ok: true,
      }),
    ),

    listUsers: jest.fn(
      async () => ({
        items: [],
      }),
    ),

    listRoles: jest.fn(
      async () => ({
        items: [],
      }),
    ),

    listPermissions: jest.fn(
      async () => ({
        items: [],
      }),
    ),

    listFactories: jest.fn(
      async () => ({
        items: [],
      }),
    ),

    linkAuthIdentity: jest.fn(
      async () => ({
        id: 'identity-1',
      }),
    ),
  };

  const controller = new IamController(
    iamService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // GET /api/iam/access
  // ============================================================

  it(
    'uses verified request identity for access resolution',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            'verified-user',

          tenantId:
            'verified-tenant',

          factoryId:
            null,
        },
      };

      const result =
        await controller.getAccess(
          request as never,
        );

      expect(result).toEqual({
        ok: true,
      });

      expect(
        iamService.resolveAccess,
      ).toHaveBeenCalledTimes(1);

      expect(
        iamService.resolveAccess,
      ).toHaveBeenCalledWith(
        'verified-user',
        'verified-tenant',
      );

      expect(
        iamService.resolveAccess,
      ).not.toHaveBeenCalledWith(
        'attacker-user',
        'attacker-tenant',
      );
    },
  );

  // ============================================================
  // GET /api/iam/access
  // ============================================================

  it(
    'does not trust spoofed headers when verified identity is missing',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            null,

          tenantId:
            null,

          factoryId:
            null,
        },
      };

      await expect(
        controller.getAccess(
          request as never,
        ),
      ).rejects.toThrow(
        'Authenticated user context is missing',
      );

      expect(
        iamService.resolveAccess,
      ).not.toHaveBeenCalled();
    },
  );

  // ============================================================
  // GET /api/iam/users
  // ============================================================

  it(
    'uses verified identity for users listing',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            'verified-user',

          tenantId:
            'verified-tenant',

          factoryId:
            null,
        },
      };

      const result =
        await controller.getUsers(
          request as never,
          '25',
        );

      expect(result).toEqual({
        items: [],
      });

      expect(
        iamService.listUsers,
      ).toHaveBeenCalledTimes(1);

      expect(
        iamService.listUsers,
      ).toHaveBeenCalledWith(
        'verified-user',
        'verified-tenant',
        25,
      );

      expect(
        iamService.listUsers,
      ).not.toHaveBeenCalledWith(
        'attacker-user',
        'attacker-tenant',
        25,
      );
    },
  );

  // ============================================================
  // GET /api/iam/users
  // ============================================================

  it(
    'rejects users listing when verified identity is missing',
    async () => {
      const request = {
        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            null,

          tenantId:
            null,

          factoryId:
            null,
        },
      };

      await expect(
        controller.getUsers(
          request as never,
          '25',
        ),
      ).rejects.toThrow(
        'Authenticated user context is missing',
      );

      expect(
        iamService.listUsers,
      ).not.toHaveBeenCalled();
    },
  );

  // ============================================================
  // GET /api/iam/roles
  // ============================================================

  it(
    'uses verified identity for roles listing',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            'verified-user',

          tenantId:
            'verified-tenant',

          factoryId:
            null,
        },
      };

      const result =
        await controller.getRoles(
          request as never,
        );

      expect(result).toEqual({
        items: [],
      });

      expect(
        iamService.listRoles,
      ).toHaveBeenCalledTimes(1);

      expect(
        iamService.listRoles,
      ).toHaveBeenCalledWith(
        'verified-user',
        'verified-tenant',
      );

      expect(
        iamService.listRoles,
      ).not.toHaveBeenCalledWith(
        'attacker-user',
        'attacker-tenant',
      );
    },
  );

  // ============================================================
  // GET /api/iam/permissions
  // ============================================================

  it(
    'uses verified identity for permissions listing',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            'verified-user',

          tenantId:
            'verified-tenant',

          factoryId:
            null,
        },
      };

      const result =
        await controller.getPermissions(
          request as never,
        );

      expect(result).toEqual({
        items: [],
      });

      expect(
        iamService.listPermissions,
      ).toHaveBeenCalledTimes(1);

      expect(
        iamService.listPermissions,
      ).toHaveBeenCalledWith(
        'verified-user',
        'verified-tenant',
      );

      expect(
        iamService.listPermissions,
      ).not.toHaveBeenCalledWith(
        'attacker-user',
        'attacker-tenant',
      );
    },
  );

  // ============================================================
  // GET /api/iam/factories
  // ============================================================

  it(
    'uses verified identity for factories listing',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            'verified-user',

          tenantId:
            'verified-tenant',

          factoryId:
            null,
        },
      };

      const result =
        await controller.getFactories(
          request as never,
        );

      expect(result).toEqual({
        items: [],
      });

      expect(
        iamService.listFactories,
      ).toHaveBeenCalledTimes(1);

      expect(
        iamService.listFactories,
      ).toHaveBeenCalledWith(
        'verified-user',
        'verified-tenant',
      );

      expect(
        iamService.listFactories,
      ).not.toHaveBeenCalledWith(
        'attacker-user',
        'attacker-tenant',
      );
    },
  );

  // ============================================================
  // POST /api/iam/users/auth-identities
  // ============================================================

  it(
    'uses verified identity as actor when linking auth identity',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            'verified-user',

          tenantId:
            'verified-tenant',

          factoryId:
            null,
        },
      };

      const body = {
        user_id:
          'target-user',

        issuer:
          'https://issuer.example.com',

        subject:
          'subject-123',
      };

      const result =
        await controller.linkAuthIdentity(
          request as never,
          body as never,
        );

      expect(result).toEqual({
        id: 'identity-1',
      });

      expect(
        iamService.linkAuthIdentity,
      ).toHaveBeenCalledTimes(1);

      expect(
        iamService.linkAuthIdentity,
      ).toHaveBeenCalledWith(
        'verified-user',
        'verified-tenant',
        'target-user',
        'https://issuer.example.com',
        'subject-123',
      );

      expect(
        iamService.linkAuthIdentity,
      ).not.toHaveBeenCalledWith(
        'attacker-user',
        'attacker-tenant',
        'target-user',
        'https://issuer.example.com',
        'subject-123',
      );
    },
  );

  // ============================================================
  // POST /api/iam/users/auth-identities
  // ============================================================

  it(
    'rejects auth identity linking when verified identity is missing',
    async () => {
      const request = {
        headers: {
          'x-user-id': 'attacker-user',
          'x-tenant-id': 'attacker-tenant',
        },

        factoryos: {
          requestId: 'request-1',
          traceId: 'trace-1',

          requestedUserId:
            'attacker-user',

          requestedTenantId:
            'attacker-tenant',

          requestedFactoryId:
            null,

          userId:
            null,

          tenantId:
            null,

          factoryId:
            null,
        },
      };

      const body = {
        user_id:
          'target-user',

        issuer:
          'https://issuer.example.com',

        subject:
          'subject-123',
      };

      await expect(
        controller.linkAuthIdentity(
          request as never,
          body as never,
        ),
      ).rejects.toThrow(
        'Authenticated user context is missing',
      );

      expect(
        iamService.linkAuthIdentity,
      ).not.toHaveBeenCalled();
    },
  );
});