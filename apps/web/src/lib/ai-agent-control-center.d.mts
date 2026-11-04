export interface AiAgentControlCenterClient {
  listAgents(): Promise<unknown>;
  listTasks(limit?: number): Promise<unknown>;
  listWorkflowDrafts(): Promise<unknown>;
  listTemplates(): Promise<unknown>;
  getAgent(id: string): Promise<unknown>;
  getAgentControl(id: string): Promise<unknown>;
  getEvaluationReport(id: string): Promise<unknown>;
  getTask(id: string): Promise<unknown>;
  setAgentControl(id: string, body: {
    status: 'ENABLED' | 'PAUSED' | 'RESTRICTED';
    execution_scopes: string[];
    reason: string;
  }): Promise<unknown>;
  cancelTask(id: string): Promise<unknown>;
  executeStep(taskId: string, stepId: string): Promise<unknown>;
  resumeTaskStep(taskId: string, stepId: string): Promise<unknown>;
  verifyTask(id: string): Promise<unknown>;
}

export function createAiAgentControlCenterClient(options: {
  apiOrigin: string;
  accessToken: string;
  tenantId: string;
  factoryId: string;
  fetchImpl?: typeof fetch;
  idFactory?: () => string;
}): AiAgentControlCenterClient;

export function isTerminalAgentTaskState(state: unknown): boolean;
export function canExecuteAgentStep(step: unknown, now?: number): boolean;
