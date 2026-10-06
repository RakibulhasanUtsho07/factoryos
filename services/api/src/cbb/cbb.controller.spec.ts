import {
  jest,
} from '@jest/globals';

import {
  UnauthorizedException,
} from '@nestjs/common';

import {
  CbbController,
} from './cbb.controller';

const getBusinessModel =
  jest.fn<
    (
      tenantId: string,
      factoryId: string,
    ) => Promise<unknown>
  >();

const getBusinessMap =
  jest.fn<
    (
      tenantId: string,
      factoryId: string,
    ) => Promise<unknown>
  >();

const listProcesses =
  jest.fn<
    (
      tenantId: string,
      factoryId: string,
    ) => Promise<unknown>
  >();

const getProcess =
  jest.fn<
    (
      tenantId: string,
      factoryId: string,
      processId: string,
    ) => Promise<unknown>
  >();

const cbbService = {
  getBusinessModel,
  getBusinessMap,
  listProcesses,
  getProcess,
};

describe(
  'CbbController',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const userId =
      '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

    const factoryId =
      '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';

    const processId =
      '9fa03a36-4e3e-45ff-8f48-9ce3e2af0004';

    const request = {
      factoryos: {
        requestId:
          'request-001',

        traceId:
          'trace-001',

        requestedUserId:
          'attacker-user',

        requestedTenantId:
          'attacker-tenant',

        requestedFactoryId:
          'attacker-factory',

        userId,

        tenantId,

        factoryId,
      },
    } as never;

    let controller:
      CbbController;

    beforeEach(
      () => {
        jest.clearAllMocks();

        controller =
          new CbbController(
            cbbService as never,
          );
      },
    );

    it(
      'uses verified tenant and factory context for business model reads',
      async () => {
        const result = {
          tenantId,
          factoryId,

          blueprint: {
            id:
              'blueprint-001',
          },
        };

        getBusinessModel
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.getBusinessModel(
            request,
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          getBusinessModel,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
        );
      },
    );

    it(
      'does not trust requested tenant or factory headers',
      async () => {
        getBusinessMap
          .mockResolvedValue(
            {},
          );

        await controller.getBusinessMap(
          request,
        );

        expect(
          getBusinessMap,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
        );

        expect(
          getBusinessMap,
        ).not.toHaveBeenCalledWith(
          'attacker-tenant',
          'attacker-factory',
        );
      },
    );

    it(
      'returns process list using verified factory scope',
      async () => {
        listProcesses
          .mockResolvedValue(
            {
              items: [],
              count: 0,
            },
          );

        await controller.listProcesses(
          request,
        );

        expect(
          listProcesses,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
        );
      },
    );

    it(
      'returns process detail using verified factory scope',
      async () => {
        getProcess
          .mockResolvedValue(
            {
              process: {
                id:
                  processId,
              },

              steps: [],
            },
          );

        await controller.getProcess(
          request,
          processId,
        );

        expect(
          getProcess,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          processId,
        );
      },
    );

    it(
      'rejects a missing verified factory context',
      async () => {
        await expect(
          controller.getBusinessModel(
            {} as never,
          ),
        ).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      },
    );
  },
);