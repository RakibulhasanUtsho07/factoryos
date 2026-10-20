import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { parseTraceParent, TraceIdMiddleware } from './trace-id.middleware';

describe('TraceIdMiddleware', () => {
  function createRequest(headers: Record<string, string> = {}) {
    return { header: jest.fn((name: string) => headers[name.toLowerCase()]), headers: { ...headers } } as unknown as Request & { headers: Record<string, string> };
  }
  function createResponse() { return { setHeader: jest.fn() } as unknown as Response & { setHeader: jest.Mock }; }
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parentSpanId = '00f067aa0ba902b7';

  it('parses W3C version-00 traceparent and preserves its parent relationship', () => {
    expect(parseTraceParent('00-' + traceId + '-' + parentSpanId + '-01')).toEqual({ traceId, parentSpanId, traceFlags: '01', sampled: true });
  });
  it.each([undefined, '00-00000000000000000000000000000000-00f067aa0ba902b7-01', '00-' + traceId + '-0000000000000000-01', '01-' + traceId + '-' + parentSpanId + '-01', '00-' + traceId + '-' + parentSpanId + '-1', 'bad trace context'])('rejects malformed W3C traceparent %j', (value) => {
    expect(parseTraceParent(value)).toBeNull();
  });
  it('creates a child span and returns a W3C traceparent with the same trace id', () => {
    const req = createRequest({ traceparent: '00-' + traceId + '-' + parentSpanId + '-01' });
    const res = createResponse();
    const next = jest.fn() as unknown as NextFunction;
    new TraceIdMiddleware().use(req, res, next);
    expect(req.traceContext).toMatchObject({ traceId, parentSpanId, sampled: true });
    expect(req.traceContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(req.traceContext?.spanId).not.toBe(parentSpanId);
    expect(res.setHeader).toHaveBeenCalledWith('traceparent', '00-' + traceId + '-' + req.traceContext?.spanId + '-01');
    expect(res.setHeader).toHaveBeenCalledWith('x-trace-id', traceId);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('preserves safe legacy x-trace-id and replaces malformed trace context', () => {
    const req = createRequest({ 'x-trace-id': 'trace.edge-17:reading_1', traceparent: 'malformed' });
    const res = createResponse();
    new TraceIdMiddleware().use(req, res, jest.fn() as unknown as NextFunction);
    expect(res.setHeader).toHaveBeenCalledWith('x-trace-id', 'trace.edge-17:reading_1');
    expect(req.traceContext?.parentSpanId).toBeNull();
    expect(req.traceContext?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
  it('does not reflect invalid tracestate and creates context when no trace headers arrive', () => {
    const req = createRequest({ tracestate: 'invalid' });
    const res = createResponse();
    new TraceIdMiddleware().use(req, res, jest.fn() as unknown as NextFunction);
    expect(req.traceContext?.traceState).toBeNull();
    expect(req.traceContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(res.setHeader).toHaveBeenCalledWith('traceparent', expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/));
  });
});
