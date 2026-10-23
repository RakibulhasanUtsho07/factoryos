import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function read(path) {
  return readFile(join(root, path), 'utf8');
}

test('release publisher runs only for trusted main pushes, never for pull-request code', async () => {
  const workflow = await read('../../.github/workflows/ot-gateway-release.yml');
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /edge\/ot-gateway\/\*\*/);
  assert.doesNotMatch(workflow, /^\s*pull_request\s*:/m);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /artifact-metadata:\s*write/);
});

test('release provenance and signature bind to the pushed OCI digest', async () => {
  const workflow = await read('../../.github/workflows/ot-gateway-release.yml');
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /tags:[\s\S]*?\$\{\{\s*env\.IMAGE_NAME\s*\}\}:\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /uses:\s*actions\/attest@v4/);
  assert.match(workflow, /subject-name:\s*\$\{\{\s*env\.IMAGE_NAME\s*\}\}/);
  assert.match(workflow, /subject-digest:\s*\$\{\{\s*steps\.push\.outputs\.digest\s*\}\}/);
  assert.match(workflow, /push-to-registry:\s*true/);
  assert.match(workflow, /cosign sign --yes "\$IMAGE_NAME@\$IMAGE_DIGEST"/);
  assert.match(workflow, /cosign verify/);
  assert.match(workflow, /EXPECTED_IDENTITY:\s*https:\/\/github\.com\/RakibulhasanUtsho07\/factoryos\/\.github\/workflows\/ot-gateway-release\.yml@refs\/heads\/main/);
  assert.match(workflow, /https:\/\/token\.actions\.githubusercontent\.com/);
});

test('admission policy fails closed on untrusted signatures and missing SLSA provenance', async () => {
  const policy = await read('deploy/verify-image-signature.policy.yaml');
  assert.match(policy, /kind:\s*ImageValidatingPolicy/);
  assert.match(policy, /validationActions:[\s\S]*?-\s*Deny/);
  assert.match(policy, /failurePolicy:\s*Fail/);
  assert.match(policy, /operations:[\s\S]*?-\s*CREATE[\s\S]*?-\s*UPDATE/);
  assert.match(policy, /resources:[\s\S]*?-\s*pods/);
  assert.match(policy, /ghcr\.io\/rakibulhasanutsho07\/factoryos\/ot-edge-gateway\*/);
  assert.match(policy, /subject:\s*"https:\/\/github\.com\/RakibulhasanUtsho07\/factoryos\/\.github\/workflows\/ot-gateway-release\.yml@refs\/heads\/main"/);
  assert.match(policy, /issuer:\s*"https:\/\/token\.actions\.githubusercontent\.com"/);
  assert.match(policy, /https:\/\/rekor\.sigstore\.dev/);
  assert.match(policy, /verifyImageSignatures/);
  assert.match(policy, /verifyAttestationSignatures/);
  assert.match(policy, /https:\/\/slsa\.dev\/provenance\/v1/);
});

test('deployment points at the signed release image and defines a private-registry pull secret', async () => {
  const deployment = await read('deploy/deployment.yaml');
  assert.match(deployment, /image:\s*ghcr\.io\/rakibulhasanutsho07\/factoryos\/ot-edge-gateway:/);
  assert.doesNotMatch(deployment, /registry\.example\.test\/factoryos\/ot-edge-gateway/);
  assert.match(deployment, /imagePullSecrets:[\s\S]*?name:\s*factoryos-ghcr-pull/);
});

test('docs disclose cluster-admission and hardware commissioning boundaries', async () => {
  const readme = await read('README.md');
  assert.match(readme, /FR-SAAS2-05/);
  assert.match(readme, /FR-MSO-03/);
  assert.match(readme, /verify-image-signature\.policy\.yaml/);
  assert.match(readme, /must be installed/i);
  assert.match(readme, /HIL commissioning/i);
  assert.match(readme, /not claim.*HIL/i);
});
