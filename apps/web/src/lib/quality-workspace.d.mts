export interface QualityWorkspaceClient {
  listInspections(input?: {
    status?: string;
    inspectionType?: string;
    targetType?: string;
    limit?: number;
  }): Promise<unknown>;
  getInspection(inspectionId: string): Promise<unknown>;
  listInspectionPlans(input?: {
    status?: string;
    inspectionType?: string;
    limit?: number;
  }): Promise<unknown>;
  listHolds(input?: {
    status?: string;
    limit?: number;
  }): Promise<unknown>;
  listReworkOrders(input?: {
    status?: string;
    limit?: number;
  }): Promise<unknown>;
}

export function createQualityWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): QualityWorkspaceClient;
