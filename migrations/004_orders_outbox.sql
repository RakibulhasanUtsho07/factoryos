BEGIN;

-- ============================================================
-- ORDER PERMISSIONS
-- ============================================================

INSERT INTO permissions (
    code,
    description
)
VALUES
(
    'orders.read',
    'Read manufacturing orders within the authorized tenant/factory scope'
),
(
    'orders.write',
    'Create manufacturing orders within the authorized tenant/factory scope'
)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- ORG ADMIN
-- ============================================================

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
INNER JOIN permissions p
    ON p.code IN ('orders.read', 'orders.write')
WHERE r.code = 'ORG_ADMIN'
  AND r.is_system = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- FACTORY MANAGER
-- ============================================================

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
INNER JOIN permissions p
    ON p.code IN ('orders.read', 'orders.write')
WHERE r.code = 'FACTORY_MANAGER'
  AND r.is_system = false
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- ORDERS
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
    id uuid NOT NULL DEFAULT gen_random_uuid(),

    tenant_id uuid NOT NULL,
    factory_id uuid NOT NULL,

    order_number varchar(100) NOT NULL,

    customer_name varchar(255),
    customer_reference varchar(255),

    status varchar(30) NOT NULL DEFAULT 'DRAFT',

    order_date date NOT NULL DEFAULT CURRENT_DATE,

    requested_delivery_date date,

    currency varchar(3) NOT NULL DEFAULT 'BDT',

    notes text,

    created_by_user_id uuid NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    version bigint NOT NULL DEFAULT 1,

    CONSTRAINT orders_pkey
        PRIMARY KEY (id),

    CONSTRAINT fk_orders_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_orders_factory
        FOREIGN KEY (factory_id)
        REFERENCES factories(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_orders_created_by
        FOREIGN KEY (created_by_user_id)
        REFERENCES users(id)
        ON DELETE RESTRICT,

    CONSTRAINT uq_orders_tenant_number
        UNIQUE (tenant_id, order_number),

    CONSTRAINT chk_orders_status
        CHECK (
            status IN (
                'DRAFT',
                'CONFIRMED',
                'IN_PROGRESS',
                'COMPLETED',
                'CANCELLED'
            )
        ),

    CONSTRAINT chk_orders_currency
        CHECK (
            currency = upper(currency)
            AND char_length(currency) = 3
        )
);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_created
    ON orders (
        tenant_id,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_orders_factory_status
    ON orders (
        factory_id,
        status,
        created_at DESC
    );

-- ============================================================
-- ORDER LINES
-- ============================================================

CREATE TABLE IF NOT EXISTS order_lines (
    id uuid NOT NULL DEFAULT gen_random_uuid(),

    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,

    line_number integer NOT NULL,

    product_code varchar(100) NOT NULL,
    product_name varchar(255) NOT NULL,

    quantity numeric(18, 4) NOT NULL,
    unit varchar(50) NOT NULL DEFAULT 'PCS',

    unit_price numeric(18, 4),

    requested_delivery_date date,

    notes text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    version bigint NOT NULL DEFAULT 1,

    CONSTRAINT order_lines_pkey
        PRIMARY KEY (id),

    CONSTRAINT fk_order_lines_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_order_lines_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)
        ON DELETE CASCADE,

    CONSTRAINT uq_order_lines_number
        UNIQUE (order_id, line_number),

    CONSTRAINT chk_order_lines_quantity
        CHECK (quantity > 0),

    CONSTRAINT chk_order_lines_unit_price
        CHECK (
            unit_price IS NULL
            OR unit_price >= 0
        )
);

CREATE INDEX IF NOT EXISTS idx_order_lines_order
    ON order_lines (
        order_id,
        line_number
    );

CREATE INDEX IF NOT EXISTS idx_order_lines_tenant
    ON order_lines (
        tenant_id,
        created_at DESC
    );

-- ============================================================
-- OUTBOX
-- ============================================================

CREATE TABLE IF NOT EXISTS outbox_events (
    id uuid NOT NULL DEFAULT gen_random_uuid(),

    tenant_id uuid NOT NULL,
    factory_id uuid,

    aggregate_type varchar(100) NOT NULL,
    aggregate_id uuid NOT NULL,

    event_type varchar(150) NOT NULL,

    event_version integer NOT NULL DEFAULT 1,

    payload jsonb NOT NULL DEFAULT '{}',

    status varchar(30) NOT NULL DEFAULT 'PENDING',

    attempts integer NOT NULL DEFAULT 0,

    next_attempt_at timestamptz NOT NULL DEFAULT now(),

    occurred_at timestamptz NOT NULL DEFAULT now(),

    published_at timestamptz,

    last_error text,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT outbox_events_pkey
        PRIMARY KEY (id),

    CONSTRAINT fk_outbox_tenant
        FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_outbox_factory
        FOREIGN KEY (factory_id)
        REFERENCES factories(id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_outbox_status
        CHECK (
            status IN (
                'PENDING',
                'PROCESSING',
                'PUBLISHED',
                'FAILED'
            )
        ),

    CONSTRAINT chk_outbox_attempts
        CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox_events (
        status,
        next_attempt_at,
        created_at
    )
    WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
    ON outbox_events (
        aggregate_type,
        aggregate_id,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_outbox_tenant
    ON outbox_events (
        tenant_id,
        created_at DESC
    );

-- ============================================================
-- MIGRATION TRACKING
-- ============================================================

INSERT INTO schema_migrations (version)
VALUES ('004_orders_outbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;