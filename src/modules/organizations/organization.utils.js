export const toPublicOrganization = (organization) => ({
  id: String(organization._id),
  name: organization.name,
  status: organization.status,
  createdBy: organization.createdBy ? String(organization.createdBy) : null,
  createdAt: organization.createdAt,
  updatedAt: organization.updatedAt,
});

export const toPublicAdminUser = (user, organizationId) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  accountStatus: user.accountStatus,
  platformRole: user.platformRole || null,
  organizationId: organizationId ? String(organizationId) : null,
});

export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default {
  toPublicOrganization,
  toPublicAdminUser,
  escapeRegex,
};
