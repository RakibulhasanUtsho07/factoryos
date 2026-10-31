BEGIN;

-- Preserve historical unsigned decisions for audit, but never allow them to
-- become newly accepted or authorize external propagation.
ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  ADD COLUMN IF NOT EXISTS attestation_key_id varchar(100),
  ADD COLUMN IF NOT EXISTS attestation_owner_reference varchar(200),
  ADD COLUMN IF NOT EXISTS attestation_signature varchar(128);

ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  DROP CONSTRAINT IF EXISTS chk_saas_external_copy_coverage_attestation;
ALTER TABLE public.saas_tenant_external_copy_coverage_decisions
  ADD CONSTRAINT chk_saas_external_copy_coverage_attestation CHECK (
    (attestation_key_id IS NULL AND attestation_owner_reference IS NULL AND attestation_signature IS NULL)
    OR (
      attestation_key_id IS NOT NULL
      AND attestation_owner_reference IS NOT NULL
      AND attestation_signature IS NOT NULL
      AND attestation_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
      AND attestation_owner_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      AND attestation_owner_reference !~ '://'
      AND attestation_signature ~ '^[A-Za-z0-9_-]{86}$'
      AND attestation_owner_reference IN (data_owner_reference,infrastructure_owner_reference)
    )
  );

CREATE OR REPLACE FUNCTION public.factoryos_guard_saas_external_copy_coverage_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'external copy-class coverage decisions are immutable and cannot be deleted' USING ERRCODE='55000';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
      OR NEW.review_reason IS NOT NULL OR NEW.valid_until IS NOT NULL THEN
      RAISE EXCEPTION 'external copy-class coverage must enter the pending review state' USING ERRCODE='55000';
    END IF;
    IF NEW.attestation_key_id IS NULL OR NEW.attestation_owner_reference IS NULL OR NEW.attestation_signature IS NULL
      OR NEW.evidence_reference !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$' THEN
      RAISE EXCEPTION 'new external copy-class coverage requires signed opaque evidence' USING ERRCODE='55000';
    END IF;
    IF NEW.evidence_at>NEW.submitted_at+interval '5 minutes' OR NEW.evidence_at<NEW.submitted_at-interval '30 days' THEN
      RAISE EXCEPTION 'external copy-class evidence must be current at submission' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('ACCEPTED','REJECTED') THEN
    RAISE EXCEPTION 'reviewed external copy-class coverage decisions are immutable' USING ERRCODE='55000';
  END IF;
  IF (NEW.decision_id,NEW.tenant_id,NEW.category_code,NEW.store_kind,NEW.revision,NEW.disposition,NEW.evidence_reference,
      NEW.evidence_sha256,NEW.evidence_at,NEW.attestation_key_id,NEW.attestation_owner_reference,NEW.attestation_signature,
      NEW.data_owner_reference,NEW.infrastructure_owner_reference,NEW.policy_reference,NEW.reason,NEW.idempotency_key,
      NEW.request_hash,NEW.submitted_by_user_id,NEW.submitted_at)
    IS DISTINCT FROM
     (OLD.decision_id,OLD.tenant_id,OLD.category_code,OLD.store_kind,OLD.revision,OLD.disposition,OLD.evidence_reference,
      OLD.evidence_sha256,OLD.evidence_at,OLD.attestation_key_id,OLD.attestation_owner_reference,OLD.attestation_signature,
      OLD.data_owner_reference,OLD.infrastructure_owner_reference,OLD.policy_reference,OLD.reason,OLD.idempotency_key,
      OLD.request_hash,OLD.submitted_by_user_id,OLD.submitted_at) THEN
    RAISE EXCEPTION 'external copy-class evidence and scope are immutable after submission' USING ERRCODE='55000';
  END IF;
  IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id=NEW.submitted_by_user_id OR NEW.reviewed_at IS NULL
    OR NEW.review_reason IS NULL OR length(btrim(NEW.review_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'external copy-class coverage requires a separate reviewer and reason' USING ERRCODE='55000';
  END IF;
  IF NEW.evidence_at>NEW.reviewed_at+interval '5 minutes' OR NEW.evidence_at<NEW.reviewed_at-interval '30 days' THEN
    RAISE EXCEPTION 'external copy-class evidence expired before approval' USING ERRCODE='55000';
  END IF;
  IF NEW.status='ACCEPTED' THEN
    IF NEW.attestation_key_id IS NULL OR NEW.attestation_owner_reference IS NULL OR NEW.attestation_signature IS NULL THEN
      RAISE EXCEPTION 'unsigned legacy external copy-class evidence cannot be accepted' USING ERRCODE='55000';
    END IF;
    IF NEW.valid_until IS NULL OR NEW.valid_until<=NEW.reviewed_at OR NEW.valid_until>NEW.reviewed_at+interval '90 days' THEN
      RAISE EXCEPTION 'accepted external copy-class coverage must have a validity window no longer than 90 days' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.valid_until IS NOT NULL THEN
    RAISE EXCEPTION 'rejected external copy-class coverage cannot have a validity window' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS saas_tenant_external_copy_coverage_decision_guard
 ON public.saas_tenant_external_copy_coverage_decisions;
CREATE TRIGGER saas_tenant_external_copy_coverage_decision_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.saas_tenant_external_copy_coverage_decisions
 FOR EACH ROW EXECUTE FUNCTION public.factoryos_guard_saas_external_copy_coverage_decision();

INSERT INTO schema_migrations(version,checksum)
VALUES ('231_saas_external_copy_coverage_evidence_attestation',NULL)
ON CONFLICT (version) DO NOTHING;

COMMIT;
