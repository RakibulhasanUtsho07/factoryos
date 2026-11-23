import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIntegrationCaseDecisionPayload,
  buildIntegrationConnectorPayload,
  buildIntegrationDecisionPayload,
  buildIntegrationQuery,
  buildIntegrationSecretRotationPayload,
  filterIntegrationConnectors,
  integrationCaseVersion,
  normalizeIntegrationRows,
  summarizeIntegrationWorkspace,
  validateIntegrationPayloadSchema,
} from "./integration-workbench.mjs";

const validSchema = {
  type: "object",
  properties: {
    occurred_at: { type: "string", minLength: 20, maxLength: 80 },
    source_sequence: { type: "integer", minimum: 1 },
  },
  required: ["occurred_at"],
  additionalProperties: false,
};

const validConnector = {
  display_name: "Payroll attendance feed",
  source_system: "WORKFORCE_PAYROLL",
  secret_reference: "env://WEBHOOK_SECRET_PAYROLL",
  schema_version: "2",
  allowed_event_types: "WORKFORCE.ATTENDANCE.CLOCK_IN\nWORKFORCE.ATTENDANCE.CLOCK_OUT",
  payload_schema: JSON.stringify(validSchema),
};

test("normalizes integration list responses and preferred collection keys", () => {
  const rows = [{ id: "one" }];
  assert.deepEqual(normalizeIntegrationRows(rows), rows);
  assert.deepEqual(normalizeIntegrationRows({ items: rows }), rows);
  assert.deepEqual(normalizeIntegrationRows({ records: rows }, "records"), rows);
  assert.deepEqual(normalizeIntegrationRows({ data: { items: rows } }), rows);
  assert.deepEqual(normalizeIntegrationRows(null), []);
});

test("builds canonical connector registrations and parses the schema document", () => {
  const result = buildIntegrationConnectorPayload(validConnector);
  assert.equal(result.display_name, "Payroll attendance feed");
  assert.equal(result.source_system, "WORKFORCE_PAYROLL");
  assert.equal(result.schema_version, 2);
  assert.deepEqual(result.allowed_event_types, [
    "WORKFORCE.ATTENDANCE.CLOCK_IN", "WORKFORCE.ATTENDANCE.CLOCK_OUT",
  ]);
  assert.deepEqual(result.payload_schema, validSchema);
});

test("rejects invalid connector identity, source code and schema version", () => {
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, display_name: "x" }), /2 to 160/);
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, source_system: "lower-case" }), /canonical uppercase/);
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, schema_version: "1.5" }), /integer between/);
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, schema_version: "10001" }), /integer between/);
});

test("requires a valid environment secret alias and never accepts secret material", () => {
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, secret_reference: "plain-secret-value" }), /env:\/\//);
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, secret_reference: "env://API_KEY" }), /env:\/\//);
});

test("requires unique canonical event types within the API limit", () => {
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, allowed_event_types: "event.lowercase" }), /canonical identifiers/);
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, allowed_event_types: "EVENT.ONE,EVENT.ONE" }), /unique canonical/);
  assert.throws(() => buildIntegrationConnectorPayload({ ...validConnector, allowed_event_types: "" }), /1 to 100/);
});

test("accepts a nested supported object, array and scalar schema", () => {
  const schema = validateIntegrationPayloadSchema({
    type: "object",
    properties: {
      lines: { type: "array", maxItems: 10, items: { type: "object", properties: {
        sku: { type: "string", minLength: 1, maxLength: 80 },
        quantity: { type: "number", minimum: 0 },
      }, required: ["sku"], additionalProperties: false } },
    },
    required: ["lines"],
    additionalProperties: false,
  });
  assert.equal(schema.type, "object");
});

test("rejects unsupported schema keywords and non-object roots", () => {
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: {}, additionalProperties: true,
  }), /additionalProperties must be false/);
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: {}, patternProperties: {},
  }), /unsupported schema keyword/);
  assert.throws(() => validateIntegrationPayloadSchema({ type: "string" }), /root type must be object/);
});

test("rejects credential-like schema fields and unsafe property names", () => {
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: { access_token: { type: "string" } },
  }), /credential-like properties/);
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: { constructor: { type: "string" } },
  }), /unsafe property name/);
});

test("rejects invalid depth, array bounds, required references and schema size", () => {
  let deep = { type: "string" };
  for (let index = 0; index < 10; index += 1) deep = { type: "array", maxItems: 1, items: deep };
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: { nested: deep },
  }), /maximum schema depth/);
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: { list: { type: "array", items: { type: "string" } } },
  }), /maxItems is required/);
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: {}, required: ["missing"],
  }), /undefined property/);
  assert.throws(() => validateIntegrationPayloadSchema({
    type: "object", properties: { large: { type: "string", enum: ["x".repeat(33000)] } },
  }), /32 KiB/);
});

test("builds connector lifecycle decisions with bounded reasons", () => {
  assert.deepEqual(buildIntegrationDecisionPayload("Approved by independent integration reviewer"), {
    reason: "Approved by independent integration reviewer",
  });
  assert.throws(() => buildIntegrationDecisionPayload("no"), /3 to 500/);
  assert.throws(() => buildIntegrationDecisionPayload("x".repeat(501)), /3 to 500/);
});

test("builds secret rotation request without exposing the current reference", () => {
  assert.deepEqual(buildIntegrationSecretRotationPayload(
    "env://WEBHOOK_SECRET_PAYROLL_NEXT", "Rotate after controlled key replacement",
  ), {
    secret_reference: "env://WEBHOOK_SECRET_PAYROLL_NEXT",
    reason: "Rotate after controlled key replacement",
  });
  assert.throws(() => buildIntegrationSecretRotationPayload("raw-secret", "Rotate signing key"), /env:\/\//);
});

test("builds optimistic-versioned reconciliation case decisions", () => {
  assert.deepEqual(buildIntegrationCaseDecisionPayload("RESOLVE", "4", "Late source event was reconciled against the verified sequence"), {
    action: "RESOLVE",
    expected_version: 4,
    reason: "Late source event was reconciled against the verified sequence",
  });
  assert.deepEqual(buildIntegrationCaseDecisionPayload("WAIVE", 2, "Owner approved waiver after downstream review"), {
    action: "WAIVE",
    expected_version: 2,
    reason: "Owner approved waiver after downstream review",
  });
  assert.throws(() => buildIntegrationCaseDecisionPayload("IGNORE", 2, "A sufficiently long decision reason"), /RESOLVE or WAIVE/);
  assert.throws(() => buildIntegrationCaseDecisionPayload("RESOLVE", 0, "A sufficiently long decision reason"), /positive integer/);
  assert.throws(() => buildIntegrationCaseDecisionPayload("RESOLVE", 2, "short"), /10 to 500/);
});

test("builds domain, delivery and time-window query parameters", () => {
  const report = new URLSearchParams(buildIntegrationQuery({
    domain: "quality",
    since: "2026-11-01T00:00",
    until: "2026-11-02T23:59",
  }, "report").slice(1));
  assert.equal(report.get("domain"), "QUALITY");
  assert.equal(report.get("since"), new Date("2026-11-01T00:00").toISOString());
  assert.equal(report.get("until"), new Date("2026-11-02T23:59").toISOString());

  const events = new URLSearchParams(buildIntegrationQuery({
    domain: "production", delivery_class: "late", source_system: "MES_LINE_1", limit: 50,
  }, "events").slice(1));
  assert.equal(events.get("domain"), "PRODUCTION");
  assert.equal(events.get("delivery_class"), "LATE");
  assert.equal(events.get("limit"), "50");
});

test("rejects reversed and malformed reconciliation filters and unsupported case values", () => {
  assert.throws(() => buildIntegrationQuery({
    since: "2026-11-03T00:00", until: "2026-11-02T00:00",
  }, "report"), /not be later/);
  assert.throws(() => buildIntegrationQuery({ domain: "FINANCE" }, "report"), /Domain must be/);
  assert.throws(() => buildIntegrationQuery({ delivery_class: "FAILED" }, "events"), /ON_TIME or LATE/);
  assert.throws(() => buildIntegrationQuery({ status: "PENDING" }, "cases"), /Case status is invalid/);
  assert.throws(() => buildIntegrationQuery({ case_type: "UNKNOWN_CASE" }, "cases"), /Case type is invalid/);
});

test("filters connectors without searching secret references or payload schemas", () => {
  const rows = [
    { id: "1", display_name: "Payroll", source_system: "PAYROLL", status: "ACTIVE", secret_reference: "hidden" },
    { id: "2", display_name: "Quality feed", source_system: "QMS", status: "PAUSED" },
  ];
  assert.deepEqual(filterIntegrationConnectors(rows, "payroll").map((row) => row.id), ["1"]);
  assert.deepEqual(filterIntegrationConnectors(rows, "", "PAUSED").map((row) => row.id), ["2"]);
  assert.deepEqual(filterIntegrationConnectors(rows, "hidden"), []);
});

test("summarizes domain, connector, delivery and reconciliation counts", () => {
  assert.deepEqual(summarizeIntegrationWorkspace(
    [{ status: "ACTIVE" }, { status: "PENDING_REVIEW" }, { status: "PAUSED" }],
    [{ delivery_class: "LATE" }, { delivery_class: "ON_TIME" }],
    [{ status: "OPEN", severity: "ERROR" }, { status: "RESOLVED", severity: "ERROR" }],
    { items: [{ domain: "QUALITY" }, { domain: "PRODUCTION" }] },
  ), {
    connectors: 3, activeConnectors: 1, pendingConnectors: 1, pausedConnectors: 1,
    events: 2, lateEvents: 1, openCases: 1, errorCases: 1, domains: 2,
  });
});

test("accepts only positive optimistic case versions", () => {
  assert.equal(integrationCaseVersion("3"), 3);
  assert.equal(integrationCaseVersion(0), null);
  assert.equal(integrationCaseVersion("1.5"), null);
  assert.equal(integrationCaseVersion("not-a-version"), null);
});
