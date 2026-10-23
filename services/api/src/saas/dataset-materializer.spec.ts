import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function digest(value: unknown) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : JSON.stringify(canonicalize(value)),
    'utf8',
  ).digest('hex');
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'factoryos-dataset-materializer-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const source = path.join(root, 'source');
  mkdirSync(input, { recursive: true });
  mkdirSync(output, { recursive: true });
  mkdirSync(source, { recursive: true });
  const manifest = {
    generator: 'factoryos-fixture-generator',
    generator_version: '1.0.0',
    schema_version: 'factory.v1',
    seed: 'repeatable-fixture-seed',
    record_count: 5,
  };
  const assessment = {};
  writeFileSync(path.join(input, 'dataset_manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(input, 'privacy_assessment.json'), JSON.stringify(assessment));
  const scriptPath = path.resolve(process.cwd(), 'physical-provisioning/dataset-materializer.mjs');
  const env = {
    ...process.env,
    FACTORYOS_DATASET_INPUT_DIRECTORY: input,
    FACTORYOS_DATASET_OUTPUT_DIRECTORY: output,
    FACTORYOS_EXPECTED_DATASET_MANIFEST_SHA256: digest(manifest),
    FACTORYOS_SANDBOX_ID: '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7',
    FACTORYOS_RUN_ID: '456f2b7f-8c46-4d9a-8b44-18eae66a4450',
    FACTORYOS_DATASET_MATERIALIZER_MAX_RECORDS: '100',
    FACTORYOS_DATASET_MATERIALIZER_MAX_BYTES: '1048576',
    FACTORYOS_MASKED_SOURCE_DIRECTORY: source,
  };
  return { root, input, output, source, manifest, assessment, scriptPath, env };
}

function execute(f: ReturnType<typeof fixture>, mode = 'SYNTHETIC') {
  return spawnSync(process.execPath, [
    f.scriptPath,
    'materialize',
    '--mode', mode,
    '--manifest', '/input/dataset_manifest.json',
    '--privacy-assessment', '/input/privacy_assessment.json',
    '--output', f.output,
  ], { env: f.env, encoding: 'utf8', timeout: 15000 });
}

describe('SaaS dataset materializer executable', () => {
  it('creates deterministic synthetic JSONL and emits a run-bound receipt without personal data', () => {
    const first = fixture();
    const second = fixture();
    try {
      const a = execute(first);
      const b = execute(second);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      const receiptA = JSON.parse(a.stdout.trim());
      const receiptB = JSON.parse(b.stdout.trim());
      expect(receiptA).toEqual(expect.objectContaining({
        status: 'SUCCEEDED',
        sandboxId: first.env.FACTORYOS_SANDBOX_ID,
        runId: first.env.FACTORYOS_RUN_ID,
        mode: 'SYNTHETIC',
        datasetManifestDigest: digest(first.manifest),
        recordCount: 5,
      }));
      expect(receiptA.datasetChecksumSha256).toBe(receiptB.datasetChecksumSha256);
      const lines = readFileSync(path.join(first.output, 'dataset.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(5);
      const records = lines.map((line) => JSON.parse(line));
      expect(records.every((record) => record.synthetic === true)).toBe(true);
      expect(records.map((record) => record.record_id).every((id) => typeof id === 'string')).toBe(true);
      expect(a.stderr).toBe('');
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  it('fails closed when manifest bytes do not match the pinned provenance digest', () => {
    const f = fixture();
    try {
      f.env.FACTORYOS_EXPECTED_DATASET_MANIFEST_SHA256 = 'f'.repeat(64);
      const result = execute(f);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr.trim())).toEqual({
        status: 'FAILED',
        reasonCode: 'DATASET_PROVENANCE_MISMATCH',
      });
      expect(() => readFileSync(path.join(f.output, 'dataset.jsonl'))).toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails closed for masked sources whose object host is not allowlisted', () => {
    const f = fixture();
    try {
      const maskedManifest = {
        dataset_reference: 'warehouse-snapshot:batch-42',
        schema_version: 'factory.v1',
        record_count: 5,
        masking_policy_version: 'mask-v2',
        masked_at: '2026-10-20T00:00:00.000Z',
        checksum_sha256: 'a'.repeat(64),
      };
      const assessment = {
        data_minimization_status: 'ASSESSED',
        residual_risk: 'LOW',
        reviewed_fields: ['worker_id'],
        assessed_at: '2026-10-20T00:00:00.000Z',
      };
      writeFileSync(path.join(f.input, 'dataset_manifest.json'), JSON.stringify(maskedManifest));
      writeFileSync(path.join(f.input, 'privacy_assessment.json'), JSON.stringify(assessment));
      writeFileSync(path.join(f.source, 'source.json'), JSON.stringify({
        dataset_reference: maskedManifest.dataset_reference,
        download_url: 'https://unapproved-data.example.test/object',
      }));
      f.env.FACTORYOS_EXPECTED_DATASET_MANIFEST_SHA256 = digest(maskedManifest);
      delete f.env.FACTORYOS_MASKED_DATASET_ALLOWED_HOSTS;
      const result = execute(f, 'MASKED');
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr.trim())).toEqual({
        status: 'FAILED',
        reasonCode: 'MASKED_DATASET_HOST_NOT_ALLOWED',
      });
      expect(() => readFileSync(path.join(f.output, 'dataset.jsonl'))).toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the input and output mounts', () => {
    const f = fixture();
    try {
      const result = spawnSync(process.execPath, [
        f.scriptPath, 'materialize', '--mode', 'SYNTHETIC',
        '--manifest', '../dataset_manifest.json',
        '--privacy-assessment', '/input/privacy_assessment.json',
        '--output', f.output,
      ], { env: f.env, encoding: 'utf8', timeout: 15000 });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr.trim()).reasonCode).toBe('INVALID_DATASET_INPUT_PATH');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
