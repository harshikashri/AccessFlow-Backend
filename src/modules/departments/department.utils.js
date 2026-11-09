export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const toPublicDepartment = (department, { managerCount = 0, memberCount = 0 } = {}) => ({
  id: String(department._id),
  organizationId: String(department.organizationId),
  name: department.name,
  description: department.description,
  status: department.status,
  managerCount,
  memberCount,
  createdAt: department.createdAt,
  updatedAt: department.updatedAt,
});

export const toPublicDepartmentUser = (user, organizationId, departmentId = null) => {
  const membership = (user.organizationMemberships || []).find(
    (item) => String(item.organizationId) === String(organizationId)
  );

  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    accountStatus: user.accountStatus,
    membershipStatus: membership?.status || null,
    membershipId: membership?.membershipId ? String(membership.membershipId) : null,
    departmentId: departmentId
      ? String(departmentId)
      : membership?.departmentId
        ? String(membership.departmentId)
        : null,
  };
};

export const getScopedDepartmentIds = (access, permission) => {
  const ids = access?.scopedPermissions?.get(permission);
  return ids ? [...ids] : [];
};

export default {
  escapeRegex,
  toPublicDepartment,
  toPublicDepartmentUser,
  getScopedDepartmentIds,
};