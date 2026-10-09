import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

import { jest } from '@jest/globals';

import {
  AiAgentStudioDraftService,
} from './ai.agent.studio.draft.service';

describe('AiAgentStudioDraftService', () => {
  const tenantId =
    '10000000-0000-4000-8000-000000000001';
  const factoryId =
    '20000000-0000-4000-8000-000000000002';
  const userId =
    '30000000-0000-4000-8000-000000000003';
  const draftId =
    '40000000-0000-4000-8000-000000000004';
  const rowId =
    '50000000-0000-4000-8000-000000000005';

  const database = {
    query: jest.fn(),
  };

  const iamService = {
    authorize: jest.fn(),
  };

  const auditService = {
    record: jest.fn(),
  };

  let service: AiAgentStudioDraftService;

  beforeEach(() => {
    jest.clearAllMocks();

    database.query.mockResolvedValue({
      rows: [],
    });

    iamService.authorize.mockResolvedValue(undefined);

    auditService.record.mockResolvedValue(undefined);

    service =
      new AiAgentStudioDraftService(
        database as never,
        iamService as never,
        auditService as never,
      );
  });

  function draftRow(overrides = {}) {
    return {
      id: rowId,
      draft_id: draftId,
      version: 1,
      tenant_id: tenantId,
      factory_id: factoryId,
      source_prompt:
        'Create a quality triage assistant for defect review',
      title:
        'Create a quality triage assistant for defect review',
      goal:
        'Create a quality triage assistant for defect review',
      capability:
        'Quality workflow assistance',
      typical_output:
        'A reviewable quality investigation and containment workflow',
      authority:
        'Draft-only. No permission grant, tool entitlement, token issuance, or live write authority.',
      risk_ceiling: 'L1',
      requested_scopes: [],
      proposed_tools: [],
      generated_spec: {
        agentId:
          'draft-create-a-quality-triage-assistant-for-defect-review',
        version: '0.1.0-draft',
        name:
          'Create a quality triage assistant for defect review',
        goal:
          'Create a quality triage assistant for defect review',
        capability:
          'Quality workflow assistance',
        typicalOutput:
          'review',
        authority: 'draft-only',
        riskCeiling: 'L1',
        executionScopes: [],
        tools: [],
        memory: {},
        policies: {
          reviewRequired: true,
          directPermissionGrant: false,
        },
        prompts: {},
        completionCriteria: {},
      },
      validation: {
        schemaValid: true,
        permissionsGranted: 0,
        toolGrantsCreated: 0,
        publicationBlocked: true,
        reviewRequired: true,
        reasons: [],
      },
      status: 'DRAFT',
      review_notes: null,
      reviewed_by: null,
      reviewed_at: null,
      created_by: userId,
      created_at:
        '2026-10-08T00:00:00.000Z',
      ...overrides,
    };
  }

  it('creates a reviewable draft without granting permissions or tools', async () => {
    database.query.mockResolvedValueOnce({
      rows: [draftRow()],
    });

    const result =
      await service.createDraft(
        tenantId,
        factoryId,
        userId,
        {
          prompt:
            'Create a quality triage assistant for defect review',
        },
      );

    expect(result.status).toBe('DRAFT');
    expect(
      result.validation.publicationBlocked,
    ).toBe(true);
    expect(
      result.validation.permissionsGranted,
    ).toBe(0);
    expect(
      result.validation.toolGrantsCreated,
    ).toBe(0);
    expect(
      iamService.authorize,
    ).toHaveBeenCalledWith(
      userId,
      tenantId,
      'ai.agents.draft.write',
      factoryId,
    );
  });

  it('extracts tool and scope references as proposals, not entitlements', async () => {
    database.query.mockResolvedValueOnce({
      rows: [
        draftRow({
          requested_scopes: [
            'inventory.read',
          ],
          proposed_tools: [
            {
              toolId:
                'INVENTORY.GET',
              version: '1.0.0',
              reason:
                'Requested in natural-language draft input',
              requestedOnly: true,
            },
          ],
        }),
      ],
    });

    const result =
      await service.createDraft(
        tenantId,
        factoryId,
        userId,
        {
          prompt:
            'Plan inventory review using tool:INVENTORY.GET@1.0.0 scope:inventory.read',
        },
      );

    expect(
      result.proposedTools[0].requestedOnly,
    ).toBe(true);
    expect(
      result.validation.toolGrantsCreated,
    ).toBe(0);
  });

  it('rejects an empty prompt', async () => {
    await expect(
      service.createDraft(
        tenantId,
        factoryId,
        userId,
        {
          prompt: '   ',
        },
      ),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(database.query).not.toHaveBeenCalled();
  });

  it('reads only the latest draft version', async () => {
    database.query.mockResolvedValueOnce({
      rows: [
        draftRow({
          version: 2,
          status: 'READY_FOR_PUBLISH',
        }),
      ],
    });

    const result =
      await service.getLatestDraft(
        tenantId,
        factoryId,
        userId,
        draftId,
      );

    expect(result.version).toBe(2);
    expect(
      result.status,
    ).toBe('READY_FOR_PUBLISH');
  });

  it('lists latest draft versions only', async () => {
    database.query.mockResolvedValueOnce({
      rows: [
        draftRow(),
        draftRow({
          id:
            '60000000-0000-4000-8000-000000000006',
          draft_id:
            '70000000-0000-4000-8000-000000000007',
          version: 2,
          status:
            'READY_FOR_PUBLISH',
        }),
      ],
    });

    const result =
      await service.listDrafts(
        tenantId,
        factoryId,
        userId,
      );

    expect(result.count).toBe(2);
    expect(
      database.query,
    ).toHaveBeenCalled();
  });

  it('approves a draft by appending a READY_FOR_PUBLISH version', async () => {
    database.query
      .mockResolvedValueOnce({
        rows: [draftRow()],
      })
      .mockResolvedValueOnce({
        rows: [
          draftRow({
            id:
              '80000000-0000-4000-8000-000000000008',
            version: 2,
            status:
              'READY_FOR_PUBLISH',
            review_notes:
              'Approved for controlled follow-up',
            reviewed_by: userId,
            reviewed_at:
              '2026-10-08T00:00:00.000Z',
          }),
        ],
      });

    const result =
      await service.reviewDraft(
        tenantId,
        factoryId,
        userId,
        draftId,
        {
          decision: 'APPROVE',
          notes:
            'Approved for controlled follow-up',
        },
      );

    expect(
      result.status,
    ).toBe('READY_FOR_PUBLISH');
    expect(
      result.validation.publicationBlocked,
    ).toBe(true);
    expect(
      result.validation.permissionsGranted,
    ).toBe(0);
  });

  it('requires notes when rejecting a draft', async () => {
    await expect(
      service.reviewDraft(
        tenantId,
        factoryId,
        userId,
        draftId,
        {
          decision: 'REJECT',
        },
      ),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects review of a non-DRAFT version', async () => {
    database.query.mockResolvedValueOnce({
      rows: [
        draftRow({
          status:
            'READY_FOR_PUBLISH',
        }),
      ],
    });

    await expect(
      service.reviewDraft(
        tenantId,
        factoryId,
        userId,
        draftId,
        {
          decision: 'APPROVE',
        },
      ),
    ).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects malformed status filters', async () => {
    await expect(
      service.listDrafts(
        tenantId,
        factoryId,
        userId,
        'INVALID' as never,
      ),
    ).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
