import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import { AppError } from '../../utils/AppError.js';

export const loadUserPermissions = async (req, res, next) => {
  try {
    const { userId, organizationId } = req.auth || {};
    if (!userId || !organizationId) {
      throw new AppError(
        'An active organization context is required for user management.',
        403,
        'ORGANIZATION_CONTEXT_REQUIRED'
      );
    }

    const assignments = await UserRoleAssignment.find({ userId, organizationId, status: 'ACTIVE' })
      .populate({ path: 'roleId', select: 'organizationId status permissions' })
      .lean();
    const organizationPermissions = new Set();
    const scopedPermissions = new Map();

    for (const assignment of assignments) {
      const role = assignment.roleId;
      if (
        !role ||
        role.status !== 'ACTIVE' ||
        String(role.organizationId) !== String(organizationId)
      ) {
        continue;
      }

      const target = assignment.scopeType === 'ORGANIZATION' && !assignment.departmentId
        ? organizationPermissions
        : assignment.scopeType === 'DEPARTMENT' && assignment.departmentId
          ? null
          : undefined;
      if (target) {
        for (const permission of role.permissions || []) target.add(permission);
      } else if (target === null) {
        const departmentId = String(assignment.departmentId);
        for (const permission of role.permissions || []) {
          if (!scopedPermissions.has(permission)) scopedPermissions.set(permission, new Set());
          scopedPermissions.get(permission).add(departmentId);
        }
      }
    }

    req.userAccess = { organizationPermissions, scopedPermissions };
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireUserPermission = (permission, { organizationWideOnly = false } = {}) =>
  (req, res, next) => {
    const access = req.userAccess;
    const organizationAllowed = access?.organizationPermissions.has(permission) || false;
    const departmentAllowed = (access?.scopedPermissions.get(permission)?.size || 0) > 0;
    if (organizationAllowed || (!organizationWideOnly && departmentAllowed)) return next();
    return next(new AppError(`Permission ${permission} is required for this operation.`, 403, 'FORBIDDEN'));
  };

export default { loadUserPermissions, requireUserPermission };