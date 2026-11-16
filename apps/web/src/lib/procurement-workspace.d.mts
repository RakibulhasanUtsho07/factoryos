export interface ProcurementWorkspaceClient {
  listPurchaseOrders(input?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<unknown>;
  getPurchaseOrder(purchaseOrderId: string): Promise<unknown>;
  listSuppliers(input?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<unknown>;
  listGoodsReceipts(
    purchaseOrderId: string,
    input?: { limit?: number },
  ): Promise<unknown>;
  getGoodsReceipt(receiptId: string): Promise<unknown>;
}

export function createProcurementWorkspaceClient(input: {
  request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}): ProcurementWorkspaceClient;
