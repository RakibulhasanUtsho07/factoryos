import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { HttpMetricsService } from './http-metrics.service';

describe('HttpMetricsMiddleware', () => {
  it('records exactly once when a response emits finish and close', () => {
    const metrics = {
      beginRequest: jest.fn(() => 'GET' as const),
      completeRequest: jest.fn(),
    } as unknown as HttpMetricsService;
    const listeners = new Map<string, () => void>();
    const res = {
      statusCode: 200,
      writableEnded: true,
      once: jest.fn((event: string, callback: () => void) => {
        listeners.set(event, callback);
        return res;
      }),
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;
    const middleware = new HttpMetricsMiddleware(metrics);

    middleware.use({ method: 'GET' } as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    listeners.get('finish')?.();
    listeners.get('close')?.();
    expect(metrics.completeRequest).toHaveBeenCalledTimes(1);
    expect(metrics.completeRequest).toHaveBeenCalledWith('GET', 200, expect.any(Number));
  });

  it('records a client-aborted response when close happens before finish', () => {
    const metrics = {
      beginRequest: jest.fn(() => 'POST' as const),
      completeRequest: jest.fn(),
    } as unknown as HttpMetricsService;
    const listeners = new Map<string, () => void>();
    const res = {
      statusCode: 200,
      writableEnded: false,
      once: jest.fn((event: string, callback: () => void) => {
        listeners.set(event, callback);
        return res;
      }),
    } as unknown as Response;
    new HttpMetricsMiddleware(metrics).use({ method: 'POST' } as Request, res, jest.fn() as unknown as NextFunction);
    listeners.get('close')?.();
    expect(metrics.completeRequest).toHaveBeenCalledWith('POST', 499, expect.any(Number));
  });
});
