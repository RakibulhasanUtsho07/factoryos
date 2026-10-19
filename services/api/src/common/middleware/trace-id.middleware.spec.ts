import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { TraceIdMiddleware } from './trace-id.middleware';

describe('TraceIdMiddleware', () => {
  function createRequest(value?: string) {
    return {
      header: jest.fn(() => value),
      headers: {},
    } as unknown as Request;
  }

  function createResponse() {
    return { setHeader: jest.fn() } as unknown as Response & {
      setHeader: jest.Mock;
    };
  }

  it('preserves a bounded, safe correlation identifier', () => {
    const middleware = new TraceIdMiddleware();
    const req = createRequest('trace.edge-17:reading_1');
    const res = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('x-trace-id', 'trace.edge-17:reading_1');
    expect(req.headers['x-trace-id']).toBe('trace.edge-17:reading_1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    'bad id with spaces',
    'x'.repeat(129),
    'unsafe\\r\\nX-Injected: yes',
    '',
  ])('replaces malformed inbound trace id %j with a generated UUID', (incoming) => {
    const middleware = new TraceIdMiddleware();
    const req = createRequest(incoming);
    const res = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    const traceId = (res.setHeader as jest.Mock).mock.calls[0]?.[1];
    expect(typeof traceId).toBe('string');
    expect(String(traceId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(req.headers['x-trace-id']).toBe(traceId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
