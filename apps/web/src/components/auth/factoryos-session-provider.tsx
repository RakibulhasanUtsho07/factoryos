"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createFactoryOsSessionClient,
  readLocalDevelopmentSession,
  type FactoryOsSessionClient,
  type FactoryOsSessionRequestOptions,
} from "@/lib/factoryos-session.mjs";
import {
  createWorkspaceSessionSnapshot,
  isActiveWorkspaceFactory,
  type WorkspaceSessionSnapshot,
} from "@/lib/factoryos-session-model.mjs";

type SessionStatus = "disconnected" | "connecting" | "connected" | "error";

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
  request(path: string, options?: Omit<FactoryOsSessionRequestOptions, "factoryId">): Promise<unknown>;
}

const WorkspaceSessionContext = createContext<WorkspaceSessionContextValue | null>(null);

export function FactoryOsSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("disconnected");
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<WorkspaceSessionSnapshot | null>(null);
  const [activeFactoryId, setActiveFactoryId] = useState("");
  const [sessionClient, setSessionClient] = useState<FactoryOsSessionClient | null>(null);
  const restoreAttempted = useRef(false);

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
    setSessionClient(null);

    let client: FactoryOsSessionClient | null = null;
    try {
      client = createFactoryOsSessionClient(input);
      const [currentUser, access, factories] = await Promise.all([
        client.getCurrentUser(),
        client.getAccess(),
        client.listFactories(),
      ]);
      const nextSnapshot = createWorkspaceSessionSnapshot(
        currentUser,
        access,
        factories,
        input.tenantId.trim(),
      );

      setSessionClient(client);
      setSnapshot(nextSnapshot);
      const firstActiveFactory = nextSnapshot.factories.find(
        (factory) => factory.status.toUpperCase() === "ACTIVE",
      );
      setActiveFactoryId(firstActiveFactory?.id ?? "");
      setStatus("connected");
    } catch (cause) {
      client?.clear();
      const message = cause instanceof Error
        ? cause.message
        : "Could not establish the FactoryOS session.";
      setSessionClient(null);
      setSnapshot(null);
      setActiveFactoryId("");
      setError(message);
      setStatus("error");
      throw cause instanceof Error ? cause : new Error(message);
    }
  }, [sessionClient]);

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    const savedSession = readLocalDevelopmentSession();
    if (!savedSession) return;
    // Defer state updates out of the effect body; only local development
    // sessions for localhost APIs can be restored by readLocalDevelopmentSession.
    void Promise.resolve()
      .then(() => connect(savedSession))
      .catch(() => undefined);
  }, [connect]);

  const selectFactory = useCallback((factoryId: string) => {
    if (!factoryId) {
      setActiveFactoryId("");
      return;
    }
    if (!isActiveWorkspaceFactory(snapshot, factoryId)) {
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

  const request = useCallback((
    path: string,
    options: Omit<FactoryOsSessionRequestOptions, "factoryId"> = {},
  ) => {
    if (status !== "connected" || !sessionClient || !snapshot) {
      throw new Error("Connect an authenticated FactoryOS session before using this workspace.");
    }
    if (!activeFactoryId || !isActiveWorkspaceFactory(snapshot, activeFactoryId)) {
      throw new Error("Select an active factory from the authenticated IAM factory list first.");
    }
    return sessionClient.request(path, { ...options, factoryId: activeFactoryId });
  }, [status, sessionClient, snapshot, activeFactoryId]);

  const value = useMemo<WorkspaceSessionContextValue>(() => ({
    status,
    error,
    snapshot,
    activeFactoryId,
    connect,
    disconnect,
    selectFactory,
    hasPermission,
    request,
  }), [status, error, snapshot, activeFactoryId, connect, disconnect, selectFactory, hasPermission, request]);

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
