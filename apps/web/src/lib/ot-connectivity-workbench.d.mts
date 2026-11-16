export type OtDeviceStatus = "PENDING_REVIEW" | "ACTIVE" | "PAUSED" | "REVOKED";
export type OtProtocol = "OPC_UA" | "MQTT" | "MODBUS_TCP";
export type OtDeliveryStatus = "ON_TIME" | "LATE" | "SEQUENCE_GAP";

export interface OtDeviceListQuery {
  status?: OtDeviceStatus;
  protocol?: OtProtocol;
}

export interface OtDeviceIdQuery {
  deviceId: string;
}

export interface OtTelemetryQuery extends OtDeviceIdQuery {
  limit?: number;
}

export interface OtConnectivityClient {
  listDevices(query?: OtDeviceListQuery): Promise<unknown>;
  getDevice(query: OtDeviceIdQuery): Promise<unknown>;
  listHistory(query: OtDeviceIdQuery): Promise<unknown>;
  listTelemetry(query: OtTelemetryQuery): Promise<unknown>;
}

export function createOtConnectivityClient(options: {
  request: (path: string, options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  }) => Promise<unknown>;
}): OtConnectivityClient;

export const otDeviceStatuses: readonly OtDeviceStatus[];
export const otProtocols: readonly OtProtocol[];
export const otDeliveryStatuses: readonly OtDeliveryStatus[];
