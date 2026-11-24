export type OperationalNotificationRecord = Record<string, unknown>;
export interface OperationalNotificationRequest {
  (path: string, options?: { method?: "GET" | "POST"; body?: unknown }): Promise<unknown>;
}
export interface OperationalNotificationClient {
  listInbox(input?: { limit?: number; status?: "UNREAD" | "ACKNOWLEDGED" | "" }): Promise<unknown>;
  acknowledge(notificationId: string, body: OperationalNotificationRecord): Promise<unknown>;
}
export function normalizeOperationalNotificationRows(value: unknown): unknown[];
export function buildOperationalNotificationInboxQuery(input?: { limit?: number; status?: "UNREAD" | "ACKNOWLEDGED" | "" }): string;
export function buildOperationalNotificationAcknowledgementPayload(input?: OperationalNotificationRecord): OperationalNotificationRecord;
export function filterOperationalNotifications(input: unknown, filters?: { query?: string; category?: string; severity?: string; actionOnly?: boolean }): unknown[];
export function summarizeOperationalNotifications(input: unknown): { total: number; unread: number; acknowledged: number; actionRequired: number; critical: number };
export function createOperationalNotificationClient(request: OperationalNotificationRequest): OperationalNotificationClient;
