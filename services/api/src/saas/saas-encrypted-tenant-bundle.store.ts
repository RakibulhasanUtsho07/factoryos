import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, resolve } from 'node:path';

const MAGIC = Buffer.from('FOSXFER1', 'ascii');
const HEADER_LENGTH = 8 + 12;
const TAG_LENGTH = 16;
const REFERENCE_PATTERN = /^bundle-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.fosx$/i;

export interface StoredEncryptedBundle {
  reference: string;
  digest: string;
  bytes: number;
}

@Injectable()
export class SaasEncryptedTenantBundleStore {
  constructor(private readonly configService: ConfigService) {}

  async put(chunks: AsyncIterable<Buffer | string>): Promise<StoredEncryptedBundle> {
    const settings = this.settings();
    await this.ensureDirectory(settings.directory);
    const id = randomBytes(16).toString('hex');
    // References are random opaque identifiers. Tenant IDs and schema names are not embedded in paths.
    const reference = 'bundle-' + this.randomUuid() + '.fosx';
    const finalPath = resolve(settings.directory, reference);
    const temporaryPath = resolve(settings.directory, '.' + id + '.partial');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', settings.key, iv);
    const fileDigest = createHash('sha256');
    let framed = false;

    const framing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          const output = framed
            ? chunk
            : Buffer.concat([MAGIC, iv, chunk]);
          framed = true;
          fileDigest.update(output);
          callback(null, output);
        } catch (error) {
          callback(error as Error);
        }
      },
      flush(callback) {
        try {
          const tag = cipher.getAuthTag();
          fileDigest.update(tag);
          this.push(tag);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });

    try {
      await pipeline(
        Readable.from(chunks),
        createGzip({ level: 9 }),
        cipher,
        framing,
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
      );
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
      const fileInfo = await stat(finalPath);
      return {
        reference,
        digest: fileDigest.digest('hex'),
        bytes: fileInfo.size,
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      await unlink(finalPath).catch(() => undefined);
      throw error;
    }
  }

  async *read(reference: string, expectedDigest: string): AsyncIterable<Buffer> {
    const settings = this.settings();
    await this.ensureDirectory(settings.directory);
    const filePath = this.resolveReference(settings.directory, reference);
    if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedDigest)) {
      throw new ConflictException('Encrypted bundle digest is invalid');
    }

    const actualHash = createHash('sha256');
    try {
      for await (const chunk of createReadStream(filePath)) {
        actualHash.update(chunk as Buffer);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw new NotFoundException('Encrypted tenant bundle was not found');
      throw error;
    }
    if (actualHash.digest('hex') !== expectedDigest.toLowerCase()) {
      throw new ConflictException('Encrypted tenant bundle digest does not match its attested digest');
    }

    const handle = await open(filePath, 'r');
    const header = Buffer.alloc(HEADER_LENGTH);
    try {
      const result = await handle.read(header, 0, HEADER_LENGTH, 0);
      if (result.bytesRead !== HEADER_LENGTH || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new ConflictException('Encrypted tenant bundle header is invalid');
      }
    } finally {
      await handle.close();
    }

    const iv = header.subarray(MAGIC.length, HEADER_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', settings.key, iv);
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const tagSplitter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        if (combined.length <= TAG_LENGTH) {
          pending = combined;
          callback();
          return;
        }
        const contentLength = combined.length - TAG_LENGTH;
        this.push(combined.subarray(0, contentLength));
        pending = combined.subarray(contentLength);
        callback();
      },
      flush(callback) {
        try {
          if (pending.length !== TAG_LENGTH) {
            callback(new ConflictException('Encrypted tenant bundle authentication tag is missing'));
            return;
          }
          // The splitter's flush occurs before the decipher receives end-of-stream.
          decipher.setAuthTag(pending);
          callback();
        } catch {
          callback(new ConflictException('Encrypted tenant bundle authentication tag is invalid'));
        }
      },
    });

    const output = new PassThrough();
    const run = pipeline(
      createReadStream(filePath, { start: HEADER_LENGTH }),
      tagSplitter,
      decipher,
      createGunzip(),
      output,
    );
    try {
      for await (const chunk of output) yield Buffer.from(chunk as Buffer);
      await run;
    } catch {
      await run.catch(() => undefined);
      throw new ConflictException('Encrypted tenant bundle failed authenticated decryption or gzip validation');
    }
  }

  async remove(reference: string): Promise<void> {
    const settings = this.settings();
    const filePath = this.resolveReference(settings.directory, reference);
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private settings(): { directory: string; key: Buffer } {
    const configuredDirectory = this.configService.get<string>('SAAS_TRANSFER_BUNDLE_DIR');
    const keyBase64 = this.configService.get<string>('SAAS_TRANSFER_ENCRYPTION_KEY_BASE64');
    if (!configuredDirectory || !keyBase64) {
      throw new ServiceUnavailableException(
        'Tenant transfer worker is not configured: encrypted bundle directory and 32-byte base64 encryption key are required',
      );
    }
    const key = Buffer.from(keyBase64, 'base64');
    if (
      key.length !== 32 ||
      !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64) ||
      key.toString('base64') !== keyBase64
    ) {
      throw new ServiceUnavailableException('SAAS_TRANSFER_ENCRYPTION_KEY_BASE64 must encode exactly 32 bytes');
    }
    return { directory: resolve(configuredDirectory), key };
  }

  private async ensureDirectory(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ServiceUnavailableException('Encrypted tenant bundle directory must be a real directory, not a symlink');
    }
    await chmod(directory, 0o700);
  }

  private resolveReference(directory: string, reference: string) {
    if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference) || basename(reference) !== reference) {
      throw new ConflictException('Encrypted bundle reference is invalid');
    }
    return resolve(directory, reference);
  }

  private randomUuid() {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
      '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
}
