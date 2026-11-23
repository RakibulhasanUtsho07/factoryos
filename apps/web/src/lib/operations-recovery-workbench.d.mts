export interface OperationalNotification {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  action_required: boolean;
  status: "UNREAD" | "ACKNOWLEDGED" | string;
  row_version: number;
  created_at?: string;
  acknowledged_at?: string | null;
  last_change_reason?: string | null;
  [key: string]: unknown;
}
export interface QuarantinedOutboxEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  event_version: number;
  status: string;
  attempts: number;
  replay_count: number;
  occurred_at?: string;
  quarantined_at?: string | null;
  [key: string]: unknown;
}
export interface BrokerDeadLetter {
  id: string;
  event_id: string;
  event_type: string;
  consumer_name: string;
  source_topic: string;
  failed_attempts: number;
  failure_count: number;
  failure_reason: string;
  status: string;
  redrive_count: number;
  row_version: number;
  failed_at?: string;
  last_redriven_at?: string | null;
  [key: string]: unknown;
}
export function normalizeOperationsRows(value: unknown, preferredKey?: string): unknown[];
export function buildOperationsInboxQuery(limit?: number, status?: string): string;
export function buildOperationsDlqQuery(factoryId: string, limit?: number, offset?: number, kind?: "outbox" | "broker"): string;
export function buildNotificationAcknowledgePayload(expectedVersion: unknown, reason: string): { expected_version: number; reason: string };
export function validateOperationsIdempotencyKey(value: string): string;
export function summarizeOperationsRecovery(notifications?: OperationalNotification[], quarantined?: QuarantinedOutboxEvent[], brokerDeadLetters?: BrokerDeadLetter[]): Record<string, number>;
export function filterOperationsNotifications(rows?: OperationalNotification[], search?: string, severity?: string): OperationalNotification[];
export function filterOperationsDeadLetters(rows?: Array<QuarantinedOutboxEvent | BrokerDeadLetter>, search?: string): Array<QuarantinedOutboxEvent | BrokerDeadLetter>;
