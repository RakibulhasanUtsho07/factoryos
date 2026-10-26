import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/wms-provider-live-smoke.yml', import.meta.url);

test('manual provider smoke validates least-privilege storage policy before side effects', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const policyStep = source.indexOf('Verify POD storage identity policy shape before shipment side effects');
  const smokeStep = source.indexOf('Run configured storage and webhook receiver smoke');
  assert.ok(policyStep >= 0, 'policy preflight step exists');
  assert.ok(smokeStep > policyStep, 'policy preflight must run before shipment side effects');
  assert.match(source, /WMS_POD_STORAGE_POLICY_JSON: \$\{\{ secrets\.WMS_POD_STORAGE_POLICY_JSON \}\}/);
  assert.match(source, /WMS_POD_STORAGE_BUCKET: \$\{\{ vars\.WMS_POD_STORAGE_BUCKET \}\}/);
  assert.match(source, /WMS_POD_STORAGE_PREFIX: \$\{\{ vars\.WMS_POD_STORAGE_PREFIX \}\}/);
  assert.match(source, /wms-storage-policy-report-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.json/);
  assert.match(source, /trap 'rm -f "\$policy_file"' EXIT/);
  assert.match(source, /umask 077/);
});

test('uploaded output remains smoke evidence and explicitly does not certify effective IAM or carrier origin', async () => {
  const source = await readFile(workflowPath, 'utf8');
  assert.match(source, /artifacts\/wms-provider-certification-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.json/);
  assert.match(source, /artifacts\/wms-storage-policy-report-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.json/);
  assert.match(source, /does not prove a carrier-originated callback, provider-side retry, or IAM least privilege/i);
  assert.match(source, /retention-days: 30/);
});
