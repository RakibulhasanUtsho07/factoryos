import { deflateRawSync, deflateSync } from 'node:zlib';

import { BadRequestException } from '@nestjs/common';

import { ResearchDocumentExtractionService } from './research-document-extraction.service';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; content: string; compress?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = Buffer.from(entry.content, 'utf8');
    const method = entry.compress ? 8 : 0;
    const bytes = entry.compress ? deflateRawSync(source) : source;
    const crc = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + bytes.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createDocx(
  documentXml: string,
  extras: Array<{ name: string; content: string }> = [],
  contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
) {
  return createZip([
    {
      name: '[Content_Types].xml',
      content: '<Types><Override PartName="/word/document.xml" ContentType="' + contentType + '"/></Types>',
      compress: true,
    },
    { name: 'word/document.xml', content: documentXml, compress: true },
    ...extras,
  ]);
}

function createPdf(streamContent: string, compressed = false): Buffer {
  const stream = compressed
    ? deflateSync(Buffer.from(streamContent, 'latin1'))
    : Buffer.from(streamContent, 'latin1');
  const filter = compressed ? ' /Filter /FlateDecode' : '';
  const before = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Length ' + stream.length + filter + ' >>\nstream\n',
    'latin1',
  );
  const after = Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1');
  return Buffer.concat([before, stream, after]);
}

describe('ResearchDocumentExtractionService', () => {
  let service: ResearchDocumentExtractionService;

  beforeEach(() => {
    service = new ResearchDocumentExtractionService();
  });

  it('extracts text from a simple text-based PDF and fingerprints original bytes', () => {
    const file = createPdf('BT /F1 12 Tf (Hello PDF) Tj ET');
    const result = service.extract(file);

    expect(result.format).toBe('PDF');
    expect(result.text).toBe('Hello PDF');
    expect(result.originalFileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.parserVersion).toBe('factoryos-document-extractor-v1');
  });

  it('extracts text from a Flate-compressed PDF content stream', () => {
    const file = createPdf('BT /F1 12 Tf [(Hello) 120 (compressed PDF)] TJ ET', true);
    const result = service.extract(file);

    expect(result.format).toBe('PDF');
    expect(result.text).toBe('Hellocompressed PDF');
  });

  it('extracts DOCX run text, entities, preserved whitespace, tabs, and paragraph breaks', () => {
    const xml =
      '<w:document xmlns:w="urn:word"><w:body>' +
      '<w:p><w:r><w:t xml:space="preserve">Hello &amp; </w:t><w:t>Word</w:t><w:tab/><w:t>again</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second line</w:t></w:r></w:p>' +
      '</w:body></w:document>';

    const result = service.extract(createDocx(xml));

    expect(result.format).toBe('DOCX');
    expect(result.text).toBe('Hello & Word\tagain\nSecond line');
  });

  it('extracts DOCX entries compressed with DEFLATE', () => {
    const result = service.extract(
      createDocx('<w:document><w:body><w:p><w:r><w:t>Compressed Word</w:t></w:r></w:p></w:body></w:document>'),
    );

    expect(result.text).toBe('Compressed Word');
  });

  it('rejects unsupported ZIP files and unsafe archive paths', () => {
    expect(() => service.extract(createZip([{ name: 'readme.txt', content: 'not a document' }]))).toThrow(
      BadRequestException,
    );
    expect(() =>
      service.extract(
        createDocx('<w:document><w:body><w:p><w:r><w:t>Safe</w:t></w:r></w:p></w:body></w:document>', [
          { name: '../unsafe.txt', content: 'unsafe' },
        ]),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects macro-enabled DOCX files', () => {
    const file = createDocx(
      '<w:document><w:body><w:p><w:r><w:t>Macro</w:t></w:r></w:p></w:body></w:document>',
      [{ name: 'word/vbaProject.bin', content: 'macro' }],
      'application/vnd.ms-word.document.macroEnabled.main+xml',
    );

    expect(() => service.extract(file)).toThrow(BadRequestException);
  });

  it('rejects scanned/image-only and encrypted PDFs rather than pretending OCR or decryption succeeded', () => {
    expect(() => service.extract(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF'))).toThrow(
      BadRequestException,
    );
    expect(() => service.extract(Buffer.from('%PDF-1.4\n/Encrypt 4 0 R\n%%EOF'))).toThrow(
      BadRequestException,
    );
  });

  it('rejects unsupported file signatures and uploads larger than 5 MiB', () => {
    expect(() => service.extract(Buffer.from('this is not a PDF or DOCX'))).toThrow(
      BadRequestException,
    );
    expect(() => service.extract(Buffer.alloc(5 * 1024 * 1024 + 1, 0x41))).toThrow(
      BadRequestException,
    );
  });

  it('decodes UTF-16BE PDF text strings and normalizes Unicode', () => {
    const result = service.extract(createPdf('BT <FEFF0043006100660065000301> Tj ET'));

    expect(result.text).toBe('Café');
  });
});
