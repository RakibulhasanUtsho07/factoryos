import { createHash } from 'node:crypto';

export const FINANCE_FACT_TYPES = [
  'GL_BALANCE',
  'AR_OPEN',
  'AP_OPEN',
  'BANK_BALANCE',
  'INVENTORY_VALUE',
  'OPEN_PO_COMMITMENT',
  'LC_EXPOSURE',
  'SHIPMENT_MILESTONE',
  'TAX_LIABILITY',
  'ACTUAL_REVENUE',
  'ACTUAL_COST',
  'ACTUAL_CONTRIBUTION_COST',
  'FORECAST_REVENUE',
  'FORECAST_COST',
  'FORECAST_CONTRIBUTION_COST',
] as const;

export type FinanceFactType = (typeof FINANCE_FACT_TYPES)[number];

export const FINANCE_RECONCILABLE_SOURCE_TYPES = [
  'ORDER_LINE', 'PURCHASE_ORDER_LINE', 'GOODS_RECEIPT_LINE', 'UTILITY_METER_READING',
] as const;
export type FinanceReconciliationSourceType = (typeof FINANCE_RECONCILABLE_SOURCE_TYPES)[number];

export const FINANCE_CONNECTOR_DOMAINS = [
  'GL',
  'AP',
  'AR',
  'BANK_RECONCILIATION',
  'TAX_EINVOICE',
  'CUSTOM',
] as const;

export type FinanceConnectorDomain = (typeof FINANCE_CONNECTOR_DOMAINS)[number];

export const FINANCE_CONNECTOR_MODES = [
  'MANUAL',
  'REST_API',
  'WEBHOOK',
  'FILE_IMPORT',
  'FILE_EXPORT',
  'ERP_IMPORT',
  'ERP_EXPORT',
  'SFTP_IMPORT',
  'SFTP_EXPORT',
] as const;

export type FinanceConnectorMode = (typeof FINANCE_CONNECTOR_MODES)[number];

const POSITION_FACT_TYPES = new Set<FinanceFactType>([
  'AR_OPEN',
  'AP_OPEN',
  'BANK_BALANCE',
  'INVENTORY_VALUE',
  'OPEN_PO_COMMITMENT',
  'LC_EXPOSURE',
  'SHIPMENT_MILESTONE',
  'TAX_LIABILITY',
  'GL_BALANCE',
  'FORECAST_REVENUE',
  'FORECAST_COST',
  'FORECAST_CONTRIBUTION_COST',
]);

const DOMAIN_FACT_TYPES: Record<Exclude<FinanceConnectorDomain, 'CUSTOM'>, ReadonlySet<FinanceFactType>> = {
  GL: new Set([
    'GL_BALANCE', 'INVENTORY_VALUE', 'ACTUAL_COST', 'ACTUAL_CONTRIBUTION_COST',
    'FORECAST_COST', 'FORECAST_CONTRIBUTION_COST',
  ]),
  AP: new Set(['AP_OPEN', 'OPEN_PO_COMMITMENT', 'LC_EXPOSURE']),
  AR: new Set(['AR_OPEN', 'SHIPMENT_MILESTONE', 'ACTUAL_REVENUE', 'FORECAST_REVENUE']),
  BANK_RECONCILIATION: new Set(['BANK_BALANCE']),
  TAX_EINVOICE: new Set(['TAX_LIABILITY']),
};

export function isFinanceFactType(value: string): value is FinanceFactType {
  return (FINANCE_FACT_TYPES as readonly string[]).includes(value);
}

export function isFinanceConnectorDomain(value: string): value is FinanceConnectorDomain {
  return (FINANCE_CONNECTOR_DOMAINS as readonly string[]).includes(value);
}

export function isFinanceConnectorMode(value: string): value is FinanceConnectorMode {
  return (FINANCE_CONNECTOR_MODES as readonly string[]).includes(value);
}

export function isPositionFactType(value: FinanceFactType): boolean {
  return POSITION_FACT_TYPES.has(value);
}

export function assertFactCompatibleWithDomain(
  domain: FinanceConnectorDomain,
  factType: FinanceFactType,
): void {
  if (domain !== 'CUSTOM' && !DOMAIN_FACT_TYPES[domain].has(factType)) {
    throw new Error('FINANCE_FACT_TYPE_NOT_ALLOWED_FOR_CONNECTOR_DOMAIN');
  }
}

export function normalizeFinanceCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('FINANCE_CURRENCY_MUST_BE_ISO_4217_CODE');
  }
  return currency;
}

/** Validate a plain decimal as text; never route accounting values through IEEE-754. */
export function normalizeFinanceDecimal(
  value: string,
  options: { allowNegative?: boolean; maxFractionDigits?: number } = {},
): string {
  const maxFractionDigits = options.maxFractionDigits ?? 8;
  if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0 || maxFractionDigits > 8) {
    throw new Error('FINANCE_DECIMAL_SCALE_UNSUPPORTED');
  }

  const text = value.trim();
  const pattern = options.allowNegative
    ? /^-?(?:0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/
    : /^(?:0|[1-9]\d{0,15})(?:\.(\d{1,8}))?$/;
  const match = text.match(pattern);
  if (!match) {
    throw new Error('FINANCE_DECIMAL_INVALID');
  }

  const fraction = match[1] ?? '';
  if (fraction.length > maxFractionDigits) {
    throw new Error('FINANCE_DECIMAL_SCALE_EXCEEDED');
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const parts = unsigned.split('.');
  const integer = parts[0];
  const normalizedFraction = (parts[1] ?? '').replace(/0+$/, '');
  const normalized = normalizedFraction.length > 0
    ? integer + '.' + normalizedFraction
    : integer;
  if (normalized === '0' || /^0\.0+$/.test(normalized)) {
    return '0';
  }
  return negative ? '-' + normalized : normalized;
}

function decimalToScaled(value: string, scaleDigits = 8): bigint {
  const normalized = normalizeFinanceDecimal(value, { allowNegative: true, maxFractionDigits: scaleDigits });
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction = ''] = unsigned.split('.');
  const scaled = BigInt(integer) * (10n ** BigInt(scaleDigits))
    + BigInt((fraction + '0'.repeat(scaleDigits)).slice(0, scaleDigits) || '0');
  return negative ? -scaled : scaled;
}

export function reconciliationMatches(
  sourceQuantity: string,
  expectedQuantity: string,
  quantityTolerance: string,
  sourceRate: string,
  expectedRate: string,
  rateTolerance: string,
): boolean {
  const quantityDelta = decimalToScaled(sourceQuantity) - decimalToScaled(expectedQuantity);
  const rateDelta = decimalToScaled(sourceRate) - decimalToScaled(expectedRate);
  return (quantityDelta < 0n ? -quantityDelta : quantityDelta) <= decimalToScaled(quantityTolerance)
    && (rateDelta < 0n ? -rateDelta : rateDelta) <= decimalToScaled(rateTolerance);
}

export function stableFinanceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableFinanceJson(item)).join(',') + ']';
  }
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map((key) =>
    JSON.stringify(key) + ':' + stableFinanceJson(object[key]),
  ).join(',') + '}';
}

export function financeRequestHash(value: unknown): string {
  return createHash('sha256').update(stableFinanceJson(value)).digest('hex');
}

export function validateFinanceSecretReference(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  const reference = value.trim();
  if (!/^(vault|secret):\/\/[A-Za-z0-9._/-]+$/.test(reference)) {
    throw new Error('FINANCE_SECRET_MUST_BE_A_VAULT_REFERENCE');
  }
  return reference;
}


export interface FinanceSftpConfiguration {
  host: string;
  port: number;
  username: string;
  remote_directory: string;
  file_format: 'CSV' | 'JSON';
  host_key_sha256: string;
  file_pattern?: string;
}

/**
 * Validate an SFTP configuration without performing network I/O. Runtime
 * adapters must also apply an egress allowlist, pin DNS resolution, verify the
 * host-key fingerprint and resolve credentials only through the secret manager.
 */
export function validateFinanceSftpConfiguration(
  mode: FinanceConnectorMode,
  value: Record<string, unknown>,
): FinanceSftpConfiguration {
  if (mode !== 'SFTP_IMPORT' && mode !== 'SFTP_EXPORT') {
    throw new Error('FINANCE_SFTP_CONFIGURATION_MODE_INVALID');
  }
  const allowed = new Set([
    'host', 'port', 'username', 'remote_directory', 'file_format',
    'host_key_sha256', 'file_pattern',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('FINANCE_SFTP_CONFIGURATION_UNSUPPORTED_FIELD');
  }
  const host = typeof value.host === 'string' ? value.host.trim().toLowerCase() : '';
  if (!host || host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
      host.includes('..') || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('FINANCE_SFTP_HOST_INVALID');
  }
  const port = value.port === undefined ? 22 : value.port;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('FINANCE_SFTP_PORT_INVALID');
  }
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username)) {
    throw new Error('FINANCE_SFTP_USERNAME_INVALID');
  }
  const remoteDirectory = typeof value.remote_directory === 'string' ? value.remote_directory.trim() : '';
  if (!remoteDirectory.startsWith('/') || remoteDirectory.length > 512 ||
      remoteDirectory.includes(String.fromCharCode(92)) ||
      remoteDirectory.split('/').some((segment) => segment === '..' || segment === '.') ||
      Array.from(remoteDirectory).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) {
    throw new Error('FINANCE_SFTP_REMOTE_DIRECTORY_INVALID');
  }
  if (value.file_format !== 'CSV' && value.file_format !== 'JSON') {
    throw new Error('FINANCE_SFTP_FILE_FORMAT_INVALID');
  }
  const fingerprint = typeof value.host_key_sha256 === 'string' ? value.host_key_sha256.trim() : '';
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint) && !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('FINANCE_SFTP_HOST_KEY_PIN_REQUIRED');
  }
  let filePattern: string | undefined;
  if (value.file_pattern !== undefined) {
    if (typeof value.file_pattern !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._*-]{0,119}$/.test(value.file_pattern)) {
      throw new Error('FINANCE_SFTP_FILE_PATTERN_INVALID');
    }
    filePattern = value.file_pattern;
  }
  return {
    host,
    port: Number(port),
    username,
    remote_directory: remoteDirectory,
    file_format: value.file_format,
    host_key_sha256: fingerprint,
    ...(filePattern ? { file_pattern: filePattern } : {}),
  };
}

export function validateFinanceEndpoint(
  mode: FinanceConnectorMode,
  value: string | null | undefined,
): string | null {
  if (!value || value.trim() === '') {
    if (mode === 'REST_API' || mode === 'WEBHOOK' || mode === 'ERP_IMPORT' || mode === 'ERP_EXPORT') {
      throw new Error('FINANCE_CONNECTOR_ENDPOINT_REQUIRED');
    }
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FINANCE_CONNECTOR_ENDPOINT_INVALID');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('FINANCE_CONNECTOR_ENDPOINT_MUST_BE_HTTPS_WITHOUT_EMBEDDED_CREDENTIALS');
  }
  for (const [key] of url.searchParams) {
    if (/(password|token|secret|credential|api.?key|authorization|private.?key|client.?secret)/i.test(key)) {
      throw new Error('FINANCE_CONNECTOR_ENDPOINT_MUST_NOT_CONTAIN_CREDENTIAL_QUERY_PARAMETERS');
    }
  }
  return url.toString();
}
