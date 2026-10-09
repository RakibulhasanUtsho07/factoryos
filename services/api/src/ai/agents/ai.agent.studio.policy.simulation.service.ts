import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { isUUID } from 'class-validator';

import type { QueryResultRow } from 'pg';

import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../database/database.service';
import {
  IamService,
} from '../../iam/iam.service';
import {
  PolicyService,
} from '../../policy/policy.service';

import type {
  AiAgentStudioHistoricalEvent,
  AiAgentStudioPolicySimulationCaseResult,
  AiAgentStudioPolicySimulationResult,
} from './ai.agent.studio.policy.simulation.types';

interface SandboxRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  factory_id: string;
  mode: 'SIMULATION';
  live_write_allowed: false;
  status:
    | 'CREATED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'BLOCKED';
}

interface SimulationRunRow extends QueryResultRow {
  id: string;
  sandbox_id: string;
  status: 'COMPLETED' | 'BLOCKED';
  plan: unknown;
  simulated_tool_responses: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  result: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  created_by: string | null;
  trace_id: string | null;
  created_at: string;
}

@Injectable()
export class AiAgentStudioPolicySimulationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly policyService: PolicyService,
    private readonly auditService: AuditService,
  ) {}

  async simulateHistoricalPolicies(
    tenantId: string,
    factoryId: string,
    actorUserId: string,
    sandboxId: string,
    traceId: string,
    events: AiAgentStudioHistoricalEvent[],
  ): Promise<AiAgentStudioPolicySimulationResult> {
    this.requiredUuid(tenantId, 'tenantId');
    this.requiredUuid(factoryId, 'factoryId');
    this.requiredUuid(actorUserId, 'actorUserId');
    this.requiredUuid(sandboxId, 'sandboxId');
    this.requiredUuid(traceId, 'traceId');

    await this.iamService.authorize(
      actorUserId,
      tenantId,
      'ai.agents.write',
      factoryId,
    );

    const normalizedEvents =
      this.normalizeEvents(events);

    const sandbox =
      await this.getSandbox(
        tenantId,
        factoryId,
        sandboxId,
      );

    if (!sandbox) {
      throw new NotFoundException(
        'Agent Studio sandbox not found',
      );
    }

    if (
      sandbox.mode !== 'SIMULATION' ||
      sandbox.live_write_allowed !== false
    ) {
      throw new ForbiddenException(
        'Policy simulation requires a simulation-only sandbox',
      );
    }

    const cases: AiAgentStudioPolicySimulationCaseResult[] = [];

    for (const event of normalizedEvents) {
      const evaluation =
        await this.policyService.evaluatePolicy(
          tenantId,
          {
            action: event.action,
            resourceType:
              event.resourceType,
            attributes:
              event.attributes ?? {},
            effectiveAt:
              event.effectiveAt,
          },
        );

      const policyRef =
        evaluation.risk.policyRef;

      cases.push({
        eventKey: event.eventKey,
        action: event.action,
        resourceType:
          event.resourceType ?? null,
        effectiveAt:
          event.effectiveAt,
        expectedOutcome:
          event.expectedOutcome ?? null,
        actualOutcome:
          evaluation.outcome,
        matchedExpectedOutcome:
          event.expectedOutcome === undefined
            ? null
            : event.expectedOutcome ===
              evaluation.outcome,
        policyId:
          policyRef?.id ?? null,
        policyKey:
          policyRef?.key ?? null,
        policyVersion:
          policyRef?.version ?? null,
        riskClass:
          evaluation.risk.class,
        approvalRequired:
          evaluation.risk.approvalRequired,
        safeDefault:
          evaluation.safeDefault,
        reason:
          evaluation.reason,
      });
    }

    const allowedCount =
      cases.filter(
        (item) =>
          item.actualOutcome === 'ALLOWED',
      ).length;

    const approvalRequiredCount =
      cases.filter(
        (item) =>
          item.actualOutcome ===
          'APPROVAL_REQUIRED',
      ).length;

    const deniedCount =
      cases.filter(
        (item) =>
          item.actualOutcome === 'DENIED',
      ).length;

    const expectedCases =
      cases.filter(
        (item) =>
          item.matchedExpectedOutcome !==
          null,
      );

    const expectedOutcomeMatches =
      expectedCases.filter(
        (item) =>
          item.matchedExpectedOutcome ===
          true,
      ).length;

    const expectedOutcomeDriftCount =
      expectedCases.filter(
        (item) =>
          item.matchedExpectedOutcome ===
          false,
      ).length;

    const allExpectedOutcomesMatched =
      expectedOutcomeDriftCount === 0;

    const allCasesNonDenied =
      deniedCount === 0;

    const recommendation =
      expectedOutcomeDriftCount > 0
        ? 'POLICY_DRIFT_DETECTED'
        : deniedCount > 0
          ? 'DENIED_CASES_PRESENT'
          : 'READY_FOR_REVIEW';

    const status: 'COMPLETED' | 'BLOCKED' =
      expectedOutcomeDriftCount > 0 ||
      deniedCount > 0
        ? 'BLOCKED'
        : 'COMPLETED';

    const plan = normalizedEvents.map(
      (event, index) => ({
        stepKey: `policy-case-${index + 1}`,
        toolId:
          'AI.AGENT_STUDIO.POLICY_SIMULATION',
        toolVersion: '1.0.0',
        actionType:
          'POLICY.EVALUATE.HISTORICAL',
        input: {
          eventKey: event.eventKey,
          action: event.action,
          resourceType:
            event.resourceType ?? null,
          effectiveAt:
            event.effectiveAt,
        },
      }),
    );

    const observations =
      cases.map(
        (item, index) => ({
          stepIndex: index,
          eventKey: item.eventKey,
          actualOutcome:
            item.actualOutcome,
          expectedOutcome:
            item.expectedOutcome,
          matchedExpectedOutcome:
            item.matchedExpectedOutcome,
          policyId:
            item.policyId,
          policyKey:
            item.policyKey,
          policyVersion:
            item.policyVersion,
          riskClass:
            item.riskClass,
          approvalRequired:
            item.approvalRequired,
          safeDefault:
            item.safeDefault,
          liveExecution: false,
          liveWriteAllowed: false,
          networkAccess: 'NONE',
          credentialsAccess: 'NONE',
        }),
      );

    const resultPayload = {
      kind: 'POLICY_SIMULATION',
      status,
      eventCount: cases.length,
      allowedCount,
      approvalRequiredCount,
      deniedCount,
      expectedOutcomeMatches,
      expectedOutcomeDriftCount,
      allExpectedOutcomesMatched,
      allCasesNonDenied,
      recommendation,
      liveExecution: false,
      liveWriteAllowed: false,
      networkAccess: 'NONE',
      credentialsAccess: 'NONE',
      cases,
    };

    const persisted =
      await this.database.transaction(
        async (client) => {
          const insert =
            await client.query<SimulationRunRow>(
              `
              INSERT INTO simulation_runs (
                tenant_id,
                factory_id,
                sandbox_id,
                parent_run_id,
                mode,
                status,
                plan,
                simulated_tool_responses,
                observations,
                result,
                finished_at,
                created_by,
                trace_id
              )
              VALUES (
                $1,
                $2,
                $3,
                NULL,
                'SIMULATION',
                $4,
                $5::jsonb,
                $6::jsonb,
                $7::jsonb,
                $8::jsonb,
                NOW(),
                $9,
                $10
              )
              RETURNING
                id::text AS id,
                sandbox_id::text AS sandbox_id,
                status,
                plan,
                simulated_tool_responses,
                observations,
                result,
                started_at::text AS started_at,
                finished_at::text AS finished_at,
                created_by::text AS created_by,
                trace_id::text AS trace_id,
                created_at::text AS created_at
              `,
              [
                tenantId,
                factoryId,
                sandboxId,
                status,
                JSON.stringify(plan),
                JSON.stringify(
                  Object.fromEntries(
                    cases.map((item) => [
                      item.eventKey,
                      {
                        outcome:
                          item.actualOutcome,
                        policyId:
                          item.policyId,
                        policyKey:
                          item.policyKey,
                        policyVersion:
                          item.policyVersion,
                      },
                    ]),
                  ),
                ),
                JSON.stringify(observations),
                JSON.stringify(resultPayload),
                actorUserId,
                traceId,
              ],
            );

          const row = insert.rows[0];

          if (!row) {
            throw new BadRequestException(
              'AI policy simulation run insert returned no row',
            );
          }

          return row;
        },
        {
          tenantId,
          userId: actorUserId,
        },
      );

    const result: AiAgentStudioPolicySimulationResult = {
      status,
      sandboxId,
      simulationRunId:
        persisted.id,
      eventCount: cases.length,
      allowedCount,
      approvalRequiredCount,
      deniedCount,
      expectedOutcomeMatches,
      expectedOutcomeDriftCount,
      allExpectedOutcomesMatched,
      allCasesNonDenied,
      recommendation,
      cases,
    };

    await this.safeAudit({
      tenantId,
      factoryId,
      actorUserId,
      resourceId: persisted.id,
      payload: {
        sandboxId,
        eventCount: cases.length,
        status,
        recommendation,
        expectedOutcomeDriftCount,
        deniedCount,
        liveExecution: false,
      },
    });

    return result;
  }

  private async getSandbox(
    tenantId: string,
    factoryId: string,
    sandboxId: string,
  ): Promise<SandboxRow | null> {
    const result =
      await this.database.query<SandboxRow>(
        `
        SELECT
          id::text AS id,
          tenant_id::text AS tenant_id,
          factory_id::text AS factory_id,
          mode,
          live_write_allowed,
          status
        FROM agent_sandboxes
        WHERE
          id = $1
          AND tenant_id = $2
          AND factory_id = $3
        LIMIT 1
        `,
        [
          sandboxId,
          tenantId,
          factoryId,
        ],
        {
          tenantId,
        },
      );

    return result.rows[0] ?? null;
  }

  private normalizeEvents(
    events: AiAgentStudioHistoricalEvent[],
  ): AiAgentStudioHistoricalEvent[] {
    if (!Array.isArray(events)) {
      throw new BadRequestException(
        'historical events are required',
      );
    }

    if (
      events.length === 0 ||
      events.length > 100
    ) {
      throw new BadRequestException(
        'historical_events must contain between 1 and 100 events',
      );
    }

    return events.map(
      (event, index) => {
        if (
          !event ||
          typeof event !== 'object'
        ) {
          throw new BadRequestException(
            `historical_events[${index}] must be an object`,
          );
        }

        const eventKey =
          this.requiredString(
            event.eventKey,
            `historical_events[${index}].eventKey`,
            200,
          );

        const action =
          this.requiredString(
            event.action,
            `historical_events[${index}].action`,
            200,
          );

        const resourceType =
          event.resourceType ===
            undefined ||
          event.resourceType === null
            ? null
            : this.requiredString(
                event.resourceType,
                `historical_events[${index}].resourceType`,
                150,
              );

        const effectiveAt =
          this.requiredDate(
            event.effectiveAt,
            `historical_events[${index}].effectiveAt`,
          );

        const expectedOutcome =
          event.expectedOutcome;

        if (
          expectedOutcome !==
            undefined &&
          ![
            'ALLOWED',
            'APPROVAL_REQUIRED',
            'DENIED',
          ].includes(
            expectedOutcome,
          )
        ) {
          throw new BadRequestException(
            `historical_events[${index}].expectedOutcome is invalid`,
          );
        }

        return {
          eventKey,
          action,
          resourceType,
          attributes:
            this.normalizeObject(
              event.attributes,
              `historical_events[${index}].attributes`,
            ) ?? {},
          effectiveAt,
          ...(expectedOutcome !==
          undefined
            ? { expectedOutcome }
            : {}),
        };
      },
    );
  }

  private requiredDate(
    value: unknown,
    field: string,
  ): string {
    if (
      typeof value !== 'string' ||
      Number.isNaN(
        new Date(value).getTime(),
      )
    ) {
      throw new BadRequestException(
        `${field} must be a valid ISO date`,
      );
    }

    return new Date(value).toISOString();
  }

  private normalizeObject(
    value: unknown,
    field: string,
  ): Record<string, unknown> {
    if (
      value === undefined ||
      value === null
    ) {
      return {};
    }

    if (
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      throw new BadRequestException(
        `${field} must be an object`,
      );
    }

    return value as Record<string, unknown>;
  }

  private requiredString(
    value: unknown,
    field: string,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    const normalized =
      value.trim();

    if (!normalized) {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    if (
      normalized.length >
      maxLength
    ) {
      throw new BadRequestException(
        `${field} must not exceed ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private requiredUuid(
    value: unknown,
    field: string,
  ): string {
    if (
      typeof value !== 'string' ||
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }

    return value;
  }

  private async safeAudit(input: {
    tenantId: string;
    factoryId: string;
    actorUserId: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.auditService.record({
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        actorUserId: input.actorUserId,
        eventType:
          'AI_AGENT_STUDIO_POLICY_SIMULATION',
        action: 'SIMULATE_HISTORICAL_POLICY',
        resourceType:
          'AI_AGENT_STUDIO_POLICY_SIMULATION',
        resourceId: input.resourceId,
        correlationId: null,
        requestId: null,
        dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The simulation result remains authoritative if audit storage fails.
    }
  }
}
