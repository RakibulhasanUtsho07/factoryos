import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DurableObservationSpool,
  createEdgeGatewaySender,
  EdgePackageControlSyncClient,
  EdgePackageExecutionSupervisor,
  EdgePackageHostRuntimeAdapter,
  EdgePackageHostRuntimeAdapter,
  EdgePackageSupervisorError,
  edgePackageRuntimeSigningPayload,
  verifySynchronizedEdgePackage,
  EdgePackageRuntimeVerificationError,
} from '../index.mjs';

test('workspace entrypoint exposes the supported public Edge agent API', () => {
  for (const exported of [
    DurableObservationSpool,
    createEdgeGatewaySender,
    EdgePackageControlSyncClient,
    EdgePackageExecutionSupervisor,
    EdgePackageSupervisorError,
    edgePackageRuntimeSigningPayload,
    verifySynchronizedEdgePackage,
    EdgePackageRuntimeVerificationError,
  ]) {
    assert.notEqual(exported, undefined);
  }
});
