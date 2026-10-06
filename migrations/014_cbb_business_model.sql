BEGIN;

-- ============================================================
-- WP04-A
-- CLIENT BUSINESS BLUEPRINT / BUSINESS OPERATING GRAPH
-- ============================================================
--
-- FactoryOS AI v2.1
--
-- This migration establishes the persistent foundation for:
--
--   - private per-factory Client Business Blueprints
--   - immutable CBB blueprint versions
--   - business entities
--   - business relations
--   - business processes / process steps
--   - decision rules
--   - terminology
--   - business exceptions
--   - evidence / provenance links
--   - reviewable change proposals
--   - conflict records
--   - business feedback
--   - role-aligned Business ACL
--
-- Design rules:
--
--   - every CBB object is tenant + factory scoped
--   - factory references are tenant-safe
--   - blueprint versions are immutable
--   - graph objects belong to a specific blueprint version
--   - verified objects are never silently mutated
--   - evidence remains provenance data
--   - contradictions are represented explicitly
--   - PROPOSED / INFERRED / CONFLICTING / STALE must never
--     silently become policy authority
--   - RLS is fail-closed when tenant context is absent
--   - later CBB service code will perform factory-scoped
--     retrieval and write authorization
-- ============================================================


-- ============================================================
-- CBB / BUSINESS MODEL PERMISSIONS
-- ============================================================

INSERT INTO permissions (
    code,
    description
)
VALUES
    (
        'ai.business.read',
        'Read tenant factory Client Business Blueprint data'
    ),
    (
        'ai.business.rebuild',
        'Request a Client Business Blueprint rebuild'
    ),
    (
        'ai.business.review',
        'Review and approve or reject Client Business Blueprint changes'
    ),
    (
        'ai.business.feedback',
        'Submit Client Business Blueprint feedback'
    )
ON CONFLICT (
    code
)
DO NOTHING;


-- ============================================================
-- EXISTING SYSTEM ORGANIZATION ADMINISTRATORS
-- ============================================================

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
CROSS JOIN permissions p
WHERE
    r.code = 'ORG_ADMIN'
    AND r.is_system = true
    AND p.code IN (
        'ai.business.read',
        'ai.business.rebuild',
        'ai.business.review',
        'ai.business.feedback'
    )
ON CONFLICT (
    role_id,
    permission_id
)
DO NOTHING;


-- ============================================================
-- TENANT-SAFE ROLE PARENT KEY
-- ============================================================
--
-- business_acl later needs a structural tenant-safe reference
-- back to roles.
--
-- roles.id is globally unique today, but the composite key makes
-- tenant ownership explicit in the foreign-key relationship.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE
            conrelid = 'roles'::regclass
            AND conname = 'uq_roles_id_tenant'
    ) THEN
        ALTER TABLE roles
            ADD CONSTRAINT uq_roles_id_tenant
            UNIQUE (
                id,
                tenant_id
            );
    END IF;
END
$$;


-- ============================================================
-- SHARED CBB STATE VOCABULARY
-- ============================================================
--
-- The SRS defines:
--
--   VERIFIED
--   INFERRED
--   PROPOSED
--   CONFLICTING
--   STALE
--
-- These states describe evidence / confidence state rather
-- than authorization.
-- ============================================================


-- ============================================================
-- BUSINESS BLUEPRINT
-- ============================================================
--
-- One private blueprint belongs to one factory.
--
-- The blueprint row itself is the stable identity.
-- Versioned snapshots live in business_blueprint_versions.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_blueprints (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    current_version_id  UUID,

    status              VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_blueprints_factory_tenant
        FOREIGN KEY (
            factory_id,
            tenant_id
        )
        REFERENCES factories (
            id,
            tenant_id
        )
        ON DELETE CASCADE,

    CONSTRAINT uq_business_blueprints_factory
        UNIQUE (
            tenant_id,
            factory_id
        ),

    CONSTRAINT uq_business_blueprints_id_tenant
        UNIQUE (
            id,
            tenant_id
        ),

    CONSTRAINT uq_business_blueprints_id_tenant_factory
        UNIQUE (
            id,
            tenant_id,
            factory_id
        ),

    CONSTRAINT chk_business_blueprints_status
        CHECK (
            status IN (
                'ACTIVE',
                'DISABLED',
                'ARCHIVED'
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_blueprints_tenant_factory
    ON business_blueprints (
        tenant_id,
        factory_id
    );


-- ============================================================
-- BUSINESS BLUEPRINT VERSIONS
-- ============================================================
--
-- Version rows are immutable snapshots.
--
-- A rollback or rebuild creates another version rather than
-- mutating historical state.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_blueprint_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_id        UUID NOT NULL,

    version             BIGINT NOT NULL,

    graph_hash          VARCHAR(128),

    evidence_count      INTEGER NOT NULL DEFAULT 0,

    readiness_score     NUMERIC(8,4),

    status              VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    change_reason       TEXT,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_blueprint_versions_blueprint
        FOREIGN KEY (
            blueprint_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprints (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_blueprint_versions_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT uq_business_blueprint_versions_version
        UNIQUE (
            blueprint_id,
            version
        ),

    CONSTRAINT uq_business_blueprint_versions_id_tenant
        UNIQUE (
            id,
            tenant_id
        ),

    CONSTRAINT uq_business_blueprint_versions_id_tenant_factory
        UNIQUE (
            id,
            tenant_id,
            factory_id
        ),

    CONSTRAINT chk_business_blueprint_versions_version
        CHECK (
            version >= 1
        ),

    CONSTRAINT chk_business_blueprint_versions_evidence_count
        CHECK (
            evidence_count >= 0
        ),

    CONSTRAINT chk_business_blueprint_versions_readiness
        CHECK (
            readiness_score IS NULL
            OR (
                readiness_score >= 0
                AND readiness_score <= 1
            )
        ),

    CONSTRAINT chk_business_blueprint_versions_status
        CHECK (
            status IN (
                'PROPOSED',
                'ACTIVE',
                'SUPERSEDED',
                'REJECTED'
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_blueprint_versions_tenant_factory
    ON business_blueprint_versions (
        tenant_id,
        factory_id,
        created_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_business_blueprint_versions_blueprint_version
    ON business_blueprint_versions (
        blueprint_id,
        version DESC
    );


-- ============================================================
-- CURRENT VERSION FOREIGN KEY
-- ============================================================
--
-- This is added after the version table exists so the two
-- objects can safely reference each other.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE
            conrelid =
                'business_blueprints'::regclass
            AND conname =
                'fk_business_blueprints_current_version'
    ) THEN
        ALTER TABLE business_blueprints
            ADD CONSTRAINT
                fk_business_blueprints_current_version
            FOREIGN KEY (
                current_version_id,
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
-- BUSINESS ENTITIES
-- ============================================================
--
-- Represents the business graph's core entities and actors:
--
--   customers
--   suppliers
--   products
--   departments
--   roles
--   systems
--   KPIs
--   stakeholders
--   sites
--   other governed business objects
--
-- entity_type remains extensible because the SRS defines a
-- minimum conceptual model rather than a closed enumeration.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_entities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    entity_type         VARCHAR(100) NOT NULL,

    name                VARCHAR(300) NOT NULL,

    description         TEXT,

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_entities_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_entities_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT uq_business_entities_id_scope
        UNIQUE (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id
        ),

    CONSTRAINT chk_business_entities_type
        CHECK (
            LENGTH(BTRIM(entity_type)) > 0
        ),

    CONSTRAINT chk_business_entities_name
        CHECK (
            LENGTH(BTRIM(name)) > 0
        ),

    CONSTRAINT chk_business_entities_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_entities_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_entities_scope
    ON business_entities (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


CREATE INDEX IF NOT EXISTS idx_business_entities_type
    ON business_entities (
        tenant_id,
        factory_id,
        entity_type
    );


CREATE INDEX IF NOT EXISTS idx_business_entities_state
    ON business_entities (
        tenant_id,
        factory_id,
        state
    );


-- ============================================================
-- BUSINESS RELATIONS
-- ============================================================
--
-- Graph edges between entities.
-- Both endpoints must belong to the same tenant, factory and
-- blueprint version.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_relations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    from_entity_id      UUID NOT NULL,
    to_entity_id        UUID NOT NULL,

    relation_type       VARCHAR(150) NOT NULL,

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_relations_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_relations_from_entity
        FOREIGN KEY (
            from_entity_id,
            tenant_id,
            factory_id,
            blueprint_version_id
        )
        REFERENCES business_entities (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_relations_to_entity
        FOREIGN KEY (
            to_entity_id,
            tenant_id,
            factory_id,
            blueprint_version_id
        )
        REFERENCES business_entities (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_relations_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_relations_type
        CHECK (
            LENGTH(BTRIM(relation_type)) > 0
        ),

    CONSTRAINT chk_business_relations_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_relations_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        ),

    CONSTRAINT chk_business_relations_not_self
        CHECK (
            from_entity_id <> to_entity_id
        )
);


CREATE INDEX IF NOT EXISTS idx_business_relations_scope
    ON business_relations (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


CREATE INDEX IF NOT EXISTS idx_business_relations_from
    ON business_relations (
        tenant_id,
        factory_id,
        from_entity_id
    );


CREATE INDEX IF NOT EXISTS idx_business_relations_to
    ON business_relations (
        tenant_id,
        factory_id,
        to_entity_id
    );


-- ============================================================
-- BUSINESS PROCESSES
-- ============================================================
--
-- Process maps and business workflows.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_processes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    name                VARCHAR(300) NOT NULL,

    description         TEXT,

    owner_ref           VARCHAR(255),

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_processes_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_processes_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT uq_business_processes_id_scope
        UNIQUE (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id
        ),

    CONSTRAINT chk_business_processes_name
        CHECK (
            LENGTH(BTRIM(name)) > 0
        ),

    CONSTRAINT chk_business_processes_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_processes_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_processes_scope
    ON business_processes (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


-- ============================================================
-- BUSINESS PROCESS STEPS
-- ============================================================
--
-- Minimum process representation includes:
--
--   sequence
--   inputs
--   outputs
--   owner
--   state
--
-- JSONB is used for inputs/outputs because their domain structure
-- varies by process and will later be connected to graph nodes
-- and governed evidence.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_process_steps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    process_id          UUID NOT NULL,

    sequence_no         INTEGER NOT NULL,

    name                VARCHAR(300) NOT NULL,

    description         TEXT,

    owner_ref           VARCHAR(255),

    inputs              JSONB NOT NULL DEFAULT '[]'::JSONB,

    outputs             JSONB NOT NULL DEFAULT '[]'::JSONB,

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_process_steps_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_process_steps_process
        FOREIGN KEY (
            process_id,
            tenant_id,
            factory_id,
            blueprint_version_id
        )
        REFERENCES business_processes (
            id,
            tenant_id,
            factory_id,
            blueprint_version_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_process_steps_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT uq_business_process_steps_sequence
        UNIQUE (
            process_id,
            sequence_no
        ),

    CONSTRAINT chk_business_process_steps_sequence
        CHECK (
            sequence_no >= 1
        ),

    CONSTRAINT chk_business_process_steps_name
        CHECK (
            LENGTH(BTRIM(name)) > 0
        ),

    CONSTRAINT chk_business_process_steps_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_process_steps_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        ),

    CONSTRAINT chk_business_process_steps_inputs
        CHECK (
            jsonb_typeof(inputs) = 'array'
        ),

    CONSTRAINT chk_business_process_steps_outputs
        CHECK (
            jsonb_typeof(outputs) = 'array'
        )
);


CREATE INDEX IF NOT EXISTS idx_business_process_steps_scope
    ON business_process_steps (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


CREATE INDEX IF NOT EXISTS idx_business_process_steps_process
    ON business_process_steps (
        tenant_id,
        factory_id,
        process_id,
        sequence_no
    );


-- ============================================================
-- BUSINESS RULES
-- ============================================================
--
-- Decision rules belong to the CBB.
-- They are context and explanation artifacts, NOT policy
-- authority.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    name                VARCHAR(300) NOT NULL,

    rule_type           VARCHAR(100) NOT NULL,

    description         TEXT,

    expression_ref      TEXT,

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_rules_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_rules_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_rules_name
        CHECK (
            LENGTH(BTRIM(name)) > 0
        ),

    CONSTRAINT chk_business_rules_type
        CHECK (
            LENGTH(BTRIM(rule_type)) > 0
        ),

    CONSTRAINT chk_business_rules_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_rules_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_rules_scope
    ON business_rules (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


-- ============================================================
-- BUSINESS TERMS
-- ============================================================
--
-- Client-specific terminology dictionary.
--
-- Supports:
--
--   English
--   Bangla
--   transliterated terms
--   source-system variants
--
-- canonical_term is the governed business vocabulary.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_terms (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    term                VARCHAR(300) NOT NULL,

    canonical_term      VARCHAR(300) NOT NULL,

    language_code       VARCHAR(20),

    source_system       VARCHAR(150),

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_terms_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_terms_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_terms_term
        CHECK (
            LENGTH(BTRIM(term)) > 0
        ),

    CONSTRAINT chk_business_terms_canonical
        CHECK (
            LENGTH(BTRIM(canonical_term)) > 0
        ),

    CONSTRAINT chk_business_terms_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_terms_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_terms_scope
    ON business_terms (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


CREATE INDEX IF NOT EXISTS idx_business_terms_term
    ON business_terms (
        tenant_id,
        factory_id,
        LOWER(term)
    );


CREATE INDEX IF NOT EXISTS idx_business_terms_canonical
    ON business_terms (
        tenant_id,
        factory_id,
        LOWER(canonical_term)
    );


-- ============================================================
-- BUSINESS EXCEPTIONS
-- ============================================================
--
-- Explicit exception paths in the client's operating model.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_exceptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_version_id
                        UUID NOT NULL,

    name                VARCHAR(300) NOT NULL,

    description         TEXT,

    trigger_ref         TEXT,

    handling_ref        TEXT,

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    confidence          NUMERIC(6,5),

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_exceptions_version
        FOREIGN KEY (
            blueprint_version_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprint_versions (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_exceptions_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_exceptions_name
        CHECK (
            LENGTH(BTRIM(name)) > 0
        ),

    CONSTRAINT chk_business_exceptions_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_exceptions_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_exceptions_scope
    ON business_exceptions (
        tenant_id,
        factory_id,
        blueprint_version_id
    );


-- ============================================================
-- BUSINESS EVIDENCE
-- ============================================================
--
-- Evidence is the provenance layer for the CBB.
--
-- Source information is retained with timestamp, confidence,
-- state and content hash.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_evidence (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    source_type         VARCHAR(100) NOT NULL,

    source_ref          VARCHAR(1000) NOT NULL,

    source_timestamp    TIMESTAMPTZ,

    evidence_grade      VARCHAR(30),

    confidence          NUMERIC(6,5),

    state               VARCHAR(30) NOT NULL DEFAULT 'PROPOSED',

    content_hash        VARCHAR(128),

    visibility          VARCHAR(30) NOT NULL DEFAULT 'INTERNAL',

    metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_evidence_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_evidence_source_type
        CHECK (
            LENGTH(BTRIM(source_type)) > 0
        ),

    CONSTRAINT chk_business_evidence_source_ref
        CHECK (
            LENGTH(BTRIM(source_ref)) > 0
        ),

    CONSTRAINT chk_business_evidence_confidence
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        ),

    CONSTRAINT chk_business_evidence_state
        CHECK (
            state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_evidence_visibility
        CHECK (
            visibility IN (
                'INTERNAL',
                'RESTRICTED'
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_evidence_scope
    ON business_evidence (
        tenant_id,
        factory_id,
        created_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_business_evidence_source
    ON business_evidence (
        tenant_id,
        factory_id,
        source_type,
        source_ref
    );


CREATE INDEX IF NOT EXISTS idx_business_evidence_hash
    ON business_evidence (
        tenant_id,
        factory_id,
        content_hash
    );


-- ============================================================
-- BUSINESS EVIDENCE LINKS
-- ============================================================
--
-- Generic provenance link between evidence and a graph/model
-- object.
--
-- target_type identifies the governed object category.
-- target_id identifies the object itself.
--
-- The application service will validate that target_id belongs
-- to the same tenant/factory/version before creating the link.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_evidence_links (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    evidence_id         UUID NOT NULL,

    target_type         VARCHAR(100) NOT NULL,

    target_id           UUID NOT NULL,

    link_type            VARCHAR(100) NOT NULL DEFAULT 'SUPPORTS',

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_evidence_links_evidence
        FOREIGN KEY (
            evidence_id
        )
        REFERENCES business_evidence (
            id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_evidence_links_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_evidence_links_target_type
        CHECK (
            LENGTH(BTRIM(target_type)) > 0
        ),

    CONSTRAINT chk_business_evidence_links_type
        CHECK (
            LENGTH(BTRIM(link_type)) > 0
        ),

    CONSTRAINT uq_business_evidence_links
        UNIQUE (
            evidence_id,
            target_type,
            target_id,
            link_type
        )
);


CREATE INDEX IF NOT EXISTS idx_business_evidence_links_target
    ON business_evidence_links (
        tenant_id,
        factory_id,
        target_type,
        target_id
    );


CREATE INDEX IF NOT EXISTS idx_business_evidence_links_evidence
    ON business_evidence_links (
        tenant_id,
        factory_id,
        evidence_id
    );


-- ============================================================
-- BUSINESS CHANGE PROPOSALS
-- ============================================================
--
-- Reviewable model changes.
--
-- Generated candidates remain proposals until an authorized
-- review flow accepts them.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_change_proposals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_id        UUID NOT NULL,

    target_type         VARCHAR(100) NOT NULL,

    target_id           UUID,

    proposal_type       VARCHAR(100) NOT NULL,

    proposed_state      VARCHAR(30),

    proposed_payload    JSONB NOT NULL DEFAULT '{}'::JSONB,

    status              VARCHAR(30) NOT NULL DEFAULT 'PENDING',

    reason              TEXT,

    requested_by        UUID,

    decided_by          UUID,

    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    decided_at          TIMESTAMPTZ,

    decision_reason     TEXT,

    CONSTRAINT fk_business_change_proposals_blueprint
        FOREIGN KEY (
            blueprint_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprints (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_change_proposals_requested_by
        FOREIGN KEY (
            requested_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT fk_business_change_proposals_decided_by
        FOREIGN KEY (
            decided_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_change_proposals_target_type
        CHECK (
            LENGTH(BTRIM(target_type)) > 0
        ),

    CONSTRAINT chk_business_change_proposals_type
        CHECK (
            LENGTH(BTRIM(proposal_type)) > 0
        ),

    CONSTRAINT chk_business_change_proposals_state
        CHECK (
            proposed_state IS NULL
            OR proposed_state IN (
                'VERIFIED',
                'INFERRED',
                'PROPOSED',
                'CONFLICTING',
                'STALE'
            )
        ),

    CONSTRAINT chk_business_change_proposals_status
        CHECK (
            status IN (
                'PENDING',
                'APPROVED',
                'REJECTED',
                'CANCELLED'
            )
        ),

    CONSTRAINT chk_business_change_proposals_decision_fields
        CHECK (
            (
                status = 'PENDING'
                AND decided_by IS NULL
                AND decided_at IS NULL
            )
            OR
            (
                status <> 'PENDING'
                AND decided_by IS NOT NULL
                AND decided_at IS NOT NULL
            )
        )
);


CREATE INDEX IF NOT EXISTS idx_business_change_proposals_scope
    ON business_change_proposals (
        tenant_id,
        factory_id,
        requested_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_business_change_proposals_status
    ON business_change_proposals (
        tenant_id,
        factory_id,
        status,
        requested_at DESC
    );


-- ============================================================
-- BUSINESS CONFLICTS
-- ============================================================
--
-- Conflicting trusted evidence must be surfaced explicitly.
-- The system must not choose silently.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_conflicts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    blueprint_id        UUID NOT NULL,

    subject_type        VARCHAR(100) NOT NULL,

    subject_id          UUID NOT NULL,

    status              VARCHAR(30) NOT NULL DEFAULT 'OPEN',

    description         TEXT,

    evidence_refs       JSONB NOT NULL DEFAULT '[]'::JSONB,

    resolution_ref      TEXT,

    created_by          UUID,

    resolved_by         UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    resolved_at         TIMESTAMPTZ,

    CONSTRAINT fk_business_conflicts_blueprint
        FOREIGN KEY (
            blueprint_id,
            tenant_id,
            factory_id
        )
        REFERENCES business_blueprints (
            id,
            tenant_id,
            factory_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_conflicts_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT fk_business_conflicts_resolved_by
        FOREIGN KEY (
            resolved_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_conflicts_subject_type
        CHECK (
            LENGTH(BTRIM(subject_type)) > 0
        ),

    CONSTRAINT chk_business_conflicts_status
        CHECK (
            status IN (
                'OPEN',
                'RESOLVED',
                'DISMISSED'
            )
        ),

    CONSTRAINT chk_business_conflicts_evidence_refs
        CHECK (
            jsonb_typeof(evidence_refs) = 'array'
        )
);


CREATE INDEX IF NOT EXISTS idx_business_conflicts_scope
    ON business_conflicts (
        tenant_id,
        factory_id,
        created_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_business_conflicts_status
    ON business_conflicts (
        tenant_id,
        factory_id,
        status,
        created_at DESC
    );


-- ============================================================
-- BUSINESS FEEDBACK
-- ============================================================
--
-- User feedback about model correctness / usefulness.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_feedback (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    subject_type        VARCHAR(100) NOT NULL,

    subject_id          UUID NOT NULL,

    feedback_type       VARCHAR(100) NOT NULL,

    payload_json        JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_feedback_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_feedback_subject_type
        CHECK (
            LENGTH(BTRIM(subject_type)) > 0
        ),

    CONSTRAINT chk_business_feedback_type
        CHECK (
            LENGTH(BTRIM(feedback_type)) > 0
        )
);


CREATE INDEX IF NOT EXISTS idx_business_feedback_scope
    ON business_feedback (
        tenant_id,
        factory_id,
        created_at DESC
    );


CREATE INDEX IF NOT EXISTS idx_business_feedback_subject
    ON business_feedback (
        tenant_id,
        factory_id,
        subject_type,
        subject_id
    );


-- ============================================================
-- BUSINESS ACL
-- ============================================================
--
-- Field/node-level visibility aligned with tenant roles.
--
-- target_type:
--   BLUEPRINT
--   ENTITY
--   RELATION
--   PROCESS
--   PROCESS_STEP
--   RULE
--   TERM
--   EXCEPTION
--
-- access_level:
--   READ
--   EDIT
--   OWNER
--
-- Application-level services will enforce the exact target
-- relationship before writes.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_acl (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id           UUID NOT NULL,
    factory_id          UUID NOT NULL,

    role_id             UUID NOT NULL,

    target_type         VARCHAR(100) NOT NULL,

    target_id           UUID NOT NULL,

    field_name          VARCHAR(150),

    access_level        VARCHAR(30) NOT NULL DEFAULT 'READ',

    created_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_business_acl_role_tenant
        FOREIGN KEY (
            role_id,
            tenant_id
        )
        REFERENCES roles (
            id,
            tenant_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_acl_factory_tenant
        FOREIGN KEY (
            factory_id,
            tenant_id
        )
        REFERENCES factories (
            id,
            tenant_id
        )
        ON DELETE CASCADE,

    CONSTRAINT fk_business_acl_created_by
        FOREIGN KEY (
            created_by
        )
        REFERENCES users (
            id
        )
        ON DELETE SET NULL,

    CONSTRAINT chk_business_acl_target_type
        CHECK (
            LENGTH(BTRIM(target_type)) > 0
        ),

    CONSTRAINT chk_business_acl_access_level
        CHECK (
            access_level IN (
                'READ',
                'EDIT',
                'OWNER'
            )
        ),

    CONSTRAINT uq_business_acl_entry
        UNIQUE (
            tenant_id,
            factory_id,
            role_id,
            target_type,
            target_id,
            field_name,
            access_level
        )
);


CREATE INDEX IF NOT EXISTS idx_business_acl_scope
    ON business_acl (
        tenant_id,
        factory_id
    );


CREATE INDEX IF NOT EXISTS idx_business_acl_target
    ON business_acl (
        tenant_id,
        factory_id,
        target_type,
        target_id
    );


CREATE INDEX IF NOT EXISTS idx_business_acl_role
    ON business_acl (
        tenant_id,
        factory_id,
        role_id
    );


-- ============================================================
-- IMMUTABLE VERSIONED CBB OBJECTS
-- ============================================================
--
-- Every graph/model object belongs to a blueprint version.
-- Once created, the historical version must not be mutated.
--
-- New state is represented by a new blueprint version.
-- ============================================================

DROP TRIGGER IF EXISTS
    business_blueprint_versions_immutable_version
ON business_blueprint_versions;

CREATE TRIGGER
    business_blueprint_versions_immutable_version
BEFORE UPDATE OR DELETE
ON business_blueprint_versions
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_entities_immutable_version
ON business_entities;

CREATE TRIGGER
    business_entities_immutable_version
BEFORE UPDATE OR DELETE
ON business_entities
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_relations_immutable_version
ON business_relations;

CREATE TRIGGER
    business_relations_immutable_version
BEFORE UPDATE OR DELETE
ON business_relations
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_processes_immutable_version
ON business_processes;

CREATE TRIGGER
    business_processes_immutable_version
BEFORE UPDATE OR DELETE
ON business_processes
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_process_steps_immutable_version
ON business_process_steps;

CREATE TRIGGER
    business_process_steps_immutable_version
BEFORE UPDATE OR DELETE
ON business_process_steps
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_rules_immutable_version
ON business_rules;

CREATE TRIGGER
    business_rules_immutable_version
BEFORE UPDATE OR DELETE
ON business_rules
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_terms_immutable_version
ON business_terms;

CREATE TRIGGER
    business_terms_immutable_version
BEFORE UPDATE OR DELETE
ON business_terms
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


DROP TRIGGER IF EXISTS
    business_exceptions_immutable_version
ON business_exceptions;

CREATE TRIGGER
    business_exceptions_immutable_version
BEFORE UPDATE OR DELETE
ON business_exceptions
FOR EACH ROW
EXECUTE FUNCTION factoryos_reject_versioned_mutation();


-- ============================================================
-- FACTORY-SCOPED BLUEPRINT SEED
-- ============================================================
--
-- FR-CBB-01:
-- Each factory gets a private CBB identity.
--
-- Existing factories are initialized here.
-- New factory provisioning will later create these records
-- transactionally in the provisioning flow.
-- ============================================================

INSERT INTO business_blueprints (
    tenant_id,
    factory_id,
    status
)
SELECT
    f.tenant_id,
    f.id,
    'ACTIVE'
FROM factories f
ON CONFLICT (
    tenant_id,
    factory_id
)
DO NOTHING;


-- ============================================================
-- INITIAL BLUEPRINT VERSION
-- ============================================================
--
-- Every existing blueprint receives version 1 where it does not
-- already have one.
-- ============================================================

INSERT INTO business_blueprint_versions (
    tenant_id,
    factory_id,
    blueprint_id,
    version,
    evidence_count,
    readiness_score,
    status,
    change_reason,
    created_by
)
SELECT
    b.tenant_id,
    b.factory_id,
    b.id,
    1,
    0,
    0,
    'ACTIVE',
    'Initial CBB foundation version',
    NULL
FROM business_blueprints b
WHERE NOT EXISTS (
    SELECT 1
    FROM business_blueprint_versions v
    WHERE
        v.blueprint_id = b.id
        AND v.version = 1
);


-- ============================================================
-- POINT BLUEPRINTS AT INITIAL VERSION
-- ============================================================

UPDATE business_blueprints b
SET
    current_version_id = v.id,
    updated_at = NOW()
FROM business_blueprint_versions v
WHERE
    v.blueprint_id = b.id
    AND v.tenant_id = b.tenant_id
    AND v.factory_id = b.factory_id
    AND v.version = (
        SELECT
            MIN(v2.version)
        FROM business_blueprint_versions v2
        WHERE
            v2.blueprint_id = b.id
    )
    AND b.current_version_id IS NULL;


-- ============================================================
-- RLS: BUSINESS BLUEPRINTS
-- ============================================================

ALTER TABLE business_blueprints
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_blueprints
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_blueprints_tenant_isolation
ON business_blueprints;

CREATE POLICY
    business_blueprints_tenant_isolation
ON business_blueprints
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS BLUEPRINT VERSIONS
-- ============================================================

ALTER TABLE business_blueprint_versions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_blueprint_versions
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_blueprint_versions_tenant_isolation
ON business_blueprint_versions;

CREATE POLICY
    business_blueprint_versions_tenant_isolation
ON business_blueprint_versions
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS ENTITIES
-- ============================================================

ALTER TABLE business_entities
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_entities
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_entities_tenant_isolation
ON business_entities;

CREATE POLICY
    business_entities_tenant_isolation
ON business_entities
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS RELATIONS
-- ============================================================

ALTER TABLE business_relations
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_relations
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_relations_tenant_isolation
ON business_relations;

CREATE POLICY
    business_relations_tenant_isolation
ON business_relations
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS PROCESSES
-- ============================================================

ALTER TABLE business_processes
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_processes
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_processes_tenant_isolation
ON business_processes;

CREATE POLICY
    business_processes_tenant_isolation
ON business_processes
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS PROCESS STEPS
-- ============================================================

ALTER TABLE business_process_steps
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_process_steps
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_process_steps_tenant_isolation
ON business_process_steps;

CREATE POLICY
    business_process_steps_tenant_isolation
ON business_process_steps
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS RULES
-- ============================================================

ALTER TABLE business_rules
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_rules
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_rules_tenant_isolation
ON business_rules;

CREATE POLICY
    business_rules_tenant_isolation
ON business_rules
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS TERMS
-- ============================================================

ALTER TABLE business_terms
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_terms
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_terms_tenant_isolation
ON business_terms;

CREATE POLICY
    business_terms_tenant_isolation
ON business_terms
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS EXCEPTIONS
-- ============================================================

ALTER TABLE business_exceptions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_exceptions
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_exceptions_tenant_isolation
ON business_exceptions;

CREATE POLICY
    business_exceptions_tenant_isolation
ON business_exceptions
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS EVIDENCE
-- ============================================================

ALTER TABLE business_evidence
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_evidence
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_evidence_tenant_isolation
ON business_evidence;

CREATE POLICY
    business_evidence_tenant_isolation
ON business_evidence
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS EVIDENCE LINKS
-- ============================================================

ALTER TABLE business_evidence_links
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_evidence_links
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_evidence_links_tenant_isolation
ON business_evidence_links;

CREATE POLICY
    business_evidence_links_tenant_isolation
ON business_evidence_links
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS CHANGE PROPOSALS
-- ============================================================

ALTER TABLE business_change_proposals
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_change_proposals
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_change_proposals_tenant_isolation
ON business_change_proposals;

CREATE POLICY
    business_change_proposals_tenant_isolation
ON business_change_proposals
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS CONFLICTS
-- ============================================================

ALTER TABLE business_conflicts
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_conflicts
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_conflicts_tenant_isolation
ON business_conflicts;

CREATE POLICY
    business_conflicts_tenant_isolation
ON business_conflicts
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS FEEDBACK
-- ============================================================

ALTER TABLE business_feedback
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_feedback
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_feedback_tenant_isolation
ON business_feedback;

CREATE POLICY
    business_feedback_tenant_isolation
ON business_feedback
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- RLS: BUSINESS ACL
-- ============================================================

ALTER TABLE business_acl
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_acl
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS
    business_acl_tenant_isolation
ON business_acl;

CREATE POLICY
    business_acl_tenant_isolation
ON business_acl
USING (
    tenant_id =
        factoryos_current_tenant_id()
)
WITH CHECK (
    tenant_id =
        factoryos_current_tenant_id()
);


-- ============================================================
-- MIGRATION TRACKING
-- ============================================================

INSERT INTO schema_migrations (
    version,
    checksum
)
VALUES (
    '014_cbb_business_model',
    NULL
)
ON CONFLICT (
    version
)
DO NOTHING;


COMMIT;