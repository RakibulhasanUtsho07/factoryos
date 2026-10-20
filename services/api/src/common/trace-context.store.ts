import { AsyncLocalStorage } from 'node:async_hooks';
import type { DistributedTraceContext } from './types/request-context';

const traceContextStorage = new AsyncLocalStorage<DistributedTraceContext>();

/** Run a request pipeline inside an async-local trace context without leaking it between concurrent requests. */
export function runWithTraceContext<T>(
  context: DistributedTraceContext,
  operation: () => T,
): T {
  return traceContextStorage.run(context, operation);
}

export function currentTraceContext(): DistributedTraceContext | undefined {
  return traceContextStorage.getStore();
}

/** W3C headers for an outbound child operation; downstream services see this server span as their parent. */
export function currentTracePropagationHeaders(): Record<string, string> {
  const context = currentTraceContext();
  if (!context) return {};
  const traceparent = '00-' + context.traceId + '-' + context.spanId + '-' + context.traceFlags;
  return {
    traceparent,
    ...(context.traceState ? { tracestate: context.traceState } : {}),
  };
}
