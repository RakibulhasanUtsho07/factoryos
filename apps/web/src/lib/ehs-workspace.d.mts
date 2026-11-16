export interface EhsWorkspaceClient {
  listIncidents(input?: {
    status?: string;
    severity?: string;
    limit?: number;
  }): Promise<unknown>;
  listPermits(input?: {
    status?: string;
    riskLevel?: string;
    limit?: number;
  }): Promise<unknown>;
  listCorrectiveActions(
    incidentId: string,
    input?: { limit?: number },
  ): Promise<unknown>;
}

export function createEhsWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): EhsWorkspaceClient;
