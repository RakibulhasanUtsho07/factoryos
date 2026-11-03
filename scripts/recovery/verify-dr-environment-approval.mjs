import { createHash } from 'node:crypto';
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function fail(message) {
  console.error('DR environment approval rejected: ' + message);
  process.exit(2);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail('expected --name value arguments');
    }
    const name = key.slice(2);
    if (values[name] !== undefined) fail('duplicate argument: ' + key);
    values[name] = argv[index + 1];
    index += 1;
  }
  const allowed = new Set([
    'approvals-json', 'output', 'environment', 'approver', 'operator',
    'candidate-sha', 'run-id', 'repository', 'targets-approved',
    'rpo-target-seconds', 'rto-target-seconds',
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) fail('unknown argument: --' + name);
  }
  return values;
}

const args = parseArguments(process.argv.slice(2));
for (const name of ['approvals-json', 'output', 'environment', 'approver', 'operator', 'candidate-sha', 'run-id', 'repository', 'targets-approved']) {
  if (!args[name]?.trim()) fail('missing required --' + name);
}
if (!['true', 'false'].includes(args['targets-approved'])) fail('--targets-approved must be true or false');
if (args.environment !== 'production-dr-rehearsal') fail('unexpected GitHub Environment name');
if (!/^[a-f0-9]{40}$/.test(args['candidate-sha'])) fail('--candidate-sha must be a full lowercase 40-character SHA');
if (!/^[1-9][0-9]*$/.test(args['run-id']) || !Number.isSafeInteger(Number(args['run-id']))) fail('--run-id must be a positive integer');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository)) fail('--repository must be owner/repository');
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
if (!loginPattern.test(args.approver) || !loginPattern.test(args.operator)) fail('approver and operator must be GitHub login names');
if (args.approver.toLowerCase() === args.operator.toLowerCase()) fail('environment approver must be independent from the workflow operator');

let approvedTargets = null;
if (args['targets-approved'] === 'true') {
  for (const name of ['rpo-target-seconds', 'rto-target-seconds']) {
    if (!/^(0|[1-9][0-9]*)$/.test(args[name] ?? '') || !Number.isSafeInteger(Number(args[name]))) {
      fail('--' + name + ' must be a non-negative integer when target approval is enabled');
    }
  }
  approvedTargets = {
    rpoSeconds: Number(args['rpo-target-seconds']),
    rtoSeconds: Number(args['rto-target-seconds']),
  };
} else if (args['rpo-target-seconds'] || args['rto-target-seconds']) {
  fail('RPO/RTO target values must not be supplied when targets are not approved');
}

const approvalsPath = resolve(args['approvals-json']);
const approvalsStat = await lstat(approvalsPath).catch(() => fail('workflow approval history is missing or unreadable'));
if (!approvalsStat.isFile() || approvalsStat.isSymbolicLink() || (approvalsStat.mode & 0o022) !== 0) {
  fail('workflow approval history must be a protected regular file, not a symlink');
}
const approvalsBytes = await readFile(approvalsPath).catch(() => fail('workflow approval history could not be read'));
let approvals;
try {
  approvals = JSON.parse(approvalsBytes.toString('utf8'));
} catch {
  fail('GitHub workflow approval history is not valid JSON');
}
if (!Array.isArray(approvals)) fail('GitHub workflow approval history must be an array');

const expectedEnvironment = args.environment;
const expectedApprover = args.approver.toLowerCase();
const matches = approvals.filter((approval) => {
  if (approval?.state !== 'approved' || approval?.user?.login?.toLowerCase() !== expectedApprover) return false;
  return Array.isArray(approval.environments)
    && approval.environments.some((environment) => environment?.name === expectedEnvironment);
});
if (matches.length === 0) fail('the named approver has no approved decision for the production-dr-rehearsal Environment on this workflow run');

const targetMarker = approvedTargets
  ? `FACTORYOS_DR_TARGETS_APPROVED:rpo=${approvedTargets.rpoSeconds};rto=${approvedTargets.rtoSeconds}`
  : null;
let selectedApproval = matches.find((approval) => {
  if (!targetMarker) return true;
  return typeof approval.comment === 'string' && approval.comment.split(/\r?\n/).some((line) => line.trim() === targetMarker);
});
if (!selectedApproval && targetMarker) {
  fail('the actual GitHub Environment approval comment must contain the exact owner target marker: ' + targetMarker);
}
if (!selectedApproval) fail('no matching approved GitHub Environment review was found');

const approvedBy = selectedApproval.user.login;
if (approvedBy.toLowerCase() === args.operator.toLowerCase()) fail('GitHub Environment approval was not independent of the workflow operator');
const approvalHistorySha256 = createHash('sha256').update(approvalsBytes).digest('hex');
const workflowRunId = Number(args['run-id']);
const approvalHistoryUrl = `https://api.github.com/repos/${args.repository}/actions/runs/${workflowRunId}/approvals`;
const attestation = {
  schema: 'factoryos.dr-environment-approval/v1',
  source: 'GITHUB_ACTIONS_WORKFLOW_RUN_APPROVALS_API',
  repository: args.repository,
  workflowRunId,
  candidateSha: args['candidate-sha'],
  environment: expectedEnvironment,
  operator: args.operator,
  approvedBy,
  approvedById: Number.isSafeInteger(selectedApproval.user.id) ? selectedApproval.user.id : null,
  approvedAtDecision: 'approved',
  approvalHistoryUrl,
  approvalHistorySha256,
  targetApproval: approvedTargets
    ? { approved: true, ...approvedTargets, exactCommentMarker: targetMarker }
    : { approved: false, rpoSeconds: null, rtoSeconds: null, exactCommentMarker: null },
  retrievedAtUtc: new Date().toISOString(),
};

const output = resolve(args.output);
const serialized = JSON.stringify(attestation, null, 2) + '\n';
const temporary = output + '.partial-' + process.pid;
await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 }).catch(() => fail('could not create the protected approval attestation'));
try {
  await link(temporary, output).catch((error) => {
    fail(error.code === 'EEXIST' ? 'approval attestation already exists; refusing to overwrite it' : 'could not publish approval attestation');
  });
} finally {
  await unlink(temporary).catch(() => undefined);
}
console.log('dr_environment_approval=' + output);
console.log('dr_approval_history_sha256=' + approvalHistorySha256);
console.log('dr_environment_approver=' + approvedBy);
