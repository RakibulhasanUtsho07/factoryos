"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  createFactoryOsSessionClient,
  type FactoryOsSessionClient,
} from "@/lib/factoryos-session.mjs";

type JsonRecord = Record<string, unknown>;
type SessionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface WorkspaceFactory {
  id: string;
  code: string;
  name: string;
  status: string;
  timezone?: string;
}

export interface WorkspaceSessionSnapshot {
  user: {
    id: string;
    displayName: string;
    email: string | null;
  };
  tenant: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    defaultLocale: string;
  };
  membership: {
    id: string;
    status: string;
  };
  roles: Array<{ id: string; code: string; name: string }>;
  permissions: Array<{ id: string; code: string; description: string | null }>;
  factories: WorkspaceFactory[];
}

interface ConnectInput {
  apiOrigin: string;
  accessToken: string;
  tenantId: string;
}

interface WorkspaceSessionContextValue {
  status: SessionStatus;
  error: string;
  snapshot: WorkspaceSessionSnapshot | null;
  activeFactoryId: string;
  connect(input: ConnectInput): Promise<void>;
  disconnect(): void;
  selectFactory(factoryId: string): void;
  hasPermission(permissionCode: string): boolean;
}

const WorkspaceSessionContext = createContext<WorkspaceSessionContextValue | null>(null);

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The authenticated API response is missing " + field + ".");
  }
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asItems(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  return Array.isArray(record.items) ? record.items.map(asRecord) : [];
}

function createSnapshot(
  currentUserValue: unknown,
  accessValue: unknown,
  factoriesValue: unknown,
  requestedTenantId: string,
): WorkspaceSessionSnapshot {
  const currentUser = asRecord(currentUserValue);
  if (currentUser.authenticated !== true) {
    throw new Error("The API did not confirm an authenticated session.");
  }

  const identity = asRecord(currentUser.user);
  const identityTenantId = optionalText(identity.tenantId);
  if (identityTenantId && identityTenantId.toLowerCase() !== requestedTenantId.toLowerCase()) {
    throw new Error("The verified identity does not match the requested tenant context.");
  }

  const access = asRecord(accessValue);
  const user = asRecord(access.user);
  const tenant = asRecord(access.tenant);
  const membership = asRecord(access.membership);

  const tenantId = requiredText(tenant.id, "tenant.id");
  if (tenantId.toLowerCase() !== requestedTenantId.toLowerCase()) {
    throw new Error("The IAM access response belongs to a different tenant.");
  }

  if (String(membership.status ?? "").toUpperCase() !== "ACTIVE") {
    throw new Error("The selected tenant membership is not active.");
  }

  const factoryItems = asItems(factoriesValue);
  const factories = factoryItems
    .filter((item) => typeof item.id === "string" && typeof item.code === "string")
    .map((item) => ({
      id: String(item.id),
      code: String(item.code),
      name: typeof item.name === "string" ? item.name : String(item.code),
      status: typeof item.status === "string" ? item.status : "UNKNOWN",
      ...(typeof item.timezone === "string" ? { timezone: item.timezone } : {}),
    }));

  const roles = (Array.isArray(access.roles) ? access.roles : [])
    .map(asRecord)
    .filter((item) => typeof item.id === "string" && typeof item.code === "string")
    .map((item) => ({
      id: String(item.id),
      code: String(item.code),
      name: typeof item.name === "string" ? item.name : String(item.code),
    }));

  const permissions = (Array.isArray(access.permissions) ? access.permissions : [])
    .map(asRecord)
    .filter((item) => typeof item.id === "string" && typeof item.code === "string")
    .map((item) => ({
      id: String(item.id),
      code: String(item.code),
      description: optionalText(item.description),
    }));

  return {
    user: {
      id: requiredText(user.id, "user.id"),
      displayName: typeof user.displayName === "string" && user.displayName.trim()
        ? user.displayName.trim()
        : "FactoryOS user",
      email: optionalText(user.email),
    },
    tenant: {
      id: tenantId,
      slug: requiredText(tenant.slug, "tenant.slug"),
      name: requiredText(tenant.name, "tenant.name"),
      timezone: typeof tenant.timezone === "string" ? tenant.timezone : "UTC",
      defaultLocale: typeof tenant.defaultLocale === "string" ? tenant.defaultLocale : "en",
    },
    membership: {
      id: requiredText(membership.id, "membership.id"),
      status: String(membership.status),
    },
    roles,
    permissions,
    factories,
  };
}

export function FactoryOsSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("disconnected");
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<WorkspaceSessionSnapshot | null>(null);
  const [activeFactoryId, setActiveFactoryId] = useState("");
  const [sessionClient, setSessionClient] = useState<FactoryOsSessionClient | null>(null);

  const disconnect = useCallback(() => {
    sessionClient?.clear();
    setSessionClient(null);
    setSnapshot(null);
    setActiveFactoryId("");
    setError("");
    setStatus("disconnected");
  }, [sessionClient]);

  const connect = useCallback(async (input: ConnectInput) => {
    setError("");
    setStatus("connecting");
    setSnapshot(null);
    setActiveFactoryId("");
    sessionClient?.clear();

    let client: FactoryOsSessionClient | null = null;
    try {
      client = createFactoryOsSessionClient(input);
      const [currentUser, access, factories] = await Promise.all([
        client.getCurrentUser(),
        client.getAccess(),
        client.listFactories(),
      ]);
      const nextSnapshot = createSnapshot(currentUser, access, factories, input.tenantId.trim());

      setSessionClient(client);
      setSnapshot(nextSnapshot);
      const firstActiveFactory = nextSnapshot.factories.find(
        (factory) => factory.status.toUpperCase() === "ACTIVE",
      );
      setActiveFactoryId(firstActiveFactory?.id ?? "");
      setStatus("connected");
    } catch (cause) {
      client?.clear();
      const message = cause instanceof Error ? cause.message : "Could not establish the FactoryOS session.";
      setError(message);
      setStatus("error");
      throw cause instanceof Error ? cause : new Error(message);
    }
  }, [sessionClient]);

  const selectFactory = useCallback((factoryId: string) => {
    if (!factoryId) {
      setActiveFactoryId("");
      return;
    }
    const allowed = snapshot?.factories.some(
      (factory) => factory.id === factoryId && factory.status.toUpperCase() === "ACTIVE",
    );
    if (!allowed) {
      setError("Choose an active factory returned by the authenticated IAM API.");
      return;
    }
    setError("");
    setActiveFactoryId(factoryId);
  }, [snapshot]);

  const permissionSet = useMemo(
    () => new Set(snapshot?.permissions.map((permission) => permission.code) ?? []),
    [snapshot],
  );

  const hasPermission = useCallback(
    (permissionCode: string) => permissionSet.has(permissionCode),
    [permissionSet],
  );

  const value = useMemo<WorkspaceSessionContextValue>(() => ({
    status,
    error,
    snapshot,
    activeFactoryId,
    connect,
    disconnect,
    selectFactory,
    hasPermission,
  }), [status, error, snapshot, activeFactoryId, connect, disconnect, selectFactory, hasPermission]);

  return (
    <WorkspaceSessionContext.Provider value={value}>
      {children}
    </WorkspaceSessionContext.Provider>
  );
}

export function useFactoryOsSession() {
  const context = useContext(WorkspaceSessionContext);
  if (!context) {
    throw new Error("useFactoryOsSession must be used within FactoryOsSessionProvider.");
  }
  return context;
}
