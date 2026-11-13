export interface WorkspaceFactory {
  id: string;
  code: string;
  name: string;
  status: string;
  timezone?: string;
}

export interface WorkspaceSessionSnapshot {
  user: { id: string; displayName: string; email: string | null };
  tenant: { id: string; slug: string; name: string; timezone: string; defaultLocale: string };
  membership: { id: string; status: string };
  roles: Array<{ id: string; code: string; name: string }>;
  permissions: Array<{ id: string; code: string; description: string | null }>;
  factories: WorkspaceFactory[];
}

export function createWorkspaceSessionSnapshot(
  currentUser: unknown,
  access: unknown,
  factories: unknown,
  requestedTenantId: string,
): WorkspaceSessionSnapshot;

export function isActiveWorkspaceFactory(
  snapshot: WorkspaceSessionSnapshot | null | undefined,
  factoryId: string,
): boolean;
