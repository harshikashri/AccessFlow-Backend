import { ORGANIZATION_ADMIN_ROLE_NAME } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';
import { resolveEffectivePermissions } from '../../services/authorization/permission.service.js';
import { getRoleType } from './role-compatibility.js';

export const loadRoleManagementAccess = async (req, res, next) => {
  try {
    const { userId, organizationId } = req.auth || {};
    if (!userId || !organizationId) {
      throw new AppError('An active organization context is required for role management.', 403, 'ORGANIZATION_CONTEXT_REQUIRED');
    }
    req.roleAccess = await resolveEffectivePermissions({ userId, organizationId });
    req.roleAccess.isOrganizationAdmin = req.roleAccess.assignments.some((assignment) =>
      assignment.scopeType === 'ORGANIZATION' &&
      !assignment.departmentId &&
      (getRoleType(assignment.roleId) === 'ORGANIZATION_ADMIN' || assignment.roleId.name === ORGANIZATION_ADMIN_ROLE_NAME)
    );
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireRoleManagementPermission = (permission) => (req, res, next) => {
  const access = req.roleAccess;
  if (
    access?.isOrganizationAdmin &&
    access.organizationPermissions.has(permission)
  ) {
    return next();
  }
  return next(new AppError('Organization Admin role permission is required.', 403, 'FORBIDDEN'));
};

export default { loadRoleManagementAccess, requireRoleManagementPermission };