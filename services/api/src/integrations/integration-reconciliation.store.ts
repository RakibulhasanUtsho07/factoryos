import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { integrationRequestHash } from './integration-contract';

export type OperationalDomain = 'ATTENDANCE' | 'PRODUCTION' | 'QUALITY';
export type OperationalCaseType =
  | 'MISSING_EVENT_TIME'
  | 'INVALID_EVENT_TIME'
  | 'INVALID_SEQUENCE'
  | 'MISSING_SEQUENCE_RANGE'
  | 'SEQUENCE_COLLISION'
  | 'CROSS_SOURCE_CONFLICT'
  | 'CONFLICTING_DUPLICATE'
  | 'DUPLICATE_BUSINESS_EVENT'
  | 'BUSINESS_EVENT_CONFLICT';

export interface OperationalWebhookInput {
  tenantId: string;
  factoryId: string;
  connectorId: string;
  sourceSystem: string;
  externalEventId: string;
  eventType: string;
  schemaVersion: number;
  payloadSha256: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
}

export interface NormalizedOperationalEvent {
  domain: OperationalDomain;
  occurredAt: string | null;
  timeIssue: 'MISSING_EVENT_TIME' | 'INVALID_EVENT_TIME' | null;
  sourceSequence: number | null;
  watermarkThroughSequence: number | null;
  sequenceIssue: string | null;
  streamKey: string | null;
  entityReference: string | null;
  reconciliationKey: string | null;
  comparisonSha256: string;
}

export function classifyOperationalDomain(eventType: string): OperationalDomain | null {
  if (/^(?:ATTENDANCE|WORKFORCE\.ATTENDANCE|MES\.ATTENDANCE)\./.test(eventType) ||
      /^WORKFORCE\.(?:CLOCK_IN|CLOCK_OUT|BREAK_START|BREAK_END|ABSENCE_RECORDED)(?:\.|$)/.test(eventType)) {
    return 'ATTENDANCE';
  }
  if (/^(?:PRODUCTION|OPERATION|MES\.PRODUCTION|MES\.OPERATION)\./.test(eventType)) {
    return 'PRODUCTION';
  }
  if (/^(?:QUALITY|INSPECTION|NCR|QC)\./.test(eventType)) return 'QUALITY';
  return null;
}

function scalarReference(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const candidate = String(value).trim();
  if (!candidate || candidate.length > 200 || /[\x00-\x1f\x7f]/.test(candidate)) return null;
  return candidate;
}

function firstReference(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = scalarReference(payload[key]);
    if (value) return value;
  }
  return null;
}

function parseOccurredAt(payload: Record<string, unknown>): {
  value: string | null;
  issue: 'MISSING_EVENT_TIME' | 'INVALID_EVENT_TIME' | null;
} {
  const keys = ['occurred_at', 'event_time', 'timestamp'];
  const present = keys.find((key) => Object.hasOwn(payload, key));
  if (!present) return { value: null, issue: 'MISSING_EVENT_TIME' };
  const raw = payload[present];
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 80 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    return { value: null, issue: 'INVALID_EVENT_TIME' };
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) return { value: null, issue: 'INVALID_EVENT_TIME' };
  return { value: new Date(milliseconds).toISOString(), issue: null };
}

function sequenceValue(value: unknown, min: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return null;
  return value;
}

export function normalizeOperationalEvent(
  input: Pick<OperationalWebhookInput, 'eventType' | 'payload'>,
): NormalizedOperationalEvent | null {
  const domain = classifyOperationalDomain(input.eventType);
  if (!domain) return null;

  const payload = input.payload;
  const occurred = parseOccurredAt(payload);
  const sequenceField = Object.hasOwn(payload, 'source_sequence')
    ? 'source_sequence'
    : Object.hasOwn(payload, 'sequence_number')
      ? 'sequence_number'
      : null;
  const watermarkField = Object.hasOwn(payload, 'watermark_through_sequence')
    ? 'watermark_through_sequence'
    : Object.hasOwn(payload, 'expected_through_sequence')
      ? 'expected_through_sequence'
      : null;
  const streamKey = firstReference(payload, [
    'stream_key', 'stream_id', 'worker_id', 'shift_assignment_id',
    'work_order_id', 'operation_id', 'inspection_id', 'quality_inspection_id',
  ]);
  let sourceSequence = sequenceField ? sequenceValue(payload[sequenceField], 1) : null;
  let watermarkThroughSequence = watermarkField ? sequenceValue(payload[watermarkField], 0) : null;
  let sequenceIssue: string | null = null;
  if (sequenceField && sourceSequence === null) sequenceIssue = 'SOURCE_SEQUENCE_MUST_BE_A_SAFE_POSITIVE_INTEGER';
  else if (watermarkField && watermarkThroughSequence === null) sequenceIssue = 'WATERMARK_MUST_BE_A_SAFE_NON_NEGATIVE_INTEGER';
  else if ((sequenceField || watermarkField) && !streamKey) {
    sequenceIssue = 'SEQUENCE_REQUIRES_A_STREAM_KEY';
    sourceSequence = null;
    watermarkThroughSequence = null;
  }

  const comparisonFields = [
    'worker_id', 'worker_code', 'employee_id', 'employee_code', 'source_employee_id',
    'shift_assignment_id', 'shift_code', 'clock_type', 'attendance_status',
    'work_order_id', 'work_order_number', 'operation_id', 'operation_code',
    'product_id', 'sku', 'batch_id', 'lot_id', 'serial_id', 'machine_id',
    'inspection_id', 'quality_inspection_id', 'inspection_type', 'plan_code',
    'criterion_code', 'target_id', 'quantity', 'good_quantity', 'pass_quantity',
    'scrap_quantity', 'fail_quantity', 'rejected_quantity', 'measured_value',
    'uom', 'unit', 'defect_code', 'reason_code', 'disposition',
    'result', 'severity', 'status', 'event_status',
  ];
  const comparisonEvidence: Record<string, unknown> = {
    event_type: input.eventType,
    occurred_at: occurred.value,
  };
  for (const field of comparisonFields) {
    const value = payload[field];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (value !== undefined) comparisonEvidence[field] = value;
    }
  }

  return {
    domain,
    occurredAt: occurred.value,
    timeIssue: occurred.issue,
    sourceSequence,
    watermarkThroughSequence,
    sequenceIssue,
    streamKey,
    entityReference: firstReference(payload, [
      'entity_reference', 'entity_id', 'worker_id', 'shift_assignment_id',
      'work_order_id', 'operation_id', 'inspection_id', 'quality_inspection_id', 'target_id',
    ]),
    reconciliationKey: firstReference(payload, ['reconciliation_key', 'business_event_key', 'source_record_key']),
    comparisonSha256: integrationRequestHash(comparisonEvidence),
  };
}

function hashKey(parts: Array<string | number>): string {
  return createHash('sha256').update(JSON.stringify(parts.map(String))).digest('hex');
}

function caseKey(type: OperationalCaseType, parts: Array<string | number>): string {
  return type + ':' + hashKey(parts);
}

interface CaseInput {
  tenantId: string;
  factoryId: string;
  connectorId: string;
  eventId: string | null;
  domain: OperationalDomain;
  type: OperationalCaseType;
  key: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  streamKey?: string | null;
  details: Record<string, unknown>;
}

async function openCase(client: PoolClient, item: CaseInput): Promise<void> {
  await client.query(
    `INSERT INTO integration_reconciliation_cases
      (tenant_id,factory_id,connector_id,event_id,domain,case_type,case_key,severity,stream_key,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT(tenant_id,factory_id,case_key) WHERE status='OPEN' DO NOTHING`,
    [
      item.tenantId, item.factoryId, item.connectorId, item.eventId, item.domain,
      item.type, item.key, item.severity, item.streamKey ?? null, JSON.stringify(item.details),
    ],
  );
}

async function recordAttempt(
  client: PoolClient,
  input: OperationalWebhookInput,
  domain: OperationalDomain,
  outcome: 'ACCEPTED' | 'DUPLICATE_REPLAY' | 'CONFLICTING_DUPLICATE',
  eventId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO integration_reconciliation_attempts
      (tenant_id,factory_id,connector_id,event_id,domain,external_event_id,incoming_payload_sha256,outcome)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.tenantId, input.factoryId, input.connectorId, eventId, domain,
      input.externalEventId, input.payloadSha256, outcome,
    ],
  );
}

async function refreshSequenceGaps(
  client: PoolClient,
  input: OperationalWebhookInput,
  eventId: string,
  normalized: NormalizedOperationalEvent,
): Promise<void> {
  const streamKey = normalized.streamKey;
  if (!streamKey) return;

  const sequenceResult = await client.query<{ source_sequence: string }>(
    `SELECT DISTINCT source_sequence::text AS source_sequence
     FROM integration_reconciliation_events
     WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4
       AND stream_key=$5 AND source_sequence IS NOT NULL
     ORDER BY source_sequence ASC`,
    [input.tenantId, input.factoryId, input.connectorId, normalized.domain, streamKey],
  );
  const sequences = sequenceResult.rows.map((row) => Number(row.source_sequence));
  const watermarkResult = await client.query<{ watermark: string | null }>(
    `SELECT MAX(watermark_through_sequence)::text AS watermark
     FROM integration_reconciliation_events
     WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4 AND stream_key=$5`,
    [input.tenantId, input.factoryId, input.connectorId, normalized.domain, streamKey],
  );
  const watermark = watermarkResult.rows[0]?.watermark == null ? null : Number(watermarkResult.rows[0].watermark);

  const gaps: Array<{
    start: number;
    end: number;
    previous: number | null;
    next: number | null;
    confirmed: boolean;
  }> = [];
  for (let i = 1; i < sequences.length; i += 1) {
    if (sequences[i] - sequences[i - 1] > 1) {
      gaps.push({
        start: sequences[i - 1] + 1,
        end: sequences[i] - 1,
        previous: sequences[i - 1],
        next: sequences[i],
        confirmed: false,
      });
    }
  }
  if (watermark !== null && watermark > 0) {
    if (sequences.length === 0) {
      gaps.push({ start: 1, end: watermark, previous: null, next: null, confirmed: true });
    } else {
      if (sequences[0] > 1 && watermark >= sequences[0]) {
        gaps.push({ start: 1, end: sequences[0] - 1, previous: null, next: sequences[0], confirmed: true });
      }
      const latest = sequences[sequences.length - 1];
      if (latest < watermark) {
        gaps.push({ start: latest + 1, end: watermark, previous: latest, next: null, confirmed: true });
      }
    }
  }

  const activeKeys = new Set(gaps.map((gap) =>
    caseKey('MISSING_SEQUENCE_RANGE', [
      input.connectorId, normalized.domain, streamKey, gap.start, gap.end,
    ]),
  ));
  const openCases = await client.query<{ id: string; case_key: string }>(
    `SELECT id::text AS id,case_key FROM integration_reconciliation_cases
     WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4
       AND case_type='MISSING_SEQUENCE_RANGE' AND stream_key=$5 AND status='OPEN'`,
    [input.tenantId, input.factoryId, input.connectorId, normalized.domain, streamKey],
  );
  for (const oldCase of openCases.rows) {
    if (!activeKeys.has(oldCase.case_key)) {
      await client.query(
        `UPDATE integration_reconciliation_cases
         SET status='RESOLVED',resolved_by_user_id=NULL,resolved_at=clock_timestamp(),
             resolution_reason='Automatically reconciled after a late event or a newer watermark changed the missing range',
             row_version=row_version+1
         WHERE id=$1 AND tenant_id=$2 AND factory_id=$3 AND status='OPEN'`,
        [oldCase.id, input.tenantId, input.factoryId],
      );
    }
  }

  for (const gap of gaps) {
    await openCase(client, {
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      connectorId: input.connectorId,
      eventId,
      domain: normalized.domain,
      type: 'MISSING_SEQUENCE_RANGE',
      key: caseKey('MISSING_SEQUENCE_RANGE', [
        input.connectorId, normalized.domain, streamKey, gap.start, gap.end,
      ]),
      severity: gap.confirmed ? 'ERROR' : 'WARNING',
      streamKey,
      details: {
        missing_from_sequence: gap.start,
        missing_through_sequence: gap.end,
        preceding_sequence: gap.previous,
        following_sequence: gap.next,
        confirmed_by_watermark: gap.confirmed,
      },
    });
  }

  if (normalized.sourceSequence !== null) {
    const collision = await client.query<{ count: string; event_ids: string[]; source_event_ids: string[] }>(
      `SELECT COUNT(*)::text AS count,
              COALESCE(array_agg(id::text ORDER BY received_at) FILTER (WHERE id IS NOT NULL), ARRAY[]::text[]) AS event_ids,
              COALESCE(array_agg(external_event_id ORDER BY received_at) FILTER (WHERE external_event_id IS NOT NULL), ARRAY[]::text[]) AS source_event_ids
       FROM integration_reconciliation_events
       WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4
         AND stream_key=$5 AND source_sequence=$6`,
      [input.tenantId, input.factoryId, input.connectorId, normalized.domain, streamKey, normalized.sourceSequence],
    );
    if (Number(collision.rows[0]?.count ?? 0) > 1) {
      await openCase(client, {
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        connectorId: input.connectorId,
        eventId,
        domain: normalized.domain,
        type: 'SEQUENCE_COLLISION',
        key: caseKey('SEQUENCE_COLLISION', [
          input.connectorId, normalized.domain, streamKey, normalized.sourceSequence,
        ]),
        severity: 'ERROR',
        streamKey,
        details: {
          source_sequence: normalized.sourceSequence,
          conflicting_event_ids: (collision.rows[0]?.event_ids ?? []).slice(0, 20),
          conflicting_source_event_ids: (collision.rows[0]?.source_event_ids ?? []).slice(0, 20),
          truncated: Number(collision.rows[0]?.count ?? 0) > 20,
        },
      });
    }
  }
}

export async function recordOperationalWebhookEvent(
  client: PoolClient,
  input: OperationalWebhookInput,
): Promise<void> {
  const normalized = normalizeOperationalEvent(input);
  if (!normalized) return;

  const latestResult = normalized.streamKey && normalized.sourceSequence !== null
    ? await client.query<{ max_sequence: string | null }>(
        `SELECT MAX(source_sequence)::text AS max_sequence
         FROM integration_reconciliation_events
         WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4
           AND stream_key=$5`,
        [input.tenantId, input.factoryId, input.connectorId, normalized.domain, normalized.streamKey],
      )
    : null;
  const latest = latestResult?.rows[0]?.max_sequence == null ? null : Number(latestResult.rows[0].max_sequence);
  const deliveryClass = normalized.sourceSequence !== null && latest !== null && normalized.sourceSequence < latest
    ? 'LATE'
    : 'ON_TIME';

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO integration_reconciliation_events(
       tenant_id,factory_id,connector_id,domain,source_system,external_event_id,event_type,
       schema_version,occurred_at,source_sequence,watermark_through_sequence,stream_key,
       entity_reference,reconciliation_key,payload_sha256,comparison_sha256,correlation_id,delivery_class
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id::text AS id`,
    [
      input.tenantId, input.factoryId, input.connectorId, normalized.domain, input.sourceSystem,
      input.externalEventId, input.eventType, input.schemaVersion, normalized.occurredAt,
      normalized.sourceSequence, normalized.watermarkThroughSequence, normalized.streamKey,
      normalized.entityReference, normalized.reconciliationKey, input.payloadSha256,
      normalized.comparisonSha256, input.correlationId, deliveryClass,
    ],
  );
  const eventId = inserted.rows[0]?.id;
  if (!eventId) throw new Error('INTEGRATION_RECONCILIATION_EVENT_INSERT_FAILED');
  await recordAttempt(client, input, normalized.domain, 'ACCEPTED', eventId);

  if (normalized.timeIssue) {
    await openCase(client, {
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      connectorId: input.connectorId,
      eventId,
      domain: normalized.domain,
      type: normalized.timeIssue,
      key: caseKey(normalized.timeIssue, [input.connectorId, input.externalEventId]),
      severity: normalized.timeIssue === 'MISSING_EVENT_TIME' ? 'WARNING' : 'ERROR',
      streamKey: normalized.streamKey,
      details: { issue_code: normalized.timeIssue, fields_checked: ['occurred_at', 'event_time', 'timestamp'] },
    });
  }
  if (normalized.sequenceIssue) {
    await openCase(client, {
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      connectorId: input.connectorId,
      eventId,
      domain: normalized.domain,
      type: 'INVALID_SEQUENCE',
      key: caseKey('INVALID_SEQUENCE', [input.connectorId, input.externalEventId, normalized.sequenceIssue]),
      severity: 'ERROR',
      streamKey: normalized.streamKey,
      details: { issue_code: normalized.sequenceIssue },
    });
  }
  if (normalized.streamKey && (normalized.sourceSequence !== null || normalized.watermarkThroughSequence !== null)) {
    await refreshSequenceGaps(client, input, eventId, normalized);
  }

  if (normalized.reconciliationKey) {
    const sameConnector = await client.query<{
      id: string;
      external_event_id: string;
      comparison_sha256: string;
    }>(
      `SELECT id::text AS id,external_event_id,comparison_sha256
       FROM integration_reconciliation_events
       WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4
         AND reconciliation_key=$5 AND event_type=$6 AND external_event_id<>$7
       ORDER BY received_at DESC LIMIT 25`,
      [
        input.tenantId, input.factoryId, input.connectorId, normalized.domain,
        normalized.reconciliationKey, input.eventType, input.externalEventId,
      ],
    );
    for (const prior of sameConnector.rows) {
      const ids = [prior.id, eventId].sort();
      const sameComparison = prior.comparison_sha256 === normalized.comparisonSha256;
      await openCase(client, {
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        connectorId: input.connectorId,
        eventId,
        domain: normalized.domain,
        type: sameComparison ? 'DUPLICATE_BUSINESS_EVENT' : 'BUSINESS_EVENT_CONFLICT',
        key: caseKey(sameComparison ? 'DUPLICATE_BUSINESS_EVENT' : 'BUSINESS_EVENT_CONFLICT', [
          input.connectorId, normalized.domain, normalized.reconciliationKey, input.eventType, ...ids,
        ]),
        severity: sameComparison ? 'WARNING' : 'ERROR',
        streamKey: normalized.streamKey,
        details: {
          business_key_sha256: hashKey([normalized.domain, normalized.reconciliationKey]),
          source_event_ids: [prior.external_event_id, input.externalEventId].sort(),
          duplicate_event_ids: ids,
          comparison_match: sameComparison,
        },
      });
    }

    const other = await client.query<{
      id: string;
      connector_id: string;
      source_system: string;
      comparison_sha256: string;
    }>(
      `SELECT id::text AS id,connector_id::text AS connector_id,source_system,comparison_sha256
       FROM integration_reconciliation_events
       WHERE tenant_id=$1 AND factory_id=$2 AND domain=$3 AND reconciliation_key=$4
         AND event_type=$5 AND connector_id<>$6 AND comparison_sha256<>$7
       ORDER BY received_at DESC LIMIT 25`,
      [
        input.tenantId, input.factoryId, normalized.domain, normalized.reconciliationKey,
        input.eventType, input.connectorId, normalized.comparisonSha256,
      ],
    );
    for (const prior of other.rows) {
      const ids = [prior.id, eventId].sort();
      await openCase(client, {
        tenantId: input.tenantId,
        factoryId: input.factoryId,
        connectorId: input.connectorId,
        eventId,
        domain: normalized.domain,
        type: 'CROSS_SOURCE_CONFLICT',
        key: caseKey('CROSS_SOURCE_CONFLICT', [
          normalized.domain, normalized.reconciliationKey, input.eventType, ...ids,
        ]),
        severity: 'ERROR',
        streamKey: normalized.streamKey,
        details: {
          comparison_key_sha256: hashKey([normalized.domain, normalized.reconciliationKey]),
          conflicting_event_ids: ids,
          source_systems: [prior.source_system, input.sourceSystem].sort(),
        },
      });
    }
  }
}

export async function recordOperationalWebhookReplay(
  client: PoolClient,
  input: OperationalWebhookInput,
  outcome: 'DUPLICATE_REPLAY' | 'CONFLICTING_DUPLICATE',
): Promise<void> {
  const domain = classifyOperationalDomain(input.eventType);
  if (!domain) return;
  const found = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM integration_reconciliation_events
     WHERE tenant_id=$1 AND factory_id=$2 AND connector_id=$3 AND domain=$4 AND external_event_id=$5`,
    [input.tenantId, input.factoryId, input.connectorId, domain, input.externalEventId],
  );
  const eventId = found.rows[0]?.id ?? null;
  if (outcome === 'DUPLICATE_REPLAY') {
    if (eventId) await recordAttempt(client, input, domain, outcome, eventId);
    return;
  }
  if (!eventId) {
    await recordAttempt(client, input, domain, outcome, null);
    await openCase(client, {
      tenantId: input.tenantId,
      factoryId: input.factoryId,
      connectorId: input.connectorId,
      eventId: null,
      domain,
      type: 'CONFLICTING_DUPLICATE',
      key: caseKey('CONFLICTING_DUPLICATE', [input.connectorId, input.externalEventId, input.payloadSha256]),
      severity: 'ERROR',
      details: {
        source_event_id: input.externalEventId,
        accepted_operational_evidence_available: false,
        conflicting_payload_sha256: input.payloadSha256,
      },
    });
    return;
  }
  await recordAttempt(client, input, domain, outcome, eventId);
  await openCase(client, {
    tenantId: input.tenantId,
    factoryId: input.factoryId,
    connectorId: input.connectorId,
    eventId,
    domain,
    type: 'CONFLICTING_DUPLICATE',
    key: caseKey('CONFLICTING_DUPLICATE', [input.connectorId, input.externalEventId, input.payloadSha256]),
    severity: 'ERROR',
    details: {
      source_event_id: input.externalEventId,
      accepted_payload_sha256: (await client.query<{ payload_sha256: string }>(
        'SELECT payload_sha256 FROM integration_reconciliation_events WHERE id=$1 AND tenant_id=$2 AND factory_id=$3',
        [eventId, input.tenantId, input.factoryId],
      )).rows[0]?.payload_sha256 ?? null,
      conflicting_payload_sha256: input.payloadSha256,
    },
  });
}
