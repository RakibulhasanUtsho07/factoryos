import { jest } from '@jest/globals';

import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import {
  EntitlementsController,
} from './entitlements.controller';

describe(
  'EntitlementsController',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const userId =
      '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

    const entitlementId =
      '1f3f8d8b-df0d-4d96-9b8f-3d6572dc9001';

    const featureFlagId =
      '2f3f8d8b-df0d-4d96-9b8f-3d6572dc9002';

    const request = {
      factoryos: {
        requestId:
          'request-001',

        traceId:
          'trace-001',

        requestedUserId:
          'attacker-user-id',

        requestedTenantId:
          'attacker-tenant-id',

        requestedFactoryId:
          null,

        userId,

        tenantId,

        factoryId:
          null,
      },
    } as never;

    const entitlementService = {
      listEntitlements:
        jest.fn(),

      getEntitlement:
        jest.fn(),

      createEntitlement:
        jest.fn(),
    };

    const featureFlagService = {
      listFeatureFlags:
        jest.fn(),

      getFeatureFlag:
        jest.fn(),

      createFeatureFlag:
        jest.fn(),

      resolveFeatureFlag:
        jest.fn(),
    };

    const iamService = {
      authorize:
        jest.fn(),
    };

    let controller:
      EntitlementsController;

    beforeEach(
      () => {
        jest.clearAllMocks();

        controller =
          new EntitlementsController(
            entitlementService as never,

            featureFlagService as never,

            iamService as never,
          );
      },
    );

    // ==========================================================
    // AUTHENTICATED CONTEXT
    // ==========================================================

    it(
      'uses verified tenant and user context instead of requested headers',
      async () => {
        entitlementService
          .listEntitlements
          .mockResolvedValue({
            items: [],

            limit:
              50,

            offset:
              0,

            count:
              0,
          });

        await controller.listEntitlements(
          request,

          {
            limit:
              50,

            offset:
              0,
          },
        );

        expect(
          entitlementService
            .listEntitlements,
        ).toHaveBeenCalledWith(
          tenantId,

          {
            package:
              undefined,

            featureKey:
              undefined,

            status:
              undefined,

            limit:
              50,

            offset:
              0,
          },
        );
      },
    );

    it(
      'rejects a request without verified authentication context',
      async () => {
        const requestWithoutContext =
          {} as never;

        await expect(
          controller.listEntitlements(
            requestWithoutContext,

            {},
          ),
        ).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      },
    );

    // ==========================================================
    // ENTITLEMENTS
    // ==========================================================

    it(
      'lists entitlements',
      async () => {
        const result = {
          items: [
            {
              id:
                entitlementId,
            },
          ],

          limit:
            20,

          offset:
            10,

          count:
            1,
        };

        entitlementService
          .listEntitlements
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.listEntitlements(
            request,

            {
              package:
                'PRO',

              feature_key:
                'ai.copilot',

              status:
                'ACTIVE',

              limit:
                20,

              offset:
                10,
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          entitlementService
            .listEntitlements,
        ).toHaveBeenCalledWith(
          tenantId,

          {
            package:
              'PRO',

            featureKey:
              'ai.copilot',

            status:
              'ACTIVE',

            limit:
              20,

            offset:
              10,
          },
        );
      },
    );

    it(
      'gets an entitlement by id',
      async () => {
        const result = {
          id:
            entitlementId,

          tenantId,
        };

        entitlementService
          .getEntitlement
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.getEntitlement(
            request,

            entitlementId,
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          entitlementService
            .getEntitlement,
        ).toHaveBeenCalledWith(
          tenantId,

          entitlementId,
        );
      },
    );

    it(
      'creates an entitlement using verified identity',
      async () => {
        const result = {
          id:
            entitlementId,

          tenantId,

          package:
            'PRO',

          featureKey:
            'ai.copilot',

          version:
            1,
        };

        entitlementService
          .createEntitlement
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.createEntitlement(
            request,

            {
              package:
                'PRO',

              feature_key:
                'ai.copilot',

              limit_value:
                100,

              period:
                'MONTH',

              status:
                'ACTIVE',

              effective_from:
                '2026-10-06T00:00:00.000Z',

              effective_to:
                null,

              config: {
                model:
                  'default',
              },
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          entitlementService
            .createEntitlement,
        ).toHaveBeenCalledWith(
          tenantId,

          userId,

          {
            package:
              'PRO',

            featureKey:
              'ai.copilot',

            limitValue:
              100,

            period:
              'MONTH',

            status:
              'ACTIVE',

            effectiveFrom:
              '2026-10-06T00:00:00.000Z',

            effectiveTo:
              null,

            config: {
              model:
                'default',
            },
          },
        );
      },
    );

    // ==========================================================
    // FEATURE FLAGS
    // ==========================================================

    it(
      'lists feature flags',
      async () => {
        const result = {
          items: [
            {
              id:
                featureFlagId,
            },
          ],

          limit:
            50,

          offset:
            0,

          count:
            1,
        };

        featureFlagService
          .listFeatureFlags
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.listFeatureFlags(
            request,

            {
              key:
                'enable_growth_engine',

              enabled:
                true,

              owner:
                'product',

              security_critical:
                false,

              limit:
                50,

              offset:
                0,
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          featureFlagService
            .listFeatureFlags,
        ).toHaveBeenCalledWith(
          tenantId,

          {
            key:
              'enable_growth_engine',

            enabled:
              true,

            owner:
              'product',

            securityCritical:
              false,

            limit:
              50,

            offset:
              0,
          },
        );
      },
    );

    it(
      'gets a feature flag by id',
      async () => {
        const result = {
          id:
            featureFlagId,

          tenantId,

          key:
            'enable_growth_engine',
        };

        featureFlagService
          .getFeatureFlag
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.getFeatureFlag(
            request,

            featureFlagId,
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          featureFlagService
            .getFeatureFlag,
        ).toHaveBeenCalledWith(
          tenantId,

          featureFlagId,
        );
      },
    );

    it(
      'creates a normal feature flag without security-critical authorization',
      async () => {
        const result = {
          id:
            featureFlagId,

          tenantId,

          key:
            'enable_growth_engine',

          version:
            1,
        };

        featureFlagService
          .createFeatureFlag
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.createFeatureFlag(
            request,

            {
              key:
                'enable_growth_engine',

              enabled:
                true,

              config: {
                rollout:
                  100,
              },

              owner:
                'product',

              security_critical:
                false,

              change_reason:
                null,
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          iamService.authorize,
        ).not.toHaveBeenCalled();

        expect(
          featureFlagService
            .createFeatureFlag,
        ).toHaveBeenCalledWith(
          tenantId,

          userId,

          {
            key:
              'enable_growth_engine',

            enabled:
              true,

            config: {
              rollout:
                100,
            },

            owner:
              'product',

            securityCritical:
              false,

            changeReason:
              null,

            effectiveFrom:
              undefined,

            expiresAt:
              undefined,
          },

          {
            securityCriticalChangeAuthorized:
              false,
          },
        );
      },
    );

    it(
      'requires the privileged IAM permission for a security-critical flag',
      async () => {
        const result = {
          id:
            featureFlagId,

          tenantId,

          key:
            'emergency_kill_switch',

          version:
            1,
        };

        iamService
          .authorize
          .mockResolvedValue(
            undefined,
          );

        featureFlagService
          .createFeatureFlag
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.createFeatureFlag(
            request,

            {
              key:
                'emergency_kill_switch',

              enabled:
                false,

              config: {},

              owner:
                'security',

              security_critical:
                true,

              change_reason:
                'Emergency control-plane change',
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          iamService.authorize,
        ).toHaveBeenCalledWith(
          userId,

          tenantId,

          'feature_flags.security_critical.write',

          null,
        );

        expect(
          featureFlagService
            .createFeatureFlag,
        ).toHaveBeenCalledWith(
          tenantId,

          userId,

          {
            key:
              'emergency_kill_switch',

            enabled:
              false,

            config: {},

            owner:
              'security',

            securityCritical:
              true,

            changeReason:
              'Emergency control-plane change',

            effectiveFrom:
              undefined,

            expiresAt:
              undefined,
          },

          {
            securityCriticalChangeAuthorized:
              true,
          },
        );
      },
    );

    it(
      'does not create a security-critical flag when privileged IAM authorization fails',
      async () => {
        iamService
          .authorize
          .mockRejectedValue(
            new ForbiddenException(
              'Missing permission: feature_flags.security_critical.write',
            ),
          );

        await expect(
          controller.createFeatureFlag(
            request,

            {
              key:
                'emergency_kill_switch',

              enabled:
                false,

              owner:
                'security',

              security_critical:
                true,

              change_reason:
                'Attempted privileged change',
            },
          ),
        ).rejects.toBeInstanceOf(
          ForbiddenException,
        );

        expect(
          featureFlagService
            .createFeatureFlag,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'evaluates a feature flag using the authenticated tenant',
      async () => {
        const result = {
          enabled:
            true,

          flag: {
            id:
              featureFlagId,

            key:
              'enable_growth_engine',
          },

          safeDefault:
            false,
        };

        featureFlagService
          .resolveFeatureFlag
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.evaluateFeatureFlag(
            request,

            'enable_growth_engine',

            {
              at:
                '2026-10-06T00:00:00.000Z',
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          featureFlagService
            .resolveFeatureFlag,
        ).toHaveBeenCalledWith(
          tenantId,

          'enable_growth_engine',

          '2026-10-06T00:00:00.000Z',
        );
      },
    );
  },
);