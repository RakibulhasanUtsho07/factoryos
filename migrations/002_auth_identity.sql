BEGIN;

CREATE TABLE IF NOT EXISTS auth_identities (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    issuer varchar(500) NOT NULL,
    subject varchar(255) NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'ACTIVE',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT auth_identities_pkey
        PRIMARY KEY (id),

    CONSTRAINT fk_auth_identity_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_auth_identity_issuer_subject
        UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identity_user
    ON auth_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_identity_subject
    ON auth_identities (subject);

INSERT INTO schema_migrations (version)
VALUES ('002_auth_identity')
ON CONFLICT (version) DO NOTHING;

COMMIT;