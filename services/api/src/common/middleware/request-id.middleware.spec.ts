import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { RequestIdMiddleware } from './request-id.middleware';

describe('RequestIdMiddleware', () => {
  const request = (value?: string) => ({ header: jest.fn(() => value), headers: {} }) as unknown as Request;
  const response = () => ({ setHeader: jest.fn() }) as unknown as Response & { setHeader: jest.Mock };
  it('preserves a bounded safe request identifier', () => {
    const req = request('request.edge-2:operation_3');
    const res = response();
    const next = jest.fn() as unknown as NextFunction;
    new RequestIdMiddleware().use(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'request.edge-2:operation_3');
    expect(req.headers['x-request-id']).toBe('request.edge-2:operation_3');
    expect(next).toHaveBeenCalledTimes(1);
  });
  it.each(['unsafe id', 'x'.repeat(129), 'bad\r\nX-Foo:yes', ''])('replaces malformed request ID %j', (value) => {
    const req = request(value);
    const res = response();
    new RequestIdMiddleware().use(req, res, jest.fn() as unknown as NextFunction);
    expect(String(res.setHeader.mock.calls[0]?.[1])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
