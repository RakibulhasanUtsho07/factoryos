-- Compile and pin the supplier invoice -> posted GRN -> approved PO source resolver.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='purchase_orders'::regclass
      AND conname='fk_purchase_orders_supplier_tenant'
  ) THEN
    RAISE EXCEPTION 'Purchase orders must retain their tenant-scoped supplier identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='goods_receipt_lines'::regclass
      AND conname='fk_goods_receipt_lines_po_line_scope'
  ) THEN
    RAISE EXCEPTION 'GRN lines must retain their exact tenant/factory/PO-line binding';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='goods_receipt_lines'::regclass
      AND conname='fk_goods_receipt_lines_receipt_scope'
  ) THEN
    RAISE EXCEPTION 'GRN lines must retain their exact tenant/factory/receipt binding';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='suppliers'
      AND indexname='uq_suppliers_tenant_code_ci'
  ) THEN
    RAISE EXCEPTION 'Canonical supplier code uniqueness is required for AP supplier crosswalks';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='financial_facts'::regclass
      AND conname='chk_financial_fact_type'
      AND pg_get_constraintdef(oid) LIKE '%AP_OPEN%'
  ) THEN
    RAISE EXCEPTION 'External AP_OPEN financial facts are not available for supplier invoice lines';
  END IF;
END;
$$;

PREPARE factoryos_supplier_invoice_grn_po_source(uuid,uuid,text) AS
  SELECT grl.accepted_quantity::text AS quantity,
         pol.unit_price::text AS rate,
         upper(pol.unit) AS uom_code,
         upper(po.currency) AS currency,
         upper(s.code) AS supplier_code
    FROM goods_receipt_lines grl
    JOIN goods_receipts gr
      ON gr.id=grl.goods_receipt_id
     AND gr.tenant_id=grl.tenant_id
     AND gr.factory_id=grl.factory_id
    JOIN purchase_order_lines pol
      ON pol.id=grl.purchase_order_line_id
     AND pol.tenant_id=grl.tenant_id
     AND pol.factory_id=grl.factory_id
     AND pol.purchase_order_id=grl.purchase_order_id
    JOIN purchase_orders po
      ON po.id=pol.purchase_order_id
     AND po.tenant_id=pol.tenant_id
     AND po.factory_id=pol.factory_id
    JOIN suppliers s
      ON s.id=po.supplier_id
     AND s.tenant_id=po.tenant_id
   WHERE grl.tenant_id=$1
     AND grl.factory_id=$2
     AND grl.accepted_quantity>0
     AND gr.status='POSTED'
     AND po.status='APPROVED'
     AND (grl.id::text=$3
       OR (gr.receipt_number || ':' || po.po_number || ':' || pol.line_number::text)=$3)
   LIMIT 2;

EXPLAIN (COSTS OFF)
EXECUTE factoryos_supplier_invoice_grn_po_source(
  'faaab63d-c447-46ce-950d-deebdd7f5f30',
  '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
  '00000000-0000-0000-0000-000000000000'
);
DEALLOCATE factoryos_supplier_invoice_grn_po_source;

ROLLBACK;
