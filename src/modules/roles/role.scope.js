import { SCOPE_TYPES } from '../../config/constants.js';
import { getRoleType } from './role-compatibility.js';

export const getSupportedRoleScopes = (role) => {
  const roleType = getRoleType(role);
  if (roleType === 'ORGANIZATION_ADMIN') return ['ORGANIZATION'];
  if (['DEPARTMENT_MANAGER', 'FINANCE_APPROVER'].includes(roleType)) {
    return ['DEPARTMENT'];
  }
  if (roleType === 'EMPLOYEE') return ['ORGANIZATION', 'DEPARTMENT'];

  const configuredScopes = Array.isArray(role?.assignmentScopes) && role.assignmentScopes.length > 0
    ? role.assignmentScopes
    : role?.assignmentScope
      ? [role.assignmentScope]
      : [];
  return SCOPE_TYPES.filter((scope) => configuredScopes.includes(scope));
};

export const isRoleScopeSupported = (role, scopeType) =>
  getSupportedRoleScopes(role).includes(scopeType);
