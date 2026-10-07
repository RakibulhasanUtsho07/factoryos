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

const createChangeProposal =
  jest.fn<
    (
      ...args: unknown[]
    ) => Promise<unknown>
  >();

const listChangeProposals =
  jest.fn<
    (
      ...args: unknown[]
    ) => Promise<unknown>
  >();

const approveChangeProposal =
  jest.fn<
    (
      ...args: unknown[]
    ) => Promise<unknown>
  >();

const rejectChangeProposal =
  jest.fn<
    (
      ...args: unknown[]
    ) => Promise<unknown>
  >();

const createFeedback =
  jest.fn<
    (
      ...args: unknown[]
    ) => Promise<unknown>
  >();

const cbbService = {
  getBusinessModel,
  getBusinessMap,
  listProcesses,
  getProcess,
};

const cbbChangeService = {
  createChangeProposal,
  listChangeProposals,
  approveChangeProposal,
  rejectChangeProposal,
  createFeedback,
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

    const proposalId =
      'a0000000-0000-0000-0000-000000000001';

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
            cbbChangeService as never,
          );
      },
    );

    // ==========================================================
    // READS
    // ==========================================================

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
          .mockResolvedValue({
            items: [],
            count: 0,
          });

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
          .mockResolvedValue({
            process: {
              id:
                processId,
            },

            steps: [],
          });

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

    // ==========================================================
    // CHANGES
    // ==========================================================

    it(
      'creates a business change using the verified factory context',
      async () => {
        const result = {
          id:
            proposalId,

          status:
            'PENDING',
        };

        createChangeProposal
          .mockResolvedValue(
            result,
          );

        await expect(
          controller.createChange(
            request,
            {
              target_type:
                'ENTITY',

              target_id:
                proposalId,

              proposal_type:
                'UPDATE',

              proposed_state:
                'PROPOSED',

              proposed_payload:
                {},

              reason:
                'Review',
            },
          ),
        ).resolves.toBe(
          result,
        );

        expect(
          createChangeProposal,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          userId,
          expect.objectContaining({
            targetType:
              'ENTITY',
          }),
        );
      },
    );

    it(
      'lists changes using verified tenant and factory scope',
      async () => {
        listChangeProposals
          .mockResolvedValue({
            items: [],
            limit: 50,
            offset: 0,
            count: 0,
          });

        await controller.listChanges(
          request,
          {
            limit: 50,
            offset: 0,
          },
        );

        expect(
          listChangeProposals,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          expect.any(
            Object,
          ),
        );
      },
    );

    it(
      'approves a business change using verified identity',
      async () => {
        approveChangeProposal
          .mockResolvedValue({
            status:
              'APPROVED',
          });

        await controller.approveChange(
          request,
          proposalId,
          {
            reason:
              'Approved',
          },
        );

        expect(
          approveChangeProposal,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          userId,
          proposalId,
          'Approved',
        );
      },
    );

    it(
      'rejects a business change using verified identity',
      async () => {
        rejectChangeProposal
          .mockResolvedValue({
            status:
              'REJECTED',
          });

        await controller.rejectChange(
          request,
          proposalId,
          {
            reason:
              'Insufficient evidence',
          },
        );

        expect(
          rejectChangeProposal,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          userId,
          proposalId,
          'Insufficient evidence',
        );
      },
    );

    // ==========================================================
    // FEEDBACK
    // ==========================================================

    it(
      'creates feedback in the verified factory scope',
      async () => {
        createFeedback
          .mockResolvedValue({
            id:
              'f0000000-0000-0000-0000-000000000001',
          });

        await controller.createFeedback(
          request,
          {
            subject_type:
              'ENTITY',

            subject_id:
              proposalId,

            feedback_type:
              'INCORRECT',

            payload_json:
              {
                note:
                  'Incorrect node',
              },
          },
        );

        expect(
          createFeedback,
        ).toHaveBeenCalledWith(
          tenantId,
          factoryId,
          userId,
          {
            subjectType:
              'ENTITY',

            subjectId:
              proposalId,

            feedbackType:
              'INCORRECT',

            payload: {
              note:
                'Incorrect node',
            },
          },
        );
      },
    );

    // ==========================================================
    // AUTH CONTEXT
    // ==========================================================

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