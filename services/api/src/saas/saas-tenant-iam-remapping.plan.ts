import { BadRequestException, ConflictException } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type SaasIamTransferStatus = 'ACTIVE' | 'INACTIVE' | 'DISABLED' | 'RETIRED';

export interface SaasTenantIamPortableSnapshot {
  memberships: Array<{ userId: string; status: 'ACTIVE' | 'INACTIVE' }>;
  roles: Array<{
    code: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    status: SaasIamTransferStatus;
  }>;
  userRoles: Array<{ userId: string; roleCode: string; factoryCode: string | null }>;
  rolePermissions: Array<{ roleCode: string; permissionCode: string }>;
}

export interface SaasTenantIamTargetDirectory {
  users: Array<{ userId: string; status: SaasIamTransferStatus }>;
  memberships: Array<{ id: string; userId: string; status: 'ACTIVE' | 'INACTIVE' }>;
  roles: Array<{ id: string; code: string; name: string; description: string | null; isSystem: boolean; status: SaasIamTransferStatus }>;
  factories: Array<{ id: string; code: string; status: SaasIamTransferStatus }>;
  permissions: Array<{ id: string; code: string; status: SaasIamTransferStatus }>;
  userRoles: Array<{ userId: string; roleCode: string; factoryCode: string | null }>;
  rolePermissions: Array<{ roleCode: string; permissionCode: string }>;
}

export interface SaasTenantIamRemappingPlan {
  membershipsToCreate: Array<{ userId: string; status: 'ACTIVE' | 'INACTIVE' }>;
  rolesToCreate: SaasTenantIamPortableSnapshot['roles'];
  userRolesToCreate: SaasTenantIamPortableSnapshot['userRoles'];
  rolePermissionsToCreate: SaasTenantIamPortableSnapshot['rolePermissions'];
  expectedEffectiveAccess: Array<{ userId: string; permissionCode: string; factoryCode: string | null }>;
}

/**
 * Build a deterministic, logical IAM remapping plan.
 *
 * This is deliberately a pure planning boundary: it never writes IAM rows.
 * The database adapter must apply this plan in the same target transaction as
 * the business-data import, resolve generated IDs by stable codes, and call
 * assertSaasTenantIamEffectiveAccess before writing the import receipt.
 */
export function buildSaasTenantIamRemappingPlan(
  source: SaasTenantIamPortableSnapshot,
  target: SaasTenantIamTargetDirectory,
): SaasTenantIamRemappingPlan {
  assertUnique(source.memberships, (row) => row.userId, 'source membership user');
  assertUnique(source.roles, (row) => row.code, 'source role code');
  assertUnique(source.userRoles, assignmentKey, 'source user-role assignment');
  assertUnique(source.rolePermissions, grantKey, 'source role-permission grant');

  const sourceMemberships = new Map(source.memberships.map((row) => {
    assertUuid(row.userId, 'source membership user ID');
    assertMembershipStatus(row.status, 'source membership status');
    return [row.userId, row] as const;
  }));
  const sourceRoles = new Map(source.roles.map((row) => {
    assertCode(row.code, 'source role code');
    assertStatus(row.status, 'source role status');
    if (typeof row.name !== 'string' || row.name.trim().length === 0 || row.name.length > 200) {
      throw new BadRequestException('Source role name is invalid');
    }
    if (row.description !== null && (typeof row.description !== 'string' || row.description.length > 2000)) {
      throw new BadRequestException('Source role description is invalid');
    }
    if (typeof row.isSystem !== 'boolean') throw new BadRequestException('Source role system flag is invalid');
    return [row.code, row] as const;
  }));

  const targetUsers = indexBy(target.users, (row) => row.userId, 'target user ID');
  const targetMemberships = indexBy(target.memberships, (row) => row.userId, 'target membership user ID');
  const targetRoles = indexBy(target.roles, (row) => row.code, 'target role code');
  const targetFactories = indexBy(target.factories, (row) => row.code, 'target factory code');
  const targetPermissions = indexBy(target.permissions, (row) => row.code, 'target permission code');
  assertUnique(target.userRoles, assignmentKey, 'target user-role assignment');
  assertUnique(target.rolePermissions, grantKey, 'target role-permission grant');
  const targetAssignments = new Set(target.userRoles.map(assignmentKey));
  const targetGrants = new Set(target.rolePermissions.map(grantKey));

  const membershipsToCreate: SaasTenantIamRemappingPlan['membershipsToCreate'] = [];
  for (const sourceMembership of sourceMemberships.values()) {
    const user = targetUsers.get(sourceMembership.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new ConflictException('IAM remapping requires every source member to map to an active target user');
    }

    const targetMembership = targetMemberships.get(sourceMembership.userId);
    if (!targetMembership) {
      membershipsToCreate.push({ ...sourceMembership });
      continue;
    }
    assertUuid(targetMembership.id, 'target membership ID');
    if (targetMembership.status !== sourceMembership.status) {
      throw new ConflictException('Target membership status differs from the source; an explicit lifecycle decision is required');
    }
  }

  const rolesToCreate: SaasTenantIamRemappingPlan['rolesToCreate'] = [];
  for (const sourceRole of sourceRoles.values()) {
    const targetRole = targetRoles.get(sourceRole.code);
    if (!targetRole) {
      rolesToCreate.push({ ...sourceRole });
      continue;
    }
    assertUuid(targetRole.id, 'target role ID');
    if (
      targetRole.status !== sourceRole.status ||
      targetRole.isSystem !== sourceRole.isSystem ||
      targetRole.name !== sourceRole.name ||
      targetRole.description !== sourceRole.description
    ) {
      throw new ConflictException('Target role code exists with incompatible metadata or lifecycle semantics');
    }
  }

  const userRolesToCreate: SaasTenantIamRemappingPlan['userRolesToCreate'] = [];
  for (const assignment of source.userRoles) {
    if (!sourceMemberships.has(assignment.userId)) {
      throw new BadRequestException('Source user-role assignment references a missing tenant membership');
    }
    if (!sourceRoles.has(assignment.roleCode)) {
      throw new BadRequestException('Source user-role assignment references an unknown role code');
    }
    if (assignment.factoryCode !== null) {
      assertCode(assignment.factoryCode, 'source factory code');
      const factory = targetFactories.get(assignment.factoryCode);
      if (!factory || factory.status !== 'ACTIVE') {
        throw new ConflictException('Factory-scoped IAM assignment cannot be mapped to an active target factory');
      }
      assertUuid(factory.id, 'target factory ID');
    }
    if (!targetAssignments.has(assignmentKey(assignment))) {
      userRolesToCreate.push({ ...assignment });
    }
  }

  const rolePermissionsToCreate: SaasTenantIamRemappingPlan['rolePermissionsToCreate'] = [];
  for (const grant of source.rolePermissions) {
    if (!sourceRoles.has(grant.roleCode)) {
      throw new BadRequestException('Source role-permission grant references an unknown role code');
    }
    assertCode(grant.permissionCode, 'source permission code');
    const permission = targetPermissions.get(grant.permissionCode);
    if (!permission || permission.status !== 'ACTIVE') {
      throw new ConflictException('IAM remapping requires every granted permission code to exist and be active on the target');
    }
    assertUuid(permission.id, 'target permission ID');
    if (!targetGrants.has(grantKey(grant))) {
      rolePermissionsToCreate.push({ ...grant });
    }
  }

  const grantsByRole = new Map<string, string[]>();
  for (const grant of source.rolePermissions) {
    const codes = grantsByRole.get(grant.roleCode) ?? [];
    codes.push(grant.permissionCode);
    grantsByRole.set(grant.roleCode, codes);
  }
  const expected = new Map<string, { userId: string; permissionCode: string; factoryCode: string | null }>();
  for (const assignment of source.userRoles) {
    const membership = sourceMemberships.get(assignment.userId);
    const role = sourceRoles.get(assignment.roleCode);
    if (membership?.status !== 'ACTIVE' || role?.status !== 'ACTIVE') continue;
    for (const permissionCode of grantsByRole.get(assignment.roleCode) ?? []) {
      const tuple = { userId: assignment.userId, permissionCode, factoryCode: assignment.factoryCode };
      expected.set(effectiveAccessKey(tuple), tuple);
    }
  }

  return {
    membershipsToCreate: membershipsToCreate.sort((a, b) => a.userId.localeCompare(b.userId)),
    rolesToCreate: rolesToCreate.sort((a, b) => a.code.localeCompare(b.code)),
    userRolesToCreate: userRolesToCreate.sort((a, b) => assignmentKey(a).localeCompare(assignmentKey(b))),
    rolePermissionsToCreate: rolePermissionsToCreate.sort((a, b) => grantKey(a).localeCompare(grantKey(b))),
    expectedEffectiveAccess: [...expected.values()].sort((a, b) => effectiveAccessKey(a).localeCompare(effectiveAccessKey(b))),
  };
}

/**
 * Compare normalized access tuples read back from the target database with
 * the planned result. Extra grants are treated as a failure, not ignored.
 */
export function assertSaasTenantIamEffectiveAccess(
  expected: Array<{ userId: string; permissionCode: string; factoryCode: string | null }>,
  actual: Array<{ userId: string; permissionCode: string; factoryCode: string | null }>,
): { expectedCount: number; actualCount: number } {
  for (const tuple of [...expected, ...actual]) {
    assertUuid(tuple.userId, 'effective-access user ID');
    assertCode(tuple.permissionCode, 'effective-access permission code');
    if (tuple.factoryCode !== null) assertCode(tuple.factoryCode, 'effective-access factory code');
  }
  assertUnique(expected, effectiveAccessKey, 'expected effective-access tuple');
  assertUnique(actual, effectiveAccessKey, 'target effective-access tuple');
  const expectedKeys = new Set(expected.map(effectiveAccessKey));
  const actualKeys = new Set(actual.map(effectiveAccessKey));
  let missing = 0;
  let unexpected = 0;
  for (const key of expectedKeys) if (!actualKeys.has(key)) missing += 1;
  for (const key of actualKeys) if (!expectedKeys.has(key)) unexpected += 1;
  if (missing > 0 || unexpected > 0) {
    throw new ConflictException(
      'Target IAM effective access differs from the remapping plan (missing=' +
      missing + ', unexpected=' + unexpected + ')',
    );
  }
  return { expectedCount: expectedKeys.size, actualCount: actualKeys.size };
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(label + ' must be a UUID');
  }
}

function assertCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !STABLE_CODE_PATTERN.test(value) || value.trim() !== value) {
    throw new BadRequestException(label + ' is invalid');
  }
}

function assertStatus(value: unknown, label: string): asserts value is SaasIamTransferStatus {
  if (!['ACTIVE', 'INACTIVE', 'DISABLED', 'RETIRED'].includes(value as string)) {
    throw new BadRequestException(label + ' is invalid');
  }
}

function assertMembershipStatus(value: unknown, label: string): asserts value is 'ACTIVE' | 'INACTIVE' {
  if (value !== 'ACTIVE' && value !== 'INACTIVE') throw new BadRequestException(label + ' is invalid');
}

function assertUnique<T>(items: T[], keyOf: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) throw new ConflictException('Duplicate ' + label + ' in IAM remapping input');
    seen.add(key);
  }
}

function indexBy<T>(
  items: T[],
  keyOf: (item: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (result.has(key)) throw new ConflictException('Duplicate ' + label + ' in target IAM catalog');
    result.set(key, item);
  }
  return result;
}

function assignmentKey(item: { userId: string; roleCode: string; factoryCode: string | null }): string {
  return JSON.stringify([item.userId, item.roleCode, item.factoryCode]);
}

function grantKey(item: { roleCode: string; permissionCode: string }): string {
  return JSON.stringify([item.roleCode, item.permissionCode]);
}

function effectiveAccessKey(item: { userId: string; permissionCode: string; factoryCode: string | null }): string {
  return JSON.stringify([item.userId, item.permissionCode, item.factoryCode]);
}
