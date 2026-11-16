export interface ProductionWorkspaceClient {
  listWorkOrders(input?: {
    status?: string;
    limit?: number;
  }): Promise<unknown>;
  getWorkOrder(workOrderId: string): Promise<unknown>;
  getMaterialShortageRadar(input?: {
    limit?: number;
  }): Promise<unknown>;
}

export function createProductionWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): ProductionWorkspaceClient;
