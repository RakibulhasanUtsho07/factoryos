export interface FactoryOsSessionConfig {
  apiOrigin: string;
  accessToken: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
  idFactory?: () => string;
}

export class FactoryOsSessionError extends Error {
  constructor(message: string, status: number);
  readonly status: number;
  readonly code: "UNAUTHENTICATED" | "ACCESS_DENIED" | "API_REQUEST_FAILED";
}

export interface FactoryOsSessionClient {
  getCurrentUser(): Promise<unknown>;
  getAccess(): Promise<unknown>;
  listFactories(): Promise<unknown>;
  clear(): void;
}

export function createFactoryOsSessionClient(
  config: FactoryOsSessionConfig,
): FactoryOsSessionClient;
