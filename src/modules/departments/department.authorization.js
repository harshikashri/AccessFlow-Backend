import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import { AppError } from '../../utils/AppError.js';

export const loadDepartmentPermissions = async (req, res, next) => {
  try {
    const { userId, organizationId } = req.auth || {};
    if (!userId || !organizationId) {
      throw new AppError(
        'An active organization context is required for department access.',
        403,
        'ORGANIZATION_CONTEXT_REQUIRED'
      );
    }

    const assignments = await UserRoleAssignment.find({
      userId,
      organizationId,
      status: 'ACTIVE',
    })
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

      if (assignment.scopeType === 'ORGANIZATION' && !assignment.departmentId) {
        for (const permission of role.permissions || []) {
          organizationPermissions.add(permission);
        }
        continue;
      }

      if (assignment.scopeType !== 'DEPARTMENT' || !assignment.departmentId) {
        continue;
      }

      const departmentId = String(assignment.departmentId);
      for (const permission of role.permissions || []) {
        if (!scopedPermissions.has(permission)) {
          scopedPermissions.set(permission, new Set());
        }
        scopedPermissions.get(permission).add(departmentId);
      }
    }

    req.departmentAccess = { organizationPermissions, scopedPermissions };
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireDepartmentPermission = (permission, { organizationWideOnly = false } = {}) =>
  (req, res, next) => {
    const access = req.departmentAccess;
    const organizationAllowed = access?.organizationPermissions.has(permission) || false;
    const departmentAllowed = (access?.scopedPermissions.get(permission)?.size || 0) > 0;

    if (organizationAllowed || (!organizationWideOnly && departmentAllowed)) {
      return next();
    }

    return next(
      new AppError(
        `Permission ${permission} is required for this operation.`,
        403,
        'FORBIDDEN'
      )
    );
  };

export default { loadDepartmentPermissions, requireDepartmentPermission };