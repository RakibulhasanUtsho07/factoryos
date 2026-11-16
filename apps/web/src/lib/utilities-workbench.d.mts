export type UtilityType =
  | "ELECTRICITY"
  | "GAS"
  | "STEAM"
  | "WATER"
  | "COMPRESSED_AIR"
  | "FUEL"
  | "OTHER";

export type UtilityMeterStatus = "ACTIVE" | "INACTIVE" | "RETIRED";
export type UtilityEventStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "CANCELLED";

export interface UtilityMeterQuery {
  limit?: number;
  utilityType?: UtilityType;
  status?: UtilityMeterStatus;
}

export interface UtilityReadingQuery {
  meterId: string;
  limit?: number;
  from?: string;
  to?: string;
}

export interface UtilityEventQuery {
  limit?: number;
  status?: UtilityEventStatus;
}

export interface UtilityAlertQuery {
  limit?: number;
  status?: UtilityEventStatus;
}

export interface UtilityListQuery {
  limit?: number;
}

export interface UtilitiesWorkbenchClient {
  listMeters(query?: UtilityMeterQuery): Promise<unknown>;
  listReadings(query: UtilityReadingQuery): Promise<unknown>;
  listEvents(query?: UtilityEventQuery): Promise<unknown>;
  listThresholdAlerts(query?: UtilityAlertQuery): Promise<unknown>;
  listThresholdPolicies(query?: UtilityListQuery): Promise<unknown>;
  listSourceBindings(query?: UtilityListQuery): Promise<unknown>;
}

export function createUtilitiesWorkbenchClient(options: {
  request: (path: string, options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  }) => Promise<unknown>;
}): UtilitiesWorkbenchClient;

export const utilitiesTypes: readonly UtilityType[];
export const utilitiesMeterStatuses: readonly UtilityMeterStatus[];
export const utilitiesEventStatuses: readonly UtilityEventStatus[];
export const utilitiesAlertStatuses: readonly UtilityEventStatus[];
