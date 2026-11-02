#!/usr/bin/env node
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  assertReplayCaptureRule, assertReplayQueueAttributes, assertReplayDlqAttributes, sha256,
} from '../audit/aws-backup-copy-job-audit-evidence.mjs';

const MAX_AWS_OUTPUT = 8 * 1024 * 1024;
const MAX_MESSAGES = 500000;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
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
      if (total > MAX_AWS_OUTPUT) { child.kill('SIGKILL'); clearTimeout(timer); reject(new Error('AWS CLI output exceeded 8 MiB')); return; }
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
async function runJson(args, timeoutMs = 60000) {
  const raw = await runAws([...args, '--output', 'json'], timeoutMs);
  try { return JSON.parse(raw); } catch { fail('AWS CLI returned invalid JSON for ' + args.slice(0, 2).join(' ')); }
}
async function readJson(path, schema) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 1024 * 1024) {
    fail('JSON receipt must be a single-link regular file no larger than 1 MiB');
  }
  const bytes = await readFile(path);
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (parsed.schema !== schema) fail('JSON receipt schema is invalid');
  return { parsed, bytes };
}
async function queueAttributes(queueUrl, region) {
  const response = await runJson(['sqs', 'get-queue-attributes', '--queue-url', queueUrl,
    '--attribute-names', 'All', '--region', region]);
  return response.Attributes || {};
}
function epoch(value) {
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  return Date.parse(value);
}
function equalTime(left, right) {
  const a = typeof left === 'number' ? epoch(left) : Date.parse(left);
  const b = typeof right === 'number' ? epoch(right) : Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}
function validateBinding(manifest, preflight, replayReceipt, manifestBytes, preflightBytes) {
  if (manifest.schema !== 'factoryos.aws-backup-copy-job-replay-capture/v1'
    || preflight.schema !== 'factoryos.aws-backup-copy-job-replay-preflight/v1'
    || replayReceipt.schema !== 'factoryos.aws-backup-copy-job-replay-start/v1') fail('Replay capture input schema is invalid');
  const fields = [
    'accountId', 'region', 'archiveArn', 'archiveName', 'replayName', 'eventStartTime', 'eventEndTime',
    'captureRuleName', 'captureQueueArn', 'captureQueueUrl', 'captureDeadLetterQueueArn', 'captureDeadLetterQueueUrl',
  ];
  for (const field of fields) if (String(manifest[field]) !== String(preflight[field])) fail('Preflight does not match manifest field ' + field);
  if (sha256(manifestBytes) !== replayReceipt.manifestSha256
    || sha256(preflightBytes) !== replayReceipt.preflightSha256
    || replayReceipt.accountId !== manifest.accountId || replayReceipt.region !== manifest.region
    || replayReceipt.archiveArn !== manifest.archiveArn || replayReceipt.replayName !== manifest.replayName
    || !equalTime(replayReceipt.eventStartTime, manifest.eventStartTime)
    || !equalTime(replayReceipt.eventEndTime, manifest.eventEndTime)
    || replayReceipt.destinationRuleCount !== 1 || replayReceipt.productionRulesSelected !== 0
    || replayReceipt.destructiveBackupActionsPerformed !== false
    || JSON.stringify(replayReceipt.filterArns) !== JSON.stringify([preflight.captureRuleArn])) {
    fail('Replay receipt is not bound to the exact preflight, archive, scope and filtered destination');
  }
  if (Date.parse(preflight.checkedAt) >= Date.parse(replayReceipt.startedAt)) fail('Replay must start after its preflight');
}
async function appendBatch(handle, messages, currentBytes, receiptHandles) {
  let bytes = currentBytes;
  for (const message of messages) {
    const wrapper = {
      messageId: message.MessageId,
      sentTimestamp: message.Attributes?.SentTimestamp || null,
      body: message.Body,
      bodySha256: sha256(Buffer.from(message.Body, 'utf8')),
    };
    const line = JSON.stringify(wrapper) + '\n';
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_CAPTURE_BYTES) fail('Capture exceeded the 256 MiB bound');
    await handle.write(line, null, 'utf8');
    receiptHandles.push(message.ReceiptHandle);
  }
  await handle.sync();
  return bytes;
}
async function acknowledgeMessages(receiptHandles, queueUrl, region) {
  let succeeded = 0; let failed = 0;
  for (let offset = 0; offset < receiptHandles.length; offset += 10) {
    let pending = receiptHandles.slice(offset, offset + 10);
    for (let attempt = 0; attempt < 3 && pending.length; attempt += 1) {
      const entries = pending.map((ReceiptHandle, index) => ({ Id: 'm' + index, ReceiptHandle }));
      try {
        const result = await runJson(['sqs', 'delete-message-batch', '--queue-url', queueUrl,
          '--entries', JSON.stringify(entries), '--region', region]);
        const successful = new Set((result.Successful || []).map((entry) => entry.Id));
        const failedIds = new Set((result.Failed || []).map((entry) => entry.Id));
        succeeded += successful.size;
        pending = pending.filter((_, index) => failedIds.has('m' + index) || !successful.has('m' + index));
      } catch {
        // Keep failed acknowledgements visible for redelivery; the durable capture remains available.
      }
    }
    failed += pending.length;
  }
  return { succeeded, failed };
}
async function main() {
  const argv = process.argv.slice(2); const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || args.has(key)) fail('Invalid or duplicate argument');
    args.set(key, value);
  }
  const required = ['--manifest', '--preflight', '--replay-receipt', '--output', '--summary-output'];
  if (args.size !== required.length || required.some((key) => !args.has(key))) {
    fail('Usage: node scripts/security/capture-aws-backup-copy-job-replay.mjs --manifest <capture.json> --preflight <preflight.json> --replay-receipt <replay.json> --output <capture.ndjson> --summary-output <capture-summary.json>');
  }
  const manifestRead = await readJson(args.get('--manifest'), 'factoryos.aws-backup-copy-job-replay-capture/v1');
  const preflightRead = await readJson(args.get('--preflight'), 'factoryos.aws-backup-copy-job-replay-preflight/v1');
  const replayRead = await readJson(args.get('--replay-receipt'), 'factoryos.aws-backup-copy-job-replay-start/v1');
  const manifest = manifestRead.parsed; const preflight = preflightRead.parsed; const replayReceipt = replayRead.parsed;
  validateBinding(manifest, preflight, replayReceipt, manifestRead.bytes, preflightRead.bytes);

  const identity = await runJson(['sts', 'get-caller-identity', '--region', manifest.region]);
  if (identity.Account !== manifest.accountId) fail('AWS caller account differs from the capture manifest');
  const archive = await runJson(['events', 'describe-archive', '--archive-name', manifest.archiveName, '--region', manifest.region]);
  if (archive.ArchiveArn !== manifest.archiveArn || archive.State !== 'ENABLED' || archive.RetentionDays !== 0) fail('EventBridge archive is no longer enabled with indefinite retention');
  const replay = await runJson(['events', 'describe-replay', '--replay-name', manifest.replayName, '--region', manifest.region]);
  const replayEventStart = epoch(replay.EventStartTime);
  const replayEventEnd = epoch(replay.EventEndTime);
  const replayDestination = replay.Destination || {};
  const replayFilterArns = replayDestination.FilterArns || [];
  const hasReplayEventRange = replay.EventStartTime !== undefined && replay.EventEndTime !== undefined;
  const hasNoReplayEventRange = replay.EventStartTime === undefined && replay.EventEndTime === undefined;
  if (replay.ReplayArn !== replayReceipt.replayArn || replay.ReplayName !== manifest.replayName
    || replay.EventSourceArn !== manifest.archiveArn || replay.State !== 'COMPLETED'
    || replayDestination.Arn !== preflight.eventBusArn
    || replayFilterArns.length !== 1 || replayFilterArns[0] !== preflight.captureRuleArn
    || (!hasReplayEventRange && !hasNoReplayEventRange)
    || (hasReplayEventRange && (!Number.isFinite(replayEventStart) || !Number.isFinite(replayEventEnd)
      || replayEventStart < Date.parse(manifest.eventStartTime)
      || replayEventEnd > Date.parse(manifest.eventEndTime) || replayEventEnd < replayEventStart))
    || !Number.isFinite(epoch(replay.ReplayStartTime))
    || epoch(replay.ReplayStartTime) < Date.parse(preflight.checkedAt)
    || !Number.isFinite(epoch(replay.ReplayEndTime))
    || epoch(replay.ReplayEndTime) < epoch(replay.ReplayStartTime)) {
    fail('EventBridge replay is not completed for the exact preflighted archive/window and single capture-rule destination');
  }

  const rule = await runJson(['events', 'describe-rule', '--name', manifest.captureRuleName,
    '--event-bus-name', 'default', '--region', manifest.region]);
  const targets = await runJson(['events', 'list-targets-by-rule', '--rule', manifest.captureRuleName,
    '--event-bus-name', 'default', '--region', manifest.region]);
  const verifiedRule = assertReplayCaptureRule(rule, targets.Targets || [], manifest.captureRuleName,
    manifest.captureQueueArn, manifest.captureDeadLetterQueueArn, manifest.accountId, manifest.region);
  if (verifiedRule.ruleArn !== preflight.captureRuleArn
    || verifiedRule.rulePatternSha256 !== preflight.captureRulePatternSha256
    || verifiedRule.targetsSha256 !== preflight.captureRuleTargetsSha256) fail('Capture rule or target changed after preflight');
  const primary = assertReplayQueueAttributes(await queueAttributes(manifest.captureQueueUrl, manifest.region),
    manifest.captureQueueArn, manifest.captureDeadLetterQueueArn, verifiedRule.ruleArn, manifest.accountId, false);
  const dlq = assertReplayDlqAttributes(await queueAttributes(manifest.captureDeadLetterQueueUrl, manifest.region),
    manifest.captureDeadLetterQueueArn, verifiedRule.ruleArn, manifest.accountId);
  if (primary.queuePolicySha256 !== preflight.captureQueuePolicySha256
    || dlq.queuePolicySha256 !== preflight.captureDeadLetterQueuePolicySha256
    || sha256(Buffer.from(JSON.stringify(primary))) !== preflight.captureQueueSecuritySha256
    || sha256(Buffer.from(JSON.stringify(dlq))) !== preflight.captureDlqSecuritySha256) fail('Capture queue or DLQ configuration changed after preflight');

  const outputPath = resolve(args.get('--output'));
  const summaryPath = resolve(args.get('--summary-output'));
  if (outputPath === summaryPath) fail('Capture and summary output paths must be different');
  const partialPath = outputPath + '.partial';
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const handle = await open(partialPath, 'wx', 0o600);
  let bytesWritten = 0; let received = 0; let idlePolls = 0;
  const receiptHandles = [];
  const maxIdlePolls = Number.isSafeInteger(manifest.maxIdlePolls) ? manifest.maxIdlePolls : 15;
  const maxMessages = Number.isSafeInteger(manifest.maxMessages) ? manifest.maxMessages : MAX_MESSAGES;
  if (maxIdlePolls < 15 || maxIdlePolls > 180 || maxMessages < 1 || maxMessages > MAX_MESSAGES) {
    await handle.close(); fail('Capture poll/message bounds are invalid');
  }
  try {
    while (idlePolls < maxIdlePolls && received < maxMessages) {
      const response = await runJson(['sqs', 'receive-message', '--queue-url', manifest.captureQueueUrl,
        '--wait-time-seconds', '20', '--visibility-timeout', '43200', '--max-number-of-messages', '10',
        '--attribute-names', 'All', '--region', manifest.region], 30000);
      const messages = response.Messages || [];
      if (!messages.length) { idlePolls += 1; continue; }
      idlePolls = 0;
      for (const message of messages) {
        if (typeof message.Body !== 'string' || typeof message.ReceiptHandle !== 'string' || typeof message.MessageId !== 'string') {
          fail('SQS returned a malformed message; it remains unacknowledged');
        }
        let event;
        try { event = JSON.parse(message.Body); } catch { fail('SQS contains invalid EventBridge JSON; message remains unacknowledged'); }
        const eventTime = Date.parse(event.time);
        if (event.account !== manifest.accountId || event.region !== manifest.region
          || event.source !== 'aws.backup' || event['detail-type'] !== 'Copy Job State Change'
          || event['replay-name'] !== manifest.replayName || typeof event.id !== 'string'
          || !Number.isFinite(eventTime) || eventTime < Date.parse(manifest.eventStartTime)
          || eventTime > Date.parse(manifest.eventEndTime)) {
          fail('SQS message is outside the exact account/Region/source/replay/time scope; message remains unacknowledged');
        }
      }
      bytesWritten = await appendBatch(handle, messages, bytesWritten, receiptHandles);
      received += messages.length;
      if (received > maxMessages) fail('SQS capture exceeded the configured message bound');
    }
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  if (idlePolls < maxIdlePolls) fail('Capture reached maxMessages before draining the replay queue; use a fresh output path and a larger reviewed bound');
  await rename(partialPath, outputPath);
  const captureBytes = await readFile(outputPath);
  const ack = await acknowledgeMessages(receiptHandles, manifest.captureQueueUrl, manifest.region);
  const queueAfterAttributes = await queueAttributes(manifest.captureQueueUrl, manifest.region);
  const queueAfter = assertReplayQueueAttributes(
    queueAfterAttributes, manifest.captureQueueArn, manifest.captureDeadLetterQueueArn,
    verifiedRule.ruleArn, manifest.accountId,
  );
  const dlqAfterAttributes = await queueAttributes(manifest.captureDeadLetterQueueUrl, manifest.region);
  const dlqAfter = assertReplayDlqAttributes(
    dlqAfterAttributes, manifest.captureDeadLetterQueueArn, verifiedRule.ruleArn, manifest.accountId,
  );
  const queueCounts = {
    available: Number(queueAfterAttributes.ApproximateNumberOfMessages),
    notVisible: Number(queueAfterAttributes.ApproximateNumberOfMessagesNotVisible),
    delayed: Number(queueAfterAttributes.ApproximateNumberOfMessagesDelayed),
  };
  const dlqCounts = {
    available: Number(dlqAfterAttributes.ApproximateNumberOfMessages),
    notVisible: Number(dlqAfterAttributes.ApproximateNumberOfMessagesNotVisible),
    delayed: Number(dlqAfterAttributes.ApproximateNumberOfMessagesDelayed),
  };
  if (ack.failed !== 0 || ack.succeeded !== received) {
    fail('SQS message acknowledgement is incomplete; preserve the capture file, resolve redelivery and do not sign this pack');
  }
  const summary = {
    schema: 'factoryos.aws-backup-copy-job-replay-capture/v1',
    accountId: manifest.accountId, region: manifest.region,
    archiveArn: manifest.archiveArn, replayArn: replayReceipt.replayArn,
    replayName: manifest.replayName, captureRuleName: manifest.captureRuleName,
    captureQueueArn: manifest.captureQueueArn,
    eventStartTime: new Date(manifest.eventStartTime).toISOString(),
    eventEndTime: new Date(manifest.eventEndTime).toISOString(),
    manifestSha256: sha256(manifestRead.bytes), preflightSha256: sha256(preflightRead.bytes),
    replayReceiptSha256: sha256(replayRead.bytes),
    replayLastReplayedTime: replay.EventLastReplayedTime || null,
    replayObservedEventStartTime: replay.EventStartTime || null,
    replayObservedEventEndTime: replay.EventEndTime || null,
    eventCount: received, captureQueueDrained: true,
    captureQueuePostReadBackSha256: sha256(Buffer.from(JSON.stringify(queueAfter))),
    deadLetterQueuePostReadBackSha256: sha256(Buffer.from(JSON.stringify(dlqAfter))),
    captureQueuePostReadBackCounts: queueCounts,
    deadLetterQueuePostReadBackCounts: dlqCounts,
    queueAcknowledgedCount: ack.succeeded, queueAcknowledgementFailedCount: ack.failed,
    queueAcknowledgementComplete: ack.failed === 0 && ack.succeeded === received,
    captureQuietPolls: idlePolls,
    minimumQuietWindowSeconds: maxIdlePolls * 20,
    queueAcknowledgedOnlyAfterCaptureFsyncAndAtomicRename: true,
    captureFile: basename(outputPath), captureBytes: captureBytes.length,
    captureSha256: sha256(captureBytes), createdAt: new Date().toISOString(),
  };
  const summaryHandle = await open(summaryPath, 'wx', 0o600);
  try { await summaryHandle.writeFile(JSON.stringify(summary, null, 2) + '\n', 'utf8'); await summaryHandle.sync(); }
  finally { await summaryHandle.close(); }
  process.stdout.write(JSON.stringify({
    schema: summary.schema, eventCount: summary.eventCount, captureSha256: summary.captureSha256,
    queueAcknowledgementComplete: summary.queueAcknowledgementComplete,
    queueAcknowledgedCount: ack.succeeded, queueAcknowledgementFailedCount: ack.failed,
    captureFile: summary.captureFile, summaryFile: basename(summaryPath),
  }, null, 2) + '\n');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('AWS Backup replay capture refused: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
