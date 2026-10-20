-- Return exactly one UTC timestamp for the known application/audit fixture.
-- Real rehearsal operators must replace this with the business-approved durable
-- write watermark for the specific system under recovery.
SELECT to_char(
  max(created_at) AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"'
)
FROM audit_events
WHERE event_type='RECOVERY_REHEARSAL'
  AND action='RESTORE_CONTINUITY';
