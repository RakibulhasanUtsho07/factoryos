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
  CbbPromotionService,
} from './cbb.promotion.service';

type TestQueryResult = {
  rows: QueryResultRow[];
};

type TestQueryMock =
  jest.MockedFunction<
    (
      text: string,
      values?: unknown[],
    ) => Promise<TestQueryResult>
  >;

interface TestClient {
  query:
    PoolClient['query'];
}

type TestTransactionImplementation =
  <
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
  'CbbPromotionService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const factoryId =
      '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';

    const userId =
      '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

    const blueprintId =
      'b0000000-0000-4000-8000-000000000001';

    const sourceVersionId =
      'c0000000-0000-4000-8000-000000000001';

    const promotedVersionId =
      'd0000000-0000-4000-8000-000000000001';

    const entityId =
      'e0000000-0000-4000-8000-000000000001';

    const relationId =
      'f0000000-0000-4000-8000-000000000001';

    const proposalId =
      'a0000000-0000-4000-8000-000000000001';

    let service:
      CbbPromotionService;

    beforeEach(
      () => {
        jest.clearAllMocks();

        service =
          new CbbPromotionService(
            database as never,
            auditService as never,
          );
      },
    );

    // ==========================================================
    // SUCCESSFUL PROMOTION
    // ==========================================================

    it(
      'creates a new immutable version and promotes the blueprint pointer',
      async () => {
        let currentVersion =
          1;

        queryMock.mockImplementation(
          async (
            text,
          ) => {
            const sql =
              text.toLowerCase();

            if (
              sql.includes(
                'from business_change_proposals cp',
              )
            ) {
              return {
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
                      sourceVersionId,

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
                      'VERIFIED',

                    proposed_payload:
                      {
                        description:
                          'Updated production department',
                      },

                    status:
                      'APPROVED',

                    reason:
                      'Approved business correction',

                    requested_by:
                      userId,

                    decided_by:
                      userId,

                    requested_at:
                      '2026-10-07T00:00:00.000Z',

                    decided_at:
                      '2026-10-07T01:00:00.000Z',

                    decision_reason:
                      'Reviewed',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'from business_blueprints b',
              )
            ) {
              return {
                rows: [
                  {
                    id:
                      blueprintId,

                    tenant_id:
                      tenantId,

                    factory_id:
                      factoryId,

                    current_version_id:
                      sourceVersionId,

                    status:
                      'ACTIVE',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'from business_blueprint_versions v',
              ) &&
              sql.includes(
                'for share',
              )
            ) {
              return {
                rows: [
                  {
                    id:
                      sourceVersionId,

                    tenant_id:
                      tenantId,

                    factory_id:
                      factoryId,

                    blueprint_id:
                      blueprintId,

                    version:
                      '1',

                    graph_hash:
                      'source-hash',

                    evidence_count:
                      1,

                    readiness_score:
                      '0.75',

                    status:
                      'ACTIVE',

                    change_reason:
                      'Initial',

                    created_by:
                      null,

                    created_at:
                      '2026-10-07T00:00:00.000Z',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'from business_entities e',
              )
            ) {
              return {
                rows: [
                  {
                    id:
                      entityId,

                    tenant_id:
                      tenantId,

                    factory_id:
                      factoryId,

                    blueprint_version_id:
                      sourceVersionId,

                    entity_type:
                      'DEPARTMENT',

                    name:
                      'Production',

                    description:
                      'Old description',

                    state:
                      'VERIFIED',

                    confidence:
                      '0.99',

                    metadata:
                      {
                        source:
                          'test',
                      },

                    created_by:
                      userId,

                    created_at:
                      '2026-10-07T00:00:00.000Z',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'from business_relations r',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'from business_processes p',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'from business_process_steps ps',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'from business_rules r',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'from business_terms t',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'from business_exceptions e',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'from business_evidence_links l',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'coalesce',
              ) &&
              sql.includes(
                'max(v.version)',
              )
            ) {
              return {
                rows: [
                  {
                    next_version:
                      '2',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'insert into business_blueprint_versions',
              )
            ) {
              return {
                rows: [
                  {
                    id:
                      promotedVersionId,

                    tenant_id:
                      tenantId,

                    factory_id:
                      factoryId,

                    blueprint_id:
                      blueprintId,

                    version:
                      '2',

                    graph_hash:
                      'generated-graph-hash',

                    evidence_count:
                      1,

                    readiness_score:
                      '0.75',

                    status:
                      'ACTIVE',

                    change_reason:
                      'Promoted UPDATE_DESCRIPTION: from version 1: Approved business correction',

                    created_by:
                      userId,

                    created_at:
                      '2026-10-07T02:00:00.000Z',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'insert into business_entities',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_processes',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_process_steps',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_relations',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_rules',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_terms',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_exceptions',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'insert into business_evidence_links',
              )
            ) {
              return {
                rows: [],
              };
            }

            if (
              sql.includes(
                'update business_blueprints',
              )
            ) {
              currentVersion =
                2;

              return {
                rows: [
                  {
                    id:
                      blueprintId,

                    current_version_id:
                      promotedVersionId,

                    status:
                      'ACTIVE',
                  },
                ],
              };
            }

            if (
              sql.includes(
                'update business_change_proposals',
              )
            ) {
              return {
                rows: [
                  {
                    id:
                      proposalId,

                    status:
                      'APPROVED',

                    promoted_version_id:
                      promotedVersionId,

                    promoted_at:
                      '2026-10-07T02:00:01.000Z',
                  },
                ],
              };
            }

            throw new Error(
              `Unexpected SQL in promotion unit test: ${text}`,
            );
          },
        );

        const result =
          await service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            proposalId,
          );

        expect(
          result.idempotent,
        ).toBe(
          false,
        );

        expect(
          result.sourceVersion.id,
        ).toBe(
          sourceVersionId,
        );

        expect(
          result.sourceVersion.version,
        ).toBe(
          1,
        );

        expect(
          result.promotedVersion.id,
        ).toBe(
          promotedVersionId,
        );

        expect(
          result.promotedVersion.version,
        ).toBe(
          2,
        );

        expect(
          result.promotedVersion.status,
        ).toBe(
          'ACTIVE',
        );

        expect(
          result.proposal.status,
        ).toBe(
          'APPROVED',
        );

        expect(
          result.proposal.promotedVersionId,
        ).toBe(
          promotedVersionId,
        );

        expect(
          currentVersion,
        ).toBe(
          2,
        );

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

        const sqlCalls =
          queryMock.mock.calls.map(
            (
              call,
            ) =>
              call[0]
                .toLowerCase(),
          );

        expect(
          sqlCalls.some(
            (
              sql,
            ) =>
              sql.includes(
                'update business_entities',
              ) ||
              sql.includes(
                'delete from business_entities',
              ) ||
              sql.includes(
                'update business_blueprint_versions',
              ) ||
              sql.includes(
                'delete from business_blueprint_versions',
              ),
          ),
        ).toBe(
          false,
        );
      },
    );

    // ==========================================================
    // STALE PROPOSAL
    // ==========================================================

    it(
      'rejects promotion when the blueprint has already advanced',
      async () => {
        queryMock
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
                  sourceVersionId,

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
                  'VERIFIED',

                proposed_payload:
                  {},

                status:
                  'APPROVED',

                reason:
                  'Approved',

                requested_by:
                  userId,

                decided_by:
                  userId,

                requested_at:
                  '2026-10-07T00:00:00.000Z',

                decided_at:
                  '2026-10-07T01:00:00.000Z',

                decision_reason:
                  'Reviewed',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  blueprintId,

                tenant_id:
                  tenantId,

                factory_id:
                  factoryId,

                current_version_id:
                  promotedVersionId,

                status:
                  'ACTIVE',
              },
            ],
          });

        await expect(
          service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            proposalId,
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
    // LEGACY PROPOSAL
    // ==========================================================

    it(
      'rejects an approved legacy proposal without source_version_id',
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
                null,

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
                'VERIFIED',

              proposed_payload:
                {},

              status:
                'APPROVED',

              reason:
                'Legacy',

              requested_by:
                userId,

              decided_by:
                userId,

              requested_at:
                '2026-10-07T00:00:00.000Z',

              decided_at:
                '2026-10-07T01:00:00.000Z',

              decision_reason:
                'Reviewed',
            },
          ],
        });

        await expect(
          service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            proposalId,
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
    // NOT APPROVED
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
                sourceVersionId,

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
                'VERIFIED',

              proposed_payload:
                {},

              status:
                'PENDING',

              reason:
                'Pending',

              requested_by:
                userId,

              decided_by:
                null,

              requested_at:
                '2026-10-07T00:00:00.000Z',

              decided_at:
                null,

              decision_reason:
                null,
            },
          ],
        });

        await expect(
          service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            proposalId,
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
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
    // MISSING PROPOSAL
    // ==========================================================

    it(
      'returns not found for a missing proposal',
      async () => {
        queryMock.mockResolvedValueOnce({
          rows: [],
        });

        await expect(
          service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            proposalId,
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );

        expect(
          auditRecordMock,
        ).not.toHaveBeenCalled();
      },
    );

    // ==========================================================
    // INVALID UUID
    // ==========================================================

    it(
      'rejects an invalid proposal UUID before touching the database',
      async () => {
        await expect(
          service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            'not-a-uuid',
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

        expect(
          auditRecordMock,
        ).not.toHaveBeenCalled();
      },
    );

    // ==========================================================
    // ALREADY PROMOTED
    // ==========================================================

    it(
      'returns the existing promoted version on replay',
      async () => {
        queryMock
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
                  sourceVersionId,

                promoted_version_id:
                  promotedVersionId,

                promoted_at:
                  '2026-10-07T02:00:01.000Z',

                target_type:
                  'ENTITY',

                target_id:
                  entityId,

                proposal_type:
                  'UPDATE_DESCRIPTION',

                proposed_state:
                  'VERIFIED',

                proposed_payload:
                  {
                    description:
                      'Already promoted',
                  },

                status:
                  'APPROVED',

                reason:
                  'Approved',

                requested_by:
                  userId,

                decided_by:
                  userId,

                requested_at:
                  '2026-10-07T00:00:00.000Z',

                decided_at:
                  '2026-10-07T01:00:00.000Z',

                decision_reason:
                  'Reviewed',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  promotedVersionId,

                tenant_id:
                  tenantId,

                factory_id:
                  factoryId,

                blueprint_id:
                  blueprintId,

                version:
                  '2',

                graph_hash:
                  'existing-hash',

                evidence_count:
                  1,

                readiness_score:
                  '0.75',

                status:
                  'ACTIVE',

                change_reason:
                  'Previous promotion',

                created_by:
                  userId,

                created_at:
                  '2026-10-07T02:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                version:
                  '1',
              },
            ],
          });

        const result =
          await service.promoteApprovedChange(
            tenantId,
            factoryId,
            userId,
            proposalId,
          );

        expect(
          result.idempotent,
        ).toBe(
          true,
        );

        expect(
          result.promotedVersion.id,
        ).toBe(
          promotedVersionId,
        );

        expect(
          result.promotedVersion.version,
        ).toBe(
          2,
        );

        expect(
          result.promotedVersion.graphHash,
        ).toBe(
          'existing-hash',
        );

        expect(
          result.proposal.promotedVersionId,
        ).toBe(
          promotedVersionId,
        );

        expect(
          auditRecordMock,
        ).toHaveBeenCalledTimes(
          1,
        );
      },
    );
  },
);