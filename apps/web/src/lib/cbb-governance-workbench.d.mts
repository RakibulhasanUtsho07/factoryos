export type CbbEvidenceState =
  | "VERIFIED"
  | "INFERRED"
  | "PROPOSED"
  | "CONFLICTING"
  | "STALE";

export type CbbTargetType =
  | "BLUEPRINT"
  | "ENTITY"
  | "RELATION"
  | "PROCESS"
  | "PROCESS_STEP"
  | "RULE"
  | "TERM"
  | "EXCEPTION";

export type CbbConflictStatus = "OPEN" | "RESOLVED" | "DISMISSED";

export interface CbbVersionMapQuery {
  versionId: string;
}

export interface CbbProcessQuery {
  processId: string;
}

export interface CbbEvidenceQuery {
  state?: CbbEvidenceState;
  targetType?: CbbTargetType;
  targetId?: string;
  limit?: number;
  offset?: number;
}

export interface CbbConflictQuery {
  status?: CbbConflictStatus;
  subjectType?: CbbTargetType;
  limit?: number;
  offset?: number;
}

export interface CbbTerminologyQuery {
  search?: string;
}

export interface CbbGovernanceClient {
  getBusinessModel(): Promise<unknown>;
  getBusinessMap(): Promise<unknown>;
  getVersionMap(query: CbbVersionMapQuery): Promise<unknown>;
  listProcesses(): Promise<unknown>;
  getProcess(query: CbbProcessQuery): Promise<unknown>;
  listVersions(): Promise<unknown>;
  listEvidence(query?: CbbEvidenceQuery): Promise<unknown>;
  listConflicts(query?: CbbConflictQuery): Promise<unknown>;
  listStaleness(): Promise<unknown>;
  listTerminology(query?: CbbTerminologyQuery): Promise<unknown>;
}

export function createCbbGovernanceClient(options: {
  request: (path: string, options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  }) => Promise<unknown>;
}): CbbGovernanceClient;

export const cbbEvidenceStates: readonly CbbEvidenceState[];
export const cbbTargetTypes: readonly CbbTargetType[];
export const cbbConflictStatuses: readonly CbbConflictStatus[];
