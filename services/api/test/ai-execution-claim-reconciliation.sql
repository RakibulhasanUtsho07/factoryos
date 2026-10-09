-- B19 migration/schema regression check. Run after applying migration 028.
BEGIN;

DO $$
DECLARE
    v_rls_enabled BOOLEAN;
    v_rls_forced BOOLEAN;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM schema_migrations
        WHERE version = '028_ai_execution_claim_reconciliation'
    ) THEN
        RAISE EXCEPTION 'B19 migration marker is missing';
    END IF;

    SELECT c.relrowsecurity, c.relforcerowsecurity
      INTO v_rls_enabled, v_rls_forced
      FROM pg_class c
     WHERE c.oid = to_regclass('ai_execution_claim_reconciliations');

    IF COALESCE(v_rls_enabled, FALSE) IS NOT TRUE
       OR COALESCE(v_rls_forced, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION 'B19 reconciliation ledger must have RLS enabled and forced';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = to_regclass('ai_execution_claim_reconciliations')
          AND polname = 'ai_execution_claim_reconciliations_tenant_isolation'
    ) THEN
        RAISE EXCEPTION 'B19 tenant isolation policy is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('ai_execution_claim_reconciliations')
          AND tgname = 'trg_ai_execution_claim_reconciliation_immutable'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
    ) THEN
        RAISE EXCEPTION 'B19 append-only trigger is missing or disabled';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM permissions WHERE code = 'ai.execution.claims.read'
    ) OR NOT EXISTS (
        SELECT 1 FROM permissions WHERE code = 'ai.execution.claims.reconcile'
    ) THEN
        RAISE EXCEPTION 'B19 permissions are missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_indexes
         WHERE indexname = 'uq_ai_execution_claim_scope'
    ) THEN
        RAISE EXCEPTION 'B19 composite claim scope index is missing';
    END IF;

    RAISE NOTICE 'B19 AI execution claim reconciliation schema checks passed';
END;
$$;

ROLLBACK;
