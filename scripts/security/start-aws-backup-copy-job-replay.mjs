#!/usr/bin/env node
import { lstat, open, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  assertReplayCaptureRule, assertReplayQueueAttributes, assertReplayDlqAttributes, sha256,
} from '../audit/aws-backup-copy-job-audit-evidence.mjs';
const MAX_OUTPUT = 8 * 1024 * 1024;
function fail(message) { throw new Error(message); }
async function runAws(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.AWS_CLI_PATH || 'aws', [...args, '--no-cli-pager'], {
      shell: false, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('AWS CLI command timed out')); }, 60000);
    const consume = (chunk, isError) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('AWS CLI output exceeded 8 MiB')); return; }
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
  try { return JSON.parse(raw); } catch { fail('AWS CLI returned invalid JSON'); }
}
async function readReceipt(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 1024 * 1024) fail('Input JSON must be a single-link regular file no larger than 1 MiB');
  return readFile(path);
}
async function queueAttributes(queueUrl, region) {
  const response = await runJson(['sqs', 'get-queue-attributes', '--queue-url', queueUrl, '--attribute-names', 'All', '--region', region]);
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
  if (args.size !== 3 || !args.has('--manifest') || !args.has('--preflight') || !args.has('--output')) {
    fail('Usage: node scripts/security/start-aws-backup-copy-job-replay.mjs --manifest <capture.json> --preflight <preflight.json> --output <replay.json>');
  }
  const manifestBytes = await readReceipt(args.get('--manifest'));
  const preflightBytes = await readReceipt(args.get('--preflight'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const preflight = JSON.parse(preflightBytes.toString('utf8'));
  if (manifest.schema !== 'factoryos.aws-backup-copy-job-replay-capture/v1') fail('Replay manifest schema is invalid');
  if (sha256(manifestBytes) !== preflight.manifestSha256) fail('Replay manifest bytes differ from the preflight receipt');
  for (const field of ['accountId', 'region', 'archiveArn', 'archiveName', 'replayName', 'eventStartTime', 'eventEndTime',
    'captureRuleName', 'captureQueueArn', 'captureQueueUrl', 'captureDeadLetterQueueArn', 'captureDeadLetterQueueUrl']) {
    if (String(manifest[field]) !== String(preflight[field])) fail('Replay manifest/preflight binding mismatch for ' + field);
  }
  if (preflight.schema !== 'factoryos.aws-backup-copy-job-replay-preflight/v1') fail('Preflight receipt schema is invalid');
  const now = Date.now(); const checked = Date.parse(preflight.checkedAt);
  if (!Number.isFinite(checked) || now - checked > 60 * 60 * 1000 || checked > now + 60 * 1000) fail('Preflight must be no more than one hour old');
  if (preflight.replayDestination !== 'SOURCE_EVENT_BUS_FILTERED_TO_ONE_CAPTURE_RULE'
    || preflight.productionRulesSelected !== 0 || preflight.destructiveBackupActionsPermitted !== false
    || !Array.isArray(preflight.selectedFilterArns) || preflight.selectedFilterArns.length !== 1
    || preflight.selectedFilterArns[0] !== preflight.captureRuleArn) fail('Preflight does not prove a single-rule, non-destructive replay destination');

  const identity = await runJson(['sts', 'get-caller-identity', '--region', preflight.region]);
  if (identity.Account !== preflight.accountId) fail('AWS caller account differs from preflight account');
  const archive = await runJson(['events', 'describe-archive', '--archive-name', preflight.archiveName, '--region', preflight.region]);
  const expectedEventBusArn = 'arn:' + preflight.archiveArn.split(':')[1]
    + ':events:' + preflight.region + ':' + preflight.accountId + ':event-bus/default';
  if (archive.ArchiveArn !== preflight.archiveArn || archive.EventSourceArn !== expectedEventBusArn
    || archive.State !== 'ENABLED' || archive.RetentionDays !== 0) {
    fail('Archive state, source bus or indefinite retention changed since preflight');
  }
  const archivePattern = typeof archive.EventPattern === 'string' ? JSON.parse(archive.EventPattern) : archive.EventPattern;
  if (JSON.stringify(archivePattern?.source) !== JSON.stringify(['aws.backup'])
    || JSON.stringify(archivePattern?.['detail-type']) !== JSON.stringify(['Copy Job State Change'])) {
    fail('Archive event pattern changed since preflight');
  }
  const rule = await runJson(['events', 'describe-rule', '--name', preflight.captureRuleName, '--event-bus-name', 'default', '--region', preflight.region]);
  const targetResponse = await runJson(['events', 'list-targets-by-rule', '--rule', preflight.captureRuleName, '--event-bus-name', 'default', '--region', preflight.region]);
  const verified = assertReplayCaptureRule(rule, targetResponse.Targets || [], preflight.captureRuleName,
    preflight.captureQueueArn, preflight.captureDeadLetterQueueArn, preflight.accountId, preflight.region);
  if (verified.ruleArn !== preflight.captureRuleArn || verified.rulePatternSha256 !== preflight.captureRulePatternSha256
    || verified.targetsSha256 !== preflight.captureRuleTargetsSha256) fail('Capture rule changed since preflight');

  const primary = assertReplayQueueAttributes(await queueAttributes(preflight.captureQueueUrl, preflight.region),
    preflight.captureQueueArn, preflight.captureDeadLetterQueueArn, verified.ruleArn, preflight.accountId);
  const dlq = assertReplayDlqAttributes(await queueAttributes(preflight.captureDeadLetterQueueUrl, preflight.region),
    preflight.captureDeadLetterQueueArn, verified.ruleArn, preflight.accountId);
  if (primary.queuePolicySha256 !== preflight.captureQueuePolicySha256
    || dlq.queuePolicySha256 !== preflight.captureDeadLetterQueuePolicySha256
    || sha256(Buffer.from(JSON.stringify(primary))) !== preflight.captureQueueSecuritySha256
    || sha256(Buffer.from(JSON.stringify(dlq))) !== preflight.captureDlqSecuritySha256) {
    fail('Capture queue or DLQ security configuration changed since preflight');
  }

  const destination = JSON.stringify({ Arn: preflight.eventBusArn, FilterArns: [verified.ruleArn] });
  const started = await runJson([
    'events', 'start-replay', '--replay-name', preflight.replayName,
    '--event-source-arn', preflight.archiveArn,
    '--event-start-time', preflight.eventStartTime,
    '--event-end-time', preflight.eventEndTime,
    '--destination', destination, '--region', preflight.region,
  ]);
  const replayArnParts = typeof started.ReplayArn === 'string' ? started.ReplayArn.split(':') : [];
  if (replayArnParts.length < 6 || replayArnParts[2] !== 'events' || replayArnParts[3] !== preflight.region
    || replayArnParts[4] !== preflight.accountId || replayArnParts[5] !== 'replay/' + preflight.replayName
    || !['STARTING', 'RUNNING', 'COMPLETED'].includes(started.State)) fail('EventBridge did not acknowledge the expected replay in the exact account and Region');

  const receipt = {
    schema: 'factoryos.aws-backup-copy-job-replay-start/v1',
    startedAt: new Date().toISOString(), manifestSha256: sha256(manifestBytes), preflightSha256: sha256(preflightBytes),
    accountId: preflight.accountId, region: preflight.region, archiveArn: preflight.archiveArn,
    replayArn: started.ReplayArn, replayName: preflight.replayName,
    eventStartTime: preflight.eventStartTime, eventEndTime: preflight.eventEndTime,
    eventBusArn: preflight.eventBusArn, filterArns: [verified.ruleArn],
    destinationRuleCount: 1, productionRulesSelected: 0, destructiveBackupActionsPerformed: false,
  };
  const outputPath = resolve(args.get('--output'));
  const handle = await open(outputPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  process.stdout.write(JSON.stringify({
    schema: receipt.schema, replayArn: receipt.replayArn, state: started.State,
    destinationRuleCount: 1, productionRulesSelected: 0,
    destructiveBackupActionsPerformed: false, receiptFile: basename(outputPath),
  }, null, 2) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('AWS Backup replay start refused: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
