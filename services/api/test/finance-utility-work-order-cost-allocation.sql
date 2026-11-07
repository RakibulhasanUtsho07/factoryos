-- Compile the exact finance reconciliation source join against the migrated schema.
BEGIN;
DO $$
BEGIN
  PERFORM a.allocated_quantity,a.unit_cost_snapshot,upper(a.unit_code),upper(a.currency_code)
    FROM utility_reading_work_order_cost_allocations a
    JOIN utility_meter_readings r
      ON r.id=a.reading_id AND r.tenant_id=a.tenant_id AND r.factory_id=a.factory_id
    JOIN work_orders wo
      ON wo.id=a.work_order_id AND wo.tenant_id=a.tenant_id AND wo.factory_id=a.factory_id
   WHERE a.tenant_id='faaab63d-c447-46ce-950d-deebdd7f5f30'
     AND a.factory_id='24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7'
     AND a.id='00000000-0000-0000-0000-000000000000'
     AND a.allocation_kind='ALLOCATE'
     AND NOT EXISTS (
       SELECT 1 FROM utility_reading_work_order_cost_allocations rev
        WHERE rev.reverses_allocation_id=a.id AND rev.tenant_id=a.tenant_id AND rev.factory_id=a.factory_id
     )
     AND r.currency_code_snapshot IS NOT NULL;
END;
$$;
ROLLBACK;
