import { AppError } from '../../utils/AppError.js';
import { resolveEffectivePermissions } from '../../services/authorization/permission.service.js';

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

    req.userAccess = await resolveEffectivePermissions({ userId, organizationId });
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