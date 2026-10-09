export interface ApiMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  [key: string]: unknown;
}

export interface ApiErrorItem {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  request_id: string;
  trace_id: string;
  api_version: string;
  tenant_id: string | null;
  data: T;
  meta: ApiMeta;
  errors: ApiErrorItem[];
}