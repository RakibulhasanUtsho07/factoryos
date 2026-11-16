export type FinanceClosePeriodStatus = "DRAFT" | "SUBMITTED" | "APPROVED";

export interface FinanceWorkbenchQuery {
  from?: string;
  to?: string;
  currency?: string;
  horizonDays?: number;
  unreconciledLimit?: number;
}

export interface FinanceClosePeriodQuery {
  status?: FinanceClosePeriodStatus;
  currency?: string;
  from?: string;
  to?: string;
}

export interface FinanceWorkbenchClient {
  readWorkbench(query?: FinanceWorkbenchQuery): Promise<unknown>;
  listClosePeriods(query?: FinanceClosePeriodQuery): Promise<unknown>;
}

export function createFinanceWorkbenchClient(options: {
  request: (path: string, options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  }) => Promise<unknown>;
}): FinanceWorkbenchClient;

export const financeClosePeriodStatuses: readonly FinanceClosePeriodStatus[];
