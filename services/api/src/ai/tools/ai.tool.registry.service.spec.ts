
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import {
  jest,
} from '@jest/globals';

import {
  AiToolRegistryService,
} from './ai.tool.registry.service';

describe(
  'AiToolRegistryService',
  () => {
    const tenantId =
      'faaab63d-c447-46ce-950d-deebdd7f5f30';

    const factoryId =
      '6fa03a36-6e3e-45ff-8f48-9ce3e2af0001';

    const database = {
      query: jest.fn<
        (
          ...args: unknown[]
        ) => Promise<{
          rows: Record<string, unknown>[];
        }>
      >(),
    };

    let registry:
      AiToolRegistryService;

    function buildRow(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        id:
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',

        tenant_id:
          null,

        factory_id:
          null,

        tool_id:
          'AI.RUNTIME.NOOP',

        version:
          '1.0.0',

        input_schema: {
          type:
            'object',

          additionalProperties:
            true,
        },

        output_schema: {
          type:
            'object',

          required: [
            'execution',
            'executorType',
            'actionType',
            'committed',
          ],

          properties: {
            execution: {
              type:
                'string',
            },

            executorType: {
              type:
                'string',
            },

            actionType: {
              type:
                'string',
            },

            committed: {
              type:
                'boolean',
            },
          },

          additionalProperties:
            true,
        },

        risk_class:
          'L0',

        required_scopes: [
          'ai.actions.execute',
        ],

        approval_mode:
          'none',

        write_capable:
          false,

        idempotency_required:
          false,

        timeout_ms:
          1000,

        audit_mode:
          'REDACTED',

        rollback: {
          type:
            'NONE',
        },

        status:
          'ACTIVE',

        metadata: {},

        created_by:
          null,

        created_at:
          '2026-10-09T00:00:00.000Z',

        updated_at:
          '2026-10-09T00:00:00.000Z',

        ...overrides,
      };
    }

    beforeEach(
      () => {
        jest.resetAllMocks();

        registry =
          new AiToolRegistryService(
            database as never,
          );
      },
    );

    it(
      'resolves an active tool using normalized identifiers and tenant RLS context',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow(),
          ],
        });

        const tool =
          await registry.getTool(
            tenantId,
            factoryId,
            ' AI.RUNTIME.NOOP ',
            ' 1.0.0 ',
          );

        expect(
          tool.toolId,
        ).toBe(
          'AI.RUNTIME.NOOP',
        );

        expect(
          tool.version,
        ).toBe(
          '1.0.0',
        );

        const call =
          database.query.mock.calls[0];

        const sql =
          String(
            call?.[0] ?? '',
          ).replace(
            /\s+/g,
            ' ',
          );

        expect(
          call?.[1],
        ).toEqual([
          'AI.RUNTIME.NOOP',
          '1.0.0',
          tenantId,
          factoryId,
        ]);

        expect(
          call?.[2],
        ).toEqual({
          tenantId,
        });

        expect(
          sql,
        ).toContain(
          "t.status = 'ACTIVE'",
        );
      },
    );

    it(
      'preserves factory, tenant, then global lookup precedence',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow(),
          ],
        });

        await registry.getTool(
          tenantId,
          factoryId,
          'AI.RUNTIME.NOOP',
          '1.0.0',
        );

        const call =
          database.query.mock.calls[0];

        const sql =
          String(
            call?.[0] ?? '',
          ).replace(
            /\s+/g,
            ' ',
          );

        const factoryRank =
          sql.indexOf(
            'WHEN t.tenant_id = $3 AND t.factory_id = $4 THEN 1',
          );

        const tenantRank =
          sql.indexOf(
            'WHEN t.tenant_id = $3 AND t.factory_id IS NULL THEN 2',
          );

        const globalRank =
          sql.indexOf(
            'WHEN t.tenant_id IS NULL AND t.factory_id IS NULL THEN 3',
          );

        expect(
          factoryRank,
        ).toBeGreaterThanOrEqual(
          0,
        );

        expect(
          tenantRank,
        ).toBeGreaterThan(
          factoryRank,
        );

        expect(
          globalRank,
        ).toBeGreaterThan(
          tenantRank,
        );
      },
    );

    it(
      'rejects malformed tenant identifiers before querying the database',
      async () => {
        await expect(
          registry.getTool(
            'not-a-uuid',
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(
          database.query,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'rejects malformed factory identifiers before querying the database',
      async () => {
        await expect(
          registry.getTool(
            tenantId,
            'not-a-uuid',
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(
          database.query,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'returns not found when no active matching tool exists',
      async () => {
        database.query.mockResolvedValue({
          rows: [],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'MISSING.TOOL',
            '1.0.0',
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it(
      'rejects a missing rollback type without throwing a raw TypeError',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              rollback: {},
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI tool rollback definition is invalid',
        );
      },
    );

    it(
      'rejects unsupported rollback types',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              rollback: {
                type:
                  'UNSUPPORTED',
              },
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI tool rollback definition is invalid',
        );
      },
    );

    it(
      'rejects write-capable tools without idempotency',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              write_capable:
                true,

              idempotency_required:
                false,

              rollback: {
                type:
                  'COMPENSATION',
              },
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI write-capable tool must require idempotency',
        );
      },
    );

    it(
      'rejects write-capable tools with NONE rollback',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              write_capable:
                true,

              idempotency_required:
                true,

              rollback: {
                type:
                  'NONE',
              },
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI write-capable tool must define rollback',
        );
      },
    );

    it(
      'rejects whitespace-padded required scopes',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              required_scopes: [
                ' ai.actions.execute ',
              ],
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI tool required scopes must contain non-empty, trimmed strings',
        );
      },
    );

    it(
      'rejects invalid timeout values',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              timeout_ms:
                70000,
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI tool timeout is outside the supported bounded range',
        );
      },
    );

    it(
      'rejects non-object metadata',
      async () => {
        database.query.mockResolvedValue({
          rows: [
            buildRow({
              metadata: [
                'unexpected',
              ],
            }),
          ],
        });

        await expect(
          registry.getTool(
            tenantId,
            factoryId,
            'AI.RUNTIME.NOOP',
            '1.0.0',
          ),
        ).rejects.toThrow(
          'AI tool metadata must be an object',
        );
      },
    );
  },
);