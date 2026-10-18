import {
  classifyOperationalDomain,
  normalizeOperationalEvent,
} from './integration-reconciliation.store';

describe('operational event reconciliation contract', () => {
  it('classifies attendance, production and quality while ignoring unrelated domains', () => {
    expect(classifyOperationalDomain('WORKFORCE.ATTENDANCE.CLOCK_IN')).toBe('ATTENDANCE');
    expect(classifyOperationalDomain('MES.PRODUCTION.COUNTED')).toBe('PRODUCTION');
    expect(classifyOperationalDomain('QUALITY.INSPECTION.PASSED')).toBe('QUALITY');
    expect(classifyOperationalDomain('ORDER.CREATED')).toBeNull();
    expect(classifyOperationalDomain('WORKFORCE.SKILL.CERTIFIED')).toBeNull();
  });

  it('normalizes a canonical sequence event and preserves only comparison evidence hashes', () => {
    const result = normalizeOperationalEvent({
      eventType: 'PRODUCTION.OPERATION.COMPLETED',
      payload: {
        occurred_at: '2026-10-18T08:00:00+06:00',
        stream_key: 'work-order:WO-100:operation:20',
        source_sequence: 7,
        work_order_id: 'WO-100',
        operation_id: '20',
        reconciliation_key: 'WO-100:OP-20:REV-1',
        good_quantity: 12,
        scrap_quantity: 1,
        operator_display_name: 'must not affect canonical comparison',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.domain).toBe('PRODUCTION');
    expect(result?.occurredAt).toBe('2026-10-18T02:00:00.000Z');
    expect(result?.sourceSequence).toBe(7);
    expect(result?.streamKey).toBe('work-order:WO-100:operation:20');
    expect(result?.entityReference).toBe('WO-100');
    expect(result?.reconciliationKey).toBe('WO-100:OP-20:REV-1');
    expect(result?.timeIssue).toBeNull();
    expect(result?.sequenceIssue).toBeNull();
    expect(result?.comparisonSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports missing and malformed source event time instead of replacing it with receipt time', () => {
    const missing = normalizeOperationalEvent({
      eventType: 'ATTENDANCE.CLOCK_IN',
      payload: { worker_id: 'worker-22' },
    });
    const malformed = normalizeOperationalEvent({
      eventType: 'QUALITY.INSPECTION.RESULT',
      payload: { event_time: 'not-a-time' },
    });
    const timezoneFree = normalizeOperationalEvent({
      eventType: 'ATTENDANCE.CLOCK_IN',
      payload: { occurred_at: '2026-10-18T08:00:00' },
    });

    expect(missing?.timeIssue).toBe('MISSING_EVENT_TIME');
    expect(missing?.occurredAt).toBeNull();
    expect(malformed?.timeIssue).toBe('INVALID_EVENT_TIME');
    expect(malformed?.occurredAt).toBeNull();
    expect(timezoneFree?.timeIssue).toBe('INVALID_EVENT_TIME');
    expect(timezoneFree?.occurredAt).toBeNull();
  });

  it('rejects unsafe sequence values and sequences without an explicit stream key', () => {
    const fractional = normalizeOperationalEvent({
      eventType: 'ATTENDANCE.CLOCK_OUT',
      payload: { occurred_at: '2026-10-18T08:00:00Z', worker_id: 'worker-1', source_sequence: 1.5 },
    });
    const noStream = normalizeOperationalEvent({
      eventType: 'PRODUCTION.OUTPUT.REPORTED',
      payload: { occurred_at: '2026-10-18T08:00:00Z', source_sequence: 9 },
    });
    const unsafeWatermark = normalizeOperationalEvent({
      eventType: 'QUALITY.SYNC_WATERMARK',
      payload: { occurred_at: '2026-10-18T08:00:00Z', stream_key: 'inspection-feed', expected_through_sequence: Number.MAX_SAFE_INTEGER + 1 },
    });

    expect(fractional?.sourceSequence).toBeNull();
    expect(fractional?.sequenceIssue).toBe('SOURCE_SEQUENCE_MUST_BE_A_SAFE_POSITIVE_INTEGER');
    expect(noStream?.sourceSequence).toBeNull();
    expect(noStream?.sequenceIssue).toBe('SEQUENCE_REQUIRES_A_STREAM_KEY');
    expect(unsafeWatermark?.watermarkThroughSequence).toBeNull();
    expect(unsafeWatermark?.sequenceIssue).toBe('WATERMARK_MUST_BE_A_SAFE_NON_NEGATIVE_INTEGER');
  });

  it('accepts explicit watermarks for trailing or entirely missing sequences', () => {
    const result = normalizeOperationalEvent({
      eventType: 'ATTENDANCE.SYNC_WATERMARK',
      payload: {
        event_time: '2026-10-18T08:00:00Z',
        stream_key: 'reader-7',
        expected_through_sequence: 42,
      },
    });

    expect(result?.watermarkThroughSequence).toBe(42);
    expect(result?.sequenceIssue).toBeNull();
  });
});
