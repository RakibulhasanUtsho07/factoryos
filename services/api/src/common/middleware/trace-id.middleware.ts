import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DistributedTraceContext } from '../types/request-context';

const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACEPARENT_V00_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface ParsedTraceParent {
  traceId: string;
  parentSpanId: string;
  traceFlags: string;
  sampled: boolean;
}

/** Strict W3C Trace Context v00 parsing; invalid/all-zero identifiers create a new root trace. */
export function parseTraceParent(value: string | undefined): ParsedTraceParent | null {
  if (!value) return null;
  const match = TRACEPARENT_V00_PATTERN.exec(value.trim());
  if (!match) return null;
  const traceId = match[1]!;
  const parentSpanId = match[2]!;
  const traceFlags = match[3]!;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId, parentSpanId, traceFlags, sampled: (Number.parseInt(traceFlags, 16) & 0x01) === 0x01 };
}

function randomHex(byteLength: number): string { return randomBytes(byteLength).toString('hex'); }
function samplingRatio(): number {
  const raw = process.env.TRACE_SAMPLE_RATIO;
  if (raw === undefined || raw.trim() === '') return 0.1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}
function safeTraceState(value: string | undefined): string | null {
  if (!value || value.length > 512 || /[^\x20-\x7E]/.test(value)) return null;
  const members = value.split(',');
  if (members.length > 32 || members.some((member) => !/^\s*[0-9A-Za-z_*/-]+@?[0-9A-Za-z_*/-]*=([^,]{1,256})\s*$/.test(member))) return null;
  return value.trim();
}

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = parseTraceParent(req.header('traceparent'));
    const candidate = req.header('x-trace-id')?.trim();
    const validLegacyCandidate = candidate && TRACE_ID_PATTERN.test(candidate) ? candidate : null;
    const candidateW3cTraceId = validLegacyCandidate && /^[0-9a-f]{32}$/i.test(validLegacyCandidate)
      && !/^0+$/.test(validLegacyCandidate) ? validLegacyCandidate.toLowerCase() : null;
    const traceId = inbound?.traceId ?? candidateW3cTraceId ?? randomHex(16);
    const legacyTraceId = inbound ? inbound.traceId : validLegacyCandidate ?? traceId;
    const spanId = randomHex(8);
    const sampled = inbound ? inbound.sampled : Math.random() < samplingRatio();
    const traceFlags = inbound ? inbound.traceFlags : sampled ? '01' : '00';
    const traceState = safeTraceState(req.header('tracestate'));
    const traceContext: DistributedTraceContext = {
      traceId, spanId, parentSpanId: inbound?.parentSpanId ?? null, traceFlags,
      sampled, traceState, startTimeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
    };
    const outgoingTraceParent = '00-' + traceId + '-' + spanId + '-' + traceFlags;
    req.traceContext = traceContext;
    req.headers.traceparent = outgoingTraceParent;
    req.headers['x-trace-id'] = legacyTraceId;
    res.setHeader('x-trace-id', legacyTraceId);
    res.setHeader('traceparent', outgoingTraceParent);
    if (traceState) {
      req.headers.tracestate = traceState;
      res.setHeader('tracestate', traceState);
    } else {
      delete req.headers.tracestate;
    }
    next();
  }
}
