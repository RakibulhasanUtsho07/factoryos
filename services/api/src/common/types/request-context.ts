export interface DistributedTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceFlags: string;
  sampled: boolean;
  traceState: string | null;
  startTimeUnixNano: string;
}

export interface RequestContext {
  requestId: string;
  /** Legacy x-trace-id correlation value; W3C trace IDs live in traceContext. */
  traceId: string;
  traceContext?: DistributedTraceContext;
  requestedUserId: string | null;
  requestedTenantId: string | null;
  requestedFactoryId: string | null;
  userId: string | null;
  tenantId: string | null;
  factoryId: string | null;
}
