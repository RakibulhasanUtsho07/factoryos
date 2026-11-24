export interface EdgeDevice {
  id: string;
  deviceKey: string;
  displayName: string;
  protocol: "OPC_UA" | "MQTT" | "MODBUS" | "GENERIC" | string;
  deviceGroup?: string | null;
  capabilityProfile?: Record<string, unknown>;
  status: "ACTIVE" | "PAUSED" | "REVOKED" | string;
  lastSeenAt?: string | null;
  lastSyncAt?: string | null;
  latestHealth?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}
export function normalizeEdgeRows(value: unknown, preferredKey?: string): unknown[];
export function buildEdgeDevicePayload(input: Record<string, unknown>): {
  device_key: string; display_name: string; protocol: string; device_group?: string;
  capability_profile: Record<string, unknown>;
};
export function buildEdgeCredentialPayload(validForDays: unknown): { valid_for_days: number };
export function buildEdgeSigningKeyPayload(input: Record<string, unknown>): {
  key_id: string; public_key_pem: string; replaces_key_id?: string;
};
export function buildEdgePackageControlPayload(input: Record<string, unknown>): {
  package_id: string; package_version: string; target_kind: string; target_key: string;
  action: "PAUSE" | "RESUME" | "REVOKE"; reason: string;
};
export function buildEdgeSigningKeyRevocationPayload(reason: string): { reason: string };
export function filterEdgeDevices(rows?: EdgeDevice[], search?: string, status?: string, protocol?: string): EdgeDevice[];
export function summarizeEdgeDevices(rows?: EdgeDevice[]): {
  total: number; active: number; paused: number; revoked: number;
  healthy: number; attention: number; neverSeen: number;
};
export function isEdgeUuid(value: unknown): value is string;
export function safeEdgePayloadPreview(value: unknown, maxLength?: number): string;
