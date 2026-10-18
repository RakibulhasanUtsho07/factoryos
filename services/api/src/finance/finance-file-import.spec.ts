import { describe, expect, it } from '@jest/globals';
import { FinanceFileImportDto } from './dto/finance.dto';
import { deriveFinanceValidationCounts, FinanceFileValidationError, parseFinanceFileImport, serializeFinanceFactsCsv, serializeFinanceValidationErrorCsv } from './finance-file-import';

function fileDto(format: 'CSV' | 'JSON', text: string): FinanceFileImportDto {
  return {
    external_batch_ref: 'batch-001',
    format,
    file_name: format === 'CSV' ? 'finance.csv' : 'finance.json',
    content_base64: Buffer.from(text, 'utf8').toString('base64'),
  };
}

const fact = {
  external_fact_id: 'erp-row-1',
  source_fact_key: 'invoice-line-1',
  fact_type: 'AR_OPEN',
  source_record_type: 'AR_INVOICE',
  source_record_ref: 'INV-100',
  effective_at: '2026-10-01T00:00:00.000Z',
  due_at: '2026-10-31T00:00:00.000Z',
  currency: 'BDT',
  amount: '1234.5000',
  customer_ref: 'Customer, Ltd',
};

describe('finance file import contract', () => {
  it('validates JSON fact arrays using the same DTO contract as API ingestion', () => {
    const parsed = parseFinanceFileImport(fileDto('JSON', JSON.stringify([fact])));
    expect(parsed.batch.external_batch_ref).toBe('batch-001');
    expect(parsed.batch.facts).toHaveLength(1);
    expect(parsed.batch.facts[0].amount).toBe('1234.5000');
    expect(parsed.sourceFileName).toBe('finance.json');
    expect(parsed.sourceFormat).toBe('JSON');
    expect(parsed.sourcePayloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses CSV quoted commas, escaped quotes, CRLF and JSON evidence columns', () => {
    const csv = [
      'external_fact_id,source_fact_key,fact_type,source_record_type,source_record_ref,effective_at,currency,amount,customer_ref,metadata_snapshot',
      'erp-row-1,invoice-line-1,AR_OPEN,AR_INVOICE,INV-100,2026-10-01T00:00:00.000Z,BDT,1234.5000,"Customer, ""Preferred"" Ltd","{""region"":""BD"",""verified"":true}"',
      '',
    ].join('\r\n');
    const parsed = parseFinanceFileImport(fileDto('CSV', csv));
    expect(parsed.batch.facts).toHaveLength(1);
    expect(parsed.batch.facts[0].customer_ref).toBe('Customer, "Preferred" Ltd');
    expect(parsed.batch.facts[0].metadata_snapshot).toEqual({ region: 'BD', verified: true });
  });

  it('accepts a JSON wrapper only when it contains facts and no shadow batch metadata', () => {
    expect(parseFinanceFileImport(fileDto('JSON', JSON.stringify({ facts: [fact] }))).batch.facts).toHaveLength(1);
    expect(() => parseFinanceFileImport(fileDto('JSON', JSON.stringify({
      external_batch_ref: 'shadowed-batch',
      facts: [fact],
    })))).toThrow('Finance JSON file object may contain only the facts array');
  });

  it('returns precise row, field and constraint codes for DTO validation errors', () => {
    let thrown: unknown;
    try {
      parseFinanceFileImport(fileDto('JSON', JSON.stringify([{ ...fact, amount: 42 }])));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      validationIssues: expect.arrayContaining([
        expect.objectContaining({ row: 1, field: 'amount', code: 'ISSTRING' }),
      ]),
    });
  });

  it('rejects incomplete facts, duplicate headers, unknown columns and malformed CSV quoting', () => {
    const missingFact = { ...fact } as Record<string, unknown>;
    delete missingFact.amount;
    expect(() => parseFinanceFileImport(fileDto('JSON', JSON.stringify([missingFact]))))
      .toThrow('Finance import contract validation failed');

    const base = 'external_fact_id,source_fact_key,fact_type,source_record_type,source_record_ref,effective_at,currency,amount';
    expect(() => parseFinanceFileImport(fileDto('CSV', base + ',amount\nx,y,AR_OPEN,AR_INVOICE,INV-1,2026-10-01T00:00:00Z,BDT,1,2\n'))).toThrow('cannot repeat column headers');
    expect(() => parseFinanceFileImport(fileDto('CSV', base + ',inline_secret\nx,y,z,a,b,2026-10-01T00:00:00Z,BDT,1,supersecret')))
      .toThrow('unsupported columns');
    expect(() => parseFinanceFileImport(fileDto('CSV', base + '\n"broken,id,AR_OPEN,AR_INVOICE,INV-1,2026-10-01T00:00:00Z,BDT,1')))
      .toThrow('unterminated quoted field');
  });

  it('rejects path-like names, invalid base64 and unsupported files over the input-size boundary', () => {
    expect(() => parseFinanceFileImport({
      ...fileDto('JSON', JSON.stringify([fact])),
      file_name: '../finance.json',
    })).toThrow('simple filename');
    expect(() => parseFinanceFileImport({
      ...fileDto('JSON', JSON.stringify([fact])),
      content_base64: '!!bad!!',
    })).toThrow('canonical base64');
    expect(() => parseFinanceFileImport({
      ...fileDto('JSON', JSON.stringify([fact])),
      format: 'XML' as 'JSON',
    })).toThrow('Unsupported finance file format');
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
    expect(() => parseFinanceFileImport({
      ...fileDto('JSON', JSON.stringify([fact])),
      content_base64: oversized,
    })).toThrow('exceeds 2 MiB');
  });
});


describe('finance file export serialization', () => {
  it('round-trips CSV export facts including decimals, commas and JSON evidence columns', () => {
    const exportCsv = serializeFinanceFactsCsv([{
      external_fact_id: 'row-1',
      source_fact_key: 'line-1',
      fact_type: 'AR_OPEN',
      source_record_type: 'AR_INVOICE',
      source_record_ref: 'INV-1',
      effective_at: '2026-10-01T00:00:00.000Z',
      due_at: '2026-10-31T00:00:00.000Z',
      currency: 'BDT',
      amount: '1234.5000',
      customer_ref: 'Customer, "Preferred" Ltd',
      metadata_snapshot: { region: 'BD', verified: true },
      reconciliation: null,
    }]);
    const parsed = parseFinanceFileImport(fileDto('CSV', exportCsv));
    expect(parsed.batch.facts).toHaveLength(1);
    expect(parsed.batch.facts[0].amount).toBe('1234.5000');
    expect(parsed.batch.facts[0].customer_ref).toBe('Customer, "Preferred" Ltd');
    expect(parsed.batch.facts[0].metadata_snapshot).toEqual({ region: 'BD', verified: true });
  });
});


describe('finance validation error file', () => {
  it('exports row-level validation errors as an escaped UTF-8 CSV', () => {
    const file = serializeFinanceValidationErrorCsv([{
      row: 2,
      field: 'customer_ref',
      code: 'ISSTRING',
      message: 'Value contains, "quotes"',
    }]).toString('utf8');
    expect(file).toContain('row,field,code,message');
    expect(file).toContain('2,customer_ref,ISSTRING,"Value contains, ""quotes"""');
  });
});


describe('finance validation report counting', () => {
  it('preserves source row counts when DTO validation identifies only some invalid rows', () => {
    const invalidIssues = [
      { row: 2, field: 'amount', code: 'IS_STRING', message: 'must be a string' },
      { row: 4, field: 'amount', code: 'IS_STRING', message: 'must be a string' },
    ];
    expect(deriveFinanceValidationCounts(6, invalidIssues)).toEqual({
      rowCount: 6,
      validRowCount: 4,
      invalidRowCount: 2,
    });
  });

  it('marks file-level errors invalid when no data row can be identified', () => {
    expect(deriveFinanceValidationCounts(0, [
      { row: null, field: 'file', code: 'FILE_CONTRACT_INVALID', message: 'Invalid JSON' },
    ])).toEqual({ rowCount: 0, validRowCount: 0, invalidRowCount: 1 });
  });

  it('retains the fact-array size when DTO validation rejects a row', () => {
    let caught: FinanceFileValidationError | null = null;
    try {
      parseFinanceFileImport(fileDto('JSON', JSON.stringify([
        fact,
        { ...fact, amount: 'not-a-decimal' },
        fact,
      ])));
    } catch (error) {
      if (error instanceof FinanceFileValidationError) caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.rowCount).toBe(3);
    expect(caught?.validationIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 2, field: 'amount' }),
    ]));
  });
});
