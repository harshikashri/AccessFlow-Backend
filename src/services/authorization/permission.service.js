import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import Department from '../../models/Department.js';
import { AppError } from '../../utils/AppError.js';

export const resolveEffectivePermissions = async ({ userId, organizationId }) => {
  if (!userId || !organizationId) {
    throw new AppError('An active organization context is required.', 403, 'ORGANIZATION_CONTEXT_REQUIRED');
  }

  const [user, organization] = await Promise.all([
    User.findById(userId).select('accountStatus organizationMemberships'),
    Organization.findById(organizationId).select('status'),
  ]);
  if (!user || user.accountStatus !== 'ACTIVE') {
    throw new AppError('Account is inactive.', 403, 'ACCOUNT_INACTIVE');
  }
  const membership = user.organizationMemberships.find(
    (item) => String(item.organizationId) === String(organizationId) && item.status === 'ACTIVE'
  );
  if (!membership) {
    throw new AppError('Active organization membership is required.', 403, 'NO_ORGANIZATION_MEMBERSHIP');
  }
  if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
  if (organization.status !== 'ACTIVE') {
    throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
  }

  const assignments = await UserRoleAssignment.find({
    userId,
    organizationId,
    status: 'ACTIVE',
  })
    .populate({ path: 'roleId', select: 'organizationId name roleType status permissions' })
    .lean();
  const activeAssignments = assignments.filter((assignment) =>
    assignment.roleId &&
    assignment.roleId.status === 'ACTIVE' &&
    String(assignment.roleId.organizationId) === String(organizationId)
  );
  const departmentIds = [...new Set(activeAssignments
    .filter((assignment) => assignment.scopeType === 'DEPARTMENT' && assignment.departmentId)
    .map((assignment) => String(assignment.departmentId)))];
  const activeDepartments = departmentIds.length
    ? await Department.find({
      _id: { $in: departmentIds },
      organizationId,
      status: 'ACTIVE',
    }).distinct('_id')
    : [];
  const activeDepartmentIds = new Set(activeDepartments.map(String));

  const organizationPermissions = new Set();
  const scopedPermissions = new Map();
  const effectiveAssignments = [];
  for (const assignment of activeAssignments) {
    const role = assignment.roleId;
    const permissions = role.permissions || [];
    if (assignment.scopeType === 'ORGANIZATION' && !assignment.departmentId) {
      for (const permission of permissions) organizationPermissions.add(permission);
      effectiveAssignments.push(assignment);
      continue;
    }
    if (assignment.scopeType !== 'DEPARTMENT' || !assignment.departmentId) continue;
    const departmentId = String(assignment.departmentId);
    if (!activeDepartmentIds.has(departmentId)) continue;
    for (const permission of permissions) {
      if (!scopedPermissions.has(permission)) scopedPermissions.set(permission, new Set());
      scopedPermissions.get(permission).add(departmentId);
    }
    effectiveAssignments.push(assignment);
  }

  return {
    organizationPermissions,
    scopedPermissions,
    assignments: effectiveAssignments,
  };
};

export const hasEffectivePermission = (access, permission, departmentId = null) => {
  if (access?.organizationPermissions.has(permission)) return true;
  if (!departmentId) return false;
  return access?.scopedPermissions.get(permission)?.has(String(departmentId)) || false;
};

export default { resolveEffectivePermissions, hasEffectivePermission };