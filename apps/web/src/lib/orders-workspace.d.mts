export interface OrdersWorkspaceClient {
  listOrders(input?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  listProductionReports(
    orderId: string,
    options?: { limit?: number },
  ): Promise<unknown>;
}

export function createOrdersWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): OrdersWorkspaceClient;
