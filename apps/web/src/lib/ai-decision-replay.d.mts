export interface AiDecisionReplayClient {
  replay(traceId: string): Promise<unknown>;
}

export function isAiTraceId(value: unknown): value is string;

export function createAiDecisionReplayClient(input: {
  request: (
    path: string,
    options?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
    },
  ) => Promise<unknown>;
}): AiDecisionReplayClient;
