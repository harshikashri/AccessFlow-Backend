import { AppError } from '../../utils/AppError.js';
import { resolveEffectivePermissions } from '../../services/authorization/permission.service.js';

export const loadRequestAccess = async (req, res, next) => {
  try {
    const { userId, organizationId } = req.auth || {};
    if (!userId || !organizationId) {
      throw new AppError('An active organization context is required for request access.', 403, 'ORGANIZATION_CONTEXT_REQUIRED');
    }
    req.requestAccess = await resolveEffectivePermissions({ userId, organizationId });
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireRequestPermission = (permission) => (req, res, next) => {
  if (req.requestAccess?.organizationPermissions.has(permission) ||
      (req.requestAccess?.scopedPermissions.get(permission)?.size || 0) > 0) {
    return next();
  }
  return next(new AppError(`Permission ${permission} is required for this operation.`, 403, 'FORBIDDEN'));
};

export default { loadRequestAccess, requireRequestPermission };

