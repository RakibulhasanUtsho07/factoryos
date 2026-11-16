export interface MaintenanceWorkspaceClient {
  listAssets(input?: {
    status?: string;
    limit?: number;
  }): Promise<unknown>;
  listPmPlans(input?: {
    status?: string;
    assetId?: string;
    limit?: number;
  }): Promise<unknown>;
  listWorkOrders(input?: {
    status?: string;
    type?: string;
    priority?: string;
    assetId?: string;
    limit?: number;
  }): Promise<unknown>;
  getWorkOrder(workOrderId: string): Promise<unknown>;
}

export function createMaintenanceWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): MaintenanceWorkspaceClient;
