#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

const inputDirectory = process.env.FACTORYOS_DATASET_INPUT_DIRECTORY || '/input';
const outputDirectory = process.env.FACTORYOS_DATASET_OUTPUT_DIRECTORY || '/data';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeReasonCode(error) {
  const raw = error && typeof error.code === 'string' ? error.code
    : error && typeof error.name === 'string' ? error.name
      : 'MATERIALIZATION_FAILED';
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 70);
  return normalized || 'MATERIALIZATION_FAILED';
}

function requireString(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw Object.assign(new Error('Invalid dataset materializer input'), { code: 'INVALID_' + label });
  }
  return value.trim();
}

function validateCount(value, maxCount) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxCount) {
    throw Object.assign(new Error('Dataset record count is outside the materializer bound'), {
      code: 'RECORD_COUNT_OUT_OF_BOUNDS',
    });
  }
  return value;
}

function validateDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function writeSynthetic(manifest, destination) {
  requireString(manifest.generator, 'GENERATOR', 100);
  requireString(manifest.generator_version, 'GENERATOR_VERSION', 80);
  const schemaVersion = requireString(manifest.schema_version, 'SCHEMA_VERSION', 80);
  const seed = requireString(manifest.seed, 'SEED', 128);
  const recordCount = validateCount(
    manifest.record_count,
    Number(process.env.FACTORYOS_DATASET_MATERIALIZER_MAX_RECORDS || '100000'),
  );
  const hash = createHash('sha256');
  let bytesWritten = 0;
  let created = 0;

  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  try {
    for (let index = 0; index < recordCount; index += 1) {
      const entropy = sha256(seed + ':' + String(index + 1));
      const line = Buffer.from(JSON.stringify({
        record_id: entropy.slice(0, 24),
        schema_version: schemaVersion,
        sequence: index + 1,
        synthetic: true,
        attributes: {
          synthetic_group: 'GROUP_' + String(Number.parseInt(entropy.slice(24, 26), 16) % 8 + 1),
          synthetic_code: entropy.slice(26, 38),
        },
      }) + '\n', 'utf8');
      const maxBytes = Number(process.env.FACTORYOS_DATASET_MATERIALIZER_MAX_BYTES || String(1024 * 1024 * 1024));
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 10 * 1024 * 1024 * 1024 ||
          bytesWritten + line.length > maxBytes) {
        throw Object.assign(new Error('Synthetic dataset exceeds the configured materializer byte limit'), {
          code: 'SYNTHETIC_DATASET_TOO_LARGE',
        });
      }
      hash.update(line);
      bytesWritten += line.length;
      if (!output.write(line)) await once(output, 'drain');
      created += 1;
    }
    output.end();
    await new Promise((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
  return { recordCount: created, bytesWritten, datasetChecksumSha256: hash.digest('hex') };
}

function validateAllowedDownloadUrl(downloadUrl) {
  let url;
  try {
    url = new URL(requireString(downloadUrl, 'DOWNLOAD_URL', 4096));
  } catch {
    throw Object.assign(new Error('Masked-data source URL is invalid'), { code: 'INVALID_DOWNLOAD_URL' });
  }
  const allowedHosts = (process.env.FACTORYOS_MASKED_DATASET_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local') ||
      allowedHosts.length === 0 || !allowedHosts.includes(host)) {
    throw Object.assign(new Error('Masked-data source host is not explicitly allowlisted'), {
      code: 'MASKED_DATASET_HOST_NOT_ALLOWED',
    });
  }
  return url;
}

async function writeMasked(manifest, assessment, destination) {
  const datasetReference = requireString(manifest.dataset_reference, 'DATASET_REFERENCE', 200);
  requireString(manifest.schema_version, 'SCHEMA_VERSION', 80);
  requireString(manifest.masking_policy_version, 'MASKING_POLICY_VERSION', 80);
  if (!validateDigest(manifest.checksum_sha256)) {
    throw Object.assign(new Error('Masked-data source digest is invalid'), { code: 'INVALID_MASKED_SOURCE_DIGEST' });
  }
  if (!assessment || assessment.data_minimization_status !== 'ASSESSED' ||
      !['LOW', 'MEDIUM'].includes(assessment.residual_risk) ||
      !Array.isArray(assessment.reviewed_fields) || assessment.reviewed_fields.length < 1 ||
      !Number.isFinite(Date.parse(assessment.assessed_at)) || Date.parse(assessment.assessed_at) > Date.now()) {
    throw Object.assign(new Error('Masked dataset has no eligible privacy assessment'), {
      code: 'MASKED_PRIVACY_ASSESSMENT_INVALID',
    });
  }

  const sourceDirectory = process.env.FACTORYOS_MASKED_SOURCE_DIRECTORY || '/source';
  const sourceText = await readFile(path.join(sourceDirectory, 'source.json'), 'utf8');
  let source;
  try {
    source = JSON.parse(sourceText);
  } catch {
    throw Object.assign(new Error('Masked dataset source configuration is invalid'), {
      code: 'MASKED_SOURCE_CONFIG_INVALID',
    });
  }
  if (source?.dataset_reference !== datasetReference) {
    throw Object.assign(new Error('Mounted masked-data reference does not match the approved dataset'), {
      code: 'MASKED_SOURCE_REFERENCE_MISMATCH',
    });
  }

  const url = validateAllowedDownloadUrl(source.download_url);
  const headers = { Accept: 'application/octet-stream' };
  if (source.authorization_bearer !== undefined) {
    const token = requireString(source.authorization_bearer, 'SOURCE_AUTHORIZATION', 8192);
    if (/[\r\n]/.test(token)) {
      throw Object.assign(new Error('Masked dataset authorization header is invalid'), {
        code: 'MASKED_SOURCE_AUTHORIZATION_INVALID',
      });
    }
    headers.Authorization = 'Bearer ' + token;
  }
  const timeoutSeconds = Number(process.env.FACTORYOS_MASKED_DATASET_DOWNLOAD_TIMEOUT_SECONDS || '120');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 300) {
    throw Object.assign(new Error('Masked dataset download timeout is invalid'), {
      code: 'MASKED_DOWNLOAD_TIMEOUT_INVALID',
    });
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!response.ok || !response.body) {
    throw Object.assign(new Error('Approved masked-data object could not be downloaded'), {
      code: 'MASKED_SOURCE_DOWNLOAD_FAILED',
    });
  }

  const maxBytes = Number(process.env.FACTORYOS_DATASET_MATERIALIZER_MAX_BYTES || String(1024 * 1024 * 1024));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 10 * 1024 * 1024 * 1024) {
    throw Object.assign(new Error('Materializer maximum byte limit is invalid'), { code: 'MAX_BYTES_INVALID' });
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw Object.assign(new Error('Masked dataset exceeds the configured materializer byte limit'), {
      code: 'MASKED_SOURCE_TOO_LARGE',
    });
  }

  const hash = createHash('sha256');
  let bytesWritten = 0;
  let lineFeeds = 0;
  let currentLineBytes = 0;
  let lastByte = -1;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        callback(Object.assign(new Error('Masked dataset exceeds the configured byte limit'), {
          code: 'MASKED_SOURCE_TOO_LARGE',
        }));
        return;
      }
      hash.update(chunk);
      for (const byte of chunk) {
        if (byte === 10) {
          if (currentLineBytes === 0) {
            callback(Object.assign(new Error('Masked source contains a blank record line'), {
              code: 'MASKED_SOURCE_BLANK_RECORD',
            }));
            return;
          }
          lineFeeds += 1;
          currentLineBytes = 0;
        } else {
          currentLineBytes += 1;
        }
      }
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    throw error;
  }
  const datasetChecksumSha256 = hash.digest('hex');
  if (datasetChecksumSha256 !== manifest.checksum_sha256) {
    throw Object.assign(new Error('Downloaded masked dataset does not match the approved checksum'), {
      code: 'MASKED_SOURCE_CHECKSUM_MISMATCH',
    });
  }
  const recordCount = bytesWritten === 0 ? 0 : lineFeeds + (lastByte === 10 ? 0 : 1);
  const expectedCount = validateCount(
    manifest.record_count,
    Number(process.env.FACTORYOS_DATASET_MATERIALIZER_MAX_RECORDS || '100000'),
  );
  if (recordCount !== expectedCount) {
    throw Object.assign(new Error('Masked dataset record count differs from the approved manifest'), {
      code: 'MASKED_SOURCE_RECORD_COUNT_MISMATCH',
    });
  }
  return { recordCount, bytesWritten, datasetChecksumSha256 };
}

async function main(argv) {
  const args = [...argv];
  if (args.shift() !== 'materialize') {
    throw Object.assign(new Error('Unsupported dataset materializer command'), { code: 'UNSUPPORTED_COMMAND' });
  }
  const options = {};
  while (args.length > 0) {
    const key = args.shift();
    const value = args.shift();
    if (!key?.startsWith('--') || value === undefined || Object.hasOwn(options, key.slice(2))) {
      throw Object.assign(new Error('Invalid dataset materializer arguments'), { code: 'INVALID_ARGUMENTS' });
    }
    options[key.slice(2)] = value;
  }
  const mode = options.mode;
  if (!['SYNTHETIC', 'MASKED'].includes(mode)) {
    throw Object.assign(new Error('Dataset mode must be SYNTHETIC or MASKED'), { code: 'INVALID_DATASET_MODE' });
  }
  const inputFile = (value, fallback) => {
    const candidate = value || fallback;
    let relative = candidate;
    if (candidate.startsWith('/input/')) {
      // Kubernetes job arguments always name the fixed read-only input mount.
      relative = candidate.slice('/input/'.length);
    } else if (candidate.startsWith(inputDirectory + '/')) {
      relative = candidate.slice(inputDirectory.length + 1);
    }
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw Object.assign(new Error('Dataset input path must stay inside the configured input mount'), {
        code: 'INVALID_DATASET_INPUT_PATH',
      });
    }
    return path.join(inputDirectory, relative);
  };
  const manifestPath = inputFile(options.manifest, 'dataset_manifest.json');
  const assessmentPath = inputFile(options['privacy-assessment'], 'privacy_assessment.json');
  const requestedOutput = path.resolve(options.output || outputDirectory);
  if (requestedOutput !== path.resolve(outputDirectory)) {
    throw Object.assign(new Error('Dataset output path must match the configured PVC mount'), {
      code: 'INVALID_DATASET_OUTPUT_PATH',
    });
  }
  const manifestText = await readFile(manifestPath, 'utf8');
  const assessmentText = await readFile(assessmentPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  const assessment = JSON.parse(assessmentText);
  const datasetManifestDigest = sha256(JSON.stringify(canonicalize(manifest)));
  const expectedDigest = process.env.FACTORYOS_EXPECTED_DATASET_MANIFEST_SHA256;
  const sandboxId = process.env.FACTORYOS_SANDBOX_ID;
  const runId = process.env.FACTORYOS_RUN_ID;
  if (!validateDigest(expectedDigest) || datasetManifestDigest !== expectedDigest ||
      typeof sandboxId !== 'string' || !sandboxId || typeof runId !== 'string' || !runId) {
    throw Object.assign(new Error('Manifest, sandbox or run identity did not match the provision request'), {
      code: 'DATASET_PROVENANCE_MISMATCH',
    });
  }

  await mkdir(outputDirectory, { recursive: true });
  // Synthetic records have a defined JSONL encoding. Masked source bytes
  // retain their approved encoding, so use a format-neutral filename.
  const datasetFile = mode === 'SYNTHETIC' ? 'dataset.jsonl' : 'dataset.masked';
  const destination = path.join(outputDirectory, datasetFile);
  const temporaryPath = path.join(outputDirectory, '.dataset.jsonl.' + randomBytes(8).toString('hex') + '.partial');
  try {
    const materialized = mode === 'SYNTHETIC'
      ? await writeSynthetic(manifest, temporaryPath)
      : await writeMasked(manifest, assessment, temporaryPath);
    const prior = await lstat(destination).catch((error) => error && error.code === 'ENOENT' ? null : Promise.reject(error));
    if (prior?.isSymbolicLink() || (prior && !prior.isFile())) {
      throw Object.assign(new Error('Dataset output path is not a regular file'), { code: 'UNSAFE_DATASET_OUTPUT_PATH' });
    }
    await rename(temporaryPath, destination);
    const receipt = {
      status: 'SUCCEEDED',
      sandboxId,
      runId,
      mode,
      datasetFile,
      schemaVersion: manifest.schema_version,
      datasetManifestDigest,
      datasetChecksumSha256: materialized.datasetChecksumSha256,
      recordCount: materialized.recordCount,
      bytesWritten: materialized.bytesWritten,
      completedAt: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'FAILED', reasonCode: safeReasonCode(error) }) + '\n');
  process.exitCode = 1;
});
