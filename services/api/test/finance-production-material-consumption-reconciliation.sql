-- Compile and execute the production-consumption reference-rate source query against
-- the post-migration PostgreSQL schema. The deliberately absent UUID ensures this
-- contract checks names, joins, tenant/factory predicates and columns without changing
-- or depending on operational fixture data.
BEGIN;

SELECT set_config('app.tenant_id','00000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000002',true);

DO $$
DECLARE
  resolved_rows integer;
BEGIN
  SELECT count(*) INTO resolved_rows
  FROM (
    SELECT
      ca.quantity::text AS quantity,
      pol.unit_price::text AS rate,
      upper(pol.unit) AS uom_code,
      upper(po.currency) AS currency
    FROM inventory_reservation_consumption_traceability_allocations ca
    JOIN inventory_reservation_consumptions c
      ON c.id=ca.consumption_id AND c.tenant_id=ca.tenant_id AND c.factory_id=ca.factory_id
    JOIN work_order_material_reservations mr
      ON mr.reservation_id=c.reservation_id AND mr.tenant_id=c.tenant_id
     AND mr.factory_id=c.factory_id AND mr.item_id=c.item_id
    JOIN traceability_units tu
      ON tu.id=ca.traceability_unit_id AND tu.tenant_id=ca.tenant_id
     AND tu.factory_id=ca.factory_id AND tu.inventory_item_id=c.item_id
    JOIN goods_receipt_lines grl
      ON grl.id=tu.goods_receipt_line_id AND grl.tenant_id=tu.tenant_id
     AND grl.factory_id=tu.factory_id AND grl.goods_receipt_id=tu.goods_receipt_id
     AND grl.inventory_item_id=tu.inventory_item_id
    JOIN goods_receipts gr
      ON gr.id=grl.goods_receipt_id AND gr.tenant_id=grl.tenant_id
     AND gr.factory_id=grl.factory_id AND gr.status='POSTED' AND gr.posted_at IS NOT NULL
    JOIN purchase_order_lines pol
      ON pol.id=grl.purchase_order_line_id AND pol.tenant_id=grl.tenant_id
     AND pol.factory_id=grl.factory_id AND pol.purchase_order_id=grl.purchase_order_id
    JOIN purchase_orders po
      ON po.id=pol.purchase_order_id AND po.tenant_id=pol.tenant_id AND po.factory_id=pol.factory_id
    WHERE ca.tenant_id='00000000-0000-4000-8000-000000000001'::uuid
      AND ca.factory_id='00000000-0000-4000-8000-000000000003'::uuid
      AND ca.id='00000000-0000-4000-8000-000000000004'::uuid
      AND mr.work_order_id IS NOT NULL
      AND tu.product_role='MATERIAL'
      AND tu.unit_type IN ('LOT','SERIAL')
      AND tu.goods_receipt_line_id IS NOT NULL
      AND c.quantity>0
      AND pol.unit_price IS NOT NULL
      AND upper(tu.unit)=upper(pol.unit)
      AND po.status='APPROVED'
    LIMIT 2
  ) source_rows;

  IF resolved_rows<>0 THEN
    RAISE EXCEPTION 'Reference-rate schema contract expected no source row for its absent fixture UUID';
  END IF;
END $$;

ROLLBACK;
