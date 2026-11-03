import mongoose from 'mongoose';

export const toPublicUser = (user, organizationId = null) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  platformRole: user.platformRole || null,
  organizationId: organizationId ? String(organizationId) : null,
});

export const getActiveMemberships = (user) =>
  (user.organizationMemberships || []).filter((membership) => membership.status === 'ACTIVE');

export const findActiveMembership = (user, organizationId) => {
  if (!organizationId) {
    return null;
  }

  const targetId = String(organizationId);
  return getActiveMemberships(user).find(
    (membership) => String(membership.organizationId) === targetId
  );
};

export const isSuperAdmin = (user) => user?.platformRole === 'SUPER_ADMIN';

export const idsEqual = (left, right) => {
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return String(left) === String(right);
};

export const toObjectIdOrNull = (value) => {
  if (value == null || value === '') {
    return null;
  }
  return new mongoose.Types.ObjectId(String(value));
};

export default {
  toPublicUser,
  getActiveMemberships,
  findActiveMembership,
  isSuperAdmin,
  idsEqual,
  toObjectIdOrNull,
};
