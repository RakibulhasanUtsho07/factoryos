-- Populated rework inventory acceptance: consume quarantined source, verify output, post recovered quantity.
BEGIN;

DO $rework_inventory_fixture$
DECLARE
  v_tenant UUID := gen_random_uuid();
  v_factory UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_completer UUID := gen_random_uuid();
  v_verifier UUID := gen_random_uuid();
  v_approver UUID := gen_random_uuid();
  v_supplier UUID := gen_random_uuid();
  v_purchase_order UUID := gen_random_uuid();
  v_po_line UUID := gen_random_uuid();
  v_receipt UUID := gen_random_uuid();
  v_receipt_line UUID;
  v_item UUID := gen_random_uuid();
  v_location UUID;
  v_source_unit UUID := gen_random_uuid();
  v_output_unit UUID := gen_random_uuid();
  v_source_inspection UUID := gen_random_uuid();
  v_followup_inspection UUID := gen_random_uuid();
  v_hold UUID := gen_random_uuid();
  v_rework_disposition UUID := gen_random_uuid();
  v_defect UUID := gen_random_uuid();
  v_source_link UUID := gen_random_uuid();
  v_output_link UUID := gen_random_uuid();
  v_rework UUID := gen_random_uuid();
  v_cancel_inspection UUID := gen_random_uuid();
  v_cancel_defect UUID := gen_random_uuid();
  v_cancel_source_link UUID := gen_random_uuid();
  v_cancel_rework UUID := gen_random_uuid();
  v_cancel_issue_movement UUID;
  v_cancel_restore_movement UUID;
  v_cancel_quantity_after NUMERIC(18,4);
  v_correlation UUID := gen_random_uuid();
  v_request UUID := gen_random_uuid();
  v_movement UUID := gen_random_uuid();
  v_quantity_after NUMERIC(18,4);
  v_total NUMERIC(18,4);
  v_version INTEGER;
BEGIN
  INSERT INTO tenants (id,slug,name)
  VALUES (v_tenant,'quality-rework-'||v_tenant::text,'Quality Rework Inventory Test Tenant');
  INSERT INTO users (id,display_name) VALUES
    (v_actor,'Rework Operator'),
    (v_completer,'Rework Completer'),
    (v_verifier,'Independent Rework Verifier'),
    (v_approver,'Independent GRN Approver');
  INSERT INTO factories (id,tenant_id,code,name,status)
  VALUES (v_factory,v_tenant,'QWR-'||upper(substr(v_factory::text,1,8)),'Quality Rework Inventory Factory','ACTIVE');

  PERFORM set_config('app.tenant_id',v_tenant::text,TRUE);
  PERFORM set_config('app.user_id',v_actor::text,TRUE);
  PERFORM set_config('app.request_id',v_request::text,TRUE);
  PERFORM set_config('app.trace_id',v_correlation::text,TRUE);

  INSERT INTO inventory_items (id,tenant_id,factory_id,sku,name,unit,created_by_user_id)
  VALUES (v_item,v_tenant,v_factory,'QWR-SKU-'||upper(substr(v_item::text,1,8)),'Quarantined rework source','PCS',v_actor);
  INSERT INTO inventory_stock_balances (tenant_id,factory_id,item_id,quantity_on_hand)
  VALUES (v_tenant,v_factory,v_item,0);
  SELECT id INTO v_location FROM inventory_locations
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND is_default=TRUE AND status='ACTIVE';
  IF v_location IS NULL THEN RAISE EXCEPTION 'Rework test requires a default active inventory location'; END IF;

  -- Material stock originates from a persisted PO and approved GRN in this same fixture.
  -- The lot, GRN line, supplier, quality hold and rework orders share the same identifiers.
  INSERT INTO suppliers (id,tenant_id,code,name,created_by_user_id)
  VALUES (v_supplier,v_tenant,'QWR-SUP-'||upper(substr(v_supplier::text,1,8)),'Rework Test Supplier',v_actor);

  INSERT INTO purchase_orders (id,tenant_id,factory_id,supplier_id,po_number,status,created_by_user_id)
  VALUES (v_purchase_order,v_tenant,v_factory,v_supplier,
    'QWR-PO-'||upper(substr(v_purchase_order::text,1,8)),'DRAFT',v_actor);
  INSERT INTO purchase_order_lines (
    id,tenant_id,factory_id,purchase_order_id,line_number,inventory_item_id,description,quantity,unit,unit_price
  ) VALUES (
    v_po_line,v_tenant,v_factory,v_purchase_order,1,v_item,'Source material for quality rework',5,'PCS',4
  );
  INSERT INTO purchase_order_status_history (
    tenant_id,factory_id,purchase_order_id,from_status,to_status,version,actor_user_id,reason
  ) VALUES (v_tenant,v_factory,v_purchase_order,NULL,'DRAFT',1,v_actor,'PO created for shared GRN/rework acceptance');

  UPDATE purchase_orders SET status='SUBMITTED',
    submitted_by_user_id=v_actor,submitted_at=clock_timestamp(),
    updated_at=clock_timestamp(),version=version+1
  WHERE id=v_purchase_order AND tenant_id=v_tenant AND factory_id=v_factory;
  INSERT INTO purchase_order_status_history (
    tenant_id,factory_id,purchase_order_id,from_status,to_status,version,actor_user_id,reason,request_id,trace_id
  ) VALUES (
    v_tenant,v_factory,v_purchase_order,'DRAFT','SUBMITTED',2,v_actor,
    'Submit shared fixture PO',v_request,v_correlation
  );

  PERFORM set_config('app.user_id',v_approver::text,TRUE);
  UPDATE purchase_orders SET status='APPROVED',
    approved_by_user_id=v_approver,approved_at=clock_timestamp(),
    updated_at=clock_timestamp(),version=version+1
  WHERE id=v_purchase_order AND tenant_id=v_tenant AND factory_id=v_factory;
  INSERT INTO purchase_order_status_history (
    tenant_id,factory_id,purchase_order_id,from_status,to_status,version,actor_user_id,reason,request_id,trace_id
  ) VALUES (
    v_tenant,v_factory,v_purchase_order,'SUBMITTED','APPROVED',3,v_approver,
    'Approve source material PO',v_request,v_correlation
  );

  PERFORM set_config('app.inventory_location_id',v_location::text,TRUE);
  INSERT INTO goods_receipts (
    id,tenant_id,factory_id,purchase_order_id,location_id,receipt_number,status,
    supplier_delivery_reference,notes,created_by_user_id,idempotency_key,request_hash,
    request_id,trace_id,correlation_id
  ) VALUES (
    v_receipt,v_tenant,v_factory,v_purchase_order,v_location,
    'QWR-GRN-'||upper(substr(v_receipt::text,1,8)),'POSTING',
    'QWR-DELIVERY-'||upper(substr(v_receipt::text,1,8)),
    'Accepted material used by the shared quality/rework fixture',v_approver,
    'qwr-grn-'||v_receipt::text,repeat('a',64),v_request,v_correlation,v_correlation
  );
  INSERT INTO goods_receipt_lines (
    tenant_id,factory_id,goods_receipt_id,purchase_order_id,purchase_order_line_id,
    inventory_item_id,received_quantity,rejected_quantity
  ) VALUES (
    v_tenant,v_factory,v_receipt,v_purchase_order,v_po_line,v_item,5,0
  ) RETURNING id INTO v_receipt_line;

  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand+5,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
  RETURNING quantity_on_hand INTO v_quantity_after;
  INSERT INTO inventory_movements (
    tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_item,v_location,'RECEIPT',5,5,v_quantity_after,
    'GRN:'||v_receipt::text||':'||v_po_line::text,repeat('b',64),'GOODS_RECEIPT',v_receipt,
    'Accepted source material receipt for rework fixture',v_approver,v_correlation
  ) RETURNING id INTO v_movement;
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'GOODS_RECEIPT',v_receipt,'PROCUREMENT.GOODS_RECEIPT_POSTED',
    jsonb_build_object('receipt_id',v_receipt,'accepted_quantity',5,'rejected_quantity',0)
  );
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,
    correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_approver,'PROCUREMENT','POSTED','GOODS_RECEIPT',v_receipt,
    v_correlation,v_request,'INTERNAL',
    jsonb_build_object('accepted_quantity',5,'rejected_quantity',0,'purchase_order_id',v_purchase_order)
  );
  UPDATE goods_receipts SET status='POSTED',posted_at=clock_timestamp()
  WHERE id=v_receipt AND tenant_id=v_tenant AND factory_id=v_factory;

  PERFORM set_config('app.user_id',v_actor::text,TRUE);
  INSERT INTO traceability_units (
    id,tenant_id,factory_id,unit_type,product_role,unit_code,barcode_value,inventory_item_id,
    quantity,unit,supplier_id,goods_receipt_id,goods_receipt_line_id,
    external_reference,status,attributes,idempotency_key,request_hash,version,
    created_by_user_id,correlation_id
  ) VALUES (
    v_source_unit,v_tenant,v_factory,'LOT','MATERIAL',
    'QWR-SOURCE-'||upper(substr(v_source_unit::text,1,8)),
    'QWR-SOURCE-BAR-'||upper(substr(v_source_unit::text,1,8)),v_item,5,'PCS',
    v_supplier,v_receipt,v_receipt_line,
    'quality-rework-source-lot','ACTIVE','{"origin":"posted-grn","fixture":"quality-rework"}'::jsonb,
    'qwr-source-unit',repeat('c',64),1,v_actor,v_correlation
  );
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_actor,'TRACEABILITY','REGISTERED','TRACEABILITY_UNIT',v_source_unit,v_correlation,v_request,'INTERNAL',
    jsonb_build_object('unit_id',v_source_unit,'quantity',5,'unit','PCS','goods_receipt_id',v_receipt,'goods_receipt_line_id',v_receipt_line)
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'TRACEABILITY_UNIT',v_source_unit,'TRACEABILITY.UNIT_REGISTERED',
    jsonb_build_object('unit_id',v_source_unit,'quantity',5,'goods_receipt_id',v_receipt,'supplier_id',v_supplier)
  );
  -- MATERIAL lot registration seeds its bounded quantity into the default UNASSIGNED
  -- bucket through traceability_unit_seed_inventory_location_balance; do not insert it twice.

  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,traceability_unit_id,
    status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_source_inspection,v_tenant,v_factory,'INVENTORY','TRACEABILITY_UNIT',v_source_unit,v_item,v_source_unit,
    'OPEN',1,'qwr-source-inspection',repeat('c',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_source_inspection,1,NULL,'OPEN','CREATED','Source unit quality inspection',
    'qwr-source-inspection-created',repeat('d',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,'QWR_SOURCE_INSPECTION_CREATED','{"status":"OPEN"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_source_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"OPEN"}'::jsonb);

  UPDATE quality_inspections SET status='ON_HOLD',row_version=row_version+1,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_source_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_source_inspection,2,'OPEN','ON_HOLD','HOLD','Defective tracked source quarantined',
    'qwr-source-inspection-hold',repeat('e',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,'QWR_SOURCE_HOLD','{"status":"ON_HOLD"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_source_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"ON_HOLD"}'::jsonb);

  INSERT INTO quality_holds (
    id,tenant_id,factory_id,inspection_id,inventory_item_id,traceability_unit_id,reason,created_by_user_id,correlation_id
  ) VALUES (
    v_hold,v_tenant,v_factory,v_source_inspection,v_item,v_source_unit,
    'Hold source stock pending controlled rework',v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,hold_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_hold,'QWR_SOURCE_HOLD_RECORDED',
    jsonb_build_object('status','ACTIVE','source_traceability_unit_id',v_source_unit),v_actor,v_correlation);

  -- Record the authorized REWORK disposition against the same held GRN-sourced lot.
  INSERT INTO quality_dispositions (
    id,tenant_id,factory_id,inspection_id,hold_id,inventory_item_id,action,status,reason,
    idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_rework_disposition,v_tenant,v_factory,v_source_inspection,v_hold,v_item,'REWORK','RECORDED',
    'Route the quarantined GRN material through controlled rework and follow-up inspection',
    'qwr-source-rework-disposition',repeat('d',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (
    tenant_id,factory_id,inspection_id,hold_id,action_type,payload,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_source_inspection,v_hold,'QWR_REWORK_DISPOSITION_RECORDED',
    jsonb_build_object('disposition_id',v_rework_disposition,'action','REWORK',
      'goods_receipt_id',v_receipt,'goods_receipt_line_id',v_receipt_line),v_actor,v_correlation
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'QUALITY_DISPOSITION',v_rework_disposition,'QUALITY.DISPOSITION_CHANGED',
    jsonb_build_object('disposition_id',v_rework_disposition,'action','REWORK','status','RECORDED',
      'goods_receipt_id',v_receipt,'goods_receipt_line_id',v_receipt_line)
  );

  INSERT INTO quality_defects (
    id,tenant_id,factory_id,inspection_id,defect_code,severity,affected_quantity,description,evidence,
    status,row_version,idempotency_key,request_hash,reported_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_defect,v_tenant,v_factory,v_source_inspection,'QWR-FABRIC-DEFECT','MAJOR',2,
    'Two units require controlled repair before stock can be released',
    '{"inspection_sheet":"QWR-QC-001","evidence_ref":"source-lot-photo"}'::jsonb,
    'OPEN',1,'qwr-defect',repeat('f',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_defect_events (
    tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_defect,NULL,'OPEN','REPORTED','Defect reported on tracked source lot',
    'qwr-defect-event',repeat('1',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (
    v_tenant,v_factory,v_source_inspection,v_defect,'QUALITY_DEFECT_REPORTED',
    jsonb_build_object('defect_code','QWR-FABRIC-DEFECT','affected_quantity',2,'source_unit_id',v_source_unit),v_actor,v_correlation
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'QUALITY_DEFECT',v_defect,'QUALITY.DEFECT_CHANGED',
    jsonb_build_object('defect_id',v_defect,'status','OPEN')
  );
  INSERT INTO quality_defect_links (
    id,tenant_id,factory_id,defect_id,link_type,traceability_unit_id,affected_quantity,link_source,
    notes,evidence,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_source_link,v_tenant,v_factory,v_defect,'TRACEABILITY_UNIT',v_source_unit,2,'INSPECTION_TARGET',
    'Inspected held lot is the source of this defect','{"inspection_sheet":"QWR-QC-001"}'::jsonb,
    'qwr-source-defect-link',repeat('2',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (
    v_tenant,v_factory,v_source_inspection,v_defect,'DEFECT_TRACEABILITY_LINKED',
    jsonb_build_object('link_id',v_source_link,'link_type','TRACEABILITY_UNIT','target_id',v_source_unit),v_actor,v_correlation
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'QUALITY_DEFECT',v_defect,'QUALITY.DEFECT_TRACEABILITY_LINKED',
    jsonb_build_object('link_id',v_source_link,'defect_id',v_defect,'target_id',v_source_unit)
  );

  INSERT INTO quality_rework_orders (
    id,tenant_id,factory_id,rework_number,defect_id,inspection_id,source_inventory_item_id,source_traceability_unit_id,
    source_goods_receipt_id,source_goods_receipt_line_id,
    input_quantity,recovered_quantity,scrap_quantity,status,reason,instructions,row_version,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_rework,v_tenant,v_factory,'QWR-'||upper(substr(v_rework::text,1,12)),v_defect,v_source_inspection,v_item,v_source_unit,
    v_receipt,v_receipt_line,2,0,0,'DRAFT','Controlled repair of held source stock','Rework and re-inspect before inventory release',1,
    'qwr-rework-order',repeat('3',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_rework,1,NULL,'DRAFT','CREATED','Rework task created',
    '{"work_instruction":"QWR-REPAIR-01"}'::jsonb,jsonb_build_object('input_quantity',2),
    'qwr-rework-created',repeat('4',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_rework,'version',1,'to_status','DRAFT'),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_rework,'QUALITY.REWORK_CHANGED','{"version":1,"status":"DRAFT"}'::jsonb);

  UPDATE quality_rework_orders SET status='APPROVED',row_version=2,
    approved_by_user_id=v_actor,approved_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_rework,2,'DRAFT','APPROVED','APPROVE','Rework plan approved',
    '{"approved_instruction":"QWR-REPAIR-01"}'::jsonb,'{"input_quantity":2}'::jsonb,
    'qwr-rework-approved',repeat('5',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_rework,'version',2,'to_status','APPROVED'),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_rework,'QUALITY.REWORK_CHANGED','{"version":2,"status":"APPROVED"}'::jsonb);

  UPDATE quality_rework_orders SET status='IN_PROGRESS',row_version=3,
    started_by_user_id=v_actor,started_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  UPDATE quality_defects SET status='REWORK',row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_defect AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1 AND status='OPEN';
  INSERT INTO quality_defect_events (
    tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_defect,'OPEN','REWORK','DISPOSITIONED','Rework task started',
    'qwr-defect-rework-transition',repeat('6',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'DEFECT_REWORK',
    '{"status":"REWORK"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_DEFECT',v_defect,'QUALITY.DEFECT_CHANGED','{"status":"REWORK"}'::jsonb);

  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_rework,3,'APPROVED','IN_PROGRESS','START','Rework processing started',
    '{"source_lot":true}'::jsonb,'{"input_quantity":2}'::jsonb,
    'qwr-rework-started',repeat('7',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_rework,'version',3,'to_status','IN_PROGRESS'),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_rework,'QUALITY.REWORK_CHANGED','{"version":3,"status":"IN_PROGRESS"}'::jsonb);

  -- Simulate the transaction used by the API service: consume 2.0000 from the held source lot and bin.
  PERFORM set_config('app.inventory_location_id',v_location::text,TRUE);
  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand-2,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND quantity_reserved=0 AND quantity_on_hand>=2
  RETURNING quantity_on_hand INTO v_quantity_after;
  UPDATE inventory_traceability_location_balances SET quantity_on_hand=quantity_on_hand-2,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND traceability_unit_id=v_source_unit
    AND location_id=v_location AND quantity_reserved=0 AND quantity_on_hand>=2;
  IF NOT FOUND OR v_quantity_after<>3 THEN RAISE EXCEPTION 'Rework input did not conserve source stock'; END IF;
  INSERT INTO inventory_movements (
    tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_item,v_location,'ISSUE',2,-2,v_quantity_after,
    'qwr-rework-input-1',repeat('8',64),'QUALITY_REWORK_INPUT',v_rework,
    'Source quantity consumed for controlled rework',v_actor,v_correlation
  ) RETURNING id INTO v_movement;
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_actor,'INVENTORY','STOCK_ISSUE','INVENTORY_MOVEMENT',v_movement,v_correlation,v_request,'INTERNAL',
    jsonb_build_object('rework_order_id',v_rework,'quantity',2,'quantity_after',v_quantity_after,'traceability_unit_id',v_source_unit)
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'INVENTORY_ITEM',v_item,'INVENTORY.STOCK_ISSUED',
    jsonb_build_object('movement_id',v_movement,'rework_order_id',v_rework,'quantity',2,'quantity_after',v_quantity_after)
  );

  -- Register the recovered identity; its stock is not counted until the independent follow-up PASS.
  PERFORM set_config('app.user_id',v_completer::text,TRUE);
  INSERT INTO traceability_units (
    id,tenant_id,factory_id,unit_type,product_role,unit_code,barcode_value,inventory_item_id,
    quantity,unit,external_reference,status,attributes,idempotency_key,request_hash,version,
    created_by_user_id,correlation_id
  ) VALUES (
    v_output_unit,v_tenant,v_factory,'LOT','FINISHED_GOOD',
    'QWR-OUTPUT-'||upper(substr(v_output_unit::text,1,8)),
    'QWR-OUTPUT-BAR-'||upper(substr(v_output_unit::text,1,8)),v_item,1.5,'PCS',
    'quality-rework-output-fixture','ACTIVE','{"origin":"quality-rework-output"}'::jsonb,
    'qwr-output-unit',repeat('9',64),1,v_completer,v_correlation
  );
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_completer,'TRACEABILITY','REGISTERED','TRACEABILITY_UNIT',v_output_unit,v_correlation,v_request,'INTERNAL',
    jsonb_build_object('unit_id',v_output_unit,'quantity',1.5,'source_rework_order_id',v_rework)
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'TRACEABILITY_UNIT',v_output_unit,'TRACEABILITY.UNIT_REGISTERED',
    jsonb_build_object('unit_id',v_output_unit,'quantity',1.5,'source_rework_order_id',v_rework)
  );

  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,traceability_unit_id,
    status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_followup_inspection,v_tenant,v_factory,'INVENTORY','TRACEABILITY_UNIT',v_output_unit,v_item,v_output_unit,
    'OPEN',1,'qwr-output-followup',repeat('a',64),v_completer,v_completer,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_followup_inspection,1,NULL,'OPEN','CREATED','Inspection of recovered rework output',
    'qwr-output-followup-created',repeat('b',64),v_completer,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_followup_inspection,'QWR_OUTPUT_FOLLOWUP_CREATED','{"status":"OPEN"}'::jsonb,v_completer,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_followup_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"OPEN"}'::jsonb);

  UPDATE quality_rework_orders SET status='COMPLETED',row_version=4,
    recovered_quantity=1.5,scrap_quantity=0.5,output_traceability_unit_id=v_output_unit,follow_up_inspection_id=v_followup_inspection,
    completion_reason='Recovered 1.5000; scrapped 0.5000',completed_by_user_id=v_completer,completed_at=clock_timestamp(),
    updated_by_user_id=v_completer,updated_at=clock_timestamp()
  WHERE id=v_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_rework,4,'IN_PROGRESS','COMPLETED','COMPLETE','Rework output recorded for inspection',
    '{"completion_sheet":"QWR-OUTPUT-SHEET-01"}'::jsonb,
    jsonb_build_object('input_quantity',2,'recovered_quantity',1.5,'scrap_quantity',0.5,'output_traceability_unit_id',v_output_unit,'follow_up_inspection_id',v_followup_inspection),
    'qwr-rework-completed',repeat('c',64),v_completer,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_rework,'version',4,'to_status','COMPLETED','recovered_quantity',1.5,'scrap_quantity',0.5),v_completer,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'QUALITY_REWORK',v_rework,'QUALITY.REWORK_CHANGED',
    '{"version":4,"status":"COMPLETED","recovered_quantity":1.5,"scrap_quantity":0.5}'::jsonb
  );
  INSERT INTO quality_defect_links (
    id,tenant_id,factory_id,defect_id,link_type,traceability_unit_id,rework_order_id,affected_quantity,
    link_source,notes,evidence,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_output_link,v_tenant,v_factory,v_defect,'REWORK_OUTPUT',v_output_unit,v_rework,1.5,'REWORK_OUTPUT',
    'Recovered output identity is linked to its source defect',
    jsonb_build_object('rework_order_id',v_rework,'follow_up_inspection_id',v_followup_inspection),
    'qwr-output-defect-link',repeat('d',64),v_completer,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'DEFECT_TRACEABILITY_LINKED',
    jsonb_build_object('link_id',v_output_link,'link_type','REWORK_OUTPUT','target_id',v_output_unit),v_completer,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'QUALITY_DEFECT',v_defect,'QUALITY.DEFECT_TRACEABILITY_LINKED',
    jsonb_build_object('link_id',v_output_link,'defect_id',v_defect,'target_id',v_output_unit)
  );

  PERFORM set_config('app.user_id',v_verifier::text,TRUE);
  UPDATE quality_inspections SET status='IN_PROGRESS',row_version=2,updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_followup_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_followup_inspection,2,'OPEN','IN_PROGRESS','START','Follow-up inspection started',
    'qwr-output-followup-start',repeat('e',64),v_verifier,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_followup_inspection,'QWR_OUTPUT_FOLLOWUP_STARTED','{"status":"IN_PROGRESS"}'::jsonb,v_verifier,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_followup_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"IN_PROGRESS"}'::jsonb);

  UPDATE quality_inspections SET status='PASSED',row_version=3,updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_followup_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_followup_inspection,3,'IN_PROGRESS','PASSED','PASS','Recovered output passed the follow-up inspection',
    'qwr-output-followup-pass',repeat('f',64),v_verifier,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_followup_inspection,'QWR_OUTPUT_FOLLOWUP_PASSED','{"status":"PASSED"}'::jsonb,v_verifier,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_followup_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"PASSED"}'::jsonb);

  UPDATE quality_rework_orders SET status='VERIFIED',row_version=5,
    verified_by_user_id=v_verifier,verified_at=clock_timestamp(),verification_reason='Independent review of output quantity and follow-up PASS',
    updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=4;
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_rework,5,'COMPLETED','VERIFIED','VERIFY_PASS','Independent rework verification passed',
    '{"verification_sheet":"QWR-VERIFY-01"}'::jsonb,'{"recovered_quantity":1.5,"scrap_quantity":0.5}'::jsonb,
    'qwr-rework-verified',repeat('1',64),v_verifier,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_source_inspection,v_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_rework,'version',5,'to_status','VERIFIED'),v_verifier,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_rework,'QUALITY.REWORK_CHANGED','{"version":5,"status":"VERIFIED"}'::jsonb);

  -- The recovered lot is added only after independent verification and a PASS on that exact identity.
  PERFORM set_config('app.inventory_location_id',v_location::text,TRUE);
  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand+1.5,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
  RETURNING quantity_on_hand INTO v_quantity_after;
  INSERT INTO inventory_movements (
    tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_item,v_location,'RECEIPT',1.5,1.5,v_quantity_after,
    'qwr-rework-output-receipt',repeat('2',64),'QUALITY_REWORK_OUTPUT',v_rework,
    'Verified recovered output posted to stock ledger',v_verifier,v_correlation
  ) RETURNING id INTO v_movement;
  INSERT INTO inventory_traceability_location_balances (
    tenant_id,factory_id,item_id,traceability_unit_id,location_id,quantity_on_hand,quantity_reserved
  ) VALUES (v_tenant,v_factory,v_item,v_output_unit,v_location,1.5,0);
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_verifier,'INVENTORY','STOCK_RECEIPT','INVENTORY_MOVEMENT',v_movement,v_correlation,v_request,'INTERNAL',
    jsonb_build_object('rework_order_id',v_rework,'output_unit_id',v_output_unit,'quantity',1.5,'quantity_after',v_quantity_after)
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'INVENTORY_ITEM',v_item,'INVENTORY.STOCK_RECEIVED',
    jsonb_build_object('movement_id',v_movement,'rework_order_id',v_rework,'output_unit_id',v_output_unit,'quantity',1.5)
  );

  PERFORM set_config('app.user_id',v_verifier::text,TRUE);
  UPDATE quality_defects SET status='RESOLVED',row_version=row_version+1,updated_by_user_id=v_verifier,updated_at=clock_timestamp()
  WHERE id=v_defect AND tenant_id=v_tenant AND factory_id=v_factory AND status='REWORK' AND row_version=2;
  INSERT INTO quality_defect_events (
    tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_defect,'REWORK','RESOLVED','RESOLVED','Verified recovered output passed follow-up inspection',
    'qwr-defect-resolved',repeat('3',64),v_verifier,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (
    v_tenant,v_factory,v_source_inspection,v_defect,'DEFECT_RESOLVED',
    jsonb_build_object('rework_order_id',v_rework,'status','RESOLVED'),v_verifier,v_correlation
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_DEFECT',v_defect,'QUALITY.DEFECT_CHANGED','{"status":"RESOLVED"}'::jsonb);


  -- Exercise cancellation separately: a fully issued rework task must return the exact
  -- source lot quantity to the same bin, rather than creating recovered output.
  PERFORM set_config('app.user_id',v_actor::text,TRUE);

  -- Use a valid in-progress inspection for the second defect; the original inspection remains ON_HOLD.
  INSERT INTO quality_inspections (
    id,tenant_id,factory_id,inspection_type,target_type,target_id,inventory_item_id,traceability_unit_id,
    status,row_version,idempotency_key,request_hash,created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_cancel_inspection,v_tenant,v_factory,'INVENTORY','TRACEABILITY_UNIT',v_source_unit,v_item,v_source_unit,
    'OPEN',1,'qwr-cancel-inspection',repeat('4',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_inspection,1,NULL,'OPEN','CREATED','Cancellation stock restoration inspection',
    'qwr-cancel-inspection-created',repeat('5',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,'QWR_CANCEL_INSPECTION_CREATED','{"status":"OPEN"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_cancel_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"OPEN"}'::jsonb);
  UPDATE quality_inspections SET status='IN_PROGRESS',row_version=2,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_cancel_inspection AND tenant_id=v_tenant AND factory_id=v_factory AND status='OPEN' AND row_version=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation inspection could not enter IN_PROGRESS'; END IF;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_inspection,2,'OPEN','IN_PROGRESS','START','Begin cancellation fixture inspection',
    'qwr-cancel-inspection-start',repeat('6',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,'QWR_CANCEL_INSPECTION_STARTED','{"status":"IN_PROGRESS"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_cancel_inspection,'QUALITY.INSPECTION_CHANGED','{"status":"IN_PROGRESS"}'::jsonb);

  INSERT INTO quality_defects (
    id,tenant_id,factory_id,inspection_id,defect_code,severity,affected_quantity,description,evidence,
    status,row_version,idempotency_key,request_hash,reported_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_cancel_defect,v_tenant,v_factory,v_cancel_inspection,'QWR-CANCEL-DEFECT','MINOR',1,
    'One additional unit is used to prove cancelled rework restores its source stock',
    '{"inspection_sheet":"QWR-CANCEL-QC-001","evidence_ref":"cancel-source-lot"}'::jsonb,
    'OPEN',1,'qwr-cancel-defect',repeat('4',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_defect_events (
    tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_defect,NULL,'OPEN','REPORTED','Cancellation stock-restoration test defect',
    'qwr-cancel-defect-event',repeat('5',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'QUALITY_DEFECT_REPORTED',
    jsonb_build_object('defect_code','QWR-CANCEL-DEFECT','affected_quantity',1,'source_unit_id',v_source_unit),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_DEFECT',v_cancel_defect,'QUALITY.DEFECT_CHANGED','{"status":"OPEN"}'::jsonb);

  INSERT INTO quality_defect_links (
    id,tenant_id,factory_id,defect_id,link_type,traceability_unit_id,affected_quantity,link_source,
    notes,evidence,idempotency_key,request_hash,created_by_user_id,correlation_id
  ) VALUES (
    v_cancel_source_link,v_tenant,v_factory,v_cancel_defect,'TRACEABILITY_UNIT',v_source_unit,1,'INSPECTION_TARGET',
    'Cancellation fixture is bound to the same held source lot','{"inspection_sheet":"QWR-CANCEL-QC-001"}'::jsonb,
    'qwr-cancel-source-link',repeat('6',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'DEFECT_TRACEABILITY_LINKED',
    jsonb_build_object('link_id',v_cancel_source_link,'link_type','TRACEABILITY_UNIT','target_id',v_source_unit),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_DEFECT',v_cancel_defect,'QUALITY.DEFECT_TRACEABILITY_LINKED',
    jsonb_build_object('link_id',v_cancel_source_link,'defect_id',v_cancel_defect,'target_id',v_source_unit));

  -- Rework is only permitted against a failed/held/dispositioned inspection.
  -- Hold the cancellation fixture's second inspection before creating its rework order.
  UPDATE quality_inspections SET status='ON_HOLD',row_version=3,
    updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_cancel_inspection AND tenant_id=v_tenant AND factory_id=v_factory
    AND status='IN_PROGRESS' AND row_version=2;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation inspection could not be placed on hold before rework'; END IF;
  INSERT INTO quality_inspection_events (
    tenant_id,factory_id,inspection_id,version,from_status,to_status,action,reason,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_inspection,3,'IN_PROGRESS','ON_HOLD','HOLD',
    'Quarantine source inspection before rework cancellation test',
    'qwr-cancel-inspection-hold',repeat('8',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,'QWR_CANCEL_INSPECTION_HOLD',
    '{"status":"ON_HOLD","rework_source_gate":true}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_INSPECTION',v_cancel_inspection,'QUALITY.INSPECTION_CHANGED',
    '{"status":"ON_HOLD","reason":"rework source quarantine"}'::jsonb);

  INSERT INTO quality_rework_orders (
    id,tenant_id,factory_id,rework_number,defect_id,inspection_id,source_inventory_item_id,source_traceability_unit_id,
    source_goods_receipt_id,source_goods_receipt_line_id,
    input_quantity,recovered_quantity,scrap_quantity,status,reason,instructions,row_version,idempotency_key,request_hash,
    created_by_user_id,updated_by_user_id,correlation_id
  ) VALUES (
    v_cancel_rework,v_tenant,v_factory,'QWR-CANCEL-'||upper(substr(v_cancel_rework::text,1,10)),
    v_cancel_defect,v_cancel_inspection,v_item,v_source_unit,v_receipt,v_receipt_line,1,0,0,'DRAFT',
    'Cancellation must restore held source stock','Cancel before recovery or scrap is recorded',1,
    'qwr-cancel-rework-order',repeat('7',64),v_actor,v_actor,v_correlation
  );
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_rework,1,NULL,'DRAFT','CREATED','Cancellation inventory fixture created',
    '{"work_instruction":"QWR-CANCEL-01"}'::jsonb,'{"input_quantity":1}'::jsonb,
    'qwr-cancel-rework-created',repeat('8',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_cancel_rework,'version',1,'to_status','DRAFT'),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_cancel_rework,'QUALITY.REWORK_CHANGED','{"version":1,"status":"DRAFT"}'::jsonb);

  UPDATE quality_rework_orders SET status='APPROVED',row_version=2,
    approved_by_user_id=v_actor,approved_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_cancel_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=1;
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_rework,2,'DRAFT','APPROVED','APPROVE','Approve cancellation fixture',
    '{"approved_instruction":"QWR-CANCEL-01"}'::jsonb,'{"input_quantity":1}'::jsonb,
    'qwr-cancel-rework-approved',repeat('9',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_cancel_rework,'version',2,'to_status','APPROVED'),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_cancel_rework,'QUALITY.REWORK_CHANGED','{"version":2,"status":"APPROVED"}'::jsonb);

  UPDATE quality_rework_orders SET status='IN_PROGRESS',row_version=3,
    started_by_user_id=v_actor,started_at=clock_timestamp(),updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_cancel_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=2;
  UPDATE quality_defects SET status='REWORK',row_version=row_version+1,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_cancel_defect AND tenant_id=v_tenant AND factory_id=v_factory AND status='OPEN';
  INSERT INTO quality_defect_events (
    tenant_id,factory_id,defect_id,from_status,to_status,action,reason,idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_defect,'OPEN','REWORK','DISPOSITIONED','Cancellation rework task started',
    'qwr-cancel-defect-rework',repeat('a',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'DEFECT_REWORK','{"status":"REWORK"}'::jsonb,v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_DEFECT',v_cancel_defect,'QUALITY.DEFECT_CHANGED','{"status":"REWORK"}'::jsonb);
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_rework,3,'APPROVED','IN_PROGRESS','START','Start then cancel controlled rework',
    '{"source_lot":true}'::jsonb,'{"input_quantity":1}'::jsonb,
    'qwr-cancel-rework-started',repeat('b',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_cancel_rework,'version',3,'to_status','IN_PROGRESS'),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_cancel_rework,'QUALITY.REWORK_CHANGED','{"version":3,"status":"IN_PROGRESS"}'::jsonb);

  PERFORM set_config('app.inventory_location_id',v_location::text,TRUE);
  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand-1,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND quantity_reserved=0 AND quantity_on_hand>=1
  RETURNING quantity_on_hand INTO v_cancel_quantity_after;
  UPDATE inventory_traceability_location_balances SET quantity_on_hand=quantity_on_hand-1,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
    AND traceability_unit_id=v_source_unit AND location_id=v_location
    AND quantity_reserved=0 AND quantity_on_hand>=1;
  IF NOT FOUND OR v_cancel_quantity_after<>3.5 THEN
    RAISE EXCEPTION 'Cancellation fixture failed to consume one source unit before cancellation';
  END IF;
  INSERT INTO inventory_movements (
    tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_item,v_location,'ISSUE',1,-1,v_cancel_quantity_after,
    'qwr-cancel-input-issue',repeat('c',64),'QUALITY_REWORK_INPUT',v_cancel_rework,
    'Held source quantity consumed before cancellation',v_actor,v_correlation
  ) RETURNING id INTO v_cancel_issue_movement;
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_actor,'INVENTORY','STOCK_ISSUE','INVENTORY_MOVEMENT',v_cancel_issue_movement,
    v_correlation,v_request,'INTERNAL',
    jsonb_build_object('rework_order_id',v_cancel_rework,'quantity',1,'quantity_after',v_cancel_quantity_after,'traceability_unit_id',v_source_unit)
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'INVENTORY_ITEM',v_item,'INVENTORY.STOCK_ISSUED',
    jsonb_build_object('movement_id',v_cancel_issue_movement,'rework_order_id',v_cancel_rework,'quantity',1,'quantity_after',v_cancel_quantity_after)
  );

  UPDATE quality_rework_orders SET status='CANCELLED',row_version=4,
    cancelled_by_user_id=v_actor,cancelled_at=clock_timestamp(),cancellation_reason='Cancel and restore the original source quantity',
    completed_by_user_id=NULL,completed_at=NULL,completion_reason=NULL,recovered_quantity=0,scrap_quantity=0,
    output_traceability_unit_id=NULL,follow_up_inspection_id=NULL,verified_by_user_id=NULL,verified_at=NULL,
    verification_reason=NULL,updated_by_user_id=v_actor,updated_at=clock_timestamp()
  WHERE id=v_cancel_rework AND tenant_id=v_tenant AND factory_id=v_factory AND row_version=3;
  INSERT INTO quality_rework_events (
    tenant_id,factory_id,rework_order_id,version,from_status,to_status,command,reason,evidence,payload,
    idempotency_key,request_hash,actor_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_cancel_rework,4,'IN_PROGRESS','CANCELLED','CANCEL','Restore all issued input on cancellation',
    '{"cancellation_sheet":"QWR-CANCEL-01"}'::jsonb,
    '{"input_quantity":1,"recovered_quantity":0,"scrap_quantity":0}'::jsonb,
    'qwr-cancel-rework-cancelled',repeat('d',64),v_actor,v_correlation
  );
  INSERT INTO quality_audit_events (tenant_id,factory_id,inspection_id,defect_id,action_type,payload,actor_user_id,correlation_id)
  VALUES (v_tenant,v_factory,v_cancel_inspection,v_cancel_defect,'QUALITY_REWORK_EVENT',
    jsonb_build_object('rework_order_id',v_cancel_rework,'version',4,'to_status','CANCELLED','source_restore_required',true),v_actor,v_correlation);
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (v_tenant,v_factory,'QUALITY_REWORK',v_cancel_rework,'QUALITY.REWORK_CHANGED',
    '{"version":4,"status":"CANCELLED","source_restore_required":true}'::jsonb);

  UPDATE inventory_stock_balances SET quantity_on_hand=quantity_on_hand+1,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
  RETURNING quantity_on_hand INTO v_cancel_quantity_after;
  UPDATE inventory_traceability_location_balances SET quantity_on_hand=quantity_on_hand+1,
    version=version+1,updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item
    AND traceability_unit_id=v_source_unit AND location_id=v_location;
  IF NOT FOUND OR v_cancel_quantity_after<>4.5 THEN
    RAISE EXCEPTION 'Cancelled rework did not restore the exact quantity to the source lot and aggregate stock';
  END IF;
  INSERT INTO inventory_movements (
    tenant_id,factory_id,item_id,location_id,movement_type,quantity,quantity_delta,quantity_after,
    idempotency_key,request_hash,reference_type,reference_id,notes,created_by_user_id,correlation_id
  ) VALUES (
    v_tenant,v_factory,v_item,v_location,'RECEIPT',1,1,v_cancel_quantity_after,
    'qwr-cancel-input-restore',repeat('e',64),'QUALITY_REWORK_RESTORE',v_cancel_rework,
    'Restore the original source lot and bin on rework cancellation',v_actor,v_correlation
  ) RETURNING id INTO v_cancel_restore_movement;
  INSERT INTO audit_events (
    tenant_id,factory_id,actor_user_id,event_type,action,resource_type,resource_id,correlation_id,request_id,data_class,payload
  ) VALUES (
    v_tenant,v_factory,v_actor,'INVENTORY','STOCK_RECEIPT','INVENTORY_MOVEMENT',v_cancel_restore_movement,
    v_correlation,v_request,'INTERNAL',
    jsonb_build_object('rework_order_id',v_cancel_rework,'quantity',1,'quantity_after',v_cancel_quantity_after,'traceability_unit_id',v_source_unit)
  );
  INSERT INTO outbox_events (tenant_id,factory_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES (
    v_tenant,v_factory,'INVENTORY_ITEM',v_item,'INVENTORY.STOCK_RECEIVED',
    jsonb_build_object('movement_id',v_cancel_restore_movement,'rework_order_id',v_cancel_rework,'quantity',1,'quantity_after',v_cancel_quantity_after)
  );
  IF (SELECT status FROM quality_rework_orders WHERE id=v_cancel_rework) IS DISTINCT FROM 'CANCELLED'
    OR (SELECT COALESCE(sum(quantity),0) FROM inventory_movements WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND reference_type='QUALITY_REWORK_INPUT' AND reference_id=v_cancel_rework AND movement_type='ISSUE')<>1
    OR (SELECT COALESCE(sum(quantity),0) FROM inventory_movements WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND reference_type='QUALITY_REWORK_RESTORE' AND reference_id=v_cancel_rework AND movement_type='RECEIPT')<>1
    OR EXISTS (SELECT 1 FROM inventory_movements WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id=v_cancel_rework AND movement_type='RECEIPT')
    OR NOT EXISTS (SELECT 1 FROM audit_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND resource_type='INVENTORY_MOVEMENT' AND resource_id=v_cancel_issue_movement AND action='STOCK_ISSUE')
    OR NOT EXISTS (SELECT 1 FROM outbox_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND aggregate_id=v_item AND event_type='INVENTORY.STOCK_ISSUED'
      AND payload->>'rework_order_id'=v_cancel_rework::text)
    OR NOT EXISTS (SELECT 1 FROM audit_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND resource_type='INVENTORY_MOVEMENT' AND resource_id=v_cancel_restore_movement AND action='STOCK_RECEIPT')
    OR NOT EXISTS (SELECT 1 FROM outbox_events WHERE tenant_id=v_tenant AND factory_id=v_factory
      AND aggregate_id=v_item AND event_type='INVENTORY.STOCK_RECEIVED'
      AND payload->>'rework_order_id'=v_cancel_rework::text) THEN
    RAISE EXCEPTION 'Cancelled rework must restore its full source issue and must never post recovered output';
  END IF;


  SET CONSTRAINTS ctr_goods_receipt_posted_integrity, ctr_quality_inspection_evidence,
    ctr_traceability_unit_evidence, ctr_quality_rework_inventory_reconciliation,
    ctr_quality_defect_link_audit IMMEDIATE;

  IF (SELECT status FROM purchase_orders WHERE id=v_purchase_order AND tenant_id=v_tenant AND factory_id=v_factory)
       IS DISTINCT FROM 'APPROVED'
    OR (SELECT status FROM goods_receipts WHERE id=v_receipt AND tenant_id=v_tenant AND factory_id=v_factory)
       IS DISTINCT FROM 'POSTED'
    OR NOT EXISTS (
      SELECT 1 FROM goods_receipt_lines gl
      WHERE gl.id=v_receipt_line AND gl.goods_receipt_id=v_receipt
        AND gl.purchase_order_id=v_purchase_order AND gl.purchase_order_line_id=v_po_line
        AND gl.inventory_item_id=v_item AND gl.received_quantity=5 AND gl.rejected_quantity=0
    )
    OR NOT EXISTS (
      SELECT 1 FROM inventory_movements im
      WHERE im.tenant_id=v_tenant AND im.factory_id=v_factory
        AND im.reference_type='GOODS_RECEIPT' AND im.reference_id=v_receipt
        AND im.item_id=v_item AND im.movement_type='RECEIPT'
        AND im.quantity=5 AND im.quantity_delta=5
    )
    OR NOT EXISTS (
      SELECT 1 FROM traceability_units tu
      WHERE tu.id=v_source_unit AND tu.tenant_id=v_tenant AND tu.factory_id=v_factory
        AND tu.inventory_item_id=v_item AND tu.product_role='MATERIAL' AND tu.quantity=5
        AND tu.supplier_id=v_supplier AND tu.goods_receipt_id=v_receipt
        AND tu.goods_receipt_line_id=v_receipt_line
    )
    OR (SELECT count(*) FROM quality_rework_orders r
        WHERE r.tenant_id=v_tenant AND r.factory_id=v_factory
          AND r.id IN (v_rework,v_cancel_rework)
          AND r.source_goods_receipt_id=v_receipt
          AND r.source_goods_receipt_line_id=v_receipt_line) <> 2
    OR (SELECT action FROM quality_dispositions WHERE id=v_rework_disposition) IS DISTINCT FROM 'REWORK'
    OR (SELECT status FROM quality_dispositions WHERE id=v_rework_disposition) IS DISTINCT FROM 'RECORDED'
    OR NOT EXISTS (
      SELECT 1 FROM audit_events a WHERE a.tenant_id=v_tenant AND a.factory_id=v_factory
        AND a.resource_type='GOODS_RECEIPT' AND a.resource_id=v_receipt AND a.action='POSTED'
    )
    OR NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.tenant_id=v_tenant AND o.factory_id=v_factory
        AND o.aggregate_type='GOODS_RECEIPT' AND o.aggregate_id=v_receipt
        AND o.event_type='PROCUREMENT.GOODS_RECEIPT_POSTED'
    ) THEN
    RAISE EXCEPTION 'Shared GRN/quality acceptance failed: approved PO, posted GRN, accepted stock, supplier genealogy and source-bound REWORK disposition must reconcile';
  END IF;

  SELECT quantity_on_hand INTO v_quantity_after FROM inventory_stock_balances
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item;
  SELECT COALESCE(sum(quantity_on_hand),0)::numeric(18,4) INTO v_total FROM inventory_location_balances
  WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item;
  IF v_quantity_after<>4.5 OR v_total<>4.5
    OR (SELECT quantity_on_hand FROM inventory_traceability_location_balances
        WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND traceability_unit_id=v_source_unit AND location_id=v_location)<>3
    OR (SELECT quantity_on_hand FROM inventory_traceability_location_balances
        WHERE tenant_id=v_tenant AND factory_id=v_factory AND item_id=v_item AND traceability_unit_id=v_output_unit AND location_id=v_location)<>1.5
    OR (SELECT COALESCE(sum(quantity),0) FROM inventory_movements WHERE tenant_id=v_tenant AND factory_id=v_factory
        AND reference_type='QUALITY_REWORK_INPUT' AND reference_id=v_rework AND movement_type='ISSUE')<>2
    OR (SELECT COALESCE(sum(quantity),0) FROM inventory_movements WHERE tenant_id=v_tenant AND factory_id=v_factory
        AND reference_type='QUALITY_REWORK_OUTPUT' AND reference_id=v_rework AND movement_type='RECEIPT')<>1.5
    OR (SELECT recovered_quantity+scrap_quantity FROM quality_rework_orders WHERE id=v_rework)<>2
    OR (SELECT status FROM quality_rework_orders WHERE id=v_rework)<>'VERIFIED'
    OR (SELECT status FROM quality_inspections WHERE id=v_followup_inspection)<>'PASSED'
    OR (SELECT status FROM quality_defects WHERE id=v_defect)<>'RESOLVED'
    OR (SELECT status FROM quality_holds WHERE id=v_hold)<>'ACTIVE'
    OR NOT EXISTS (SELECT 1 FROM quality_defect_links WHERE id=v_output_link AND traceability_unit_id=v_output_unit AND rework_order_id=v_rework)
    OR NOT EXISTS (SELECT 1 FROM audit_events WHERE tenant_id=v_tenant AND factory_id=v_factory AND resource_type='INVENTORY_MOVEMENT'
        AND resource_id=v_movement AND action='STOCK_RECEIPT')
    OR NOT EXISTS (SELECT 1 FROM outbox_events WHERE tenant_id=v_tenant AND factory_id=v_factory AND aggregate_id=v_item
        AND event_type='INVENTORY.STOCK_RECEIVED' AND payload->>'rework_order_id'=v_rework::text) THEN
    RAISE EXCEPTION 'Rework stock reconciliation failed: input 2.0000, recovered 1.5000, scrap 0.5000 must net to 4.5000 stock with source/output genealogy balances';
  END IF;

  RAISE NOTICE 'Rework inventory acceptance passed: held source consumed, output lot inspected/passed, independent verification, recovered receipt and scrap netting all reconcile';
END;
$rework_inventory_fixture$;

ROLLBACK;
