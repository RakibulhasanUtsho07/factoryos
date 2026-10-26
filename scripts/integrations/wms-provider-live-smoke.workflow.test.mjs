import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/wms-provider-live-smoke.yml', import.meta.url);

test('live provider smoke is manually dispatched only and requires protected environment approval', async () => {
  const source = await readFile(workflowPath, 'utf8');
  assert.match(source, /^on:\s*\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(source, /^\s+(?:pull_request|push):/m);
  assert.match(source, /environment:\s*\n\s+name:\s*wms-provider-certification/);
  assert.match(source, /actions\/upload-artifact@v4/);
  assert.match(source, /FACTORYOS_CERT_ALLOW_SIDE_EFFECTS/);
  assert.match(source, /WMS_POD_STORAGE_POLICY_JSON/);
  assert.match(source, /wms-provider-evidence-safety-check\.mjs/);
  assert.match(source, /carrier-native sandbox callback\/retry is not generated/i);
});

test('workflow targets only staging or sandbox and grants read-only repository permissions', async () => {
  const source = await readFile(workflowPath, 'utf8');
  assert.match(source, /options:\s*\n\s+- staging\s*\n\s+- sandbox/);
  assert.match(source, /permissions:\s*\n\s+contents:\s+read/);
  assert.match(source, /if-no-files-found:\s*error/);
  assert.doesNotMatch(source, /FACTORYOS_CERT_WEBHOOK_SECRET:\s*\$\{\{\s*vars\./);
});
