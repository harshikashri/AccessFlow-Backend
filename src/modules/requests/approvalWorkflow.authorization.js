import { AppError } from '../../utils/AppError.js';
import { resolveEffectivePermissions } from '../../services/authorization/permission.service.js';
import { getRoleType } from '../roles/role-compatibility.js';

export const loadWorkflowAccess = async (req, res, next) => {
  try {
    const { userId, organizationId } = req.auth || {};
    if (!userId || !organizationId) {
      throw new AppError('An active organization context is required for workflow management.', 403, 'ORGANIZATION_CONTEXT_REQUIRED');
    }
    req.workflowAccess = await resolveEffectivePermissions({ userId, organizationId });
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireWorkflowPermission = (permission) => (req, res, next) => {
  const isAdmin = req.workflowAccess?.assignments.some((assignment) =>
    assignment.scopeType === 'ORGANIZATION' &&
    !assignment.departmentId &&
    getRoleType(assignment.roleId) === 'ORGANIZATION_ADMIN'
  );
  if (isAdmin && req.workflowAccess.organizationPermissions.has(permission)) return next();
  return next(new AppError('Organization Admin workflow permission is required.', 403, 'FORBIDDEN'));
};
