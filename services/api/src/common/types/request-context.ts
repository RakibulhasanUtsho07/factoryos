export interface RequestContext {
  requestId: string;
  traceId: string;

  requestedUserId: string | null;
  requestedTenantId: string | null;

  userId: string | null;
  tenantId: string | null;
}