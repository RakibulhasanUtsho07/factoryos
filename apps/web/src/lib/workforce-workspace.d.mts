export interface WorkforceWorkspaceClient {
  listWorkers(input?: { limit?: number }): Promise<unknown>;
  listShifts(input?: { limit?: number }): Promise<unknown>;
  staffingCoverage(input: {
    shiftDate: string;
    shiftTemplateId?: string;
  }): Promise<unknown>;
  listAttendance(input: {
    shiftDate: string;
    shiftTemplateId?: string;
    limit?: number;
  }): Promise<unknown>;
}

export function createWorkforceWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): WorkforceWorkspaceClient;
