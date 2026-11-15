export interface AiDecisionReplayClient {
  replay(traceId: string): Promise<unknown>;
}

export function isAiTraceId(value: unknown): value is string;

export function createAiDecisionReplayClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): AiDecisionReplayClient;
