import {
  jest,
} from '@jest/globals';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import type {
  DatabaseContext,
} from '../database/database.service';

import type {
  QueryResultRow,
  PoolClient,
} from 'pg';

import {
  AiRuntimeService,
} from './ai.runtime.service';

const tenantId =
  'faaab63d-c447-46ce-950d-deebdd7f5f30';
const factoryId =
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const userId =
  '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const requestId =
  '6f1a1111-1111-4111-8111-111111111111';
const traceId =
  '6f1a2222-2222-4222-8222-222222222222';
const decisionId =
  '6f1a3333-3333-4333-8333-333333333333';
const contextPackageId =
  '6f1a4444-4444-4444-8444-444444444444';
const verificationId =
  '6f1a5555-5555-4555-8555-555555555555';

const databaseQueryMock = jest.fn<
  (
    text: string,
    values?: unknown[],
  ) => Promise<{
    rows: QueryResultRow[];
  }>
>();

const databaseTransactionMock =
  jest.fn(
    async function <T>(
      callback: (
        client: {
          query: PoolClient['query'];
        },
      ) => Promise<T>,
      _context?: DatabaseContext,
    ): Promise<T> {
      return callback({
        query:
          databaseQueryMock as unknown as PoolClient['query'],
      });
    },
  );

const database = {
  query: databaseQueryMock,
  transaction: databaseTransactionMock,
};

const auditRecordMock =
  jest.fn<(input: unknown) => Promise<void>>();

const auditService = {
  record: auditRecordMock,
};

const authorizeMock =
  jest.fn<(
    userId: string,
    tenantId: string,
    permissionCode: string,
    factoryId?: string | null,
  ) => Promise<void>>();

const iamService = {
  authorize: authorizeMock,
};

const evaluatePolicyMock =
  jest.fn();

const policyService = {
  evaluatePolicy: evaluatePolicyMock,
};

const getBusinessModelMock =
  jest.fn();

const cbbService = {
  getBusinessModel:
    getBusinessModelMock,
};

const aiToolRegistry = {
  getTool: jest.fn(),
};

const aiToolGateway = {
  execute: jest.fn(),
};

describe(
  'AiRuntimeService',
  () => {
    let service: AiRuntimeService;

    beforeEach(() => {
      jest.clearAllMocks();

      service =
        new AiRuntimeService(
          database as never,
          auditService as never,
          iamService as never,
          policyService as never,
          cbbService as never,
          aiToolRegistry as never,
          aiToolGateway as never,
        );
    });

    it(
      'creates a decision envelope with verified factory scope',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: decisionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              request_id: requestId,
              trace_id: traceId,
              actor_id: userId,
              objective: 'Explain order delay',
              reasoning_mode: 'HYPOTHESIS',
              context_version: null,
              risk_class: null,
              output_state: 'ANSWER',
              metadata: {},
              created_at: '2026-10-07T00:00:00.000Z',
              updated_at: '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        const result =
          await service.createDecision(
            tenantId,
            factoryId,
            userId,
            requestId,
            traceId,
            {
              objective:
                'Explain order delay',
              reasoning_mode:
                'HYPOTHESIS',
              output_state:
                'ANSWER',
            },
          );

        expect(
          result.idempotent,
        ).toBe(false);
        expect(
          result.decision.id,
        ).toBe(decisionId);
        expect(
          databaseTransactionMock,
        ).toHaveBeenCalledTimes(1);
        expect(
          auditRecordMock,
        ).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'returns an existing decision as idempotent replay for the same trace',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [
            {
              id: decisionId,
              tenant_id: tenantId,
              factory_id: factoryId,
              request_id: requestId,
              trace_id: traceId,
              actor_id: userId,
              objective: 'Existing',
              reasoning_mode: 'FACT',
              context_version: 'cbb-2',
              risk_class: null,
              output_state: 'ANSWER',
              metadata: {},
              created_at: '2026-10-07T00:00:00.000Z',
              updated_at: '2026-10-07T00:00:00.000Z',
            },
          ],
        });

        const result =
          await service.createDecision(
            tenantId,
            factoryId,
            userId,
            requestId,
            traceId,
            {
              objective:
                'Different retry body',
              reasoning_mode:
                'HYPOTHESIS',
              output_state:
                'ANSWER',
            },
          );

        expect(
          result.idempotent,
        ).toBe(true);
        expect(
          result.decision.objective,
        ).toBe('Existing');
        expect(
          databaseQueryMock,
        ).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'rejects an invalid decision scope before database access',
      async () => {
        await expect(
          service.createDecision(
            tenantId,
            'not-a-factory',
            userId,
            requestId,
            traceId,
            {
              objective: 'x',
              reasoning_mode: 'FACT',
              output_state: 'ANSWER',
            },
          ),
        ).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(
          databaseQueryMock,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'resolves a permission-scoped context package from CBB and evidence',
      async () => {
        getBusinessModelMock.mockResolvedValue({
          tenantId,
          factoryId,
          currentVersion: {
            id: 'cbb-version-1',
            version: '1',
            graphHash: 'hash',
            readinessScore: 0.8,
          },
          counts: {
            entities: 2,
            relations: 1,
            processes: 1,
            processSteps: 2,
            rules: 0,
            terms: 0,
            exceptions: 0,
            evidence: 1,
            pendingChangeProposals: 0,
            openConflicts: 0,
          },
        });

        databaseQueryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id: decisionId,
                tenant_id: tenantId,
                factory_id: factoryId,
                request_id: requestId,
                trace_id: traceId,
                actor_id: userId,
                objective: 'Explain order delay',
                reasoning_mode: 'HYPOTHESIS',
                context_version: null,
                risk_class: null,
                output_state: 'ANSWER',
                metadata: {},
                created_at: '2026-10-07T00:00:00.000Z',
                updated_at: '2026-10-07T00:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: 'evidence-id',
                source_type: 'SOP',
                source_ref: 'sop-1',
                source_timestamp: '2026-10-07T00:00:00.000Z',
                evidence_grade: 'A',
                confidence: '0.99',
                state: 'VERIFIED',
                content_hash: 'hash',
                visibility: 'INTERNAL',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: contextPackageId,
                tenant_id: tenantId,
                factory_id: factoryId,
                decision_id: decisionId,
                context_version: 'cbb-1',
                sources: [],
                permissions: [
                  'ai.context.read',
                  'ai.business.read',
                ],
                freshness: {},
                evidence_states: [
                  'VERIFIED',
                  'INFERRED',
                ],
                package_hash:
                  'a'.repeat(64),
                created_at: '2026-10-07T00:01:00.000Z',
              },
            ],
          });

        const result =
          await service.resolveContext(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
            },
          );

        expect(
          authorizeMock,
        ).toHaveBeenCalledWith(
          userId,
          tenantId,
          'ai.business.read',
          factoryId,
        );
        expect(
          result.contextPackage.id,
        ).toBe(contextPackageId);
        expect(
          result.contextPackage.packageHash,
        ).toHaveLength(64);
      },
    );

    it(
      'rejects context resolution when the decision is missing',
      async () => {
        databaseQueryMock.mockResolvedValueOnce({
          rows: [],
        });

        await expect(
          service.resolveContext(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
            },
          ),
        ).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it(
      'blocks verification when open conflicts exist',
      async () => {
        databaseQueryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id: decisionId,
                tenant_id: tenantId,
                factory_id: factoryId,
                request_id: requestId,
                trace_id: traceId,
                actor_id: userId,
                objective: 'Explain order delay',
                reasoning_mode: 'HYPOTHESIS',
                context_version: 'cbb-1',
                risk_class: null,
                output_state: 'ANSWER',
                metadata: {},
                created_at: '2026-10-07T00:00:00.000Z',
                updated_at: '2026-10-07T00:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: contextPackageId,
                tenant_id: tenantId,
                factory_id: factoryId,
                decision_id: decisionId,
                context_version: 'cbb-1',
                sources: [
                  {
                    type: 'BUSINESS_EVIDENCE',
                  },
                ],
                permissions: [],
                freshness: {},
                evidence_states: [
                  'VERIFIED',
                ],
                package_hash:
                  'a'.repeat(64),
                created_at: '2026-10-07T00:01:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: 'conflict-id',
                subject_type: 'PROCESS',
                subject_id: 'subject-id',
                status: 'OPEN',
                description: 'Conflict',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: verificationId,
                status: 'BLOCKED',
                created_at:
                  '2026-10-07T00:02:00.000Z',
              },
            ],
          });

        const result =
          await service.verifyDecision(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
              context_package_id:
                contextPackageId,
            },
          );

        expect(
          result.verification.status,
        ).toBe('BLOCKED');
        expect(
          result.verification.contradictions,
        ).toHaveLength(1);
      },
    );

    it(
      'marks policy verification as review-required when policy requires approval',
      async () => {
        databaseQueryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id: decisionId,
                tenant_id: tenantId,
                factory_id: factoryId,
                request_id: requestId,
                trace_id: traceId,
                actor_id: userId,
                objective: 'Review plan change',
                reasoning_mode: 'ACTION_PROPOSAL',
                context_version: 'cbb-1',
                risk_class: 'L2',
                output_state: 'ACTION_PROPOSAL',
                metadata: {},
                created_at: '2026-10-07T00:00:00.000Z',
                updated_at: '2026-10-07T00:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: contextPackageId,
                tenant_id: tenantId,
                factory_id: factoryId,
                decision_id: decisionId,
                context_version: 'cbb-1',
                sources: [
                  {
                    type: 'BUSINESS_EVIDENCE',
                  },
                ],
                permissions: [],
                freshness: {},
                evidence_states: [
                  'VERIFIED',
                ],
                package_hash:
                  'a'.repeat(64),
                created_at: '2026-10-07T00:01:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: verificationId,
                status: 'REVIEW_REQUIRED',
                created_at:
                  '2026-10-07T00:02:00.000Z',
              },
            ],
          });

        evaluatePolicyMock.mockResolvedValue({
          outcome: 'APPROVAL_REQUIRED',
          risk: {
            class: 'L2',
            policyRef: {
              id: 'policy-id',
              key: 'plan.change',
              version: '1',
            },
            approvalRequired: true,
          },
          policy: null,
          safeDefault: false,
          reason: 'POLICY_APPROVAL_REQUIRED',
        });

        const result =
          await service.verifyDecision(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
              context_package_id:
                contextPackageId,
              policy_action:
                'plan.change',
            },
          );

        expect(
          result.verification.status,
        ).toBe('REVIEW_REQUIRED');
        expect(
          result.verification.policyChecks.status,
        ).toBe('REVIEW_REQUIRED');
      },
    );

    it(
      'rejects verification when an explicit context package belongs to another decision',
      async () => {
        databaseQueryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id: decisionId,
                tenant_id: tenantId,
                factory_id: factoryId,
                request_id: requestId,
                trace_id: traceId,
                actor_id: userId,
                objective: 'x',
                reasoning_mode: 'FACT',
                context_version: 'cbb-1',
                risk_class: null,
                output_state: 'ANSWER',
                metadata: {},
                created_at: '2026-10-07T00:00:00.000Z',
                updated_at: '2026-10-07T00:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: contextPackageId,
                tenant_id: tenantId,
                factory_id: factoryId,
                decision_id: requestId,
                context_version: 'cbb-1',
                sources: [],
                permissions: [],
                freshness: {},
                evidence_states: ['VERIFIED'],
                package_hash: 'a'.repeat(64),
                created_at: '2026-10-07T00:01:00.000Z',
              },
            ],
          });

        await expect(
          service.verifyDecision(
            tenantId,
            factoryId,
            userId,
            {
              decision_id: decisionId,
              context_package_id: contextPackageId,
            },
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(
          databaseQueryMock,
        ).toHaveBeenCalledTimes(2);
      },
    );

    it(
      'rejects a decision verification without context',
      async () => {
        databaseQueryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id: decisionId,
                tenant_id: tenantId,
                factory_id: factoryId,
                request_id: requestId,
                trace_id: traceId,
                actor_id: userId,
                objective: 'x',
                reasoning_mode: 'FACT',
                context_version: null,
                risk_class: null,
                output_state: 'ANSWER',
                metadata: {},
                created_at: '2026-10-07T00:00:00.000Z',
                updated_at: '2026-10-07T00:00:00.000Z',
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [],
          });

        await expect(
          service.verifyDecision(
            tenantId,
            factoryId,
            userId,
            {
              decision_id:
                decisionId,
            },
          ),
        ).rejects.toBeInstanceOf(
          ConflictException,
        );
      },
    );
  },
);
