import { BadRequestException, Injectable } from '@nestjs/common';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export type ExtractedDocumentFormat = 'PDF' | 'DOCX';

export interface ExtractedResearchDocument {
  format: ExtractedDocumentFormat;
  text: string;
  originalFileSha256: string;
  parserVersion: 'factoryos-document-extractor-v1';
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 512;
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;
const MAX_PDF_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_PDF_TOTAL_EXPANDED_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 32768;
const MAX_TEXT_BYTES = 49152;

type PdfTextToken =
  | { type: 'string'; value: string }
  | { type: 'array'; value: string[] }
  | { type: 'word'; value: string };

@Injectable()
export class ResearchDocumentExtractionService {
  extract(input: Buffer): ExtractedResearchDocument {
    if (!Buffer.isBuffer(input) || input.length === 0) {
      throw new BadRequestException('A non-empty PDF or DOCX file is required');
    }
    if (input.length > MAX_FILE_BYTES) {
      throw new BadRequestException('Document upload exceeds the 5 MiB limit');
    }

    const originalFileSha256 = createHash('sha256').update(input).digest('hex');
    let format: ExtractedDocumentFormat;
    let text: string;

    if (input.subarray(0, 5).toString('ascii') === '%PDF-') {
      format = 'PDF';
      text = this.extractPdf(input);
    } else if (
      input.length >= 4 &&
      input[0] === 0x50 &&
      input[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(input[2]) &&
      [0x04, 0x06, 0x08].includes(input[3])
    ) {
      format = 'DOCX';
      text = this.extractDocx(input);
    } else {
      throw new BadRequestException('Unsupported document format; upload a valid PDF or DOCX file');
    }

    const normalized = text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .normalize('NFC')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    const characterCount = Array.from(normalized).length;
    const byteCount = Buffer.byteLength(normalized, 'utf8');
    if (!normalized || characterCount > MAX_TEXT_CHARACTERS || byteCount > MAX_TEXT_BYTES) {
      throw new BadRequestException(
        'Extracted text must contain 1-32,768 characters and at most 49,152 UTF-8 bytes',
      );
    }

    if (this.containsUnsupportedControlCharacters(normalized)) {
      throw new BadRequestException('Extracted text contains unsupported control characters');
    }

    return {
      format,
      text: normalized,
      originalFileSha256,
      parserVersion: 'factoryos-document-extractor-v1',
    };
  }

  private containsUnsupportedControlCharacters(value: string): boolean {
    return Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      );
    });
  }

  private extractDocx(input: Buffer): string {
    const entries = this.readZipDirectory(input);
    const documentEntry = entries.filter((entry) => entry.name === 'word/document.xml');
    const contentTypesEntry = entries.find((entry) => entry.name === '[Content_Types].xml');

    if (documentEntry.length !== 1 || !contentTypesEntry) {
      throw new BadRequestException('The uploaded ZIP is not a supported Word DOCX document');
    }
    if (entries.some((entry) => entry.name === 'word/vbaProject.bin')) {
      throw new BadRequestException('Macro-enabled Word documents are not supported');
    }

    const documentXml = this.readZipEntry(input, documentEntry[0]!);
    let documentXmlText: string;
    let contentTypesXml: string;
    try {
      documentXmlText = new TextDecoder('utf-8', { fatal: true }).decode(documentXml);
      contentTypesXml = new TextDecoder('utf-8', { fatal: true }).decode(
        this.readZipEntry(input, contentTypesEntry),
      );
    } catch {
      throw new BadRequestException('DOCX XML must use valid UTF-8 encoding');
    }
    if (
      /wordprocessingml\.document\.macroEnabled/i.test(contentTypesXml) ||
      !/wordprocessingml\.document\.main\+xml/i.test(contentTypesXml)
    ) {
      throw new BadRequestException('Only non-macro DOCX documents are supported');
    }

    const xml = documentXmlText;
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new BadRequestException('DOCX XML declarations with DTD/entities are not supported');
    }

    const paragraphs: string[] = [];
    const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    for (const paragraph of xml.matchAll(paragraphPattern)) {
      const paragraphXml = paragraph[1] ?? '';
      const pieces: string[] = [];
      const runPartPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\s*\/>|<w:br(?:\s[^>]*)?\s*\/>/g;
      for (const part of paragraphXml.matchAll(runPartPattern)) {
        const token = part[0] ?? '';
        if (part[1] !== undefined) {
          pieces.push(this.decodeXmlEntities(part[1]));
        } else if (token.startsWith('<w:tab')) {
          pieces.push('\t');
        } else {
          pieces.push('\n');
        }
      }
      const text = pieces.join('');
      if (text.trim()) paragraphs.push(text);
      if (paragraphs.join('\n').length > MAX_TEXT_CHARACTERS) {
        throw new BadRequestException('Extracted DOCX text exceeds the character limit');
      }
    }

    return paragraphs.join('\n');
  }

  private readZipDirectory(input: Buffer): Array<{
    name: string;
    method: number;
    flags: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  }> {
    const minimum = Math.max(0, input.length - 65557);
    let eocd = -1;
    for (let cursor = input.length - 22; cursor >= minimum; cursor -= 1) {
      if (input.readUInt32LE(cursor) === 0x06054b50) {
        eocd = cursor;
        break;
      }
    }
    if (eocd < 0) throw new BadRequestException('DOCX ZIP directory is missing or invalid');

    const diskNumber = input.readUInt16LE(eocd + 4);
    const directoryDisk = input.readUInt16LE(eocd + 6);
    const entriesOnDisk = input.readUInt16LE(eocd + 8);
    const entryCount = input.readUInt16LE(eocd + 10);
    const directorySize = input.readUInt32LE(eocd + 12);
    const directoryOffset = input.readUInt32LE(eocd + 16);
    if (
      diskNumber !== 0 ||
      directoryDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount < 1 ||
      entryCount > MAX_DOCX_ENTRIES ||
      directoryOffset + directorySize > eocd ||
      directoryOffset + directorySize > input.length
    ) {
      throw new BadRequestException('DOCX ZIP layout exceeds supported safety limits');
    }

    const entries: Array<{
      name: string;
      method: number;
      flags: number;
      compressedSize: number;
      uncompressedSize: number;
      localHeaderOffset: number;
    }> = [];
    let cursor = directoryOffset;

    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > input.length || input.readUInt32LE(cursor) !== 0x02014b50) {
        throw new BadRequestException('DOCX ZIP central directory is malformed');
      }
      const flags = input.readUInt16LE(cursor + 8);
      const method = input.readUInt16LE(cursor + 10);
      const compressedSize = input.readUInt32LE(cursor + 20);
      const uncompressedSize = input.readUInt32LE(cursor + 24);
      const nameLength = input.readUInt16LE(cursor + 28);
      const extraLength = input.readUInt16LE(cursor + 30);
      const commentLength = input.readUInt16LE(cursor + 32);
      const startDisk = input.readUInt16LE(cursor + 34);
      const localHeaderOffset = input.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > input.length || startDisk !== 0 || (flags & 0x0001) !== 0) {
        throw new BadRequestException('Encrypted or malformed DOCX archive entries are not supported');
      }
      if (method !== 0 && method !== 8) {
        throw new BadRequestException('DOCX ZIP compression method is not supported');
      }

      const name = input.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').some((segment) => segment === '..')
      ) {
        throw new BadRequestException('DOCX archive contains an unsafe entry path');
      }
      if (uncompressedSize > MAX_DOCX_XML_BYTES * 2) {
        throw new BadRequestException('DOCX archive entry exceeds the decompression limit');
      }

      entries.push({
        name,
        method,
        flags,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor = end;
    }

    if (cursor > directoryOffset + directorySize) {
      throw new BadRequestException('DOCX ZIP central directory length is inconsistent');
    }
    return entries;
  }

  private readZipEntry(
    input: Buffer,
    entry: {
      name: string;
      method: number;
      flags: number;
      compressedSize: number;
      uncompressedSize: number;
      localHeaderOffset: number;
    },
  ): Buffer {
    const offset = entry.localHeaderOffset;
    if (offset + 30 > input.length || input.readUInt32LE(offset) !== 0x04034b50) {
      throw new BadRequestException('DOCX local ZIP entry header is malformed');
    }
    const localNameLength = input.readUInt16LE(offset + 26);
    const localExtraLength = input.readUInt16LE(offset + 28);
    const localName = input.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8');
    const localFlags = input.readUInt16LE(offset + 6);
    const localMethod = input.readUInt16LE(offset + 8);
    if (
      localName !== entry.name ||
      localMethod !== entry.method ||
      (localFlags & 0x0001) !== 0
    ) {
      throw new BadRequestException('DOCX ZIP directory does not match its local entry');
    }

    const start = offset + 30 + localNameLength + localExtraLength;
    const end = start + entry.compressedSize;
    if (start > input.length || end > input.length) {
      throw new BadRequestException('DOCX compressed entry is truncated');
    }
    if (
      entry.uncompressedSize > MAX_DOCX_XML_BYTES ||
      (entry.compressedSize === 0 && entry.uncompressedSize > 0) ||
      (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)
    ) {
      throw new BadRequestException('DOCX entry has an unsafe expansion ratio');
    }

    try {
      const compressed = input.subarray(start, end);
      const output =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: MAX_DOCX_XML_BYTES });
      if (output.length !== entry.uncompressedSize || output.length > MAX_DOCX_XML_BYTES) {
        throw new BadRequestException('DOCX entry decompressed length is inconsistent');
      }
      return output;
    } catch {
      throw new BadRequestException('DOCX entry could not be safely decompressed');
    }
  }

  private decodeXmlEntities(value: string): string {
    return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      const codePoint = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 1 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return '';
      }
      return String.fromCodePoint(codePoint);
    });
  }

  private extractPdf(input: Buffer): string {
    const raw = input.toString('latin1');
    if (/\/Encrypt\b/.test(raw)) {
      throw new BadRequestException('Encrypted PDFs are not supported');
    }

    const streams: string[] = [];
    const marker = /stream\r?\n/g;
    let match: RegExpExecArray | null;
    let expandedTotal = 0;
    let streamCount = 0;

    while ((match = marker.exec(raw)) !== null) {
      streamCount += 1;
      if (streamCount > 1024) {
        throw new BadRequestException('PDF has too many streams to process safely');
      }
      const dictionaryEnd = raw.lastIndexOf('>>', match.index);
      const dictionaryStart = raw.lastIndexOf('<<', dictionaryEnd);
      if (
        dictionaryStart < 0 ||
        dictionaryEnd < dictionaryStart ||
        match.index - dictionaryStart > 8192
      ) {
        continue;
      }
      const dictionary = raw.slice(dictionaryStart, dictionaryEnd + 2);
      const streamStart = marker.lastIndex;
      if (/\/Subtype\s*\/Image\b/.test(dictionary)) {
        const imageEnd = raw.indexOf('endstream', streamStart);
        if (imageEnd < 0) break;
        marker.lastIndex = imageEnd + 9;
        continue;
      }

      const declaredLength = dictionary.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/);
      let streamEnd: number;
      if (declaredLength) {
        streamEnd = streamStart + Number(declaredLength[1]);
      } else {
        streamEnd = raw.indexOf('endstream', streamStart);
      }
      if (streamEnd < streamStart || streamEnd > raw.length) {
        throw new BadRequestException('PDF stream bounds are invalid');
      }

      let bytes = input.subarray(streamStart, streamEnd);
      const filterArray = dictionary.match(/\/Filter\s*\[([^\]]+)\]/);
      const filters = filterArray?.[1]?.match(/\/[A-Za-z0-9]+/g) ?? [];
      const hasDirectFlate =
        /\/Filter\s*\/(?:FlateDecode|Fl)\b/.test(dictionary) && !filterArray;
      const hasSingleFlateArray =
        Boolean(filterArray) && filters.length === 1 && /\/(?:FlateDecode|Fl)\b/.test(filters[0]!);
      const isFlate = hasDirectFlate || hasSingleFlateArray;
      if (filterArray && !hasSingleFlateArray) {
        const end = raw.indexOf('endstream', streamStart);
        if (end < 0) break;
        marker.lastIndex = end + 9;
        continue;
      }
      if (dictionary.includes('/Filter') && !isFlate) {
        // Skip streams using unsupported filters; no external filters are loaded.
        const end = raw.indexOf('endstream', streamStart);
        if (end < 0) break;
        marker.lastIndex = end + 9;
        continue;
      }
      if (isFlate) {
        try {
          bytes = inflateSync(bytes, { maxOutputLength: MAX_PDF_STREAM_BYTES });
        } catch {
          throw new BadRequestException('PDF compressed stream is invalid or exceeds the safety limit');
        }
      }

      expandedTotal += bytes.length;
      if (expandedTotal > MAX_PDF_TOTAL_EXPANDED_BYTES) {
        throw new BadRequestException('PDF expanded streams exceed the safety limit');
      }
      streams.push(bytes.toString('latin1'));
      const endMarker = raw.indexOf('endstream', streamEnd);
      marker.lastIndex = endMarker >= 0 ? endMarker + 9 : streamEnd;
    }

    const candidates = streams.length > 0 ? streams : [raw];
    const blocks: string[] = [];
    for (const candidate of candidates) {
      for (const text of this.extractPdfTextOperators(candidate)) {
        if (text.trim()) blocks.push(text.trim());
        if (blocks.join('\n').length > MAX_TEXT_CHARACTERS) {
          throw new BadRequestException('Extracted PDF text exceeds the character limit');
        }
      }
    }
    if (blocks.length === 0) {
      throw new BadRequestException(
        'No extractable text was found in the PDF; scanned/image-only PDFs require OCR and are not supported',
      );
    }
    return blocks.join('\n');
  }

  private extractPdfTextOperators(content: string): string[] {
    const blocks: string[] = [];
    for (const textObject of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      const tokens = this.tokenizePdfTextObject(textObject[1] ?? '');
      const output: string[] = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        const next = tokens[index + 1];
        if (token.type === 'word' && ['T*', 'Td', 'TD'].includes(token.value)) {
          output.push('\n');
          continue;
        }
        if (
          token.type === 'string' &&
          next?.type === 'word' &&
          ['Tj', "'", '"'].includes(next.value)
        ) {
          if (next.value !== 'Tj') output.push('\n');
          output.push(token.value);
          index += 1;
          continue;
        }
        if (token.type === 'array' && next?.type === 'word' && next.value === 'TJ') {
          output.push(token.value.join(''));
          index += 1;
        }
      }
      const block = output.join('').replace(/[ \t]+/g, ' ').trim();
      if (block) blocks.push(block);
    }
    return blocks;
  }

  private tokenizePdfTextObject(source: string): PdfTextToken[] {
    const tokens: PdfTextToken[] = [];
    let cursor = 0;

    const skipSpaceAndComments = () => {
      while (cursor < source.length) {
        if (/\s/.test(source[cursor]!)) {
          cursor += 1;
        } else if (source[cursor] === '%') {
          while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') {
            cursor += 1;
          }
        } else {
          break;
        }
      }
    };

    const readLiteral = (): string => {
      cursor += 1;
      let depth = 1;
      const bytes: number[] = [];
      while (cursor < source.length && depth > 0) {
        const char = source[cursor++]!;
        if (char === '\\') {
          if (cursor >= source.length) break;
          const escaped = source[cursor++]!;
          const simple: Record<string, number> = {
            n: 10, r: 13, t: 9, b: 8, f: 12,
            '(': 40, ')': 41, '\\': 92,
          };
          if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
            bytes.push(simple[escaped]!);
          } else if (/[0-7]/.test(escaped)) {
            let octal = escaped;
            for (let count = 0; count < 2 && cursor < source.length && /[0-7]/.test(source[cursor]!); count += 1) {
              octal += source[cursor++]!;
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff);
          } else if (escaped === '\n') {
            // PDF line continuation: emit no byte.
          } else if (escaped === '\r') {
            if (source[cursor] === '\n') cursor += 1;
          } else {
            bytes.push(escaped.charCodeAt(0) & 0xff);
          }
          continue;
        }
        if (char === '(') {
          depth += 1;
          if (depth > 1) bytes.push(40);
          continue;
        }
        if (char === ')') {
          depth -= 1;
          if (depth > 0) bytes.push(41);
          continue;
        }
        bytes.push(char.charCodeAt(0) & 0xff);
      }
      return this.decodePdfBytes(Buffer.from(bytes));
    };

    const readHexString = (): string => {
      cursor += 1;
      let hex = '';
      while (cursor < source.length && source[cursor] !== '>') {
        if (!/\s/.test(source[cursor]!)) hex += source[cursor];
        cursor += 1;
      }
      if (source[cursor] === '>') cursor += 1;
      if (!/^[a-fA-F0-9]*$/.test(hex)) return '';
      if (hex.length % 2 === 1) hex += '0';
      return this.decodePdfBytes(Buffer.from(hex, 'hex'));
    };

    while (cursor < source.length) {
      skipSpaceAndComments();
      if (cursor >= source.length) break;
      const char = source[cursor]!;
      if (char === '(') {
        tokens.push({ type: 'string', value: readLiteral() });
        continue;
      }
      if (char === '[') {
        cursor += 1;
        let depth = 1;
        const parts: string[] = [];
        while (cursor < source.length && depth > 0) {
          skipSpaceAndComments();
          const current = source[cursor]!;
          if (current === '[') {
            depth += 1;
            cursor += 1;
          } else if (current === ']') {
            depth -= 1;
            cursor += 1;
          } else if (current === '(') {
            parts.push(readLiteral());
          } else if (current === '<' && source[cursor + 1] !== '<') {
            parts.push(readHexString());
          } else {
            cursor += 1;
          }
          if (parts.join('').length > MAX_TEXT_CHARACTERS) {
            throw new BadRequestException('PDF text array exceeds the extraction limit');
          }
        }
        tokens.push({ type: 'array', value: parts });
        continue;
      }
      if (char === '<' && source[cursor + 1] !== '<') {
        tokens.push({ type: 'string', value: readHexString() });
        continue;
      }

      const start = cursor;
      while (
        cursor < source.length &&
        !/\s/.test(source[cursor]!) &&
        !'()<>[]{}/%'.includes(source[cursor]!)
      ) cursor += 1;
      if (cursor === start) {
        cursor += 1;
      } else {
        tokens.push({ type: 'word', value: source.slice(start, cursor) });
      }
      if (tokens.length > 100000) {
        throw new BadRequestException('PDF text operator count exceeds the safety limit');
      }
    }
    return tokens;
  }

  private decodePdfBytes(bytes: Buffer): string {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const payload = bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2));
      return payload.swap16().toString('utf16le');
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      const payload = bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2));
      return payload.toString('utf16le');
    }
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
