export interface IntegrationConnector {
  id: string;
  display_name: string;
  source_system: string;
  connector_type: string;
  status: "PENDING_REVIEW" | "ACTIVE" | "PAUSED" | "REJECTED" | string;
  webhook_path?: string;
  schema_version: number;
  allowed_event_types: string[];
  has_secret_reference: boolean;
  decision_reason?: string | null;
  created_at?: string;
  reviewed_at?: string | null;
  paused_at?: string | null;
  [key: string]: unknown;
}
export interface IntegrationEvent {
  id: string;
  domain: "ATTENDANCE" | "PRODUCTION" | "QUALITY" | string;
  source_system: string;
  event_type: string;
  schema_version: number;
  occurred_at?: string | null;
  source_sequence?: string | number | null;
  watermark_through_sequence?: string | number | null;
  delivery_class: "ON_TIME" | "LATE" | string;
  received_at?: string;
  [key: string]: unknown;
}
export interface IntegrationCase {
  id: string;
  domain: string;
  case_type: string;
  status: "OPEN" | "RESOLVED" | "WAIVED" | string;
  severity: "INFO" | "WARNING" | "ERROR" | string;
  row_version: number;
  opened_at?: string;
  resolved_at?: string | null;
  resolution_reason?: string | null;
  [key: string]: unknown;
}
export function normalizeIntegrationRows(value: unknown, preferredKey?: string): unknown[];
export function validateIntegrationPayloadSchema(input: unknown): Record<string, unknown>;
export function buildIntegrationConnectorPayload(input: Record<string, unknown>): {
  display_name: string; source_system: string; secret_reference: string; schema_version: number;
  allowed_event_types: string[]; payload_schema: Record<string, unknown>;
};
export function buildIntegrationDecisionPayload(reason: string): { reason: string };
export function buildIntegrationSecretRotationPayload(secretReference: string, reason: string): { secret_reference: string; reason: string };
export function buildIntegrationCaseDecisionPayload(action: string, expectedVersion: unknown, reason: string): { action: "RESOLVE" | "WAIVE"; expected_version: number; reason: string };
export function buildIntegrationQuery(filters?: Record<string, unknown>, kind?: "report" | "events" | "cases" | "connectors"): string;
export function summarizeIntegrationWorkspace(connectors?: IntegrationConnector[], events?: IntegrationEvent[], cases?: IntegrationCase[], report?: unknown): Record<string, number>;
export function filterIntegrationConnectors(rows?: IntegrationConnector[], search?: string, status?: string): IntegrationConnector[];
export function integrationCaseVersion(value: unknown): number | null;
