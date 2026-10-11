import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';

import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../database/database.service';
import { IamService } from '../../iam/iam.service';

export type AiAgentEvaluationCaseKind = 'EXPECTED_TOOL_CALL' | 'EXPECTED_REFUSAL';
export type AiAgentEvaluationStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface CreateAiAgentEvaluationCaseInput {
  caseKey: string;
  version: number;
  name: string;
  description?: string | null;
  kind: AiAgentEvaluationCaseKind;
  expectedToolId?: string | null;
  expectedToolVersion?: string | null;
  expectedActionType?: string | null;
  expectedInputSubset?: Record<string, unknown>;
  expectedRefusalReasonContains?: string | null;
  status?: 'ACTIVE' | 'DISABLED';
}

interface EvaluationCaseRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; agent_definition_id: string;
  agent_id: string; agent_version: string; case_key: string;
  case_version: number | string; name: string; description: string | null;
  kind: AiAgentEvaluationCaseKind; expected_tool_id: string | null;
  expected_tool_version: string | null; expected_action_type: string | null;
  expected_input_subset: Record<string, unknown>;
  expected_refusal_reason_contains: string | null;
  status: 'ACTIVE' | 'DISABLED'; created_by: string | null; created_at: string;
}
interface SimulationRow extends QueryResultRow {
  id: string; sandbox_id: string; status: 'COMPLETED' | 'FAILED' | 'BLOCKED';
  plan: Array<Record<string, unknown>>;
  simulated_tool_responses: Record<string, unknown>;
  observations: Array<Record<string, unknown>>;
  result: Record<string, unknown>;
  sandbox_agent_id: string; sandbox_agent_version: string;
  sandbox_mode: string; live_write_allowed: boolean; created_at: string;
}
interface EvaluationResultRow extends QueryResultRow {
  id: string; tenant_id: string; factory_id: string; case_id: string;
  simulation_run_id: string; sandbox_id: string; status: AiAgentEvaluationStatus;
  expected_summary: Record<string, unknown>; observed_summary: Record<string, unknown>;
  created_by: string | null; created_at: string;
}

const REFUSAL_WORDS = /\b(refus(?:e|ed|al)?|den(?:y|ied|ial)|reject(?:ed)?|forbidden|not authorized|not permitted|unauthorized)\b/i;
const SENSITIVE_INPUT_KEY = /(password|secret|token|credential|authorization|api[_-]?key|private[_-]?key)/i;

@Injectable()
export class AiAgentEvaluationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly iamService: IamService,
    private readonly auditService: AuditService,
  ) {}

  async createCase(tenantId: string, factoryId: string, actorUserId: string, agentDefinitionId: string, input: CreateAiAgentEvaluationCaseInput) {
    await this.authorizeWrite(tenantId, factoryId, actorUserId);
    this.validateUuid(agentDefinitionId, 'agentDefinitionId');
    const definition = await this.loadDefinition(tenantId, factoryId, agentDefinitionId, actorUserId);
    const normalized = this.normalizeCase(input);

    try {
      const query = [
        'INSERT INTO ai_agent_evaluation_cases (tenant_id,factory_id,agent_definition_id,case_key,case_version,name,description,kind,expected_tool_id,expected_tool_version,expected_action_type,expected_input_subset,expected_refusal_reason_contains,status,created_by)',
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)',
        'RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,',
        'agent_definition_id::text AS agent_definition_id,$16::text AS agent_id,$17::text AS agent_version,',
        'case_key,case_version,name,description,kind,expected_tool_id,expected_tool_version,expected_action_type,',
        'expected_input_subset,expected_refusal_reason_contains,status,created_by::text AS created_by,created_at::text AS created_at',
      ].join('\n');
      const result = await this.database.query<EvaluationCaseRow>(
        query,
        [
          tenantId, factoryId, agentDefinitionId, normalized.caseKey, normalized.version,
          normalized.name, normalized.description, normalized.kind, normalized.expectedToolId,
          normalized.expectedToolVersion, normalized.expectedActionType,
          JSON.stringify(normalized.expectedInputSubset), normalized.expectedRefusalReasonContains,
          normalized.status, actorUserId, definition.agent_id, definition.version,
        ],
        { tenantId, userId: actorUserId },
      );
      const row = result.rows[0];
      if (!row) throw new BadRequestException('AI agent evaluation case insert returned no row');
      const mapped = this.mapCase(row);
      await this.safeAudit({
        tenantId, factoryId, actorUserId, action: 'CREATE_EVALUATION_CASE',
        resourceType: 'AI_AGENT_EVALUATION_CASE', resourceId: mapped.id,
        payload: { agentDefinitionId, caseKey: mapped.caseKey, version: mapped.version, kind: mapped.kind, status: mapped.status },
      });
      return mapped;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('AI evaluation case version already exists: ' + normalized.caseKey + '@' + normalized.version);
      }
      throw error;
    }
  }

  async listCases(tenantId: string, factoryId: string, actorUserId: string, agentDefinitionId: string) {
    await this.authorizeRead(tenantId, factoryId, actorUserId);
    this.validateUuid(agentDefinitionId, 'agentDefinitionId');
    await this.loadDefinition(tenantId, factoryId, agentDefinitionId, actorUserId);
    const query = [
      'SELECT DISTINCT ON (c.case_key) c.id::text AS id,c.tenant_id::text AS tenant_id,',
      'c.factory_id::text AS factory_id,c.agent_definition_id::text AS agent_definition_id,',
      'd.agent_id,d.version AS agent_version,c.case_key,c.case_version,c.name,c.description,c.kind,',
      'c.expected_tool_id,c.expected_tool_version,c.expected_action_type,c.expected_input_subset,',
      'c.expected_refusal_reason_contains,c.status,c.created_by::text AS created_by,c.created_at::text AS created_at',
      'FROM ai_agent_evaluation_cases c JOIN ai_agent_definitions d ON d.id=c.agent_definition_id',
      'AND d.tenant_id=c.tenant_id AND d.factory_id=c.factory_id',
      'WHERE c.tenant_id=$1 AND c.factory_id=$2 AND c.agent_definition_id=$3',
      'ORDER BY c.case_key,c.case_version DESC',
    ].join('\n');
    const result = await this.database.query<EvaluationCaseRow>(
      query, [tenantId, factoryId, agentDefinitionId], { tenantId, userId: actorUserId },
    );
    return { agentDefinitionId, items: result.rows.map((row) => this.mapCase(row)), count: result.rows.length };
  }

  async evaluateCase(tenantId: string, factoryId: string, actorUserId: string, agentDefinitionId: string, caseId: string, simulationRunId: string) {
    await this.authorizeWrite(tenantId, factoryId, actorUserId);
    this.validateUuid(agentDefinitionId, 'agentDefinitionId');
    this.validateUuid(caseId, 'caseId');
    this.validateUuid(simulationRunId, 'simulationRunId');

    const caseQuery = [
      'SELECT c.id::text AS id,c.tenant_id::text AS tenant_id,c.factory_id::text AS factory_id,',
      'c.agent_definition_id::text AS agent_definition_id,d.agent_id,d.version AS agent_version,',
      'c.case_key,c.case_version,c.name,c.description,c.kind,c.expected_tool_id,c.expected_tool_version,',
      'c.expected_action_type,c.expected_input_subset,c.expected_refusal_reason_contains,c.status,',
      'c.created_by::text AS created_by,c.created_at::text AS created_at',
      'FROM ai_agent_evaluation_cases c JOIN ai_agent_definitions d ON d.id=c.agent_definition_id',
      'AND d.tenant_id=c.tenant_id AND d.factory_id=c.factory_id',
      'WHERE c.id=$1 AND c.tenant_id=$2 AND c.factory_id=$3 AND c.agent_definition_id=$4 LIMIT 1',
    ].join('\n');
    const caseResult = await this.database.query<EvaluationCaseRow>(
      caseQuery, [caseId, tenantId, factoryId, agentDefinitionId], { tenantId, userId: actorUserId },
    );
    const testCase = caseResult.rows[0];
    if (!testCase) throw new NotFoundException('AI agent evaluation case not found');
    if (testCase.status !== 'ACTIVE') throw new ConflictException('Only active AI agent evaluation cases can be evaluated');

    const runQuery = [
      'SELECT r.id::text AS id,r.sandbox_id::text AS sandbox_id,r.status,r.plan,',
      'r.simulated_tool_responses,r.observations,r.result,s.agent_spec->>\'agentId\' AS sandbox_agent_id,',
      's.agent_spec->>\'version\' AS sandbox_agent_version,s.mode AS sandbox_mode,',
      's.live_write_allowed,r.created_at::text AS created_at',
      'FROM simulation_runs r JOIN agent_sandboxes s ON s.id=r.sandbox_id AND s.tenant_id=r.tenant_id AND s.factory_id=r.factory_id',
      'WHERE r.id=$1 AND r.tenant_id=$2 AND r.factory_id=$3 AND r.mode=\'SIMULATION\' LIMIT 1',
    ].join('\n');
    const runResult = await this.database.query<SimulationRow>(
      runQuery, [simulationRunId, tenantId, factoryId], { tenantId, userId: actorUserId },
    );
    const run = runResult.rows[0];
    if (!run) throw new NotFoundException('Simulation run not found in this factory scope');
    if (run.sandbox_mode !== 'SIMULATION' || run.live_write_allowed !== false ||
        run.sandbox_agent_id !== testCase.agent_id || run.sandbox_agent_version !== testCase.agent_version) {
      throw new ForbiddenException('Evaluation run must belong to a simulation-only sandbox for this exact agent version');
    }

    const priorQuery = [
      'SELECT id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,',
      'case_id::text AS case_id,simulation_run_id::text AS simulation_run_id,sandbox_id::text AS sandbox_id,',
      'status,expected_summary,observed_summary,created_by::text AS created_by,created_at::text AS created_at',
      'FROM ai_agent_evaluation_results WHERE tenant_id=$1 AND factory_id=$2 AND case_id=$3 AND simulation_run_id=$4 LIMIT 1',
    ].join('\n');
    const prior = await this.database.query<EvaluationResultRow>(
      priorQuery, [tenantId, factoryId, caseId, simulationRunId], { tenantId, userId: actorUserId },
    );
    if (prior.rows[0]) return this.mapResult(prior.rows[0]);

    const evaluated = this.compareCaseToRun(testCase, run);
    const expectedSummary = this.expectedSummary(testCase);
    const insertedQuery = [
      'INSERT INTO ai_agent_evaluation_results (tenant_id,factory_id,case_id,simulation_run_id,sandbox_id,status,expected_summary,observed_summary,created_by)',
      'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)',
      'RETURNING id::text AS id,tenant_id::text AS tenant_id,factory_id::text AS factory_id,',
      'case_id::text AS case_id,simulation_run_id::text AS simulation_run_id,sandbox_id::text AS sandbox_id,',
      'status,expected_summary,observed_summary,created_by::text AS created_by,created_at::text AS created_at',
    ].join('\n');
    const inserted = await this.database.query<EvaluationResultRow>(
      insertedQuery,
      [tenantId, factoryId, caseId, simulationRunId, run.sandbox_id, evaluated.status,
        JSON.stringify(expectedSummary), JSON.stringify(evaluated.observedSummary), actorUserId],
      { tenantId, userId: actorUserId },
    );
    const row = inserted.rows[0];
    if (!row) throw new BadRequestException('AI agent evaluation result insert returned no row');
    const mapped = this.mapResult(row);
    await this.safeAudit({
      tenantId, factoryId, actorUserId, action: 'EVALUATE_AGENT_CASE',
      resourceType: 'AI_AGENT_EVALUATION_RESULT', resourceId: mapped.id,
      payload: { agentDefinitionId, caseId, simulationRunId, status: mapped.status },
    });
    return mapped;
  }

  async getReport(tenantId: string, factoryId: string, actorUserId: string, agentDefinitionId: string) {
    await this.authorizeRead(tenantId, factoryId, actorUserId);
    this.validateUuid(agentDefinitionId, 'agentDefinitionId');
    await this.loadDefinition(tenantId, factoryId, agentDefinitionId, actorUserId);
    const query = [
      'WITH latest_cases AS (',
      'SELECT DISTINCT ON (c.case_key) c.id,c.case_key,c.case_version,c.name,c.kind,c.status',
      'FROM ai_agent_evaluation_cases c WHERE c.tenant_id=$1 AND c.factory_id=$2 AND c.agent_definition_id=$3',
      'ORDER BY c.case_key,c.case_version DESC)',
      'SELECT c.id::text AS case_id,c.case_key,c.case_version,c.name,c.kind,c.status AS case_status,',
      'COUNT(e.id)::text AS evaluation_count,COUNT(e.id) FILTER (WHERE e.status=\'PASS\')::text AS pass_count,',
      'COUNT(e.id) FILTER (WHERE e.status=\'FAIL\')::text AS fail_count,',
      'COUNT(e.id) FILTER (WHERE e.status=\'INCONCLUSIVE\')::text AS inconclusive_count,',
      '(SELECT e2.status FROM ai_agent_evaluation_results e2 WHERE e2.case_id=c.id AND e2.tenant_id=$1 AND e2.factory_id=$2 ORDER BY e2.created_at DESC LIMIT 1) AS latest_status,',
      'MAX(e.created_at)::text AS last_evaluated_at',
      'FROM latest_cases c LEFT JOIN ai_agent_evaluation_results e ON e.case_id=c.id AND e.tenant_id=$1 AND e.factory_id=$2',
      'GROUP BY c.id,c.case_key,c.case_version,c.name,c.kind,c.status ORDER BY c.case_key',
    ].join('\n');
    const result = await this.database.query<{
      case_id: string; case_key: string; case_version: number | string; name: string;
      kind: AiAgentEvaluationCaseKind; case_status: 'ACTIVE' | 'DISABLED';
      evaluation_count: string | number; pass_count: string | number; fail_count: string | number;
      inconclusive_count: string | number; latest_status: AiAgentEvaluationStatus | null; last_evaluated_at: string | null;
    }>(query, [tenantId, factoryId, agentDefinitionId], { tenantId, userId: actorUserId });

    const cases = result.rows.map((row) => ({
      caseId: row.case_id, caseKey: row.case_key, version: Number(row.case_version),
      name: row.name, kind: row.kind, status: row.case_status,
      evaluationCount: Number(row.evaluation_count), passCount: Number(row.pass_count),
      failCount: Number(row.fail_count), inconclusiveCount: Number(row.inconclusive_count),
      latestStatus: row.latest_status, lastEvaluatedAt: row.last_evaluated_at,
    }));
    const summary = cases.reduce((acc, item) => ({
      caseCount: acc.caseCount + (item.status === 'ACTIVE' ? 1 : 0),
      evaluationCount: acc.evaluationCount + item.evaluationCount,
      passCount: acc.passCount + item.passCount,
      failCount: acc.failCount + item.failCount,
      inconclusiveCount: acc.inconclusiveCount + item.inconclusiveCount,
    }), { caseCount: 0, evaluationCount: 0, passCount: 0, failCount: 0, inconclusiveCount: 0 });
    const conclusiveCount = summary.passCount + summary.failCount;
    return {
      agentDefinitionId,
      summary: {
        ...summary,
        passRatePercent: conclusiveCount === 0 ? null : Math.round((summary.passCount / conclusiveCount) * 10000) / 100,
      },
      cases,
    };
  }

  private compareCaseToRun(testCase: EvaluationCaseRow, run: SimulationRow) {
    const steps = Array.isArray(run.plan) ? run.plan : [];
    const observations = Array.isArray(run.observations) ? run.observations : [];
    const matchingSteps = testCase.kind === 'EXPECTED_REFUSAL' && !testCase.expected_tool_id
      ? []
      : steps.map((step, index) => ({ step, index }))
          .filter(({ step }) => this.matchesExpectedTool(testCase, step));

    if (testCase.kind === 'EXPECTED_TOOL_CALL') {
      if (run.status !== 'COMPLETED') {
        return {
          status: 'INCONCLUSIVE' as const,
          observedSummary: {
            runStatus: run.status, observedCallCount: matchingSteps.length,
            matchingStepIndices: matchingSteps.map((item) => item.index),
            reason: 'The sandbox run did not complete; expected calls cannot be conclusively assessed',
          },
        };
      }
      return {
        status: matchingSteps.length > 0 ? 'PASS' as const : 'FAIL' as const,
        observedSummary: {
          runStatus: run.status, observedCallCount: matchingSteps.length,
          matchingStepIndices: matchingSteps.map((item) => item.index),
          completedObservations: observations.length,
        },
      };
    }

    const refusal = this.findRefusalEvidence({ result: run.result ?? {}, observations });
    const forbiddenCallObserved = matchingSteps.length > 0;
    const reasonMatched = !testCase.expected_refusal_reason_contains ||
      refusal.texts.some((value) => value.toLowerCase().includes(testCase.expected_refusal_reason_contains!.toLowerCase()));
    let status: AiAgentEvaluationStatus;
    if (refusal.found) status = !forbiddenCallObserved && reasonMatched ? 'PASS' : 'FAIL';
    else status = run.status === 'COMPLETED' ? 'FAIL' : 'INCONCLUSIVE';

    return {
      status,
      observedSummary: {
        runStatus: run.status, refusalObserved: refusal.found,
        refusalSignalPaths: refusal.paths, refusalReasonMatched: reasonMatched,
        forbiddenCallObserved, forbiddenCallCount: matchingSteps.length,
      },
    };
  }

  private matchesExpectedTool(testCase: EvaluationCaseRow, step: Record<string, unknown>) {
    if (testCase.expected_tool_id && step.toolId !== testCase.expected_tool_id) return false;
    if (testCase.expected_tool_version && step.toolVersion !== testCase.expected_tool_version) return false;
    if (testCase.expected_action_type && step.actionType !== testCase.expected_action_type) return false;
    if (testCase.expected_input_subset && !this.matchesSubset(this.asObject(step.input), testCase.expected_input_subset)) return false;
    return true;
  }

  private matchesSubset(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
    return Object.entries(expected).every(([key, expectedValue]) => {
      const actualValue = actual[key];
      if (expectedValue && typeof expectedValue === 'object' && !Array.isArray(expectedValue)) {
        return actualValue !== null && typeof actualValue === 'object' && !Array.isArray(actualValue) &&
          this.matchesSubset(actualValue as Record<string, unknown>, expectedValue as Record<string, unknown>);
      }
      return JSON.stringify(actualValue) === JSON.stringify(expectedValue);
    });
  }

  private findRefusalEvidence(root: Record<string, unknown>) {
    const paths: string[] = [];
    const texts: string[] = [];
    let nodeCount = 0;
    const visit = (value: unknown, path: string, depth: number) => {
      nodeCount += 1;
      if (nodeCount > 10000 || depth > 12 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, path + '[' + index + ']', depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? path + '.' + key : key;
        const lowerKey = key.toLowerCase();
        if (['refused', 'denied', 'rejected'].includes(lowerKey) && child === true) {
          paths.push(childPath); texts.push(key);
        }
        if (['refusal', 'refusal_reason', 'refusalreason', 'denial_reason', 'denialreason'].includes(lowerKey) &&
            typeof child === 'string' && child.trim().length > 0) {
          paths.push(childPath); texts.push(child);
        }
        if (['authorizationstatus', 'authorization_status', 'outcome', 'status'].includes(lowerKey) &&
            typeof child === 'string' && ['REFUSED', 'DENIED', 'REJECTED'].includes(child.trim().toUpperCase())) {
          paths.push(childPath); texts.push(child);
        }
        if (['reason', 'error', 'message'].includes(lowerKey) && typeof child === 'string' && REFUSAL_WORDS.test(child)) {
          paths.push(childPath); texts.push(child);
        }
        visit(child, childPath, depth + 1);
      }
    };
    visit(root, '', 0);
    return { found: paths.length > 0, paths: [...new Set(paths)], texts };
  }

  private expectedSummary(testCase: EvaluationCaseRow) {
    return {
      caseKey: testCase.case_key, caseVersion: Number(testCase.case_version),
      kind: testCase.kind,
      expectedTool: testCase.expected_tool_id ? testCase.expected_tool_id + '@' + testCase.expected_tool_version : null,
      expectedActionType: testCase.expected_action_type,
      expectedRefusalReasonContains: testCase.expected_refusal_reason_contains,
    };
  }

  private normalizeCase(input: CreateAiAgentEvaluationCaseInput) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Evaluation case input is required');
    if (input.kind !== 'EXPECTED_TOOL_CALL' && input.kind !== 'EXPECTED_REFUSAL') {
      throw new BadRequestException('kind must be EXPECTED_TOOL_CALL or EXPECTED_REFUSAL');
    }
    const caseKey = this.requiredString(input.caseKey, 'caseKey', 160);
    if (!Number.isInteger(input.version) || input.version < 1 || input.version > 1000000) {
      throw new BadRequestException('version must be a positive integer');
    }
    const name = this.requiredString(input.name, 'name', 200);
    const description = input.description === undefined || input.description === null
      ? null : this.requiredString(input.description, 'description', 2000);
    const expectedToolId = input.expectedToolId === undefined || input.expectedToolId === null
      ? null : this.requiredString(input.expectedToolId, 'expectedToolId', 200);
    const expectedToolVersion = input.expectedToolVersion === undefined || input.expectedToolVersion === null
      ? null : this.requiredString(input.expectedToolVersion, 'expectedToolVersion', 100);
    const expectedActionType = input.expectedActionType === undefined || input.expectedActionType === null
      ? null : this.requiredString(input.expectedActionType, 'expectedActionType', 200);
    const expectedRefusalReasonContains = input.expectedRefusalReasonContains === undefined || input.expectedRefusalReasonContains === null
      ? null : this.requiredString(input.expectedRefusalReasonContains, 'expectedRefusalReasonContains', 300);
    const expectedInputSubset = this.asObject(input.expectedInputSubset ?? {});
    this.assertNoSecrets(expectedInputSubset, 'expectedInputSubset');
    if ((expectedToolId === null) !== (expectedToolVersion === null)) {
      throw new BadRequestException('expectedToolId and expectedToolVersion must be supplied together');
    }
    if (input.kind === 'EXPECTED_TOOL_CALL' && expectedToolId === null) {
      throw new BadRequestException('EXPECTED_TOOL_CALL requires expectedToolId and expectedToolVersion');
    }
    if (input.kind === 'EXPECTED_REFUSAL' && expectedToolId === null && expectedRefusalReasonContains === null) {
      throw new BadRequestException('EXPECTED_REFUSAL requires a forbidden tool reference or refusal reason');
    }
    if (!['ACTIVE', 'DISABLED'].includes(input.status ?? 'ACTIVE')) {
      throw new BadRequestException('status must be ACTIVE or DISABLED');
    }
    return {
      caseKey, version: input.version, name, description, kind: input.kind,
      expectedToolId, expectedToolVersion, expectedActionType, expectedInputSubset,
      expectedRefusalReasonContains, status: input.status ?? 'ACTIVE',
    };
  }

  private assertNoSecrets(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.assertNoSecrets(item, path + '[' + index + ']'));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_INPUT_KEY.test(key)) throw new BadRequestException(path + ' must not contain secret-like field: ' + key);
        this.assertNoSecrets(child, path + '.' + key);
      }
    }
  }

  private async loadDefinition(tenantId: string, factoryId: string, definitionId: string, actorUserId: string) {
    const result = await this.database.query<{ id: string; agent_id: string; version: string; status: string }>(
      'SELECT id::text AS id,agent_id,version,status FROM ai_agent_definitions WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 LIMIT 1',
      [definitionId, tenantId, factoryId],
      { tenantId, userId: actorUserId },
    );
    const definition = result.rows[0];
    if (!definition) throw new NotFoundException('AI agent definition not found');
    return definition;
  }

  private mapCase(row: EvaluationCaseRow) {
    return {
      id: row.id, tenantId: row.tenant_id, factoryId: row.factory_id,
      agentDefinitionId: row.agent_definition_id, agentId: row.agent_id, agentVersion: row.agent_version,
      caseKey: row.case_key, version: Number(row.case_version), name: row.name, description: row.description,
      kind: row.kind, expectedToolId: row.expected_tool_id, expectedToolVersion: row.expected_tool_version,
      expectedActionType: row.expected_action_type, expectedInputSubset: row.expected_input_subset ?? {},
      expectedRefusalReasonContains: row.expected_refusal_reason_contains, status: row.status,
      createdBy: row.created_by, createdAt: row.created_at,
    };
  }

  private mapResult(row: EvaluationResultRow) {
    return {
      id: row.id, tenantId: row.tenant_id, factoryId: row.factory_id,
      caseId: row.case_id, simulationRunId: row.simulation_run_id, sandboxId: row.sandbox_id,
      status: row.status, expectedSummary: row.expected_summary, observedSummary: row.observed_summary,
      createdBy: row.created_by, createdAt: row.created_at,
    };
  }

  private async authorizeRead(tenantId: string, factoryId: string, actorUserId: string) {
    this.validateUuid(tenantId, 'tenantId'); this.validateUuid(factoryId, 'factoryId'); this.validateUuid(actorUserId, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'ai.agents.read', factoryId);
  }
  private async authorizeWrite(tenantId: string, factoryId: string, actorUserId: string) {
    this.validateUuid(tenantId, 'tenantId'); this.validateUuid(factoryId, 'factoryId'); this.validateUuid(actorUserId, 'actorUserId');
    await this.iamService.authorize(actorUserId, tenantId, 'ai.agents.write', factoryId);
  }
  private validateUuid(value: string, field: string) {
    if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
  }
  private requiredString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(field + ' is required');
    const normalized = value.trim();
    if (!normalized) throw new BadRequestException(field + ' is required');
    if (normalized.length > maxLength) throw new BadRequestException(field + ' must not exceed ' + maxLength + ' characters');
    return normalized;
  }
  private asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('expectedInputSubset must be an object');
    return value as Record<string, unknown>;
  }
  private async safeAudit(input: { tenantId: string; factoryId: string; actorUserId: string; action: string; resourceType: string; resourceId: string; payload: Record<string, unknown> }) {
    try {
      await this.auditService.record({
        tenantId: input.tenantId, factoryId: input.factoryId, actorUserId: input.actorUserId,
        eventType: 'AI_AGENT_EVALUATION', action: input.action, resourceType: input.resourceType,
        resourceId: input.resourceId, correlationId: null, requestId: null, dataClass: 'INTERNAL',
        payload: input.payload,
      });
    } catch {
      // The immutable evaluation record remains authoritative when audit persistence fails.
    }
  }
  private isUniqueViolation(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code?: string }).code === '23505';
  }
}
