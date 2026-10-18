import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash } from 'node:crypto';
import { FinanceFileImportDto, IngestFinanceFactsDto } from './dto/finance.dto';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 500;
const REQUIRED_HEADERS = [
  'external_fact_id', 'source_fact_key', 'fact_type', 'source_record_type',
  'source_record_ref', 'effective_at', 'currency', 'amount',
] as const;
const ALLOWED_HEADERS = new Set([
  'external_fact_id', 'source_fact_key', 'fact_type', 'source_record_type',
  'source_record_ref', 'effective_at', 'due_at', 'currency', 'amount',
  'customer_ref', 'product_id', 'product_ref', 'order_id', 'order_ref',
  'cost_center_ref', 'shipment_ref', 'source_quantity', 'source_rate',
  'source_uom_code', 'metadata_snapshot', 'reconciliation',
]);

export interface ParsedFinanceFileImport {
  batch: IngestFinanceFactsDto;
  sourceFileName: string;
  sourceFormat: 'CSV' | 'JSON';
  sourcePayloadSha256: string;
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  const pushField = () => {
    record.push(field);
    field = '';
    afterQuote = false;
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
    if (records.length > MAX_ROWS + 1) {
      throw new BadRequestException('Finance CSV cannot contain more than 500 data rows');
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += ch;
      }
      if (field.length > 32768) throw new BadRequestException('A finance CSV field exceeds the 32 KiB limit');
      continue;
    }

    if (afterQuote) {
      if (ch === ',') pushField();
      else if (ch === '\n') pushRecord();
      else if (ch === '\r' && text[i + 1] === '\n') {
        pushRecord();
        i += 1;
      } else if (ch !== ' ' && ch !== '\t') {
        throw new BadRequestException('Finance CSV has unexpected characters after a quoted field');
      }
      continue;
    }

    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRecord();
    else if (ch === '\r' && text[i + 1] === '\n') {
      pushRecord();
      i += 1;
    } else if (ch === '"') {
      throw new BadRequestException('Finance CSV contains a quote inside an unquoted field');
    } else {
      field += ch;
      if (field.length > 32768) throw new BadRequestException('A finance CSV field exceeds the 32 KiB limit');
    }
  }

  if (quoted) throw new BadRequestException('Finance CSV contains an unterminated quoted field');
  if (field.length > 0 || record.length > 0 || afterQuote) pushRecord();
  return records;
}

function parseJsonCell(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestException('Finance CSV column ' + fieldName + ' must contain valid JSON');
  }
}

function parseCsvFacts(text: string): unknown[] {
  const records = parseCsvRecords(text.replace(/^\uFEFF/, ''));
  if (records.length < 2) throw new BadRequestException('Finance CSV must include a header and at least one data row');

  const headers = records[0].map((header) => header.trim());
  if (headers.some((header) => !header)) throw new BadRequestException('Finance CSV headers cannot be blank');
  if (new Set(headers).size !== headers.length) throw new BadRequestException('Finance CSV cannot repeat column headers');
  const unknown = headers.filter((header) => !ALLOWED_HEADERS.has(header));
  if (unknown.length) throw new BadRequestException('Finance CSV contains unsupported columns: ' + unknown.join(', '));
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new BadRequestException('Finance CSV is missing required columns: ' + missing.join(', '));

  const facts: Record<string, unknown>[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const cells = records[index];
    if (cells.length === 1 && cells[0].trim() === '') continue;
    if (cells.length !== headers.length) {
      throw new BadRequestException('Finance CSV row ' + (index + 1) + ' has ' + cells.length +
        ' fields; expected ' + headers.length);
    }
    const fact: Record<string, unknown> = {};
    for (let column = 0; column < headers.length; column += 1) {
      const name = headers[column];
      const cell = cells[column];
      if (cell.trim() === '') continue;
      fact[name] = name === 'metadata_snapshot' || name === 'reconciliation'
        ? parseJsonCell(cell, name)
        : cell.trim();
    }
    facts.push(fact);
    if (facts.length > MAX_ROWS) throw new BadRequestException('Finance CSV cannot contain more than 500 data rows');
  }
  if (facts.length < 1) throw new BadRequestException('Finance CSV has no financial fact rows');
  return facts;
}

function decodeStrictBase64(value: string): Buffer {
  const encoded = value.trim();
  if (!encoded || encoded.length > 2796204 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new BadRequestException('content_base64 must be canonical base64 containing a file up to 2 MiB');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== encoded) {
    throw new BadRequestException('Finance import file exceeds 2 MiB or has invalid base64 encoding');
  }
  return bytes;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestException('Finance import file must be UTF-8 encoded');
  }
}

export function parseFinanceFileImport(dto: FinanceFileImportDto): ParsedFinanceFileImport {
  const fileName = dto.file_name.trim();
  if (!fileName || fileName.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(fileName) ||
      fileName === '.' || fileName === '..') {
    throw new BadRequestException('file_name must be a simple filename without path separators or control characters');
  }

  const bytes = decodeStrictBase64(dto.content_base64);
  const text = decodeUtf8(bytes);
  let facts: unknown[];
  if (dto.format === 'CSV') {
    facts = parseCsvFacts(text);
  } else if (dto.format === 'JSON') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BadRequestException('Finance JSON import is not valid JSON');
    }
    if (Array.isArray(parsed)) {
      facts = parsed;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).facts)) {
      const payload = parsed as Record<string, unknown>;
      if (Object.keys(payload).some((key) => key !== 'facts')) {
        throw new BadRequestException('Finance JSON file object may contain only the facts array; batch metadata belongs in the request');
      }
      facts = payload.facts as unknown[];
    } else {
      throw new BadRequestException('Finance JSON import must be a facts array or an object containing only facts');
    }
  } else {
    throw new BadRequestException('Unsupported finance file format');
  }

  if (facts.length < 1 || facts.length > MAX_ROWS) {
    throw new BadRequestException('Finance file must contain 1 to 500 facts');
  }
  const batch = plainToInstance(IngestFinanceFactsDto, {
    external_batch_ref: dto.external_batch_ref.trim(),
    ...(dto.source_occurred_at ? { source_occurred_at: dto.source_occurred_at } : {}),
    facts,
  });
  const issues = validateSync(batch, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  if (issues.length) {
    const paths = issues.map((issue) => {
      const childPaths = (issue.children ?? []).map((child) => child.property);
      return [issue.property, ...childPaths].join('.');
    });
    throw new BadRequestException('Finance import contract validation failed: ' + paths.join(', '));
  }

  return {
    batch,
    sourceFileName: fileName,
    sourceFormat: dto.format,
    sourcePayloadSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
