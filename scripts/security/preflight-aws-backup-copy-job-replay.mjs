#!/usr/bin/env node
import { lstat, open, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  assertReplayCaptureRule,
  assertReplayQueueAttributes,
  assertReplayDlqAttributes,
  sha256,
} from '../audit/aws-backup-copy-job-audit-evidence.mjs';
const MAX_OUTPUT = 8 * 1024 * 1024;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
function fail(message) { throw new Error(message); }

async function runAws(args, timeoutMs = 60000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.AWS_CLI_PATH || 'aws', [...args, '--no-cli-pager'], {
      shell: false, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let total = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('AWS CLI command timed out')); }, timeoutMs);
    const consume = (chunk, isError) => {
      total += chunk.length;
      if (total > MAX_OUTPUT) { child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('AWS CLI output exceeded 8 MiB')); return; }
      if (isError) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => consume(chunk, false));
    child.stderr.on('data', (chunk) => consume(chunk, true));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('AWS CLI command failed (' + code + '): ' + stderr.slice(0, 2000)));
      else resolvePromise(stdout);
    });
  });
}
async function runJson(args) {
  const raw = await runAws([...args, '--output', 'json']);
  try { return JSON.parse(raw); } catch { fail('AWS CLI returned invalid JSON for ' + args.slice(0, 2).join(' ')); }
}
async function readManifest(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024) {
    fail('Manifest must be a regular file no larger than 1 MiB');
  }
  return readFile(path);
}
function validate(manifest) {
  if (!manifest || manifest.schema !== 'factoryos.aws-backup-copy-job-replay-capture/v1') fail('Unsupported replay manifest schema');
  if (!/^\d{12}$/.test(manifest.accountId || '') || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(manifest.region || '')) {
    fail('AWS account or Region is invalid');
  }
  if (!SAFE.test(manifest.archiveName || '') || !SAFE.test(manifest.captureRuleName || '')
    || typeof manifest.replayName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.replayName)) {
    fail('Archive/rule/replay name is invalid');
  }
  const checkArn = (value, service) => {
    if (typeof value !== 'string') fail(service + ' ARN is missing');
    const parts = value.split(':');
    if (parts.length < 6 || parts[0] !== 'arn' || parts[2] !== service
      || parts[3] !== manifest.region || parts[4] !== manifest.accountId) fail(service + ' ARN is outside declared scope');
    return parts;
  };
  checkArn(manifest.archiveArn, 'events');
  checkArn(manifest.captureQueueArn, 'sqs');
  checkArn(manifest.captureDeadLetterQueueArn, 'sqs');
  if (!manifest.archiveArn.includes(':archive/')) fail('archiveArn resource type is invalid');
  for (const field of ['captureQueueUrl', 'captureDeadLetterQueueUrl']) {
    if (typeof manifest[field] !== 'string'
      || !manifest[field].startsWith('https://sqs.' + manifest.region + '.amazonaws.com/' + manifest.accountId + '/')) {
      fail(field + ' does not match the declared account and Region');
    }
  }
  for (const field of ['eventStartTime', 'eventEndTime']) {
    if (typeof manifest[field] !== 'string' || !/Z$/.test(manifest[field]) || !Number.isFinite(Date.parse(manifest[field]))) {
      fail(field + ' must be a UTC ISO timestamp');
    }
  }
  if (Date.parse(manifest.eventEndTime) <= Date.parse(manifest.eventStartTime)
    || Date.parse(manifest.eventEndTime) > Date.now() - 10 * 60 * 1000) {
    fail('Replay window must be valid and end at least ten minutes before preflight');
  }
}
async function queueAttributes(queueUrl, region) {
  const response = await runJson([
    'sqs', 'get-queue-attributes', '--queue-url', queueUrl,
    '--attribute-names', 'All', '--region', region,
  ]);
  return response.Attributes || {};
}
async function main() {
  const argv = process.argv.slice(2);
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || args.has(key)) fail('Invalid or duplicate argument');
    args.set(key, value);
  }
  if (args.size !== 2 || !args.has('--manifest') || !args.has('--output')) {
    fail('Usage: node scripts/security/preflight-aws-backup-copy-job-replay.mjs --manifest <capture.json> --output <preflight.json>');
  }
  const manifestBytes = await readManifest(args.get('--manifest'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validate(manifest);
  const identity = await runJson(['sts', 'get-caller-identity', '--region', manifest.region]);
  if (identity.Account !== manifest.accountId) fail('AWS caller account does not match the manifest');

  const archive = await runJson(['events', 'describe-archive', '--archive-name', manifest.archiveName, '--region', manifest.region]);
  const eventBusArn = 'arn:' + manifest.archiveArn.split(':')[1]
    + ':events:' + manifest.region + ':' + manifest.accountId + ':event-bus/default';
  if (archive.ArchiveArn !== manifest.archiveArn || archive.EventSourceArn !== eventBusArn
    || archive.State !== 'ENABLED' || archive.RetentionDays !== 0) {
    fail('Archive is not the active, indefinite archive on the declared default event bus');
  }
  const archivePattern = typeof archive.EventPattern === 'string' ? JSON.parse(archive.EventPattern) : archive.EventPattern;
  if (JSON.stringify(archivePattern?.source) !== JSON.stringify(['aws.backup'])
    || JSON.stringify(archivePattern?.['detail-type']) !== JSON.stringify(['Copy Job State Change'])) {
    fail('Archive does not cover AWS Backup Copy Job State Change events');
  }

  const rule = await runJson([
    'events', 'describe-rule', '--name', manifest.captureRuleName,
    '--event-bus-name', 'default', '--region', manifest.region,
  ]);
  const targetResponse = await runJson([
    'events', 'list-targets-by-rule', '--rule', manifest.captureRuleName,
    '--event-bus-name', 'default', '--region', manifest.region,
  ]);
  const captureRule = assertReplayCaptureRule(rule, targetResponse.Targets || [],
    manifest.captureRuleName, manifest.captureQueueArn, manifest.captureDeadLetterQueueArn,
    manifest.accountId, manifest.region);
  const primary = assertReplayQueueAttributes(await queueAttributes(manifest.captureQueueUrl, manifest.region),
    manifest.captureQueueArn, manifest.captureDeadLetterQueueArn, rule.Arn, manifest.accountId);
  const dlq = assertReplayDlqAttributes(await queueAttributes(manifest.captureDeadLetterQueueUrl, manifest.region),
    manifest.captureDeadLetterQueueArn, rule.Arn, manifest.accountId);

  const output = {
    schema: 'factoryos.aws-backup-copy-job-replay-preflight/v1',
    checkedAt: new Date().toISOString(),
    manifestSha256: sha256(manifestBytes),
    accountId: manifest.accountId, region: manifest.region,
    archiveArn: manifest.archiveArn, archiveName: manifest.archiveName, eventBusArn,
    eventStartTime: new Date(manifest.eventStartTime).toISOString(),
    eventEndTime: new Date(manifest.eventEndTime).toISOString(),
    replayName: manifest.replayName,
    captureRuleName: manifest.captureRuleName, captureRuleArn: captureRule.ruleArn,
    captureRulePatternSha256: captureRule.rulePatternSha256, captureRuleTargetsSha256: captureRule.targetsSha256,
    captureQueueArn: primary.queueArn, captureQueueUrl: manifest.captureQueueUrl,
    captureQueuePolicySha256: primary.queuePolicySha256,
    captureDeadLetterQueueArn: dlq.queueArn, captureDeadLetterQueueUrl: manifest.captureDeadLetterQueueUrl,
    captureDeadLetterQueuePolicySha256: dlq.queuePolicySha256,
    captureQueueSecuritySha256: sha256(Buffer.from(JSON.stringify(primary))),
    captureDlqSecuritySha256: sha256(Buffer.from(JSON.stringify(dlq))),
    replayDestination: 'SOURCE_EVENT_BUS_FILTERED_TO_ONE_CAPTURE_RULE',
    selectedFilterArns: [captureRule.ruleArn], productionRulesSelected: 0,
    destructiveBackupActionsPermitted: false,
  };
  const outputPath = resolve(args.get('--output'));
  const handle = await open(outputPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(output, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  process.stdout.write(JSON.stringify({
    schema: output.schema, preflightFile: basename(outputPath),
    manifestSha256: output.manifestSha256, captureRuleArn: output.captureRuleArn,
    replayFilterCount: 1, productionRulesSelected: 0, canStartReplay: true,
  }, null, 2) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('AWS Backup replay preflight refused: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
