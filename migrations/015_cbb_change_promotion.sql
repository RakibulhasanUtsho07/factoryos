BEGIN;

-- ============================================================
-- WP04-D / CBB CHANGE PROMOTION FOUNDATION
-- ============================================================
--
-- Approved business-model changes must remain tied to the
-- blueprint version from which they were proposed.
--
-- The promotion flow will later:
--
--   approved proposal
--        ->
--   create new immutable blueprint version
--        ->
--   promote blueprint current_version_id
--
-- Historical blueprint versions remain immutable.
-- ============================================================


-- ============================================================
-- SOURCE VERSION
-- ============================================================
--
-- Records the blueprint version against which the proposal was
-- created.
--
-- This allows promotion to detect:
--
--   "the blueprint changed after this proposal was created"
--
-- instead of silently applying an old proposal to a newer graph.
-- ============================================================

ALTER TABLE business_change_proposals
    ADD COLUMN IF NOT EXISTS source_version_id UUID;


-- ============================================================
-- PROMOTED VERSION
-- ============================================================
--
-- Records the immutable version created by promotion.
--
-- NULL:
--   not promoted yet
--
-- UUID:
--   promotion already materialized
-- ============================================================

ALTER TABLE business_change_proposals
    ADD COLUMN IF NOT EXISTS promoted_version_id UUID;


ALTER TABLE business_change_proposals
    ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;


-- ============================================================
-- SOURCE VERSION FOREIGN KEY
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE
            conrelid =
                'business_change_proposals'::regclass
            AND conname =
                'fk_business_change_proposals_source_version'
    ) THEN
        ALTER TABLE business_change_proposals
            ADD CONSTRAINT
                fk_business_change_proposals_source_version
            FOREIGN KEY (
                source_version_id,
                tenant_id,
                factory_id
            )
            REFERENCES business_blueprint_versions (
                id,
                tenant_id,
                factory_id
            )
            ON DELETE RESTRICT;
    END IF;
END
$$;


-- ============================================================
-- PROMOTED VERSION FOREIGN KEY
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE
            conrelid =
                'business_change_proposals'::regclass
            AND conname =
                'fk_business_change_proposals_promoted_version'
    ) THEN
        ALTER TABLE business_change_proposals
            ADD CONSTRAINT
                fk_business_change_proposals_promoted_version
            FOREIGN KEY (
                promoted_version_id,
                tenant_id,
                factory_id
            )
            REFERENCES business_blueprint_versions (
                id,
                tenant_id,
                factory_id
            )
            ON DELETE RESTRICT;
    END IF;
END
$$;


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS
    idx_business_change_proposals_source_version
ON business_change_proposals (
    tenant_id,
    factory_id,
    source_version_id
);


CREATE INDEX IF NOT EXISTS
    idx_business_change_proposals_promoted_version
ON business_change_proposals (
    tenant_id,
    factory_id,
    promoted_version_id
);


CREATE INDEX IF NOT EXISTS
    idx_business_change_proposals_promotion_status
ON business_change_proposals (
    tenant_id,
    factory_id,
    status,
    promoted_at
);


-- ============================================================
-- MIGRATION TRACKING
-- ============================================================

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '015_cbb_change_promotion',
    NULL
)
ON CONFLICT (
    version
)
DO NOTHING;


COMMIT;