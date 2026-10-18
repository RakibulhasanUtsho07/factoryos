import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { OperationalDomain, OperationalCaseType } from './integration-reconciliation.store';

export interface ReconciliationScope {
  userId: string;
  tenantId: string;
  factoryId: string;
}

const DOMAINS: OperationalDomain[] = ['ATTENDANCE', 'PRODUCTION', 'QUALITY'];
const CASE_TYPES: OperationalCaseType[] = [
  'MISSING_EVENT_TIME',
  'INVALID_EVENT_TIME',
  'INVALID_SEQUENCE',
  'MISSING_SEQUENCE_RANGE',
  'SEQUENCE_COLLISION',
  'CROSS_SOURCE_CONFLICT',
  'CONFLICTING_DUPLICATE',
  'DUPLICATE_BUSINESS_EVENT',
  'BUSINESS_EVENT_CONFLICT',
];

@Injectable()
export class IntegrationReconciliationService {
  constructor(private readonly database: DatabaseService) {}

  async report(
    scope: ReconciliationScope,
    query: { domain?: string; since?: string; until?: string },
  ) {
    this.validateScope(scope);
    const domain = this.domainFilter(query.domain);
    const since = this.dateFilter(query.since, 'since');
    const until = this.dateFilter(query.until, 'until');
    if (since && until && Date.parse(since) > Date.parse(until)) {
      throw new BadRequestException('since must not be later than until');
    }

    return this.database.transaction(async (client) => {
      const result = await client.query(
        `WITH domains(domain) AS (
           VALUES ('ATTENDANCE'::text),('PRODUCTION'::text),('QUALITY'::text)
         ),
         events AS (
           SELECT e.domain,
                  COUNT(*)::int AS accepted_events,
                  COUNT(*) FILTER (WHERE e.delivery_class='LATE')::int AS late_events,
                  COUNT(*) FILTER (WHERE e.watermark_through_sequence IS NOT NULL)::int AS watermark_events,
                  COUNT(DISTINCT e.source_system)::int AS source_systems
           FROM integration_reconciliation_events e
           WHERE e.tenant_id=$1 AND e.factory_id=$2
             AND ($3::text IS NULL OR e.domain=$3)
             AND ($4::timestamptz IS NULL OR e.received_at >= $4::timestamptz)
             AND ($5::timestamptz IS NULL OR e.received_at <= $5::timestamptz)
           GROUP BY e.domain
         ),
         attempts AS (
           SELECT a.domain,
             COUNT(*) FILTER (WHERE a.outcome='DUPLICATE_REPLAY')::int AS duplicate_replays,
             COUNT(*) FILTER (WHERE a.outcome='CONFLICTING_DUPLICATE')::int AS conflicting_duplicates
           FROM integration_reconciliation_attempts a
           WHERE a.tenant_id=$1 AND a.factory_id=$2
             AND ($3::text IS NULL OR a.domain=$3)
             AND ($4::timestamptz IS NULL OR a.received_at >= $4::timestamptz)
             AND ($5::timestamptz IS NULL OR a.received_at <= $5::timestamptz)
           GROUP BY a.domain
         ),
         matched_sources AS (
           SELECT matched.domain,COUNT(*)::int AS cross_source_matches
           FROM (
             SELECT e.domain,e.reconciliation_key,e.event_type
             FROM integration_reconciliation_events e
             WHERE e.tenant_id=$1 AND e.factory_id=$2 AND e.reconciliation_key IS NOT NULL
               AND ($3::text IS NULL OR e.domain=$3)
               AND ($4::timestamptz IS NULL OR e.received_at >= $4::timestamptz)
               AND ($5::timestamptz IS NULL OR e.received_at <= $5::timestamptz)
             GROUP BY e.domain,e.reconciliation_key,e.event_type
             HAVING COUNT(DISTINCT e.source_system)>1 AND COUNT(DISTINCT e.comparison_sha256)=1
           ) matched
           GROUP BY matched.domain
         ),
         cases AS (
           SELECT c.domain,
             COUNT(*) FILTER (WHERE c.status='OPEN')::int AS open_cases,
             COUNT(*) FILTER (WHERE c.status='OPEN' AND c.severity='ERROR')::int AS open_errors,
             COUNT(*) FILTER (WHERE c.status='OPEN' AND c.case_type='MISSING_SEQUENCE_RANGE')::int AS missing_sequence_ranges,
             COUNT(*) FILTER (WHERE c.status='OPEN' AND c.case_type='MISSING_EVENT_TIME')::int AS missing_event_time,
             COUNT(*) FILTER (WHERE c.status='OPEN' AND c.case_type='INVALID_EVENT_TIME')::int AS invalid_event_time
           FROM integration_reconciliation_cases c
           WHERE c.tenant_id=$1 AND c.factory_id=$2
             AND ($3::text IS NULL OR c.domain=$3)
             AND ($4::timestamptz IS NULL OR c.opened_at >= $4::timestamptz)
             AND ($5::timestamptz IS NULL OR c.opened_at <= $5::timestamptz)
           GROUP BY c.domain
         )
         SELECT d.domain,
           COALESCE(e.accepted_events,0)::int AS accepted_events,
           COALESCE(e.late_events,0)::int AS late_events,
           COALESCE(c.missing_event_time,0)::int AS missing_event_time,
           COALESCE(c.invalid_event_time,0)::int AS invalid_event_time,
           COALESCE(e.watermark_events,0)::int AS watermark_events,
           COALESCE(e.source_systems,0)::int AS source_systems,
           COALESCE(a.duplicate_replays,0)::int AS duplicate_replays,
           COALESCE(a.conflicting_duplicates,0)::int AS conflicting_duplicates,
           COALESCE(ms.cross_source_matches,0)::int AS cross_source_matches,
           COALESCE(c.open_cases,0)::int AS open_cases,
           COALESCE(c.open_errors,0)::int AS open_errors,
           COALESCE(c.missing_sequence_ranges,0)::int AS missing_sequence_ranges
         FROM domains d
         LEFT JOIN events e ON e.domain=d.domain
         LEFT JOIN attempts a ON a.domain=d.domain
         LEFT JOIN matched_sources ms ON ms.domain=d.domain
         LEFT JOIN cases c ON c.domain=d.domain
         WHERE ($3::text IS NULL OR d.domain=$3)
         ORDER BY d.domain`,
        [scope.tenantId, scope.factoryId, domain, since, until],
      );
      return {
        scope: { factory_id: scope.factoryId },
        window: { since: since ?? null, until: until ?? null },
        items: result.rows,
      };
    }, { tenantId: scope.tenantId, userId: scope.userId });
  }

  async listEvents(
    scope: ReconciliationScope,
    query: { domain?: string; source_system?: string; delivery_class?: string; limit?: string | number },
  ) {
    this.validateScope(scope);
    const domain = this.domainFilter(query.domain);
    const sourceSystem = this.optionalCode(query.source_system, 'source_system', /^[A-Z0-9][A-Z0-9._-]{1,119}$/);
    const deliveryClass = query.delivery_class?.trim().toUpperCase() || null;
    if (deliveryClass && !['ON_TIME', 'LATE'].includes(deliveryClass)) {
      throw new BadRequestException('delivery_class must be ON_TIME or LATE');
    }
    const limit = this.limit(query.limit);
    const result = await this.database.query(
      `SELECT id::text AS id,domain,source_system,external_event_id,event_type,schema_version,
              occurred_at,source_sequence::text AS source_sequence,
              watermark_through_sequence::text AS watermark_through_sequence,
              stream_key,entity_reference,reconciliation_key,payload_sha256,comparison_sha256,
              correlation_id::text AS correlation_id,delivery_class,received_at
       FROM integration_reconciliation_events
       WHERE tenant_id=$1 AND factory_id=$2
         AND ($3::text IS NULL OR domain=$3)
         AND ($4::text IS NULL OR source_system=$4)
         AND ($5::text IS NULL OR delivery_class=$5)
       ORDER BY received_at DESC,id DESC LIMIT $6`,
      [scope.tenantId, scope.factoryId, domain, sourceSystem, deliveryClass, limit],
      { tenantId: scope.tenantId, userId: scope.userId },
    );
    return { items: result.rows, limit };
  }

  async listCases(
    scope: ReconciliationScope,
    query: { domain?: string; status?: string; case_type?: string; limit?: string | number },
  ) {
    this.validateScope(scope);
    const domain = this.domainFilter(query.domain);
    const status = query.status?.trim().toUpperCase() || null;
    if (status && !['OPEN', 'RESOLVED', 'WAIVED'].includes(status)) {
      throw new BadRequestException('status must be OPEN, RESOLVED or WAIVED');
    }
    const caseType = query.case_type?.trim().toUpperCase() || null;
    if (caseType && !CASE_TYPES.includes(caseType as OperationalCaseType)) {
      throw new BadRequestException('Unsupported reconciliation case_type');
    }
    const limit = this.limit(query.limit);
    const result = await this.database.query(
      `SELECT id::text AS id,connector_id::text AS connector_id,event_id::text AS event_id,
              domain,case_type,status,severity,stream_key,details,row_version,
              opened_at,resolved_by_user_id::text AS resolved_by_user_id,resolved_at,
              resolution_reason,created_at,updated_at
       FROM integration_reconciliation_cases
       WHERE tenant_id=$1 AND factory_id=$2
         AND ($3::text IS NULL OR domain=$3)
         AND ($4::text IS NULL OR status=$4)
         AND ($5::text IS NULL OR case_type=$5)
       ORDER BY CASE WHEN status='OPEN' THEN 0 ELSE 1 END, opened_at DESC,id DESC
       LIMIT $6`,
      [scope.tenantId, scope.factoryId, domain, status, caseType, limit],
      { tenantId: scope.tenantId, userId: scope.userId },
    );
    return { items: result.rows, limit };
  }

  async caseHistory(scope: ReconciliationScope, caseId: string) {
    this.validateScope(scope);
    if (!isUUID(caseId)) throw new BadRequestException('caseId must be a UUID');
    return this.database.transaction(async (client) => {
      await this.findCase(client, scope, caseId, false);
      const history = await client.query(
        `SELECT id::text AS id,actor_user_id::text AS actor_user_id,action,status,reason,details,happened_at
         FROM integration_reconciliation_case_history
         WHERE tenant_id=$1 AND factory_id=$2 AND case_id=$3
         ORDER BY happened_at ASC,id ASC`,
        [scope.tenantId, scope.factoryId, caseId],
      );
      return { case_id: caseId, items: history.rows };
    }, { tenantId: scope.tenantId, userId: scope.userId });
  }

  async decideCase(
    scope: ReconciliationScope,
    caseId: string,
    input: { action: 'RESOLVE' | 'WAIVE'; expected_version: number; reason: string },
  ) {
    this.validateScope(scope);
    if (!isUUID(caseId)) throw new BadRequestException('caseId must be a UUID');
    if (!Number.isInteger(input.expected_version) || input.expected_version < 1) {
      throw new BadRequestException('expected_version must be a positive integer');
    }
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) {
      throw new BadRequestException('reason must contain 10 to 500 characters');
    }
    if (!['RESOLVE', 'WAIVE'].includes(input.action)) {
      throw new BadRequestException('action must be RESOLVE or WAIVE');
    }

    return this.database.transaction(async (client) => {
      const current = await this.findCase(client, scope, caseId, true);
      if (current.status !== 'OPEN') {
        throw new ConflictException('Only OPEN reconciliation cases can be resolved or waived');
      }
      if (Number(current.row_version) !== input.expected_version) {
        throw new ConflictException('Reconciliation case version changed; reload it before deciding');
      }
      const nextStatus = input.action === 'RESOLVE' ? 'RESOLVED' : 'WAIVED';
      const updated = await client.query(
        `UPDATE integration_reconciliation_cases
         SET status=$1,resolved_by_user_id=$2,resolved_at=clock_timestamp(),
             resolution_reason=$3,row_version=row_version+1
         WHERE id=$4 AND tenant_id=$5 AND factory_id=$6 AND status='OPEN' AND row_version=$7
         RETURNING id::text AS id,domain,case_type,status,severity,row_version,resolved_by_user_id::text AS resolved_by_user_id,resolved_at,resolution_reason`,
        [nextStatus, scope.userId, reason, caseId, scope.tenantId, scope.factoryId, input.expected_version],
      );
      const row = updated.rows[0];
      if (!row) throw new ConflictException('Reconciliation case changed concurrently; reload and retry');
      return row;
    }, { tenantId: scope.tenantId, userId: scope.userId });
  }

  private async findCase(
    client: PoolClient,
    scope: ReconciliationScope,
    caseId: string,
    forUpdate: boolean,
  ) {
    const result = await client.query<{
      id: string; status: string; row_version: number; domain: string; case_type: string;
    }>(
      `SELECT id::text AS id,status,row_version,domain,case_type
       FROM integration_reconciliation_cases
       WHERE id=$1 AND tenant_id=$2 AND factory_id=$3${forUpdate ? ' FOR UPDATE' : ''}`,
      [caseId, scope.tenantId, scope.factoryId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Operational reconciliation case not found');
    return row;
  }

  private validateScope(scope: ReconciliationScope) {
    for (const [field, value] of Object.entries({
      userId: scope.userId, tenantId: scope.tenantId, factoryId: scope.factoryId,
    })) {
      if (!isUUID(value)) throw new BadRequestException(field + ' must be a valid UUID');
    }
  }

  private domainFilter(value?: string): OperationalDomain | null {
    const domain = value?.trim().toUpperCase() || null;
    if (domain && !DOMAINS.includes(domain as OperationalDomain)) {
      throw new BadRequestException('domain must be ATTENDANCE, PRODUCTION or QUALITY');
    }
    return domain as OperationalDomain | null;
  }

  private dateFilter(value: string | undefined, field: string): string | null {
    if (value === undefined || value.trim() === '') return null;
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) throw new BadRequestException(field + ' must be a valid ISO-8601 timestamp');
    return new Date(millis).toISOString();
  }

  private optionalCode(value: string | undefined, field: string, pattern: RegExp): string | null {
    const result = value?.trim().toUpperCase() || null;
    if (result && !pattern.test(result)) throw new BadRequestException(field + ' must be a valid canonical source code');
    return result;
  }

  private limit(value?: string | number): number {
    if (value === undefined || value === '') return 100;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      throw new BadRequestException('limit must be an integer between 1 and 200');
    }
    return parsed;
  }
}
