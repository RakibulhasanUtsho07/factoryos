import { runWithTraceContext, currentTraceContext, currentTracePropagationHeaders } from './trace-context.store';
import type { DistributedTraceContext } from './types/request-context';

describe('trace-context.store', () => {
  const context: DistributedTraceContext = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentSpanId: 'b7ad6b7169203331',
    traceFlags: '01',
    sampled: true,
    traceState: 'vendor=value',
    startTimeUnixNano: '1760961600000000000',
  };

  it('propagates trace context over awaited async work with the current server span as downstream parent', async () => {
    const outsideBefore = currentTraceContext();
    const result = await runWithTraceContext(context, async () => {
      await Promise.resolve();
      expect(currentTraceContext()).toEqual(context);
      return currentTracePropagationHeaders();
    });
    expect(result).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
    });
    expect(currentTraceContext()).toBe(outsideBefore);
    expect(currentTracePropagationHeaders()).toEqual({});
  });

  it('does not share trace context between independent async chains', async () => {
    const first = { ...context, traceId: '11111111111111111111111111111111' };
    const second = { ...context, traceId: '22222222222222222222222222222222' };
    const values = await Promise.all([
      runWithTraceContext(first, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return currentTracePropagationHeaders().traceparent;
      }),
      runWithTraceContext(second, async () => {
        await Promise.resolve();
        return currentTracePropagationHeaders().traceparent;
      }),
    ]);
    expect(values[0]).toContain(first.traceId);
    expect(values[1]).toContain(second.traceId);
  });
});
