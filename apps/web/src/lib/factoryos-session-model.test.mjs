import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspaceSessionSnapshot,
  isActiveWorkspaceFactory,
} from "./factoryos-session-model.mjs";

const tenantId = "a1000000-0000-4000-8000-000000000001";
const userId = "a3000000-0000-4000-8000-000000000003";
const membershipId = "a3100000-0000-4000-8000-000000000003";
const factoryId = "a2000000-0000-4000-8000-000000000002";

const currentUser = {
  authenticated: true,
  user: { userId, tenantId, membershipId },
};
const access = {
  user: { id: userId, email: "operator@example.test", displayName: "Factory Operator" },
  tenant: { id: tenantId, slug: "demo-factory", name: "Demo Factory", timezone: "Asia/Dhaka", defaultLocale: "en" },
  membership: { id: membershipId, status: "ACTIVE" },
  roles: [{ id: "role-1", code: "FACTORY_MANAGER", name: "Factory Manager" }],
  permissions: [{ id: "perm-1", code: "iam.access.read", description: "Read IAM access" }],
};
const factories = {
  items: [
    { id: factoryId, code: "DHK-01", name: "Dhaka Plant", status: "ACTIVE", timezone: "Asia/Dhaka" },
    { id: "a2200000-0000-4000-8000-000000000022", code: "OLD-01", name: "Archived Plant", status: "INACTIVE" },
  ],
  count: 2,
};

test("workspace context accepts matching authenticated tenant and active membership", () => {
  const snapshot = createWorkspaceSessionSnapshot(currentUser, access, factories, tenantId);
  assert.equal(snapshot.user.id, userId);
  assert.equal(snapshot.tenant.id, tenantId);
  assert.equal(snapshot.membership.status, "ACTIVE");
  assert.equal(snapshot.roles[0].code, "FACTORY_MANAGER");
  assert.equal(snapshot.permissions[0].code, "iam.access.read");
  assert.equal(snapshot.factories.length, 2);
});

test("workspace context rejects unauthenticated responses", () => {
  assert.throws(
    () => createWorkspaceSessionSnapshot({ authenticated: false }, access, factories, tenantId),
    /did not confirm/i,
  );
});

test("workspace context rejects a different JWT tenant", () => {
  assert.throws(
    () => createWorkspaceSessionSnapshot({
      authenticated: true,
      user: { ...currentUser.user, tenantId: "a9999999-9999-4999-8999-999999999999" },
    }, access, factories, tenantId),
    /verified identity/i,
  );
});

test("workspace context rejects a tenant mismatch in IAM access", () => {
  assert.throws(
    () => createWorkspaceSessionSnapshot(currentUser, {
      ...access,
      tenant: { ...access.tenant, id: "a9999999-9999-4999-8999-999999999999" },
    }, factories, tenantId),
    /different tenant/i,
  );
});

test("workspace context rejects a user ID mismatch between auth and IAM", () => {
  assert.throws(
    () => createWorkspaceSessionSnapshot({
      ...currentUser,
      user: { ...currentUser.user, userId: "a3999999-9999-4999-8999-999999999999" },
    }, access, factories, tenantId),
    /does not match the IAM user/i,
  );
});

test("workspace context rejects a membership ID mismatch between auth and IAM", () => {
  assert.throws(
    () => createWorkspaceSessionSnapshot({
      ...currentUser,
      user: { ...currentUser.user, membershipId: "a3999999-9999-4999-8999-999999999999" },
    }, access, factories, tenantId),
    /does not match the IAM membership/i,
  );
});

test("workspace context rejects inactive tenant memberships", () => {
  assert.throws(
    () => createWorkspaceSessionSnapshot(currentUser, {
      ...access,
      membership: { ...access.membership, status: "SUSPENDED" },
    }, factories, tenantId),
    /not active/i,
  );
});

test("factory selector accepts only factories returned as ACTIVE", () => {
  const snapshot = createWorkspaceSessionSnapshot(currentUser, access, factories, tenantId);
  assert.equal(isActiveWorkspaceFactory(snapshot, factoryId), true);
  assert.equal(isActiveWorkspaceFactory(snapshot, "a2200000-0000-4000-8000-000000000022"), false);
});
