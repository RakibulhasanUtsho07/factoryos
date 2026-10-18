export const FINANCE_ERP_TRANSFER = Symbol('FINANCE_ERP_TRANSFER');

export interface FinanceErpFileDownload {
  /** Stable provider-side batch key; never inferred from the remote path. */
  source_batch_ref: string;
  file_name: string;
  format: 'CSV' | 'JSON';
  content: Buffer;
  source_occurred_at?: string;
  /** Opaque provider reference for later idempotent acknowledgement. */
  provider_reference: string;
}

export interface FinanceErpUploadResult {
  /** Opaque provider operation/file reference, never a credential or signed URL. */
  provider_reference: string;
  payload_sha256: string;
  bytes_written: number;
}

export interface FinanceErpTransferAdapter {
  /**
   * Provider-specific mapping/transport is deployed out-of-process from this contract.
   * Implementations must resolve auth from the supplied secret-manager reference,
   * enforce an outbound hostname/IP allowlist, pin DNS per connection, reject private/
   * link-local/metadata addresses, validate redirects and never log credentials or
   * signed response URLs. Do not derive a tenant from provider payload metadata.
   */
  downloadNext(input: {
    tenant_id: string;
    factory_id: string;
    connector_id: string;
    endpoint_url: string;
    secret_reference: string;
    configuration: Record<string, unknown>;
  }): Promise<FinanceErpFileDownload | null>;

  /** Acknowledge only after the durable import receipt exists; quarantine invalid files. */
  acknowledge(input: {
    tenant_id: string;
    factory_id: string;
    connector_id: string;
    endpoint_url: string;
    secret_reference: string;
    configuration: Record<string, unknown>;
    source_batch_ref: string;
    provider_reference: string;
    payload_sha256: string;
    disposition: 'PROCESSED' | 'QUARANTINED';
  }): Promise<void>;

  /** Idempotent upsert by deterministic filename or provider idempotency reference. */
  upload(input: {
    tenant_id: string;
    factory_id: string;
    connector_id: string;
    endpoint_url: string;
    secret_reference: string;
    configuration: Record<string, unknown>;
    file_name: string;
    format: 'CSV' | 'JSON';
    content: Buffer;
    payload_sha256: string;
  }): Promise<FinanceErpUploadResult>;
}
