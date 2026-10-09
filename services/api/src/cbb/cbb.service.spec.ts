import {
  jest,
} from '@jest/globals';

import {
  CbbService,
} from './cbb.service';

type QueryResultLike = {
  rows: Record<
    string,
    unknown
  >[];
};

describe(
  'CbbService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const factoryId =
      '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';

    const blueprintId =
      '7fa03a36-6e3e-45ff-8f48-9ce3e2af0002';

    const versionId =
      '8fa03a36-6e3e-45ff-8f48-9ce3e2af0003';

    const processId =
      '9fa03a36-4e3e-45ff-8f48-9ce3e2af0004';

    const database = {
      query:
        jest.fn<
          (
            ...args: unknown[]
          ) => Promise<QueryResultLike>
        >(),
    };

    let service:
      CbbService;

    beforeEach(
      () => {
        jest.clearAllMocks();

        service =
          new CbbService(
            database as never,
          );
      },
    );

    it(
      'returns the current blueprint summary for the authorized factory',
      async () => {
        database.query
          .mockResolvedValueOnce({
            rows: [
              {
                blueprint_id:
                  blueprintId,

                tenant_id:
                  tenantId,

                factory_id:
                  factoryId,

                blueprint_status:
                  'ACTIVE',

                current_version_id:
                  versionId,

                version:
                  '1',

                graph_hash:
                  null,

                evidence_count:
                  0,

                readiness_score:
                  '0',

                version_status:
                  'ACTIVE',

                change_reason:
                  'Initial CBB foundation version',

                version_created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                entities_count:
                  0,

                relations_count:
                  0,

                processes_count:
                  0,

                process_steps_count:
                  0,

                rules_count:
                  0,

                terms_count:
                  0,

                exceptions_count:
                  0,

                evidence_count:
                  0,

                pending_change_proposals_count:
                  0,

                open_conflicts_count:
                  0,
              },
            ],
          });

        const result =
          await service.getBusinessModel(
            tenantId,
            factoryId,
          );

        expect(
          database.query,
        ).toHaveBeenCalledTimes(
          2,
        );

        expect(
          result?.tenantId,
        ).toBe(
          tenantId,
        );

        expect(
          result?.factoryId,
        ).toBe(
          factoryId,
        );

        expect(
          result?.blueprint.id,
        ).toBe(
          blueprintId,
        );

        expect(
          result?.currentVersion.version,
        ).toBe(
          '1',
        );

        expect(
          result?.counts.entities,
        ).toBe(
          0,
        );
      },
    );

    it(
      'prefers VERIFIED entities and keeps INFERRED entities visibly labeled',
      async () => {
        database.query
          .mockResolvedValueOnce({
            rows: [
              {
                blueprint_id:
                  blueprintId,

                blueprint_status:
                  'ACTIVE',

                version_id:
                  versionId,

                version:
                  '1',

                graph_hash:
                  null,

                evidence_count:
                  0,

                readiness_score:
                  '0',

                version_status:
                  'ACTIVE',

                change_reason:
                  null,

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  'a0000000-0000-0000-0000-000000000001',

                entity_type:
                  'DEPARTMENT',

                name:
                  'Production',

                description:
                  null,

                state:
                  'VERIFIED',

                confidence:
                  '0.99',

                metadata:
                  {},

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },

              {
                id:
                  'a0000000-0000-0000-0000-000000000002',

                entity_type:
                  'DEPARTMENT',

                name:
                  'Planning',

                description:
                  null,

                state:
                  'INFERRED',

                confidence:
                  '0.72',

                metadata:
                  {},

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [],
          });

        const result =
          await service.getBusinessMap(
            tenantId,
            factoryId,
          );

        expect(
          result?.nodes,
        ).toHaveLength(
          2,
        );

        expect(
          result?.nodes[0]?.state,
        ).toBe(
          'VERIFIED',
        );

        expect(
          result?.nodes[1]?.state,
        ).toBe(
          'INFERRED',
        );

        expect(
          result?.nodes[1]?.inferred,
        ).toBe(
          true,
        );

        expect(
          result?.retrieval.excludedStates,
        ).toEqual([
          'PROPOSED',
          'CONFLICTING',
          'STALE',
        ]);
      },
    );

    it(
      'returns only verified or inferred processes for the current version',
      async () => {
        database.query
          .mockResolvedValueOnce({
            rows: [
              {
                blueprint_id:
                  blueprintId,

                blueprint_status:
                  'ACTIVE',

                version_id:
                  versionId,

                version:
                  '1',

                graph_hash:
                  null,

                evidence_count:
                  0,

                readiness_score:
                  '0',

                version_status:
                  'ACTIVE',

                change_reason:
                  null,

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  processId,

                name:
                  'Order Fulfillment',

                description:
                  'Fulfillment workflow',

                owner_ref:
                  'ops',

                state:
                  'VERIFIED',

                confidence:
                  '1',

                metadata:
                  {},

                step_count:
                  2,

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          });

        const result =
          await service.listProcesses(
            tenantId,
            factoryId,
          );

        expect(
          result?.count,
        ).toBe(
          1,
        );

        expect(
          result?.items[0]?.id,
        ).toBe(
          processId,
        );

        expect(
          result?.items[0]?.stepCount,
        ).toBe(
          2,
        );
      },
    );

    it(
      'returns a process with only visible process steps',
      async () => {
        database.query
          .mockResolvedValueOnce({
            rows: [
              {
                blueprint_id:
                  blueprintId,

                blueprint_status:
                  'ACTIVE',

                version_id:
                  versionId,

                version:
                  '1',

                graph_hash:
                  null,

                evidence_count:
                  0,

                readiness_score:
                  '0',

                version_status:
                  'ACTIVE',

                change_reason:
                  null,

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  processId,

                name:
                  'Order Fulfillment',

                description:
                  null,

                owner_ref:
                  'ops',

                state:
                  'VERIFIED',

                confidence:
                  '1',

                metadata:
                  {},

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          })

          .mockResolvedValueOnce({
            rows: [
              {
                id:
                  'b0000000-0000-0000-0000-000000000001',

                process_id:
                  processId,

                sequence_no:
                  1,

                name:
                  'Pick',

                description:
                  null,

                owner_ref:
                  'warehouse',

                inputs:
                  [],

                outputs:
                  [],

                state:
                  'VERIFIED',

                confidence:
                  '1',

                metadata:
                  {},

                created_at:
                  '2026-10-06T00:00:00.000Z',
              },
            ],
          });

        const result =
          await service.getProcess(
            tenantId,
            factoryId,
            processId,
          );

        expect(
          result?.process.id,
        ).toBe(
          processId,
        );

        expect(
          result?.steps,
        ).toHaveLength(
          1,
        );

        expect(
          result?.steps[0]?.sequence,
        ).toBe(
          1,
        );

        expect(
          result?.steps[0]?.inputs,
        ).toEqual([]);

        expect(
          result?.steps[0]?.outputs,
        ).toEqual([]);
      },
    );

    it(
      'returns null when no blueprint exists for the factory scope',
      async () => {
        database.query.mockResolvedValue({
          rows: [],
        });

        const result =
          await service.getBusinessModel(
            tenantId,
            factoryId,
          );

        expect(
          result,
        ).toBeNull();
      },
    );
  },
);