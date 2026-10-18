# Signed Webhook Connector Contract

## SRS / architecture traceability

This slice implements the SRS integration/event-processing scope and the v2.1 HLD/LLD integration flow:

External connector -> signature verification -> strict envelope and payload validation -> tenant/factory-scoped transaction -> immutable inbound receipt + transactional outbox -> existing publisher/consumer retry, quarantine and DLQ tooling.

The architecture requires webhook signature verification and replay protection, versioned event schemas, consumer idempotency, and bounded retry/DLQ behavior.

## Registry lifecycle and authorization

- \`POST /api/integrations/connectors\` registers a \`SIGNED_WEBHOOK\` connector in \`PENDING_REVIEW\`. An \`Idempotency-Key\` is required. The signing secret is never stored in a database column; registration stores only an approved reference.
- \`GET /api/integrations/connectors\`, \`GET /api/integrations/connectors/:id\`, and \`GET /api/integrations/connectors/:id/history\` expose records only inside the active tenant/factory scope.
- \`POST /api/integrations/connectors/:id/activate\` and \`/reject\` require \`integrations.connectors.approve\`. The database trigger enforces maker-checker: the creator cannot approve or reject their own registration.
- \`POST /api/integrations/connectors/:id/pause\` requires \`integrations.connectors.write\`; \`/resume\` and \`/rotate-secret\` require approval permission. Secret rotation is permitted only while paused.
- Connector identity, source system, schema and schema version are immutable. A breaking schema change is registered as a new connector rather than silently changing an existing contract. Status/credential transitions write append-only connector history.

\`ORG_ADMIN\` receives read/write/approve permissions. \`FACTORY_MANAGER\` receives read/write but not approval. The API never returns a secret value or the private secret reference.

## Signature format and replay window

The public ingress endpoint is \`POST /api/integrations/webhooks/:connectorId\` and requires:

- \`X-FactoryOS-Timestamp\`: ten-digit Unix timestamp in seconds.
- \`X-FactoryOS-Event-Id\`: stable, provider-generated delivery/event identifier (1–200 visible ASCII characters).
- \`X-FactoryOS-Signature\`: \`sha256=\` followed by 64 lower-case hexadecimal characters.

The HMAC-SHA256 input is the exact UTF-8 byte sequence:

\`\`\`text
timestamp + "." + event_id + "." + raw_request_body
\`\`\`

The original JSON bytes are retained by the HTTP body parser only for this webhook route. Signature comparison is constant-time. The default clock-skew allowance is 300 seconds; \`WEBHOOK_SIGNATURE_TOLERANCE_SECONDS\` may be set between 60 and 900 seconds. Missing/malformed/stale timestamps and invalid signatures are rejected before the database transaction starts.

Signing keys use references shaped like \`env://WEBHOOK_SECRET_ERP_A\`. The referenced environment value must be present and at least 32 UTF-8 bytes. This implementation deliberately stores neither key material nor credentials inside connector configuration, logs, event receipts or API responses. A Vault/KMS-backed secret-provider adapter is not included in this slice; the current resolver is environment-backed.

## Strict envelope and schema subset

The only supported envelope keys are:

\`\`\`json
{
  "event_type": "ORDER.CONFIRMED",
  "schema_version": 1,
  "correlation_id": "optional-uuid",
  "payload": {
    "order_number": "SO-100",
    "quantity": 12
  }
}
\`\`\`

\`event_type\` must use a canonical uppercase identifier. \`schema_version\` must exactly match the connector's registered immutable version; \`correlation_id\`, when supplied, must be a UUID. Tenant, factory, actor and connector scope are derived by FactoryOS and cannot be spoofed in the envelope.

The payload schema is a bounded JSON Schema subset for object, array, string, number, integer, boolean and null types. It supports required fields, strict object properties, enums, array item schemas (every array requires an explicit `maxItems` from 0 to 1,000), string length limits and numeric bounds. Unknown schema keywords and open-ended \`additionalProperties\` are rejected. Schemas are limited to 32 KiB, depth 8, 100 object properties and 1,000 array items per declared maximum. Payloads that contain unknown fields, omit required fields, use the wrong type, or report an incompatible schema version are rejected as 4xx responses; invalid data is not endlessly retried.

## Transactional intake, duplicate delivery and safe retry

After signature and schema verification, FactoryOS acquires a database advisory lock keyed by connector + external event ID. Within a tenant/factory-scoped transaction it checks an immutable receipt, rechecks connector state/version/secret reference, inserts a canonical event into \`outbox_events\`, then inserts the corresponding immutable \`integration_webhook_receipts\` row. Receipt and outbox event commit atomically; a successful HTTP acceptance therefore means the event is durably queued, not that downstream business processing has already finished.

- First valid delivery returns HTTP 202 with \`accepted=true\`, \`duplicate=false\` and the internal outbox event ID.
- A repeated event ID with the same canonical payload returns HTTP 202 with \`duplicate=true\`; a second outbox event is not created.
- Reusing an event ID with different event content returns HTTP 409. The receiver will not silently reinterpret an already accepted provider event.
- Invalid signatures/timestamps are 401; malformed/unsupported envelopes are 400/422; unknown connectors are 404; paused connectors return 503 for new events so providers may retry. An exact duplicate receipt can still be acknowledged while the connector is paused.
- Database or unexpected transient failures surface as 5xx/503. Providers should retry only transient failures with the same event ID and unchanged event content. FactoryOS uses its existing transactional outbox retry schedule and DLQ for downstream publish/consumer failures.

The ingress does not execute business mutations directly. It records a validated event and lets the existing idempotent consumer pipeline process it. The resolver function returns only the tenant/factory locator for a connector ID; the internal routing table lives in a non-public schema without app-role table access. Registry, connector history and receipts have forced tenant RLS; DB constraints bind receipts to the same tenant, factory, connector and outbox event.

## Verification

- \`integration-contract.spec.ts\`: canonical raw-byte signing, constant-time verification path, timestamp freshness, secret-reference rules and strict schema validation.
- \`integration.service.spec.ts\`: accepted-event transaction, duplicate suppression, invalid-signature rejection before transaction, stale timestamp and schema-version mismatch.
- \`services/api/test/integration-webhook.sql\`: registry/receipt/history RLS, append-only guards, internal route-table isolation, scoped resolver function permission and migration registration.
- The PostgreSQL CI workflow fails if the new migration or SQL schema contract test is not registered.
