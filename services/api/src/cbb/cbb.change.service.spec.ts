import {
  jest,
} from '@jest/globals';

import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import type {
  DatabaseContext,
} from '../database/database.service';

import type {
  PoolClient,
  QueryResultRow,
} from 'pg';

import {
  CbbChangeService,
} from './cbb.change.service';

type TestQueryResult = {
  rows: QueryResultRow[];
};

type TestQueryMock = jest.MockedFunction<
  (
    text: string,
    values?: unknown[],
  ) => Promise<TestQueryResult>
>;

interface TestClient {
  query: PoolClient['query'];
}

type TestTransactionImplementation = <
  T,
>(
  callback: (
    client: TestClient,
  ) => Promise<T>,
  context?: DatabaseContext,
) => Promise<T>;

type TestTransactionMock =
  jest.MockedFunction<
    TestTransactionImplementation
  >;

const queryMock =
  jest.fn<
    (
      text: string,
      values?: unknown[],
    ) => Promise<TestQueryResult>
  >() as TestQueryMock;

const transactionMock =
  jest.fn(
    async function <
      T,
    >(
      callback: (
        client: TestClient,
      ) => Promise<T>,
      _context?: DatabaseContext,
    ): Promise<T> {
      const client: TestClient = {
        query:
          queryMock as unknown as PoolClient['query'],
      };

      return callback(
        client,
      );
    },
  ) as TestTransactionMock;

const database = {
  query:
    queryMock,

  transaction:
    transactionMock,
};

const auditRecordMock =
  jest.fn<
    (
      input: unknown,
    ) => Promise<void>
  >();

const auditService = {
  record:
    auditRecordMock,
};

describe(
  'CbbChangeService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const factoryId =
      '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';

    const userId =
      '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

    const blueprintId =
      'b0000000-0000-4000-8000-000000000001';

    const versionId =
      'c0000000-0000-4000-8000-000000000001';

    const entityId =
      'e0000000-0000-4000-8000-000000000001';

    const proposalId =
      'a0000000-0000-4000-8000-000000000001';

    const promotedVersionId =
      'd0000000-0000-4000-8000-000000000001';

    const feedbackId =
      'f0000000-0000-4000-8000-000000000001';

    let service:
      CbbChangeService;

    beforeEach(
      () => {
        jest.clearAllMocks();

        service =
          new CbbChangeService(
            database as never,
            auditService as never,
          );
      },
    );

    // ==========================================================
    // CREATE
    // ==========================================================

    it(
      'creates a pending business change proposal pinned to the current blueprint version',
      async () => {
        queryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  blueprintId,

                current_version_id:
                  versionId,
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  entityId,
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  proposalId,

                tenant_id:
                  tenantId,

                factory_id:
                  factoryId,

                blueprint_id:
                  blueprintId,

                source_version_id:
                  versionId,

                promoted_version_id:
                  null,

                promoted_at:
                  null,

                target_type:
                  'ENTITY',

                target_id:
                  entityId,

                proposal_type:
                  'UPDATE_DESCRIPTION',

                proposed_state:
                  'PROPOSED',

                proposed_payload:
                  {
                    description:
                      'Updated',
                  },

                status:
                  'PENDING',

                reason:
                  'Business review',

                requested_by:
                  userId,

                decided_by:
                  null,

                requested_at:
                  '2026-10-06T00:00:00.000Z',

                decided_at:
                  null,

                decision_reason:
                  null,
              },
            ],
          });

        const result =
          await service.createChangeProposal(
            tenantId,
            factoryId,
            userId,
            {
              targetType:
                'ENTITY',

              targetId:
                entityId,

              proposalType:
                'UPDATE_DESCRIPTION',

              proposedState:
                'PROPOSED',

              proposedPayload:
                {
                  description:
                    'Updated',
                },

              reason:
                'Business review',
            },
          );

        expect(
          result.status,
        ).toBe(
          'PENDING',
        );

        expect(
          result.targetType,
        ).toBe(
          'ENTITY',
        );

        expect(
          result.targetId,
        ).toBe(
          entityId,
        );

        expect(
          result.tenantId,
        ).toBe(
          tenantId,
        );

        expect(
          result.factoryId,
        ).toBe(
          factoryId,
        );

        expect(
          result.sourceVersionId,
        ).toBe(
          versionId,
        );

        expect(
          result.promotedVersionId,
        ).toBeNull();

        expect(
          result.promotedAt,
        ).toBeNull();

        expect(
          transactionMock,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditRecordMock,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditRecordMock.mock.calls[0]?.[0],
        ).toEqual(
          expect.objectContaining({
            tenantId,
            actorUserId:
              userId,
            eventType:
              'BUSINESS_MODEL_CHANGE',
            action:
              'CREATE_PROPOSAL',
            resourceType:
              'BUSINESS_CHANGE_PROPOSAL',
            resourceId:
              proposalId,
            payload:
              expect.objectContaining({
                sourceVersionId:
                  versionId,
              }),
          }),
        );
      },
    );

    // ==========================================================
    // TARGET SCOPE
    // ==========================================================

    it(
      'rejects a target outside the current factory business model',
      async () => {
        queryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  blueprintId,

                current_version_id:
                  versionId,
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [],
          });

        await expect(
          service.createChangeProposal(
            tenantId,
            factoryId,
            userId,
            {
              targetType:
                'ENTITY',

              targetId:
                'e0000000-0000-4000-8000-000000000099',

              proposalType:
                'UPDATE',

              proposedState:
                'PROPOSED',

              proposedPayload:
                {},

              reason:
                null,
            },
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );

        expect(
          transactionMock,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditRecordMock,
        ).not.toHaveBeenCalled();
      },
    );

    // ==========================================================
    // APPROVE
    // ==========================================================

    it(
      'approves a pending proposal without mutating the blueprint graph',
      async () => {
        queryMock.mockResolvedValueOnce({
          rows: [
            {
              id:
                proposalId,

              tenant_id:
                tenantId,

              factory_id:
                factoryId,

              blueprint_id:
                blueprintId,

              source_version_id:
                versionId,

              promoted_version_id:
                null,

              promoted_at:
                null,

              target_type:
                'ENTITY',

              target_id:
                entityId,

              proposal_type:
                'UPDATE',

              proposed_state:
                'PROPOSED',

              proposed_payload:
                {},

              status:
                'APPROVED',

              reason:
                null,

              requested_by:
                userId,

              decided_by:
                userId,

              requested_at:
                '2026-10-06T00:00:00.000Z',

              decided_at:
                '2026-10-06T01:00:00.000Z',

              decision_reason:
                'Reviewed',
            },
          ],
        });

        const result =
          await service.approveChangeProposal(
            tenantId,
            factoryId,
            userId,
            proposalId,
            'Reviewed',
          );

        expect(
          result.status,
        ).toBe(
          'APPROVED',
        );

        expect(
          result.decidedBy,
        ).toBe(
          userId,
        );

        expect(
          result.decisionReason,
        ).toBe(
          'Reviewed',
        );

        expect(
          result.sourceVersionId,
        ).toBe(
          versionId,
        );

        expect(
          result.promotedVersionId,
        ).toBeNull();

        expect(
          result.promotedAt,
        ).toBeNull();

        expect(
          auditRecordMock,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditRecordMock.mock.calls[0]?.[0],
        ).toEqual(
          expect.objectContaining({
            payload:
              expect.objectContaining({
                sourceVersionId:
                  versionId,
              }),
          }),
        );
      },
    );

    // ==========================================================
    // REJECT VALIDATION
    // ==========================================================

    it(
      'requires a reason when rejecting a proposal',
      async () => {
        await expect(
          service.rejectChangeProposal(
            tenantId,
            factoryId,
            userId,
            proposalId,
            null,
          ),
        ).rejects.toThrow(
          'reason is required when rejecting a change proposal',
        );

        expect(
          queryMock,
        ).not.toHaveBeenCalled();

        expect(
          transactionMock,
        ).not.toHaveBeenCalled();

        expect(
          auditRecordMock,
        ).not.toHaveBeenCalled();
      },
    );

    // ==========================================================
    // REJECT
    // ==========================================================

    it(
      'rejects a pending proposal',
      async () => {
        queryMock.mockResolvedValueOnce({
          rows: [
            {
              id:
                proposalId,

              tenant_id:
                tenantId,

              factory_id:
                factoryId,

              blueprint_id:
                blueprintId,

              source_version_id:
                versionId,

              promoted_version_id:
                null,

              promoted_at:
                null,

              target_type:
                'ENTITY',

              target_id:
                entityId,

              proposal_type:
                'UPDATE',

              proposed_state:
                'PROPOSED',

              proposed_payload:
                {},

              status:
                'REJECTED',

              reason:
                'Review required',

              requested_by:
                userId,

              decided_by:
                userId,

              requested_at:
                '2026-10-06T00:00:00.000Z',

              decided_at:
                '2026-10-06T01:00:00.000Z',

              decision_reason:
                'Insufficient evidence',
            },
          ],
        });

        const result =
          await service.rejectChangeProposal(
            tenantId,
            factoryId,
            userId,
            proposalId,
            'Insufficient evidence',
          );

        expect(
          result.status,
        ).toBe(
          'REJECTED',
        );

        expect(
          result.decisionReason,
        ).toBe(
          'Insufficient evidence',
        );

        expect(
          result.decidedBy,
        ).toBe(
          userId,
        );

        expect(
          result.sourceVersionId,
        ).toBe(
          versionId,
        );

        expect(
          result.promotedVersionId,
        ).toBeNull();

        expect(
          result.promotedAt,
        ).toBeNull();

        expect(
          auditRecordMock,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    // ==========================================================
    // TERMINAL STATE
    // ==========================================================

    it(
      'throws conflict when an already decided proposal is updated',
      async () => {
        queryMock
          .mockResolvedValueOnce({
            rows: [],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  proposalId,

                tenant_id:
                  tenantId,

                factory_id:
                  factoryId,

                blueprint_id:
                  blueprintId,

                source_version_id:
                  versionId,

                promoted_version_id:
                  promotedVersionId,

                promoted_at:
                  '2026-10-06T02:00:00.000Z',

                target_type:
                  'ENTITY',

                target_id:
                  entityId,

                proposal_type:
                  'UPDATE',

                proposed_state:
                  'PROPOSED',

                proposed_payload:
                  {},

                status:
                  'APPROVED',

                reason:
                  null,

                requested_by:
                  userId,

                decided_by:
                  userId,

                requested_at:
                  '2026-10-06T00:00:00.000Z',

                decided_at:
                  '2026-10-06T01:00:00.000Z',

                decision_reason:
                  'Already reviewed',
              },
            ],
          });

        await expect(
          service.approveChangeProposal(
            tenantId,
            factoryId,
            userId,
            proposalId,
            null,
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(
          auditRecordMock,
        ).not.toHaveBeenCalled();
      },
    );

    // ==========================================================
    // FEEDBACK
    // ==========================================================

    it(
      'creates feedback in the factory scope',
      async () => {
        queryMock.mockResolvedValueOnce({
          rows: [
            {
              id:
                feedbackId,

              tenant_id:
                tenantId,

              factory_id:
                factoryId,

              subject_type:
                'ENTITY',

              subject_id:
                entityId,

              feedback_type:
                'INCORRECT',

              payload_json:
                {
                  note:
                    'Wrong name',
                },

              created_by:
                userId,

              created_at:
                '2026-10-06T00:00:00.000Z',
            },
          ],
        });

        const result =
          await service.createFeedback(
            tenantId,
            factoryId,
            userId,
            {
              subjectType:
                'ENTITY',

              subjectId:
                entityId,

              feedbackType:
                'INCORRECT',

              payload:
                {
                  note:
                    'Wrong name',
                },
            },
          );

        expect(
          result.id,
        ).toBe(
          feedbackId,
        );

        expect(
          result.feedbackType,
        ).toBe(
          'INCORRECT',
        );

        expect(
          result.payload,
        ).toEqual({
          note:
            'Wrong name',
        });

        expect(
          result.tenantId,
        ).toBe(
          tenantId,
        );

        expect(
          result.factoryId,
        ).toBe(
          factoryId,
        );

        expect(
          auditRecordMock,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    // ==========================================================
    // INVALID UUID
    // ==========================================================

    it(
      'rejects an invalid proposal UUID',
      async () => {
        await expect(
          service.approveChangeProposal(
            tenantId,
            factoryId,
            userId,
            'not-a-uuid',
            null,
          ),
        ).rejects.toThrow(
          'proposalId must be a valid UUID',
        );

        expect(
          queryMock,
        ).not.toHaveBeenCalled();

        expect(
          transactionMock,
        ).not.toHaveBeenCalled();
      },
    );
  },
);