BEGIN;
INSERT INTO permissions (code, description)
VALUES ('suppliers.performance.read', 'Read factory-scoped supplier delivery and GRN-linked quality evidence without calculating a score')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'suppliers.performance.read'
WHERE r.code IN ('ORG_ADMIN', 'FACTORY_MANAGER', 'QUALITY_MANAGER')
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_expected_delivery
  ON purchase_orders (tenant_id, factory_id, supplier_id, expected_delivery_date, id)
  WHERE status = 'APPROVED' AND expected_delivery_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quality_supplier_events_supplier_grn_line_date
  ON quality_supplier_quality_events (tenant_id, factory_id, supplier_id, goods_receipt_line_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.factoryos_supplier_performance_report(
  p_factory_id UUID, p_supplier_id UUID, p_from_date DATE, p_to_date DATE, p_as_of_date DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $supplier_performance$
DECLARE
  v_tenant_id UUID := public.factoryos_current_tenant_id();
  v_as_of_date DATE := COALESCE(p_as_of_date, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date);
  v_report JSONB;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'supplier performance report requires a verified tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_factory_id IS NULL OR p_supplier_id IS NULL OR p_from_date IS NULL OR p_to_date IS NULL
     OR p_from_date > p_to_date OR (p_to_date - p_from_date) > 365 THEN
    RAISE EXCEPTION 'supplier performance report requires a valid factory, supplier and inclusive date range of at most 366 days'
      USING ERRCODE = '22023';
  END IF;

  WITH bounds AS (
    SELECT p_from_date AS from_date, p_to_date AS to_date, v_as_of_date AS as_of_date,
      ((v_as_of_date + 1)::timestamp AT TIME ZONE 'UTC') AS as_of_exclusive
  ),
  factory_scope AS (
    SELECT id FROM public.factories WHERE id = p_factory_id AND tenant_id = v_tenant_id
  ),
  supplier_scope AS (
    SELECT id, code, name FROM public.suppliers WHERE id = p_supplier_id AND tenant_id = v_tenant_id
  ),
  approved_purchase_orders AS (
    SELECT po.id, po.tenant_id, po.factory_id, po.supplier_id, po.po_number,
      po.order_date, po.expected_delivery_date, po.currency
    FROM public.purchase_orders po
    JOIN factory_scope fs ON fs.id = po.factory_id
    JOIN supplier_scope ss ON ss.id = po.supplier_id
    CROSS JOIN bounds b
    WHERE po.tenant_id = v_tenant_id AND po.status = 'APPROVED'
      AND po.approved_at IS NOT NULL AND po.approved_at < b.as_of_exclusive
      AND (po.expected_delivery_date BETWEEN b.from_date AND b.to_date
        OR (po.expected_delivery_date IS NULL AND po.order_date BETWEEN b.from_date AND b.to_date))
  ),
  due_lines AS (
    SELECT po.id AS purchase_order_id, po.po_number, po.supplier_id, po.order_date,
      po.expected_delivery_date, po.currency, pol.id AS purchase_order_line_id, pol.line_number,
      pol.inventory_item_id, pol.description, pol.quantity AS ordered_quantity, upper(btrim(pol.unit)) AS unit
    FROM approved_purchase_orders po
    JOIN public.purchase_order_lines pol
      ON pol.purchase_order_id = po.id AND pol.tenant_id = po.tenant_id AND pol.factory_id = po.factory_id
    WHERE po.expected_delivery_date IS NOT NULL
  ),
  posted_receipt_lines AS (
    SELECT dl.purchase_order_id, dl.purchase_order_line_id, dl.ordered_quantity,
      gr.id AS goods_receipt_id, gr.receipt_number, gr.posted_at, grl.id AS goods_receipt_line_id,
      grl.received_quantity, grl.accepted_quantity, grl.rejected_quantity
    FROM due_lines dl
    JOIN public.goods_receipt_lines grl ON grl.purchase_order_line_id = dl.purchase_order_line_id
    JOIN public.goods_receipts gr ON gr.id = grl.goods_receipt_id
      AND gr.tenant_id = grl.tenant_id AND gr.factory_id = grl.factory_id
      AND gr.purchase_order_id = dl.purchase_order_id AND gr.status = 'POSTED' AND gr.posted_at IS NOT NULL
    CROSS JOIN bounds b
    WHERE grl.tenant_id = v_tenant_id AND grl.factory_id = p_factory_id
      AND grl.purchase_order_id = dl.purchase_order_id AND gr.posted_at < b.as_of_exclusive
  ),
  receipt_progress AS (
    SELECT pr.*, SUM(pr.received_quantity) OVER (
      PARTITION BY pr.purchase_order_line_id
      ORDER BY pr.posted_at, pr.goods_receipt_id, pr.goods_receipt_line_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_received_quantity
    FROM posted_receipt_lines pr
  ),
  receipt_totals AS (
    SELECT rp.purchase_order_line_id,
      SUM(rp.received_quantity)::numeric(18,4) AS received_quantity,
      SUM(rp.accepted_quantity)::numeric(18,4) AS accepted_quantity,
      SUM(rp.rejected_quantity)::numeric(18,4) AS rejected_quantity,
      MIN(rp.posted_at) FILTER (WHERE rp.cumulative_received_quantity >= rp.ordered_quantity) AS completed_at
    FROM receipt_progress rp GROUP BY rp.purchase_order_line_id
  ),
  line_evidence AS (
    SELECT dl.*, COALESCE(rt.received_quantity,0)::numeric(18,4) AS received_quantity,
      COALESCE(rt.accepted_quantity,0)::numeric(18,4) AS accepted_quantity,
      COALESCE(rt.rejected_quantity,0)::numeric(18,4) AS rejected_quantity,
      GREATEST(dl.ordered_quantity-COALESCE(rt.received_quantity,0),0)::numeric(18,4) AS outstanding_quantity,
      rt.completed_at, (rt.completed_at AT TIME ZONE 'UTC')::date AS completion_date_utc,
      CASE WHEN rt.completed_at IS NOT NULL AND (rt.completed_at AT TIME ZONE 'UTC')::date <= dl.expected_delivery_date
        THEN 'ON_TIME'
        WHEN rt.completed_at IS NOT NULL THEN 'LATE'
        WHEN dl.expected_delivery_date < b.as_of_date THEN 'OVERDUE_OPEN'
        ELSE 'OPEN_NOT_DUE' END AS delivery_status
    FROM due_lines dl LEFT JOIN receipt_totals rt ON rt.purchase_order_line_id = dl.purchase_order_line_id
    CROSS JOIN bounds b
  ),
  summary_stats AS (
    SELECT
      (SELECT COUNT(*)::integer FROM approved_purchase_orders) AS approved_purchase_order_count,
      (SELECT COUNT(*)::integer FROM approved_purchase_orders WHERE expected_delivery_date IS NOT NULL) AS due_purchase_order_count,
      (SELECT COUNT(*)::integer FROM approved_purchase_orders WHERE expected_delivery_date IS NULL) AS undated_approved_po_count,
      COUNT(*)::integer AS due_line_count,
      COUNT(*) FILTER (WHERE delivery_status IN ('ON_TIME','LATE'))::integer AS completed_line_count,
      COUNT(*) FILTER (WHERE delivery_status='ON_TIME')::integer AS on_time_complete_line_count,
      COUNT(*) FILTER (WHERE delivery_status='LATE')::integer AS late_complete_line_count,
      COUNT(*) FILTER (WHERE delivery_status='OVERDUE_OPEN')::integer AS overdue_open_line_count,
      COUNT(*) FILTER (WHERE delivery_status='OPEN_NOT_DUE')::integer AS open_not_due_line_count
    FROM line_evidence
  ),
  supplier_quality_events AS (
    SELECT q.id AS event_id, q.defect_id, q.inspection_id, q.goods_receipt_id, q.goods_receipt_line_id,
      q.event_type, q.defect_code, q.severity, q.affected_quantity, q.created_at,
      pr.receipt_number, dl.po_number, dl.purchase_order_line_id, dl.line_number, dl.unit
    FROM public.quality_supplier_quality_events q
    JOIN posted_receipt_lines pr ON pr.goods_receipt_line_id=q.goods_receipt_line_id AND pr.goods_receipt_id=q.goods_receipt_id
    JOIN due_lines dl ON dl.purchase_order_line_id=pr.purchase_order_line_id
    CROSS JOIN bounds b
    WHERE q.tenant_id=v_tenant_id AND q.factory_id=p_factory_id AND q.supplier_id=p_supplier_id
      AND q.created_at < b.as_of_exclusive
  ),
  quality_by_defect AS (
    SELECT severity, defect_code, unit, COUNT(*)::integer AS event_count,
      COUNT(DISTINCT defect_id)::integer AS distinct_defect_count,
      SUM(affected_quantity)::numeric(18,4) AS affected_quantity
    FROM supplier_quality_events GROUP BY severity, defect_code, unit
  ),
  quality_stats AS (
    SELECT COUNT(*)::integer AS event_count, COUNT(DISTINCT defect_id)::integer AS distinct_defect_count
    FROM supplier_quality_events
  )
  SELECT jsonb_build_object(
    'supplier',(SELECT jsonb_build_object('id',s.id,'code',s.code,'name',s.name) FROM supplier_scope s),
    'period',jsonb_build_object('from',p_from_date,'to',p_to_date,'as_of',v_as_of_date,
      'date_comparison_timezone','UTC','as_of_inclusive_through_utc_day',TRUE),
    'summary',jsonb_build_object(
      'approved_purchase_order_count',ss.approved_purchase_order_count,
      'due_purchase_order_count',ss.due_purchase_order_count,'undated_approved_po_count',ss.undated_approved_po_count,
      'due_line_count',ss.due_line_count,'completed_line_count',ss.completed_line_count,
      'on_time_complete_line_count',ss.on_time_complete_line_count,'late_complete_line_count',ss.late_complete_line_count,
      'overdue_open_line_count',ss.overdue_open_line_count,'open_not_due_line_count',ss.open_not_due_line_count,
      'completion_rate_percent',CASE WHEN ss.due_line_count=0 THEN NULL ELSE ROUND(ss.completed_line_count::numeric*100/ss.due_line_count,2) END,
      'on_time_rate_percent',CASE WHEN ss.completed_line_count=0 THEN NULL ELSE ROUND(ss.on_time_complete_line_count::numeric*100/ss.completed_line_count,2) END),
    'quantities_by_unit',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('unit',qty.unit,'line_count',qty.line_count,
        'ordered_quantity',qty.ordered_quantity,'received_quantity',qty.received_quantity,
        'accepted_quantity',qty.accepted_quantity,'rejected_quantity',qty.rejected_quantity,
        'outstanding_quantity',qty.outstanding_quantity) ORDER BY qty.unit)
      FROM (SELECT unit,COUNT(*)::integer AS line_count,SUM(ordered_quantity)::numeric(18,4) AS ordered_quantity,
        SUM(received_quantity)::numeric(18,4) AS received_quantity,SUM(accepted_quantity)::numeric(18,4) AS accepted_quantity,
        SUM(rejected_quantity)::numeric(18,4) AS rejected_quantity,SUM(outstanding_quantity)::numeric(18,4) AS outstanding_quantity
        FROM line_evidence GROUP BY unit) qty
    ),'[]'::jsonb),
    'delivery_exceptions',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('purchase_order_id',ex.purchase_order_id,'po_number',ex.po_number,
        'purchase_order_line_id',ex.purchase_order_line_id,'line_number',ex.line_number,'inventory_item_id',ex.inventory_item_id,
        'description',ex.description,'unit',ex.unit,'ordered_quantity',ex.ordered_quantity,
        'received_quantity',ex.received_quantity,'accepted_quantity',ex.accepted_quantity,'rejected_quantity',ex.rejected_quantity,
        'outstanding_quantity',ex.outstanding_quantity,'expected_delivery_date',ex.expected_delivery_date,
        'completion_date_utc',ex.completion_date_utc,'delivery_status',ex.delivery_status)
        ORDER BY CASE ex.delivery_status WHEN 'OVERDUE_OPEN' THEN 0 ELSE 1 END,ex.expected_delivery_date,ex.po_number,ex.line_number)
      FROM (SELECT * FROM line_evidence WHERE delivery_status IN ('LATE','OVERDUE_OPEN')
        ORDER BY CASE delivery_status WHEN 'OVERDUE_OPEN' THEN 0 ELSE 1 END,expected_delivery_date,po_number,line_number LIMIT 50) ex
    ),'[]'::jsonb),
    'delivery_exceptions_truncated',(SELECT COUNT(*)>50 FROM line_evidence WHERE delivery_status IN ('LATE','OVERDUE_OPEN')),
    'quality',jsonb_build_object('event_count',qs.event_count,'distinct_defect_count',qs.distinct_defect_count,
      'by_defect',COALESCE((SELECT jsonb_agg(jsonb_build_object('severity',qd.severity,'defect_code',qd.defect_code,
        'unit',qd.unit,'event_count',qd.event_count,'distinct_defect_count',qd.distinct_defect_count,
        'affected_quantity',qd.affected_quantity) ORDER BY qd.severity,qd.defect_code,qd.unit) FROM quality_by_defect qd),'[]'::jsonb),
      'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('event_id',qe.event_id,'event_type',qe.event_type,
        'defect_id',qe.defect_id,'inspection_id',qe.inspection_id,'defect_code',qe.defect_code,'severity',qe.severity,
        'affected_quantity',qe.affected_quantity,'unit',qe.unit,'po_number',qe.po_number,'po_line_number',qe.line_number,
        'goods_receipt_id',qe.goods_receipt_id,'receipt_number',qe.receipt_number,
        'goods_receipt_line_id',qe.goods_receipt_line_id,'created_at',qe.created_at)
        ORDER BY qe.created_at DESC,qe.event_id)
        FROM (SELECT * FROM supplier_quality_events ORDER BY created_at DESC,event_id LIMIT 50) qe),'[]'::jsonb),
      'evidence_truncated',(SELECT COUNT(*)>50 FROM supplier_quality_events),
      'coverage','GRN-linked quality defect events only; not a census of all supplier inspections or quality outcomes'),
    'methodology',jsonb_build_object(
      'delivery_progress_basis','POSTED GRN physical received_quantity, including rejected units',
      'completion_basis','first posted_at at which cumulative physical receipt reaches PO line ordered quantity, excluding future-as-of GRNs',
      'quantity_grouping','quantities are grouped by PO line unit; units are never added across UOMs',
      'supplier_score','NOT_CALCULATED','supplier_ranking','NOT_CALCULATED','automatic_supplier_recommendation','NOT_PROVIDED')
  ) INTO v_report FROM summary_stats ss CROSS JOIN quality_stats qs;

  RETURN v_report;
END;
$supplier_performance$;

REVOKE ALL ON FUNCTION public.factoryos_supplier_performance_report(UUID,UUID,DATE,DATE,DATE) FROM PUBLIC;
INSERT INTO schema_migrations (version,checksum)
VALUES ('239_supplier_performance_evidence',NULL) ON CONFLICT (version) DO NOTHING;
COMMENT ON FUNCTION public.factoryos_supplier_performance_report(UUID,UUID,DATE,DATE,DATE) IS
 'Read-only tenant/factory-scoped evidence from approved PO, posted GRN and immutable GRN-linked defect events; no weighted supplier score or ranking.';
COMMIT;
