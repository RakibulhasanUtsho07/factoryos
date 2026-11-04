import { jest } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AiAgentRuntimeService } from './ai.agent.runtime.service';

const tenantId = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';

describe('AiAgentRuntimeService.listTasks', () => {
  const database = {
    query: jest.fn<() => Promise<unknown>>(),
  };
  const auditService = {
    record: jest.fn<() => Promise<string>>(),
  };
  const iamService = {
    authorize: jest.fn<() => Promise<void>>(),
  };
  const aiRuntimeService = {
    authorizeAction: jest.fn<() => Promise<unknown>>(),
    executeAgentAction: jest.fn<() => Promise<unknown>>(),
  };
  const catalogue = {
    assertToolEntitled: jest.fn<() => Promise<unknown>>(),
  };
  const toolRegistry = {
    getTool: jest.fn<() => Promise<unknown>>(),
  };

  let service: AiAgentRuntimeService;

  beforeEach(() => {
    jest.clearAllMocks();
    database.query.mockResolvedValue({ rows: [] });
    iamService.authorize.mockResolvedValue(undefined);
    service = new AiAgentRuntimeService(
      database as never,
      auditService as never,
      iamService as never,
      aiRuntimeService as never,
      catalogue as never,
      toolRegistry as never,
    );
  });

  it('returns only recent tasks from the authenticated tenant/factory scope', async () => {
    const result = await service.listTasks(tenantId, factoryId, userId, 25);

    expect(result).toEqual({ items: [], limit: 25, count: 0 });
    expect(iamService.authorize).toHaveBeenCalledWith(
      userId, tenantId, 'ai.business.read', factoryId,
    );
    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, values, context] = database.query.mock.calls[0] as unknown as [
      string, unknown[], Record<string, unknown>,
    ];
    expect(sql).toContain('FROM agent_tasks');
    expect(sql).toContain('NULL::text AS idempotency_key');
    expect(sql).not.toContain('planner_attestation');
    expect(sql).not.toContain('request_hash');
    expect(sql).toContain('WHERE tenant_id = $1');
    expect(sql).toContain('AND factory_id = $2');
    expect(sql).toContain('ORDER BY updated_at DESC');
    expect(sql).toContain('LIMIT $3');
    expect(values).toEqual([tenantId, factoryId, 25]);
    expect(context).toEqual({ tenantId, userId });
  });

  it('rejects non-integer, zero and out-of-range list limits before authorization or SQL', async () => {
    for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        service.listTasks(tenantId, factoryId, userId, limit),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(iamService.authorize).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('does not query task rows when the caller lacks read permission', async () => {
    const denial = new ForbiddenException('Denied');
    iamService.authorize.mockRejectedValue(denial);

    await expect(
      service.listTasks(tenantId, factoryId, userId, 50),
    ).rejects.toBe(denial);
    expect(database.query).not.toHaveBeenCalled();
  });
});
