import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProtocolSupervisor } from '../src/index.mjs';

test('missing initial secret inventory aborts startup before readiness can become true', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'factoryos-ot-startup-secrets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const supervisor = new ProtocolSupervisor({
    security: {
      serverCertFile: join(dir, 'missing-gateway-cert.pem'),
      serverKeyFile: join(dir, 'missing-gateway-key.pem'),
    },
    mqtt: null,
    opcua: [],
    modbus: [],
  }, {});

  await assert.rejects(() => supervisor.start(), /SECRET_ROTATION_FILE_UNAVAILABLE/);
  assert.equal(supervisor.started, false);
  assert.equal(supervisor.rotationFault, true);
  assert.equal(supervisor.health().ready, false);
  assert.equal(supervisor.health().credentialRotationReady, false);
  assert.equal(supervisor.health().errorCode, 'SECRET_ROTATION_FILE_UNAVAILABLE');
  assert.deepEqual(supervisor.opcua, []);
  assert.deepEqual(supervisor.modbus, []);
  assert.equal(supervisor.mqtt, null);
});
