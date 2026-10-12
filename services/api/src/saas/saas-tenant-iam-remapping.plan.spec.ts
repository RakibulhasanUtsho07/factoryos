import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertSaasTenantIamEffectiveAccess,
  buildSaasTenantIamRemappingPlan,
  SaasTenantIamPortableSnapshot,
  SaasTenantIamTargetDirectory,
} from './saas-tenant-iam-remapping.plan';

const userA = 'faaab63d-c447-46ce-950d-deebdd7f5f30';
const userB = '5e8d2d2b-4a11-4ac7-8db9-cda1eafaf001';
const roleId = '24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const factoryId = '34f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';
const permissionId = '64f17c4f-b34f-4d6b-8ebd-37fbf73e36e7';

function sourceSnapshot(): SaasTenantIamPortableSnapshot {
  return {
    memberships: [
      { userId: userA, status: 'ACTIVE' },
      { userId: userB, status: 'INACTIVE' },
    ],
    roles: [
      { code: 'factory.operator', name: 'Factory Operator', description: null, isSystem: false, status: 'ACTIVE' },
      { code: 'legacy.viewer', name: 'Legacy Viewer', description: 'Retained but disabled', isSystem: false, status: 'INACTIVE' },
    ],
    userRoles: [
      { userId: userA, roleCode: 'factory.operator', factoryCode: 'DHK-01' },
      { userId: userB, roleCode: 'legacy.viewer', factoryCode: null },
    ],
    rolePermissions: [
      { roleCode: 'factory.operator', permissionCode: 'orders.read' },
      { roleCode: 'legacy.viewer', permissionCode: 'reports.read' },
    ],
  };
}

function targetDirectory(): SaasTenantIamTargetDirectory {
  return {
    users: [
      { userId: userA, status: 'ACTIVE' },
      { userId: userB, status: 'ACTIVE' },
    ],
    memberships: [
      { id: '74f17c4f-b34f-4d6b-8ebd-37fbf73e36e7', userId: userA, status: 'ACTIVE' },
    ],
    roles: [
      { id: roleId, code: 'factory.operator', name: 'Factory Operator', description: null, isSystem: false, status: 'ACTIVE' },
    ],
    factories: [
      { id: factoryId, code: 'DHK-01', status: 'ACTIVE' },
    ],
    permissions: [
      { id: permissionId, code: 'orders.read', status: 'ACTIVE' },
      { id: '84f17c4f-b34f-4d6b-8ebd-37fbf73e36e7', code: 'reports.read', status: 'ACTIVE' },
    ],
    userRoles: [
      { userId: userA, roleCode: 'factory.operator', factoryCode: 'DHK-01' },
    ],
    rolePermissions: [
      { roleCode: 'factory.operator', permissionCode: 'orders.read' },
    ],
  };
}

describe('SaaS tenant IAM remapping plan', () => {
  it('maps by stable codes, creates missing memberships/roles and preserves factory scope', () => {
    const plan = buildSaasTenantIamRemappingPlan(sourceSnapshot(), targetDirectory());

    expect(plan.membershipsToCreate).toEqual([{ userId: userB, status: 'INACTIVE' }]);
    expect(plan.rolesToCreate).toEqual([
      { code: 'legacy.viewer', name: 'Legacy Viewer', description: 'Retained but disabled', isSystem: false, status: 'INACTIVE' },
    ]);
    expect(plan.userRolesToCreate).toEqual([
      { userId: userB, roleCode: 'legacy.viewer', factoryCode: null },
    ]);
    expect(plan.rolePermissionsToCreate).toEqual([
      { roleCode: 'legacy.viewer', permissionCode: 'reports.read' },
    ]);
    expect(plan.expectedEffectiveAccess).toEqual([
      { userId: userA, permissionCode: 'orders.read', factoryCode: 'DHK-01' },
    ]);
  });

  it('does not duplicate assignments or grants already present under the same logical keys', () => {
    const source = sourceSnapshot();
    const target = targetDirectory();
    target.userRoles.push({ userId: userB, roleCode: 'legacy.viewer', factoryCode: null });
    target.rolePermissions.push({ roleCode: 'legacy.viewer', permissionCode: 'reports.read' });

    const plan = buildSaasTenantIamRemappingPlan(source, target);
    expect(plan.userRolesToCreate).toEqual([]);
    expect(plan.rolePermissionsToCreate).toEqual([]);
  });

  it('rejects duplicated target logical grants instead of masking conflicting target state', () => {
    const target = targetDirectory();
    target.rolePermissions.push({ roleCode: 'factory.operator', permissionCode: 'orders.read' });
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
  });

  it('fails closed when any source member has no active target user', () => {
    const target = targetDirectory();
    target.users = target.users.filter((user) => user.userId !== userB);
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
    target.users.push({ userId: userB, status: 'INACTIVE' });
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
  });

  it('rejects unknown or inactive target permissions rather than dropping a grant', () => {
    const source = sourceSnapshot();
    source.rolePermissions.push({ roleCode: 'factory.operator', permissionCode: 'production.approve' });
    expect(() => buildSaasTenantIamRemappingPlan(source, targetDirectory()))
      .toThrow(ConflictException);
    const target = targetDirectory();
    target.permissions[0].status = 'DISABLED';
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
  });

  it('rejects missing target factories for factory-scoped assignments', () => {
    const target = targetDirectory();
    target.factories = [];
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
  });

  it('rejects conflicting role lifecycle/system semantics for a reused stable code', () => {
    const target = targetDirectory();
    target.roles[0].isSystem = true;
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
    target.roles[0].isSystem = false;
    target.roles[0].name = 'Unexpected renamed role';
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
    target.roles[0].name = 'Factory Operator';
    target.roles[0].status = 'DISABLED';
    expect(() => buildSaasTenantIamRemappingPlan(sourceSnapshot(), target))
      .toThrow(ConflictException);
  });

  it('rejects duplicate stable codes and dangling source relationships', () => {
    const source = sourceSnapshot();
    source.roles.push({ ...source.roles[0] });
    expect(() => buildSaasTenantIamRemappingPlan(source, targetDirectory()))
      .toThrow(ConflictException);

    const sourceWithDanglingAssignment = sourceSnapshot();
    sourceWithDanglingAssignment.userRoles[0].roleCode = 'missing.role';
    expect(() => buildSaasTenantIamRemappingPlan(sourceWithDanglingAssignment, targetDirectory()))
      .toThrow(BadRequestException);
  });

  it('compares target effective access as an exact set and rejects both missing and extra grants', () => {
    const expected = [{ userId: userA, permissionCode: 'orders.read', factoryCode: 'DHK-01' }];
    expect(assertSaasTenantIamEffectiveAccess(expected, expected)).toEqual({ expectedCount: 1, actualCount: 1 });
    expect(() => assertSaasTenantIamEffectiveAccess(expected, []))
      .toThrow(ConflictException);
    expect(() => assertSaasTenantIamEffectiveAccess(expected, [
      ...expected,
      { userId: userA, permissionCode: 'orders.delete', factoryCode: 'DHK-01' },
    ])).toThrow(ConflictException);
  });

  it('rejects duplicate target effective-access tuples instead of normalizing the defect away', () => {
    const tuple = { userId: userA, permissionCode: 'orders.read', factoryCode: 'DHK-01' };
    expect(() => assertSaasTenantIamEffectiveAccess([tuple], [tuple, tuple]))
      .toThrow(ConflictException);
  });
});
