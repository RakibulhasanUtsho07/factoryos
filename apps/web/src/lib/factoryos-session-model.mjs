const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The authenticated API response is missing " + field + ".");
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asItems(value) {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  return Array.isArray(record.items) ? record.items.map(asRecord) : [];
}

export function createWorkspaceSessionSnapshot(currentUserValue, accessValue, factoriesValue, requestedTenantId) {
  const tenantScope = String(requestedTenantId ?? "").trim().toLowerCase();
  if (!UUID_PATTERN.test(tenantScope)) {
    throw new Error("A valid requested tenant UUID is required.");
  }

  const currentUser = asRecord(currentUserValue);
  if (currentUser.authenticated !== true) {
    throw new Error("The API did not confirm an authenticated session.");
  }

  const identity = asRecord(currentUser.user);
  const identityTenantId = optionalText(identity.tenantId);
  const identityUserId = requiredText(identity.userId, "user.userId");
  const identityMembershipId = requiredText(identity.membershipId, "user.membershipId");
  if (identityTenantId && identityTenantId.toLowerCase() !== tenantScope) {
    throw new Error("The verified identity does not match the requested tenant context.");
  }

  const access = asRecord(accessValue);
  const user = asRecord(access.user);
  const tenant = asRecord(access.tenant);
  const membership = asRecord(access.membership);

  const accessUserId = requiredText(user.id, "user.id");
  const accessMembershipId = requiredText(membership.id, "membership.id");
  if (accessUserId !== identityUserId) {
    throw new Error("The authenticated identity does not match the IAM user.");
  }
  if (accessMembershipId !== identityMembershipId) {
    throw new Error("The authenticated identity does not match the IAM membership.");
  }

  const tenantId = requiredText(tenant.id, "tenant.id");
  if (tenantId.toLowerCase() !== tenantScope) {
    throw new Error("The IAM access response belongs to a different tenant.");
  }
  if (String(membership.status ?? "").toUpperCase() !== "ACTIVE") {
    throw new Error("The selected tenant membership is not active.");
  }

  const factories = asItems(factoriesValue)
    .filter((item) => typeof item.id === "string" && typeof item.code === "string")
    .map((item) => ({
      id: String(item.id),
      code: String(item.code),
      name: typeof item.name === "string" ? item.name : String(item.code),
      status: typeof item.status === "string" ? item.status : "UNKNOWN",
      ...(typeof item.timezone === "string" ? { timezone: item.timezone } : {}),
    }));

  const roles = (Array.isArray(access.roles) ? access.roles : [])
    .map(asRecord)
    .filter((item) => typeof item.id === "string" && typeof item.code === "string")
    .map((item) => ({
      id: String(item.id),
      code: String(item.code),
      name: typeof item.name === "string" ? item.name : String(item.code),
    }));

  const permissions = (Array.isArray(access.permissions) ? access.permissions : [])
    .map(asRecord)
    .filter((item) => typeof item.id === "string" && typeof item.code === "string")
    .map((item) => ({
      id: String(item.id),
      code: String(item.code),
      description: optionalText(item.description),
    }));

  return {
    user: {
      id: accessUserId,
      displayName: typeof user.displayName === "string" && user.displayName.trim()
        ? user.displayName.trim()
        : "FactoryOS user",
      email: optionalText(user.email),
    },
    tenant: {
      id: tenantId,
      slug: requiredText(tenant.slug, "tenant.slug"),
      name: requiredText(tenant.name, "tenant.name"),
      timezone: typeof tenant.timezone === "string" ? tenant.timezone : "UTC",
      defaultLocale: typeof tenant.defaultLocale === "string" ? tenant.defaultLocale : "en",
    },
    membership: {
      id: accessMembershipId,
      status: String(membership.status),
    },
    roles,
    permissions,
    factories,
  };
}

export function isActiveWorkspaceFactory(snapshot, factoryId) {
  return Array.isArray(snapshot?.factories)
    && snapshot.factories.some((factory) => factory.id === factoryId && factory.status.toUpperCase() === "ACTIVE");
}
