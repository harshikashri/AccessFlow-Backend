export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const getScopedDepartmentIds = (access, permission) => {
  const ids = access?.scopedPermissions?.get(permission);
  return ids ? [...ids] : [];
};

export const toPublicMembership = (membership, department = null) => ({
  membershipId: String(membership.membershipId),
  organizationId: String(membership.organizationId),
  organizationStatus: membership.organizationStatus || null,
  departmentId: membership.departmentId ? String(membership.departmentId) : null,
  department: department
    ? { id: String(department._id), name: department.name, status: department.status }
    : null,
  status: membership.status,
});

export const toPublicUser = (user, membership, department = null, roleAssignments = []) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  accountStatus: user.accountStatus,
  membership: toPublicMembership(membership, department),
  roleAssignments: roleAssignments.map((assignment) => ({
    roleId: String(assignment.roleId?._id || assignment.roleId),
    roleName: assignment.roleId?.name || assignment.roleName || null,
    scopeType: assignment.scopeType,
    departmentId: assignment.departmentId ? String(assignment.departmentId) : null,
    status: assignment.status,
  })),
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

export default { escapeRegex, getScopedDepartmentIds, toPublicMembership, toPublicUser };